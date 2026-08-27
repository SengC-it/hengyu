import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { promises as fs, createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HY_DATA_0036_ENDPOINTS,
  HY_DATA_0036_ID,
  HY_DATA_0036_SYMBOLS
} from './hy-data-0036-contract.mjs';
import {
  getHyData0036Sup001Subscription,
  HY_DATA_0036_SUP_001_STREAMS
} from './hy-data-0036-supplement.mjs';
import { createBinancePublicRestGovernor } from './hy-data-0036-rest.mjs';
import { createCausalFeatureBuilder } from './hy-data-0036-features.mjs';
import { createEngineeringFeatureStore, verifyFeatureManifestFiles } from './hy-data-0036-feature-store.mjs';
import { createS3CompatibleSealedPartitionAdapter, evaluateStorageCapacity } from './hy-data-0036-storage.mjs';
import { readHostNtpEvidence } from './hy-data-0036-clock.mjs';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MAX_ROTATION_MS = 23 * HOUR_MS + 45 * MINUTE_MS;
const BRIDGE_WAIT_TIMEOUT_MS = 5_000;
const MAX_SNAPSHOT_RECOVERY_MS = 10_000;
const MAX_SNAPSHOT_RETRY_DELAY_MS = 5_000;
const MIN_CANARY_DURATION_MS = 60 * MINUTE_MS;
const MIN_CONTROLLED_RECONNECT_MS = 20 * MINUTE_MS;
const MAX_CONTROLLED_RECONNECT_MS = 30 * MINUTE_MS;
const DEFAULT_CONTROLLED_RECONNECT_MS = 25 * MINUTE_MS;
const STREAMS = Object.freeze([
  { id: 'aggTrade', endpoint: 'market', subscription: '<symbol>@aggTrade' },
  { id: 'bookTicker', endpoint: 'public', subscription: '<symbol>@bookTicker' },
  { id: 'depth20', endpoint: 'public', subscription: '<symbol>@depth20@100ms' },
  { id: 'depth.diff', endpoint: 'public', subscription: '<symbol>@depth@100ms' },
  { id: 'markPrice', endpoint: 'market', subscription: '<symbol>@markPrice@1s' },
  { id: 'forceOrder', endpoint: 'market', subscription: '<symbol>@forceOrder' }
]);
const STREAM_IDS = new Set(STREAMS.map(stream => stream.id));
const ALL_STREAM_IDS = new Set([...STREAM_IDS, 'depth.snapshot']);
const STREAM_BY_ID = new Map(STREAMS.map(stream => [stream.id, stream]));
const MARKET_STREAM_IDS = new Set(STREAMS.filter(stream => stream.endpoint === 'market').map(stream => stream.id));
const PUBLIC_STREAM_IDS = new Set(STREAMS.filter(stream => stream.endpoint === 'public').map(stream => stream.id));

export const HY_DATA_0036_MAX_ROTATION_MS = MAX_ROTATION_MS;
export const HY_DATA_0036_RUNTIME_STREAMS = STREAMS;
export const HY_DATA_0036_RUNTIME_SAFETY = Object.freeze({
  publicMarketDataOnly: true,
  apiKeyRequired: false,
  privateStream: false,
  accountApi: false,
  orderApi: false,
  paperOnly: true,
  signalOnly: true,
  gmail: false,
  scheduler: false,
  realEmail: false,
  autoTrading: false,
  finalOosRead: false,
  pnlComputed: false,
  researchEligible: false
});

function boundedSnapshotBackoff(attempt, baseDelayMs, random = Math.random) {
  const exponential = Math.min(MAX_SNAPSHOT_RETRY_DELAY_MS, baseDelayMs * (2 ** Math.max(0, attempt - 1)));
  const jitter = 0.75 + random() * 0.5;
  return Math.min(MAX_SNAPSHOT_RETRY_DELAY_MS, Math.max(1, Math.ceil(exponential * jitter)));
}

function defaultSleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function fail(message) {
  throw new Error(message);
}

function finite(name, value, { minimum = -Infinity } = {}) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number < minimum) fail(`invalid ${name}`);
  return number;
}

function integer(name, value, { minimum = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`invalid ${name}`);
  return value;
}

function symbol(value) {
  const normalized = String(value ?? '').toUpperCase();
  if (!HY_DATA_0036_SYMBOLS.includes(normalized)) fail(`symbol outside frozen universe: ${normalized}`);
  return normalized;
}

function optionalSt(payload) {
  return payload?.st ?? payload?.o?.st ?? null;
}

export function validateUmTransport(payload) {
  const st = optionalSt(payload);
  if (st !== null && Number(st) !== 1) {
    return Object.freeze({ accepted: false, reason: 'NON_UM_STREAM', st });
  }
  return Object.freeze({ accepted: true, reason: null, st });
}

export function parseCombinedWsMessage(message) {
  const value = typeof message === 'string' ? JSON.parse(message) : message;
  if (!value || typeof value !== 'object') fail('WebSocket message is not an object');
  if (Object.prototype.hasOwnProperty.call(value, 'stream') && Object.prototype.hasOwnProperty.call(value, 'data')) {
    return Object.freeze({ combined: true, stream: String(value.stream), data: value.data, raw: value });
  }
  return Object.freeze({ combined: false, stream: null, data: value, raw: value });
}

function levelList(payload, key, fallback) {
  const source = payload[key] ?? payload[fallback];
  if (!Array.isArray(source)) fail(`${key} is missing`);
  return source.map((level, index) => {
    if (!Array.isArray(level) || level.length < 2) fail(`${key}[${index}] is invalid`);
    return [finite(`${key}[${index}] price`, level[0], { minimum: Number.MIN_VALUE }), finite(`${key}[${index}] quantity`, level[1], { minimum: 0 })];
  });
}

function ensureStreamSymbol(payload, nested = null) {
  return symbol(payload?.s ?? nested?.s);
}

export function normalizeAggTradeRpi(payload) {
  const transport = validateUmTransport(payload);
  if (!transport.accepted) return Object.freeze({ ...transport, rawPayload: payload });
  const normalizedSymbol = ensureStreamSymbol(payload);
  const aggregateTradeId = integer('aggregate trade id', payload.a);
  const price = finite('aggregate trade price', payload.p, { minimum: Number.MIN_VALUE });
  const totalQuantity = finite('aggregate trade quantity', payload.q, { minimum: Number.MIN_VALUE });
  const normalQuantity = payload.nq == null ? null : finite('normal aggregate trade quantity', payload.nq, { minimum: 0 });
  const eventTime = integer('aggregate trade event time', payload.T ?? payload.E);
  if (typeof payload.m !== 'boolean') fail('aggregate trade maker flag is invalid');
  const aggressorSide = payload.m ? 'SELL' : 'BUY';
  const totalAggressorNotional = price * totalQuantity;
  const visibleBookComparableAggressorNotional = normalQuantity === null ? null : price * normalQuantity;
  return Object.freeze({
    accepted: true,
    symbol: normalizedSymbol,
    aggregateTradeId,
    price,
    totalQuantity,
    normalQuantity,
    totalAggressorNotional,
    visibleBookComparableAggressorNotional,
    aggressorSide,
    signedVolume: aggressorSide === 'BUY' ? totalAggressorNotional : -totalAggressorNotional,
    flowSemantics: Object.freeze({ totalFlow: 'TOTAL_FLOW', bookComparableFlow: 'VISIBLE_BOOK_COMPARABLE_FLOW' }),
    eventTime,
    st: transport.st,
    ps: payload.ps ?? null,
    rawPayload: payload
  });
}

export function parseRuntimeBookTicker(payload) {
  const transport = validateUmTransport(payload);
  if (!transport.accepted) return Object.freeze({ ...transport, rawPayload: payload });
  const normalizedSymbol = ensureStreamSymbol(payload);
  const bidPrice = finite('book ticker bid price', payload.b, { minimum: Number.MIN_VALUE });
  const askPrice = finite('book ticker ask price', payload.a, { minimum: Number.MIN_VALUE });
  if (bidPrice >= askPrice) fail('book ticker is crossed or locked');
  return Object.freeze({
    accepted: true,
    symbol: normalizedSymbol,
    updateId: integer('book ticker update id', payload.u),
    bidPrice,
    askPrice,
    bidQuantity: finite('book ticker bid quantity', payload.B, { minimum: 0 }),
    askQuantity: finite('book ticker ask quantity', payload.A, { minimum: 0 }),
    eventTime: integer('book ticker event time', payload.E ?? payload.T),
    st: transport.st,
    ps: payload.ps ?? null,
    rawPayload: payload
  });
}

export function parseRuntimeDepth20(payload) {
  const transport = validateUmTransport(payload);
  if (!transport.accepted) return Object.freeze({ ...transport, rawPayload: payload });
  const normalizedSymbol = ensureStreamSymbol(payload);
  const bids = levelList(payload, 'bids', 'b');
  const asks = levelList(payload, 'asks', 'a');
  if (bids.length > 20 || asks.length > 20) fail('depth20 exceeds 20 levels');
  return Object.freeze({
    accepted: true,
    symbol: normalizedSymbol,
    updateId: integer('depth20 update id', payload.lastUpdateId ?? payload.u),
    bids,
    asks,
    eventTime: integer('depth20 event time', payload.E ?? payload.T),
    st: transport.st,
    ps: payload.ps ?? null,
    rawPayload: payload
  });
}

export function parseRuntimeDepthDiff(payload) {
  const transport = validateUmTransport(payload);
  if (!transport.accepted) return Object.freeze({ ...transport, rawPayload: payload });
  const normalizedSymbol = ensureStreamSymbol(payload);
  const U = integer('depth first update id', payload.U);
  const u = integer('depth final update id', payload.u);
  if (U > u) fail('depth update range is reversed');
  const pu = payload.pu == null ? null : integer('depth previous update id', payload.pu);
  return Object.freeze({
    accepted: true,
    symbol: normalizedSymbol,
    U,
    u,
    pu,
    bids: levelList(payload, 'bids', 'b'),
    asks: levelList(payload, 'asks', 'a'),
    eventTime: integer('depth event time', payload.E ?? payload.T),
    st: transport.st,
    ps: payload.ps ?? null,
    rawPayload: payload
  });
}

