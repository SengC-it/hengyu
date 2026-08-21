import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256 } from './hy-exp-0020-historical-l2.mjs';
import { buildUniverseSnapshot, DEFAULT_UNIVERSE_POLICY } from './universe.mjs';

export const HY_EXP_0020_FINAL_OOS_WINDOW = Object.freeze({
  start: '2026-09-01T00:00:00.000Z',
  endExclusive: '2027-03-01T00:00:00.000Z'
});

export const HY_EXP_0020_CAPTURE_ROOTS = Object.freeze({
  engineeringDryRun: path.join('data', 'raw', 'engineering-dry-run', 'HY-EXP-0020'),
  finalOos: path.join('data', 'raw', 'final-oos', 'HY-EXP-0020')
});

export const HY_EXP_0020_PUBLIC_ENDPOINTS = Object.freeze({
  depthSnapshot: 'https://fapi.binance.com/fapi/v1/depth',
  funding: 'https://fapi.binance.com/fapi/v1/fundingRate',
  exchangeInfo: 'https://fapi.binance.com/fapi/v1/exchangeInfo',
  ticker: 'https://fapi.binance.com/fapi/v1/ticker/24hr',
  websocket: 'wss://fstream.binance.com/ws/<symbol>@depth@100ms'
});

const FINAL_START_MS = Date.parse(HY_EXP_0020_FINAL_OOS_WINDOW.start);
const FINAL_END_MS = Date.parse(HY_EXP_0020_FINAL_OOS_WINDOW.endExclusive);
const DEFAULT_DEPTH_LEVELS = 1000;
const DEFAULT_MAX_EVENT_GAP_MS = 1_000;
const FOUR_HOURS_MS = 4 * 60 * 60 * 1_000;
const MAX_COMBINED_SEGMENT_MS = 3 * 60 * 60 * 1_000 + 55 * 60 * 1_000;
const DEPTH_SNAPSHOT_MIN_INTERVAL_MS = 500;
const MAX_BUFFERED_EVENTS_PER_SYMBOL = 10_000;
const MAX_BUFFERED_EVENTS_TOTAL = 100_000;
const MAX_SNAPSHOT_ATTEMPTS = 5;
const MAX_SNAPSHOT_ACQUISITION_MS = 10_000;

function finite(name, value, { minimum = -Infinity, exclusiveMinimum = false } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (exclusiveMinimum ? parsed <= minimum : parsed < minimum)) {
    throw new Error(`invalid ${name}`);
  }
  return parsed;
}

function integer(name, value, { minimum = 0 } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`invalid ${name}`);
  return parsed;
}

function symbolOf(value) {
  const symbol = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]*$/.test(symbol)) throw new Error('invalid capture symbol');
  return symbol;
}

function captureSymbolOrNull(value) {
  const symbol = String(value ?? '').trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9_-]*$/.test(symbol) ? symbol : null;
}

function universeSymbolOrNull(value) {
  const symbol = String(value ?? '').trim().toUpperCase();
  return /^[A-Z0-9]+$/.test(symbol) ? symbol : null;
}

function normalizeSymbols(symbols) {
  const normalized = [...new Set((symbols ?? []).map(symbolOf))].sort();
  if (!normalized.length) throw new Error('capture symbols must not be empty');
  return normalized;
}

function iso(value) {
  const parsed = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
  if (!Number.isFinite(parsed)) throw new Error('invalid capture timestamp');
  return new Date(parsed).toISOString();
}

function safePath(value) {
  const normalized = String(value ?? '').replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || path.posix.normalize(normalized).startsWith('../') || normalized.includes('/../')) {
    throw new Error('capture path is unsafe');
  }
  return normalized;
}

