import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const DEFAULT_CHUNK_BYTES = 8_000_000;
export const DEFAULT_HTTP_CONCURRENCY = 8;
export const MAX_HTTP_CONCURRENCY = 12;
export const DEFAULT_MAX_VERIFIED_ZIP_SPOOL_BYTES = 8 * 1024 ** 3;
// Operational floor for a bounded, resumable multi-hour acquisition on this host.
// This is a transport-operability gate, not a research parameter.
export const MIN_REASONABLE_THROUGHPUT_BYTES_PER_SECOND = 256_000;
export const DIRECT_S3_BASE = 'https://s3-ap-northeast-1.amazonaws.com/data.binance.vision/';

function iso(value = Date.now()) {
  return new Date(value).toISOString();
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export async function fetchWithTimeout(url, init = {}, timeoutMs = 120_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function objectKeyFromCanonicalUrl(canonicalUrl) {
  const url = new URL(canonicalUrl);
  if (url.hostname !== 'data.binance.vision') throw new Error('CANONICAL_BINANCE_HOST_INVALID');
  return url.pathname.replace(/^\/+/, '');
}

export function directS3UrlFor(canonicalUrl) {
  return DIRECT_S3_BASE + objectKeyFromCanonicalUrl(canonicalUrl);
}

export function parseContentRange(value) {
  const match = String(value ?? '').match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  if (!match) return null;
  return { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) };
}

export function validatePartialResponse({ status, contentRange, payloadLength, start, end, total }) {
  const parsed = parseContentRange(contentRange);
  return status === 206
    && parsed != null
    && parsed.start === start
    && parsed.end === end
    && parsed.total === total
    && payloadLength === end - start + 1;
}

function partitionName(file) {
  const symbol = String(file.symbol ?? '');
  const period = String(file.period ?? '');
  if (!/^[A-Z0-9]+$/.test(symbol) || !/^[0-9-]+$/.test(period)) {
    throw new Error('PARTITION_ID_INVALID');
  }
  return symbol + '-' + period;
}

export function partitionPaths(file, root) {
  const base = path.join(root, partitionName(file));
  return {
    partPath: base + '.zip.part',
    resumePath: base + '.resume.json',
    statePath: base + '.state.json'
  };
}

async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.tmp';
  await fsp.writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
  await fsp.rm(file, { force: true });
  await fsp.rename(temporary, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function loadPartitionState(file, root) {
  return readJson(partitionPaths(file, root).statePath);
}

export async function setPartitionState(file, root, state, extra = {}, now = Date.now()) {
  const current = loadPartitionState(file, root) ?? {};
  const next = {
    schemaVersion: 1,
    symbol: file.symbol,
    cadence: file.cadence,
    period: file.period,
    canonicalUrl: file.url,
    transportUrl: file.transportUrl ?? file.url,
    expectedBytes: file.bytes,
    officialSha256: file.sha256,
    state,
    updatedAt: iso(now),
    ...current,
    ...extra,
    state,
    updatedAt: iso(now)
  };
  await writeJsonAtomic(partitionPaths(file, root).statePath, next);
  return next;
}

export function isPartitionSkipEligible(file, root) {
  const state = loadPartitionState(file, root);
  return state?.derivedCommitted === true && ['DERIVED_COMMITTED', 'RAW_DELETED'].includes(state.state);
}

export function createSpoolController(maxBytes = DEFAULT_MAX_VERIFIED_ZIP_SPOOL_BYTES) {
  let reservedBytes = 0;
  return {
    get reservedBytes() { return reservedBytes; },
    get maxBytes() { return maxBytes; },
    reserve(bytes) {
      if (!Number.isSafeInteger(bytes) || bytes < 0 || reservedBytes + bytes > maxBytes) {
        throw new Error('VERIFIED_ZIP_SPOOL_CAP_EXCEEDED');
      }
      reservedBytes += bytes;
    },
    release(bytes) {
      reservedBytes = Math.max(0, reservedBytes - bytes);
    }
  };
}

export function createDownloadCoordinator({
  maxConcurrency = DEFAULT_HTTP_CONCURRENCY,
  maxAllowedConcurrency = MAX_HTTP_CONCURRENCY
} = {}) {
  const ceiling = Math.min(MAX_HTTP_CONCURRENCY, Math.max(1, maxAllowedConcurrency));
  let limit = Math.min(ceiling, Math.max(1, maxConcurrency));
  let active = 0;
  const waiters = [];
  const drain = () => {
    while (waiters.length && active < limit) {
      active += 1;
      waiters.shift()();
    }
  };
  return {
    get limit() { return limit; },
    get active() { return active; },
    async run(task) {
      if (active >= limit) await new Promise(resolve => waiters.push(resolve));
      else active += 1;
      try {
        return await task();
      } finally {
        active -= 1;
        drain();
      }
    },
    observeStatus(status) {
      if (status === 429 || status === 503) {
        limit = Math.max(1, Math.ceil(limit / 2));
      }
      drain();
    },
    setLimit(next) {
      limit = Math.min(ceiling, Math.max(1, Number(next) || 1));
      drain();
    }
  };
}

function retryAfterMs(response, now = Date.now()) {
  const value = response.headers?.get?.('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function backoffMs(attempt, response, now, random = Math.random) {
  const retryAfter = response ? retryAfterMs(response, now) : null;
  if (retryAfter != null) return Math.min(120_000, retryAfter);
  return Math.min(120_000, 500 * 2 ** attempt + Math.floor(random() * 250));
}

function rangePlan(bytes, chunkBytes) {
  const ranges = [];
  for (let start = 0; start < bytes; start += chunkBytes) {
    ranges.push({ start, end: Math.min(bytes - 1, start + chunkBytes - 1) });
  }
  return ranges;
}

function rangeKey(range) {
  return range.start + ':' + range.end;
}

function normalizeCompletedRanges(ranges, plan) {
  const valid = new Set(plan.map(rangeKey));
  return [...new Map((Array.isArray(ranges) ? ranges : [])
    .filter(range => valid.has(rangeKey(range)))
    .map(range => [rangeKey(range), { start: range.start, end: range.end }])).values()]
    .sort((left, right) => left.start - right.start);
}

async function sha256FileStream(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function mapConcurrent(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function consume() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, consume));
  return results;
}

async function fetchRange(file, range, {
  transportUrl,
  fetchImpl = fetchWithTimeout,
  coordinator,
  sleepImpl = sleep,
  now = () => Date.now(),
  random = Math.random,
  maxAttempts = 5
}) {
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await coordinator.run(() => fetchImpl(transportUrl, {
        headers: { Range: 'bytes=' + range.start + '-' + range.end }
      }));
      const payload = Buffer.from(await response.arrayBuffer());
      const validPartial = validatePartialResponse({
        status: response.status,
        contentRange: response.headers.get('content-range'),
        payloadLength: payload.length,
        start: range.start,
        end: range.end,
        total: file.bytes
      });
      const validFull = range.start === 0 && range.end === file.bytes - 1
        && response.status === 200 && payload.length === file.bytes;
      if (validPartial || validFull) return payload;
      coordinator.observeStatus(response.status);
      lastError = new Error('RANGE_RESPONSE_INVALID:' + response.status + ':' + payload.length);
      if (response.status === 418) throw lastError;
      if (attempt + 1 < maxAttempts) await sleepImpl(backoffMs(attempt, response, now(), random));
    } catch (error) {
      if (String(error?.message ?? '').startsWith('RANGE_RESPONSE_INVALID:418')) throw error;
      lastError = error;
      if (attempt + 1 < maxAttempts) await sleepImpl(backoffMs(attempt, null, now(), random));
    }
  }
  throw lastError ?? new Error('RANGE_DOWNLOAD_FAILED');
}

