import path from 'node:path';

export const HY_EXP_0021_ID = 'HY-EXP-0021';
export const HY_EXP_0021_PREREGISTRATION_COMMIT = '518530097a6205e58c540dc2b14adb28b4fe2cf1';
export const HY_EXP_0021_PREREGISTRATION_COMMITTED_AT = '2026-08-22T00:10:47.000Z';
export const HY_EXP_0021_CAPTURE_START = '2026-08-22T04:00:00.000Z';
export const HY_EXP_0021_PROPOSED_DEVELOPMENT_START = '2026-08-24T00:00:00.000Z';
export const HY_EXP_0021_DEVELOPMENT_END_EXCLUSIVE = '2027-03-01T00:00:00.000Z';
export const HY_EXP_0021_FINAL_OOS_START = '2027-03-01T00:00:00.000Z';
export const HY_EXP_0021_FINAL_OOS_END_EXCLUSIVE = '2027-09-01T00:00:00.000Z';
export const HY_EXP_0021_CAPTURE_ROOTS = Object.freeze({
  development: path.join('data', 'raw', 'prospective-development', HY_EXP_0021_ID),
  finalOos: path.join('data', 'raw', 'prospective-final-oos', HY_EXP_0021_ID)
});
export const HY_EXP_0021_ORDER_ENDPOINTS = Object.freeze([]);
export const HY_EXP_0021_CAPTURE_OPERATIONS = Object.freeze(['write', 'hash', 'integrity_check']);
export const HY_EXP_0021_FINAL_OOS_READ_OPERATIONS = Object.freeze([
  'query',
  'summarize',
  'inspect',
  'calculate',
  'optimize',
  'generate_metrics',
  'train',
  'backtest'
]);
export const HY_EXP_0021_ENDPOINTS = Object.freeze({
  depthSnapshot: 'https://fapi.binance.com/fapi/v1/depth',
  depthStream: 'wss://fstream.binance.com/stream?streams=<symbol>@depth@100ms',
  funding: 'https://fapi.binance.com/fapi/v1/fundingRate',
  exchangeInfo: 'https://fapi.binance.com/fapi/v1/exchangeInfo',
  ticker: 'https://fapi.binance.com/fapi/v1/ticker/24hr',
  order: null,
  account: null
});

const FOUR_HOURS_MS = 4 * 60 * 60 * 1_000;

function timestamp(name, value) {
  const parsed = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
  if (!Number.isFinite(parsed)) throw new Error(`invalid ${name}`);
  return parsed;
}

function iso(value) {
  return new Date(timestamp('timestamp', value)).toISOString();
}