function levels(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} is missing`);
  return value.map((row, index) => {
    if (!Array.isArray(row) || row.length < 2) throw new Error(`invalid ${label}[${index}]`);
    return [
      finite(`${label}[${index}] price`, row[0], { minimum: 0, exclusiveMinimum: true }),
      finite(`${label}[${index}] quantity`, row[1], { minimum: 0 })
    ];
  });
}

function validateNotCrossed(bids, asks, label) {
  const liveBids = bids.filter(([, quantity]) => quantity > 0);
  const liveAsks = asks.filter(([, quantity]) => quantity > 0);
  if (!liveBids.length || !liveAsks.length) throw new Error(`${label}:empty_book`);
  const bestBid = Math.max(...liveBids.map(([price]) => price));
  const bestAsk = Math.min(...liveAsks.map(([price]) => price));
  if (bestBid >= bestAsk) throw new Error(`${label}:crossed_book`);
}

function applyLevels(book, updates) {
  for (const [price, quantity] of updates) {
    if (quantity === 0) book.delete(price);
    else book.set(price, quantity);
  }
}

function ordered(book, side) {
  return [...book.entries()].sort((left, right) => side === 'bid' ? right[0] - left[0] : left[0] - right[0]);
}

export function resolveHyExp0020CaptureMode({ requestedMode = 'ENGINEERING_DRY_RUN', now = Date.now() } = {}) {
  const mode = String(requestedMode).toUpperCase();
  const current = finite('capture now', now, { minimum: 0 });
  if (!['ENGINEERING_DRY_RUN', 'FINAL_OOS'].includes(mode)) throw new Error(`unsupported capture mode: ${mode}`);
  if (mode === 'FINAL_OOS' && current < FINAL_START_MS) {
    throw new Error('HY-EXP-0020 final OOS capture is locked until 2026-09-01T00:00:00.000Z');
  }
  if (mode === 'FINAL_OOS' && current >= FINAL_END_MS) {
    throw new Error('HY-EXP-0020 final OOS window is closed');
  }
  return current < FINAL_START_MS ? 'ENGINEERING_DRY_RUN' : mode;
}

export function expectedHyExp0020CaptureRoot({ projectRoot = process.cwd(), mode } = {}) {
  const normalizedMode = String(mode ?? '').toUpperCase();
  if (normalizedMode === 'ENGINEERING_DRY_RUN') return path.resolve(projectRoot, HY_EXP_0020_CAPTURE_ROOTS.engineeringDryRun);
  if (normalizedMode === 'FINAL_OOS') return path.resolve(projectRoot, HY_EXP_0020_CAPTURE_ROOTS.finalOos);
  throw new Error(`unsupported capture mode: ${mode}`);
}

export function assertHyExp0020CaptureRoot({ projectRoot = process.cwd(), mode, outputRoot } = {}) {
  const expected = expectedHyExp0020CaptureRoot({ projectRoot, mode });
  const actual = path.resolve(projectRoot, outputRoot ?? expected);
  if (actual !== expected) {
    throw new Error(`capture output root is isolated to ${path.relative(projectRoot, expected).replaceAll('\\', '/')}`);
  }
  return expected;
}

export function buildHyExp0020CaptureMetadata({ mode, runId, startedAt, symbols = [] }) {
  const normalizedMode = String(mode).toUpperCase();
  if (!['ENGINEERING_DRY_RUN', 'FINAL_OOS'].includes(normalizedMode)) throw new Error('invalid capture metadata mode');
  return {
    schemaVersion: 1,
    experimentId: 'HY-EXP-0020',
    runId: String(runId),
    captureMode: normalizedMode,
    dataClass: normalizedMode === 'ENGINEERING_DRY_RUN' ? 'ENGINEERING_DRY_RUN' : 'FINAL_OOS_RAW',
    authorization: 'PAPER_ONLY',
    apiTradingEnabled: false,
    orderApiEnabled: false,
    pnlComputed: false,
    trainingEligible: false,
    finalOosEligible: false,
    finalOosWindow: HY_EXP_0020_FINAL_OOS_WINDOW,
    startedAt: iso(startedAt),
    symbols: symbols.length ? normalizeSymbols(symbols) : []
  };
}

/** Append-only writer: it never truncates or rewrites a raw NDJSON file. */
export function openAppendOnlyNdjson(filePath) {
  const absolute = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const handle = fs.openSync(absolute, fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY, 0o600);
  let closed = false;
  return {
    filePath: absolute,
    append(record) {
      if (closed) throw new Error('append-only writer is closed');
      const line = `${JSON.stringify(record)}\n`;
      fs.writeSync(handle, line, null, 'utf8');
      fs.fsyncSync(handle);
    },
    close() {
      if (closed) return;
      fs.fsyncSync(handle);
      fs.closeSync(handle);
      closed = true;
    }
  };
}

export function buildRawCaptureFileEntry({ root, filePath }) {
  const absolute = path.resolve(filePath);
  const relative = path.relative(path.resolve(root), absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('raw capture file escapes run directory');
  const bytes = fs.readFileSync(absolute);
  return {
    path: safePath(relative),
    bytes: bytes.length,
    sha256: sha256(bytes)
  };
}

export function buildHyExp0020RawManifest({
  metadata,
  startedAt,
  finishedAt,
  files,
  segments,
  errors = [],
  diagnostics = null
}) {
  const invalidSegments = (segments ?? []).filter(segment => segment.status !== 'VALID');
  const normalizedErrors = [...errors.map(String), ...invalidSegments.map(segment => `invalid_segment:${segment.segmentId}`)];
  const body = {
    ...metadata,
    schemaVersion: 1,
    manifestType: 'HY-EXP-0020-MARKET-DATA-CAPTURE',
    immutable: true,
    status: normalizedErrors.length ? 'DATA_FAIL' : 'complete',
    startedAt: iso(startedAt),
    finishedAt: iso(finishedAt),
    files: (files ?? []).map(entry => ({
      path: safePath(entry.path),
      bytes: integer('capture file bytes', entry.bytes),
      sha256: String(entry.sha256).toLowerCase()
    })),
    segments: segments ?? [],
    diagnostics: diagnostics ?? {},
    invalidSegmentCount: invalidSegments.length,
    errors: normalizedErrors,
    finalOosEligible: metadata.captureMode === 'FINAL_OOS' && normalizedErrors.length === 0
  };
  return { ...body, manifestSha256: sha256(canonicalJson(body)) };
}

export function writeImmutableCaptureManifest({ directory, manifest }) {
  const absoluteDirectory = path.resolve(directory);
  fs.mkdirSync(absoluteDirectory, { recursive: true });
  const manifestPath = path.join(absoluteDirectory, 'manifest.json');
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const handle = fs.openSync(manifestPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeSync(handle, bytes);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  const hashPath = path.join(absoluteDirectory, 'manifest.sha256');
  const hashHandle = fs.openSync(hashPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeSync(hashHandle, `${sha256(bytes)}\n`);
    fs.fsyncSync(hashHandle);
  } finally {
    fs.closeSync(hashHandle);
  }
  return { manifestPath, manifestSha256: sha256(bytes) };
}

export function buildDepthRecordEnvelope({
  symbol,
  data,
  receivedAt,
  requestStartedAt = null,
  exchangeObservedAt = null,
  serverTime = null,
  snapshotAttempt = null,
  stream,
  segmentId,
  kind = 'diff'
}) {
  const normalizedSymbol = symbolOf(symbol);
  const receipt = integer('receivedAt', receivedAt);
  if (!data || typeof data !== 'object') throw new Error('depth data is missing');
  return {
    kind,
    segmentId: String(segmentId),
    symbol: normalizedSymbol,
    stream: String(stream ?? `${normalizedSymbol.toLowerCase()}@depth@100ms`),
    requestStartedAt,
    receivedAt: receipt,
    exchangeObservedAt,
    serverTime,
    ...(snapshotAttempt == null ? {} : { snapshotAttempt }),
    data
  };
}

function payloadFromMessage(message) {
  if (message?.data && typeof message.data === 'object' && (message.data.e || message.data.U != null)) return message.data;
  return message;
}

export function createDepthSegmentReconstructor({
  symbol,
  requiredDepthLevels = DEFAULT_DEPTH_LEVELS,
  maxEventGapMs = DEFAULT_MAX_EVENT_GAP_MS,
  maxFutureSkewMs = 5_000
} = {}) {
  const normalizedSymbol = symbolOf(symbol);
  const state = {
    symbol: normalizedSymbol,
    snapshotId: null,
    lastUpdateId: null,
    aligned: false,
    lastReceivedAt: null,
    seen: new Set(),
    bids: new Map(),
    asks: new Map(),
    updates: 0,
    maxDepthLevel: 0
  };
  function fail(reason) {
    const error = new Error(`${normalizedSymbol}:${reason}`);
    error.code = reason;
    throw error;
  }
  return {
    get summary() {
      return {
        symbol: normalizedSymbol,
        updates: state.updates,
        maxDepthLevel: state.maxDepthLevel,
        lastUpdateId: state.lastUpdateId
      };
    },
    ingestSnapshot({ data, receivedAt }) {
      const payload = payloadFromMessage(data);
      const receipt = integer('snapshot receivedAt', receivedAt);
      if (String(payload.s ?? normalizedSymbol).toUpperCase() !== normalizedSymbol) fail('snapshot_symbol_mismatch');
      const lastUpdateId = integer('snapshot lastUpdateId', payload.lastUpdateId);
      const bids = levels(payload.bids ?? payload.b, `${normalizedSymbol} snapshot bids`);
      const asks = levels(payload.asks ?? payload.a, `${normalizedSymbol} snapshot asks`);
      if (bids.length < requiredDepthLevels || asks.length < requiredDepthLevels) fail('insufficient_depth_levels');
      try {
        validateNotCrossed(bids, asks, normalizedSymbol);
      } catch (error) {
        fail(error.message.split(':').at(-1));
      }
      state.snapshotId = lastUpdateId;
      state.lastUpdateId = lastUpdateId;
      state.aligned = false;
      // The REST response completes after buffered WebSocket messages may have
      // arrived. Do not compare those message receipts against snapshot receipt;
      // the first diff establishes the causal receipt baseline.
      state.lastReceivedAt = null;
      state.seen.clear();
      state.bids = new Map(bids.filter(([, quantity]) => quantity > 0));
      state.asks = new Map(asks.filter(([, quantity]) => quantity > 0));
      state.maxDepthLevel = Math.max(bids.length, asks.length);
      return this.summary;
    },
    ingestDiff({ data, receivedAt }) {
      const payload = payloadFromMessage(data);
      const receipt = integer('depth receivedAt', receivedAt);
      if (String(payload.s ?? normalizedSymbol).toUpperCase() !== normalizedSymbol) fail('depth_symbol_mismatch');
      const eventTime = integer('depth E', payload.E);
      const transactionTime = integer('depth T', payload.T);
      if (eventTime > receipt + maxFutureSkewMs || transactionTime > receipt + maxFutureSkewMs) fail('event_after_receipt');
      const U = integer('depth U', payload.U);
      const u = integer('depth u', payload.u);
      const pu = payload.pu == null ? null : integer('depth pu', payload.pu);
      if (U > u) fail('invalid_sequence_range');
      const bids = levels(payload.b ?? payload.bids, `${normalizedSymbol} depth bids`);
      const asks = levels(payload.a ?? payload.asks, `${normalizedSymbol} depth asks`);
      if (state.lastReceivedAt != null) {
        if (receipt < state.lastReceivedAt) fail('out_of_order_receipt');
        if (receipt - state.lastReceivedAt > maxEventGapMs) fail('missing_interval');
      }
      if (state.seen.has(u)) fail('duplicate_update');
      state.seen.add(u);
      if (state.snapshotId == null) fail('snapshot_missing');
      if (!state.aligned) {
        if (!(U <= state.snapshotId && u >= state.snapshotId)) fail('snapshot_alignment');
        state.aligned = true;
      } else {
        if (u <= state.lastUpdateId) fail('out_of_order_update');
        if (pu == null || pu !== state.lastUpdateId) fail('sequence_gap');
      }
      applyLevels(state.bids, bids);
      applyLevels(state.asks, asks);
      try {
        validateNotCrossed(ordered(state.bids, 'bid'), ordered(state.asks, 'ask'), normalizedSymbol);
      } catch (error) {
        fail(error.message.split(':').at(-1));
      }
      state.lastUpdateId = u;
      state.lastReceivedAt = receipt;
      state.updates++;
      state.maxDepthLevel = Math.max(state.maxDepthLevel, state.bids.size, state.asks.size);
      return { ...this.summary, eventTime, transactionTime, receivedAt: receipt };
    }
  };
}

async function fetchJson(fetchImpl, url) {
  if (typeof fetchImpl !== 'function') throw new Error('global fetch is unavailable');
  const requestStartedAt = Date.now();
  const response = await fetchImpl(url);
  if (response?.ok === false) throw new Error(`public request failed: ${response.status}`);
  const data = await response.json();
  const receivedAt = Date.now();
  const serverTime = data?.serverTime != null && Number.isFinite(Number(data.serverTime))
    ? Number(data.serverTime)
    : null;
  return { data, requestStartedAt, receivedAt, serverTime };
}

function publicUrl(endpoint, params = {}) {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(params)) if (value != null) url.searchParams.set(key, String(value));
  return url.toString();
}

function attachSocketListener(socket, name, handler) {
  if (typeof socket.addEventListener === 'function') socket.addEventListener(name, handler);
  else socket[`on${name}`] = handler;
}

async function openDepthSocket({ WebSocketImpl, url, onMessage, onError, onClose }) {
  if (typeof WebSocketImpl !== 'function') throw new Error('WebSocket implementation is unavailable');
  return new Promise((resolve, reject) => {
    let opened = false;
    const socket = new WebSocketImpl(url);
    attachSocketListener(socket, 'open', () => {
      opened = true;
      resolve(socket);
    });
    attachSocketListener(socket, 'message', event => {
      try {
        const value = typeof event?.data === 'string' ? JSON.parse(event.data) : (event?.data ?? event);
        onMessage(value);
      } catch (error) {
        onError(error);
      }
    });
    attachSocketListener(socket, 'error', error => {
      if (!opened) reject(new Error('depth WebSocket connection failed'));
      onError(error instanceof Error ? error : new Error('depth WebSocket error'));
    });
    attachSocketListener(socket, 'close', () => onClose());
  });
}

function closeSocket(socket) {
  try {
    if (socket && typeof socket.close === 'function') socket.close();
  } catch {
    // Closing an already failed public socket is best effort.
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function collectCombinedDepthSegment({
  symbols,
  segmentId,
  boundaryAt,
  segmentDeadline,
  fetchImpl,
  WebSocketImpl,
  depthWriter,
  snapshotWriter,
  onUniverseSnapshot
}) {
  const candidateSymbols = normalizeSymbols(symbols);
  const buffers = new Map(candidateSymbols.map(symbol => [symbol, []]));
  const contexts = new Map(candidateSymbols.map(symbol => [symbol, {
    symbol,
    buffer: buffers.get(symbol),
    state: null,
    snapshotId: null,
    snapshotRequestStartedAt: null,
    snapshotReceivedAt: null,
    snapshotAttempts: 0,
    snapshotTooOldRetries: 0,
    alignmentSuccesses: 0,
    alignmentFailureCount: 0,
    acquisitionStartedAt: null,
    waiters: [],
    status: 'WAITING_SNAPSHOT',
    aligned: false,
    staleBufferedDropped: 0,
    alignmentLatencyMs: null,
    alignmentFailure: null
  }]));
  const depthSnapshots = [];
  const snapshotErrors = [];
  let nextSnapshotRequestAt = Date.now();
  let bufferedEventsCurrent = 0;
  let bufferedEventsPeak = 0;
  let staleBufferedDropped = 0;
  let bufferedEventsDiscarded = 0;
  let socket;
  let failure = null;
  let terminalResult = null;
  let settled = false;
  let resolveOutcome;
  const outcome = new Promise(resolve => { resolveOutcome = resolve; });
  const notifyContext = (context, reason = 'event') => {
    const waiters = context.waiters.splice(0);
    for (const resolve of waiters) resolve(reason);
  };
  const finish = result => {
    if (settled) return;
    settled = true;
    terminalResult = result;
    if (result.status !== 'VALID') failure = result.reason;
    closeSocket(socket);
    for (const context of contexts.values()) notifyContext(context, 'settled');
    resolveOutcome(result);
  };
  const markAlignmentFailure = (context, reason) => {
    if (!context) return;
    if (!context.alignmentFailure) {
      context.status = 'FAILED';
      context.alignmentFailure = String(reason);
      context.alignmentFailureCount++;
    }
  };
  const failSegment = (reason, context = null) => {
    const message = String(reason ?? 'invalid_segment');
    if (context && message.includes('snapshot_alignment')) markAlignmentFailure(context, message);
    failure = failure ?? message;
    finish({ status: 'INVALID', reason: failure });
  };
  const sequenceBounds = (context, envelope) => {
    const U = Number(envelope?.data?.U);
    const u = Number(envelope?.data?.u);
    if (!Number.isSafeInteger(U) || !Number.isSafeInteger(u) || U > u) {
      throw new Error(`${context.symbol}:invalid_sequence_range`);
    }
    return { U, u };
  };
  const takeBuffered = context => {
    const envelope = context.buffer.shift();
    if (envelope) bufferedEventsCurrent--;
    return envelope;
  };
  const discardUnreconstructableBuffer = context => {
    bufferedEventsDiscarded += context.buffer.length;
    bufferedEventsCurrent -= context.buffer.length;
    context.buffer.length = 0;
  };
  const enqueueBuffered = (context, envelope) => {
    context.buffer.push(envelope);
    bufferedEventsCurrent++;
    bufferedEventsPeak = Math.max(bufferedEventsPeak, bufferedEventsCurrent);
    if (context.buffer.length > MAX_BUFFERED_EVENTS_PER_SYMBOL || bufferedEventsCurrent > MAX_BUFFERED_EVENTS_TOTAL) {
      failSegment(`${context.symbol}:buffer_limit_exceeded`, context);
    }
  };
  const waitForContextEvent = (context, timeoutMs) => new Promise(resolve => {
    let settledWait = false;
    let timer;
    const wake = reason => {
      if (settledWait) return;
      settledWait = true;
      clearTimeout(timer);
      const index = context.waiters.indexOf(wake);
      if (index >= 0) context.waiters.splice(index, 1);
      resolve(reason);
    };
    context.waiters.push(wake);
    timer = setTimeout(() => wake('timeout'), Math.max(1, timeoutMs));
  });
  const processBuffered = context => {
    if (settled || context.status === 'EXCLUDED' || context.status === 'FAILED' || !context.state) return 'WAITING';
    if (!context.aligned) {
      while (context.buffer.length && !settled && !context.aligned) {
        const head = context.buffer[0];
        const { U, u } = sequenceBounds(context, head);
        if (u < context.snapshotId) {
          takeBuffered(context);
          context.staleBufferedDropped++;
          staleBufferedDropped++;
          continue;
        }
        if (U > context.snapshotId) {
          return 'SNAPSHOT_TOO_OLD';
        }
        const first = takeBuffered(context);
        context.state.ingestDiff({ data: first.data, receivedAt: first.receivedAt });
        context.aligned = true;
        context.status = 'ALIGNED';
        context.alignmentSuccesses++;
        context.alignmentLatencyMs = Math.max(0, Date.now() - context.snapshotRequestStartedAt);
      }
    }
    while (context.aligned && context.buffer.length && !settled) {
      const next = takeBuffered(context);
      context.state.ingestDiff({ data: next.data, receivedAt: next.receivedAt });
    }
    return context.aligned ? 'ALIGNED' : 'WAITING';
  };
  const onMessage = message => {
    let context = null;
    try {
      const { symbol, stream, payload } = combinedMessage(message);
      if (!candidateSymbols.includes(symbol)) throw new Error(`${symbol}:universe_stream_mismatch`);
      context = contexts.get(symbol);
      const receivedAt = Date.now();
      const envelope = buildDepthRecordEnvelope({
        symbol,
        data: payload,
        receivedAt,
        stream,
        segmentId,
        kind: 'diff'
      });
      depthWriter.append(envelope);
      if (settled || context.status === 'EXCLUDED') return;
      if (!context.state || !context.aligned) {
        enqueueBuffered(context, envelope);
        processBuffered(context);
        notifyContext(context);
        return;
      }
      context.state.ingestDiff({ data: payload, receivedAt });
    } catch (error) {
      failSegment(error.message, context);
    }
  };
  const onError = error => failSegment(error?.message ?? 'websocket_error');
  const onClose = () => {
    if (settled) return;
    if (Date.now() >= segmentDeadline) {
      const unaligned = [...contexts.values()].filter(context => context.status !== 'EXCLUDED' && !context.aligned);
      for (const context of unaligned) markAlignmentFailure(context, `${context.symbol}:snapshot_alignment`);
      const missing = [...contexts.values()].filter(context => context.status !== 'EXCLUDED' && context.aligned && (context.state?.summary.updates ?? 0) < 1);
      const validSymbolCount = [...contexts.values()].filter(context => context.status !== 'EXCLUDED').length;
      finish({
        status: validSymbolCount > 0 && !unaligned.length && !missing.length ? 'VALID' : 'INVALID',
        reason: unaligned.length
          ? `snapshot_alignment:${unaligned.map(context => context.symbol).sort().join(',')}`
          : (validSymbolCount === 0
            ? 'no_valid_depth_snapshots'
            : (missing.length ? `no_depth_updates:${missing.map(context => context.symbol).sort().join(',')}` : 'utc_4h_rotation'))
      });
    } else {
      failSegment('connection_closed');
    }
  };
  const processSnapshot = async symbol => {
    const context = contexts.get(symbol);
    context.acquisitionStartedAt = Date.now();
    let latestSnapshotRow = null;
    const acquisitionDeadline = () => Math.min(
      segmentDeadline,
      context.acquisitionStartedAt + MAX_SNAPSHOT_ACQUISITION_MS
    );
    const failAlignment = () => {
      markAlignmentFailure(context, `${context.symbol}:snapshot_alignment`);
      failSegment(`${context.symbol}:snapshot_alignment`, context);
      return latestSnapshotRow ?? { symbol, valid: false };
    };
    const scheduleSnapshotRetry = () => {
      if (context.snapshotAttempts >= MAX_SNAPSHOT_ATTEMPTS || Date.now() >= acquisitionDeadline()) return false;
      context.snapshotTooOldRetries++;
      return true;
    };
    while (!settled && !context.aligned && context.status !== 'EXCLUDED' && context.status !== 'FAILED') {
      if (context.snapshotAttempts >= MAX_SNAPSHOT_ATTEMPTS || Date.now() >= acquisitionDeadline()) return failAlignment();
      const slot = Math.max(Date.now(), nextSnapshotRequestAt);
      nextSnapshotRequestAt = slot + DEPTH_SNAPSHOT_MIN_INTERVAL_MS;
      if (slot > Date.now()) {
        await delay(Math.min(slot - Date.now(), Math.max(1, acquisitionDeadline() - Date.now())));
      }
      if (settled || Date.now() >= acquisitionDeadline()) return failAlignment();
      const snapshotAttempt = ++context.snapshotAttempts;
      let response;
      try {
        response = await fetchJson(fetchImpl, publicUrl(HY_EXP_0020_PUBLIC_ENDPOINTS.depthSnapshot, {
          symbol,
          limit: DEFAULT_DEPTH_LEVELS
        }));
      } catch (error) {
        context.status = 'EXCLUDED';
        discardUnreconstructableBuffer(context);
        snapshotErrors.push({ symbol, reason: error.message, code: 'snapshot_request_failed', snapshotAttempt });
        notifyContext(context, 'snapshot_request_failed');
        return { symbol, valid: false };
      }
      try {
        const envelope = buildDepthRecordEnvelope({
          symbol,
          data: { s: symbol, lastUpdateId: response.data.lastUpdateId, bids: response.data.bids ?? response.data.b, asks: response.data.asks ?? response.data.a },
          requestStartedAt: response.requestStartedAt,
          receivedAt: response.receivedAt,
          snapshotAttempt,
          stream: `${symbol.toLowerCase()}@depthSnapshot`,
          segmentId,
          kind: 'snapshot'
        });
        snapshotWriter.append(envelope);
        const state = createDepthSegmentReconstructor({ symbol });
        try {
          state.ingestSnapshot({ data: envelope.data, receivedAt: response.receivedAt });
        } catch (error) {
          if (error.code !== 'insufficient_depth_levels') throw error;
          context.status = 'EXCLUDED';
          discardUnreconstructableBuffer(context);
          snapshotErrors.push({ symbol, reason: error.message, code: error.code, snapshotAttempt });
          notifyContext(context, 'snapshot_excluded');
          return { symbol, valid: false };
        }
        const snapshotRow = {
          symbol,
          payload: envelope.data,
          requestStartedAt: response.requestStartedAt,
          receivedAt: response.receivedAt,
          exchangeObservedAt: response.serverTime,
          snapshotAttempt,
          valid: true
        };
        latestSnapshotRow = snapshotRow;
        context.state = state;
        context.snapshotId = envelope.data.lastUpdateId;
        context.snapshotRequestStartedAt = response.requestStartedAt;
        context.snapshotReceivedAt = response.receivedAt;
        context.status = 'ALIGNING';
        let alignment;
        try {
          alignment = processBuffered(context);
        } catch (error) {
          failSegment(error.message, context);
          return snapshotRow;
        }
        notifyContext(context, alignment);
        if (alignment === 'ALIGNED') return snapshotRow;
        if (alignment === 'SNAPSHOT_TOO_OLD') {
          if (!scheduleSnapshotRetry()) return failAlignment();
          continue;
        }
        while (!settled && !context.aligned) {
          const waitMs = Math.max(1, acquisitionDeadline() - Date.now());
          const wakeReason = await waitForContextEvent(context, waitMs);
          if (settled) return latestSnapshotRow;
          if (wakeReason === 'timeout' || Date.now() >= acquisitionDeadline()) return failAlignment();
          let nextAlignment;
          try {
            nextAlignment = processBuffered(context);
          } catch (error) {
            failSegment(error.message, context);
            return latestSnapshotRow;
          }
          if (nextAlignment === 'ALIGNED') return latestSnapshotRow;
          if (nextAlignment === 'SNAPSHOT_TOO_OLD') {
            if (!scheduleSnapshotRetry()) return failAlignment();
            break;
          }
        }
        if (context.aligned) return latestSnapshotRow;
      } catch (error) {
        snapshotErrors.push({ symbol, reason: error.message, code: error.code ?? 'snapshot_failure', snapshotAttempt });
        failSegment(error.message, context);
        return latestSnapshotRow ?? { symbol, valid: false };
      }
    }
    return latestSnapshotRow ?? { symbol, valid: false };
  };
  const buildResult = universeSnapshot => {
    const perSymbol = Object.fromEntries([...contexts.values()].map(context => [context.symbol, {
      symbol: context.symbol,
      snapshotId: context.snapshotId,
      snapshotRequestStartedAt: context.snapshotRequestStartedAt,
      snapshotReceivedAt: context.snapshotReceivedAt,
      snapshotAttempts: context.snapshotAttempts,
      snapshotTooOldRetries: context.snapshotTooOldRetries,
      alignmentSuccesses: context.alignmentSuccesses,
      alignmentFailureCount: context.alignmentFailureCount,
      ...(context.state?.summary ?? { updates: 0, maxDepthLevel: 0, lastUpdateId: null }),
      status: context.status,
      aligned: context.aligned,
      bufferedEventsRemaining: context.buffer.length,
      staleBufferedDropped: context.staleBufferedDropped,
      alignmentLatencyMs: context.alignmentLatencyMs,
      alignmentFailure: context.alignmentFailure
    }]));
    const alignmentLatencyMs = Object.fromEntries([...contexts.values()]
      .filter(context => context.alignmentLatencyMs != null)
      .map(context => [context.symbol, context.alignmentLatencyMs]));
    const alignmentFailures = Object.fromEntries([...contexts.values()]
      .filter(context => context.alignmentFailure)
      .map(context => [context.symbol, context.alignmentFailure]));
    const snapshotAttempts = [...contexts.values()].reduce((total, context) => total + context.snapshotAttempts, 0);
    const snapshotTooOldRetries = [...contexts.values()].reduce((total, context) => total + context.snapshotTooOldRetries, 0);
    const alignmentSuccesses = [...contexts.values()].reduce((total, context) => total + context.alignmentSuccesses, 0);
    const alignmentFailureCount = [...contexts.values()].reduce((total, context) => total + context.alignmentFailureCount, 0);
    const status = failure || terminalResult?.status === 'INVALID' ? 'INVALID' : 'VALID';
    return {
      segmentId,
      boundaryAt,
      segmentDeadline,
      symbols: candidateSymbols,
      status,
      reason: failure ?? terminalResult?.reason ?? 'utc_4h_rotation',
      universeSnapshot,
      snapshots: depthSnapshots.length,
      snapshotErrors: snapshotErrors.sort((left, right) => left.symbol.localeCompare(right.symbol)),
      staleBufferedDropped,
      bufferedEventsDiscarded,
      bufferedEventsPeak,
      snapshotAttempts,
      snapshotTooOldRetries,
      alignmentSuccesses,
      alignmentFailureCount,
      alignmentLatencyMs,
      alignmentFailures,
      perSymbol
    };
  };
  try {
    socket = await openDepthSocket({ WebSocketImpl, url: combinedDepthUrl(candidateSymbols), onMessage, onError, onClose });
    if (settled) throw new Error(failure ?? 'combined_socket_closed_before_snapshot');
    const snapshotRows = await Promise.all(candidateSymbols.map(processSnapshot));
    depthSnapshots.push(...snapshotRows.filter(row => row.valid !== false));
    let universeSnapshot = null;
    try {
      universeSnapshot = await onUniverseSnapshot({ depthSnapshots, snapshotErrors, boundaryAt, segmentId });
    } catch (error) {
      failSegment(error.message);
    }
    if (settled) {
      return buildResult(universeSnapshot);
    }
    const remaining = Math.max(1, segmentDeadline - Date.now());
    const timer = setTimeout(() => {
      const unaligned = [...contexts.values()].filter(context => context.status !== 'EXCLUDED' && !context.aligned);
      for (const context of unaligned) markAlignmentFailure(context, `${context.symbol}:snapshot_alignment`);
      const missing = [...contexts.values()].filter(context => context.status !== 'EXCLUDED' && context.aligned && (context.state?.summary.updates ?? 0) < 1);
      const validSymbolCount = [...contexts.values()].filter(context => context.status !== 'EXCLUDED').length;
      finish({
        status: validSymbolCount > 0 && !unaligned.length && !missing.length ? 'VALID' : 'INVALID',
        reason: unaligned.length
          ? `snapshot_alignment:${unaligned.map(context => context.symbol).sort().join(',')}`
          : (validSymbolCount === 0
            ? 'no_valid_depth_snapshots'
            : (missing.length ? `no_depth_updates:${missing.map(context => context.symbol).sort().join(',')}` : 'utc_4h_rotation'))
      });
    }, remaining);
    await outcome;
    clearTimeout(timer);
    return buildResult(universeSnapshot);
  } catch (error) {
    failure = failure ?? error.message;
    finish({ status: 'INVALID', reason: failure });
    await outcome;
    return buildResult(null);
  }
}

async function collectSymbolSegment({
  symbol,
  segmentId,
  deadline,
  fetchImpl,
  WebSocketImpl,
  depthWriter,
  snapshotWriter,
  reconstructorOptions,
  endpoint = HY_EXP_0020_PUBLIC_ENDPOINTS.depthSnapshot
}) {
  const state = createDepthSegmentReconstructor({ symbol, ...reconstructorOptions });
  const stream = `${symbol.toLowerCase()}@depth@100ms`;
  const url = `wss://fstream.binance.com/ws/${stream}`;
  let snapshotReady = false;
  let socket;
  let failure = null;
  let settled = false;
  let resolveOutcome;
  const buffered = [];
  const outcome = new Promise(resolve => { resolveOutcome = resolve; });
  const finish = result => {
    if (settled) return;
    settled = true;
    if (failure == null && result.status !== 'VALID') failure = result.reason;
    closeSocket(socket);
    resolveOutcome(result);
  };
  const onMessage = message => {
    const receivedAt = Date.now();
    const payload = payloadFromMessage(message);
    const envelope = buildDepthRecordEnvelope({ symbol, data: payload, receivedAt, stream, segmentId });
    depthWriter.append(envelope);
    if (!snapshotReady) {
      buffered.push(envelope);
      return;
    }
    try {
      state.ingestDiff({ data: payload, receivedAt });
    } catch (error) {
      failure = error.message;
      finish({ status: 'INVALID', reason: error.message });
    }
  };
  const onError = error => finish({ status: 'INVALID', reason: error?.message ?? 'websocket_error' });
  const onClose = () => {
    if (Date.now() >= deadline && !failure) finish({
      status: state.summary.updates > 0 ? 'VALID' : 'INVALID',
      reason: state.summary.updates > 0 ? 'deadline' : 'no_depth_updates'
    });
    else if (!failure) finish({ status: 'INVALID', reason: 'connection_closed' });
  };
  try {
    socket = await openDepthSocket({ WebSocketImpl, url, onMessage, onError, onClose });
    const response = await fetchJson(fetchImpl, publicUrl(endpoint, { symbol, limit: DEFAULT_DEPTH_LEVELS }));
    const { data: payload, requestStartedAt, receivedAt } = response;
    const snapshotEnvelope = buildDepthRecordEnvelope({
      symbol,
      data: { s: symbol, lastUpdateId: payload.lastUpdateId, bids: payload.bids ?? payload.b, asks: payload.asks ?? payload.a },
      receivedAt,
      requestStartedAt,
      stream: `${symbol.toLowerCase()}@depthSnapshot`,
      segmentId,
      kind: 'snapshot'
    });
    snapshotWriter.append(snapshotEnvelope);
    state.ingestSnapshot({ data: snapshotEnvelope.data, receivedAt });
    snapshotReady = true;
    for (const envelope of buffered) state.ingestDiff({ data: envelope.data, receivedAt: envelope.receivedAt });
    buffered.length = 0;
    const remaining = Math.max(1, deadline - Date.now());
    const timer = setTimeout(() => finish({
      status: failure ? 'INVALID' : (state.summary.updates > 0 ? 'VALID' : 'INVALID'),
      reason: failure ?? (state.summary.updates > 0 ? 'deadline' : 'no_depth_updates')
    }), remaining);
    await outcome;
    clearTimeout(timer);
  } catch (error) {
    failure = error.message;
    finish({ status: 'INVALID', reason: error.message });
    await outcome;
  }
  return {
    segmentId,
    symbol,
    status: failure ? 'INVALID' : 'VALID',
    reason: failure ?? 'deadline',
    ...state.summary
  };
}