function compatibleResumeState(state, file, transportUrl, chunkBytes) {
  return state
    && state.canonicalUrl === file.url
    && state.expectedBytes === file.bytes
    && state.officialSha256 === file.sha256
    && state.chunkBytes === chunkBytes
    ? state
    : null;
}

export async function downloadArchiveWithResume(file, {
  root,
  transportUrl = file.transportUrl ?? file.url,
  chunkBytes = DEFAULT_CHUNK_BYTES,
  concurrency = DEFAULT_HTTP_CONCURRENCY,
  coordinator = createDownloadCoordinator({ maxConcurrency: concurrency }),
  spoolController = null,
  fetchImpl = fetchWithTimeout,
  sleepImpl = sleep,
  now = () => Date.now(),
  random = Math.random,
  maxAttempts = 5
} = {}) {
  if (!root) throw new Error('DOWNLOAD_ROOT_REQUIRED');
  if (!Number.isSafeInteger(file.bytes) || file.bytes <= 0) throw new Error('ARCHIVE_SIZE_INVALID');
  await fsp.mkdir(root, { recursive: true });
  const paths = partitionPaths(file, root);
  const plan = rangePlan(file.bytes, chunkBytes);
  let state = compatibleResumeState(readJson(paths.resumePath), file, transportUrl, chunkBytes) ?? {
    schemaVersion: 1,
    symbol: file.symbol,
    cadence: file.cadence,
    period: file.period,
    canonicalUrl: file.url,
    transportUrl,
    expectedBytes: file.bytes,
    officialSha256: file.sha256,
    chunkBytes,
    completedRanges: [],
    downloadedBytes: 0,
    attempts: 0,
    checksumAttempts: 0,
    checksumVerified: false,
    lastUpdatedAt: iso(now())
  };
  state.transportUrl = transportUrl;
  state.completedRanges = normalizeCompletedRanges(state.completedRanges, plan);
  state.downloadedBytes = state.completedRanges.reduce((sum, range) => sum + range.end - range.start + 1, 0);
  const existingState = loadPartitionState(file, root);
  if (existingState?.derivedCommitted === true) {
    return { path: paths.partPath, bytes: file.bytes, sha256: file.sha256, state: existingState.state, skipped: true };
  }
  await fsp.open(paths.partPath, 'a').then(handle => handle.close());
  const stat = await fsp.stat(paths.partPath);
  if (stat.size !== file.bytes) await fsp.truncate(paths.partPath, file.bytes);
  let checksumAttempt = Number(state.checksumAttempts) || 0;
  while (true) {
    await writeJsonAtomic(paths.resumePath, { ...state, lastUpdatedAt: iso(now()) });
    await setPartitionState(file, root, 'DOWNLOADING', { completedRanges: state.completedRanges, downloadedBytes: state.downloadedBytes }, now());
    const descriptor = await fsp.open(paths.partPath, 'r+');
    try {
      const completed = new Set(state.completedRanges.map(rangeKey));
      const missing = plan.filter(range => !completed.has(rangeKey(range)));
      await mapConcurrent(missing, Math.min(concurrency, MAX_HTTP_CONCURRENCY), async range => {
        const payload = await fetchRange(file, range, { transportUrl, fetchImpl, coordinator, sleepImpl, now, random, maxAttempts });
        const expected = range.end - range.start + 1;
        if (payload.length !== expected) throw new Error('RANGE_LENGTH_INVALID');
        await descriptor.write(payload, 0, payload.length, range.start);
        state.completedRanges.push(range);
        state.completedRanges.sort((left, right) => left.start - right.start);
        state.downloadedBytes += payload.length;
        state.attempts += 1;
        await writeJsonAtomic(paths.resumePath, { ...state, lastUpdatedAt: iso(now()) });
      });
      await descriptor.sync();
    } catch (error) {
      await descriptor.close();
      await setPartitionState(file, root, 'TRANSFER_RETRYABLE', {
        completedRanges: state.completedRanges,
        downloadedBytes: state.downloadedBytes,
        errorCode: error.code ?? error.message
      }, now());
      throw error;
    }
    await descriptor.close();
    await setPartitionState(file, root, 'DOWNLOADED', { downloadedBytes: file.bytes }, now());
    const actualSha256 = await sha256FileStream(paths.partPath);
    if (actualSha256 !== file.sha256) {
      checksumAttempt += 1;
      state.checksumAttempts = checksumAttempt;
      await setPartitionState(file, root, 'CHECKSUM_FAIL', { checksumAttempts: checksumAttempt }, now());
      await fsp.rm(paths.partPath, { force: true });
      await fsp.rm(paths.resumePath, { force: true });
      if (checksumAttempt >= 2) throw new Error('DATA_FAIL_SOURCE_INTEGRITY');
      state = {
        ...state,
        completedRanges: [],
        downloadedBytes: 0,
        checksumVerified: false,
        checksumAttempts: checksumAttempt
      };
      await fsp.open(paths.partPath, 'a').then(handle => handle.close());
      await fsp.truncate(paths.partPath, file.bytes);
      continue;
    }
    state.checksumVerified = true;
    state.lastUpdatedAt = iso(now());
    await writeJsonAtomic(paths.resumePath, state);
    await setPartitionState(file, root, 'SHA256_VERIFIED', {
      checksumVerified: true,
      downloadedBytes: file.bytes,
      completedRanges: state.completedRanges
    }, now());
    if (spoolController) spoolController.reserve(file.bytes);
    return { path: paths.partPath, bytes: file.bytes, sha256: actualSha256, state: 'SHA256_VERIFIED', skipped: false };
  }
}

