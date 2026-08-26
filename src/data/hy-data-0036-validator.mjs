import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  HY_DATA_0036_DEPTH_FEATURE_FIELDS,
  HY_DATA_0036_FEATURE_FIELDS,
  HY_DATA_0036_ID,
  HY_DATA_0036_INTERVALS,
  HY_DATA_0036_QUALITY_TARGETS,
  HY_DATA_0036_STREAMS,
  HY_DATA_0036_SYMBOLS
} from './hy-data-0036-contract.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const STREAM_IDS = new Set(HY_DATA_0036_STREAMS.map(stream => stream.id));
const INTERVAL_MS = Object.freeze({ '1s': 1_000, '5s': 5_000, '1m': 60_000 });
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function fail(message) {
  throw new Error(message);
}

function integer(name, value, { minimum = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`invalid ${name}`);
  return value;
}

function finite(name, value, { minimum = -Infinity, maximum = Infinity } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    fail(`invalid ${name}`);
  }
  return value;
}

function symbol(value) {
  const normalized = String(value ?? '').toUpperCase();
  if (!HY_DATA_0036_SYMBOLS.includes(normalized)) fail('symbol is outside HY-DATA-0036 fixed universe');
  return normalized;
}

function assertSequence(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('raw sequence/update id is missing');
  const fields = ['updateId', 'aggregateTradeId', 'firstUpdateId', 'finalUpdateId', 'lastUpdateId'];
  if (!fields.some(field => Number.isSafeInteger(value[field]) && value[field] >= 0)) {
    fail('raw sequence/update id is invalid');
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function validateRawRecord(record, { collectionStartAt } = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) fail('raw record is not an object');
  for (const field of ['source', 'stream', 'symbol', 'exchangeEventTime', 'tradeTime', 'localReceiveTime', 'sequence', 'rawPayload', 'schemaVersion']) {
    if (!own(record, field)) fail(`raw record missing ${field}`);
  }
  if (record.source !== 'binance-public-usdm') fail('raw record source is not public Binance USD-M');
  if (!STREAM_IDS.has(record.stream)) fail('raw stream is not registered');
  const normalizedSymbol = symbol(record.symbol);
  if (record.schemaVersion !== 1) fail('raw schemaVersion is not frozen version 1');
  const exchangeEventTime = integer('exchangeEventTime', record.exchangeEventTime);
  const localReceiveTime = integer('localReceiveTime', record.localReceiveTime);
  if (record.tradeTime !== null) integer('tradeTime', record.tradeTime);
  assertSequence(record.sequence);
  if (record.rawPayload === undefined) fail('raw payload is missing');
  if (collectionStartAt != null) {
    const boundary = integer('collectionStartAt', collectionStartAt);
    if (exchangeEventTime < boundary || localReceiveTime < boundary) {
      fail('raw record predates collectionStartAt');
    }
  }
  return Object.freeze({
    symbol: normalizedSymbol,
    stream: record.stream,
    exchangeEventTime,
    localReceiveTime,
    receiveLatencyMs: localReceiveTime - exchangeEventTime,
    clockStatus: 'UNVALIDATED'
  });
}

export function normalizeAggTrade(payload) {
  if (!payload || typeof payload !== 'object') fail('aggTrade payload is missing');
  const normalizedSymbol = symbol(payload.s);
  const aggregateTradeId = integer('aggregate trade id', payload.a);
  const price = finite('aggregate trade price', Number(payload.p), { minimum: Number.MIN_VALUE });
  const quantity = finite('aggregate trade quantity', Number(payload.q), { minimum: Number.MIN_VALUE });
  const eventTime = integer('aggregate trade time', payload.T ?? payload.E);
  if (typeof payload.m !== 'boolean') fail('maker flag is invalid');
  const aggressorSide = payload.m ? 'SELL' : 'BUY';
  const quoteNotional = price * quantity;
  return Object.freeze({
    symbol: normalizedSymbol,
    aggregateTradeId,
    price,
    quantity,
    quoteNotional,
    aggressorSide,
    signedVolume: aggressorSide === 'BUY' ? quoteNotional : -quoteNotional,
    eventTime
  });
}

export function parseBookTicker(payload) {
  if (!payload || typeof payload !== 'object') fail('bookTicker payload is missing');
  const normalizedSymbol = symbol(payload.s);
  const bidPrice = finite('bid price', Number(payload.b), { minimum: Number.MIN_VALUE });
  const askPrice = finite('ask price', Number(payload.a), { minimum: Number.MIN_VALUE });
  if (bidPrice >= askPrice) fail('bookTicker is crossed or locked');
  return Object.freeze({
    symbol: normalizedSymbol,
    updateId: integer('bookTicker update id', payload.u),
    bidPrice,
    askPrice,
    bidQuantity: finite('bid quantity', Number(payload.B), { minimum: 0 }),
    askQuantity: finite('ask quantity', Number(payload.A), { minimum: 0 }),
    eventTime: integer('bookTicker event time', payload.E ?? payload.T)
  });
}

export function parseDepth20(payload) {
  if (!payload || typeof payload !== 'object') fail('depth20 payload is missing');
  const normalizedSymbol = symbol(payload.s);
  const levels = side => {
    if (!Array.isArray(payload[side]) && !Array.isArray(payload[side === 'bids' ? 'b' : 'a'])) fail(`depth20 ${side} are missing`);
    const source = payload[side] ?? payload[side === 'bids' ? 'b' : 'a'];
    if (source.length > 20) fail(`depth20 ${side} exceeds 20 levels`);
    return source.map((level, index) => {
      if (!Array.isArray(level) || level.length < 2) fail(`depth20 ${side}[${index}] is invalid`);
      return [
        finite(`${side}[${index}] price`, Number(level[0]), { minimum: Number.MIN_VALUE }),
        finite(`${side}[${index}] quantity`, Number(level[1]), { minimum: 0 })
      ];
    });
  };
  return Object.freeze({
    symbol: normalizedSymbol,
    updateId: integer('depth20 update id', payload.lastUpdateId ?? payload.u),
    bids: levels('bids'),
    asks: levels('asks'),
    eventTime: integer('depth20 event time', payload.E ?? payload.T)
  });
}

function depthFailure(reason, extra = {}) {
  return Object.freeze({
    status: 'INVALID',
    bookStateValid: false,
    reason,
    resyncRequired: true,
    depthFeatures: null,
    ...extra
  });
}

export function validateDepthSequence({ snapshot, updates } = {}) {
  try {
    if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(updates)) return depthFailure('INVALID_DEPTH_INPUT');
    const snapshotLastUpdateId = integer('snapshotLastUpdateId', snapshot.lastUpdateId ?? snapshot.snapshotLastUpdateId);
    const normalized = updates.map((update, index) => {
      if (!update || typeof update !== 'object') fail(`depth update ${index} is invalid`);
      const U = integer(`depth update ${index} U`, update.U);
      const u = integer(`depth update ${index} u`, update.u);
      if (U > u) fail(`depth update ${index} range is reversed`);
      const pu = update.pu == null ? null : integer(`depth update ${index} pu`, update.pu);
      return { U, u, pu, index };
    });
    const stale = normalized.filter(update => update.u < snapshotLastUpdateId);
    const firstIndex = normalized.findIndex(update => update.U <= snapshotLastUpdateId && snapshotLastUpdateId <= update.u);
    if (firstIndex < 0) {
      return depthFailure('SNAPSHOT_ALIGNMENT_FAILED', {
        snapshotLastUpdateId,
        staleUpdateIds: stale.map(update => update.u),
        firstUpdateId: null,
        finalUpdateId: null,
        previousFinalUpdateId: null,
        consumedBufferedEventCount: stale.length
      });
    }
    const applied = [normalized[firstIndex]];
    for (let index = firstIndex + 1; index < normalized.length; index++) {
      const previous = applied.at(-1);
      const current = normalized[index];
      if (current.u === previous.u) {
        return depthFailure('DUPLICATE_DEPTH_UPDATE', {
          snapshotLastUpdateId,
          offendingUpdateId: current.u,
          staleUpdateIds: stale.map(update => update.u)
        });
      }
      if (current.u < previous.u) {
        return depthFailure('OUT_OF_ORDER_DEPTH_UPDATE', {
          snapshotLastUpdateId,
          offendingUpdateId: current.u,
          previousFinalUpdateId: previous.u
        });
      }
      if (current.pu !== previous.u || current.U > previous.u + 1 || current.U > current.u) {
        return depthFailure('SEQUENCE_GAP', {
          snapshotLastUpdateId,
          offendingUpdateId: current.u,
          previousFinalUpdateId: previous.u,
          expectedPreviousFinalUpdateId: previous.u
        });
      }
      applied.push(current);
    }
    return Object.freeze({
      status: 'VALID',
      bookStateValid: true,
      resyncRequired: false,
      reason: null,
      snapshotLastUpdateId,
      firstUpdateId: applied[0].U,
      finalUpdateId: applied.at(-1).u,
      previousFinalUpdateId: applied.length > 1 ? applied.at(-2).u : applied[0].pu,
      staleUpdateIds: stale.map(update => update.u),
      appliedUpdateIds: applied.map(update => update.u),
      consumedBufferedEventCount: stale.length + applied.length
    });
  } catch (error) {
    return depthFailure(error.message.replaceAll(' ', '_'));
  }
}