function errorWithCode(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Return the first complete UTC 4h boundary strictly after a timestamp. */
export function firstCompleteUtc4hBoundaryAfter(value) {
  const parsed = timestamp('preregistration committedAt', value);
  return new Date((Math.floor(parsed / FOUR_HOURS_MS) + 1) * FOUR_HOURS_MS).toISOString();
}

export function resolveHyExp0021Windows({
  preregistrationCommittedAt = HY_EXP_0021_PREREGISTRATION_COMMITTED_AT,
  proposedDevelopmentStart = HY_EXP_0021_PROPOSED_DEVELOPMENT_START
} = {}) {
  const captureStart = firstCompleteUtc4hBoundaryAfter(preregistrationCommittedAt);
  const proposedStartMs = timestamp('proposed development start', proposedDevelopmentStart);
  const captureStartMs = timestamp('capture start', captureStart);
  return Object.freeze({
    captureStart,
    developmentStart: new Date(Math.max(proposedStartMs, captureStartMs)).toISOString(),
    developmentEndExclusive: HY_EXP_0021_DEVELOPMENT_END_EXCLUSIVE,
    finalOosStart: HY_EXP_0021_FINAL_OOS_START,
    finalOosEndExclusive: HY_EXP_0021_FINAL_OOS_END_EXCLUSIVE,
    finalOosImmutable: true
  });
}

export const HY_EXP_0021_WINDOWS = resolveHyExp0021Windows();

function rootForMode(projectRoot, mode) {
  const normalized = String(mode ?? '').toUpperCase();
  if (normalized === 'DEVELOPMENT_CAPTURE') {
    return path.resolve(projectRoot, HY_EXP_0021_CAPTURE_ROOTS.development);
  }
  if (normalized === 'FINAL_OOS_CAPTURE') {
    return path.resolve(projectRoot, HY_EXP_0021_CAPTURE_ROOTS.finalOos);
  }
  throw new Error(`unsupported HY-EXP-0021 capture mode: ${mode}`);
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function expectedHyExp0021CaptureRoot({ projectRoot = process.cwd(), mode } = {}) {
  return rootForMode(projectRoot, mode);
}

/** Prevent 0020 raw paths or a caller-supplied cross-experiment directory. */
export function assertHyExp0021CaptureRoot({ projectRoot = process.cwd(), mode, outputRoot } = {}) {
  const expected = rootForMode(projectRoot, mode);
  const actual = path.resolve(projectRoot, outputRoot ?? expected);
  if (actual !== expected || actual.includes(`${path.sep}HY-EXP-0020`)) {
    throw errorWithCode(
      'HY_EXP_0021_NAMESPACE_MISMATCH',
      `HY-EXP-0021 capture output must be isolated to ${path.relative(projectRoot, expected).replaceAll('\\', '/')}`
    );
  }
  return expected;
}

export function assertHyExp0021InputIdentity({ experimentId, inputPath } = {}) {
  if (String(experimentId ?? '') !== HY_EXP_0021_ID) {
    throw errorWithCode('HY_EXP_0021_FOREIGN_INPUT', 'HY-EXP-0021 cannot consume a foreign experiment input');
  }
  const normalized = String(inputPath ?? '').replaceAll('\\', '/');
  if (!normalized.includes(HY_EXP_0021_ID) || normalized.includes('HY-EXP-0020')) {
    throw errorWithCode('HY_EXP_0021_FOREIGN_INPUT', 'HY-EXP-0021 input path is not experiment-isolated');
  }
  return true;
}

/** A prospective record needs both a causal source timestamp and local receipt time. */
export function validateHyExp0021ProspectiveRecord({
  sourceTimestamp,
  receivedAt,
  captureStart = HY_EXP_0021_CAPTURE_START
} = {}) {
  const sourceMs = timestamp('source timestamp', sourceTimestamp);
  const receiptMs = timestamp('receivedAt', receivedAt);
  const captureMs = timestamp('capture start', captureStart);
  if (sourceMs < captureMs || receiptMs < captureMs) {
    throw errorWithCode('PRE_CAPTURE_DATA', 'record precedes HY-EXP-0021 captureStart');
  }
  if (sourceMs > receiptMs) {
    throw errorWithCode('FUTURE_DATA', 'source timestamp is later than local receipt timestamp');
  }
  return {
    eligible: true,
    sourceTimestamp: new Date(sourceMs).toISOString(),
    receivedAt: new Date(receiptMs).toISOString(),
    captureStart: new Date(captureMs).toISOString(),
    futureData: false,
    proxy: false
  };
}

export function buildHyExp0021CaptureMetadata({
  mode,
  runId,
  startedAt = Date.now(),
  developmentAllowed = false,
  pnlComputed = false
} = {}) {
  const normalizedMode = String(mode ?? '').toUpperCase();
  if (!['DEVELOPMENT_CAPTURE', 'FINAL_OOS_CAPTURE'].includes(normalizedMode)) {
    throw new Error(`unsupported HY-EXP-0021 capture mode: ${mode}`);
  }
  if (developmentAllowed !== false || pnlComputed !== false) {
    throw errorWithCode('HY_EXP_0021_CAPTURE_SAFETY', 'capture stage cannot enable Development or PnL');
  }
  return {
    schemaVersion: 1,
    experimentId: HY_EXP_0021_ID,
    runId: String(runId),
    captureMode: normalizedMode,
    captureStart: HY_EXP_0021_CAPTURE_START,
    developmentWindow: {
      start: HY_EXP_0021_WINDOWS.developmentStart,
      endExclusive: HY_EXP_0021_WINDOWS.developmentEndExclusive
    },
    finalOosWindow: {
      start: HY_EXP_0021_WINDOWS.finalOosStart,
      endExclusive: HY_EXP_0021_WINDOWS.finalOosEndExclusive
    },
    authorization: 'PAPER_ONLY',
    liveOrdersEnabled: false,
    accountApiEnabled: false,
    orderApiEnabled: false,
    orderEndpoints: [...HY_EXP_0021_ORDER_ENDPOINTS],
    pnlComputed: false,
    developmentAllowed: false,
    finalOosEligible: false,
    futureDataUsed: false,
    proxyDepthUsed: false,
    sourceExperimentId: HY_EXP_0021_ID,
    startedAt: iso(startedAt)
  };
}

export function assertHyExp0021PaperOnly(config = {}) {
  const failures = [];
  if (config.authorization !== 'PAPER_ONLY') failures.push('authorization_not_paper_only');
  if (config.liveOrdersEnabled !== false) failures.push('live_orders_enabled');
  if (config.accountApiEnabled !== false) failures.push('account_api_enabled');
  if (config.orderApiEnabled !== false) failures.push('order_api_enabled');
  if (config.pnlComputed !== false) failures.push('pnl_computed_during_capture');
  if (Array.isArray(config.orderEndpoints) && config.orderEndpoints.length) failures.push('order_endpoint_present');
  if (failures.length) throw errorWithCode('HY_EXP_0021_CAPTURE_SAFETY', failures.join(','));
  return true;
}

export function assertHyExp0021FinalOosWindow({ start, endExclusive } = {}) {
  if (iso(start) !== new Date(HY_EXP_0021_FINAL_OOS_START).toISOString()
    || iso(endExclusive) !== new Date(HY_EXP_0021_FINAL_OOS_END_EXCLUSIVE).toISOString()) {
    throw errorWithCode('HY_EXP_0021_OOS_WINDOW_MUTATION', 'HY-EXP-0021 Final-OOS window is immutable');
  }
  return true;
}

/** Final-OOS raw capture is allowed before Development PASS; all analytical reads are locked. */
export function assertHyExp0021FinalOosOperation({ operation, developmentStatus = 'NOT_PASS', developmentAllowed = false } = {}) {
  const normalized = String(operation ?? '').toLowerCase();
  if (HY_EXP_0021_CAPTURE_OPERATIONS.includes(normalized)) {
    return { allowed: true, operation: normalized, mode: 'RAW_CAPTURE_ONLY' };
  }
  const developmentPassed = developmentStatus === 'PASS' && developmentAllowed === true;
  if (!developmentPassed && HY_EXP_0021_FINAL_OOS_READ_OPERATIONS.includes(normalized)) {
    throw errorWithCode('HY_EXP_0021_FINAL_OOS_LOCKED', `Final-OOS operation ${normalized} is locked until Development PASS`);
  }
  if (!developmentPassed) {
    throw errorWithCode('HY_EXP_0021_FINAL_OOS_LOCKED', `Final-OOS operation ${normalized} is locked until Development PASS`);
  }
  return { allowed: true, operation: normalized, mode: 'POST_DEVELOPMENT_READ' };
}

