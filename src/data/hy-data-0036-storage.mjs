import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';

export const HY_DATA_0036_S3_ENVIRONMENT = Object.freeze([
  'HY_DATA_0036_S3_ENDPOINT',
  'HY_DATA_0036_S3_REGION',
  'HY_DATA_0036_S3_ACCESS_KEY_ID',
  'HY_DATA_0036_S3_SECRET_ACCESS_KEY',
  'HY_DATA_0036_S3_BUCKET',
  'HY_DATA_0036_S3_PREFIX'
]);

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

function safeRunId(value) {
  const normalized = String(value ?? 'preflight').replace(/[^A-Za-z0-9_.-]/g, '_');
  return normalized || 'preflight';
}

async function readBodyBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value);
  if (value && typeof value.transformTo === 'function') return Buffer.from(await value.transformTo('byteArray'));
  if (value && typeof value[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    for await (const chunk of value) chunks.push(bodyBytes(chunk));
    return Buffer.concat(chunks);
  }
  return bodyBytes(value);
}

function createAwsS3CommandClient(s3Client) {
  return Object.freeze({
    putObject: ({ bucket, key, body, metadata }) => s3Client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      Metadata: metadata
    })),
    headObject: async ({ bucket, key }) => {
      const result = await s3Client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return Object.freeze({ Metadata: result.Metadata ?? {}, metadata: result.Metadata ?? {} });
    },
    getObject: async ({ bucket, key }) => {
      const result = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return Object.freeze({ body: await readBodyBytes(result.Body) });
    },
    deleteObject: ({ bucket, key }) => s3Client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
  });
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

  async function verifyBackend({ runId = 'preflight', now = () => Date.now() } = {}) {
    if (!configured) return Object.freeze({ configured: false, verified: false, status: 'STORAGE_BACKEND_NOT_CONFIGURED' });
    const probeBody = Buffer.from(`HY-DATA-0036 engineering storage probe\n${safeRunId(runId)}\n${now()}\n`);
    const expectedSha256 = createHash('sha256').update(probeBody).digest('hex');
    const key = `${prefix ? `${prefix.replace(/\/$/, '')}/` : ''}_engineering-preflight/${safeRunId(runId)}-${now()}.probe`;
    try {
      await client.putObject({ bucket, key, body: probeBody, metadata: { sha256: expectedSha256 } });
      const head = await client.headObject({ bucket, key });
      const headHash = remoteHash(head);
      if (headHash !== expectedSha256) throw errorWithCode('REMOTE_PROBE_HEAD_HASH_MISMATCH', 'remote probe HEAD hash mismatch');
      let readHash = null;
      if (typeof client.getObject === 'function') {
        const object = await client.getObject({ bucket, key });
        readHash = createHash('sha256').update(await readBodyBytes(object?.body ?? object?.Body ?? object)).digest('hex');
        if (readHash !== expectedSha256) throw errorWithCode('REMOTE_PROBE_READ_HASH_MISMATCH', 'remote probe read hash mismatch');
      }
      const deleteSupported = typeof client.deleteObject === 'function';
      let deleteVerified = null;
      if (deleteSupported) {
        await client.deleteObject({ bucket, key });
        deleteVerified = true;
      }
      return Object.freeze({
        configured: true,
        verified: true,
        status: 'STORAGE_BACKEND_VERIFIED',
        probe: Object.freeze({ key, sha256: expectedSha256, headHashMatch: true, readHashMatch: readHash === null ? null : true, deleteSupported, deleteVerified })
      });
    } catch (error) {
      return Object.freeze({
        configured: true,
        verified: false,
        status: 'STORAGE_BACKEND_VERIFY_FAILED',
        errorCode: error.code ?? error.name ?? 'REMOTE_PROBE_FAILED'
      });
    }
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
    verifyRemote,
    verifyBackend
  });
}

function envValue(env, name) {
  const value = env?.[name];
  return value == null || String(value) === '' ? null : String(value);
}

function safeConfiguration({ env, missing }) {
  return Object.freeze({
    provider: 'S3_COMPATIBLE',
    endpointPresent: envValue(env, 'HY_DATA_0036_S3_ENDPOINT') !== null,
    regionPresent: envValue(env, 'HY_DATA_0036_S3_REGION') !== null,
    accessKeyPresent: envValue(env, 'HY_DATA_0036_S3_ACCESS_KEY_ID') !== null,
    secretKeyPresent: envValue(env, 'HY_DATA_0036_S3_SECRET_ACCESS_KEY') !== null,
    bucketPresent: envValue(env, 'HY_DATA_0036_S3_BUCKET') !== null,
    prefixPresent: envValue(env, 'HY_DATA_0036_S3_PREFIX') !== null,
    missing: Object.freeze([...missing])
  });
}

/**
 * Creates the provider-neutral S3/R2 adapter from environment variables.
 * Values are deliberately held only inside the SDK client closure; the
 * returned object exposes presence booleans and safe verification methods.
 */
export function createHyData0036StorageFromEnv({
  env = process.env,
  client = null,
  clientFactory = options => new S3Client(options),
  deleteLocal = true
} = {}) {
  const values = Object.fromEntries(HY_DATA_0036_S3_ENVIRONMENT.map(name => [name, envValue(env, name)]));
  const missing = HY_DATA_0036_S3_ENVIRONMENT.filter(name => values[name] === null);
  const configuration = safeConfiguration({ env, missing });
  if (missing.length) {
    const disabled = createS3CompatibleSealedPartitionAdapter({ deleteLocal });
    return Object.freeze({ ...disabled, configuration, verification: Object.freeze({ configured: false, verified: false, status: 'STORAGE_BACKEND_NOT_CONFIGURED' }) });
  }
  let sdkClient = client;
  try {
    if (sdkClient === null) {
      sdkClient = clientFactory({
        endpoint: values.HY_DATA_0036_S3_ENDPOINT,
        region: values.HY_DATA_0036_S3_REGION,
        credentials: {
          accessKeyId: values.HY_DATA_0036_S3_ACCESS_KEY_ID,
          secretAccessKey: values.HY_DATA_0036_S3_SECRET_ACCESS_KEY
        },
        forcePathStyle: true
      });
    }
    const commandClient = typeof sdkClient.send === 'function' ? createAwsS3CommandClient(sdkClient) : sdkClient;
    const adapter = createS3CompatibleSealedPartitionAdapter({
      client: commandClient,
      bucket: values.HY_DATA_0036_S3_BUCKET,
      prefix: values.HY_DATA_0036_S3_PREFIX,
      deleteLocal
    });
    return Object.freeze({ ...adapter, configuration });
  } catch (error) {
    const disabled = createS3CompatibleSealedPartitionAdapter({ deleteLocal });
    return Object.freeze({
      ...disabled,
      configuration,
      verification: Object.freeze({ configured: false, verified: false, status: 'STORAGE_BACKEND_VERIFY_FAILED', errorCode: error.code ?? error.name ?? 'S3_CLIENT_INITIALIZATION_FAILED' })
    });
  }
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
