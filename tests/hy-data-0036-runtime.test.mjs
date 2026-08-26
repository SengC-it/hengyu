import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  HY_DATA_0036_ENDPOINTS,
  HY_DATA_0036_SYMBOLS
} from '../src/data/hy-data-0036-contract.mjs';
import {
  createBoundedAsyncQueue,
  createDurableRawPartitionStore,
  createEngineeringDryRunConfig,
  createHyData0036Runtime,
  createPerSymbolDepthBook,
  HY_DATA_0036_MAX_ROTATION_MS,
  HY_DATA_0036_RUNTIME_SAFETY,
  normalizeAggTradeRpi,
  parseCombinedWsMessage,
  parseForceOrder,
  parseMarkPrice,
  parseRuntimeBookTicker,
  parseRuntimeDepth20,
  parseRuntimeDepthDiff,
  validateUmTransport,
  verifyRawPartitionFiles,
  verifyRawPartitionManifest
} from '../src/data/hy-data-0036-runtime.mjs';

const NOW = Date.parse('2026-08-27T00:00:00.000Z');

function depthUpdate(U, u, pu = null, symbol = 'BTCUSDT') {
  return {
    symbol,
    U,
    u,
    pu,
    bids: [[99, 2]],
    asks: [[101, 3]],
    eventTime: NOW
  };
}

function snapshot(lastUpdateId = 100) {
  return { lastUpdateId, bids: [['99', '2']], asks: [['101', '3']] };
}

function response(body, { ok = true, status = 200 } = {}) {
  return { ok, status, text: async () => body };
}

test('combined transport uses the documented public and market endpoints', () => {
  const message = parseCombinedWsMessage(JSON.stringify({ stream: 'btcusdt@bookTicker', data: { s: 'BTCUSDT' } }));
  assert.equal(message.combined, true);
  assert.equal(message.stream, 'btcusdt@bookTicker');
  assert.equal(message.data.s, 'BTCUSDT');
  assert.equal(HY_DATA_0036_ENDPOINTS.publicWebSocket, 'wss://fstream.binance.com/public/stream');
  assert.equal(HY_DATA_0036_ENDPOINTS.marketWebSocket, 'wss://fstream.binance.com/market/stream');
});

test('USD-M transport filtering allows st=1 and rejects st=2 without changing raw payload', () => {
  const accepted = validateUmTransport({ st: 1, ps: 'BTCUSDT' });
  const rejected = validateUmTransport({ st: 2, ps: 'BTCUSDT' });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.st, 1);
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.reason, 'NON_UM_STREAM');
  assert.equal(rejected.st, 2);
});

test('runtime parsers preserve mark-price, liquidation, and transport metadata', () => {
  const mark = parseMarkPrice({ e: 'markPriceUpdate', E: NOW, s: 'BTCUSDT', p: '100', i: '99', P: '101', r: '0.0001', T: NOW + 8 * 60 * 60 * 1000, st: 1, ps: 'BTCUSDT' });
  assert.deepEqual({ symbol: mark.symbol, markPrice: mark.markPrice, indexPrice: mark.indexPrice, estimatedSettlePrice: mark.estimatedSettlePrice, fundingRate: mark.fundingRate, nextFundingTime: mark.nextFundingTime, st: mark.st, ps: mark.ps }, {
    symbol: 'BTCUSDT', markPrice: 100, indexPrice: 99, estimatedSettlePrice: 101, fundingRate: 0.0001, nextFundingTime: NOW + 8 * 60 * 60 * 1000, st: 1, ps: 'BTCUSDT'
  });
  const force = parseForceOrder({ e: 'forceOrder', E: NOW, s: 'ETHUSDT', st: 1, o: { s: 'ETHUSDT', S: 'SELL', o: 'LIMIT', f: 'GTC', q: '2', p: '100', ap: '100.1', X: 'FILLED', l: '2', z: '2', T: NOW } });
  assert.equal(force.symbol, 'ETHUSDT');
  assert.equal(force.side, 'SELL');
  assert.equal(force.originalQty, 2);
  assert.equal(force.tradeTime, NOW);
  assert.throws(() => parseForceOrder({ e: 'forceOrder', E: NOW, s: 'ETHUSDT', st: 1, o: { s: 'ETHUSDT', q: '2', T: NOW } }), /force order side/);
});

