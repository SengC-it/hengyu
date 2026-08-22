import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  HY_EXP_0022_ACCOUNT_ENDPOINTS,
  HY_EXP_0022_ENGINEERING_ROOT,
  HY_EXP_0022_ORDER_ENDPOINTS,
  HY_EXP_0022_TRANSPORT_ENDPOINTS,
  assertHyExp0022EngineeringNeverDevelopmentInput,
  assertHyExp0022EngineeringRoot,
  buildCollectorEngineeringReadiness,
  buildDepthSnapshotUrl,
  buildHyExp0022OosWorkflowDecision,
  buildJustClosedKlineUrl,
  buildBinanceSubscriptionMessage,
  fetchJsonCompleted,
  openHyExp0022AppendOnlyNdjson,
  runHyExp0022EngineeringDryRun,
  selectHyExp0022EngineeringSymbols,
  verifyBinanceTransportCapability
} from '../src/model/hy-exp-0022-collector.mjs';

const FOUR_HOURS_MS = 4 * 60 * 60 * 1_000;

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function response(data, bodyDelay = 0) {
  return {
    ok: true,
    async text() {
      await delay(bodyDelay);
      return JSON.stringify(data);
    }
  };
}

function bookLevels() {
  return {
    bids: Array.from({ length: 1_000 }, (_, index) => [String(100_000 - index), '1']),
    asks: Array.from({ length: 1_000 }, (_, index) => [String(200_000 + index), '1'])
  };
}

class ScenarioWebSocket {
  static depthConnections = 0;
  static klineConnections = 0;
  static invalidFirstDepthSegment = true;

  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.closed = false;
    if (url.includes('/public/stream')) ScenarioWebSocket.depthConnections++;
    if (url.includes('/market/stream')) ScenarioWebSocket.klineConnections++;
    setTimeout(() => this.emit('open'), 1);
  }

  addEventListener(name, handler) {
    const list = this.listeners.get(name) ?? [];
    list.push(handler);
    this.listeners.set(name, list);
  }

  send(value) {
    const request = JSON.parse(value);
    setTimeout(() => this.emit('message', { data: JSON.stringify({ result: null, id: request.id }) }), 1);
    if (this.url.includes('/public/stream')) {
      const invalid = ScenarioWebSocket.depthConnections === 1 && ScenarioWebSocket.invalidFirstDepthSegment;
      for (const [index, stream] of request.params.entries()) {
        const symbol = stream.split('@')[0].toUpperCase();
        const base = 10_000 + index * 1_000;
        const eventAt = Date.now();
        const first = {
          e: 'depthUpdate', E: eventAt, T: eventAt, s: symbol, ps: symbol, st: 1,
          U: 99, u: 101, pu: null, b: [['100000', '1']], a: [['200000', '1']]
        };
        const second = {
          e: 'depthUpdate', E: eventAt + 1, T: eventAt + 1, s: symbol, ps: symbol, st: 1,
          U: invalid ? 103 : 102, u: invalid ? 103 : 102, pu: invalid ? 102 : 101,
          b: [['100000', String(base)]], a: [['200000', '1']]
        };
        setTimeout(() => this.emit('message', { data: JSON.stringify({ stream, data: first }) }), 4);
        setTimeout(() => this.emit('message', { data: JSON.stringify({ stream, data: second }) }), 8);
      }
    } else if (this.url.includes('/market/stream')) {
      for (const stream of request.params) {
        const symbol = stream.split('@')[0].toUpperCase();
        const openTime = Math.floor(Date.now() / FOUR_HOURS_MS) * FOUR_HOURS_MS;
        const payload = {
          e: 'kline', E: Date.now(), s: symbol, ps: symbol, st: 1,
          k: {
            t: openTime, T: openTime + FOUR_HOURS_MS - 1, s: symbol, i: '4h',
            o: '100', c: '101', h: '102', l: '99', v: '1', q: '100', n: 10, x: false
          }
        };
        setTimeout(() => this.emit('message', { data: JSON.stringify({ stream, data: payload }) }), 5);
      }
    }
  }

  emit(name, event = {}) {
    if (this.closed) return;
    for (const handler of this.listeners.get(name) ?? []) handler(event);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    setTimeout(() => {
      for (const handler of this.listeners.get('close') ?? []) handler({ code: 1000 });
    }, 0);
  }
}

