import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { crc32 } from '../src/research/archive.mjs';
import {
  benchmarkOfficialTransports,
  buildAcquisitionProgress,
  commitDerivedPartition,
  createDownloadCoordinator,
  createSpoolController,
  directS3UrlFor,
  downloadArchiveWithResume,
  isPartitionSkipEligible,
  loadPartitionState,
  objectKeyFromCanonicalUrl,
  partitionPaths,
  setPartitionState
} from '../src/research/hy-exp-0040-transport.mjs';
import {
  processAggTradeArchives,
  readDerivedBuckets,
  restoreAggTradeRollingCheckpoint,
  serializeAggTradeRollingCheckpoint
} from '../src/research/hy-exp-0040-aggtrade.mjs';

const rootFor = () => fsp.mkdtemp(path.join(os.tmpdir(), 'hy-exp-0040-transport-'));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const fileSpec = (symbol, period, bytes, data = Buffer.alloc(bytes, 0x61)) => ({
  symbol,
  cadence: 'monthly',
  period,
  url: `https://data.binance.vision/data/futures/um/monthly/aggTrades/${symbol}/${symbol}-aggTrades-${period}.zip`,
  bytes,
  sha256: sha256(data)
});

function zipSingleCsv(text) {
  const payload = Buffer.from(text);
  const compressed = deflateRawSync(payload);
  const name = Buffer.from('data.csv');
  const checksum = crc32(payload);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(name.length, 26);
  const centralOffset = local.length + name.length + compressed.length;
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(payload.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + name.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, name, compressed, central, name, eocd]);
}

function archiveFixture(period, csv) {
  const archiveData = zipSingleCsv(csv);
  return { ...fileSpec('BTCUSDT', period, archiveData.length, archiveData), archiveData };
}

async function processArchiveFixtures(archives, root, outputPath) {
  return processAggTradeArchives({
    symbol: 'BTCUSDT',
    archives,
    outputPath,
    start: 0,
    end: 180000,
    checkpointRoot: root,
    downloadOptions: {
      root,
      chunkBytes: 4096,
      concurrency: 1,
      maxAttempts: 1,
      fetchImpl: async (url, init) => {
        const archive = archives.find(file => file.url === url);
        return partialResponse(archive, archive.archiveData, init);
      }
    }
  });
}

function rangeFrom(init) {
  const match = init.headers.Range.match(/^bytes=(\d+)-(\d+)$/);
  return { start: Number(match[1]), end: Number(match[2]) };
}

function partialResponse(file, data, init, status = 206, contentRange = null) {
  const range = rangeFrom(init);
  const payload = data.subarray(range.start, range.end + 1);
  return new Response(payload, {
    status,
    headers: contentRange == null
      ? { 'content-range': `bytes ${range.start}-${range.end}/${file.bytes}` }
      : { 'content-range': contentRange }
  });
}

test('canonical identity remains separate from direct S3 transport', () => {
  const canonical = 'https://data.binance.vision/data/futures/um/monthly/aggTrades/BTCUSDT/BTCUSDT-aggTrades-2024-08.zip';
  assert.equal(objectKeyFromCanonicalUrl(canonical), 'data/futures/um/monthly/aggTrades/BTCUSDT/BTCUSDT-aggTrades-2024-08.zip');
  assert.equal(directS3UrlFor(canonical), 'https://s3-ap-northeast-1.amazonaws.com/data.binance.vision/data/futures/um/monthly/aggTrades/BTCUSDT/BTCUSDT-aggTrades-2024-08.zip');
});