async function pollFunding({ symbols, deadline, fetchImpl, writer, intervalMs, errors }) {
  while (Date.now() < deadline) {
    for (const symbol of symbols) {
      if (Date.now() >= deadline) break;
      try {
        const response = await fetchJson(fetchImpl, publicUrl(HY_EXP_0020_PUBLIC_ENDPOINTS.funding, { symbol, limit: 1 }));
        writer.append({
          symbol,
          requestStartedAt: response.requestStartedAt,
          receivedAt: response.receivedAt,
          endpoint: HY_EXP_0020_PUBLIC_ENDPOINTS.funding,
          data: response.data
        });
      } catch (error) {
        errors.push(`funding:${symbol}:${error.message}`);
        writer.append({ symbol, receivedAt: Date.now(), error: error.message, endpoint: HY_EXP_0020_PUBLIC_ENDPOINTS.funding });
      }
    }
    if (Date.now() < deadline) await delay(Math.min(intervalMs, deadline - Date.now()));
  }
}

async function captureExchangeInfoAndUniverse({ symbols, fetchImpl, exchangeWriter, universeWriter }) {
  const exchangeResponse = await fetchJson(fetchImpl, HY_EXP_0020_PUBLIC_ENDPOINTS.exchangeInfo);
  const tickerResponse = await fetchJson(fetchImpl, publicUrl(HY_EXP_0020_PUBLIC_ENDPOINTS.ticker));
  const exchangeInfo = exchangeResponse.data;
  const ticker = tickerResponse.data;
  const observedAt = Math.max(exchangeResponse.receivedAt, tickerResponse.receivedAt);
  exchangeWriter.append({
    requestStartedAt: exchangeResponse.requestStartedAt,
    receivedAt: exchangeResponse.receivedAt,
    exchangeObservedAt: exchangeResponse.serverTime,
    serverTime: exchangeResponse.serverTime,
    observedAt,
    endpoint: HY_EXP_0020_PUBLIC_ENDPOINTS.exchangeInfo,
    data: exchangeInfo
  });
  universeWriter.append({
    requestStartedAt: tickerResponse.requestStartedAt,
    receivedAt: tickerResponse.receivedAt,
    observedAt,
    endpoint: HY_EXP_0020_PUBLIC_ENDPOINTS.ticker,
    requestedSymbols: symbols,
    exchangeInfo,
    ticker,
    exchangeInfoRequestStartedAt: exchangeResponse.requestStartedAt,
    exchangeInfoReceivedAt: exchangeResponse.receivedAt,
    tickerRequestStartedAt: tickerResponse.requestStartedAt,
    tickerReceivedAt: tickerResponse.receivedAt,
    exchangeObservedAt: exchangeResponse.serverTime,
    serverTime: exchangeResponse.serverTime
  });
}