test('aggTrade separates q total flow from nq visible-book-comparable flow', () => {
  const withNq = normalizeAggTradeRpi({ e: 'aggTrade', s: 'BTCUSDT', a: 10, p: '100', q: '2', nq: '1.5', T: NOW, m: false, st: 1 });
  const withoutNq = normalizeAggTradeRpi({ e: 'aggTrade', s: 'BTCUSDT', a: 11, p: '100', q: '2', T: NOW + 1, m: true, st: 1 });
  assert.equal(withNq.totalQuantity, 2);
  assert.equal(withNq.normalQuantity, 1.5);
  assert.equal(withNq.totalAggressorNotional, 200);
  assert.equal(withNq.visibleBookComparableAggressorNotional, 150);
  assert.equal(withoutNq.normalQuantity, null);
  assert.equal(withoutNq.visibleBookComparableAggressorNotional, null);
  assert.equal(withoutNq.signedVolume, -200);
});

test('bookTicker and depth20 parsers validate books and keep absolute levels', () => {
  const ticker = parseRuntimeBookTicker({ s: 'BTCUSDT', u: 4, b: '100', B: '2', a: '101', A: '3', E: NOW, st: 1 });
  const shallow = parseRuntimeDepth20({ s: 'BTCUSDT', lastUpdateId: 5, b: [['100', '2']], a: [['101', '3']], E: NOW, st: 1 });
  assert.equal(ticker.bidPrice, 100);
  assert.equal(shallow.bids[0][1], 2);
  assert.throws(() => parseRuntimeBookTicker({ s: 'BTCUSDT', u: 4, b: '101', B: '2', a: '100', A: '3', E: NOW }), /crossed/);
});

test('per-symbol depth alignment drops stale updates and applies only an overlapping first update', () => {
  const book = createPerSymbolDepthBook({ symbol: 'BTCUSDT', maxBufferedEvents: 10 });
  book.buffer(depthUpdate(80, 90));
  book.buffer(depthUpdate(91, 99, 90));
  book.buffer(depthUpdate(99, 101, 99));
  const result = book.align(snapshot(), NOW);
  assert.equal(result.ok, true);
  assert.equal(result.staleDropped, 2);
  assert.equal(result.firstAppliedUpdateId, 99);
  assert.equal(book.status, 'ALIGNED');
  assert.equal(book.applyLive(depthUpdate(102, 103, 101), NOW + 1).ok, true);
  assert.equal(book.snapshot().lastUpdateId, 103);
  assert.equal(book.applyLive({ ...depthUpdate(104, 104, 103), bids: [[99, 0]] }, NOW + 2).ok, true);
  assert.equal(book.snapshot().book.bids.some(([price]) => price === 99), false);
});

test('snapshot without overlap stays in alignment and bounded retry can succeed with the retained buffer', () => {
  const book = createPerSymbolDepthBook({ symbol: 'ETHUSDT', maxBufferedEvents: 10 });
  book.buffer(depthUpdate(120, 130, null, 'ETHUSDT'));
  const first = book.align(snapshot(100), NOW);
  assert.equal(first.ok, false);
  assert.equal(first.snapshotTooOld, true);
  assert.equal(book.status, 'ALIGNING');
  const second = book.align(snapshot(121), NOW + 1);
  assert.equal(second.ok, true);
  assert.equal(book.status, 'ALIGNED');
});

test('aligned depth rejects a sequence gap and never silently repairs it', () => {
  const book = createPerSymbolDepthBook({ symbol: 'SOLUSDT', maxBufferedEvents: 10 });
  book.buffer(depthUpdate(99, 101, null, 'SOLUSDT'));
  assert.equal(book.align(snapshot(), NOW).ok, true);
  const failed = book.applyLive(depthUpdate(105, 106, 104, 'SOLUSDT'), NOW + 1);
  assert.equal(failed.reason, 'SEQUENCE_GAP');
  assert.equal(book.status, 'WAITING_SNAPSHOT');
  assert.equal(book.snapshot().book, null);
});

