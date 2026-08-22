import path from 'node:path';

export const HY_EXP_0023_ID = 'HY-EXP-0023';
export const HY_EXP_0023_PREREGISTRATION_COMMIT = 'a229ac1b88af32fa0f4026120f1e711a7d5721e1';
export const HY_EXP_0023_PREREGISTRATION_COMMITTED_AT = '2026-08-22T09:52:13.000Z';
export const HY_EXP_0023_PREREGISTRATION_SHA256 = '6fcd11c3c5767259b4c43e4a96ca733857f31d72f73e6f8eed0ff3e8eb61934';
export const HY_EXP_0023_CAPTURE_START = '2026-08-23T12:00:00.000Z';
export const HY_EXP_0023_EARLIEST_CANDIDATE_TIME = '2026-09-22T12:00:00.000Z';
export const HY_EXP_0023_DEVELOPMENT_END_EXCLUSIVE = '2027-03-01T00:00:00.000Z';
export const HY_EXP_0023_FINAL_OOS_START = '2027-03-01T00:00:00.000Z';
export const HY_EXP_0023_FINAL_OOS_END_EXCLUSIVE = '2027-09-01T00:00:00.000Z';
export const HY_EXP_0023_CAPTURE_MODES = Object.freeze({
  ENGINEERING_DRY_RUN: 'ENGINEERING_DRY_RUN',
  ARMED_PROSPECTIVE_CAPTURE: 'ARMED_PROSPECTIVE_CAPTURE',
  DEVELOPMENT_CAPTURE: 'DEVELOPMENT_CAPTURE'
});

export const HY_EXP_0023_ENGINEERING_ROOT = path.join(
  'data',
  'raw',
  'engineering-dry-run',
  HY_EXP_0023_ID
);
export const HY_EXP_0023_DEVELOPMENT_ROOT = path.join(
  'data',
  'raw',
  'prospective-development',
  HY_EXP_0023_ID
);
export const HY_EXP_0023_FINAL_OOS_ROOT = path.join(
  'data',
  'raw',
  'prospective-final-oos',
  HY_EXP_0023_ID
);

export const HY_EXP_0023_TRANSPORT_ENDPOINTS = Object.freeze({
  depth: 'wss://fstream.binance.com/public/stream',
  kline: 'wss://fstream.binance.com/market/stream',
  depthSnapshot: 'https://fapi.binance.com/fapi/v1/depth',
  klines: 'https://fapi.binance.com/fapi/v1/klines',
  exchangeInfo: 'https://fapi.binance.com/fapi/v1/exchangeInfo',
  funding: 'https://fapi.binance.com/fapi/v1/fundingRate',
  ticker: 'https://fapi.binance.com/fapi/v1/ticker/24hr',
  serverTime: 'https://fapi.binance.com/fapi/v1/time'
});

export const HY_EXP_0023_REQUIRED_CAPTURE_STREAMS = Object.freeze([
  'depth.diff',
  'depth.snapshot',
  'kline.4h',
  'exchangeInfo',
  'funding',
  'universe.snapshot',
  'universe.audit',
  'segment.audit'
]);

export const HY_EXP_0023_DIAGNOSTIC_STREAMS = Object.freeze(['ticker']);
export const HY_EXP_0023_ORDER_ENDPOINTS = Object.freeze([]);
export const HY_EXP_0023_ACCOUNT_ENDPOINTS = Object.freeze([]);

export const HY_EXP_0023_WINDOWS = Object.freeze({
  captureStart: HY_EXP_0023_CAPTURE_START,
  developmentStart: HY_EXP_0023_CAPTURE_START,
  developmentEndExclusive: HY_EXP_0023_DEVELOPMENT_END_EXCLUSIVE,
  finalOosStart: HY_EXP_0023_FINAL_OOS_START,
  finalOosEndExclusive: HY_EXP_0023_FINAL_OOS_END_EXCLUSIVE,
  finalOosImmutable: true
});