export function depthFeaturesOrNull(bookStateValid, values = {}) {
  if (!bookStateValid) return Object.freeze(Object.fromEntries(HY_DATA_0036_DEPTH_FEATURE_FIELDS.map(field => [field, null])));
  return Object.freeze(Object.fromEntries(HY_DATA_0036_DEPTH_FEATURE_FIELDS.map(field => [field, values[field] ?? null])));
}

export function validateClock({ exchangeEventTime, localReceiveTime, clockDriftMs } = {}) {
  const exchange = integer('exchangeEventTime', exchangeEventTime);
  const received = integer('localReceiveTime', localReceiveTime);
  const drift = finite('clockDriftMs', clockDriftMs);
  const receiveLatencyMs = received - exchange;
  if (Math.abs(drift) > 500) {
    return Object.freeze({ status: 'CLOCK_UNTRUSTED', latencyTrusted: false, receiveLatencyMs, clockDriftMs: drift });
  }
  return Object.freeze({ status: 'CLOCK_TRUSTED', latencyTrusted: true, receiveLatencyMs, clockDriftMs: drift });
}

export function computeCausalLargeTradeThreshold(trades, { asOf, priorWindowComplete = false } = {}) {
  const cutoff = integer('asOf', asOf);
  if (!Array.isArray(trades)) fail('prior aggTrade observations must be an array');
  if (trades.some(trade => integer('trade event time', trade.eventTime) >= cutoff)) {
    fail('future aggTrade distribution is not allowed');
  }
  const windowStart = cutoff - DAY_MS;
  const prior = trades
    .filter(trade => trade.eventTime >= windowStart && trade.eventTime < cutoff)
    .map(trade => finite('trade quote notional', Number(trade.quoteNotional), { minimum: 0 }))
    .sort((left, right) => left - right);
  if (!priorWindowComplete || !prior.length) {
    return Object.freeze({ status: 'WARMUP', threshold: null, asOf: cutoff, windowStart, sampleSize: prior.length });
  }
  const rank = Math.max(0, Math.ceil(0.95 * prior.length) - 1);
  return Object.freeze({
    status: 'VALID',
    threshold: prior[rank],
    asOf: cutoff,
    windowStart,
    sampleSize: prior.length,
    percentile: 0.95
  });
}