test('raw partition store seals atomically and verifies both manifest and actual file hashes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hy-data-0036-engineering-'));
  const store = createDurableRawPartitionStore({ rootDir: root, runId: 'test-run' });
  await store.append({ source: 'binance-public-usdm', stream: 'aggTrade', symbol: 'BTCUSDT', exchangeEventTime: NOW, localReceiveTime: NOW + 2, receivedAt: NOW + 2, rawPayload: { q: '1' }, schemaVersion: 1 });
  const manifest = await store.seal();
  assert.equal(store.sealed, true);
  assert.equal(verifyRawPartitionManifest(manifest), true);
  assert.equal(await verifyRawPartitionFiles(manifest, { rootDir: root }), true);
  await assert.rejects(store.append({}), /RAW_PARTITION_STORE_SEALED/);
  const files = [];
  async function collect(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await collect(absolute);
      else files.push(entry.name);
    }
  }
  await collect(root);
  assert.deepEqual(files.filter(file => file.endsWith('.part')), []);
});

test('bounded queue fails closed on backlog overflow', async () => {
  let release;
  let overflow = 0;
  const queue = createBoundedAsyncQueue({ maxSize: 1, onOverflow: () => { overflow += 1; } });
  const first = queue.push(() => new Promise(resolve => { release = resolve; }));
  const second = queue.push(() => Promise.resolve('second'));
  await assert.rejects(queue.push(() => Promise.resolve('overflow')), /BACKPRESSURE_LIMIT_FAILURE/);
  release();
  await Promise.all([first, second]);
  assert.equal(overflow, 1);
  queue.stop();
});

test('REST receipt is taken after the complete body and snapshot calls are independent per symbol', async () => {
  const records = [];
  const rawStore = Object.freeze({
    append: async record => { records.push(record); },
    seal: async () => [],
    get sealed() { return false; }
  });
  const fetchImpl = async url => {
    const value = String(url);
    if (value.includes('/depth?')) {
      const requested = new URL(value).searchParams.get('symbol');
      await new Promise(resolve => setTimeout(resolve, requested === 'BTCUSDT' ? 10 : 30));
      return response(JSON.stringify({ lastUpdateId: 100, bids: [['99', '2']], asks: [['101', '3']] }));
    }
    return response('{}');
  };
  const runtime = createHyData0036Runtime({ dryRun: true, symbols: ['BTCUSDT', 'ETHUSDT'], fetchImpl, rawStore, maxSnapshotAttempts: 1, snapshotRetryDelayMs: 1 });
  const started = Date.now();
  await runtime.alignAllSnapshots();
  const snapshots = records.filter(record => record.stream === 'depth.snapshot');
  assert.equal(snapshots.length, 2);
  assert.ok(snapshots.every(record => record.receivedAt > record.requestStartedAt));
  assert.ok(snapshots[0].receivedAt - started < 30);
  assert.notEqual(snapshots[0].symbol, snapshots[1].symbol);
});

test('runtime message raw record preserves st=2 rejection and raw payload before normalization', async () => {
  const records = [];
  const runtime = createHyData0036Runtime({
    dryRun: true,
    symbols: ['BTCUSDT'],
    rawStore: { append: async record => records.push(record), seal: async () => [], get sealed() { return false; } },
    fetchImpl: async () => response('{}')
  });
  await runtime.processMessage(JSON.stringify({ stream: 'btcusdt@markPrice@1s', data: { e: 'markPriceUpdate', E: NOW, s: 'BTCUSDT', p: '100', i: '99', st: 2 } }), { connectionId: 'test-market' }, NOW + 1);
  assert.equal(records.length, 1);
  assert.equal(records[0].st, 2);
  assert.equal(records[0].rawPayload.st, 2);
  assert.equal(runtime.diagnostics.rejectedNonUm, 1);
});

test('engineering dry-run config and safety can never become formal research evidence', () => {
  const config = createEngineeringDryRunConfig({ durationMs: 3_600_000, maxSymbols: 8 });
  assert.deepEqual(config.symbols, HY_DATA_0036_SYMBOLS);
  assert.equal(config.collectionStartAt, null);
  assert.equal(config.researchEligible, false);
  assert.equal(config.noPnl, true);
  assert.throws(() => createEngineeringDryRunConfig({ maxSymbols: 9 }), /exceeds frozen universe/);
  assert.equal(HY_DATA_0036_RUNTIME_SAFETY.publicMarketDataOnly, true);
  assert.equal(HY_DATA_0036_RUNTIME_SAFETY.accountApi, false);
  assert.equal(HY_DATA_0036_RUNTIME_SAFETY.orderApi, false);
  assert.equal(HY_DATA_0036_RUNTIME_SAFETY.pnlComputed, false);
  assert.ok(HY_DATA_0036_MAX_ROTATION_MS <= 23 * 60 * 60 * 1000 + 45 * 60 * 1000);
});