function loadUniversePolicy(projectRoot) {
  const policyFile = path.resolve(projectRoot, 'config', 'universe-policy.json');
  const raw = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
  return {
    ...DEFAULT_UNIVERSE_POLICY,
    minListingAgeMs: Number(raw.minListingAgeDays) * 86_400_000,
    allowedQuoteAssets: [...(raw.allowedQuoteAssets ?? DEFAULT_UNIVERSE_POLICY.allowedQuoteAssets)],
    minTierAQuoteVolumeUsdt: Number(raw.minTierAQuoteVolumeUsdt),
    minTierBQuoteVolumeUsdt: Number(raw.minTierBQuoteVolumeUsdt),
    minTierADepthUsdt: Number(raw.minTierADepthUsdt),
    minTierBDepthUsdt: Number(raw.minTierBDepthUsdt),
    depthBps: Number(raw.depthBps),
    maxDepthAgeMs: Number(raw.maxDepthAgeMs),
    maxSymbols: Number(raw.maxSymbols),
    excludedBaseAssets: [...(raw.excludedBaseAssets ?? DEFAULT_UNIVERSE_POLICY.excludedBaseAssets)]
  };
}

function floorUtcFourHourBoundary(value) {
  const timestamp = integer('boundary timestamp', value, { minimum: 0 });
  return Math.floor(timestamp / FOUR_HOURS_MS) * FOUR_HOURS_MS;
}