function timestamp(name, value) {
  const parsed = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
  if (!Number.isFinite(parsed)) throw new Error(`invalid ${name}`);
  return parsed;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function canonicalRoot({ projectRoot = process.cwd(), relativeRoot, outputRoot } = {}) {
  const expected = path.resolve(projectRoot, relativeRoot);
  const actual = path.resolve(projectRoot, outputRoot ?? expected);
  if (!isWithin(expected, actual)) {
    throw new Error(`HY-EXP-0023 path is outside canonical root: ${relativeRoot}`);
  }
  return actual;
}

/** Resolve the first UTC 4h boundary that is not earlier than commit + 24h. */
export function resolveHyExp0023CaptureStart({ committedAt = HY_EXP_0023_PREREGISTRATION_COMMITTED_AT } = {}) {
  const minimum = timestamp('preregistration commit timestamp', committedAt) + 24 * 60 * 60 * 1_000;
  const fourHours = 4 * 60 * 60 * 1_000;
  return new Date(Math.ceil(minimum / fourHours) * fourHours).toISOString();
}

export function assertHyExp0023FrozenResolution({
  resolution = {},
  preregistrationSha256 = HY_EXP_0023_PREREGISTRATION_SHA256
} = {}) {
  const expected = {
    preregCommit: HY_EXP_0023_PREREGISTRATION_COMMIT,
    preregCommitTimestamp: HY_EXP_0023_PREREGISTRATION_COMMITTED_AT,
    preregFileSha256: preregistrationSha256,
    captureStart: HY_EXP_0023_CAPTURE_START,
    earliestCandidateTime: HY_EXP_0023_EARLIEST_CANDIDATE_TIME,
    finalOosStart: HY_EXP_0023_FINAL_OOS_START,
    finalOosEndExclusive: HY_EXP_0023_FINAL_OOS_END_EXCLUSIVE
  };
  for (const [key, value] of Object.entries(expected)) {
    if (String(resolution[key] ?? '') !== value) throw new Error(`HY_EXP_0023 resolution mismatch: ${key}`);
  }
  if (resolution.preregAccepted !== true || resolution.officialCaptureAuthorized !== false) {
    throw new Error('HY_EXP_0023 resolution must be accepted but keep official capture locked');
  }
  return true;
}

export function expectedHyExp0023EngineeringRoot({ projectRoot = process.cwd() } = {}) {
  return path.resolve(projectRoot, HY_EXP_0023_ENGINEERING_ROOT);
}

export function assertHyExp0023EngineeringRoot({ projectRoot = process.cwd(), outputRoot } = {}) {
  const actual = canonicalRoot({ projectRoot, relativeRoot: HY_EXP_0023_ENGINEERING_ROOT, outputRoot });
  if (actual.includes(`${path.sep}prospective-development${path.sep}`)
    || actual.includes(`${path.sep}prospective-final-oos${path.sep}`)) {
    throw new Error('HY-EXP-0023 engineering root cannot be a prospective root');
  }
  return actual;
}

export function assertHyExp0023EngineeringNeverDevelopmentInput({ inputPath, projectRoot = process.cwd() } = {}) {
  const engineering = expectedHyExp0023EngineeringRoot({ projectRoot });
  if (isWithin(engineering, path.resolve(projectRoot, String(inputPath ?? '')))) {
    throw new Error('HY-EXP-0023 engineering data is never Development eligible');
  }
  return true;
}

/** Prospective modes require the separate frozen readiness/time/root gate. */
export function assertHyExp0023CaptureMode(mode = HY_EXP_0023_CAPTURE_MODES.ENGINEERING_DRY_RUN, { gateValidated = false } = {}) {
  const normalized = String(mode).toUpperCase();
  if (normalized === HY_EXP_0023_CAPTURE_MODES.ENGINEERING_DRY_RUN) return normalized;
  if (gateValidated && [
    HY_EXP_0023_CAPTURE_MODES.ARMED_PROSPECTIVE_CAPTURE,
    HY_EXP_0023_CAPTURE_MODES.DEVELOPMENT_CAPTURE
  ].includes(normalized)) return normalized;
  const error = new Error('HY-EXP-0023 prospective capture requires the frozen readiness gate');
  error.code = 'HY_EXP_0023_CAPTURE_GATE_REQUIRED';
  throw error;
}

export function buildHyExp0023SafetyMetadata({ runId, startedAt = Date.now() } = {}) {
  return {
    experimentId: HY_EXP_0023_ID,
    runId: String(runId),
    captureMode: 'ENGINEERING_DRY_RUN',
    authorization: 'PAPER_ONLY',
    liveOrdersEnabled: false,
    orderApiEnabled: false,
    accountApiEnabled: false,
    pnlComputed: false,
    developmentAllowed: false,
    officialCaptureAuthorized: false,
    finalOosRead: false,
    startedAt: new Date(timestamp('startedAt', startedAt)).toISOString(),
    engineeringRoot: HY_EXP_0023_ENGINEERING_ROOT,
    developmentRoot: HY_EXP_0023_DEVELOPMENT_ROOT,
    finalOosRoot: HY_EXP_0023_FINAL_OOS_ROOT
  };
}