function scenarioFetch() {
  const levels = bookLevels();
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
  return async input => {
    const url = String(input);
    await delay(3);
    if (url.endsWith('/exchangeInfo')) {
      return response({
        serverTime: Date.now(),
        symbols: symbols.map((symbol, index) => ({
          symbol,
          baseAsset: symbol.replace('USDT', ''),
          quoteAsset: 'USDT',
          contractType: 'PERPETUAL',
          status: 'TRADING',
          onboardDate: Date.now() - (40 + index) * 86_400_000
        }))
      }, 3);
    }
    if (url.includes('/ticker/24hr')) {
      return response(symbols.map((symbol, index) => ({ symbol, quoteVolume: String(30_000_000 - index * 1_000_000) })), 3);
    }
    if (url.includes('/fundingRate')) {
      const symbol = new URL(url).searchParams.get('symbol');
      return response([{ symbol, fundingRate: '0.0001', fundingTime: Date.now() - 1_000 }], 3);
    }
    if (url.includes('/depth')) {
      return response({ lastUpdateId: 100, bids: levels.bids, asks: levels.asks }, 3);
    }
    if (url.includes('/klines')) {
      const openTime = Number(new URL(url).searchParams.get('startTime'));
      return response([[openTime, '100', '102', '99', '101', '1', openTime + FOUR_HOURS_MS - 1, '100', 10]], 3);
    }
    throw new Error(`unexpected endpoint: ${url}`);
  };
}

test('Phase A uses current documented public and market endpoints, never legacy /stream', () => {
  assert.equal(HY_EXP_0022_TRANSPORT_ENDPOINTS.depth, 'wss://fstream.binance.com/public/stream');
  assert.equal(HY_EXP_0022_TRANSPORT_ENDPOINTS.kline, 'wss://fstream.binance.com/market/stream');
  assert.equal(HY_EXP_0022_TRANSPORT_ENDPOINTS.depth.includes('/stream?'), false);
  assert.equal(HY_EXP_0022_TRANSPORT_ENDPOINTS.kline.includes('/stream?'), false);
  assert.match(buildBinanceSubscriptionMessage({ streams: ['btcusdt@depth@100ms'] }), /SUBSCRIBE/);
  assert.match(buildDepthSnapshotUrl('BTCUSDT'), /limit=1000/);
  assert.match(buildJustClosedKlineUrl({
    symbol: 'BTCUSDT',
    openTime: 1_000,
    closeTime: 1_000 + FOUR_HOURS_MS - 1
  }), /startTime=1000/);
});

test('st=1 is allowed, st=2 is rejected, and st/ps are returned for raw preservation', () => {
  const depth = verifyBinanceTransportCapability({
    kind: 'depth',
    message: { stream: 'btcusdt@depth@100ms', data: { e: 'depthUpdate', s: 'BTCUSDT', st: 1, ps: 'BTCUSDT' } }
  });
  assert.equal(depth.st, 1);
  assert.equal(depth.ps, 'BTCUSDT');
  const kline = verifyBinanceTransportCapability({
    kind: 'kline',
    message: { stream: 'btcusdt@kline_4h', data: { e: 'kline', st: '1', ps: 'BTCUSDT' } }
  });
  assert.equal(kline.st, 1);
  assert.equal(kline.ps, 'BTCUSDT');
  assert.throws(
    () => verifyBinanceTransportCapability({ kind: 'depth', message: { data: { st: 2 } } }),
    error => error.code === 'BINANCE_TRANSPORT_STATUS_REJECTED'
  );
  assert.throws(
    () => verifyBinanceTransportCapability({ kind: 'kline', message: { data: { st: 2 } } }),
    error => error.code === 'BINANCE_TRANSPORT_STATUS_REJECTED'
  );
});

test('REST receivedAt is measured after response body completion', async () => {
  let bodyCompletedAt = 0;
  const result = await fetchJsonCompleted({
    url: 'https://example.invalid/public',
    fetchImpl: async () => ({
      ok: true,
      async text() {
        await delay(20);
        bodyCompletedAt = Date.now();
        return JSON.stringify({ serverTime: 123 });
      }
    })
  });
  assert.ok(result.receivedAt >= bodyCompletedAt);
  assert.ok(result.receivedAt > result.requestStartedAt);
  assert.equal(result.exchangeObservedAt, 123);
  assert.equal(result.bodyCompleted, true);
});

test('engineering root is isolated and never Development eligible', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hengyu-0022-root-'));
  const engineering = assertHyExp0022EngineeringRoot({ projectRoot, outputRoot: path.join(HY_EXP_0022_ENGINEERING_ROOT, 'run') });
  assert.ok(engineering.endsWith(path.join('HY-EXP-0022', 'run')));
  assert.throws(() => assertHyExp0022EngineeringRoot({
    projectRoot,
    outputRoot: path.join('data', 'raw', 'prospective-development', 'HY-EXP-0022')
  }), error => error.code === 'HY_EXP_0022_ENGINEERING_NAMESPACE_MISMATCH');
  assert.throws(() => assertHyExp0022EngineeringNeverDevelopmentInput({
    projectRoot,
    inputPath: path.join(HY_EXP_0022_ENGINEERING_ROOT, 'run')
  }), error => error.code === 'HY_EXP_0022_ENGINEERING_NOT_DEVELOPMENT');
});