function nextUtcFourHourBoundary(value) {
  return floorUtcFourHourBoundary(value) + FOUR_HOURS_MS;
}

function excludedCaptureBaseAsset(baseAsset, policy) {
  const base = String(baseAsset ?? '').toUpperCase();
  const excluded = new Set((policy.excludedBaseAssets ?? []).map(value => String(value).toUpperCase()));
  return excluded.has(base) || /(?:UP|DOWN|BULL|BEAR|[123]L|[123]S)$/.test(base);
}

/** Select a bounded candidate set from only the exchangeInfo/ticker PIT inputs. */
export function selectHyExp0020CaptureCandidates({ exchangeInfo, tickers, observedAt, policy }) {
  const at = integer('universe observedAt', observedAt, { minimum: 0 });
  const effectivePolicy = policy ?? DEFAULT_UNIVERSE_POLICY;
  const tickerBySymbol = new Map();
  for (const row of tickers ?? []) {
    const symbol = captureSymbolOrNull(row?.symbol ?? row?.s);
    if (symbol) tickerBySymbol.set(symbol, row);
  }
  const rows = [];
  const excluded = [];
  for (const row of exchangeInfo ?? []) {
    const symbol = captureSymbolOrNull(row?.symbol);
    if (!symbol) {
      excluded.push({
        symbol: String(row?.symbol ?? '').trim().toUpperCase() || 'UNKNOWN',
        reasons: ['invalid_symbol']
      });
      continue;
    }
    const baseAsset = String(row.baseAsset ?? '').toUpperCase();
    const quoteAsset = String(row.quoteAsset ?? row.marginAsset ?? '').toUpperCase();
    const status = String(row.status ?? '').toUpperCase();
    const contractType = String(row.contractType ?? '').toUpperCase();
    const onboardDate = Number(row.onboardDate);
    const ticker = tickerBySymbol.get(symbol);
    const volume = Number(ticker?.quoteVolume ?? ticker?.q);
    const reasons = [];
    if (contractType !== 'PERPETUAL') reasons.push('not_perpetual');
    if (!effectivePolicy.allowedQuoteAssets.map(value => String(value).toUpperCase()).includes(quoteAsset)) reasons.push('unsupported_quote_asset');
    if (status !== 'TRADING') reasons.push('not_trading');
    if (excludedCaptureBaseAsset(baseAsset, effectivePolicy)) reasons.push('excluded_base_asset');
    if (!Number.isFinite(onboardDate)) reasons.push('missing_listing_date');
    else if (onboardDate > at - effectivePolicy.minListingAgeMs) reasons.push('listing_age_under_30d');
    if (!ticker) reasons.push('missing_ticker');
    else if (!Number.isFinite(volume) || volume < effectivePolicy.minTierBQuoteVolumeUsdt) reasons.push('volume_below_tier_b');
    const candidate = {
      symbol,
      baseAsset,
      quoteAsset,
      contractType,
      status,
      onboardDate: Number.isFinite(onboardDate) ? onboardDate : null,
      quoteVolumeUsdt: Number.isFinite(volume) ? volume : null,
      reasons
    };
    if (reasons.length) excluded.push(candidate);
    else rows.push(candidate);
  }
  rows.sort((left, right) => (right.quoteVolumeUsdt - left.quoteVolumeUsdt) || left.symbol.localeCompare(right.symbol));
  const selected = rows.slice(0, effectivePolicy.maxSymbols);
  const selectedSymbols = new Set(selected.map(row => row.symbol));
  for (const row of rows.slice(effectivePolicy.maxSymbols)) excluded.push({ ...row, reasons: ['universe_cap'] });
  return {
    observedAt: at,
    policy: effectivePolicy,
    symbols: selected.map(row => row.symbol).sort(),
    candidates: selected,
    excluded: excluded.sort((left, right) => left.symbol.localeCompare(right.symbol)),
    counts: {
      exchangeInfo: (exchangeInfo ?? []).length,
      ticker: (tickers ?? []).length,
      candidateBeforeCap: rows.length,
      candidateAfterCap: selected.length,
      excluded: excluded.length
    },
    pointInTime: true,
    futureDataUsed: false,
    capped: rows.length > selectedSymbols.size
  };
}