test('benchmark chooses only a valid official range transport', async () => {
  const files = [fileSpec('BTCUSDT', '2024-08', 1_000_000), fileSpec('ETHUSDT', '2024-08', 1_000_000), fileSpec('LTCUSDT', '2024-08', 1_000_000)];
  let tick = 0;
  const benchmark = await benchmarkOfficialTransports(files, {
    sampleBytes: 800_000,
    now: () => (tick += 1),
    fetchImpl: async (url, init) => {
      const file = files.find(row => url.endsWith(`${row.symbol}-aggTrades-${row.period}.zip`));
      return partialResponse(file, Buffer.alloc(file.bytes, 0x62), init);
    }
  });
  assert.equal(benchmark.samples.length, 3);
  assert.equal(benchmark.summaries.every(row => row.allSamplesValid), true);
  assert.equal(benchmark.summaries.every(row => row.performanceStatus === 'NORMAL'), true);
  assert.ok(['canonical', 'direct-s3'].includes(benchmark.selectedEndpoint));
  assert.equal(benchmark.selection, 'FASTEST_VALID_OFFICIAL_TRANSPORT');
  assert.equal(benchmark.selectedConcurrency, 8);
});

test('benchmark selects valid slow transport and marks it resumable', async () => {
  const files = [fileSpec('BTCUSDT', '2024-08', 2_000), fileSpec('ETHUSDT', '2024-08', 2_000), fileSpec('LTCUSDT', '2024-08', 2_000)];
  let clock = 0;
  const result = await benchmarkOfficialTransports(files, {
    sampleBytes: 1_000,
    now: () => clock,
    fetchImpl: async (url, init) => {
      const file = files.find(row => url.endsWith(`${row.symbol}-aggTrades-${row.period}.zip`));
      clock += url.startsWith('https://s3-') ? 12.5 : 10;
      return partialResponse(file, Buffer.alloc(file.bytes, 0x62), init);
    }
  });
  assert.equal(result.summaries.every(row => row.allSamplesValid), true);
  assert.equal(result.summaries[0].medianThroughputBytesPerSecond, 100_000);
  assert.equal(result.summaries[1].medianThroughputBytesPerSecond, 80_000);
  assert.equal(result.selectedEndpoint, 'canonical');
  assert.equal(result.transportPerformanceStatus, 'SLOW_BUT_RESUMABLE');
  assert.equal(result.selection, 'FASTEST_VALID_OFFICIAL_TRANSPORT');
  assert.equal(result.selectedConcurrency, 8);
});

test('benchmark blocks only when both official transports fail range validation', async () => {
  const files = [fileSpec('BTCUSDT', '2024-08', 20), fileSpec('ETHUSDT', '2024-08', 20), fileSpec('LTCUSDT', '2024-08', 20)];
  const result = await benchmarkOfficialTransports(files, {
    sampleBytes: 8,
    fetchImpl: async (url, init) => {
      const file = files.find(row => url.endsWith(`${row.symbol}-aggTrades-${row.period}.zip`));
      return partialResponse(file, Buffer.alloc(file.bytes), init, 200, null);
    }
  });
  assert.equal(result.selectedEndpoint, null);
  assert.equal(result.transportPerformanceStatus, 'UNAVAILABLE');
  assert.equal(result.selection, 'HOST_NETWORK_TRANSPORT_BLOCKER');
});

test('resume keeps deterministic ranges and never downloads a completed range again', async () => {
  const root = await rootFor();
  const data = Buffer.from('abcdefghijklmnopqrst');
  const file = fileSpec('BTCUSDT', '2024-08', data.length, data);
  let phase = 1;
  const calls = [];
  const fetchImpl = async (url, init) => {
    const range = rangeFrom(init);
    calls.push(range.start);
    if (phase === 1 && range.start === 5) throw new Error('simulated disconnect');
    return partialResponse(file, data, init);
  };
  await assert.rejects(() => downloadArchiveWithResume(file, {
    root,
    chunkBytes: 5,
    concurrency: 1,
    maxAttempts: 1,
    fetchImpl
  }), /simulated disconnect/);
  const paths = partitionPaths(file, root);
  const saved = JSON.parse(await fsp.readFile(paths.resumePath, 'utf8'));
  assert.deepEqual(saved.completedRanges, [{ start: 0, end: 4 }]);
  assert.equal(fs.existsSync(paths.partPath), true);
  phase = 2;
  calls.length = 0;
  const result = await downloadArchiveWithResume(file, {
    root,
    chunkBytes: 5,
    concurrency: 1,
    maxAttempts: 1,
    fetchImpl
  });
  assert.deepEqual(calls, [5, 10, 15]);
  assert.equal(await fsp.readFile(result.path, 'utf8'), data.toString());
  assert.equal(loadPartitionState(file, root).state, 'SHA256_VERIFIED');
  assert.equal(result.path, paths.partPath);
  await fsp.rm(root, { recursive: true, force: true });
});

