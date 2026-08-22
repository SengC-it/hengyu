import path from 'node:path';

export const HY_EXP_0022_ID = 'HY-EXP-0022';
export const HY_EXP_0022_PREREGISTRATION_COMMIT = '792f9ef4630d724e77fa4df13847ff421bd3e521';
export const HY_EXP_0022_PREREGISTRATION_COMMITTED_AT = '2026-08-22T00:28:19.000Z';
export const HY_EXP_0022_PREREGISTRATION_SHA256 = '552bc2610df8c6bd85ed955aa4744cf172a82172cfcfbeab14b21d6d606dc74e';
export const HY_EXP_0022_CAPTURE_START = '2026-08-22T04:00:00.000Z';
export const HY_EXP_0022_PROPOSED_DEVELOPMENT_START = '2026-08-24T00:00:00.000Z';
export const HY_EXP_0022_DEVELOPMENT_END_EXCLUSIVE = '2027-03-01T00:00:00.000Z';
export const HY_EXP_0022_FINAL_OOS_START = '2027-03-01T00:00:00.000Z';
export const HY_EXP_0022_FINAL_OOS_END_EXCLUSIVE = '2027-09-01T00:00:00.000Z';
export const HY_EXP_0022_CAPTURE_ROOTS = Object.freeze({
  development: path.join('data', 'raw', 'prospective-development', HY_EXP_0022_ID),
  finalOos: path.join('data', 'raw', 'prospective-final-oos', HY_EXP_0022_ID)
});
export const HY_EXP_0022_MANIFEST_ROOT = path.join('artifacts', HY_EXP_0022_ID, 'manifests');
export const HY_EXP_0022_REQUIRED_STREAMS = Object.freeze([
  'depth.diff',
  'depth.snapshot',
  'kline.4h',
  'exchangeInfo',
  'funding',
  'universe.snapshot',
  'universe.audit',
  'segment.audit'
]);
export const HY_EXP_0022_DIAGNOSTIC_ONLY_STREAMS = Object.freeze(['ticker']);
export const HY_EXP_0022_ORDER_ENDPOINTS = Object.freeze([]);
export const HY_EXP_0022_ACCOUNT_ENDPOINTS = Object.freeze([]);
export const HY_EXP_0022_CAPTURE_OPERATIONS = Object.freeze(['write', 'hash', 'integrity_check']);
export const HY_EXP_0022_POST_DEVELOPMENT_READ_OPERATIONS = Object.freeze([
  'read_raw_final_oos',
  'read_manifest',
  'calculate_metrics',
  'generate_report'
]);
export const HY_EXP_0022_ENDPOINTS = Object.freeze({
  depthSnapshot: 'https://fapi.binance.com/fapi/v1/depth?symbol=<symbol>&limit=1000',
  depthStream: 'wss://fstream.binance.com/stream?streams=<symbol>@depth@100ms',
  klineRest: 'https://fapi.binance.com/fapi/v1/klines?symbol=<symbol>&interval=4h',
  klineStream: 'wss://fstream.binance.com/stream?streams=<symbol>@kline_4h',
  exchangeInfo: 'https://fapi.binance.com/fapi/v1/exchangeInfo',
  funding: 'https://fapi.binance.com/fapi/v1/fundingRate',
  ticker: 'https://fapi.binance.com/fapi/v1/ticker/24hr',
  order: null,
  account: null
});

const FOUR_HOURS_MS = 4 * 60 * 60 * 1_000;
const BAR_CLOSE_OFFSET_MS = FOUR_HOURS_MS - 1;
const PROSPECTIVE_WARMUP_BARS = 180;