function combinedDepthUrl(symbols) {
  const streams = symbols.map(symbol => `${symbol.toLowerCase()}@depth@100ms`).join('/');
  return `wss://fstream.binance.com/stream?streams=${streams}`;
}

function combinedMessage(message) {
  const payload = payloadFromMessage(message);
  const stream = String(message?.stream ?? `${String(payload?.s ?? '').toLowerCase()}@depth@100ms`);
  const symbol = symbolOf(payload?.s ?? stream.split('@', 1)[0]);
  return { symbol, stream, payload };
}

export function membershipDiff(previousSymbols, nextSymbols) {
  const previous = new Set(previousSymbols ?? []);
  const next = new Set(nextSymbols ?? []);
  return {
    added: [...next].filter(symbol => !previous.has(symbol)).sort(),
    removed: [...previous].filter(symbol => !next.has(symbol)).sort(),
    unchanged: [...next].filter(symbol => previous.has(symbol)).sort()
  };
}

async function captureDynamicUniverseInputs({
  boundaryAt,
  fetchImpl,
  policy,
  exchangeWriter,
  tickerWriter
}) {
  const exchangeResponse = await fetchJson(fetchImpl, HY_EXP_0020_PUBLIC_ENDPOINTS.exchangeInfo);
  const tickerResponse = await fetchJson(fetchImpl, publicUrl(HY_EXP_0020_PUBLIC_ENDPOINTS.ticker));
  const observedAt = Math.max(exchangeResponse.receivedAt, tickerResponse.receivedAt);
  const exchangeInfo = exchangeResponse.data;
  const tickers = tickerResponse.data;
  if (!Array.isArray(exchangeInfo?.symbols)) throw new Error('exchangeInfo symbols are missing');
  if (!Array.isArray(tickers)) throw new Error('ticker response is not an array');
  const candidates = selectHyExp0020CaptureCandidates({
    exchangeInfo: exchangeInfo.symbols,
    tickers,
    observedAt,
    policy
  });
  exchangeWriter.append({
    type: 'exchangeInfo',
    boundaryAt,
    requestStartedAt: exchangeResponse.requestStartedAt,
    receivedAt: exchangeResponse.receivedAt,
    exchangeObservedAt: exchangeResponse.serverTime,
    serverTime: exchangeResponse.serverTime,
    observedAt,
    endpoint: HY_EXP_0020_PUBLIC_ENDPOINTS.exchangeInfo,
    data: exchangeInfo
  });
  tickerWriter.append({
    type: 'ticker',
    boundaryAt,
    requestStartedAt: tickerResponse.requestStartedAt,
    receivedAt: tickerResponse.receivedAt,
    observedAt,
    endpoint: HY_EXP_0020_PUBLIC_ENDPOINTS.ticker,
    data: tickers
  });
  return {
    boundaryAt,
    observedAt,
    exchangeInfo,
    tickers,
    candidates,
    timing: {
      exchangeInfoRequestStartedAt: exchangeResponse.requestStartedAt,
      exchangeInfoReceivedAt: exchangeResponse.receivedAt,
      exchangeObservedAt: exchangeResponse.serverTime,
      tickerRequestStartedAt: tickerResponse.requestStartedAt,
      tickerReceivedAt: tickerResponse.receivedAt
    }
  };
}

