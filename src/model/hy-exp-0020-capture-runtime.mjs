import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalJson, sha256 } from './hy-exp-0020-historical-l2.mjs';

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

export function buildHyExp0020CaptureMetadata({ mode, runId, startedAt, symbols }) {
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
    symbols: normalizeSymbols(symbols)
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
  errors = []
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

export function buildDepthRecordEnvelope({ symbol, data, receivedAt, stream, segmentId, kind = 'diff' }) {
  const normalizedSymbol = symbolOf(symbol);
  const receipt = integer('receivedAt', receivedAt);
  if (!data || typeof data !== 'object') throw new Error('depth data is missing');
  return {
    kind,
    segmentId: String(segmentId),
    symbol: normalizedSymbol,
    stream: String(stream ?? `${normalizedSymbol.toLowerCase()}@depth@100ms`),
    receivedAt: receipt,
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
      state.lastReceivedAt = receipt;
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
  const response = await fetchImpl(url);
  if (response?.ok === false) throw new Error(`public request failed: ${response.status}`);
  return response.json();
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
    const receivedAt = Date.now();
    const payload = await fetchJson(fetchImpl, publicUrl(endpoint, { symbol, limit: DEFAULT_DEPTH_LEVELS }));
    const snapshotEnvelope = buildDepthRecordEnvelope({
      symbol,
      data: { s: symbol, lastUpdateId: payload.lastUpdateId, bids: payload.bids ?? payload.b, asks: payload.asks ?? payload.a },
      receivedAt,
      stream: `${symbol.toLowerCase()}@depthSnapshot`,
      segmentId,
      kind: 'snapshot'
    });
    snapshotWriter.append(snapshotEnvelope);
    state.ingestSnapshot({ data: snapshotEnvelope.data, receivedAt });
    snapshotReady = true;
    for (const envelope of buffered) state.ingestDiff({ data: envelope.data, receivedAt: envelope.receivedAt });
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
        const receivedAt = Date.now();
        const data = await fetchJson(fetchImpl, publicUrl(HY_EXP_0020_PUBLIC_ENDPOINTS.funding, { symbol, limit: 1 }));
        writer.append({ symbol, receivedAt, endpoint: HY_EXP_0020_PUBLIC_ENDPOINTS.funding, data });
      } catch (error) {
        errors.push(`funding:${symbol}:${error.message}`);
        writer.append({ symbol, receivedAt: Date.now(), error: error.message, endpoint: HY_EXP_0020_PUBLIC_ENDPOINTS.funding });
      }
    }
    if (Date.now() < deadline) await delay(Math.min(intervalMs, deadline - Date.now()));
  }
}