function errorWithCode(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function timestamp(name, value) {
  const parsed = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
  if (!Number.isFinite(parsed)) throw errorWithCode('INVALID_TIMESTAMP', `invalid ${name}`);
  return parsed;
}

function iso(value) {
  return new Date(timestamp('timestamp', value)).toISOString();
}

function modeName(mode) {
  const normalized = String(mode ?? '').toUpperCase();
  if (!['DEVELOPMENT_CAPTURE', 'FINAL_OOS_CAPTURE'].includes(normalized)) {
    throw errorWithCode('HY_EXP_0022_MODE_INVALID', `unsupported HY-EXP-0022 capture mode: ${mode}`);
  }
  return normalized;
}

function decimal(value, name) {
  const text = String(value ?? '').trim();
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) {
    throw errorWithCode('HY_EXP_0022_INVALID_BAR', `${name} is not a decimal string`);
  }
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [wholePart, fractionPart = ''] = unsigned.split('.');
  const whole = wholePart.replace(/^0+(?=\d)/, '') || '0';
  const fraction = fractionPart.replace(/0+$/, '');
  if (whole === '0' && !fraction && negative) return '0';
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

function decimalNumber(value, name) {
  const parsed = Number(decimal(value, name));
  if (!Number.isFinite(parsed)) throw errorWithCode('HY_EXP_0022_INVALID_BAR', `${name} is not finite`);
  return parsed;
}

function sameDecimal(left, right) {
  return decimal(left, 'decimal') === decimal(right, 'decimal');
}

/** Return the first complete UTC 4h boundary strictly after a timestamp. */
export function firstCompleteUtc4hBoundaryAfter(value) {
  const parsed = timestamp('preregistration committedAt', value);
  return new Date((Math.floor(parsed / FOUR_HOURS_MS) + 1) * FOUR_HOURS_MS).toISOString();
}

export function resolveHyExp0022Windows({
  preregistrationCommittedAt = HY_EXP_0022_PREREGISTRATION_COMMITTED_AT,
  proposedDevelopmentStart = HY_EXP_0022_PROPOSED_DEVELOPMENT_START
} = {}) {
  const captureStart = firstCompleteUtc4hBoundaryAfter(preregistrationCommittedAt);
  const proposedStart = timestamp('proposed development start', proposedDevelopmentStart);
  const captureStartMs = timestamp('capture start', captureStart);
  return Object.freeze({
    captureStart,
    developmentStart: new Date(Math.max(proposedStart, captureStartMs)).toISOString(),
    developmentEndExclusive: HY_EXP_0022_DEVELOPMENT_END_EXCLUSIVE,
    finalOosStart: HY_EXP_0022_FINAL_OOS_START,
    finalOosEndExclusive: HY_EXP_0022_FINAL_OOS_END_EXCLUSIVE,
    finalOosImmutable: true
  });
}

export const HY_EXP_0022_WINDOWS = resolveHyExp0022Windows();

export function earliestHyExp0022CandidateTime({
  captureStart = HY_EXP_0022_WINDOWS.captureStart,
  developmentStart = HY_EXP_0022_WINDOWS.developmentStart
} = {}) {
  const warmupEnd = timestamp('capture start', captureStart) + PROSPECTIVE_WARMUP_BARS * FOUR_HOURS_MS;
  return new Date(Math.max(warmupEnd, timestamp('development start', developmentStart))).toISOString();
}

function windowForMode(mode, windows = HY_EXP_0022_WINDOWS) {
  const normalized = modeName(mode);
  if (normalized === 'DEVELOPMENT_CAPTURE') {
    return {
      start: timestamp('capture start', windows.captureStart),
      endExclusive: timestamp('development end', windows.developmentEndExclusive),
      startCode: 'PRE_CAPTURE_DATA',
      endCode: 'DEVELOPMENT_WINDOW_VIOLATION'
    };
  }
  return {
    start: timestamp('final OOS start', windows.finalOosStart),
    endExclusive: timestamp('final OOS end', windows.finalOosEndExclusive),
    startCode: 'OOS_BEFORE_FINAL_START',
    endCode: 'OOS_AFTER_FINAL_END'
  };
}

function assertInWindow(value, name, range) {
  const parsed = timestamp(name, value);
  if (parsed < range.start) throw errorWithCode(range.startCode, `${name} is before the mode window`);
  if (parsed >= range.endExclusive) throw errorWithCode(range.endCode, `${name} is at or after the mode window end`);
  return parsed;
}

/** Validate every causal and receipt timestamp for one capture record. */
export function validateHyExp0022CaptureRecord({
  mode,
  sourceTimestamp,
  receivedAt,
  timestamps = [],
  windows = HY_EXP_0022_WINDOWS
} = {}) {
  const range = windowForMode(mode, windows);
  if (sourceTimestamp === undefined || sourceTimestamp === null) {
    throw errorWithCode('MISSING_SOURCE_TIMESTAMP', 'a causal source timestamp is required');
  }
  if (receivedAt === undefined || receivedAt === null) {
    throw errorWithCode('MISSING_RECEIVED_AT', 'receivedAt is required');
  }
  const sourceMs = assertInWindow(sourceTimestamp, 'source timestamp', range);
  const receiptMs = assertInWindow(receivedAt, 'receivedAt', range);
  if (sourceMs > receiptMs) {
    throw errorWithCode('FUTURE_DATA', 'source timestamp is later than receivedAt');
  }
  const extra = Array.isArray(timestamps) ? timestamps : [timestamps];
  for (const value of extra) assertInWindow(value, 'record timestamp', range);
  return {
    eligible: true,
    mode: modeName(mode),
    sourceTimestamp: new Date(sourceMs).toISOString(),
    receivedAt: new Date(receiptMs).toISOString(),
    captureStart: windows.captureStart,
    futureData: false,
    proxy: false
  };
}

export function assertHyExp0022DevelopmentDecisionTime({
  decisionTime,
  windows = HY_EXP_0022_WINDOWS
} = {}) {
  const parsed = timestamp('decisionTime', decisionTime);
  const start = timestamp('development start', windows.developmentStart);
  const end = timestamp('development end', windows.developmentEndExclusive);
  if (parsed < start) throw errorWithCode('DEVELOPMENT_NOT_STARTED', 'decisionTime precedes developmentStart');
  if (parsed >= end) throw errorWithCode('DEVELOPMENT_WINDOW_VIOLATION', 'decisionTime is outside Development');
  return { eligible: true, decisionTime: new Date(parsed).toISOString() };
}

export function assertHyExp0022NoHistoricalBackfill({
  timestamp: recordTimestamp,
  captureStart = HY_EXP_0022_CAPTURE_START
} = {}) {
  if (timestamp === undefined || timestamp === null) {
    throw errorWithCode('MISSING_BAR_TIMESTAMP', 'bar timestamp is required');
  }
  if (timestampValue(recordTimestamp) < timestampValue(captureStart)) {
    throw errorWithCode('HISTORICAL_BACKFILL_FORBIDDEN', 'pre-capture bar backfill is forbidden');
  }
  return true;
}

function timestampValue(value) {
  return timestamp('timestamp', value);
}

function sourceMarker(raw, source) {
  const parts = [
    source,
    raw?.source,
    raw?.priceType,
    raw?.endpoint,
    raw?.data?.source,
    raw?.data?.priceType,
    raw?.data?.endpoint
  ].filter(Boolean).join(' ').toLowerCase();
  if (/mark[\s_-]*price|markpricekline/.test(parts)) {
    throw errorWithCode('MARK_PRICE_KLINE_FORBIDDEN', 'mark-price kline is not a contract-price bar');
  }
}

function rawKlineParts(raw) {
  if (Array.isArray(raw)) return { kind: 'REST', values: raw, metadata: {} };
  if (Array.isArray(raw?.values)) return { kind: 'REST', values: raw.values, metadata: raw };
  const envelope = raw?.data ?? raw;
  const kline = envelope?.k ?? envelope?.data?.k;
  if (kline) return { kind: 'WEBSOCKET', kline, metadata: envelope };
  throw errorWithCode('HY_EXP_0022_INVALID_BAR', 'unsupported Binance kline payload');
}

/** Normalize a Binance USD-M contract-price 4h final kline without fetching data. */
export function normalizeHyExp0022ContractKline({
  raw,
  receivedAt,
  sourceTimestamp,
  source,
  finalFlag,
  captureStart,
  mode = 'DEVELOPMENT_CAPTURE'
} = {}) {
  sourceMarker(raw, source);
  const parsed = rawKlineParts(raw);
  let openTime;
  let closeTime;
  let open;
  let high;
  let low;
  let close;
  let volume;
  let quoteVolume;
  let tradeCount;
  let closed;
  let exchangeTimestamp;

  if (parsed.kind === 'REST') {
    const values = parsed.values;
    if (values.length < 9) throw errorWithCode('HY_EXP_0022_INVALID_BAR', 'REST kline has insufficient fields');
    [openTime, open, high, low, close, volume, closeTime, quoteVolume, tradeCount] = values;
    closed = finalFlag ?? parsed.metadata.finalClosed ?? (timestampValue(closeTime) < timestampValue(receivedAt));
    exchangeTimestamp = sourceTimestamp ?? parsed.metadata.sourceTimestamp ?? closeTime;
  } else {
    const { kline, metadata } = parsed;
    if (String(kline.i ?? '') !== '4h') {
      throw errorWithCode('HY_EXP_0022_INVALID_BAR', 'only 4h WebSocket klines are allowed');
    }
    ({ t: openTime, T: closeTime, o: open, h: high, l: low, c: close, v: volume, q: quoteVolume, n: tradeCount, x: closed } = kline);
    if (finalFlag !== undefined && finalFlag !== closed) {
      throw errorWithCode('HY_EXP_0022_INVALID_BAR', 'final flag conflicts with WebSocket kline');
    }
    closed = finalFlag ?? closed;
    exchangeTimestamp = sourceTimestamp ?? kline.T ?? metadata.E ?? closeTime;
  }

  const receiptMs = timestampValue(receivedAt);
  const openMs = timestampValue(openTime);
  const closeMs = timestampValue(closeTime);
  if (closeMs !== openMs + BAR_CLOSE_OFFSET_MS) {
    throw errorWithCode('HY_EXP_0022_INVALID_BAR', '4h kline closeTime does not match openTime');
  }
  if (closed !== true || closeMs >= receiptMs) {
    throw errorWithCode('INCOMPLETE_4H_BAR', 'only completed 4h bars are eligible');
  }
  const normalized = {
    openTime: openMs,
    closeTime: closeMs,
    open: decimal(open, 'open'),
    high: decimal(high, 'high'),
    low: decimal(low, 'low'),
    close: decimal(close, 'close'),
    volume: decimal(volume, 'volume'),
    quoteVolume: decimal(quoteVolume, 'quoteVolume'),
    tradeCount: Number(tradeCount),
    finalClosed: true,
    sourceExchangeTimestamp: iso(exchangeTimestamp),
    receivedAt: iso(receivedAt),
    source: 'BINANCE_USDM_CONTRACT_PRICE_4H'
  };
  if (!Number.isInteger(normalized.tradeCount) || normalized.tradeCount < 0) {
    throw errorWithCode('HY_EXP_0022_INVALID_BAR', 'tradeCount must be a non-negative integer');
  }
  if (decimalNumber(normalized.high, 'high') < decimalNumber(normalized.low, 'low')) {
    throw errorWithCode('HY_EXP_0022_INVALID_BAR', 'high is below low');
  }
  if (captureStart !== undefined) {
    assertHyExp0022NoHistoricalBackfill({ timestamp: openMs, captureStart });
    validateHyExp0022CaptureRecord({
      mode,
      sourceTimestamp: exchangeTimestamp,
      receivedAt,
      captureStart
    });
  }
  return normalized;
}

const RECONCILIATION_FIELDS = Object.freeze([
  'openTime',
  'closeTime',
  'open',
  'high',
  'low',
  'close',
  'volume',
  'quoteVolume',
  'tradeCount',
  'finalClosed'
]);

function sameBar(left, right) {
  return RECONCILIATION_FIELDS.every((field) => {
    if (field === 'openTime' || field === 'closeTime' || field === 'tradeCount' || field === 'finalClosed') {
      return left[field] === right[field];
    }
    return sameDecimal(left[field], right[field]);
  });
}

/** Require final WebSocket and immediate REST confirmation to agree exactly. */
export function reconcileHyExp0022BarSources({ websocketBar, restBar } = {}) {
  if (!websocketBar && !restBar) {
    throw errorWithCode('BAR_CONFIRMATION_MISSING', 'neither WebSocket nor REST final bar is present');
  }
  if (!websocketBar || !restBar) {
    return {
      status: 'WAITING_CONFIRMATION',
      eligible: false,
      sourceUsed: null,
      bar: websocketBar ?? restBar
    };
  }
  if (!sameBar(websocketBar, restBar)) {
    throw errorWithCode('BAR_SOURCE_CONFLICT', 'final WebSocket and REST bars disagree');
  }
  return {
    status: 'ACCEPTED',
    eligible: true,
    sourceUsed: 'FINAL_WEBSOCKET_KLINE_REST_CONFIRMED',
    bar: websocketBar
  };
}

function assertBarForVolume(bar) {
  if (!bar || bar.finalClosed !== true) {
    throw errorWithCode('INVALID_COMPLETED_BAR', 'quote volume requires a final completed bar');
  }
  if (bar.source !== 'BINANCE_USDM_CONTRACT_PRICE_4H') {
    throw errorWithCode('INVALID_BAR_SOURCE', 'quote volume requires contract-price 4h bars');
  }
  decimalNumber(bar.quoteVolume, 'quoteVolume');
}

/** Calculate volume6 only from the six immediately preceding completed 4h bars. */
export function calculatePriorSixBarQuoteVolume({ bars = [], decisionOpenTime, ticker } = {}) {
  const target = timestampValue(decisionOpenTime);
  const prior = bars
    .filter((bar) => timestampValue(bar?.openTime) < target)
    .sort((left, right) => timestampValue(left.openTime) - timestampValue(right.openTime));
  if (prior.length < 6) {
    throw errorWithCode('INSUFFICIENT_COMPLETED_BARS_FOR_VOLUME6', 'six completed bars are required; ticker cannot substitute');
  }
  const selected = prior.slice(-6);
  const seen = new Set();
  selected.forEach((bar, index) => {
    assertBarForVolume(bar);
    const open = timestampValue(bar.openTime);
    if (seen.has(open) || (index > 0 && open - timestampValue(selected[index - 1].openTime) !== FOUR_HOURS_MS)) {
      throw errorWithCode('NONCONTIGUOUS_VOLUME6', 'the six completed bars are not contiguous');
    }
    seen.add(open);
  });
  if (timestampValue(selected[selected.length - 1].openTime) + FOUR_HOURS_MS !== target) {
    throw errorWithCode('NONCONTIGUOUS_VOLUME6', 'the last volume bar is not immediately before the decision bar');
  }
  const sum = selected.reduce((total, bar) => total + decimalNumber(bar.quoteVolume, 'quoteVolume'), 0);
  return {
    quoteVolumeUsdt: sum,
    barsUsed: selected.map((bar) => bar.openTime),
    tickerUsed: false,
    source: 'COMPLETED_4H_CONTRACT_KLINE'
  };
}

/** Require 180 valid prospective completed bars before any candidate/model row. */
export function assertHyExp0022ProspectiveWarmup({
  bars = [],
  decisionTime,
  captureStart = HY_EXP_0022_WINDOWS.captureStart
} = {}) {
  const decisionMs = timestampValue(decisionTime);
  const captureMs = timestampValue(captureStart);
  const eligible = bars
    .filter((bar) => timestampValue(bar?.openTime) >= captureMs
      && timestampValue(bar.openTime) < decisionMs
      && timestampValue(bar.closeTime) < decisionMs)
    .sort((left, right) => timestampValue(left.openTime) - timestampValue(right.openTime));
  if (eligible.length < PROSPECTIVE_WARMUP_BARS) {
    throw errorWithCode('INSUFFICIENT_PROSPECTIVE_WARMUP', `at least ${PROSPECTIVE_WARMUP_BARS} completed post-capture bars are required`);
  }
  const selected = eligible.slice(-PROSPECTIVE_WARMUP_BARS);
  selected.forEach((bar, index) => {
    assertBarForVolume(bar);
    if (index > 0 && timestampValue(bar.openTime) - timestampValue(selected[index - 1].openTime) !== FOUR_HOURS_MS) {
      throw errorWithCode('NONCONTIGUOUS_PROSPECTIVE_WARMUP', 'prospective warmup bars contain a gap');
    }
  });
  return {
    eligible: true,
    completedBars: selected.length,
    firstOpenTime: selected[0].openTime,
    lastOpenTime: selected[selected.length - 1].openTime,
    candidateTime: new Date(decisionMs).toISOString(),
    historicalBackfillUsed: false
  };
}

function rootForMode(projectRoot, mode) {
  const normalized = modeName(mode);
  return path.resolve(projectRoot, normalized === 'DEVELOPMENT_CAPTURE'
    ? HY_EXP_0022_CAPTURE_ROOTS.development
    : HY_EXP_0022_CAPTURE_ROOTS.finalOos);
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function expectedHyExp0022CaptureRoot({ projectRoot = process.cwd(), mode } = {}) {
  return rootForMode(projectRoot, mode);
}

/** Canonical containment, not substring identity, is the namespace boundary. */
export function assertHyExp0022CaptureRoot({ projectRoot = process.cwd(), mode, outputRoot } = {}) {
  const expected = rootForMode(projectRoot, mode);
  const actual = path.resolve(projectRoot, outputRoot ?? expected);
  if (!isWithin(expected, actual)) {
    throw errorWithCode('HY_EXP_0022_NAMESPACE_MISMATCH', 'capture output is outside the canonical experiment root');
  }
  return actual;
}

export function assertHyExp0022InputRoot({
  projectRoot = process.cwd(),
  mode,
  experimentId,
  inputPath
} = {}) {
  if (String(experimentId ?? '') !== HY_EXP_0022_ID) {
    throw errorWithCode('HY_EXP_0022_FOREIGN_INPUT', 'HY-EXP-0022 cannot consume a foreign experiment input');
  }
  const expected = rootForMode(projectRoot, mode);
  const actual = path.resolve(projectRoot, String(inputPath ?? ''));
  if (!isWithin(expected, actual)) {
    throw errorWithCode('HY_EXP_0022_FOREIGN_INPUT', 'input path is outside the canonical experiment root');
  }
  return actual;
}

export function assertHyExp0022FinalOosWindow({ start, endExclusive } = {}) {
  if (iso(start) !== HY_EXP_0022_FINAL_OOS_START || iso(endExclusive) !== HY_EXP_0022_FINAL_OOS_END_EXCLUSIVE) {
    throw errorWithCode('HY_EXP_0022_OOS_WINDOW_MUTATION', 'HY-EXP-0022 Final-OOS window is immutable');
  }
  return true;
}

/** Final-OOS operations are an explicit allowlist; unknown operations never inherit permission. */
export function assertHyExp0022FinalOosOperation({
  operation,
  developmentStatus = 'NOT_PASS',
  developmentAllowed = false
} = {}) {
  const normalized = String(operation ?? '').toLowerCase();
  const developmentPassed = developmentStatus === 'PASS' && developmentAllowed === true;
  if (developmentPassed && HY_EXP_0022_POST_DEVELOPMENT_READ_OPERATIONS.includes(normalized)) {
    return { allowed: true, operation: normalized, mode: 'POST_DEVELOPMENT_READ' };
  }
  if (!developmentPassed && HY_EXP_0022_CAPTURE_OPERATIONS.includes(normalized)) {
    return { allowed: true, operation: normalized, mode: 'RAW_CAPTURE_ONLY' };
  }
  if (developmentPassed) {
    throw errorWithCode('HY_EXP_0022_OOS_OPERATION_UNKNOWN', `Final-OOS operation ${normalized} is not explicitly allowlisted`);
  }
  throw errorWithCode('HY_EXP_0022_FINAL_OOS_LOCKED', `Final-OOS operation ${normalized} is locked until Development PASS`);
}

export function buildHyExp0022CaptureMetadata({ mode, runId, startedAt = Date.now() } = {}) {
  const normalizedMode = modeName(mode);
  const metadata = {
    schemaVersion: 1,
    experimentId: HY_EXP_0022_ID,
    runId: String(runId),
    captureMode: normalizedMode,
    captureStart: HY_EXP_0022_WINDOWS.captureStart,
    developmentWindow: {
      start: HY_EXP_0022_WINDOWS.developmentStart,
      endExclusive: HY_EXP_0022_WINDOWS.developmentEndExclusive
    },
    finalOosWindow: {
      start: HY_EXP_0022_WINDOWS.finalOosStart,
      endExclusive: HY_EXP_0022_WINDOWS.finalOosEndExclusive
    },
    requiredStreams: [...HY_EXP_0022_REQUIRED_STREAMS],
    diagnosticOnlyStreams: [...HY_EXP_0022_DIAGNOSTIC_ONLY_STREAMS],
    authorization: 'PAPER_ONLY',
    liveOrdersEnabled: false,
    accountApiEnabled: false,
    orderApiEnabled: false,
    orderEndpoints: [...HY_EXP_0022_ORDER_ENDPOINTS],
    accountEndpoints: [...HY_EXP_0022_ACCOUNT_ENDPOINTS],
    pnlComputed: false,
    developmentAllowed: false,
    finalOosEligible: false,
    futureDataUsed: false,
    historicalBackfillUsed: false,
    proxyDepthUsed: false,
    startedAt: iso(startedAt)
  };
  assertHyExp0022PaperOnly(metadata);
  return metadata;
}

export function assertHyExp0022PaperOnly(config = {}) {
  const failures = [];
  if (config.authorization !== 'PAPER_ONLY') failures.push('authorization_not_paper_only');
  if (config.liveOrdersEnabled !== false) failures.push('live_orders_enabled');
  if (config.accountApiEnabled !== false) failures.push('account_api_enabled');
  if (config.orderApiEnabled !== false) failures.push('order_api_enabled');
  if (config.pnlComputed !== false) failures.push('pnl_computed_during_capture');
  if (config.developmentAllowed !== false) failures.push('development_enabled_during_capture');
  if (Array.isArray(config.orderEndpoints) && config.orderEndpoints.length) failures.push('order_endpoint_present');
  if (Array.isArray(config.accountEndpoints) && config.accountEndpoints.length) failures.push('account_endpoint_present');
  if (failures.length) throw errorWithCode('HY_EXP_0022_CAPTURE_SAFETY', failures.join(','));
  return true;
}
