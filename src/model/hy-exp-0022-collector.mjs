import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { createDepthSegmentReconstructor } from './hy-exp-0020-capture-runtime.mjs';
import {
  HY_EXP_0022_CAPTURE_START,
  HY_EXP_0022_DEVELOPMENT_END_EXCLUSIVE,
  HY_EXP_0022_FINAL_OOS_END_EXCLUSIVE,
  HY_EXP_0022_FINAL_OOS_START,
  HY_EXP_0022_ID,
  HY_EXP_0022_ORDER_ENDPOINTS,
  HY_EXP_0022_ACCOUNT_ENDPOINTS,
  HY_EXP_0022_WINDOWS,
  assertHyExp0022FinalOosOperation,
  normalizeHyExp0022ContractKline,
  reconcileHyExp0022BarSources
} from './hy-exp-0022-prospective.mjs';

export { HY_EXP_0022_ORDER_ENDPOINTS, HY_EXP_0022_ACCOUNT_ENDPOINTS };

export const HY_EXP_0022_TRANSPORT_ENDPOINTS = Object.freeze({
  depth: 'wss://fstream.binance.com/public/stream',
  kline: 'wss://fstream.binance.com/market/stream'
});

export const HY_EXP_0022_ENGINEERING_ROOT = path.join(
  'data',
  'raw',
  'engineering-dry-run',
  HY_EXP_0022_ID
);

export const HY_EXP_0022_REQUIRED_CAPTURE_STREAMS = Object.freeze([
  'depth.diff',
  'depth.snapshot',
  'kline.4h',
  'exchangeInfo',
  'funding',
  'universe.snapshot',
  'universe.audit',
  'segment.audit'
]);

export const HY_EXP_0022_DIAGNOSTIC_STREAMS = Object.freeze(['ticker']);

export const HY_EXP_0022_FIRST_PROSPECTIVE_BAR = Object.freeze({
  openTime: Date.parse('2026-08-22T04:00:00.000Z'),
  closeTime: Date.parse('2026-08-22T07:59:59.999Z'),
  source: 'CONTRACT_PRICE',
  interval: '4h'
});

const FOUR_HOURS_MS = 4 * 60 * 60 * 1_000;
const DAY_MS = 86_400_000;
const DEPTH_LEVELS = 1_000;
const MAX_BUFFERED_EVENTS_PER_SYMBOL = 10_000;
const MAX_BUFFERED_EVENTS_TOTAL = 100_000;
const MAX_SNAPSHOT_ATTEMPTS = 5;
const MAX_SNAPSHOT_ACQUISITION_MS = 10_000;
const SNAPSHOT_RETRY_DELAY_MS = 250;
const DEFAULT_SEGMENT_MAX_MS = 4 * 60 * 60 * 1_000 - 60_000;
const DEFAULT_CONFIRMATION_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_SYMBOLS = 3;
const MAX_ENGINEERING_SYMBOLS = 200;

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

function integer(name, value, minimum = 0) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`invalid ${name}`);
  return parsed;
}

function symbolOf(value) {
  const symbol = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]+$/.test(symbol)) throw new Error(`invalid symbol: ${value}`);
  return symbol;
}

function normalizeSymbols(symbols) {
  const result = [...new Set((symbols ?? []).map(symbolOf))].sort();
  if (!result.length) throw new Error('collector symbol set is empty');
  return result;
}

function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function safeRelative(value) {
  const normalized = String(value ?? '').replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('..')) {
    throw new Error('unsafe capture relative path');
  }
  return normalized;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function expectedHyExp0022EngineeringRoot({ projectRoot = process.cwd() } = {}) {
  return path.resolve(projectRoot, HY_EXP_0022_ENGINEERING_ROOT);
}

/** Engineering data is a distinct namespace and can never be a Development input root. */
export function assertHyExp0022EngineeringRoot({ projectRoot = process.cwd(), outputRoot } = {}) {
  const expected = expectedHyExp0022EngineeringRoot({ projectRoot });
  const actual = path.resolve(projectRoot, outputRoot ?? expected);
  if (!isWithin(expected, actual)) {
    throw errorWithCode('HY_EXP_0022_ENGINEERING_NAMESPACE_MISMATCH', 'engineering dry-run path is outside its canonical root');
  }
  if (actual.includes(`${path.sep}prospective-development${path.sep}`)
    || actual.includes(`${path.sep}prospective-final-oos${path.sep}`)) {
    throw errorWithCode('HY_EXP_0022_ENGINEERING_NAMESPACE_MISMATCH', 'engineering dry-run cannot use a prospective root');
  }
  return actual;
}

export function assertHyExp0022EngineeringNeverDevelopmentInput({ inputPath, projectRoot = process.cwd() } = {}) {
  const engineering = expectedHyExp0022EngineeringRoot({ projectRoot });
  const actual = path.resolve(projectRoot, String(inputPath ?? ''));
  if (isWithin(engineering, actual)) {
    throw errorWithCode('HY_EXP_0022_ENGINEERING_NOT_DEVELOPMENT', 'engineering dry-run data is never eligible as Development input');
  }
  return true;
}

export function resolveHyExp0022CollectorMode(mode = 'ENGINEERING_DRY_RUN') {
  const normalized = String(mode).toUpperCase();
  if (normalized !== 'ENGINEERING_DRY_RUN') {
    throw errorWithCode('HY_EXP_0022_PHASE_A_MODE_LOCK', 'Phase A collector permits ENGINEERING_DRY_RUN only');
  }
  return normalized;
}

export function transportPayload(message) {
  const outer = message?.data && typeof message.data === 'object' && !Array.isArray(message.data)
    ? message.data
    : message;
  if (outer?.data && typeof outer.data === 'object' && !Array.isArray(outer.data)) {
    return { outer, payload: outer.data, stream: outer.stream ?? null };
  }
  return { outer: outer ?? {}, payload: outer ?? {}, stream: outer?.stream ?? null };
}

/** Enforce the current USD-M transport status field without inventing one when absent. */
export function verifyBinanceTransportCapability({ kind, message } = {}) {
  const normalizedKind = String(kind ?? '').toLowerCase();
  if (!['depth', 'kline'].includes(normalizedKind)) throw new Error(`unsupported transport kind: ${kind}`);
  const { outer, payload, stream } = transportPayload(message);
  const st = payload?.st ?? outer?.st;
  const ps = payload?.ps ?? outer?.ps;
  if (st !== undefined && st !== null && Number(st) !== 1) {
    throw errorWithCode('BINANCE_TRANSPORT_STATUS_REJECTED', `${normalizedKind} message has unsupported st=${st}`);
  }
  return {
    accepted: true,
    kind: normalizedKind,
    endpoint: normalizedKind === 'depth' ? HY_EXP_0022_TRANSPORT_ENDPOINTS.depth : HY_EXP_0022_TRANSPORT_ENDPOINTS.kline,
    st: st == null ? null : Number(st),
    ps: ps == null ? null : String(ps),
    stream,
    payload
  };
}

export function buildBinanceSubscriptionMessage({ streams, id = 1 } = {}) {
  const normalized = [...new Set((streams ?? []).map(value => String(value).trim().toLowerCase()))].filter(Boolean);
  if (!normalized.length) throw new Error('subscription stream list is empty');
  return JSON.stringify({ method: 'SUBSCRIBE', params: normalized, id: integer('subscription id', id, 1) });
}

function addQuery(url, params) {
  const result = new URL(url);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== null) result.searchParams.set(key, String(value));
  }
  return result.toString();
}

export function buildDepthSnapshotUrl(symbol) {
  return addQuery('https://fapi.binance.com/fapi/v1/depth', { symbol: symbolOf(symbol), limit: DEPTH_LEVELS });
}

export function buildFundingUrl(symbol) {
  return addQuery('https://fapi.binance.com/fapi/v1/fundingRate', { symbol: symbolOf(symbol), limit: 1 });
}

export function buildJustClosedKlineUrl({ symbol, openTime, closeTime } = {}) {
  const open = integer('kline openTime', openTime);
  const close = integer('kline closeTime', closeTime);
  if (close !== open + FOUR_HOURS_MS - 1) throw new Error('just-closed kline boundary is invalid');
  return addQuery('https://fapi.binance.com/fapi/v1/klines', {
    symbol: symbolOf(symbol),
    interval: '4h',
    startTime: open,
    endTime: close,
    limit: 1
  });
}

/** Request timing is measured around the complete response body, never before await. */
export async function fetchJsonCompleted({ fetchImpl = globalThis.fetch, url, signal } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is unavailable');
  const requestStartedAt = Date.now();
  const response = await fetchImpl(url, { method: 'GET', signal });
  if (response?.ok === false) throw new Error(`public request failed: ${response.status}`);
  let data;
  if (typeof response?.text === 'function') {
    const body = await response.text();
    data = typeof body === 'string' ? JSON.parse(body) : body;
  } else if (typeof response?.json === 'function') {
    data = await response.json();
  } else {
    throw new Error('response body reader is unavailable');
  }
  const receivedAt = Date.now();
  const serverTime = data?.serverTime != null && Number.isFinite(Number(data.serverTime))
    ? Number(data.serverTime)
    : null;
  return {
    data,
    requestStartedAt,
    receivedAt,
    exchangeObservedAt: serverTime,
    bodyCompleted: true
  };
}