test('actual raw writer is append-only', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hengyu-0022-raw-'));
  const file = path.join(directory, 'depth.diff.ndjson');
  const first = openHyExp0022AppendOnlyNdjson(file);
  first.append({ receivedAt: 1, st: 1, ps: 'BTCUSDT' });
  first.close();
  const second = openHyExp0022AppendOnlyNdjson(file);
  second.append({ receivedAt: 2, st: 1, ps: 'BTCUSDT' });
  second.close();
  assert.equal(fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).length, 2);
});

test('OOS evaluation cannot mark Development PASS before Final-OOS capture is sealed', () => {
  assert.deepEqual(buildHyExp0022OosWorkflowDecision({
    developmentStatus: 'NOT_PASS',
    finalOosCaptureComplete: false,
    operation: 'write'
  }).operation, { allowed: true, operation: 'write', mode: 'RAW_CAPTURE_ONLY' });
  assert.throws(() => buildHyExp0022OosWorkflowDecision({
    developmentStatus: 'PASS',
    finalOosCaptureComplete: false,
    operation: 'read_manifest'
  }), error => error.code === 'FINAL_OOS_CAPTURE_NOT_COMPLETE');
  assert.deepEqual(buildHyExp0022OosWorkflowDecision({
    developmentStatus: 'PASS',
    finalOosCaptureComplete: true,
    operation: 'read_manifest'
  }).operation, { allowed: true, operation: 'read_manifest', mode: 'POST_DEVELOPMENT_READ' });
});

test('dynamic engineering selection is not a fixed symbol list and ticker cannot define volume6', () => {
  const now = Date.now();
  const selection = selectHyExp0022EngineeringSymbols({
    observedAt: now,
    maxSymbols: 3,
    exchangeInfo: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'].map((symbol, index) => ({
      symbol,
      baseAsset: symbol.replace('USDT', ''),
      quoteAsset: 'USDT',
      contractType: 'PERPETUAL',
      status: 'TRADING',
      onboardDate: now - (40 + index) * 86_400_000
    })),
    tickers: [
      { symbol: 'SOLUSDT', quoteVolume: '300' },
      { symbol: 'BTCUSDT', quoteVolume: '100' },
      { symbol: 'ETHUSDT', quoteVolume: '200' }
    ]
  });
  assert.deepEqual(selection.symbols, ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
  assert.equal(selection.tickerDiagnosticOnly, true);
  assert.equal(selection.tickerDefinesVolume6, false);
});

test('collector reconnect creates a new segment and leaves an invalid segment invalid', async () => {
  ScenarioWebSocket.depthConnections = 0;
  ScenarioWebSocket.klineConnections = 0;
  ScenarioWebSocket.invalidFirstDepthSegment = true;
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hengyu-0022-collector-'));
  const result = await runHyExp0022EngineeringDryRun({
    projectRoot,
    maxRuntimeMs: 800,
    segmentMaxMs: 70,
    maxSymbols: 3,
    fetchImpl: scenarioFetch(),
    WebSocketImpl: ScenarioWebSocket
  });
  assert.ok(ScenarioWebSocket.depthConnections >= 2);
  assert.ok(result.segments.some(segment => segment.status === 'INVALID'));
  assert.ok(result.segments.some(segment => segment.status === 'VALID'));
  assert.ok(result.segments.every(segment => segment.reconnectCreatesNewSegment === true));
  const depthRows = fs.readFileSync(path.join(result.directory, 'depth.diff.ndjson'), 'utf8')
    .trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.ok(depthRows.some(row => row.st === 1 && row.ps));
  assert.equal(result.manifest.pnlComputed, false);
  assert.equal(result.manifest.developmentAllowed, false);
  assert.equal(result.manifest.finalOosEligible, false);
  const readiness = buildCollectorEngineeringReadiness({ result, requiredDurationMs: 0 });
  assert.equal(readiness.status, 'COLLECTOR_NOT_READY');
});

test('collector exposes no order or account API', () => {
  assert.deepEqual(HY_EXP_0022_ORDER_ENDPOINTS, []);
  assert.deepEqual(HY_EXP_0022_ACCOUNT_ENDPOINTS, []);
});