test('serialized resume checkpoints survive 32 out-of-order ranges and restart', async () => {
  const root = await rootFor();
  const data = Buffer.from(Array.from({ length: 128 }, (_, index) => index));
  const file = fileSpec('BTCUSDT', '2024-08', data.length, data);
  const firstCalls = [];
  const fetchImpl = async (url, init) => {
    const range = rangeFrom(init);
    firstCalls.push(range.start);
    if (range.start === 124) {
      await new Promise(resolve => setTimeout(resolve, 2_000));
      throw new Error('simulated interruption');
    }
    await new Promise(resolve => setTimeout(resolve, 1 + ((range.start / 4) % 3)));
    return partialResponse(file, data, init);
  };
  await assert.rejects(() => downloadArchiveWithResume(file, {
    root,
    chunkBytes: 4,
    concurrency: 8,
    maxAttempts: 1,
    fetchImpl
  }), /simulated interruption/);
  const paths = partitionPaths(file, root);
  const interrupted = JSON.parse(await fsp.readFile(paths.resumePath, 'utf8'));
  const rangeKeyForTest = range => `${range.start}:${range.end}`;
  const interruptedKeys = interrupted.completedRanges.map(rangeKeyForTest);
  assert.equal(firstCalls.length, 32);
  assert.equal(new Set(firstCalls).size, 32);
  assert.equal(interrupted.completedRanges.length, 31);
  assert.equal(new Set(interruptedKeys).size, 31);
  assert.equal(interrupted.downloadedBytes, 124);
  assert.equal(loadPartitionState(file, root).state, 'TRANSFER_RETRYABLE');

  const restartCalls = [];
  const result = await downloadArchiveWithResume(file, {
    root,
    chunkBytes: 4,
    concurrency: 8,
    maxAttempts: 1,
    fetchImpl: async (url, init) => {
      const range = rangeFrom(init);
      restartCalls.push(range.start);
      return partialResponse(file, data, init);
    }
  });
  assert.deepEqual(restartCalls, [124]);
  assert.equal(result.sha256, sha256(data));
  assert.deepEqual(await fsp.readFile(result.path), data);
  const completed = JSON.parse(await fsp.readFile(paths.resumePath, 'utf8'));
  assert.equal(completed.completedRanges.length, 32);
  assert.equal(new Set(completed.completedRanges.map(rangeKeyForTest)).size, 32);
  assert.equal(completed.downloadedBytes, data.length);
  await fsp.rm(root, { recursive: true, force: true });
});

test('range validation rejects a short or incorrectly positioned response', async () => {
  const root = await rootFor();
  const data = Buffer.from('abcdefghij');
  const file = fileSpec('ETHUSDT', '2024-08', data.length, data);
  await assert.rejects(() => downloadArchiveWithResume(file, {
    root,
    chunkBytes: 5,
    concurrency: 1,
    maxAttempts: 1,
    fetchImpl: async (url, init) => partialResponse(file, data, init, 206, 'bytes 0-3/10')
  }), /RANGE_RESPONSE_INVALID/);
  assert.equal(loadPartitionState(file, root).state, 'TRANSFER_RETRYABLE');
  await fsp.rm(root, { recursive: true, force: true });
});