export async function markPartitionParsed(file, { root, derivedFileOffset, derivedFileSha256, now = Date.now() } = {}) {
  return setPartitionState(file, root, 'PARSED', { derivedFileOffset, derivedFileSha256 }, now);
}

export async function commitDerivedPartition(file, {
  root,
  derivedFileOffset,
  derivedFileSha256,
  checkpoint = null,
  spoolController = null,
  now = Date.now()
} = {}) {
  const before = loadPartitionState(file, root);
  if (!['SHA256_VERIFIED', 'PARSED'].includes(before?.state)) throw new Error('DERIVED_COMMIT_REQUIRES_VERIFIED_ARCHIVE');
  if (!Number.isSafeInteger(derivedFileOffset) || !/^[a-f0-9]{64}$/.test(derivedFileSha256 ?? '')) {
    throw new Error('DERIVED_CHECKPOINT_INVALID');
  }
  await setPartitionState(file, root, 'DERIVED_COMMITTED', {
    derivedCommitted: true,
    derivedFileOffset,
    derivedFileSha256,
    checkpoint,
    rawDeleted: false
  }, now);
  const paths = partitionPaths(file, root);
  await fsp.rm(paths.partPath, { force: true });
  await fsp.rm(paths.resumePath, { force: true });
  await setPartitionState(file, root, 'RAW_DELETED', {
    derivedCommitted: true,
    rawDeleted: true
  }, now);
  spoolController?.release(file.bytes);
  return loadPartitionState(file, root);
}

