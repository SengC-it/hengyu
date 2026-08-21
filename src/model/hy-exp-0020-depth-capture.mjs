import { createHash } from 'node:crypto';
import { validateCapturedRecords } from './forward-data.mjs';
import { buildLocalBookSnapshots } from './local-book.mjs';

export const HY_EXP_0020_CAPTURE_PLAN = Object.freeze({
  experimentId: 'HY-EXP-0020',
  authorization: 'PAPER_ONLY',
  websocketEndpoint: 'wss://fstream.binance.com/stream?streams=<symbol>@depth@100ms',
  snapshotEndpoint: 'https://fapi.binance.com/fapi/v1/depth?symbol=<symbol>&limit=1000',
  snapshotLimit: 1000,
  maxSegmentMs: 23 * 60 * 60 * 1_000,
  maxBookAgeMs: 1_000,
  requiredFields: Object.freeze(['E', 'T', 's', 'U', 'u', 'pu', 'b', 'a', 'receivedAt', 'stream'])
});

function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

function integer(name, value, minimum = 0) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`invalid ${name}`);
  return parsed;
}

function symbolOf(value) {
  const symbol = String(value ?? '').toUpperCase();
  if (!/^[A-Z0-9]+$/.test(symbol)) throw new Error('invalid symbol');
  return symbol;
}

function iso(name, value) {
  if (!value || !Number.isFinite(Date.parse(value))) throw new Error(`invalid ${name}`);
  return new Date(value).toISOString();
}

function captureFileEntry(file) {
  const path = String(file?.path ?? '').replaceAll('\\', '/');
  if (!path || path.startsWith('/') || path.includes('..')) throw new Error('capture file path is unsafe');
  const bytes = integer('capture file bytes', file.bytes);
  const hash = String(file.sha256 ?? '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('capture file sha256 is invalid');
  return { path, bytes, sha256: hash };
}

export function hashCaptureBytes(input) {
  return sha256(input);
}

export function buildCaptureFileEntry({ path, content }) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
  return { path, bytes: buffer.length, sha256: sha256(buffer) };
}

function validateCoverage(symbols, coverage) {
  const errors = [];
  for (const symbol of symbols) {
    const row = coverage?.[symbol];
    if (!row) {
      errors.push(`${symbol}:missing_coverage`);
      continue;
    }
    if (Number(row.depthSnapshots) < 1) errors.push(`${symbol}:missing_snapshot`);
    if (Number(row.depthUpdates) < 1) errors.push(`${symbol}:missing_depth_updates`);
    if (Number(row.sequenceGaps) !== 0) errors.push(`${symbol}:sequence_gap`);
    if (Number(row.missingIntervals) !== 0) errors.push(`${symbol}:missing_interval`);
    if (Number(row.maxDepthLevel) < HY_EXP_0020_CAPTURE_PLAN.snapshotLimit) {
      errors.push(`${symbol}:insufficient_depth_level`);
    }
  }
  return errors;
}

/** Build a hash-only manifest; raw files remain outside the JSON manifest. */
export function buildHyExp0020CaptureManifest({
  runId,
  windowStart,
  windowEndExclusive,
  symbols,
  startedAt,
  finishedAt,
  files,
  snapshots,
  coverage,
  errors = []
}) {
  const normalizedSymbols = [...new Set((symbols ?? []).map(symbolOf))].sort();
  if (!normalizedSymbols.length) throw new Error('capture symbols must not be empty');
  const normalizedFiles = (files ?? []).map(captureFileEntry);
  const normalizedErrors = [...errors.map(String), ...validateCoverage(normalizedSymbols, coverage)];
  const normalizedSnapshots = (snapshots ?? []).map(snapshot => ({
    symbol: symbolOf(snapshot.symbol),
    receivedAt: integer('snapshot receivedAt', snapshot.receivedAt),
    payload: snapshot.payload,
    endpoint: snapshot.endpoint ?? HY_EXP_0020_CAPTURE_PLAN.snapshotEndpoint
  }));
  return {
    schemaVersion: 1,
    experimentId: HY_EXP_0020_CAPTURE_PLAN.experimentId,
    capturePlan: 'HY-EXP-0020-L2-SNAPSHOT-DIFF-V1',
    authorization: HY_EXP_0020_CAPTURE_PLAN.authorization,
    status: normalizedErrors.length ? 'failed' : 'complete',
    runId: String(runId),
    windowStart: iso('windowStart', windowStart),
    windowEndExclusive: iso('windowEndExclusive', windowEndExclusive),
    startedAt: iso('startedAt', startedAt),
    finishedAt: iso('finishedAt', finishedAt),
    symbols: normalizedSymbols,
    depthSource: 'BINANCE_USDM_PUBLIC_L2',
    bookTickerIsNotDepth: true,
    ohlcvProxyAllowed: false,
    snapshotLimit: HY_EXP_0020_CAPTURE_PLAN.snapshotLimit,
    sequenceRule: 'first U <= snapshot.lastUpdateId <= u; later pu === previous u',
    snapshots: normalizedSnapshots,
    coverage,
    errors: normalizedErrors,
    files: normalizedFiles
  };
}

/** Validate a raw capture before any feature, edge or PnL consumer can read it. */
export function validateHyExp0020Capture({ records, snapshots, symbols, coverage }) {
  const normalizedSymbols = [...new Set((symbols ?? []).map(symbolOf))].sort();
  const quality = validateCapturedRecords(records, {
    symbols: normalizedSymbols,
    snapshots,
    maxFutureSkewMs: 5_000
  });
  const coverageErrors = validateCoverage(normalizedSymbols, coverage);
  const errors = [
    ...(quality.status === 'valid' ? [] : ['captured_records_invalid']),
    ...coverageErrors
  ];
  let reconstructedRows = [];
  if (!errors.length) {
    try {
      reconstructedRows = buildLocalBookSnapshots({
        records,
        snapshots,
        symbols: normalizedSymbols,
        maxLevelsPerSide: HY_EXP_0020_CAPTURE_PLAN.snapshotLimit
      });
    } catch (error) {
      errors.push(`local_book_reconstruction:${error.message}`);
    }
  }
  return {
    status: errors.length ? 'DATA_FAIL' : 'VALID',
    errors,
    quality,
    reconstructedRows,
    paperOnly: true,
    liveOrdersEnabled: false,
    pnlEligible: false
  };
}
