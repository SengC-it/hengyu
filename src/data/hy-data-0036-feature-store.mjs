import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const DATASET_ID = 'HY-DATA-0036';

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function safePart(value) {
  return String(value).replaceAll(/[^A-Za-z0-9_.-]/g, '_');
}

async function sha256File(filePath) {
  return createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

/**
 * Atomic, append-only engineering feature sink. It is intentionally separate
 * from the formal Supabase research table and produces an immutable manifest.
 */
export function createEngineeringFeatureStore({ rootDir, runId } = {}) {
  if (!rootDir || !runId) throw new Error('feature rootDir and runId are required');
  const partitions = new Map();
  let sealed = false;
  let writeCount = 0;

  async function getPartition(row) {
    const key = `${row.interval}/${row.symbol}`;
    if (partitions.has(key)) return partitions.get(key);
    const relativePath = path.join(safePart(row.interval), `${safePart(row.symbol)}.jsonl`);
    const finalPath = path.join(rootDir, relativePath);
    const tempPath = `${finalPath}.${safePart(runId)}.part`;
    await fs.mkdir(path.dirname(finalPath), { recursive: true });
    await fs.writeFile(tempPath, '', { flag: 'wx' });
    const partition = {
      key,
      relativePath: relativePath.replaceAll('\\', '/'),
      finalPath,
      tempPath,
      rows: 0,
      uncompressedBytes: 0,
      firstSnapshot: null,
      lastSnapshot: null,
      symbol: row.symbol,
      interval: row.interval,
      error: null,
      writeChain: Promise.resolve()
    };
    partitions.set(key, partition);
    return partition;
  }

  async function append(row) {
    if (sealed) throw new Error('FEATURE_STORE_SEALED');
    if (!row || row.datasetId !== DATASET_ID || typeof row.symbol !== 'string' || typeof row.interval !== 'string') {
      throw new Error('INVALID_FEATURE_ROW');
    }
    const partition = await getPartition(row);
    if (partition.error) throw new Error(`FEATURE_DURABILITY_FAILURE: ${partition.error.message}`);
    const line = `${JSON.stringify(row)}\n`;
    partition.uncompressedBytes += Buffer.byteLength(line);
    partition.rows += 1;
    partition.firstSnapshot ??= row.snapshotAt;
    partition.lastSnapshot = row.snapshotAt;
    partition.writeChain = partition.writeChain.then(() => fs.appendFile(partition.tempPath, line));
    try { await partition.writeChain; } catch (error) {
      partition.error = error;
      throw new Error(`FEATURE_DURABILITY_FAILURE: ${error.message}`);
    }
    writeCount += 1;
    return Object.freeze({ path: partition.relativePath, rowCount: partition.rows });
  }

  async function seal() {
    if (sealed) return Object.freeze([]);
    sealed = true;
    const files = [];
    for (const partition of partitions.values()) {
      await partition.writeChain;
      if (partition.error) throw new Error(`FEATURE_DURABILITY_FAILURE: ${partition.error.message}`);
      const handle = await fs.open(partition.tempPath, 'r+');
      try { await handle.sync(); } finally { await handle.close(); }
      try {
        await fs.stat(partition.finalPath);
        throw new Error('FEATURE_PARTITION_ALREADY_SEALED');
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      await fs.rename(partition.tempPath, partition.finalPath);
      const stat = await fs.stat(partition.finalPath);
      files.push({
        path: partition.relativePath,
        sha256: await sha256File(partition.finalPath),
        bytes: stat.size,
        rows: partition.rows,
        firstSnapshot: partition.firstSnapshot,
        lastSnapshot: partition.lastSnapshot,
        interval: partition.interval,
        symbol: partition.symbol
      });
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
    const body = {
      schemaVersion: 1,
      immutable: true,
      datasetId: DATASET_ID,
      runId,
      rootType: 'ENGINEERING_FEATURES_ONLY',
      files
    };
    const manifest = Object.freeze({ ...body, manifestSha256: createHash('sha256').update(stableJson(body)).digest('hex') });
    await fs.mkdir(rootDir, { recursive: true });
    await fs.writeFile(path.join(rootDir, 'feature-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    return manifest;
  }

  return Object.freeze({
    append,
    seal,
    get sealed() { return sealed; },
    get writeCount() { return writeCount; },
    get partitionCount() { return partitions.size; }
  });
}

export function verifyFeatureManifest(manifest) {
  if (!manifest || manifest.immutable !== true || manifest.datasetId !== DATASET_ID || !Array.isArray(manifest.files)) return false;
  const { manifestSha256, ...body } = manifest;
  return /^[a-f0-9]{64}$/.test(manifestSha256) && createHash('sha256').update(stableJson(body)).digest('hex') === manifestSha256;
}

export async function verifyFeatureManifestFiles(manifest, { rootDir } = {}) {
  if (!rootDir || !verifyFeatureManifest(manifest)) return false;
  const root = path.resolve(rootDir);
  for (const file of manifest.files) {
    if (!file || typeof file.path !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) return false;
    const absolute = path.resolve(root, file.path);
    const relative = path.relative(root, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
    try {
      if ((await fs.stat(absolute)).isDirectory() || await sha256File(absolute) !== file.sha256) return false;
    } catch {
      return false;
    }
  }
  return true;
}