function buildPITUniverseSnapshot({ inputs, depthSnapshots, snapshotErrors = [], policy }) {
  const depths = depthSnapshots.map(snapshot => ({
    symbol: snapshot.symbol,
    asOf: snapshot.receivedAt,
    bids: snapshot.payload.bids ?? snapshot.payload.b,
    asks: snapshot.payload.asks ?? snapshot.payload.a
  }));
  const observedAt = Math.max(inputs.observedAt, ...depthSnapshots.map(snapshot => snapshot.receivedAt));
  const snapshot = buildUniverseSnapshot({
    // Preserve every raw exchangeInfo/ticker response on disk, but only pass
    // syntactically valid symbols to the typed PIT universe builder. Binance
    // can publish non-trading metadata rows that are not capture stream IDs;
    // one such row must not abort the complete candidate snapshot.
    exchangeInfo: inputs.exchangeInfo.symbols.filter(row => universeSymbolOrNull(row?.symbol)),
    tickers: inputs.tickers
      .filter(row => universeSymbolOrNull(row?.symbol ?? row?.s))
      .map(row => ({ ...row, asOf: inputs.observedAt })),
    depths,
    observedAt,
    policy
  });
  return {
    ...snapshot,
    captureCandidateSymbols: inputs.candidates.symbols,
    captureCandidateCount: inputs.candidates.symbols.length,
    exchangeInfoObservedAt: inputs.observedAt,
    exchangeObservedAt: inputs.timing.exchangeObservedAt,
    exchangeInfoRequestStartedAt: inputs.timing.exchangeInfoRequestStartedAt,
    exchangeInfoReceivedAt: inputs.timing.exchangeInfoReceivedAt,
    tickerRequestStartedAt: inputs.timing.tickerRequestStartedAt,
    tickerReceivedAt: inputs.timing.tickerReceivedAt,
    depthSnapshotReceivedAt: Object.fromEntries(depthSnapshots.map(row => [row.symbol, row.receivedAt])),
    depthSnapshotErrors: snapshotErrors
      .map(error => ({ symbol: error.symbol, reason: error.reason, code: error.code }))
      .sort((left, right) => left.symbol.localeCompare(right.symbol)),
    pointInTime: true,
    futureDataUsed: false
  };
}

async function pollExchangeInfoAndUniverse({
  symbols,
  deadline,
  fetchImpl,
  exchangeWriter,
  universeWriter,
  intervalMs,
  errors
}) {
  while (Date.now() < deadline) {
    try {
      await captureExchangeInfoAndUniverse({ symbols, fetchImpl, exchangeWriter, universeWriter });
    } catch (error) {
      errors.push(`exchangeInfo_universe:${error.message}`);
      exchangeWriter.append({ receivedAt: Date.now(), error: error.message, endpoint: HY_EXP_0020_PUBLIC_ENDPOINTS.exchangeInfo });
      universeWriter.append({ receivedAt: Date.now(), error: error.message, endpoint: HY_EXP_0020_PUBLIC_ENDPOINTS.ticker });
    }
    if (Date.now() < deadline) await delay(Math.min(intervalMs, deadline - Date.now()));
  }
}

async function pollDynamicFunding({ getSymbols, deadline, fetchImpl, writer, intervalMs, errors }) {
  while (Date.now() < deadline) {
    const symbols = getSymbols();
    if (!symbols.length) {
      if (Date.now() < deadline) await delay(Math.min(100, deadline - Date.now()));
      continue;
    }
    for (const symbol of symbols) {
      if (Date.now() >= deadline) break;
      try {
        const response = await fetchJson(fetchImpl, publicUrl(HY_EXP_0020_PUBLIC_ENDPOINTS.funding, { symbol, limit: 1 }));
        writer.append({
          type: 'funding',
          symbol,
          requestStartedAt: response.requestStartedAt,
          receivedAt: response.receivedAt,
          endpoint: HY_EXP_0020_PUBLIC_ENDPOINTS.funding,
          data: response.data
        });
      } catch (error) {
        errors.push(`funding:${symbol}:${error.message}`);
        writer.append({ type: 'funding_error', symbol, receivedAt: Date.now(), endpoint: HY_EXP_0020_PUBLIC_ENDPOINTS.funding, error: error.message });
      }
    }
    if (Date.now() < deadline) await delay(Math.min(intervalMs, deadline - Date.now()));
  }
}

function captureQualityDiagnostics({ segments, exchangeInfoSnapshots, universeSnapshots }) {
  const symbols = new Set();
  for (const segment of segments) {
    for (const symbol of segment.symbols ?? []) symbols.add(symbol);
    for (const symbol of Object.keys(segment.perSymbol ?? {})) symbols.add(symbol);
  }
  const reasons = segments.map(segment => String(segment.reason ?? ''));
  const snapshotErrors = segments.flatMap(segment => segment.snapshotErrors ?? []);
  const alignmentLatencyMs = {};
  for (const segment of segments) {
    for (const [symbol, latency] of Object.entries(segment.alignmentLatencyMs ?? {})) {
      alignmentLatencyMs[symbol] = Math.max(alignmentLatencyMs[symbol] ?? 0, Number(latency));
    }
  }
  const countReason = (...needles) => reasons.filter(reason => needles.some(needle => reason.includes(needle))).length;
  return {
    symbolsCaptured: [...symbols].sort(),
    validSegments: segments.filter(segment => segment.status === 'VALID').length,
    invalidSegments: segments.filter(segment => segment.status !== 'VALID').length,
    sequenceGaps: countReason('sequence_gap'),
    snapshotAlignmentFailures: countReason('snapshot_alignment'),
    duplicateOrOutOfOrder: countReason('duplicate_update', 'out_of_order'),
    crossedBooks: countReason('crossed_book'),
    snapshotExclusions: snapshotErrors.length,
    snapshotRequestFailures: snapshotErrors.filter(error => error.code === 'snapshot_request_failed').length,
    insufficientDepthSymbols: snapshotErrors.filter(error => error.code === 'insufficient_depth_levels').length,
    staleBufferedDropped: segments.reduce((total, segment) => total + Number(segment.staleBufferedDropped ?? 0), 0),
    bufferedEventsDiscarded: segments.reduce((total, segment) => total + Number(segment.bufferedEventsDiscarded ?? 0), 0),
    bufferedEventsPeak: Math.max(0, ...segments.map(segment => Number(segment.bufferedEventsPeak ?? 0))),
    snapshotAttempts: segments.reduce((total, segment) => total + Number(segment.snapshotAttempts ?? 0), 0),
    snapshotTooOldRetries: segments.reduce((total, segment) => total + Number(segment.snapshotTooOldRetries ?? 0), 0),
    alignmentSuccesses: segments.reduce((total, segment) => total + Number(segment.alignmentSuccesses ?? 0), 0),
    alignmentFailures: segments.reduce((total, segment) => total + Number(segment.alignmentFailureCount ?? 0), 0),
    bufferLimitFailures: countReason('buffer_limit_exceeded'),
    alignmentLatencyMs,
    exchangeInfoSnapshots,
    universeSnapshots
  };
}

/**
 * Public-data-only Binance USD-M collector. The final universe is always derived
 * from point-in-time exchangeInfo/ticker/depth inputs; a manually supplied symbol
 * list is never used to define FINAL_OOS membership. Before 2026-09-01 it can only
 * write the engineering dry-run namespace and all manifests remain ineligible.
 */