function assertFeatureValue(field, value) {
  if (value === null) return;
  if (field === 'tradeCount') integer(field, value);
  else finite(field, value);
}

export function validateFeatureSnapshot(snapshot, { collectionStartAt } = {}) {
  if (!snapshot || typeof snapshot !== 'object') fail('feature snapshot is not an object');
  const normalizedSymbol = symbol(snapshot.symbol);
  integer('snapshotAt', snapshot.snapshotAt);
  if (!HY_DATA_0036_INTERVALS.includes(snapshot.interval)) fail('feature interval is not registered');
  if (snapshot.snapshotAt % INTERVAL_MS[snapshot.interval] !== 0) fail('feature snapshot is not interval aligned');
  if (collectionStartAt != null && snapshot.snapshotAt < integer('collectionStartAt', collectionStartAt)) {
    fail('feature snapshot predates collectionStartAt');
  }
  if (typeof snapshot.bookStateValid !== 'boolean') fail('bookStateValid is missing');
  if (snapshot.clockStatus !== 'CLOCK_TRUSTED' && snapshot.clockStatus !== 'CLOCK_UNTRUSTED') {
    fail('clockStatus is invalid');
  }
  finite('featureCoverage', snapshot.featureCoverage, { minimum: 0, maximum: 1 });
  for (const field of HY_DATA_0036_FEATURE_FIELDS) {
    if (!own(snapshot, field)) fail(`feature snapshot missing ${field}`);
    assertFeatureValue(field, snapshot[field]);
  }
  if (!snapshot.bookStateValid && HY_DATA_0036_DEPTH_FEATURE_FIELDS.some(field => snapshot[field] !== null)) {
    fail('invalid book has non-null depth feature');
  }
  return Object.freeze({ symbol: normalizedSymbol, snapshotAt: snapshot.snapshotAt, interval: snapshot.interval });
}