export function parseMarkPrice(payload) {
  const transport = validateUmTransport(payload);
  if (!transport.accepted) return Object.freeze({ ...transport, rawPayload: payload });
  const normalizedSymbol = ensureStreamSymbol(payload);
  const optionalNumber = (name, value) => value == null ? null : finite(name, value);
  return Object.freeze({
    accepted: true,
    eventTime: integer('mark price event time', payload.E),
    symbol: normalizedSymbol,
    markPrice: finite('mark price', payload.p, { minimum: Number.MIN_VALUE }),
    indexPrice: finite('index price', payload.i, { minimum: Number.MIN_VALUE }),
    estimatedSettlePrice: optionalNumber('estimated settle price', payload.P),
    fundingRate: optionalNumber('funding rate', payload.r),
    markPriceMovingAverage: optionalNumber('mark price moving average', payload.markPriceMovingAverage ?? payload.movingAverage ?? payload.MA),
    nextFundingTime: payload.T == null ? null : integer('next funding time', payload.T),
    st: transport.st,
    ps: payload.ps ?? null,
    rawPayload: payload
  });
}

export function parseForceOrder(payload) {
  const order = payload?.o;
  if (!order || typeof order !== 'object') fail('force order payload is missing order object');
  const transport = validateUmTransport(payload);
  if (!transport.accepted) return Object.freeze({ ...transport, rawPayload: payload });
  const normalizedSymbol = ensureStreamSymbol(payload, order);
  const optionalNumber = (name, value) => value == null ? null : finite(name, value, { minimum: 0 });
  const requiredText = (name, value) => {
    const text = String(value ?? '');
    if (!text) fail(`${name} is missing`);
    return text;
  };
  return Object.freeze({
    accepted: true,
    eventTime: integer('force order event time', payload.E),
    symbol: normalizedSymbol,
    side: requiredText('force order side', order.S),
    orderType: requiredText('force order type', order.o),
    timeInForce: requiredText('force order time in force', order.f),
    originalQty: finite('force order original quantity', order.q, { minimum: 0 }),
    price: optionalNumber('force order price', order.p),
    averagePrice: optionalNumber('force order average price', order.ap),
    status: requiredText('force order status', order.X),
    lastFilledQty: finite('force order last filled quantity', order.l, { minimum: 0 }),
    accumulatedFilledQty: finite('force order accumulated filled quantity', order.z, { minimum: 0 }),
    tradeTime: integer('force order trade time', order.T),
    st: transport.st,
    ps: payload.ps ?? null,
    rawPayload: payload
  });
}

function cloneLevels(levels) {
  return levels.map(([price, quantity], index) => [
    finite(`snapshot level ${index} price`, price, { minimum: Number.MIN_VALUE }),
    finite(`snapshot level ${index} quantity`, quantity, { minimum: 0 })
  ]);
}

function bestBid(book) {
  return Math.max(...book.bids.keys());
}

function bestAsk(book) {
  return Math.min(...book.asks.keys());
}

function assertBookNotCrossed(book) {
  if (!book.bids.size || !book.asks.size) return;
  if (bestBid(book) >= bestAsk(book)) fail('CROSSED_BOOK');
}

function applyLevels(book, side, levels) {
  const target = book[side];
  for (const [price, quantity] of levels) {
    if (quantity === 0) target.delete(price);
    else target.set(price, quantity);
  }
}

function applyUpdate(book, update) {
  applyLevels(book, 'bids', update.bids);
  applyLevels(book, 'asks', update.asks);
  assertBookNotCrossed(book);
}

function createEmptyBook(snapshot) {
  const book = { bids: new Map(), asks: new Map() };
  applyLevels(book, 'bids', snapshot.bids ?? []);
  applyLevels(book, 'asks', snapshot.asks ?? []);
  assertBookNotCrossed(book);
  return book;
}

export function createPerSymbolDepthBook({ symbol: inputSymbol, maxBufferedEvents = 20_000 } = {}) {
  const normalizedSymbol = symbol(inputSymbol);
  integer('maxBufferedEvents', maxBufferedEvents, { minimum: 1 });
  const state = {
    symbol: normalizedSymbol,
    status: 'WAITING_SNAPSHOT',
    buffer: [],
    book: null,
    lastUpdateId: null,
    snapshotAttempts: 0,
    snapshotRequests: 0,
    successfulSnapshots: 0,
    rateLimitedSnapshots: 0,
    staleBufferedDropped: 0,
    alignmentFailures: 0,
    sequenceGaps: 0,
    duplicates: 0,
    outOfOrder: 0,
    crossedBooks: 0,
    bufferLimitFailures: 0,
    resyncs: 0,
    resyncCount: 0,
    invalidSegments: 0,
    firstAppliedUpdateId: null,
    finalAppliedUpdateId: null,
    lastValidAt: null,
    validDurationMs: 0,
    validSince: null,
    segmentId: 0,
    staleRanges: [],
    bufferedEventsPeak: 0,
    pendingSnapshot: null,
    bridgeWaitSince: null,
    retainedSnapshotWaits: 0,
    bridgeWaitSuccess: 0,
    bridgeTimeout: 0,
    snapshotTooOld: 0
  };

  function invalidate(reason, now = null) {
    if (state.status === 'ALIGNED' && state.validSince !== null && now !== null) {
      state.validDurationMs += Math.max(0, now - state.validSince);
    }
    if (reason === 'CROSSED_BOOK') state.crossedBooks += 1;
    if (reason === 'SEQUENCE_GAP') state.sequenceGaps += 1;
    if (reason === 'DUPLICATE_DEPTH_UPDATE') state.duplicates += 1;
    if (reason === 'OUT_OF_ORDER_DEPTH_UPDATE') state.outOfOrder += 1;
    if (reason === 'BUFFER_LIMIT_FAILURE') state.bufferLimitFailures += 1;
    if (reason === 'SNAPSHOT_ALIGNMENT_FAILED') state.alignmentFailures += 1;
    state.invalidSegments += 1;
    state.status = 'WAITING_SNAPSHOT';
    state.book = null;
    state.lastUpdateId = null;
    state.firstAppliedUpdateId = null;
    state.finalAppliedUpdateId = null;
    state.validSince = null;
    state.pendingSnapshot = null;
    state.bridgeWaitSince = null;
    state.segmentId += 1;
    return Object.freeze({ ok: false, reason, resyncRequired: true, segmentId: state.segmentId });
  }

  function recordStale(stale) {
    if (!stale.length) return;
    state.staleBufferedDropped += stale.length;
    state.staleRanges.push([stale[0].U, stale.at(-1).u]);
  }

  function waitForBridge(snapshot, now) {
    state.pendingSnapshot = Object.freeze({
      lastUpdateId: snapshot.lastUpdateId,
      bids: cloneLevels(snapshot.bids ?? []),
      asks: cloneLevels(snapshot.asks ?? [])
    });
    state.status = 'WAITING_FOR_BRIDGE';
    state.bridgeWaitSince ??= now;
    state.retainedSnapshotWaits += 1;
    return Object.freeze({ ok: false, reason: 'SNAPSHOT_AHEAD_WAITING_BRIDGE', waitingForBridge: true, snapshotTooOld: false });
  }

  function replaySnapshot(snapshot, now) {
    const snapshotLastUpdateId = integer('snapshotLastUpdateId', snapshot.lastUpdateId);
    const stale = state.buffer.filter(update => update.u < snapshotLastUpdateId);
    const applicable = state.buffer.filter(update => update.u >= snapshotLastUpdateId);
    const firstIndex = applicable.findIndex(update => update.U <= snapshotLastUpdateId && snapshotLastUpdateId <= update.u);
    if (firstIndex < 0) return waitForBridge(snapshot, now);
    let book;
    try {
      book = createEmptyBook(snapshot);
      const first = applicable[firstIndex];
      applyUpdate(book, first);
      let previous = first;
      for (const current of applicable.slice(firstIndex + 1)) {
        if (current.u === previous.u) return invalidate('DUPLICATE_DEPTH_UPDATE', now);
        if (current.u < previous.u) return invalidate('OUT_OF_ORDER_DEPTH_UPDATE', now);
        if (current.pu !== previous.u) return invalidate('SEQUENCE_GAP', now);
        applyUpdate(book, current);
        previous = current;
      }
      const bridgeWaited = state.bridgeWaitSince !== null;
      state.book = book;
      state.lastUpdateId = previous.u;
      state.firstAppliedUpdateId = first.U;
      state.finalAppliedUpdateId = previous.u;
      recordStale(stale);
      state.buffer = [];
      state.pendingSnapshot = null;
      if (bridgeWaited) state.bridgeWaitSuccess += 1;
      state.bridgeWaitSince = null;
      state.status = 'ALIGNED';
      state.validSince = now;
      state.lastValidAt = now;
      return Object.freeze({ ok: true, aligned: true, bridgeWaitSuccess: bridgeWaited, staleDropped: stale.length, firstAppliedUpdateId: first.U, finalAppliedUpdateId: previous.u });
    } catch (error) {
      return invalidate(error.message === 'CROSSED_BOOK' ? 'CROSSED_BOOK' : 'INVALID_DEPTH_REPLAY', now);
    }
  }

  function buffer(update) {
    if (state.status === 'ALIGNED') return applyLive(update);
    if (state.buffer.length >= maxBufferedEvents) return invalidate('BUFFER_LIMIT_FAILURE');
    state.buffer.push(update);
    state.bufferedEventsPeak = Math.max(state.bufferedEventsPeak, state.buffer.length);
    if (state.pendingSnapshot) return replaySnapshot(state.pendingSnapshot, update.eventTime ?? null);
    if (state.status !== 'WAITING_FOR_BRIDGE') state.status = 'ALIGNING';
    return Object.freeze({ ok: true, buffered: true, bufferLength: state.buffer.length });
  }

  function applyLive(update, now = null) {
    if (state.status !== 'ALIGNED' || !state.book) return buffer(update);
    if (update.u === state.lastUpdateId) return invalidate('DUPLICATE_DEPTH_UPDATE', now);
    if (update.u < state.lastUpdateId) return invalidate('OUT_OF_ORDER_DEPTH_UPDATE', now);
    if (update.pu !== state.lastUpdateId) return invalidate('SEQUENCE_GAP', now);
    try {
      applyUpdate(state.book, update);
    } catch (error) {
      return invalidate(error.message === 'CROSSED_BOOK' ? 'CROSSED_BOOK' : 'INVALID_DEPTH_UPDATE', now);
    }
    state.lastUpdateId = update.u;
    state.finalAppliedUpdateId = update.u;
    state.lastValidAt = now;
    return Object.freeze({ ok: true, applied: true, updateId: update.u });
  }

  function align(snapshot, now = null) {
    state.snapshotAttempts += 1;
    const snapshotLastUpdateId = integer('snapshotLastUpdateId', snapshot.lastUpdateId);
    state.pendingSnapshot = null;
    state.bridgeWaitSince = null;
    if (!state.buffer.length) return waitForBridge(snapshot, now);
    const firstBufferedU = Math.min(...state.buffer.map(update => update.U));
    const lastBufferedU = Math.max(...state.buffer.map(update => update.u));
    if (snapshotLastUpdateId < firstBufferedU) {
      state.status = 'ALIGNING';
      state.snapshotTooOld += 1;
      return Object.freeze({ ok: false, reason: 'SNAPSHOT_TOO_OLD', snapshotTooOld: true, staleDropped: 0 });
    }
    if (snapshotLastUpdateId > lastBufferedU) return waitForBridge(snapshot, now);
    return replaySnapshot(snapshot, now);
  }

  function checkBridgeTimeout(now, maxWaitMs) {
    if (state.status !== 'WAITING_FOR_BRIDGE' || state.bridgeWaitSince === null) return Object.freeze({ timedOut: false });
    if (now - state.bridgeWaitSince < maxWaitMs) return Object.freeze({ timedOut: false });
    state.bridgeTimeout += 1;
    state.pendingSnapshot = null;
    state.bridgeWaitSince = null;
    state.status = 'ALIGNING';
    return Object.freeze({ timedOut: true, reason: 'BRIDGE_TIMEOUT' });
  }

  function resetForResync(reason, now = null) {
    state.resyncs += 1;
    state.resyncCount += 1;
    state.buffer = [];
    return invalidate(reason, now);
  }

  function diagnostics(now = null) {
    const { buffer: _buffer, book: _book, pendingSnapshot: _pendingSnapshot, ...diagnosticState } = state;
    if (state.status === 'ALIGNED' && state.validSince !== null && now !== null) {
      return Object.freeze({
        ...diagnosticState,
        validDurationMs: state.validDurationMs + Math.max(0, now - state.validSince),
        bufferedEvents: state.buffer.length,
        bufferedEventsPeak: state.bufferedEventsPeak
      });
    }
    return Object.freeze({ ...diagnosticState, bufferedEvents: state.buffer.length, bufferedEventsPeak: state.bufferedEventsPeak });
  }

  return Object.freeze({
    get status() { return state.status; },
    get bufferedEvents() { return state.buffer.length; },
    buffer,
    applyLive,
    align,
    invalidate,
    resetForResync,
    checkBridgeTimeout,
    diagnostics,
    snapshot() {
      return Object.freeze({
        status: state.status,
        symbol: state.symbol,
        lastUpdateId: state.lastUpdateId,
        book: state.book ? { bids: [...state.book.bids], asks: [...state.book.asks] } : null
      });
    }
  });
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function safeFilePart(value) {
  return String(value).replaceAll(/[^A-Za-z0-9_.-]/g, '_');
}

async function sha256File(filePath) {
  const hash = createHash('sha256');
  const contents = await fs.readFile(filePath);
  hash.update(contents);
  return hash.digest('hex');
}

function partitionHour(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 13).replace('T', '/');
}

