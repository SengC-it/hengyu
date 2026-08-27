import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';

function errorWithCode(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function bodyBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.from(String(value ?? ''));
}

async function sha256File(filePath) {
  return createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

function remoteHash(value) {
  return value?.sha256 ?? value?.checksumSha256 ?? value?.metadata?.sha256 ?? value?.Metadata?.sha256 ?? null;
}

/**
 * Provider-neutral S3-compatible adapter. The caller supplies an SDK-shaped
 * client, so no provider, endpoint, credential, or secret is embedded here.
 * Local files are deleted only after a remote HEAD/read hash verification.
 */
export function createS3CompatibleSealedPartitionAdapter({
  client = null,
  bucket = null,
  prefix = '',
  deleteLocal = true,
  localUnlink = filePath => fs.unlink(filePath)
} = {}) {
  const configured = Boolean(client && bucket && typeof client.putObject === 'function' && typeof client.headObject === 'function');

  async function verifyRemote({ key, expectedSha256 }) {
    const head = await client.headObject({ bucket, key });
    let actual = remoteHash(head);
    if (actual == null && typeof client.getObject === 'function') {
      const object = await client.getObject({ bucket, key });
      const data = bodyBytes(object?.body ?? object?.Body ?? object);
      actual = createHash('sha256').update(data).digest('hex');
    }
    if (actual !== expectedSha256) throw errorWithCode('REMOTE_HASH_MISMATCH', `remote hash mismatch for ${key}`);
    return Object.freeze({ verified: true, sha256: actual });
  }

  async function uploadSealedPartition({ filePath, objectKey, sha256 }) {
    if (!configured) throw errorWithCode('STORAGE_BACKEND_NOT_CONFIGURED', 'S3-compatible storage backend is not configured');
    const expectedSha256 = sha256 ?? await sha256File(filePath);
    const key = prefix ? `${prefix.replace(/\/$/, '')}/${objectKey.replace(/^\//, '')}` : objectKey;
    const body = await fs.readFile(filePath);
    await client.putObject({ bucket, key, body, metadata: { sha256: expectedSha256 } });
    const verification = await verifyRemote({ key, expectedSha256 });
    if (deleteLocal) await localUnlink(filePath);
    return Object.freeze({ key, ...verification, localDeleted: deleteLocal });
  }

  async function uploadManifest({ filePath, objectKey, sha256 }) {
    return uploadSealedPartition({ filePath, objectKey, sha256 });
  }

  return Object.freeze({
    configured,
    bucket,
    prefix,
    uploadSealedPartition,
    uploadManifest,
    verifyRemote
  });
}

export function evaluateStorageCapacity({ bytesPerHour, remoteCapacityBytes = null, localAvailableBytes = null, localSpoolHours = 72 } = {}) {
  const hourly = Number(bytesPerHour);
  if (!Number.isFinite(hourly) || hourly <= 0) {
    return Object.freeze({ status: 'CAPACITY_EVIDENCE_MISSING', twoX90DayHeadroom: false, localSpool72h: false });
  }
  const projectedRawBytes = Object.fromEntries([24, 30, 60, 90].map(days => [`${days}d`, Math.ceil(hourly * 24 * days)]));
  const remoteRequired = projectedRawBytes['90d'] * 2;
  const localRequired = Math.ceil(hourly * localSpoolHours);
  const remotePass = remoteCapacityBytes !== null && Number(remoteCapacityBytes) >= remoteRequired;
  const localPass = localAvailableBytes !== null && Number(localAvailableBytes) >= localRequired;
  return Object.freeze({
    bytesPerHour: Math.ceil(hourly),
    projectedRawBytes,
    remoteRequiredBytes: remoteRequired,
    remoteCapacityBytes,
    localRequiredSpoolBytes: localRequired,
    localAvailableBytes,
    twoX90DayHeadroom: remotePass,
    localSpool72h: localPass,
    status: remotePass && localPass ? 'CAPACITY_PASS' : 'STORAGE_CAPACITY_BLOCKED'
  });
}
