import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
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
  assert.equal(benchmark.summaries.every(row => row.reasonableThroughput), true);
  assert.ok(['canonical', 'direct-s3'].includes(benchmark.selectedEndpoint));
  assert.equal(benchmark.selection, 'FASTEST_VALID_OFFICIAL_TRANSPORT');
  assert.equal(benchmark.selectedConcurrency, 8);
});

test('benchmark blocks a valid but operationally unreasonable host throughput', async () => {
  const files = [fileSpec('BTCUSDT', '2024-08', 1_000_000), fileSpec('ETHUSDT', '2024-08', 1_000_000), fileSpec('LTCUSDT', '2024-08', 1_000_000)];
  let tick = 0;
  const result = await benchmarkOfficialTransports(files, {
    sampleBytes: 800_000,
    now: () => (tick += 10_000),
    fetchImpl: async (url, init) => {
      const file = files.find(row => url.endsWith(`${row.symbol}-aggTrades-${row.period}.zip`));
      return partialResponse(file, Buffer.alloc(file.bytes, 0x62), init);
    }
  });
  assert.equal(result.summaries.every(row => row.allSamplesValid), true);
  assert.equal(result.summaries.every(row => row.reasonableThroughput), false);
  assert.equal(result.selectedEndpoint, null);
  assert.equal(result.selection, 'HOST_NETWORK_THROUGHPUT_BLOCKER');
});

test('benchmark rejects HTTP 200 as a partial range success', async () => {
  const files = [fileSpec('BTCUSDT', '2024-08', 20), fileSpec('ETHUSDT', '2024-08', 20), fileSpec('LTCUSDT', '2024-08', 20)];
  const result = await benchmarkOfficialTransports(files, {
    sampleBytes: 8,
    fetchImpl: async (url, init) => {
      const file = files.find(row => url.endsWith(`${row.symbol}-aggTrades-${row.period}.zip`));
      return partialResponse(file, Buffer.alloc(file.bytes), init, 200, null);
    }
  });
  assert.equal(result.selectedEndpoint, null);
  assert.equal(result.selection, 'HOST_NETWORK_THROUGHPUT_BLOCKER');
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