test('checksum failure removes bytes and fails closed after one full retry', async () => {
  const root = await rootFor();
  const expected = Buffer.from('good');
  const file = fileSpec('LTCUSDT', '2024-08', expected.length, expected);
  let requests = 0;
  await assert.rejects(() => downloadArchiveWithResume(file, {
    root,
    chunkBytes: expected.length,
    concurrency: 1,
    maxAttempts: 1,
    fetchImpl: async (url, init) => {
      requests += 1;
      return partialResponse(file, Buffer.from('bad!'), init);
    }
  }), /DATA_FAIL_SOURCE_INTEGRITY/);
  assert.equal(requests, 2);
  assert.equal(fs.existsSync(partitionPaths(file, root).partPath), false);
  assert.equal(loadPartitionState(file, root).state, 'CHECKSUM_FAIL');
  await fsp.rm(root, { recursive: true, force: true });
});

test('partition state cannot be derived-committed before an archive is verified', async () => {
  const root = await rootFor();
  const data = Buffer.from('archive');
  const file = fileSpec('BNBUSDT', '2024-08', data.length, data);
  await setPartitionState(file, root, 'DISCOVERED');
  await assert.rejects(() => commitDerivedPartition(file, {
    root,
    derivedFileOffset: 10,
    derivedFileSha256: 'a'.repeat(64)
  }), /DERIVED_COMMIT_REQUIRES_VERIFIED_ARCHIVE/);
  await fsp.rm(root, { recursive: true, force: true });
});

test('derived commit deletes raw bytes only after a checkpoint and makes the partition resumable', async () => {
  const root = await rootFor();
  const data = Buffer.from('archive');
  const file = fileSpec('BNBUSDT', '2024-08', data.length, data);
  const spool = createSpoolController(data.length);
  await downloadArchiveWithResume(file, {
    root,
    chunkBytes: data.length,
    concurrency: 1,
    maxAttempts: 1,
    spoolController: spool,
    fetchImpl: async (url, init) => partialResponse(file, data, init)
  });
  assert.equal(spool.reservedBytes, data.length);
  const state = await commitDerivedPartition(file, {
    root,
    derivedFileOffset: 100,
    derivedFileSha256: 'a'.repeat(64),
    spoolController: spool
  });
  assert.equal(state.state, 'RAW_DELETED');
  assert.equal(state.derivedCommitted, true);
  assert.equal(isPartitionSkipEligible(file, root), true);
  assert.equal(spool.reservedBytes, 0);
  assert.equal(fs.existsSync(partitionPaths(file, root).partPath), false);
  await fsp.rm(root, { recursive: true, force: true });
});

test('verified ZIP spool cap is enforced before processing can exceed the bound', () => {
  const spool = createSpoolController(10);
  spool.reserve(10);
  assert.throws(() => spool.reserve(1), /VERIFIED_ZIP_SPOOL_CAP_EXCEEDED/);
});

test('global HTTP concurrency is capped and reduces after throttling', async () => {
  const coordinator = createDownloadCoordinator({ maxConcurrency: 8, maxAllowedConcurrency: 12 });
  let active = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 20 }, async () => coordinator.run(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 1));
    active -= 1;
  })));
  assert.ok(peak <= 8);
  coordinator.observeStatus(429);
  assert.equal(coordinator.limit, 4);
  coordinator.setLimit(99);
  assert.equal(coordinator.limit, 12);
});

test('Retry-After is honored for retryable official responses', async () => {
  const root = await rootFor();
  const data = Buffer.from('retry');
  const file = fileSpec('SOLUSDT', '2024-08', data.length, data);
  let requests = 0;
  const sleeps = [];
  const coordinator = createDownloadCoordinator({ maxConcurrency: 4 });
  await downloadArchiveWithResume(file, {
    root,
    chunkBytes: data.length,
    concurrency: 1,
    coordinator,
    maxAttempts: 2,
    sleepImpl: async milliseconds => sleeps.push(milliseconds),
    fetchImpl: async (url, init) => {
      requests += 1;
      if (requests === 1) return new Response('busy', { status: 503, headers: { 'retry-after': '1' } });
      return partialResponse(file, data, init);
    }
  });
  assert.equal(requests, 2);
  assert.ok(sleeps[0] >= 1000);
  assert.equal(coordinator.limit, 2);
  await fsp.rm(root, { recursive: true, force: true });
});