export async function runHyExp0020Capture({
  projectRoot = process.cwd(),
  requestedMode = 'ENGINEERING_DRY_RUN',
  now = Date.now(),
  maxRuntimeMs = 5 * 60 * 1_000,
  fundingPollMs = 60_000,
  reconnectBackoffMs = 1_000,
  universePolicy = null,
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket
} = {}) {
  const mode = resolveHyExp0020CaptureMode({ requestedMode, now });
  const root = assertHyExp0020CaptureRoot({ projectRoot, mode });
  const startedAt = Date.now();
  const runId = `${mode.toLowerCase()}-${new Date(startedAt).toISOString().replaceAll(/[-:.TZ]/g, '')}-${randomUUID().slice(0, 8)}`;
  const directory = path.join(root, runId);
  fs.mkdirSync(directory, { recursive: true });
  const policy = universePolicy ?? loadUniversePolicy(projectRoot);
  const metadata = buildHyExp0020CaptureMetadata({ mode, runId, startedAt });
  const depthWriter = openAppendOnlyNdjson(path.join(directory, 'depth.ndjson'));
  const snapshotWriter = openAppendOnlyNdjson(path.join(directory, 'depth-snapshots.ndjson'));
  const fundingWriter = openAppendOnlyNdjson(path.join(directory, 'funding.ndjson'));
  const exchangeWriter = openAppendOnlyNdjson(path.join(directory, 'exchange-info.ndjson'));
  const tickerWriter = openAppendOnlyNdjson(path.join(directory, 'ticker.ndjson'));
  const universeWriter = openAppendOnlyNdjson(path.join(directory, 'universe.ndjson'));
  const universeAuditWriter = openAppendOnlyNdjson(path.join(directory, 'universe-audit.ndjson'));
  const segmentWriter = openAppendOnlyNdjson(path.join(directory, 'segments.ndjson'));
  const writers = [depthWriter, snapshotWriter, fundingWriter, exchangeWriter, tickerWriter, universeWriter, universeAuditWriter, segmentWriter];
  const requestedDeadline = startedAt + integer('maxRuntimeMs', maxRuntimeMs, { minimum: 1 });
  const deadline = mode === 'FINAL_OOS' ? Math.min(requestedDeadline, FINAL_END_MS) : requestedDeadline;
  const segments = [];
  const errors = [];
  let activeSymbols = [];
  let exchangeInfoSnapshots = 0;
  let universeSnapshots = 0;
  const getFundingSymbols = () => [...activeSymbols];
  let fundingTask;
  try {
    fundingTask = pollDynamicFunding({
      getSymbols: getFundingSymbols,
      deadline,
      fetchImpl,
      writer: fundingWriter,
      intervalMs: fundingPollMs,
      errors
    });
    while (Date.now() < deadline) {
      const boundaryAt = floorUtcFourHourBoundary(Date.now());
      const nextBoundary = nextUtcFourHourBoundary(boundaryAt);
      let inputs;
      try {
        inputs = await captureDynamicUniverseInputs({
          boundaryAt,
          fetchImpl,
          policy,
          exchangeWriter,
          tickerWriter
        });
        exchangeInfoSnapshots++;
      } catch (error) {
        errors.push(`universe_inputs:${error.message}`);
        universeAuditWriter.append({ type: 'universe_input_error', boundaryAt, receivedAt: Date.now(), error: error.message });
        if (Date.now() < deadline) await delay(Math.min(60_000, deadline - Date.now()));
        continue;
      }
      const membership = membershipDiff(activeSymbols, inputs.candidates.symbols);
      universeAuditWriter.append({
        type: 'universe_membership',
        boundaryAt,
        observedAt: inputs.observedAt,
        previousSymbols: activeSymbols,
        nextSymbols: inputs.candidates.symbols,
        ...membership,
        policy: inputs.candidates.policy,
        counts: inputs.candidates.counts
      });
      activeSymbols = inputs.candidates.symbols;
      if (!activeSymbols.length) {
        const emptySegment = {
          segmentId: `${runId}:boundary:${boundaryAt}:empty`,
          boundaryAt,
          segmentDeadline: Math.min(deadline, nextBoundary),
          symbols: [],
          status: 'INVALID',
          reason: 'empty_capture_candidate_set',
          snapshots: 0,
          perSymbol: {}
        };
        segments.push(emptySegment);
        segmentWriter.append(emptySegment);
        for (const symbol of membership.removed) {
          const ended = {
            segmentId: `${runId}:boundary:${boundaryAt}:removed:${symbol}`,
            boundaryAt,
            segmentDeadline: Date.now(),
            symbols: [symbol],
            status: 'VALID',
            reason: 'universe_removed_normal_end',
            snapshots: 0,
            perSymbol: {}
          };
          segments.push(ended);
          segmentWriter.append(ended);
        }
      } else {
        let attempt = 0;
        while (Date.now() < deadline && Date.now() < nextBoundary) {
          attempt++;
          const segmentDeadline = Math.min(deadline, nextBoundary, Date.now() + MAX_COMBINED_SEGMENT_MS);
          const segment = await collectCombinedDepthSegment({
            symbols: activeSymbols,
            segmentId: `${runId}:boundary:${boundaryAt}:attempt:${attempt}`,
            boundaryAt,
            segmentDeadline,
            fetchImpl,
            WebSocketImpl,
            depthWriter,
            snapshotWriter,
            onUniverseSnapshot: async ({ depthSnapshots, snapshotErrors, segmentId }) => {
              const snapshot = buildPITUniverseSnapshot({ inputs, depthSnapshots, snapshotErrors, policy });
              universeSnapshots++;
              universeWriter.append({
                type: 'universe_snapshot',
                boundaryAt,
                segmentId,
                observedAt: snapshot.observedAt,
                requestStartedAt: Math.min(
                  inputs.timing.exchangeInfoRequestStartedAt,
                  inputs.timing.tickerRequestStartedAt,
                  ...depthSnapshots.map(row => row.requestStartedAt)
                ),
                receivedAt: Math.max(
                  inputs.timing.exchangeInfoReceivedAt,
                  inputs.timing.tickerReceivedAt,
                  ...depthSnapshots.map(row => row.receivedAt)
                ),
                exchangeObservedAt: snapshot.exchangeObservedAt,
                depthSnapshotErrors: snapshot.depthSnapshotErrors,
                snapshot
              });
              return snapshot;
            }
          });
          segments.push(segment);
          segmentWriter.append(segment);
          if (Date.now() < nextBoundary && Date.now() < deadline) {
            const retryDelay = segment.status === 'VALID'
              ? reconnectBackoffMs
              : Math.min(60_000, reconnectBackoffMs * (2 ** Math.min(attempt - 1, 6)));
            await delay(Math.min(retryDelay, nextBoundary - Date.now(), deadline - Date.now()));
          }
        }
        for (const symbol of membership.removed) {
          const ended = {
            segmentId: `${runId}:boundary:${boundaryAt}:removed:${symbol}`,
            boundaryAt,
            segmentDeadline: Date.now(),
            symbols: [symbol],
            status: 'VALID',
            reason: 'universe_removed_normal_end',
            snapshots: 0,
            perSymbol: {}
          };
          segments.push(ended);
          segmentWriter.append(ended);
        }
      }
      if (Date.now() < deadline) await delay(Math.min(Math.max(1, nextBoundary - Date.now()), deadline - Date.now()));
    }
    await fundingTask;
  } catch (error) {
    errors.push(error.message);
  } finally {
    if (fundingTask) await fundingTask.catch(error => errors.push(`funding_task:${error.message}`));
    for (const writer of writers) writer.close();
  }
  const diagnostics = captureQualityDiagnostics({ segments, exchangeInfoSnapshots, universeSnapshots });
  const filePaths = [
    'depth.ndjson', 'depth-snapshots.ndjson', 'funding.ndjson',
    'exchange-info.ndjson', 'ticker.ndjson', 'universe.ndjson',
    'universe-audit.ndjson', 'segments.ndjson'
  ].map(file => path.join(directory, file));
  const files = filePaths.map(filePath => buildRawCaptureFileEntry({ root: directory, filePath }));
  const manifest = buildHyExp0020RawManifest({
    metadata,
    startedAt,
    finishedAt: Date.now(),
    files,
    segments,
    errors,
    diagnostics
  });
  const manifestWrite = writeImmutableCaptureManifest({ directory, manifest });
  return { directory, mode, runId, manifest, manifestWrite };
}