function withTimeout(promise, timeoutMs, code) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(errorWithCode(code, `operation timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function attach(socket, event, handler) {
  if (typeof socket.addEventListener === 'function') socket.addEventListener(event, handler);
  else socket[`on${event}`] = handler;
}

function closeSocket(socket) {
  try {
    if (socket && typeof socket.close === 'function') socket.close(1000, 'phase-a-rotation');
  } catch {
    // Closing a public market-data socket is best effort.
  }
}

/** Open one documented combined endpoint and subscribe without using legacy /stream. */
export async function openBinanceCombinedSocket({
  kind,
  streams,
  WebSocketImpl = globalThis.WebSocket,
  onMessage,
  onError,
  onClose,
  endpoint
} = {}) {
  const normalizedKind = String(kind ?? '').toLowerCase();
  if (!['depth', 'kline'].includes(normalizedKind)) throw new Error(`unsupported socket kind: ${kind}`);
  const expectedEndpoint = normalizedKind === 'depth'
    ? HY_EXP_0022_TRANSPORT_ENDPOINTS.depth
    : HY_EXP_0022_TRANSPORT_ENDPOINTS.kline;
  if (endpoint && endpoint !== expectedEndpoint) {
    throw errorWithCode('LEGACY_BINANCE_ENDPOINT_FORBIDDEN', 'only the documented Phase A Binance endpoint is allowed');
  }
  if (typeof WebSocketImpl !== 'function') throw new Error('WebSocket implementation is unavailable');
  const capability = {
    endpoint: expectedEndpoint,
    kind: normalizedKind,
    opened: false,
    subscriptionAck: false,
    dataMessages: 0,
    stValues: [],
    psValues: [],
    status: 'CONNECTING'
  };
  return new Promise((resolve, reject) => {
    let opened = false;
    let settled = false;
    const socket = new WebSocketImpl(expectedEndpoint);
    const fail = error => {
      const normalized = error instanceof Error ? error : new Error(String(error ?? 'socket error'));
      if (!opened && !settled) {
        settled = true;
        reject(normalized);
      }
      onError?.(normalized);
      if (opened) closeSocket(socket);
    };
    attach(socket, 'open', () => {
      opened = true;
      capability.opened = true;
      capability.status = 'OPEN';
      try {
        socket.send(buildBinanceSubscriptionMessage({ streams }));
        resolve({ socket, capability });
      } catch (error) {
        fail(error);
      }
    });
    attach(socket, 'message', event => {
      try {
        const raw = typeof event?.data === 'string' ? JSON.parse(event.data) : (event?.data ?? event);
        if (raw && raw.id != null && Object.prototype.hasOwnProperty.call(raw, 'result')) {
          if (raw.result !== null) throw errorWithCode('BINANCE_SUBSCRIPTION_REJECTED', JSON.stringify(raw));
          capability.subscriptionAck = true;
          return;
        }
        const verified = verifyBinanceTransportCapability({ kind: normalizedKind, message: raw });
        capability.dataMessages++;
        if (verified.st !== null && !capability.stValues.includes(verified.st)) capability.stValues.push(verified.st);
        if (verified.ps !== null && !capability.psValues.includes(verified.ps)) capability.psValues.push(verified.ps);
        Promise.resolve(onMessage?.({ raw, verified })).catch(fail);
      } catch (error) {
        fail(error);
      }
    });
    attach(socket, 'error', fail);
    attach(socket, 'close', event => {
      capability.status = 'CLOSED';
      if (!settled && !opened) {
        settled = true;
        reject(new Error('Binance WebSocket closed before open'));
      }
      onClose?.(event, capability);
    });
  });
}

/** Append-only raw writer used by every 0022 stream. */
export function openHyExp0022AppendOnlyNdjson(filePath) {
  const absolute = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const handle = fs.openSync(absolute, fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY, 0o600);
  let closed = false;
  return {
    filePath: absolute,
    append(record) {
      if (closed) throw new Error('append-only writer is closed');
      fs.writeSync(handle, `${JSON.stringify(record)}\n`, null, 'utf8');
    },
    close() {
      if (closed) return;
      fs.fsyncSync(handle);
      fs.closeSync(handle);
      closed = true;
    }
  };
}

export function hashCaptureFile(filePath) {
  const bytes = fs.readFileSync(filePath);
  return { bytes: bytes.length, sha256: sha256(bytes) };
}

export function buildCaptureFileEntry({ root, filePath } = {}) {
  const absoluteRoot = path.resolve(root);
  const absoluteFile = path.resolve(filePath);
  const relative = path.relative(absoluteRoot, absoluteFile);
  if (!isWithin(absoluteRoot, absoluteFile)) throw new Error('capture file escapes run root');
  const hash = hashCaptureFile(absoluteFile);
  return { path: safeRelative(relative), ...hash };
}

export function writeImmutableHyExp0022Manifest({ directory, manifest } = {}) {
  const absoluteDirectory = path.resolve(directory);
  fs.mkdirSync(absoluteDirectory, { recursive: true });
  const manifestPath = path.join(absoluteDirectory, 'manifest.json');
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestHandle = fs.openSync(manifestPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeSync(manifestHandle, bytes);
    fs.fsyncSync(manifestHandle);
  } finally {
    fs.closeSync(manifestHandle);
  }
  const manifestFileSha256 = sha256(bytes);
  const hashPath = path.join(absoluteDirectory, 'manifest.sha256');
  const hashHandle = fs.openSync(hashPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeSync(hashHandle, `${manifestFileSha256}\n`);
    fs.fsyncSync(hashHandle);
  } finally {
    fs.closeSync(hashHandle);
  }
  return { manifestPath, hashPath, manifestFileSha256 };
}

function rawTransportFields(verified) {
  return {
    ...(verified?.st == null ? {} : { st: verified.st }),
    ...(verified?.ps == null ? {} : { ps: verified.ps })
  };
}

function serverObservedAt(response) {
  return response.exchangeObservedAt == null ? null : response.exchangeObservedAt;
}

function decimalString(value, name) {
  const text = String(value ?? '').trim();
  const parsed = Number(text);
  if (!text || !Number.isFinite(parsed) || parsed <= 0) throw errorWithCode('INVALID_SCHEMA_FIELD', `${name} must be a positive number`);
  return text;
}

/** Validate realized funding instead of treating an HTTP 200 or empty array as success. */
export function validateHyExp0022FundingRow({ symbol, row, receivedAt } = {}) {
  const normalizedSymbol = symbolOf(symbol);
  const actualSymbol = String(row?.symbol ?? row?.s ?? '').trim().toUpperCase();
  if (actualSymbol !== normalizedSymbol) throw errorWithCode('FUNDING_SCHEMA_INVALID', `${normalizedSymbol}:funding symbol mismatch`);
  const fundingTime = integer('fundingTime', row?.fundingTime);
  const fundingRate = Number(row?.fundingRate);
  const receipt = integer('funding receivedAt', receivedAt);
  if (!Number.isFinite(fundingRate)) throw errorWithCode('FUNDING_SCHEMA_INVALID', `${normalizedSymbol}:fundingRate missing or invalid`);
  if (fundingTime > receipt) throw errorWithCode('FUNDING_FUTURE_TIMESTAMP', `${normalizedSymbol}:fundingTime is after receivedAt`);
  return {
    symbol: normalizedSymbol,
    fundingTime,
    fundingRate: String(row.fundingRate),
    receivedAt: receipt
  };
}

/** Validate current prospective exchangeInfo filters; no historical/current fallback is permitted. */
export function validateHyExp0022ExchangeInfoSymbol({ symbol, row } = {}) {
  const normalizedSymbol = symbolOf(symbol);
  const actualSymbol = String(row?.symbol ?? '').trim().toUpperCase();
  const failures = [];
  if (actualSymbol !== normalizedSymbol) failures.push('symbol');
  if (String(row?.status ?? '').toUpperCase() !== 'TRADING') failures.push('status');
  if (String(row?.contractType ?? '').toUpperCase() !== 'PERPETUAL') failures.push('contractType');
  if (!String(row?.quoteAsset ?? '').trim()) failures.push('quoteAsset');
  if (!Number.isFinite(Number(row?.onboardDate))) failures.push('onboardDate');
  const filters = Array.isArray(row?.filters) ? row.filters : [];
  const priceFilter = filters.find(filter => String(filter?.filterType ?? '').toUpperCase() === 'PRICE_FILTER');
  const lotFilter = filters.find(filter => String(filter?.filterType ?? '').toUpperCase() === 'LOT_SIZE');
  const notionalFilter = filters.find(filter => ['MIN_NOTIONAL', 'NOTIONAL'].includes(String(filter?.filterType ?? '').toUpperCase()));
  let tickSize;
  let stepSize;
  let minQty;
  let minNotional;
  try { tickSize = decimalString(priceFilter?.tickSize, `${normalizedSymbol}:tickSize`); } catch { failures.push('PRICE_FILTER.tickSize'); }
  try { stepSize = decimalString(lotFilter?.stepSize, `${normalizedSymbol}:stepSize`); } catch { failures.push('LOT_SIZE.stepSize'); }
  try { minQty = decimalString(lotFilter?.minQty, `${normalizedSymbol}:minQty`); } catch { failures.push('LOT_SIZE.minQty'); }
  try {
    minNotional = decimalString(notionalFilter?.minNotional ?? notionalFilter?.notional, `${normalizedSymbol}:minNotional`);
  } catch {
    failures.push('MIN_NOTIONAL.minNotional');
  }
  return {
    symbol: normalizedSymbol,
    valid: failures.length === 0,
    failures,
    status: row?.status ?? null,
    contractType: row?.contractType ?? null,
    quoteAsset: row?.quoteAsset ?? null,
    onboardDate: Number.isFinite(Number(row?.onboardDate)) ? Number(row.onboardDate) : null,
    filters: { tickSize: tickSize ?? null, stepSize: stepSize ?? null, minQty: minQty ?? null, minNotional: minNotional ?? null }
  };
}

function upper(value) {
  return String(value ?? '').trim().toUpperCase();
}

const STABLE_BASES = new Set(['USDT', 'USDC', 'BUSD', 'DAI', 'FDUSD', 'TUSD', 'USDP', 'USDE', 'USD1']);

/** Select a capture candidate set from current PIT exchangeInfo/ticker, never a hard-coded list. */
export function selectHyExp0022EngineeringSymbols({ exchangeInfo, tickers, observedAt = Date.now(), maxSymbols = DEFAULT_MAX_SYMBOLS } = {}) {
  const at = timestamp('universe observedAt', observedAt);
  const boundedMaxSymbols = integer('maxSymbols', maxSymbols, 1);
  if (boundedMaxSymbols > MAX_ENGINEERING_SYMBOLS) throw errorWithCode('UNIVERSE_BATCH_LIMIT_EXCEEDED', `maxSymbols cannot exceed ${MAX_ENGINEERING_SYMBOLS}`);
  const tickerBySymbol = new Map((Array.isArray(tickers) ? tickers : []).map(row => [upper(row?.symbol ?? row?.s), row]));
  const rows = [];
  for (const row of Array.isArray(exchangeInfo) ? exchangeInfo : []) {
    const symbol = upper(row?.symbol);
    const reasons = [];
    if (!/^[A-Z0-9]+$/.test(symbol)) reasons.push('invalid_symbol');
    if (upper(row?.contractType) !== 'PERPETUAL') reasons.push('not_perpetual');
    if (!['USDT', 'USDC'].includes(upper(row?.quoteAsset ?? row?.marginAsset))) reasons.push('unsupported_quote_asset');
    if (upper(row?.status) !== 'TRADING') reasons.push('not_trading');
    if (STABLE_BASES.has(upper(row?.baseAsset))) reasons.push('excluded_stable_base');
    const onboardDate = Number(row?.onboardDate);
    if (!Number.isFinite(onboardDate) || onboardDate > at - 30 * DAY_MS) reasons.push('listing_age_under_30d');
    const ticker = tickerBySymbol.get(symbol);
    const quoteVolume = Number(ticker?.quoteVolume ?? ticker?.q);
    if (!ticker || !Number.isFinite(quoteVolume)) reasons.push('missing_ticker_diagnostic');
    if (reasons.length) {
      rows.push({ symbol, eligible: false, reasons: [...new Set(reasons)], quoteVolumeUsdt: Number.isFinite(quoteVolume) ? quoteVolume : null });
      continue;
    }
    rows.push({
      symbol,
      eligible: true,
      reasons: [],
      quoteVolumeUsdt: quoteVolume,
      onboardDate,
      quoteAsset: upper(row.quoteAsset ?? row.marginAsset),
      contractType: upper(row.contractType),
      status: upper(row.status),
      tickerDiagnosticOnly: true
    });
  }
  const eligible = rows
    .filter(row => row.eligible)
    .sort((left, right) => right.quoteVolumeUsdt - left.quoteVolumeUsdt || left.symbol.localeCompare(right.symbol));
  const selected = eligible.slice(0, boundedMaxSymbols);
  const selectedSymbols = selected.map(row => row.symbol).sort();
  return {
    selectionSource: 'PIT_EXCHANGE_INFO_PLUS_TICKER_FOR_ENGINEERING_CAPTURE_SAMPLING_ONLY',
    tickerDiagnosticOnly: true,
    tickerDefinesVolume6: false,
    symbols: selectedSymbols,
    selected: selected.sort((left, right) => left.symbol.localeCompare(right.symbol)),
    excluded: rows.filter(row => !selectedSymbols.includes(row.symbol)).sort((left, right) => left.symbol.localeCompare(right.symbol)),
    observedAt: at,
    maxSymbols: boundedMaxSymbols,
    pointInTime: true,
    futureDataUsed: false
  };
}

export function membershipAudit(previousSymbols = [], nextSymbols = []) {
  const previous = new Set(previousSymbols.map(symbolOf));
  const next = new Set(nextSymbols.map(symbolOf));
  return {
    added: [...next].filter(symbol => !previous.has(symbol)).sort(),
    removed: [...previous].filter(symbol => !next.has(symbol)).sort(),
    unchanged: [...next].filter(symbol => previous.has(symbol)).sort()
  };
}

function createDepthContext(symbol, segmentId) {
  return {
    symbol,
    segmentId,
    buffer: [],
    state: null,
    snapshotId: null,
    status: 'WAITING_SNAPSHOT',
    snapshotAttempts: 0,
    snapshotTooOldRetries: 0,
    alignmentSuccesses: 0,
    alignmentFailureCount: 0,
    alignmentFailure: null,
    failureCode: null,
    staleBufferedDropped: 0,
    bufferedEventsPeak: 0,
    alignmentLatencyMs: null,
    snapshotRequestStartedAt: null,
    snapshotReceivedAt: null,
    lastEventReceivedAt: null
  };
}

function sequenceBounds(context, envelope) {
  const U = Number(envelope?.data?.U);
  const u = Number(envelope?.data?.u);
  if (!Number.isSafeInteger(U) || !Number.isSafeInteger(u) || U > u) {
    throw errorWithCode('INVALID_SEQUENCE_RANGE', `${context.symbol}:invalid_sequence_range`);
  }
  return { U, u };
}

function markContextFailure(context, error) {
  if (context.status === 'FAILED') return;
  const code = error?.code ?? String(error?.message ?? error);
  context.status = 'FAILED';
  context.failureCode = String(code);
  context.alignmentFailure = context.alignmentFailure ?? String(error?.message ?? error);
  if (String(code).includes('snapshot_alignment')) context.alignmentFailureCount++;
}

function recordBuffer(context, envelope) {
  if (context.status === 'FAILED') return;
  context.buffer.push(envelope);
  context.bufferedEventsPeak = Math.max(context.bufferedEventsPeak, context.buffer.length);
  if (context.buffer.length > MAX_BUFFERED_EVENTS_PER_SYMBOL) {
    markContextFailure(context, errorWithCode('BUFFER_LIMIT_EXCEEDED', `${context.symbol}:buffer_limit_exceeded`));
  }
}

function replayContext(context) {
  if (context.status === 'FAILED' || !context.state) return 'FAILED';
  if (context.status !== 'ALIGNED') {
    while (context.buffer.length) {
      const head = context.buffer[0];
      const { U, u } = sequenceBounds(context, head);
      if (u < context.snapshotId) {
        context.buffer.shift();
        context.staleBufferedDropped++;
        continue;
      }
      if (U > context.snapshotId) return 'SNAPSHOT_TOO_OLD';
      const first = context.buffer.shift();
      context.state.ingestDiff({ data: first.data, receivedAt: first.receivedAt });
      context.status = 'ALIGNED';
      context.alignmentSuccesses++;
      context.alignmentLatencyMs = Math.max(0, Date.now() - context.snapshotRequestStartedAt);
      break;
    }
  }
  while (context.status === 'ALIGNED' && context.buffer.length) {
    const next = context.buffer.shift();
    context.state.ingestDiff({ data: next.data, receivedAt: next.receivedAt });
  }
  return context.status === 'ALIGNED' ? 'ALIGNED' : 'WAITING';
}

async function alignDepthContext({ context, fetchImpl, snapshotWriter, segmentDeadline, onEvent }) {
  const startedAt = Date.now();
  while (context.status !== 'ALIGNED' && context.status !== 'FAILED') {
    if (context.snapshotAttempts >= MAX_SNAPSHOT_ATTEMPTS || Date.now() - startedAt >= MAX_SNAPSHOT_ACQUISITION_MS || Date.now() >= segmentDeadline) {
      markContextFailure(context, errorWithCode('SNAPSHOT_ALIGNMENT', `${context.symbol}:snapshot_alignment`));
      break;
    }
    const snapshotAttempt = ++context.snapshotAttempts;
    let response;
    try {
      response = await fetchJsonCompleted({ fetchImpl, url: buildDepthSnapshotUrl(context.symbol) });
    } catch (error) {
      markContextFailure(context, error);
      break;
    }
    context.snapshotRequestStartedAt = response.requestStartedAt;
    context.snapshotReceivedAt = response.receivedAt;
    const payload = response.data;
    const verified = {
      st: payload?.st == null ? null : Number(payload.st),
      ps: payload?.ps == null ? null : String(payload.ps)
    };
    if (verified.st !== null && verified.st !== 1) {
      markContextFailure(context, errorWithCode('BINANCE_TRANSPORT_STATUS_REJECTED', `${context.symbol}:st=${verified.st}`));
      break;
    }
    const snapshotRecord = {
      experimentId: HY_EXP_0022_ID,
      stream: 'depth.snapshot',
      kind: 'snapshot',
      segmentId: context.segmentId,
      symbol: context.symbol,
      snapshotAttempt,
      requestStartedAt: response.requestStartedAt,
      receivedAt: response.receivedAt,
      exchangeObservedAt: serverObservedAt(response),
      ...rawTransportFields(verified),
      data: {
        s: payload?.s ?? context.symbol,
        ps: payload?.ps,
        st: payload?.st,
        lastUpdateId: payload?.lastUpdateId,
        bids: payload?.bids ?? payload?.b,
        asks: payload?.asks ?? payload?.a
      }
    };
    snapshotWriter.append(snapshotRecord);
    try {
      const state = createDepthSegmentReconstructor({
        symbol: context.symbol,
        requiredDepthLevels: DEPTH_LEVELS,
        maxEventGapMs: 1_000,
        maxFutureSkewMs: 5_000
      });
      state.ingestSnapshot({ data: snapshotRecord.data, receivedAt: response.receivedAt });
      context.state = state;
      context.snapshotId = integer('snapshot lastUpdateId', payload?.lastUpdateId);
    } catch (error) {
      markContextFailure(context, error);
      break;
    }
    let replayResult;
    try {
      replayResult = replayContext(context);
    } catch (error) {
      markContextFailure(context, error);
      break;
    }
    if (replayResult === 'ALIGNED') break;
    if (replayResult === 'SNAPSHOT_TOO_OLD') {
      context.snapshotTooOldRetries++;
      if (context.snapshotAttempts < MAX_SNAPSHOT_ATTEMPTS) await new Promise(resolve => setTimeout(resolve, SNAPSHOT_RETRY_DELAY_MS));
      continue;
    }
    while (context.status !== 'ALIGNED' && context.status !== 'FAILED' && Date.now() < segmentDeadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
      try {
        const next = replayContext(context);
        if (next === 'ALIGNED') break;
        if (next === 'SNAPSHOT_TOO_OLD') {
          context.snapshotTooOldRetries++;
          break;
        }
      } catch (error) {
        markContextFailure(context, error);
        break;
      }
    }
    if (context.status === 'ALIGNED') break;
    if (context.status === 'FAILED') break;
    if (context.snapshotAttempts >= MAX_SNAPSHOT_ATTEMPTS || Date.now() >= segmentDeadline) {
      markContextFailure(context, errorWithCode('SNAPSHOT_ALIGNMENT', `${context.symbol}:snapshot_alignment`));
      break;
    }
    if (context.snapshotTooOldRetries > context.snapshotAttempts - 1) continue;
    await onEvent?.(context);
  }
  if (context.status !== 'ALIGNED' && context.status !== 'FAILED') {
    markContextFailure(context, errorWithCode('SNAPSHOT_ALIGNMENT', `${context.symbol}:snapshot_alignment`));
  }
  return context;
}

function contextSummary(context) {
  return {
    symbol: context.symbol,
    status: context.status,
    aligned: context.status === 'ALIGNED',
    snapshotId: context.snapshotId,
    snapshotAttempts: context.snapshotAttempts,
    snapshotTooOldRetries: context.snapshotTooOldRetries,
    alignmentSuccesses: context.alignmentSuccesses,
    alignmentFailureCount: context.alignmentFailureCount,
    alignmentFailure: context.alignmentFailure,
    failureCode: context.failureCode,
    staleBufferedDropped: context.staleBufferedDropped,
    bufferedEventsRemaining: context.buffer.length,
    bufferedEventsPeak: context.bufferedEventsPeak,
    alignmentLatencyMs: context.alignmentLatencyMs,
    updates: context.state?.summary?.updates ?? 0,
    maxDepthLevel: context.state?.summary?.maxDepthLevel ?? 0,
    lastUpdateId: context.state?.summary?.lastUpdateId ?? null,
    snapshotRequestStartedAt: context.snapshotRequestStartedAt,
    snapshotReceivedAt: context.snapshotReceivedAt
  };
}

async function collectDepthSegment({
  symbols,
  segmentId,
  segmentDeadline,
  fetchImpl,
  WebSocketImpl,
  depthWriter,
  snapshotWriter,
  segmentWriter
}) {
  const contexts = new Map(symbols.map(symbol => [symbol, createDepthContext(symbol, segmentId)]));
  let totalBufferedPeak = 0;
  let socketHandle = null;
  let socketFailure = null;
  let closedIntentionally = false;
  let socketEndedUnexpectedly = false;
  let resolveSocketClosed;
  const socketClosed = new Promise(resolve => { resolveSocketClosed = resolve; });
  const onMessage = async ({ raw, verified }) => {
    const { payload, stream } = transportPayload(raw);
    const symbol = symbolOf(payload?.s ?? payload?.symbol);
    const context = contexts.get(symbol);
    const receivedAt = Date.now();
    const envelope = {
      experimentId: HY_EXP_0022_ID,
      stream: 'depth.diff',
      kind: 'diff',
      segmentId,
      symbol,
      sourceStream: stream ?? `${symbol.toLowerCase()}@depth@100ms`,
      receivedAt,
      sourceExchangeTimestamp: payload?.E ?? null,
      transactionTimestamp: payload?.T ?? null,
      ...rawTransportFields(verified),
      data: payload
    };
    depthWriter.append(envelope);
    if (!context) throw errorWithCode('UNIVERSE_STREAM_MISMATCH', `${symbol}:not in dynamic capture set`);
    if (context.status === 'FAILED') return;
    context.lastEventReceivedAt = receivedAt;
    if (context.status !== 'ALIGNED') {
      recordBuffer(context, envelope);
      totalBufferedPeak = Math.max(totalBufferedPeak, [...contexts.values()].reduce((sum, row) => sum + row.buffer.length, 0));
      if (totalBufferedPeak > MAX_BUFFERED_EVENTS_TOTAL) {
        markContextFailure(context, errorWithCode('BUFFER_LIMIT_EXCEEDED', 'buffer_limit_exceeded'));
      }
      try {
        replayContext(context);
      } catch (error) {
        markContextFailure(context, error);
      }
      return;
    }
    try {
      context.state.ingestDiff({ data: payload, receivedAt });
    } catch (error) {
      markContextFailure(context, error);
      socketFailure = socketFailure ?? error.message;
      closeSocket(socketHandle?.socket);
    }
  };
  try {
    socketHandle = await openBinanceCombinedSocket({
      kind: 'depth',
      streams: symbols.map(symbol => `${symbol.toLowerCase()}@depth@100ms`),
      WebSocketImpl,
      onMessage,
      onError: error => { socketFailure = socketFailure ?? error.message; },
      onClose: () => {
        if (!closedIntentionally) {
          socketFailure = socketFailure ?? 'depth_socket_closed';
          socketEndedUnexpectedly = true;
          resolveSocketClosed?.();
        }
      }
    });
  } catch (error) {
    socketFailure = error.message;
  }
  if (socketHandle) {
    const alignments = [...contexts.values()].map(context => alignDepthContext({
      context,
      fetchImpl,
      snapshotWriter,
      segmentDeadline
    }));
    await Promise.allSettled(alignments);
    const failedDuringAlignment = [...contexts.values()].some(context => context.status === 'FAILED');
    if (failedDuringAlignment) {
      socketFailure = socketFailure ?? 'depth_context_failed';
      closeSocket(socketHandle.socket);
    } else {
      const remaining = Math.max(1, segmentDeadline - Date.now());
      await Promise.race([
        new Promise(resolve => setTimeout(resolve, remaining)),
        socketClosed
      ]);
    }
    closedIntentionally = true;
    closeSocket(socketHandle.socket);
  } else {
    for (const context of contexts.values()) markContextFailure(context, new Error(socketFailure ?? 'depth_socket_open_failed'));
  }
  const summaries = Object.fromEntries([...contexts.entries()].map(([symbol, context]) => [symbol, contextSummary(context)]));
  const invalidContexts = [...contexts.values()].filter(context => context.status !== 'ALIGNED');
  const missingUpdates = [...contexts.values()].filter(context => context.status === 'ALIGNED' && (context.state?.summary?.updates ?? 0) < 1);
  const reasons = [];
  if (socketFailure && (!closedIntentionally || socketEndedUnexpectedly)) reasons.push(socketFailure);
  for (const context of invalidContexts) {
    const reason = context.failureCode ?? 'snapshot_alignment';
    reasons.push(`${reason}:${context.symbol}`);
  }
  if (missingUpdates.length) reasons.push(`no_depth_updates:${missingUpdates.map(context => context.symbol).sort().join(',')}`);
  const staleDropped = [...contexts.values()].reduce((sum, context) => sum + context.staleBufferedDropped, 0);
  const alignmentFailures = [...contexts.values()].reduce((sum, context) => sum + context.alignmentFailureCount, 0);
  const sequenceGaps = [...contexts.values()].filter(context => ['sequence_gap', 'missing_interval', 'out_of_order_receipt', 'duplicate_update', 'out_of_order_update'].includes(context.failureCode)).length;
  const crossedBooks = [...contexts.values()].filter(context => String(context.failureCode ?? '').includes('crossed_book')).length;
  const bufferLimitFailures = [...contexts.values()].filter(context => String(context.failureCode ?? '').includes('buffer_limit_exceeded')).length;
  const status = reasons.length ? 'INVALID' : 'VALID';
  const segment = {
    experimentId: HY_EXP_0022_ID,
    segmentId,
    stream: 'segment.audit',
    receivedAt: Date.now(),
    status,
    reason: reasons.join(';') || 'rotation_or_deadline',
    symbols,
    reconnectCreatesNewSegment: true,
    contexts: summaries,
    diagnostics: {
      bufferedEventsPeak: totalBufferedPeak,
      staleBufferedDropped: staleDropped,
      snapshotAlignmentFailures: alignmentFailures,
      sequenceGaps,
      crossedBooks,
      bufferLimitFailures,
      transport: socketHandle?.capability ?? null
    }
  };
  segmentWriter.append(segment);
  return segment;
}

function nextUtcBoundary(value) {
  const parsed = timestamp('boundary time', value);
  return (Math.floor(parsed / FOUR_HOURS_MS) + 1) * FOUR_HOURS_MS;
}

async function collectDepthSegments({ symbols, deadline, segmentMaxMs, fetchImpl, WebSocketImpl, writers }) {
  const segments = [];
  let index = 0;
  while (Date.now() < deadline) {
    const started = Date.now();
    const segmentDeadline = Math.min(deadline, nextUtcBoundary(started), started + segmentMaxMs);
    const segment = await collectDepthSegment({
      symbols,
      segmentId: `${writers.runId}:depth:${++index}`,
      segmentDeadline,
      fetchImpl,
      WebSocketImpl,
      depthWriter: writers.depth,
      snapshotWriter: writers.snapshot,
      segmentWriter: writers.segment
    });
    segments.push(segment);
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(250, deadline - Date.now())));
  }
  return segments;
}

function klineRecord({ segmentId, symbol, payload, receivedAt, verified, sourceStream }) {
  return {
    experimentId: HY_EXP_0022_ID,
    stream: 'kline.4h',
    kind: 'websocket',
    segmentId,
    symbol,
    source: 'CONTRACT_PRICE',
    priceType: 'CONTRACT_PRICE',
    sourceStream: sourceStream ?? `${symbol.toLowerCase()}@kline_4h`,
    sourceExchangeTimestamp: payload?.E ?? null,
    receivedAt,
    ...rawTransportFields(verified),
    data: payload
  };
}

async function collectKlineStream({
  symbols,
  deadline,
  fetchImpl,
  WebSocketImpl,
  klineWriter,
  confirmationWriter,
  confirmationTimeoutMs,
  targetBar = null
}) {
  const expectedBar = targetBar == null ? null : {
    openTime: integer('target bar openTime', targetBar.openTime),
    closeTime: integer('target bar closeTime', targetBar.closeTime),
    source: 'CONTRACT_PRICE',
    interval: '4h'
  };
  const perSymbol = Object.fromEntries(symbols.map(symbol => [symbol, {
    symbol,
    finalWebsocketBars: 0,
    restConfirmationAttempts: 0,
    restConfirmations: 0,
    confirmedBars: 0,
    sourceConflicts: 0,
    confirmationMissing: 0,
    receivedAtAfterClose: false,
    source: 'CONTRACT_PRICE',
    markPriceKlineUsed: false,
    bars: []
  }]));
  const diagnostics = {
    transport: null,
    websocketEvents: 0,
    openCurrentBarEvents: 0,
    finalBarEvents: 0,
    finalWebsocketBars: 0,
    confirmedBars: 0,
    sourceConflicts: 0,
    confirmationMissing: 0,
    preCaptureBarsRejected: 0,
    nonTargetFinalBars: 0,
    targetBar: expectedBar,
    perSymbol,
    errors: []
  };
  const pendingMessages = new Set();
  let connectionIndex = 0;
  let hardFailure = false;

  const processMessage = async ({ raw, verified, segmentId }) => {
    const { payload, stream } = transportPayload(raw);
    if (payload?.e !== 'kline' || payload?.k?.i !== '4h') {
      diagnostics.errors.push('invalid_kline_stream_payload');
      return;
    }
    const symbol = symbolOf(payload.s ?? payload.k.s);
    if (!symbols.includes(symbol)) {
      diagnostics.errors.push(`kline_symbol_not_selected:${symbol}`);
      return;
    }
    const receivedAt = Date.now();
    diagnostics.websocketEvents++;
    klineWriter.append(klineRecord({ segmentId, symbol, payload, receivedAt, verified, sourceStream: stream }));
    const symbolDiagnostics = perSymbol[symbol];
    const openTime = Number(payload.k.t);
    const closeTime = Number(payload.k.T);
    if (payload.k.x !== true) {
      if (openTime < timestamp('capture start', HY_EXP_0022_CAPTURE_START)) diagnostics.preCaptureBarsRejected++;
      else diagnostics.openCurrentBarEvents++;
      return;
    }
    if (openTime < timestamp('capture start', HY_EXP_0022_CAPTURE_START)) {
      diagnostics.preCaptureBarsRejected++;
      return;
    }
    if (expectedBar && (openTime !== expectedBar.openTime || closeTime !== expectedBar.closeTime)) {
      diagnostics.nonTargetFinalBars++;
      diagnostics.errors.push(`unexpected_target_bar:${symbol}:${openTime}`);
      return;
    }
    diagnostics.finalBarEvents++;
    diagnostics.finalWebsocketBars++;
    symbolDiagnostics.finalWebsocketBars++;
    const receivedAfterClose = receivedAt > closeTime;
    symbolDiagnostics.receivedAtAfterClose = receivedAfterClose;
    if (!receivedAfterClose) {
      diagnostics.errors.push(`BAR_RECEIPT_BEFORE_CLOSE:${symbol}`);
      return;
    }
    try {
      const restUrl = buildJustClosedKlineUrl({ symbol, openTime: payload.k.t, closeTime: payload.k.T });
      symbolDiagnostics.restConfirmationAttempts++;
      const restResponse = await withTimeout(
        fetchJsonCompleted({ fetchImpl, url: restUrl }),
        confirmationTimeoutMs,
        'BAR_CONFIRMATION_MISSING'
      );
      const rows = Array.isArray(restResponse.data) ? restResponse.data : [];
      const restRow = rows.find(row => Number(row?.[0]) === openTime);
      confirmationWriter.append({
        experimentId: HY_EXP_0022_ID,
        stream: 'kline.4h',
        kind: 'rest_confirmation',
        symbol,
        openTime,
        closeTime: Number(payload.k.T),
        requestStartedAt: restResponse.requestStartedAt,
        receivedAt: restResponse.receivedAt,
        endpoint: restUrl,
        source: 'CONTRACT_PRICE',
        priceType: 'CONTRACT_PRICE',
        data: restRow ?? null
      });
      if (!restRow) throw errorWithCode('BAR_CONFIRMATION_MISSING', 'REST did not return the just-closed prospective bar');
      symbolDiagnostics.restConfirmations++;
      const websocketBar = normalizeHyExp0022ContractKline({
        raw: { ...raw, source: 'CONTRACT_PRICE', priceType: 'CONTRACT_PRICE' },
        receivedAt,
        source: 'CONTRACT_PRICE',
        captureStart: HY_EXP_0022_CAPTURE_START,
        mode: 'DEVELOPMENT_CAPTURE'
      });
      const restBar = normalizeHyExp0022ContractKline({
        raw: { values: restRow, source: 'CONTRACT_PRICE', priceType: 'CONTRACT_PRICE' },
        receivedAt: restResponse.receivedAt,
        sourceTimestamp: Number(restRow[6]),
        source: 'CONTRACT_PRICE',
        captureStart: HY_EXP_0022_CAPTURE_START,
        mode: 'DEVELOPMENT_CAPTURE'
      });
      reconcileHyExp0022BarSources({ websocketBar, restBar });
      diagnostics.confirmedBars++;
      symbolDiagnostics.confirmedBars++;
      symbolDiagnostics.bars.push({
        ...websocketBar,
        source: 'CONTRACT_PRICE',
        restReceivedAt: restResponse.receivedAt
      });
    } catch (error) {
      if (error.code === 'BAR_SOURCE_CONFLICT') {
        diagnostics.sourceConflicts++;
        symbolDiagnostics.sourceConflicts++;
      }
      if (error.code === 'BAR_CONFIRMATION_MISSING') {
        diagnostics.confirmationMissing++;
        symbolDiagnostics.confirmationMissing++;
      }
      diagnostics.errors.push(`${error.code ?? 'BAR_CONFIRMATION_ERROR'}:${symbol}`);
    }
  };
  while (Date.now() < deadline && !hardFailure) {
    let socketHandle = null;
    let intentionalClose = false;
    let socketEndedUnexpectedly = false;
    let resolveSocketClosed;
    const socketClosed = new Promise(resolve => { resolveSocketClosed = resolve; });
    const segmentId = `kline-${Date.now()}-${++connectionIndex}`;
    try {
      socketHandle = await openBinanceCombinedSocket({
        kind: 'kline',
        streams: symbols.map(symbol => `${symbol.toLowerCase()}@kline_4h`),
        WebSocketImpl,
        onMessage: ({ raw, verified }) => {
          const task = processMessage({ raw, verified, segmentId });
          pendingMessages.add(task);
          task.then(
            () => pendingMessages.delete(task),
            () => pendingMessages.delete(task)
          );
          return task;
        },
        onError: error => {
          diagnostics.errors.push(`kline_socket:${error.message}`);
          if (error?.code === 'BINANCE_TRANSPORT_STATUS_REJECTED') hardFailure = true;
          resolveSocketClosed?.();
        },
        onClose: () => {
          if (!intentionalClose) {
            socketEndedUnexpectedly = true;
            diagnostics.errors.push('kline_socket_closed');
            resolveSocketClosed?.();
          }
        }
      });
      if (diagnostics.transport == null) {
        diagnostics.transport = { ...socketHandle.capability, dataMessages: socketHandle.capability.dataMessages };
      } else {
        diagnostics.transport.dataMessages += socketHandle.capability.dataMessages;
        diagnostics.transport.subscriptionAck = diagnostics.transport.subscriptionAck || socketHandle.capability.subscriptionAck;
        diagnostics.transport.opened = diagnostics.transport.opened || socketHandle.capability.opened;
        diagnostics.transport.stValues = [...new Set([...(diagnostics.transport.stValues ?? []), ...(socketHandle.capability.stValues ?? [])])];
        diagnostics.transport.psValues = [...new Set([...(diagnostics.transport.psValues ?? []), ...(socketHandle.capability.psValues ?? [])])];
      }
      const remaining = Math.max(1, deadline - Date.now());
      await Promise.race([
        new Promise(resolve => setTimeout(resolve, remaining)),
        socketClosed
      ]);
    } catch (error) {
      diagnostics.errors.push(`kline_socket_open:${error.message}`);
      if (error?.code === 'BINANCE_TRANSPORT_STATUS_REJECTED') hardFailure = true;
    } finally {
      intentionalClose = true;
      closeSocket(socketHandle?.socket);
      await Promise.allSettled([...pendingMessages]);
    }
    if (!socketEndedUnexpectedly || hardFailure || Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
  }

  diagnostics.status = diagnostics.websocketEvents > 0 && !hardFailure && diagnostics.errors.every(error => !error.startsWith('BINANCE_TRANSPORT_STATUS_REJECTED'))
    ? (diagnostics.confirmedBars > 0
      ? 'PASS_FINAL_WS_REST_CONFIRMATION'
      : (diagnostics.openCurrentBarEvents > 0 ? 'PASS_OPEN_CURRENT_4H_STREAM' : 'PASS_TRANSPORT_PRECAPTURE_BAR_EXCLUDED'))
    : 'FAIL';
  diagnostics.developmentEligible = false;
  diagnostics.historicalBackfillUsed = false;
  diagnostics.preCaptureOnly = diagnostics.openCurrentBarEvents === 0 && diagnostics.confirmedBars === 0 && diagnostics.preCaptureBarsRejected > 0;
  diagnostics.finalWebsocketBars = diagnostics.finalBarEvents;
  return diagnostics;
}

async function captureExchangeAndUniverse({ fetchImpl, exchangeWriter, tickerWriter }) {
  const [exchangeResponse, tickerResponse] = await Promise.all([
    fetchJsonCompleted({ fetchImpl, url: 'https://fapi.binance.com/fapi/v1/exchangeInfo' }),
    fetchJsonCompleted({ fetchImpl, url: 'https://fapi.binance.com/fapi/v1/ticker/24hr' })
  ]);
  exchangeWriter.append({
    experimentId: HY_EXP_0022_ID,
    stream: 'exchangeInfo',
    requestStartedAt: exchangeResponse.requestStartedAt,
    receivedAt: exchangeResponse.receivedAt,
    exchangeObservedAt: serverObservedAt(exchangeResponse),
    data: exchangeResponse.data
  });
  tickerWriter.append({
    experimentId: HY_EXP_0022_ID,
    stream: 'ticker',
    diagnosticOnly: true,
    requestStartedAt: tickerResponse.requestStartedAt,
    receivedAt: tickerResponse.receivedAt,
    exchangeObservedAt: serverObservedAt(tickerResponse),
    data: tickerResponse.data
  });
  const observedAt = Math.min(
    exchangeResponse.exchangeObservedAt ?? exchangeResponse.receivedAt,
    exchangeResponse.receivedAt,
    tickerResponse.exchangeObservedAt ?? tickerResponse.receivedAt,
    tickerResponse.receivedAt
  );
  return {
    exchangeResponse,
    tickerResponse,
    observedAt,
    exchangeInfo: Array.isArray(exchangeResponse.data?.symbols) ? exchangeResponse.data.symbols : [],
    tickers: Array.isArray(tickerResponse.data) ? tickerResponse.data : []
  };
}

async function captureFunding({ symbols, fetchImpl, fundingWriter }) {
  const rows = await Promise.all(symbols.map(async symbol => {
    try {
      const response = await fetchJsonCompleted({ fetchImpl, url: buildFundingUrl(symbol) });
      const sourceRows = Array.isArray(response.data) ? response.data : [];
      const sourceRow = sourceRows.find(row => String(row?.symbol ?? '').toUpperCase() === symbol);
      const validated = validateHyExp0022FundingRow({ symbol, row: sourceRow, receivedAt: response.receivedAt });
      fundingWriter.append({
        experimentId: HY_EXP_0022_ID,
        stream: 'funding',
        symbol,
        requestStartedAt: response.requestStartedAt,
        receivedAt: response.receivedAt,
        exchangeObservedAt: serverObservedAt(response),
        valid: true,
        validation: validated,
        data: response.data
      });
      return { symbol, ok: true, response, validation: validated };
    } catch (error) {
      fundingWriter.append({
        experimentId: HY_EXP_0022_ID,
        stream: 'funding',
        symbol,
        valid: false,
        receivedAt: Date.now(),
        error: error.message
      });
      return { symbol, ok: false, error: error.message, code: error.code ?? 'FUNDING_SCHEMA_INVALID' };
    }
  }));
  return rows;
}

function aggregateDepthDiagnostics(segments) {
  const contexts = segments.flatMap(segment => Object.values(segment.contexts ?? {}));
  return {
    validSegments: segments.filter(segment => segment.status === 'VALID').length,
    invalidSegments: segments.filter(segment => segment.status !== 'VALID').length,
    snapshotAlignmentFailures: segments.reduce((sum, segment) => sum + Number(segment.diagnostics?.snapshotAlignmentFailures ?? 0), 0),
    sequenceGaps: segments.reduce((sum, segment) => sum + Number(segment.diagnostics?.sequenceGaps ?? 0), 0),
    crossedBooks: segments.reduce((sum, segment) => sum + Number(segment.diagnostics?.crossedBooks ?? 0), 0),
    bufferLimitFailures: segments.reduce((sum, segment) => sum + Number(segment.diagnostics?.bufferLimitFailures ?? 0), 0),
    staleBufferedDropped: segments.reduce((sum, segment) => sum + Number(segment.diagnostics?.staleBufferedDropped ?? 0), 0),
    bufferedEventsPeak: Math.max(0, ...segments.map(segment => Number(segment.diagnostics?.bufferedEventsPeak ?? 0))),
    snapshotAttempts: contexts.reduce((sum, context) => sum + Number(context.snapshotAttempts ?? 0), 0),
    snapshotTooOldRetries: contexts.reduce((sum, context) => sum + Number(context.snapshotTooOldRetries ?? 0), 0),
    alignmentSuccesses: contexts.reduce((sum, context) => sum + Number(context.alignmentSuccesses ?? 0), 0),
    alignmentFailures: contexts.reduce((sum, context) => sum + Number(context.alignmentFailureCount ?? 0), 0),
    symbolsCaptured: [...new Set(contexts.map(context => context.symbol))].sort()
  };
}

function rawFileEntries(directory, writers) {
  return writers.map(writer => buildCaptureFileEntry({ root: directory, filePath: writer.filePath }));
}

function countMissingReceivedAt(writers) {
  let missing = 0;
  for (const writer of writers) {
    const text = fs.readFileSync(writer.filePath, 'utf8');
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      const record = JSON.parse(line);
      if (record.receivedAt == null) missing++;
    }
  }
  return missing;
}

function buildRawManifest({
  runId,
  directory,
  startedAt,
  finishedAt,
  symbols,
  files,
  segments,
  diagnostics,
  transport,
  barSourceVerification,
  errors
}) {
  const body = {
    schemaVersion: 1,
    manifestType: 'HY-EXP-0022-ENGINEERING-DRY-RUN',
    immutable: true,
    experimentId: HY_EXP_0022_ID,
    runId,
    captureMode: 'ENGINEERING_DRY_RUN',
    dataClass: 'ENGINEERING_DRY_RUN',
    root: HY_EXP_0022_ENGINEERING_ROOT,
    startedAt: iso(startedAt),
    finishedAt: iso(finishedAt),
    durationMs: timestamp('finishedAt', finishedAt) - timestamp('startedAt', startedAt),
    symbols,
    requiredStreams: [...HY_EXP_0022_REQUIRED_CAPTURE_STREAMS],
    diagnosticOnlyStreams: [...HY_EXP_0022_DIAGNOSTIC_STREAMS],
    transport,
    files,
    segments,
    diagnostics,
    barSourceVerification,
    errors: errors.map(String),
    authorization: 'PAPER_ONLY',
    liveOrdersEnabled: false,
    accountApiEnabled: false,
    orderApiEnabled: false,
    orderEndpoints: [...HY_EXP_0022_ORDER_ENDPOINTS],
    accountEndpoints: [...HY_EXP_0022_ACCOUNT_ENDPOINTS],
    developmentAllowed: false,
    developmentEligible: false,
    finalOosEligible: false,
    pnlComputed: false,
    historicalBackfillUsed: false,
    proxyDepthUsed: false,
    noOrderOrAccountApi: true,
    status: errors.length || diagnostics.validSegments < 1 ? 'DATA_FAIL' : 'complete'
  };
  return { ...body, manifestSha256: sha256(canonicalJson(body)) };
}

export function buildHyExp0022OosWorkflowDecision({
  developmentStatus,
  finalOosCaptureComplete,
  operation
} = {}) {
  if (developmentStatus === 'PASS' && finalOosCaptureComplete !== true) {
    throw errorWithCode('FINAL_OOS_CAPTURE_NOT_COMPLETE', 'Development PASS cannot be evaluated before Final-OOS capture is sealed');
  }
  const developmentAllowed = developmentStatus === 'PASS' && finalOosCaptureComplete === true;
  return {
    developmentStatus: String(developmentStatus ?? 'NOT_PASS'),
    finalOosCaptureComplete: finalOosCaptureComplete === true,
    developmentEvaluationAllowed: finalOosCaptureComplete === true,
    finalOosResearchReadAllowed: developmentAllowed,
    operation: assertHyExp0022FinalOosOperation({
      operation,
      developmentStatus,
      developmentAllowed
    })
  };
}

export function buildCollectorEngineeringReadiness({ result, requiredDurationMs = 5 * 60 * 1_000 } = {}) {
  const manifest = result.manifest;
  const diagnostics = manifest.diagnostics;
  const checks = {
    documentedDepthEndpoint: manifest.transport?.depth?.endpoint === HY_EXP_0022_TRANSPORT_ENDPOINTS.depth
      && manifest.transport?.depth?.status === 'VERIFIED',
    documentedKlineEndpoint: manifest.transport?.kline?.endpoint === HY_EXP_0022_TRANSPORT_ENDPOINTS.kline
      && manifest.transport?.kline?.status === 'VERIFIED',
    minimumDuration: manifest.durationMs >= requiredDurationMs,
    minimumDynamicSymbols: manifest.symbols.length >= 3,
    validSegments: diagnostics.validSegments >= 1 && diagnostics.invalidSegments === 0,
    snapshotAlignmentFailures: diagnostics.snapshotAlignmentFailures === 0,
    sequenceGaps: diagnostics.sequenceGaps === 0,
    crossedBooks: diagnostics.crossedBooks === 0,
    bufferLimitFailures: diagnostics.bufferLimitFailures === 0,
    receivedAtPresent: diagnostics.missingReceivedAt === 0,
    exchangeInfoCaptured: diagnostics.exchangeInfoCaptured === true,
    fundingCaptured: diagnostics.fundingMissing === 0,
    barSourceStreamVerified: ['PASS_OPEN_CURRENT_4H_STREAM', 'PASS_FINAL_WS_REST_CONFIRMATION', 'PASS_TRANSPORT_PRECAPTURE_BAR_EXCLUDED']
      .includes(result.barSourceVerification.status),
    immutableManifest: Boolean(result.manifestWrite?.manifestFileSha256),
    noPnl: manifest.pnlComputed === false,
    noDevelopment: manifest.developmentAllowed === false,
    noOrders: manifest.noOrderOrAccountApi === true
  };
  const status = Object.values(checks).every(Boolean) ? 'PASS' : 'COLLECTOR_NOT_READY';
  return {
    schemaVersion: 1,
    artifactType: 'HY_EXP_0022_COLLECTOR_ENGINEERING_READINESS',
    experimentId: HY_EXP_0022_ID,
    status,
    runId: result.runId,
    runWindow: { startedAt: manifest.startedAt, finishedAt: manifest.finishedAt, durationMs: manifest.durationMs },
    symbols: manifest.symbols,
    endpoints: {
      depth: result.manifest.transport?.depth ?? null,
      kline: result.manifest.transport?.kline ?? null
    },
    checks,
    diagnostics,
    barSourceVerification: result.barSourceVerification,
    validSegments: diagnostics.validSegments,
    invalidSegments: diagnostics.invalidSegments,
    snapshotAlignmentFailures: diagnostics.snapshotAlignmentFailures,
    sequenceGaps: diagnostics.sequenceGaps,
    crossedBooks: diagnostics.crossedBooks,
    bufferLimitFailures: diagnostics.bufferLimitFailures,
    receivedAtMissing: diagnostics.missingReceivedAt,
    files: manifest.files,
    rawFileSha256: Object.fromEntries(manifest.files.map(file => [file.path, file.sha256])),
    manifestSha256: manifest.manifestSha256,
    manifestFileSha256: result.manifestWrite?.manifestFileSha256 ?? null,
    root: HY_EXP_0022_ENGINEERING_ROOT,
    developmentEligible: false,
    developmentAllowed: false,
    finalOosEligible: false,
    pnlComputed: false,
    paperOnly: true,
    liveOrdersEnabled: false,
    orderApiEnabled: false,
    accountApiEnabled: false,
    oosWorkflow: {
      developmentPassBeforeFinalOosCaptureComplete: false,
      finalOosResearchReadRequiresDevelopmentPassAndSealedCapture: true,
      finalOosWindow: {
        start: HY_EXP_0022_FINAL_OOS_START,
        endExclusive: HY_EXP_0022_FINAL_OOS_END_EXCLUSIVE
      }
    },
    errors: manifest.errors
  };
}

/** Build the fail-closed evidence record for the first frozen prospective 4h bar. */
export function buildHyExp0022FirstProspectiveBarSmoke({
  result,
  targetBar = HY_EXP_0022_FIRST_PROSPECTIVE_BAR
} = {}) {
  const target = {
    openTime: integer('target bar openTime', targetBar.openTime),
    closeTime: integer('target bar closeTime', targetBar.closeTime),
    source: 'CONTRACT_PRICE',
    interval: '4h'
  };
  const manifest = result.manifest;
  const bar = result.barSourceVerification ?? {};
  const symbols = [...(result.symbols ?? [])].sort();
  const perSymbol = bar.perSymbol ?? {};
  const finalRows = symbols.map(symbol => perSymbol[symbol]).filter(Boolean);
  const depth = manifest.diagnostics ?? {};
  const fundingRows = result.fundingRows ?? [];
  const exchangeInfoValidation = manifest.diagnostics?.exchangeInfoValidation ?? {};
  const checks = {
    targetBarFrozen: target.openTime === HY_EXP_0022_FIRST_PROSPECTIVE_BAR.openTime
      && target.closeTime === HY_EXP_0022_FIRST_PROSPECTIVE_BAR.closeTime,
    dynamicSymbols: symbols.length >= 3,
    finalWebsocketBars: finalRows.length >= 3 && finalRows.every(row => row.finalWebsocketBars >= 1),
    exactRestConfirmations: finalRows.length >= 3 && finalRows.every(row => row.restConfirmations >= 1 && row.confirmedBars >= 1),
    barSourceConflicts: Number(bar.sourceConflicts ?? 0) === 0,
    barConfirmationMissing: Number(bar.confirmationMissing ?? 0) === 0,
    exactTimes: finalRows.length >= 3 && finalRows.every(row => row.bars.some(candidate => (
      candidate.openTime === target.openTime
      && candidate.closeTime === target.closeTime
      && candidate.finalClosed === true
    ))),
    receivedAtAfterClose: finalRows.length >= 3 && finalRows.every(row => row.receivedAtAfterClose === true),
    contractPriceSource: finalRows.length >= 3 && finalRows.every(row => row.source === 'CONTRACT_PRICE'),
    markPriceKlineNotUsed: finalRows.every(row => row.markPriceKlineUsed === false),
    depthAlignmentFailures: Number(depth.snapshotAlignmentFailures ?? 0) === 0,
    depthSequenceGaps: Number(depth.sequenceGaps ?? 0) === 0,
    depthCrossedBooks: Number(depth.crossedBooks ?? 0) === 0,
    depthBufferLimitFailures: Number(depth.bufferLimitFailures ?? 0) === 0,
    depthReceivedAtPresent: Number(depth.missingReceivedAt ?? 0) === 0,
    fundingRowsValid: fundingRows.length >= 3 && fundingRows.length === symbols.length && fundingRows.every(row => row.ok === true),
    exchangeInfoFiltersValid: symbols.length >= 3
      && Object.keys(exchangeInfoValidation).length === symbols.length
      && Object.values(exchangeInfoValidation).every(row => row.valid === true),
    noPnl: manifest.pnlComputed === false,
    noDevelopment: manifest.developmentAllowed === false && result.noDevelopment === true,
    paperOnly: manifest.authorization === 'PAPER_ONLY' && manifest.liveOrdersEnabled === false,
    noOrderOrAccountApi: manifest.noOrderOrAccountApi === true
  };
  const passed = Object.values(checks).every(Boolean);
  const now = Date.now();
  const failureReasons = [];
  if (!checks.finalWebsocketBars && now >= target.closeTime) {
    failureReasons.push('TARGET_BAR_FINAL_WS_NOT_CAPTURED_BEFORE_CLOSE_NO_HISTORICAL_BACKFILL');
  }
  if (checks.finalWebsocketBars && !checks.exactRestConfirmations) {
    failureReasons.push('BAR_CONFIRMATION_MISSING');
  }
  const status = passed
    ? 'PASS'
    : (now < target.closeTime ? 'WAITING_FOR_TARGET_BAR' : 'DATA_FAIL');
  return {
    schemaVersion: 1,
    artifactType: 'HY_EXP_0022_FIRST_PROSPECTIVE_BAR_SMOKE',
    experimentId: HY_EXP_0022_ID,
    status,
    targetBar: {
      ...target,
      openTime: new Date(target.openTime).toISOString(),
      closeTime: new Date(target.closeTime).toISOString()
    },
    runId: result.runId,
    runWindow: {
      startedAt: manifest.startedAt,
      finishedAt: manifest.finishedAt,
      durationMs: manifest.durationMs
    },
    symbols,
    finalWebsocketBars: Number(bar.finalWebsocketBars ?? bar.finalBarEvents ?? 0),
    restConfirmations: Number(bar.confirmedBars ?? 0),
    barConflicts: Number(bar.sourceConflicts ?? 0),
    confirmationMissing: Number(bar.confirmationMissing ?? 0),
    perSymbol,
    checks,
    depth: {
      alignmentFailures: Number(depth.snapshotAlignmentFailures ?? 0),
      sequenceGaps: Number(depth.sequenceGaps ?? 0),
      crossedBooks: Number(depth.crossedBooks ?? 0),
      bufferLimitFailures: Number(depth.bufferLimitFailures ?? 0),
      missingReceivedAt: Number(depth.missingReceivedAt ?? 0)
    },
    funding: {
      rows: fundingRows.map(row => ({ symbol: row.symbol, ok: row.ok, code: row.code ?? null, error: row.error ?? null })),
      valid: checks.fundingRowsValid
    },
    exchangeInfoValidation,
    source: 'CONTRACT_PRICE',
    markPriceKlineUsed: false,
    manifestSha256: manifest.manifestSha256,
    manifestFileSha256: result.manifestWrite?.manifestFileSha256 ?? null,
    rawFiles: manifest.files,
    authorization: 'PAPER_ONLY',
    pnlComputed: false,
    developmentAllowed: false,
    finalOosEligible: false,
    historicalBackfillUsed: false,
    proxyDepthUsed: false,
    errors: [...failureReasons, ...(bar.errors ?? []), ...(manifest.errors ?? [])]
  };
}

/** Execute only the isolated Phase-A engineering collector. */
export async function runHyExp0022EngineeringDryRun({
  projectRoot = process.cwd(),
  maxRuntimeMs = 5 * 60 * 1_000,
  maxSymbols = DEFAULT_MAX_SYMBOLS,
  segmentMaxMs = DEFAULT_SEGMENT_MAX_MS,
  confirmationTimeoutMs = DEFAULT_CONFIRMATION_TIMEOUT_MS,
  targetBar = null,
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket
} = {}) {
  resolveHyExp0022CollectorMode('ENGINEERING_DRY_RUN');
  const startedAt = Date.now();
  const duration = integer('maxRuntimeMs', maxRuntimeMs, 1);
  const deadline = startedAt + duration;
  const runId = `engineering-dry-run-${new Date(startedAt).toISOString().replaceAll(/[-:.TZ]/g, '')}-${randomUUID().slice(0, 8)}`;
  const directory = assertHyExp0022EngineeringRoot({ projectRoot });
  const runDirectory = path.join(directory, runId);
  fs.mkdirSync(runDirectory, { recursive: true });
  const writers = {
    runId,
    depth: openHyExp0022AppendOnlyNdjson(path.join(runDirectory, 'depth.diff.ndjson')),
    snapshot: openHyExp0022AppendOnlyNdjson(path.join(runDirectory, 'depth.snapshot.ndjson')),
    kline: openHyExp0022AppendOnlyNdjson(path.join(runDirectory, 'kline.4h.ndjson')),
    confirmation: openHyExp0022AppendOnlyNdjson(path.join(runDirectory, 'kline.4h.confirmation.ndjson')),
    exchange: openHyExp0022AppendOnlyNdjson(path.join(runDirectory, 'exchangeInfo.ndjson')),
    funding: openHyExp0022AppendOnlyNdjson(path.join(runDirectory, 'funding.ndjson')),
    ticker: openHyExp0022AppendOnlyNdjson(path.join(runDirectory, 'ticker.diagnostic.ndjson')),
    universe: openHyExp0022AppendOnlyNdjson(path.join(runDirectory, 'universe.snapshot.ndjson')),
    universeAudit: openHyExp0022AppendOnlyNdjson(path.join(runDirectory, 'universe.audit.ndjson')),
    segment: openHyExp0022AppendOnlyNdjson(path.join(runDirectory, 'segment.audit.ndjson'))
  };
  const allWriters = Object.values(writers).filter(value => value && typeof value.append === 'function');
  const errors = [];
  let universeInputs = null;
  let selection = null;
  let exchangeInfoValidation = {};
  let fundingRows = [];
  let segments = [];
  let klineDiagnostics = {
    status: 'FAIL',
    websocketEvents: 0,
    errors: ['not_started'],
    developmentEligible: false,
    historicalBackfillUsed: false,
    transport: null
  };
  const transport = {
    depth: { endpoint: HY_EXP_0022_TRANSPORT_ENDPOINTS.depth, status: 'NOT_VERIFIED' },
    kline: { endpoint: HY_EXP_0022_TRANSPORT_ENDPOINTS.kline, status: 'NOT_VERIFIED' }
  };
  try {
    try {
      universeInputs = await captureExchangeAndUniverse({
        fetchImpl,
        exchangeWriter: writers.exchange,
        tickerWriter: writers.ticker
      });
      selection = selectHyExp0022EngineeringSymbols({
        exchangeInfo: universeInputs.exchangeInfo,
        tickers: universeInputs.tickers,
        observedAt: universeInputs.observedAt,
        maxSymbols
      });
      const exchangeInfoBySymbol = new Map(universeInputs.exchangeInfo.map(row => [upper(row?.symbol), row]));
      exchangeInfoValidation = Object.fromEntries(selection.symbols.map(symbol => [
        symbol,
        validateHyExp0022ExchangeInfoSymbol({ symbol, row: exchangeInfoBySymbol.get(symbol) })
      ]));
      writers.universeAudit.append({
        experimentId: HY_EXP_0022_ID,
        stream: 'universe.audit',
        mode: 'ENGINEERING_DRY_RUN',
        observedAt: universeInputs.observedAt,
        receivedAt: Date.now(),
        previousSymbols: [],
        nextSymbols: selection.symbols,
        ...membershipAudit([], selection.symbols),
        tickerDiagnosticOnly: true,
        tickerDefinesVolume6: false,
        exchangeInfoValidation,
        selection
      });
      writers.universe.append({
        experimentId: HY_EXP_0022_ID,
        stream: 'universe.snapshot',
        phase: 'CAPTURE_CANDIDATE_SET_BEFORE_DEPTH',
        observedAt: universeInputs.observedAt,
        receivedAt: Date.now(),
        exchangeInfoObservedAt: universeInputs.exchangeResponse.exchangeObservedAt,
        symbols: selection.symbols,
        exchangeInfoValidation,
        selection,
        pointInTime: true,
        futureDataUsed: false,
        developmentEligible: false
      });
      fundingRows = await captureFunding({ symbols: selection.symbols, fetchImpl, fundingWriter: writers.funding });
    } catch (error) {
      errors.push(`universe_or_metadata:${error.message}`);
    }
    const symbols = selection?.symbols ?? [];
    if (symbols.length) {
      const [depthResult, klineResult] = await Promise.all([
        collectDepthSegments({
          symbols,
          deadline,
          segmentMaxMs: integer('segmentMaxMs', segmentMaxMs, 1),
          fetchImpl,
          WebSocketImpl,
          writers
        }),
        collectKlineStream({
          symbols,
          deadline,
          fetchImpl,
          WebSocketImpl,
          klineWriter: writers.kline,
          confirmationWriter: writers.confirmation,
          confirmationTimeoutMs: integer('confirmationTimeoutMs', confirmationTimeoutMs, 1),
          targetBar
        })
      ]);
      segments = depthResult;
      klineDiagnostics = klineResult;
      const depthCapability = segments.find(segment => segment.diagnostics?.transport)?.diagnostics?.transport;
      if (depthCapability) transport.depth = {
        ...depthCapability,
        status: depthCapability.opened && depthCapability.subscriptionAck && depthCapability.dataMessages > 0 ? 'VERIFIED' : 'FAIL'
      };
      transport.kline = {
        ...(klineDiagnostics.transport ?? { endpoint: HY_EXP_0022_TRANSPORT_ENDPOINTS.kline }),
        status: klineDiagnostics.transport?.opened && klineDiagnostics.transport?.subscriptionAck && klineDiagnostics.websocketEvents > 0
          ? 'VERIFIED'
          : 'FAIL'
      };
      const depthEligible = [...new Set(segments.flatMap(segment => Object.values(segment.contexts ?? {})
        .filter(context => context.status === 'ALIGNED' && context.maxDepthLevel >= DEPTH_LEVELS)
        .map(context => context.symbol)))].sort();
      writers.universe.append({
        experimentId: HY_EXP_0022_ID,
        stream: 'universe.snapshot',
        phase: 'CAPTURE_DEPTH_ELIGIBILITY_AUDIT',
        observedAt: Date.now(),
        receivedAt: Date.now(),
        symbols,
        depthEligibleSymbols: depthEligible,
        depthLevelsRequired: DEPTH_LEVELS,
        tickerDiagnosticOnly: true,
        tickerDefinesVolume6: false,
        pointInTime: true,
        developmentEligible: false
      });
    } else {
      errors.push('dynamic_universe_empty');
    }
  } catch (error) {
    errors.push(error.message);
  } finally {
    for (const writer of allWriters) writer.close();
  }
  const finishedAt = Date.now();
  const depthDiagnostics = aggregateDepthDiagnostics(segments);
  const rawFiles = rawFileEntries(runDirectory, allWriters);
  const diagnostics = {
    ...depthDiagnostics,
    exchangeInfoCaptured: Boolean(universeInputs),
    exchangeInfoValidation,
    exchangeInfoSchemaValid: Object.keys(exchangeInfoValidation).length === (selection?.symbols?.length ?? 0)
      && Object.values(exchangeInfoValidation).every(row => row.valid === true),
    universeSnapshots: fs.readFileSync(writers.universe.filePath, 'utf8').trim() ? 2 : 0,
    fundingMissing: fundingRows.filter(row => !row.ok).length,
    fundingRowsValid: fundingRows.length > 0 && fundingRows.every(row => row.ok === true),
    missingReceivedAt: countMissingReceivedAt(allWriters),
    klineWebsocketEvents: klineDiagnostics.websocketEvents ?? 0,
    barSourceStatus: klineDiagnostics.status,
    symbolsCaptured: selection?.symbols ?? [],
    transport
  };
  const manifest = buildRawManifest({
    runId,
    directory: runDirectory,
    startedAt,
    finishedAt,
    symbols: selection?.symbols ?? [],
    files: rawFiles,
    segments,
    diagnostics,
    transport,
    barSourceVerification: klineDiagnostics,
    errors: [...errors, ...(klineDiagnostics.errors ?? [])]
  });
  const manifestWrite = writeImmutableHyExp0022Manifest({ directory: runDirectory, manifest });
  return {
    runId,
    directory: runDirectory,
    mode: 'ENGINEERING_DRY_RUN',
    symbols: selection?.symbols ?? [],
    fundingRows,
    segments,
    barSourceVerification: klineDiagnostics,
    manifest,
    manifestWrite,
    transport,
    diagnostics,
    windows: HY_EXP_0022_WINDOWS,
    noDevelopment: true,
    noOosRead: true,
    pnlComputed: false
  };
}