test('acquisition progress remains unlocked until every partition is derived', async () => {
  const root = await rootFor();
  const files = [fileSpec('BTCUSDT', '2024-08', 4), fileSpec('ETHUSDT', '2024-08', 4)];
  const progress = buildAcquisitionProgress(files, { root });
  assert.equal(progress.totalPartitions, 2);
  assert.equal(progress.verifiedPartitions, 0);
  assert.equal(progress.derivedPartitions, 0);
  assert.equal(progress.pendingPartitions, 2);
  assert.equal(progress.outcomeRead, false);
  await setPartitionState(files[0], root, 'DOWNLOADING');
  const interrupted = buildAcquisitionProgress(files, { root });
  assert.equal(interrupted.pendingPartitions, 2);
  await fsp.rm(root, { recursive: true, force: true });
});

test('rolling CVD and prior-24h P95 state round-trips across restart', () => {
  const checkpoint = serializeAggTradeRollingCheckpoint({
    symbol: 'BTCUSDT',
    lastTrade: { aggregateTradeId: 22, timestamp: 2000, quoteNotional: 5 },
    CVD: 123,
    rolling: restoreAggTradeRollingCheckpoint({ prior24hTradeDistribution: { rows: [{ time: 1000, value: 10 }, { time: 1500, value: 20 }] } }).rolling,
    lastCompletedMinute: 180000,
    derivedFileOffset: 80,
    derivedFileSha256: 'b'.repeat(64),
    bucketCount: 3,
    validBucketCount: 3,
    missingBucketCount: 0,
    archiveKey: 'monthly:2024-08'
  });
  const restored = restoreAggTradeRollingCheckpoint(checkpoint);
  const roundTrip = serializeAggTradeRollingCheckpoint({ ...checkpoint, rolling: restored.rolling });
  assert.deepEqual(roundTrip.prior24hTradeDistribution, checkpoint.prior24hTradeDistribution);
  assert.equal(restored.CVD, 123);
  assert.equal(restored.lastTrade.aggregateTradeId, 22);
});

test('aggregateTradeId continuity is enforced across archive partitions', async () => {
  const root = await rootFor();
  const first = archiveFixture('2024-08', '1,100,1,1,1,0,false\n');
  const duplicate = archiveFixture('2024-09', '1,101,1,2,2,60000,false\n');
  await assert.rejects(
    () => processArchiveFixtures([first, duplicate], root, path.join(root, 'derived.ndjson.gz')),
    /AGGTRADE_ID_NOT_STRICTLY_INCREASING/
  );
  await fsp.rm(root, { recursive: true, force: true });
});

test('process stop/restart preserves hash-equivalent derived stream and rolling state', async () => {
  const first = archiveFixture('2024-08', '1,100,1,1,1,0,false\n2,101,1,2,2,60000,true\n');
  const second = archiveFixture('2024-09', '3,102,1,3,3,120000,false\n');
  const continuousRoot = await rootFor();
  const continuousPath = path.join(continuousRoot, 'derived.ndjson.gz');
  await processArchiveFixtures([first, second], continuousRoot, continuousPath);
  const continuousRows = await readDerivedBuckets(continuousPath);

  const resumedRoot = await rootFor();
  const resumedPath = path.join(resumedRoot, 'derived.ndjson.gz');
  await processArchiveFixtures([first], resumedRoot, resumedPath);
  const resumedResult = await processArchiveFixtures([first, second], resumedRoot, resumedPath);
  const resumedRows = await readDerivedBuckets(resumedPath);

  assert.deepEqual(resumedRows, continuousRows);
  assert.equal(sha256(JSON.stringify(resumedRows)), sha256(JSON.stringify(continuousRows)));
  assert.equal(resumedResult.bucketCount, continuousRows.length);
  assert.equal(resumedRows.at(-1).CVD, continuousRows.at(-1).CVD);
  await fsp.rm(continuousRoot, { recursive: true, force: true });
  await fsp.rm(resumedRoot, { recursive: true, force: true });
});