test('controlled reconnect and fresh snapshot are part of runtime lifecycle, without enabling research', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hy-data-0036-rotation-'));
  let socketSequence = 0;
  class FakeSocket {
    constructor() {
      this.listeners = new Map();
      this.closed = false;
      this.id = ++socketSequence;
      setTimeout(() => this.emit('open'), 0);
    }
    addEventListener(event, handler) {
      const handlers = this.listeners.get(event) ?? [];
      handlers.push(handler);
      this.listeners.set(event, handlers);
    }
    emit(event, value = {}) {
      for (const handler of this.listeners.get(event) ?? []) handler(value);
    }
    send(value) {
      const control = JSON.parse(value);
      if (control.method !== 'SUBSCRIBE') return;
      setTimeout(() => {
        this.emit('message', { data: JSON.stringify({ result: null, id: control.id }) });
        for (const param of control.params) {
          const lowerParam = param.toLowerCase();
          const symbol = param.split('@')[0].toUpperCase();
          if (lowerParam.endsWith('@depth@100ms')) this.emit('message', { data: JSON.stringify({ stream: param, data: { e: 'depthUpdate', E: Date.now(), s: symbol, U: 99, u: 101, pu: 98, b: [['99', '2']], a: [['101', '3']], st: 1 } }) });
          if (lowerParam.endsWith('@bookticker')) this.emit('message', { data: JSON.stringify({ stream: param, data: { e: 'bookTicker', E: Date.now(), s: symbol, u: this.id, b: '100', B: '2', a: '101', A: '3', st: 1 } }) });
          if (lowerParam.endsWith('@depth20@100ms')) this.emit('message', { data: JSON.stringify({ stream: param, data: { e: 'depthUpdate', E: Date.now(), s: symbol, lastUpdateId: 101, b: [['99', '2']], a: [['101', '3']], st: 1 } }) });
          if (lowerParam.endsWith('@aggtrade')) this.emit('message', { data: JSON.stringify({ stream: param, data: { e: 'aggTrade', E: Date.now(), T: Date.now(), s: symbol, a: this.id, p: '100', q: '1', nq: '1', m: false, st: 1 } }) });
          if (lowerParam.endsWith('@markprice@1s')) this.emit('message', { data: JSON.stringify({ stream: param, data: { e: 'markPriceUpdate', E: Date.now(), s: symbol, p: '100', i: '99', r: '0', T: Date.now() + 1000, st: 1 } }) });
          if (lowerParam.endsWith('@forceorder')) this.emit('message', { data: JSON.stringify({ stream: param, data: { e: 'forceOrder', E: Date.now(), s: symbol, st: 1, o: { s: symbol, S: 'SELL', o: 'LIMIT', f: 'GTC', q: '1', p: '100', ap: '100', X: 'FILLED', l: '1', z: '1', T: Date.now() } } }) });
        }
      }, 0);
    }
    ping() {}
    close() {
      if (this.closed) return;
      this.closed = true;
      setTimeout(() => this.emit('close'), 0);
    }
  }
  const fetchImpl = async url => String(url).includes('/time')
    ? response(JSON.stringify({ serverTime: Date.now() }))
    : response(JSON.stringify({ lastUpdateId: 100, bids: [['99', '2']], asks: [['101', '3']] }));
  const runtime = createHyData0036Runtime({
    dryRun: true,
    symbols: ['BTCUSDT'],
    fetchImpl,
    webSocketFactory: url => new FakeSocket(url),
    rootDir: root,
    runId: 'rotation-test',
    durationMs: 1_300,
    snapshotTimeoutMs: 100,
    maxSnapshotAttempts: 1,
    controlledReconnectAfterMs: 200,
    snapshotRetryDelayMs: 1
  });
  const report = await runtime.run();
  assert.equal(report.diagnostics.controlledReconnects, 1);
  assert.ok(report.connections.some(connection => connection.reconnectCount > 0));
  assert.ok(report.diagnostics.resyncs >= 1);
  assert.equal(report.researchEligible, false);
  assert.equal(report.collectionStartAt, null);
});