export function createFeatureSnapshot({ symbol: inputSymbol, snapshotAt, interval, bookStateValid, clockStatus, featureCoverage = 1, values = {}, collectionStartAt } = {}) {
  const snapshot = {
    snapshotAt,
    symbol: symbol(inputSymbol),
    interval,
    ...Object.fromEntries(HY_DATA_0036_FEATURE_FIELDS.map(field => [field, values[field] ?? null])),
    ...depthFeaturesOrNull(bookStateValid, values),
    bookStateValid,
    clockStatus,
    featureCoverage
  };
  validateFeatureSnapshot(snapshot, { collectionStartAt });
  return deepFreeze(snapshot);
}

export function assessDailyQuality(metrics = {}) {
  const checks = {
    uptime: Number(metrics.uptime) >= HY_DATA_0036_QUALITY_TARGETS.uptime,
    bookValidCoverage: Number(metrics.bookValidCoverage) >= HY_DATA_0036_QUALITY_TARGETS.bookValidCoverage,
    aggTradeCoverage: Number(metrics.aggTradeCoverage) >= HY_DATA_0036_QUALITY_TARGETS.aggTradeCoverage,
    bookTickerCoverage: Number(metrics.bookTickerCoverage) >= HY_DATA_0036_QUALITY_TARGETS.bookTickerCoverage
  };
  const failedGates = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  return Object.freeze({
    status: failedGates.length ? 'DATA_QUALITY_FAIL' : 'DATA_QUALITY_PASS',
    checks,
    failedGates,
    qualityGatePassed: failedGates.length === 0
  });
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function createImmutableManifest({ files = [], coverage = {}, source = 'binance-public-usdm' } = {}) {
  if (!Array.isArray(files) || !files.length) fail('manifest needs at least one file');
  const manifestFiles = files.map(file => {
    if (!file || typeof file !== 'object' || typeof file.path !== 'string') fail('manifest file path is missing');
    const digest = file.bytes != null
      ? sha256(typeof file.bytes === 'string' || Buffer.isBuffer(file.bytes) ? file.bytes : Buffer.from(file.bytes))
      : file.sha256;
    if (!/^[a-f0-9]{64}$/.test(digest)) fail(`manifest SHA-256 is missing for ${file.path}`);
    if (!Number.isSafeInteger(file.rowCount) || file.rowCount < 0) fail(`manifest rowCount is invalid for ${file.path}`);
    return {
      path: file.path.replaceAll('\\', '/'),
      sha256: digest,
      rowCount: file.rowCount,
      symbol: file.symbol ?? null,
      stream: file.stream ?? null,
      coverage: file.coverage ?? null,
      schemaVersion: file.schemaVersion ?? 1
    };
  });
  const body = {
    schemaVersion: 1,
    immutable: true,
    datasetId: HY_DATA_0036_ID,
    source,
    coverage,
    files: manifestFiles
  };
  return deepFreeze({ ...body, manifestSha256: sha256(canonicalJson(body)) });
}

export function verifyImmutableManifest(manifest) {
  if (!manifest || manifest.immutable !== true || manifest.datasetId !== HY_DATA_0036_ID) return false;
  const { manifestSha256, ...body } = manifest;
  return /^[a-f0-9]{64}$/.test(manifestSha256) && sha256(canonicalJson(body)) === manifestSha256;
}

export function createAppendOnlyRawWriter() {
  const records = [];
  let sealed = false;
  return Object.freeze({
    append(record) {
      if (sealed) fail('RAW_APPEND_ONLY_SEALED');
      const copy = structuredClone(record);
      records.push(deepFreeze(copy));
      return records.length;
    },
    snapshot() {
      return Object.freeze(records.slice());
    },
    seal() {
      sealed = true;
      return Object.freeze(records.slice());
    },
    get sealed() {
      return sealed;
    }
  });
}

function contained(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export const HY_DATA_0036_ENGINEERING_ROOT = path.join('data', 'raw', 'engineering-dry-run', HY_DATA_0036_ID);
export const HY_DATA_0036_PROSPECTIVE_ROOT = path.join('data', 'raw', 'prospective', HY_DATA_0036_ID);

export function isResearchEligibleCaptureRoot(captureRoot, { repositoryRoot = process.cwd() } = {}) {
  const candidate = path.resolve(captureRoot);
  const engineering = path.resolve(repositoryRoot, HY_DATA_0036_ENGINEERING_ROOT);
  const prospective = path.resolve(repositoryRoot, HY_DATA_0036_PROSPECTIVE_ROOT);
  return contained(prospective, candidate) && !contained(engineering, candidate);
}

export function assertResearchEligibleCaptureRoot(captureRoot, options = {}) {
  if (!isResearchEligibleCaptureRoot(captureRoot, options)) {
    fail('capture root is not the canonical HY-DATA-0036 prospective root');
  }
  return path.resolve(captureRoot);
}