async function captureExchangeInfoAndUniverse({ symbols, fetchImpl, exchangeWriter, universeWriter }) {
  const receivedAt = Date.now();
  const exchangeInfo = await fetchJson(fetchImpl, HY_EXP_0020_PUBLIC_ENDPOINTS.exchangeInfo);
  exchangeWriter.append({ receivedAt, observedAt: receivedAt, endpoint: HY_EXP_0020_PUBLIC_ENDPOINTS.exchangeInfo, data: exchangeInfo });
  const ticker = await fetchJson(fetchImpl, publicUrl(HY_EXP_0020_PUBLIC_ENDPOINTS.ticker));
  universeWriter.append({
    receivedAt: Date.now(),
    observedAt: receivedAt,
    endpoint: HY_EXP_0020_PUBLIC_ENDPOINTS.ticker,
    requestedSymbols: symbols,
    exchangeInfo,
    ticker
  });
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

/**
 * Public-data-only Binance USD-M collector. It is intentionally not called by
 * tests or by the research runner; before 2026-09-01 it can only write the dry-run
 * namespace and all manifests remain ineligible for training/final OOS.
 */
export async function runHyExp0020Capture({
  projectRoot = process.cwd(),
  requestedMode = 'ENGINEERING_DRY_RUN',
  now = Date.now(),
  symbols,
  maxRuntimeMs = 5 * 60 * 1_000,
  fundingPollMs = 60_000,
  exchangeInfoPollMs = 4 * 60 * 60 * 1_000,
  reconnectBackoffMs = 1_000,
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket
} = {}) {
  const mode = resolveHyExp0020CaptureMode({ requestedMode, now });
  const frozenSymbols = normalizeSymbols(symbols);
  const root = assertHyExp0020CaptureRoot({ projectRoot, mode });
  const startedAt = Date.now();
  const runId = `${mode.toLowerCase()}-${new Date(startedAt).toISOString().replaceAll(/[-:.TZ]/g, '')}-${randomUUID().slice(0, 8)}`;
  const directory = path.join(root, runId);
  fs.mkdirSync(directory, { recursive: true });
  const metadata = buildHyExp0020CaptureMetadata({ mode, runId, startedAt, symbols: frozenSymbols });
  const depthWriter = openAppendOnlyNdjson(path.join(directory, 'depth.ndjson'));
  const snapshotWriter = openAppendOnlyNdjson(path.join(directory, 'depth-snapshots.ndjson'));
  const fundingWriter = openAppendOnlyNdjson(path.join(directory, 'funding.ndjson'));
  const exchangeWriter = openAppendOnlyNdjson(path.join(directory, 'exchange-info.ndjson'));
  const universeWriter = openAppendOnlyNdjson(path.join(directory, 'universe.ndjson'));
  const segmentWriter = openAppendOnlyNdjson(path.join(directory, 'segments.ndjson'));
  const writers = [depthWriter, snapshotWriter, fundingWriter, exchangeWriter, universeWriter, segmentWriter];
  const requestedDeadline = startedAt + integer('maxRuntimeMs', maxRuntimeMs, { minimum: 1 });
  const deadline = mode === 'FINAL_OOS' ? Math.min(requestedDeadline, FINAL_END_MS) : requestedDeadline;
  const segments = [];
  const errors = [];
  try {
    const fundingTask = pollFunding({ symbols: frozenSymbols, deadline, fetchImpl, writer: fundingWriter, intervalMs: fundingPollMs, errors });
    const metadataTask = pollExchangeInfoAndUniverse({
      symbols: frozenSymbols,
      deadline,
      fetchImpl,
      exchangeWriter,
      universeWriter,
      intervalMs: exchangeInfoPollMs,
      errors
    });
    const segmentTasks = frozenSymbols.map(async symbol => {
      let attempt = 0;
      while (Date.now() < deadline) {
        attempt++;
        const segment = await collectSymbolSegment({
          symbol,
          segmentId: `${runId}:${symbol}:${attempt}`,
          deadline,
          fetchImpl,
          WebSocketImpl,
          depthWriter,
          snapshotWriter,
          reconstructorOptions: {}
        });
        segments.push(segment);
        segmentWriter.append(segment);
        if (Date.now() >= deadline) break;
        await delay(Math.min(reconnectBackoffMs, deadline - Date.now()));
      }
    });
    await Promise.all([...segmentTasks, fundingTask, metadataTask]);
  } catch (error) {
    errors.push(error.message);
  } finally {
    for (const writer of writers) writer.close();
  }
  const filePaths = [
    'depth.ndjson', 'depth-snapshots.ndjson', 'funding.ndjson',
    'exchange-info.ndjson', 'universe.ndjson', 'segments.ndjson'
  ].map(file => path.join(directory, file));
  const files = filePaths.map(filePath => buildRawCaptureFileEntry({ root: directory, filePath }));
  const manifest = buildHyExp0020RawManifest({
    metadata,
    startedAt,
    finishedAt: Date.now(),
    files,
    segments,
    errors
  });
  const manifestWrite = writeImmutableCaptureManifest({ directory, manifest });
  return { directory, mode, runId, manifest, manifestWrite };
}