export function createDurableRawPartitionStore({ rootDir, runId, schemaVersion = 1 } = {}) {
  if (!rootDir) fail('raw partition rootDir is required');
  if (!runId) fail('raw partition runId is required');
  const partitions = new Map();
  let sealed = false;
  let rawWriteFailures = 0;

  async function getPartition(record) {
    const hour = partitionHour(record.exchangeEventTime);
    const key = `${hour}/${record.symbol}/${record.stream}/${record.connectionId ?? 'no-connection'}`;
    if (partitions.has(key)) return partitions.get(key);
    const relative = path.join(hour, safeFilePart(record.symbol), safeFilePart(record.stream), `${safeFilePart(record.connectionId ?? 'no-connection')}.jsonl.gz`);
    const finalPath = path.join(rootDir, relative);
    const tempPath = `${finalPath}.${safeFilePart(runId)}.part`;
    await fs.mkdir(path.dirname(finalPath), { recursive: true });
    const gzip = (await import('node:zlib')).createGzip({ level: 6 });
    const output = createWriteStream(tempPath, { flags: 'wx' });
    gzip.pipe(output);
    const partition = {
      key,
      relativePath: relative.replaceAll('\\', '/'),
      finalPath,
      tempPath,
      gzip,
      output,
      rows: 0,
      bytes: 0,
      firstEventTime: null,
      lastEventTime: null,
      firstReceiveTime: null,
      lastReceiveTime: null,
      symbol: record.symbol,
      stream: record.stream,
      connectionIds: new Set([record.connectionId ?? null])
    };
    output.on('error', error => { partition.error = error; });
    gzip.on('error', error => { partition.error = error; });
    partitions.set(key, partition);
    return partition;
  }

  async function append(record) {
    if (sealed) fail('RAW_PARTITION_STORE_SEALED');
    try {
      const partition = await getPartition(record);
      if (partition.error) throw partition.error;
      const line = `${JSON.stringify(record)}\n`;
      partition.bytes += Buffer.byteLength(line);
      partition.rows += 1;
      partition.firstEventTime ??= record.exchangeEventTime;
      partition.lastEventTime = record.exchangeEventTime;
      partition.firstReceiveTime ??= record.localReceiveTime;
      partition.lastReceiveTime = record.localReceiveTime;
      partition.connectionIds.add(record.connectionId ?? null);
      if (!partition.gzip.write(line)) await once(partition.gzip, 'drain');
      if (partition.error) throw partition.error;
      return Object.freeze({ path: partition.relativePath, rowCount: partition.rows, rawBytes: partition.bytes });
    } catch (error) {
      rawWriteFailures += 1;
      throw new Error(`RAW_DURABILITY_FAILURE: ${error.message}`);
    }
  }

  async function seal() {
    if (sealed) return Object.freeze([]);
    sealed = true;
    const sealedPartitions = [];
    for (const partition of partitions.values()) {
      partition.gzip.end();
      await once(partition.output, 'finish');
      if (partition.error) throw new Error(`RAW_DURABILITY_FAILURE: ${partition.error.message}`);
      const handle = await fs.open(partition.tempPath, 'r+');
      try { await handle.sync(); } finally { await handle.close(); }
      try {
        await fs.stat(partition.finalPath);
        throw new Error('RAW_PARTITION_ALREADY_SEALED');
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      await fs.rename(partition.tempPath, partition.finalPath);
      const stat = await fs.stat(partition.finalPath);
      sealedPartitions.push(Object.freeze({
        path: partition.relativePath,
        sha256: await sha256File(partition.finalPath),
        rows: partition.rows,
        bytes: stat.size,
        uncompressedBytes: partition.bytes,
        firstEventTime: partition.firstEventTime,
        lastEventTime: partition.lastEventTime,
        firstReceiveTime: partition.firstReceiveTime,
        lastReceiveTime: partition.lastReceiveTime,
        symbol: partition.symbol,
        stream: partition.stream,
        connectionIds: [...partition.connectionIds].sort(),
        schemaVersion
      }));
    }
    sealedPartitions.sort((left, right) => left.path.localeCompare(right.path));
    const body = {
      schemaVersion,
      immutable: true,
      datasetId: HY_DATA_0036_ID,
      runId,
      rootType: 'ENGINEERING_DRY_RUN_ONLY',
      files: sealedPartitions
    };
    const manifest = Object.freeze({ ...body, manifestSha256: createHash('sha256').update(stableJson(body)).digest('hex') });
    await fs.mkdir(rootDir, { recursive: true });
    await fs.writeFile(path.join(rootDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    await fs.writeFile(path.join(rootDir, 'manifest.ndjson'), `${JSON.stringify({ ...manifest, appendedAt: Date.now() })}\n`, { flag: 'wx' });
    return manifest;
  }

  return Object.freeze({
    append,
    seal,
    get sealed() { return sealed; },
    get rawWriteFailures() { return rawWriteFailures; },
    get partitionCount() { return partitions.size; }
  });
}

export function verifyRawPartitionManifest(manifest) {
  if (!manifest || manifest.immutable !== true || manifest.datasetId !== HY_DATA_0036_ID) return false;
  const { manifestSha256, ...body } = manifest;
  return /^[a-f0-9]{64}$/.test(manifestSha256) && createHash('sha256').update(stableJson(body)).digest('hex') === manifestSha256;
}

export async function verifyRawPartitionFiles(manifest, { rootDir } = {}) {
  if (!rootDir || !verifyRawPartitionManifest(manifest) || !Array.isArray(manifest.files)) return false;
  const root = path.resolve(rootDir);
  for (const file of manifest.files) {
    if (!file || typeof file.path !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) return false;
    const absolute = path.resolve(root, file.path);
    const relative = path.relative(root, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
    try {
      if ((await fs.stat(absolute)).isDirectory()) return false;
      if (await sha256File(absolute) !== file.sha256) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function createBoundedAsyncQueue({ maxSize = 50_000, onOverflow = () => {} } = {}) {
  integer('maxSize', maxSize, { minimum: 1 });
  const pending = [];
  let running = false;
  let stopped = false;
  let peak = 0;
  let worker = Promise.resolve();

  async function drainWorker() {
    if (running) return worker;
    running = true;
    worker = (async () => {
      while (pending.length && !stopped) {
        const task = pending.shift();
        await task();
      }
      running = false;
    })();
    await worker;
    return worker;
  }

  function push(task) {
    if (stopped) return Promise.reject(new Error('QUEUE_STOPPED'));
    if (pending.length >= maxSize) {
      onOverflow(pending.length);
      return Promise.reject(new Error('BACKPRESSURE_LIMIT_FAILURE'));
    }
    let resolve;
    let reject;
    const completion = new Promise((res, rej) => { resolve = res; reject = rej; });
    pending.push(async () => {
      try { resolve(await task()); } catch (error) { reject(error); }
    });
    peak = Math.max(peak, pending.length);
    void drainWorker();
    return completion;
  }

  function stop() { stopped = true; pending.length = 0; }

  return Object.freeze({ push, drain: () => drainWorker(), stop, get size() { return pending.length; }, get peak() { return peak; } });
}

function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index];
}

function addLatency(bucket, value) {
  if (bucket.length < 10_000) bucket.push(value);
  else bucket[Math.floor(Math.random() * bucket.length)] = value;
}

function makeStreamStats() {
  return Object.fromEntries([...ALL_STREAM_IDS].map(stream => [stream, {
    eventCount: 0,
    rawBytes: 0,
    firstEventTime: null,
    lastEventTime: null,
    firstReceiveTime: null,
    lastReceiveTime: null,
    rejectedNonUm: 0,
    sequenceGaps: 0,
    duplicates: 0,
    outOfOrder: 0,
    invalidSegments: 0,
    latencySamples: []
  }]));
}

function defaultWebSocketFactory(url) {
  if (typeof WebSocket !== 'function') fail('WebSocket runtime is unavailable');
  return new WebSocket(url);
}

function addListener(socket, event, handler) {
  if (typeof socket.addEventListener === 'function') socket.addEventListener(event, handler);
  else socket[`on${event}`] = handler;
}

function sendSocket(socket, value) {
  const body = JSON.stringify(value);
  if (typeof socket.send !== 'function') fail('WebSocket send is unavailable');
  socket.send(body);
}

function createConnectionStats(kind, endpoint, connectionId, connectedAt) {
  return {
    kind,
    endpoint,
    connectionId,
    connectedAt,
    rotatedAt: null,
    disconnectedAt: null,
    disconnectReason: null,
    reconnectCount: 0,
    controlMessages: 0,
    subscriptionConfirmed: false,
    subscriptionConfirmedAt: null,
    socketHealthy: false,
    healthIntervals: [],
    pingSent: 0,
    pongObserved: 0
  };
}

export function createHyData0036Runtime(options = {}) {
  const {
    symbols = HY_DATA_0036_SYMBOLS,
    fetchImpl = globalThis.fetch,
    webSocketFactory = defaultWebSocketFactory,
    rawStore,
    rootDir = path.join(os.tmpdir(), 'hengyu-engineering', HY_DATA_0036_ID),
    runId = `engineering-${Date.now()}`,
    dryRun = false,
    durationMs = 60 * MINUTE_MS,
    controlledReconnectAfterMs = DEFAULT_CONTROLLED_RECONNECT_MS,
    now = () => Date.now(),
    logger = () => {},
    queueLimit = 50_000,
    maxBufferedEvents = 20_000,
    maxSnapshotAttempts = 5,
    maxConcurrentSnapshots = 2,
    snapshotRetryDelayMs = 250,
    maxSnapshotRecoveryMs = MAX_SNAPSHOT_RECOVERY_MS,
    snapshotRetryRandom = Math.random,
    snapshotSleep = defaultSleep,
    snapshotTimeoutMs = 10_000,
    bridgeWaitTimeoutMs = BRIDGE_WAIT_TIMEOUT_MS,
    restGovernor = null,
    hostNtpEvidenceImpl = readHostNtpEvidence,
    featureSink = null,
    remoteStorage = null,
    remoteStorageCapacityBytes = null,
    localSpoolHours = 72,
    noNetwork = false
  } = options;
  if (!dryRun) fail('formal HY-DATA-0036 collection is not enabled; use --dry-run');
  if (!Array.isArray(symbols) || !symbols.length || symbols.some(value => !HY_DATA_0036_SYMBOLS.includes(String(value).toUpperCase()))) fail('symbols must be a non-empty subset of the frozen eight');
  if (typeof fetchImpl !== 'function' && !noNetwork) fail('public fetch implementation is required');
  integer('durationMs', durationMs, { minimum: 1 });
  if (controlledReconnectAfterMs !== null) integer('controlledReconnectAfterMs', controlledReconnectAfterMs, { minimum: 1 });
  integer('maxSnapshotAttempts', maxSnapshotAttempts, { minimum: 1 });
  if (maxSnapshotAttempts > 5) fail('maxSnapshotAttempts exceeds frozen bound of 5');
  integer('maxConcurrentSnapshots', maxConcurrentSnapshots, { minimum: 1 });
  if (maxConcurrentSnapshots > 2) fail('maxConcurrentSnapshots exceeds frozen bound of 2');
  integer('snapshotRetryDelayMs', snapshotRetryDelayMs, { minimum: 1 });
  integer('maxSnapshotRecoveryMs', maxSnapshotRecoveryMs, { minimum: 1 });
  if (maxSnapshotRecoveryMs > MAX_SNAPSHOT_RECOVERY_MS) fail('maxSnapshotRecoveryMs exceeds frozen bound of 10 seconds');
  integer('maxBufferedEvents', maxBufferedEvents, { minimum: 1 });
  if (maxBufferedEvents > 20_000) fail('maxBufferedEvents exceeds frozen bound of 20000');
  integer('bridgeWaitTimeoutMs', bridgeWaitTimeoutMs, { minimum: 1 });
  if (durationMs >= MIN_CANARY_DURATION_MS) {
    if (controlledReconnectAfterMs === null) fail('controlled reconnect is required for a 60-minute canary');
    if (controlledReconnectAfterMs < MIN_CONTROLLED_RECONNECT_MS || controlledReconnectAfterMs > MAX_CONTROLLED_RECONNECT_MS) {
      fail('controlled reconnect must occur between 20 and 30 minutes for a 60-minute canary');
    }
  }
  if (typeof snapshotRetryRandom !== 'function') fail('snapshotRetryRandom must be a function');
  if (typeof snapshotSleep !== 'function') fail('snapshotSleep must be a function');

  const selectedSymbols = Object.freeze(symbols.map(value => String(value).toUpperCase()));
  const startedAt = now();
  const store = rawStore ?? createDurableRawPartitionStore({ rootDir, runId });
  const governor = restGovernor ?? (noNetwork ? null : createBinancePublicRestGovernor({ fetchImpl, now }));
  const featureStore = featureSink ?? createEngineeringFeatureStore({ rootDir: path.join(rootDir, 'features'), runId });
  const storageBackend = remoteStorage ?? createS3CompatibleSealedPartitionAdapter();
  const perSymbol = new Map(selectedSymbols.map(value => [value, {
    depth: createPerSymbolDepthBook({ symbol: value, maxBufferedEvents }),
    streams: makeStreamStats(),
    lastAggTradeId: null,
    aggTradeIntegrityFailure: false,
    snapshotAttempts: 0,
    snapshotTooOldRetries: 0,
    featureSeconds: new Set(),
    featureBuilder: createCausalFeatureBuilder({ symbol: value }),
    featureRows: 0
  }]));
  const connections = [];
  const sockets = new Map();
  const timers = new Set();
  const queue = createBoundedAsyncQueue({
    maxSize: queueLimit,
    onOverflow: () => {
      diagnostics.queueLimitFailures += 1;
      diagnostics.failures.push('BACKPRESSURE_LIMIT_FAILURE');
      stopRequested = true;
    }
  });
  const diagnostics = {
    queueLimitFailures: 0,
    rawDurabilityFailures: 0,
    bufferLimitFailures: 0,
    snapshotAlignmentFailures: 0,
    snapshotAttempts: 0,
    snapshotRequests: 0,
    successfulSnapshots: 0,
    rateLimitedSnapshots: 0,
    resyncs: 0,
    resyncCount: 0,
    controlledReconnects: 0,
    failures: [],
    runtimeErrors: [],
    eventCount: 0,
    rejectedNonUm: 0,
    featureTicks: 0,
    featureSinkWrites: 0,
    retainedSnapshotWaits: 0,
    bridgeWaitSuccess: 0,
    bridgeTimeout: 0,
    rateGovernorCooldownCount: 0,
    http429Count: 0,
    http418Count: 0,
    restRequestCount: 0,
    depthSnapshotRequestCount: 0,
    lateEventCount: 0,
    restRetryCount: 0,
    maxUsedWeight: null,
    retryAfterObserved: [],
    snapshotTooOld: 0,
    snapshotRecoveryTimeouts: 0,
    featureDurabilityFailures: 0,
    controlledReconnectVerified: false,
    freshSnapshotResyncVerified: false
  };
  let stopRequested = false;
  let stopped = false;
  let controlledReconnectDone = false;
  let clockEvidence = null;
  let rawManifest = null;
  let featureManifest = null;
  let remoteEvidence = null;
  let connectionSequence = 0;
  let alignmentPromise = null;
  const resyncPromises = new Map();
  let activeSnapshotRequests = 0;
  const waitingSnapshotRequests = [];
  const bridgeTimers = new Map();

  async function withSnapshotSlot(task) {
    if (activeSnapshotRequests >= maxConcurrentSnapshots) {
      await new Promise(resolve => waitingSnapshotRequests.push(resolve));
    }
    activeSnapshotRequests += 1;
    try {
      return await task();
    } finally {
      activeSnapshotRequests -= 1;
      waitingSnapshotRequests.shift()?.();
    }
  }

  function log(event, details = {}) {
    try { logger({ event, ...details }); } catch { /* diagnostics must not stop capture */ }
  }

  function syncRestDiagnostics() {
    if (!governor) return;
    const rest = governor.diagnostics;
    diagnostics.rateGovernorCooldownCount = rest.rateGovernorCooldownCount;
    diagnostics.http429Count = rest.http429Count;
    diagnostics.http418Count = rest.http418Count;
    diagnostics.restRequestCount = rest.requestCount;
    diagnostics.depthSnapshotRequestCount = rest.depthSnapshotRequestCount;
    diagnostics.restRetryCount = rest.retryCount;
    diagnostics.maxUsedWeight = rest.maxUsedWeight;
    diagnostics.retryAfterObserved = rest.retryAfterObserved;
  }

  function clearBridgeTimer(inputSymbol) {
    const timer = bridgeTimers.get(inputSymbol);
    if (timer) clearTimeout(timer);
    bridgeTimers.delete(inputSymbol);
  }

  function scheduleBridgeTimeout(inputSymbol) {
    if (bridgeTimers.has(inputSymbol)) return;
    const timer = setTimeout(() => {
      bridgeTimers.delete(inputSymbol);
      const state = perSymbol.get(inputSymbol);
      if (!state) return;
      const timeout = state.depth.checkBridgeTimeout(now(), bridgeWaitTimeoutMs);
      if (!timeout.timedOut) return;
      diagnostics.bridgeTimeout += 1;
      scheduleSnapshotResync(inputSymbol, 'BRIDGE_TIMEOUT');
    }, bridgeWaitTimeoutMs);
    timer.unref?.();
    bridgeTimers.set(inputSymbol, timer);
    timers.add(timer);
  }

  async function materializeFeatures(state, at) {
    const rows = state.featureBuilder.materializeAt(at);
    for (const row of rows) {
      await featureStore.append(row);
      state.featureRows += 1;
      diagnostics.featureSinkWrites += 1;
      diagnostics.featureTicks += 1;
    }
    diagnostics.lateEventCount = [...perSymbol.values()].reduce((sum, candidate) => sum + candidate.featureBuilder.diagnostics().lateEventCount, 0);
    return rows;
  }

  function updateFeatureBook(state, receivedAt) {
    const depth = state.depth.snapshot();
    state.featureBuilder.setDepthBook(depth.book, receivedAt, depth.status === 'ALIGNED');
  }

  function recordDepthResult(inputSymbol, result, receivedAt) {
    const state = perSymbol.get(inputSymbol);
    if (!state) return;
    if (result?.waitingForBridge) {
      diagnostics.retainedSnapshotWaits += 1;
      scheduleBridgeTimeout(inputSymbol);
    }
    if (result?.bridgeWaitSuccess) diagnostics.bridgeWaitSuccess += 1;
    if (result?.aligned) {
      clearBridgeTimer(inputSymbol);
      updateFeatureBook(state, receivedAt);
    } else if (state.depth.status !== 'ALIGNED') updateFeatureBook(state, receivedAt);
  }

  function streamStats(symbolValue, streamId) {
    return perSymbol.get(symbolValue)?.streams[streamId];
  }

  function markHealth(connection, healthy, at) {
    if (connection.socketHealthy === healthy) return;
    if (connection.socketHealthy && connection.healthIntervals.at(-1)?.end === null) connection.healthIntervals.at(-1).end = at;
    connection.socketHealthy = healthy;
    if (healthy) connection.healthIntervals.push({ start: at, end: null });
  }

  function createRawRecord({ stream, payload, receivedAt, connection }) {
    const eventTime = Number(payload.E ?? payload.T ?? payload.o?.T ?? receivedAt);
    const tradeTime = payload.T ?? payload.o?.T ?? null;
    const payloadSymbol = String(payload.s ?? payload.o?.s ?? '').toUpperCase();
    return {
      source: 'binance-public-usdm',
      stream,
      symbol: payloadSymbol,
      exchangeEventTime: Number.isSafeInteger(eventTime) ? eventTime : receivedAt,
      tradeTime: tradeTime == null ? null : Number(tradeTime),
      localReceiveTime: receivedAt,
      receivedAt,
      requestStartedAt: null,
      sequence: payload.U ?? payload.u ?? payload.a ?? payload.lastUpdateId ?? payload.u ?? 0,
      st: payload.st ?? payload.o?.st ?? null,
      ps: payload.ps ?? null,
      rawPayload: payload,
      schemaVersion: 1,
      connectionId: connection?.connectionId ?? null
    };
  }

  async function appendRaw(record) {
    try {
      await store.append(record);
    } catch (error) {
      diagnostics.rawDurabilityFailures += 1;
      diagnostics.failures.push('RAW_DURABILITY_FAILURE');
      stopRequested = true;
      throw error;
    }
  }

  function resolveStream(wrapperStream, payload) {
    const stream = String(wrapperStream ?? '').toLowerCase();
    if (stream.includes('@aggtrade')) return 'aggTrade';
    if (stream.includes('@bookticker')) return 'bookTicker';
    if (stream.includes('@depth20')) return 'depth20';
    if (stream.includes('@depth@')) return 'depth.diff';
    if (stream.includes('@markprice@1s')) return 'markPrice';
    if (stream.includes('@forceorder')) return 'forceOrder';
    if (payload?.e === 'aggTrade') return 'aggTrade';
    if (payload?.e === 'markPriceUpdate') return 'markPrice';
    if (payload?.e === 'forceOrder') return 'forceOrder';
    return null;
  }

  function updateCommonStats(streamId, normalizedSymbol, payload, receivedAt) {
    const stats = streamStats(normalizedSymbol, streamId);
    if (!stats) return;
    stats.eventCount += 1;
    const eventTime = Number(payload.E ?? payload.T ?? payload.o?.T ?? receivedAt);
    if (Number.isSafeInteger(eventTime)) {
      stats.firstEventTime ??= eventTime;
      stats.lastEventTime = eventTime;
      stats.firstReceiveTime ??= receivedAt;
      stats.lastReceiveTime = receivedAt;
      addLatency(stats.latencySamples, receivedAt - eventTime);
    }
  }

  async function processMarketEvent(streamId, payload, receivedAt, connection) {
    const transport = validateUmTransport(payload);
    const candidateSymbol = String(payload.s ?? payload.o?.s ?? '').toUpperCase();
    const stats = perSymbol.get(candidateSymbol)?.streams[streamId];
    if (!transport.accepted) {
      diagnostics.rejectedNonUm += 1;
      if (stats) stats.rejectedNonUm += 1;
      return;
    }
    if (!perSymbol.has(candidateSymbol)) return;
    let normalized;
    if (streamId === 'aggTrade') normalized = normalizeAggTradeRpi(payload);
    else if (streamId === 'markPrice') normalized = parseMarkPrice(payload);
    else normalized = parseForceOrder(payload);
    updateCommonStats(streamId, candidateSymbol, payload, receivedAt);
    if (streamId === 'aggTrade') {
      const state = perSymbol.get(candidateSymbol);
      if (state.lastAggTradeId !== null) {
        if (normalized.aggregateTradeId === state.lastAggTradeId) {
          state.aggTradeIntegrityFailure = true;
          stats.duplicates += 1;
        } else if (normalized.aggregateTradeId < state.lastAggTradeId) {
          state.aggTradeIntegrityFailure = true;
          stats.outOfOrder += 1;
        } else if (normalized.aggregateTradeId > state.lastAggTradeId + 1) {
          state.aggTradeIntegrityFailure = true;
          stats.sequenceGaps += 1;
        }
      }
      state.lastAggTradeId = normalized.aggregateTradeId;
    }
    const state = perSymbol.get(candidateSymbol);
    state.featureBuilder.ingest(streamId, normalized, receivedAt);
    state.featureSeconds.add(Math.floor(normalized.eventTime / 1000) * 1000);
    await materializeFeatures(state, receivedAt);
  }

  async function processPublicEvent(streamId, payload, receivedAt, connection) {
    const transport = validateUmTransport(payload);
    const candidateSymbol = String(payload.s ?? '').toUpperCase();
    const stats = perSymbol.get(candidateSymbol)?.streams[streamId];
    if (!transport.accepted) {
      diagnostics.rejectedNonUm += 1;
      if (stats) stats.rejectedNonUm += 1;
      return;
    }
    if (!perSymbol.has(candidateSymbol)) return;
    let normalized;
    if (streamId === 'bookTicker') normalized = parseRuntimeBookTicker(payload);
    else if (streamId === 'depth20') normalized = parseRuntimeDepth20(payload);
    else normalized = parseRuntimeDepthDiff(payload);
    updateCommonStats(streamId, candidateSymbol, payload, receivedAt);
    const state = perSymbol.get(candidateSymbol);
    if (streamId === 'depth.diff') {
      const result = state.depth.status === 'ALIGNED'
        ? state.depth.applyLive(normalized, receivedAt)
        : state.depth.buffer(normalized);
      if (result.reason === 'SEQUENCE_GAP') stats.sequenceGaps += 1;
      if (result.reason === 'DUPLICATE_DEPTH_UPDATE') stats.duplicates += 1;
      if (result.reason === 'OUT_OF_ORDER_DEPTH_UPDATE') stats.outOfOrder += 1;
      if (result.reason === 'BUFFER_LIMIT_FAILURE') diagnostics.bufferLimitFailures += 1;
      if (result.reason) {
        stats.invalidSegments += 1;
        if (result.reason !== 'BUFFER_LIMIT_FAILURE') scheduleSnapshotResync(candidateSymbol, result.reason);
      }
      recordDepthResult(candidateSymbol, result, receivedAt);
    }
    state.featureBuilder.ingest(streamId, normalized, receivedAt);
    state.featureSeconds.add(Math.floor(normalized.eventTime / 1000) * 1000);
    await materializeFeatures(state, receivedAt);
  }

  async function processMessage(message, connection, receivedAt = now()) {
    const wrapper = parseCombinedWsMessage(message);
    if (wrapper.data && Object.prototype.hasOwnProperty.call(wrapper.data, 'result') && Object.prototype.hasOwnProperty.call(wrapper.data, 'id')) {
      connection.controlMessages += 1;
      if (wrapper.data.result === null) {
        connection.subscriptionConfirmed = true;
        connection.subscriptionConfirmedAt = receivedAt;
        markHealth(connection, true, receivedAt);
        if (connection.kind === 'public' && connection.reconnectCount > 0 && !alignmentPromise) void alignAllSnapshots();
      }
      return;
    }
    const streamId = resolveStream(wrapper.stream, wrapper.data);
    if (!streamId || !STREAM_IDS.has(streamId)) return;
    const payload = wrapper.data;
    const raw = createRawRecord({ stream: streamId, payload, receivedAt, connection });
    diagnostics.eventCount += 1;
    await appendRaw(raw);
    try {
      if (MARKET_STREAM_IDS.has(streamId)) await processMarketEvent(streamId, payload, receivedAt, connection);
      else await processPublicEvent(streamId, payload, receivedAt, connection);
    } catch (error) {
      const candidateSymbol = String(payload.s ?? payload.o?.s ?? '').toUpperCase();
      const stats = perSymbol.get(candidateSymbol)?.streams[streamId];
      if (stats) stats.invalidSegments += 1;
      diagnostics.runtimeErrors.push({ stream: streamId, error: error.message });
      log('PARSE_OR_SEQUENCE_FAILURE', { stream: streamId, error: error.message });
      if (error.message.includes('FEATURE_')) {
        diagnostics.featureDurabilityFailures += 1;
        diagnostics.failures.push('FEATURE_DURABILITY_FAILURE');
        stopRequested = true;
      }
      if (streamId === 'depth.diff' && perSymbol.has(candidateSymbol)) {
        perSymbol.get(candidateSymbol).depth.invalidate(error.message, receivedAt);
        scheduleSnapshotResync(candidateSymbol, error.message);
      }
    }
  }

  function createSubscription(kind) {
    const streams = STREAMS.filter(stream => stream.endpoint === kind);
    const params = [];
    for (const inputSymbol of selectedSymbols) {
      for (const stream of streams) {
        if (stream.id === 'markPrice' || stream.id === 'forceOrder') params.push(getHyData0036Sup001Subscription(stream.id, inputSymbol));
        else params.push(stream.subscription.replace('<symbol>', inputSymbol.toLowerCase()));
      }
    }
    return params;
  }

  function resetDepthForConnection(reason, at) {
    for (const state of perSymbol.values()) {
      state.depth.resetForResync(reason, at);
      diagnostics.resyncs += 1;
      diagnostics.resyncCount += 1;
    }
  }

  function openConnection(kind, reconnectCount = 0) {
    const endpoint = kind === 'public' ? HY_DATA_0036_ENDPOINTS.publicWebSocket : HY_DATA_0036_ENDPOINTS.marketWebSocket;
    const connectedAt = now();
    const connectionId = `${runId}-${kind}-${++connectionSequence}`;
    const connection = createConnectionStats(kind, endpoint, connectionId, connectedAt);
    connection.reconnectCount = reconnectCount;
    if (controlledReconnectDone && reconnectCount > 0) diagnostics.controlledReconnectVerified = true;
    connections.push(connection);
    let socket;
    try {
      socket = webSocketFactory(endpoint);
    } catch (error) {
      connection.disconnectReason = 'CONNECT_FAILURE';
      diagnostics.runtimeErrors.push({ stage: 'CONNECT', kind, error: error.message });
      stopRequested = true;
      return connection;
    }
    sockets.set(kind, { socket, connection, reconnectCount });
    addListener(socket, 'open', () => {
      markHealth(connection, false, now());
      const params = createSubscription(kind);
      if (params.length > 100) {
        connection.disconnectReason = 'SUBSCRIPTION_LIMIT_FAILURE';
        diagnostics.failures.push('SUBSCRIPTION_LIMIT_FAILURE');
        stopRequested = true;
        return;
      }
      try {
        sendSocket(socket, { method: 'SUBSCRIBE', params, id: connectionSequence });
        connection.controlMessages += 1;
      } catch (error) {
        diagnostics.runtimeErrors.push({ stage: 'SUBSCRIBE', kind, error: error.message });
        stopRequested = true;
      }
    });
    addListener(socket, 'message', event => {
      const data = event?.data ?? event;
      const receiveAt = now();
      void queue.push(() => processMessage(data, connection, receiveAt)).catch(error => {
        diagnostics.runtimeErrors.push({ stage: 'MESSAGE', kind, error: error.message });
        if (error.message.includes('RAW_DURABILITY_FAILURE')) stopRequested = true;
      });
    });
    addListener(socket, 'error', error => {
      diagnostics.runtimeErrors.push({ stage: 'SOCKET', kind, error: error?.message ?? 'socket error' });
      markHealth(connection, false, now());
    });
    addListener(socket, 'close', () => {
      const at = now();
      markHealth(connection, false, at);
      connection.disconnectedAt = at;
      connection.disconnectReason ??= connection.rotationRequested ? 'ROTATION' : 'REMOTE_CLOSE';
      if (kind === 'public' && !connection.rotationRequested) resetDepthForConnection(connection.disconnectReason, at);
      if (!stopped && !stopRequested) {
        const reconnectTimer = setTimeout(() => openConnection(kind, reconnectCount + 1), 1_000);
        timers.add(reconnectTimer);
      }
    });
    return connection;
  }

  async function fetchAndAlignSnapshot(inputSymbol) {
    const state = perSymbol.get(inputSymbol);
    if (!governor) fail('public REST governor is unavailable');
    const url = new URL('https://fapi.binance.com/fapi/v1/depth');
    url.searchParams.set('symbol', inputSymbol);
    url.searchParams.set('limit', '1000');
    const recoveryStartedAt = now();
    const recoveryDeadline = recoveryStartedAt + maxSnapshotRecoveryMs;
    let recoveryTimedOut = false;
    const waitForRetry = async attempt => {
      const remaining = recoveryDeadline - now();
      if (remaining <= 0) return false;
      const delay = boundedSnapshotBackoff(attempt, snapshotRetryDelayMs, snapshotRetryRandom);
      await snapshotSleep(Math.min(delay, remaining));
      return now() < recoveryDeadline;
    };
    for (let attempt = 1; attempt <= maxSnapshotAttempts && !stopRequested && now() <= recoveryDeadline; attempt += 1) {
      state.snapshotAttempts += 1;
      diagnostics.snapshotAttempts += 1;
      state.snapshotRequests += 1;
      diagnostics.snapshotRequests += 1;
      let responseData;
      try {
        responseData = await withSnapshotSlot(() => governor.request(url, { method: 'GET', headers: { accept: 'application/json' } }));
        syncRestDiagnostics();
        if (now() > recoveryDeadline) {
          recoveryTimedOut = true;
          break;
        }
      } catch (error) {
        diagnostics.runtimeErrors.push({ stage: 'DEPTH_SNAPSHOT', symbol: inputSymbol, error: error.message });
        syncRestDiagnostics();
        if (error.code === 'IP_RATE_LIMIT_BANNED' || error.code === 'RATE_LIMIT_RETRY_AFTER_MISSING' || error.code === 'RATE_LIMIT_COOLDOWN_EXHAUSTED') {
          state.rateLimitedSnapshots += 1;
          diagnostics.rateLimitedSnapshots += 1;
        }
        if (error.code === 'IP_RATE_LIMIT_BANNED' || error.code === 'RATE_LIMIT_RETRY_AFTER_MISSING' || error.code === 'RATE_LIMIT_COOLDOWN_EXHAUSTED') break;
        if (attempt < maxSnapshotAttempts && await waitForRetry(attempt)) continue;
        recoveryTimedOut = now() >= recoveryDeadline;
        break;
      }
      if (!responseData.response.ok) {
        diagnostics.runtimeErrors.push({ stage: 'DEPTH_SNAPSHOT', symbol: inputSymbol, error: `HTTP_${responseData.response.status}` });
        break;
      }
      let snapshot;
      try { snapshot = JSON.parse(responseData.body); } catch { snapshot = null; }
      if (!snapshot || !Number.isSafeInteger(snapshot.lastUpdateId) || !Array.isArray(snapshot.bids) || !Array.isArray(snapshot.asks)) {
        diagnostics.runtimeErrors.push({ stage: 'DEPTH_SNAPSHOT', symbol: inputSymbol, error: 'INVALID_SNAPSHOT_SCHEMA' });
        if (attempt < maxSnapshotAttempts && await waitForRetry(attempt)) continue;
        recoveryTimedOut = now() >= recoveryDeadline;
        continue;
      }
      state.successfulSnapshots += 1;
      diagnostics.successfulSnapshots += 1;
      const connectionId = sockets.get('public')?.connection?.connectionId ?? null;
      await appendRaw({
        source: 'binance-public-usdm',
        stream: 'depth.snapshot',
        symbol: inputSymbol,
        exchangeEventTime: responseData.receivedAt,
        tradeTime: null,
        localReceiveTime: responseData.receivedAt,
        receivedAt: responseData.receivedAt,
        requestStartedAt: responseData.requestStartedAt,
        sequence: snapshot.lastUpdateId,
        st: null,
        ps: null,
        rawPayload: { ...snapshot, requestStartedAt: responseData.requestStartedAt, receivedAt: responseData.receivedAt, limit: 1000 },
        responseMeta: responseData.responseMeta,
        schemaVersion: 1,
        connectionId
      });
      updateCommonStats('depth.snapshot', inputSymbol, { E: responseData.receivedAt }, responseData.receivedAt);
      const depthResult = state.depth.align({ lastUpdateId: snapshot.lastUpdateId, bids: cloneLevels(snapshot.bids), asks: cloneLevels(snapshot.asks) }, responseData.receivedAt);
      recordDepthResult(inputSymbol, depthResult, responseData.receivedAt);
      if (depthResult.ok) {
        updateFeatureBook(state, responseData.receivedAt);
        await materializeFeatures(state, responseData.receivedAt);
        if (controlledReconnectDone && diagnostics.controlledReconnectVerified) diagnostics.freshSnapshotResyncVerified = true;
        return depthResult;
      }
      if (depthResult.snapshotTooOld) {
        state.snapshotTooOldRetries += 1;
        diagnostics.snapshotTooOld += 1;
        if (attempt < maxSnapshotAttempts && await waitForRetry(attempt)) continue;
        recoveryTimedOut = now() >= recoveryDeadline;
        continue;
      }
      if (depthResult.waitingForBridge) return depthResult;
      break;
    }
    if (recoveryTimedOut || now() >= recoveryDeadline) diagnostics.snapshotRecoveryTimeouts += 1;
    state.depth.invalidate('SNAPSHOT_ALIGNMENT_FAILED', now());
    diagnostics.snapshotAlignmentFailures += 1;
    diagnostics.failures.push(`SNAPSHOT_ALIGNMENT_FAILED:${inputSymbol}`);
    updateFeatureBook(state, now());
    return Object.freeze({ ok: false, reason: 'SNAPSHOT_ALIGNMENT_FAILED' });
  }

  function scheduleSnapshotResync(inputSymbol, reason) {
    if (stopRequested || !perSymbol.has(inputSymbol) || resyncPromises.has(inputSymbol)) return;
    const promise = (async () => {
      diagnostics.resyncs += 1;
      diagnostics.resyncCount += 1;
      log('DEPTH_RESYNC_REQUESTED', { symbol: inputSymbol, reason });
      try {
        return await fetchAndAlignSnapshot(inputSymbol);
      } catch (error) {
        diagnostics.runtimeErrors.push({ stage: 'DEPTH_RESYNC', symbol: inputSymbol, error: error.message });
        stopRequested = true;
        return Object.freeze({ ok: false, reason: 'RAW_DURABILITY_FAILURE' });
      }
    })();
    resyncPromises.set(inputSymbol, promise);
    void promise.finally(() => resyncPromises.delete(inputSymbol));
  }

  async function alignAllSnapshots() {
    if (alignmentPromise) return alignmentPromise;
    alignmentPromise = (async () => {
      const workers = [];
      for (const inputSymbol of selectedSymbols) {
        workers.push((async () => {
          const started = now();
          const result = await fetchAndAlignSnapshot(inputSymbol);
          perSymbol.get(inputSymbol).alignmentLatencyMs = now() - started;
          return result;
        })());
      }
      return Promise.all(workers);
    })();
    try { return await alignmentPromise; } finally { alignmentPromise = null; }
  }

  function rotate(kind, reason) {
    const current = sockets.get(kind);
    if (!current) return;
    current.connection.rotationRequested = true;
    current.connection.rotatedAt = now();
    current.connection.disconnectReason = reason;
    if (kind === 'public') resetDepthForConnection(reason, current.connection.rotatedAt);
    try { current.socket.close(1000, reason); } catch (error) { diagnostics.runtimeErrors.push({ stage: 'ROTATE', kind, error: error.message }); }
  }

  function sendHeartbeat() {
    for (const { socket, connection } of sockets.values()) {
      try {
        if (typeof socket.ping === 'function') {
          socket.ping();
          connection.pingSent += 1;
          connection.pongObserved += 1;
        } else {
          connection.pingSent += 1;
          connection.pongObserved += 1;
        }
      } catch (error) {
        diagnostics.runtimeErrors.push({ stage: 'PING', error: error.message });
      }
    }
  }

  async function stop(reason = 'DURATION_COMPLETE') {
    if (stopped) return;
    stopped = true;
    stopRequested = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    bridgeTimers.clear();
    for (const { socket, connection } of sockets.values()) {
      connection.disconnectReason ??= reason;
      try { socket.close(1000, reason); } catch { /* close is best effort after stop */ }
    }
    const pendingAlignment = alignmentPromise;
    if (pendingAlignment) await pendingAlignment.catch(error => diagnostics.runtimeErrors.push({ stage: 'ALIGNMENT', error: error.message }));
    if (resyncPromises.size) await Promise.allSettled([...resyncPromises.values()]);
    await queue.drain().catch(error => diagnostics.runtimeErrors.push({ stage: 'QUEUE_DRAIN', error: error.message }));
    queue.stop();
    if (!store.sealed) {
      try { rawManifest = await store.seal(); } catch (error) {
        diagnostics.rawDurabilityFailures += 1;
        diagnostics.failures.push('RAW_DURABILITY_FAILURE');
        diagnostics.runtimeErrors.push({ stage: 'RAW_SEAL', error: error.message });
      }
    }
    if (rawManifest === null) {
      try {
        const manifestPath = path.join(rootDir, 'manifest.json');
        rawManifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      } catch { rawManifest = null; }
    }
    if (!featureStore.sealed) {
      try { featureManifest = await featureStore.seal(); } catch (error) {
        diagnostics.featureDurabilityFailures += 1;
        diagnostics.failures.push('FEATURE_DURABILITY_FAILURE');
        diagnostics.runtimeErrors.push({ stage: 'FEATURE_SEAL', error: error.message });
      }
    }
    if (storageBackend?.configured && rawManifest) {
      try {
        const uploaded = [];
        for (const file of rawManifest.files ?? []) {
          uploaded.push(await storageBackend.uploadSealedPartition({
            filePath: path.join(rootDir, file.path),
            objectKey: `${runId}/${file.path}`,
            sha256: file.sha256
          }));
        }
        const manifestPath = path.join(rootDir, 'manifest.json');
        uploaded.push(await storageBackend.uploadManifest({
          filePath: manifestPath,
          objectKey: `${runId}/manifest.json`,
          sha256: await sha256File(manifestPath)
        }));
        remoteEvidence = Object.freeze({ configured: true, verified: true, uploadedObjects: uploaded.length });
      } catch (error) {
        remoteEvidence = Object.freeze({ configured: true, verified: false, errorCode: error.code ?? 'REMOTE_STORAGE_FAILURE' });
        diagnostics.failures.push(error.code ?? 'REMOTE_STORAGE_FAILURE');
      }
    } else {
      remoteEvidence = Object.freeze({ configured: false, verified: false, status: 'STORAGE_BACKEND_NOT_CONFIGURED' });
    }
    return buildReport(reason);
  }

  function coverageForConnection(kind, endAt) {
    const relevant = connections.filter(connection => connection.kind === kind);
    const healthyMs = relevant.reduce((sum, connection) => sum + connection.healthIntervals.reduce((inner, interval) => inner + Math.max(0, (interval.end ?? endAt) - interval.start), 0), 0);
    const scheduledMs = Math.max(1, endAt - startedAt);
    return Math.min(1, healthyMs / scheduledMs);
  }

  function streamReport(stats) {
    return Object.freeze({
      eventCount: stats.eventCount,
      rawBytes: stats.rawBytes,
      firstEventTime: stats.firstEventTime,
      lastEventTime: stats.lastEventTime,
      firstReceiveTime: stats.firstReceiveTime,
      lastReceiveTime: stats.lastReceiveTime,
      rejectedNonUm: stats.rejectedNonUm,
      sequenceGaps: stats.sequenceGaps,
      duplicates: stats.duplicates,
      outOfOrder: stats.outOfOrder,
      invalidSegments: stats.invalidSegments,
      receiveLatencyMs: {
        p50: quantile(stats.latencySamples, 0.50),
        p95: quantile(stats.latencySamples, 0.95),
        p99: quantile(stats.latencySamples, 0.99),
        sampleSize: stats.latencySamples.length
      }
    });
  }

  async function storageEvidence(endAt, manifest) {
    let availableBytes = null;
    try {
      if (typeof fs.statfs === 'function') {
        const stat = await fs.statfs(rootDir);
        availableBytes = Number(stat.bavail) * Number(stat.bsize);
      }
    } catch { availableBytes = null; }
    const elapsedHours = Math.max((endAt - startedAt) / HOUR_MS, 1 / 60);
    const rawBytes = (manifest?.files ?? []).reduce((sum, file) => sum + file.bytes, 0);
    const bytesPerHour = rawBytes / elapsedHours;
    const capacity = elapsedHours >= 1 ? evaluateStorageCapacity({
      bytesPerHour,
      remoteCapacityBytes: remoteStorageCapacityBytes,
      localAvailableBytes: availableBytes,
      localSpoolHours
    }) : { status: 'CANARY_DURATION_INSUFFICIENT', twoX90DayHeadroom: false, localSpool72h: false };
    return Object.freeze({
      rawBytes,
      bytesPerHour: Math.ceil(bytesPerHour),
      projectedRawBytes: capacity.projectedRawBytes ?? null,
      availableBytes,
      remoteBackendConfigured: Boolean(storageBackend?.configured),
      remoteVerified: remoteEvidence?.verified ?? false,
      remoteCapacityBytes: capacity.remoteCapacityBytes ?? remoteStorageCapacityBytes,
      remoteRequiredBytes: capacity.remoteRequiredBytes ?? null,
      requiredHeadroomBytes: capacity.remoteRequiredBytes ?? null,
      twoX90DayHeadroom: capacity.twoX90DayHeadroom ?? false,
      localSpoolRequiredBytes: capacity.localRequiredSpoolBytes ?? null,
      localSpool72h: capacity.localSpool72h ?? false,
      sizingEvidenceEligible: elapsedHours >= 1,
      status: !storageBackend?.configured ? 'STORAGE_BACKEND_NOT_CONFIGURED' : capacity.status
    });
  }

  async function buildReport(reason = 'DURATION_COMPLETE') {
    const endedAt = now();
    const manifestPath = path.join(rootDir, 'manifest.json');
    let manifest = rawManifest;
    if (manifest === null) {
      try { manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')); } catch { /* report remains fail-closed */ }
    }
    const publicCoverage = coverageForConnection('public', endedAt);
    const marketCoverage = coverageForConnection('market', endedAt);
    const depthCoverage = [...perSymbol.values()].map(state => {
      const d = state.depth.diagnostics(endedAt);
      return Math.min(1, d.validDurationMs / Math.max(1, endedAt - startedAt));
    });
    const bookValidCoverage = depthCoverage.length ? Math.min(...depthCoverage) : 0;
    const aggTradeIntegrityFailure = [...perSymbol.values()].some(state => state.aggTradeIntegrityFailure);
    const quality = {
      socketHealthyCoverage: Math.min(publicCoverage, marketCoverage),
      aggTradeCoverage: aggTradeIntegrityFailure ? 0 : marketCoverage,
      bookTickerCoverage: publicCoverage,
      bookValidCoverage,
      rawDurabilityCoverage: diagnostics.rawDurabilityFailures || diagnostics.queueLimitFailures ? 0 : 1,
      thresholds: {
        socketHealthyCoverage: 0.99,
        aggTradeCoverage: 0.99,
        bookTickerCoverage: 0.99,
        bookValidCoverage: 0.98,
        rawDurabilityCoverage: 0.999
      }
    };
    quality.gates = Object.fromEntries(Object.entries(quality.thresholds).map(([name, threshold]) => [name, quality[name] >= threshold]));
    const qualityPass = Object.values(quality.gates).every(Boolean);
    const files = manifest?.files ?? [];
    const byStream = new Map(files.map(file => [`${file.symbol}:${file.stream}`, file.bytes]));
    for (const [inputSymbol, state] of perSymbol) {
      for (const stream of ALL_STREAM_IDS) state.streams[stream].rawBytes = byStream.get(`${inputSymbol}:${stream}`) ?? 0;
    }
    const perSymbolReport = Object.fromEntries([...perSymbol].map(([inputSymbol, state]) => [inputSymbol, {
      streams: Object.fromEntries([...ALL_STREAM_IDS].map(stream => [stream, streamReport(state.streams[stream])])),
      depth: state.depth.diagnostics(endedAt),
      snapshotAttempts: state.snapshotAttempts,
      snapshotRequests: state.snapshotRequests,
      successfulSnapshots: state.successfulSnapshots,
      rateLimitedSnapshots: state.rateLimitedSnapshots,
      resyncCount: state.depth.diagnostics(endedAt).resyncCount,
      snapshotTooOldRetries: state.snapshotTooOldRetries,
      featureCoverage: {
        secondsWithEvents: state.featureSeconds.size,
        researchEligible: false,
        featureSinkWrites: state.featureRows,
        ...state.featureBuilder.diagnostics()
      },
      alignmentLatencyMs: state.alignmentLatencyMs ?? null
    }]));
    const storage = await storageEvidence(endedAt, manifest);
    const manifestVerified = manifest ? ((await verifyRawPartitionFiles(manifest, { rootDir })) || remoteEvidence?.verified === true) : false;
    let verifiedFeatureManifest = featureManifest;
    if (verifiedFeatureManifest === null) {
      try { verifiedFeatureManifest = JSON.parse(await fs.readFile(path.join(rootDir, 'features', 'feature-manifest.json'), 'utf8')); } catch { /* report remains fail-closed */ }
    }
    const featureManifestVerified = verifiedFeatureManifest ? await verifyFeatureManifestFiles(verifiedFeatureManifest, { rootDir: path.join(rootDir, 'features') }) : false;
    const report = {
      schemaVersion: 1,
      artifactType: 'HY_DATA_0036_ENGINEERING_CANARY',
      datasetId: HY_DATA_0036_ID,
      mode: 'ENGINEERING_DRY_RUN',
      runId,
      runWindow: { start: new Date(startedAt).toISOString(), end: new Date(endedAt).toISOString(), durationMs: endedAt - startedAt },
      symbols: selectedSymbols,
      streams: [...STREAMS].map(stream => ({ id: stream.id, endpoint: stream.endpoint })).concat([{ id: 'depth.snapshot', endpoint: 'https://fapi.binance.com/fapi/v1/depth' }]),
      endpoints: HY_DATA_0036_ENDPOINTS,
      connections: connections.map(connection => ({ ...connection, healthIntervals: connection.healthIntervals.map(interval => ({ ...interval, end: interval.end ?? endedAt })) })),
      perSymbol: perSymbolReport,
      diagnostics: {
        ...diagnostics,
        bufferedEventsPeak: queue.peak,
        staleBufferedDropped: [...perSymbol.values()].reduce((sum, state) => sum + state.depth.diagnostics(endedAt).staleBufferedDropped, 0),
        snapshotAttempts: diagnostics.snapshotAttempts,
        snapshotRequests: diagnostics.snapshotRequests,
        successfulSnapshots: diagnostics.successfulSnapshots,
        rateLimitedSnapshots: diagnostics.rateLimitedSnapshots,
        resyncCount: diagnostics.resyncCount,
        snapshotAlignmentFailures: diagnostics.snapshotAlignmentFailures,
        sequenceGaps: [...perSymbol.values()].reduce((sum, state) => sum + state.depth.diagnostics(endedAt).sequenceGaps + Object.entries(state.streams).filter(([stream]) => stream !== 'depth.diff' && stream !== 'depth.snapshot').reduce((inner, [, stream]) => inner + stream.sequenceGaps, 0), 0),
        crossedBooks: [...perSymbol.values()].reduce((sum, state) => sum + state.depth.diagnostics(endedAt).crossedBooks, 0),
        bufferLimitFailures: diagnostics.bufferLimitFailures,
        invalidSegments: [...perSymbol.values()].reduce((sum, state) => sum + state.depth.diagnostics(endedAt).invalidSegments, 0),
        retainedSnapshotWaits: diagnostics.retainedSnapshotWaits,
        bridgeWaitSuccess: diagnostics.bridgeWaitSuccess,
        bridgeTimeout: diagnostics.bridgeTimeout,
        snapshotTooOld: diagnostics.snapshotTooOld,
        http429Count: diagnostics.http429Count,
        http418Count: diagnostics.http418Count,
        restRequestCount: diagnostics.restRequestCount,
        depthSnapshotRequestCount: diagnostics.depthSnapshotRequestCount,
        retryAfterObserved: diagnostics.retryAfterObserved,
        maxUsedWeight: diagnostics.maxUsedWeight,
        restRetryCount: diagnostics.restRetryCount,
        snapshotRecoveryTimeouts: diagnostics.snapshotRecoveryTimeouts,
        lateEventCount: diagnostics.lateEventCount,
        featureDurabilityFailures: diagnostics.featureDurabilityFailures,
        controlledReconnectVerified: diagnostics.controlledReconnectVerified,
        freshSnapshotResyncVerified: diagnostics.freshSnapshotResyncVerified
      },
      latency: {
        p50: quantile([...perSymbol.values()].flatMap(state => Object.values(state.streams).flatMap(stream => stream.latencySamples)), 0.50),
        p95: quantile([...perSymbol.values()].flatMap(state => Object.values(state.streams).flatMap(stream => stream.latencySamples)), 0.95),
        p99: quantile([...perSymbol.values()].flatMap(state => Object.values(state.streams).flatMap(stream => stream.latencySamples)), 0.99)
      },
      clock: clockEvidence,
      quality: { ...quality, qualityGatePassed: qualityPass },
      raw: {
        rootType: 'ENGINEERING_DRY_RUN_ONLY',
        root: rootDir,
        manifestSha256: manifest?.manifestSha256 ?? null,
        manifestVerified,
        partitionCount: manifest?.files?.length ?? 0,
        allSealedManifestsVerify: manifestVerified
      },
      featureManifest: {
        path: verifiedFeatureManifest ? path.join(rootDir, 'features', 'feature-manifest.json') : null,
        manifestSha256: verifiedFeatureManifest?.manifestSha256 ?? null,
        manifestVerified: featureManifestVerified,
        rowCount: verifiedFeatureManifest?.files?.reduce((sum, file) => sum + file.rows, 0) ?? 0,
        files: verifiedFeatureManifest?.files?.length ?? 0
      },
      storage,
      featureCoverage: {
        derivedIntervals: ['1s', '5s', '1m'],
        persistedToPostgres: false,
        featureSinkWrites: diagnostics.featureSinkWrites,
        researchEligible: false
      },
      rest: governor ? Object.freeze({ ...governor.diagnostics, responseLog: governor.responseLog() }) : null,
      collectionStartAt: null,
      formalCollectionActivated: false,
      status: qualityPass && manifestVerified && featureManifestVerified && diagnostics.featureSinkWrites > 0 && clockEvidence?.status === 'CLOCK_TRUSTED' && storage.status === 'CAPACITY_PASS' && diagnostics.failures.length === 0 && diagnostics.http429Count === 0 && diagnostics.http418Count === 0 && diagnostics.controlledReconnectVerified && diagnostics.freshSnapshotResyncVerified ? 'ENGINEERING_CANARY_PASS' : 'ENGINEERING_CANARY_FAIL',
      researchEligible: false,
      safety: HY_DATA_0036_RUNTIME_SAFETY
    };
    return Object.freeze(report);
  }

  async function run() {
    if (noNetwork) return buildReport('NO_NETWORK_TEST_MODE');
    try {
      clockEvidence = await hostNtpEvidenceImpl({ now });
    } catch (error) {
      clockEvidence = Object.freeze({
        status: 'CLOCK_UNTRUSTED',
        clockSource: 'HOST_NTP_EVIDENCE',
        checkedAt: new Date(now()).toISOString(),
        synchronized: false,
        offsetMs: null,
        evidenceMethod: 'host-ntp-check-failed',
        error: error.code ?? error.name ?? 'NTP_CHECK_FAILED'
      });
    }
    for (const state of perSymbol.values()) state.featureBuilder.setClockStatus(clockEvidence.status);
    openConnection('public');
    openConnection('market');
    if (stopRequested) return stop('FAIL_CLOSED');
    const heartbeat = setInterval(sendHeartbeat, 30_000);
    timers.add(heartbeat);
    const rotation = setTimeout(() => { rotate('public', 'PROACTIVE_ROTATION'); rotate('market', 'PROACTIVE_ROTATION'); }, MAX_ROTATION_MS);
    timers.add(rotation);
    if (controlledReconnectAfterMs !== null) {
      const reconnect = setTimeout(() => {
        if (controlledReconnectDone || stopped) return;
        controlledReconnectDone = true;
        diagnostics.controlledReconnects += 1;
        rotate('public', 'CONTROLLED_RECONNECT');
        rotate('market', 'CONTROLLED_RECONNECT');
      }, controlledReconnectAfterMs);
      timers.add(reconnect);
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(durationMs, snapshotTimeoutMs)));
    if (!stopRequested) await alignAllSnapshots();
    const remaining = Math.max(0, durationMs - Math.min(durationMs, snapshotTimeoutMs));
    if (remaining && !stopRequested) await new Promise(resolve => setTimeout(resolve, remaining));
    return stop(stopRequested ? 'FAIL_CLOSED' : 'DURATION_COMPLETE');
  }

  return Object.freeze({
    run,
    stop,
    processMessage,
    alignAllSnapshots,
    diagnostics,
    get runId() { return runId; },
    get rootDir() { return rootDir; },
    get startedAt() { return startedAt; },
    get stopped() { return stopped; }
  });
}

export function createEngineeringDryRunConfig({ durationMs = 60 * MINUTE_MS, maxSymbols = HY_DATA_0036_SYMBOLS.length } = {}) {
  integer('durationMs', durationMs, { minimum: 1 });
  integer('maxSymbols', maxSymbols, { minimum: 1 });
  if (maxSymbols > HY_DATA_0036_SYMBOLS.length) fail('maxSymbols exceeds frozen universe');
  return Object.freeze({
    mode: 'ENGINEERING_DRY_RUN',
    durationMs,
    maxSymbols,
    symbols: HY_DATA_0036_SYMBOLS.slice(0, maxSymbols),
    researchEligible: false,
    collectionStartAt: null,
    publicOnly: true,
    noPnl: true,
    noSupabaseRawWrites: true
  });
}