function pickSamples(files) {
  const pick = (symbol, order = 'desc') => files.filter(file => file.symbol === symbol)
    .sort((left, right) => order === 'desc' ? right.bytes - left.bytes : left.bytes - right.bytes)[0];
  const samples = [pick('BTCUSDT'), pick('ETHUSDT'), pick('LTCUSDT', 'asc')].filter(Boolean);
  return [...new Map(samples.map(file => [file.url, file])).values()];
}

export async function benchmarkOfficialTransports(files, {
  sampleBytes = 8_000_000,
  fetchImpl = fetchWithTimeout,
  now = () => Date.now(),
  timeoutMs = 60_000
} = {}) {
  const samples = pickSamples(files);
  const endpoints = [
    { name: 'canonical', resolve: file => file.url },
    { name: 'direct-s3', resolve: file => directS3UrlFor(file.url) }
  ];
  const measurements = [];
  for (const endpoint of endpoints) {
    for (const file of samples) {
      const bytes = Math.min(sampleBytes, file.bytes);
      const end = bytes - 1;
      const url = endpoint.resolve(file);
      const started = now();
      try {
        const response = await fetchImpl(url, { headers: { Range: 'bytes=0-' + end } }, timeoutMs);
        const payload = Buffer.from(await response.arrayBuffer());
        const elapsedMs = Math.max(1, now() - started);
        const valid = validatePartialResponse({
          status: response.status,
          contentRange: response.headers.get('content-range'),
          payloadLength: payload.length,
          start: 0,
          end,
          total: file.bytes
        });
        measurements.push({ endpoint: endpoint.name, symbol: file.symbol, period: file.period, canonicalUrl: file.url, transportUrl: url, objectKey: objectKeyFromCanonicalUrl(file.url), expectedBytes: file.bytes, officialSha256: file.sha256, bytes: payload.length, elapsedMs, throughputBytesPerSecond: payload.length * 1000 / elapsedMs, status: response.status, contentRange: response.headers.get('content-range'), rangeSupport: valid, valid });
      } catch (error) {
        measurements.push({ endpoint: endpoint.name, symbol: file.symbol, period: file.period, canonicalUrl: file.url, transportUrl: url, objectKey: objectKeyFromCanonicalUrl(file.url), expectedBytes: file.bytes, officialSha256: file.sha256, bytes: 0, elapsedMs: Math.max(1, now() - started), throughputBytesPerSecond: 0, status: null, contentRange: null, rangeSupport: false, valid: false, errorCode: error.code ?? error.name ?? 'FETCH_FAILED' });
      }
    }
  }
  const summaries = endpoints.map(endpoint => {
    const rows = measurements.filter(row => row.endpoint === endpoint.name);
    const validRows = rows.filter(row => row.valid);
    const throughputs = validRows.map(row => row.throughputBytesPerSecond).sort((left, right) => left - right);
    const medianThroughput = throughputs.length ? throughputs[Math.floor(throughputs.length / 2)] : 0;
    const allSamplesValid = rows.length === samples.length && validRows.length === rows.length;
    return {
      endpoint: endpoint.name,
      sampleCount: rows.length,
      validSampleCount: validRows.length,
      allSamplesValid,
      medianThroughputBytesPerSecond: medianThroughput,
      reasonableThroughput: allSamplesValid && medianThroughput >= MIN_REASONABLE_THROUGHPUT_BYTES_PER_SECOND,
      estimatedAcquisitionHoursAtDefaultConcurrency: medianThroughput > 0
        ? files.reduce((sum, file) => sum + file.bytes, 0) / medianThroughput / DEFAULT_HTTP_CONCURRENCY / 3600
        : null
    };
  });
  const valid = summaries.filter(row => row.reasonableThroughput).sort((left, right) => right.medianThroughputBytesPerSecond - left.medianThroughputBytesPerSecond);
  return {
    sampleBytes,
    minimumReasonableThroughputBytesPerSecond: MIN_REASONABLE_THROUGHPUT_BYTES_PER_SECOND,
    totalCompressedBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    samples: samples.map(file => ({ symbol: file.symbol, period: file.period, canonicalUrl: file.url, transportUrl: directS3UrlFor(file.url), objectKey: objectKeyFromCanonicalUrl(file.url), expectedBytes: file.bytes, officialSha256: file.sha256 })),
    measurements,
    summaries,
    selectedEndpoint: valid[0]?.endpoint ?? null,
    selection: valid.length ? 'FASTEST_VALID_OFFICIAL_TRANSPORT' : 'HOST_NETWORK_THROUGHPUT_BLOCKER',
    selectedConcurrency: valid.length ? DEFAULT_HTTP_CONCURRENCY : null
  };
}

export function buildAcquisitionProgress(files, { root, benchmark = null, now = Date.now() } = {}) {
  const states = files.map(file => ({ file, state: loadPartitionState(file, root) }));
  const isVerified = state => ['SHA256_VERIFIED', 'PARSED', 'DERIVED_COMMITTED', 'RAW_DELETED'].includes(state?.state) || state?.checksumVerified === true;
  const isDerived = state => state?.derivedCommitted === true;
  const bySymbol = Object.fromEntries([...new Set(files.map(file => file.symbol))].map(symbol => {
    const rows = states.filter(row => row.file.symbol === symbol);
    return [symbol, {
      discovered: rows.length,
      downloaded: rows.filter(row => ['DOWNLOADED', 'SHA256_VERIFIED', 'PARSED', 'DERIVED_COMMITTED', 'RAW_DELETED'].includes(row.state?.state)).length,
      verified: rows.filter(row => isVerified(row.state)).length,
      derived: rows.filter(row => isDerived(row.state)).length
    }];
  }));
  return {
    schemaVersion: 1,
    artifactType: 'HY_EXP_0040_DATA_ACQUISITION_PROGRESS',
    immutable: false,
    experimentId: 'HY-EXP-0040',
    generatedAt: iso(now),
    totalPartitions: files.length,
    totalCompressedBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    verifiedPartitions: states.filter(row => isVerified(row.state)).length,
    verifiedBytes: states.filter(row => isVerified(row.state)).reduce((sum, row) => sum + row.file.bytes, 0),
    derivedPartitions: states.filter(row => isDerived(row.state)).length,
    pendingPartitions: states.filter(row => !isDerived(row.state)
      && !['CHECKSUM_FAIL', 'PARSE_FAIL', 'SOURCE_INVALID', 'TRANSFER_RETRYABLE'].includes(row.state?.state)).length,
    retryingPartitions: states.filter(row => row.state?.state === 'TRANSFER_RETRYABLE').length,
    failedPartitions: states.filter(row => ['CHECKSUM_FAIL', 'PARSE_FAIL', 'SOURCE_INVALID'].includes(row.state?.state)).length,
    perSymbol: bySymbol,
    selectedTransport: benchmark?.selectedEndpoint ?? null,
    measuredThroughput: benchmark?.summaries ?? [],
    outcomeRead: false,
    pnlComputed: false,
    finalOosRead: false
  };
}
