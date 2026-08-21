import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  HY_EXP_0020_CAPTURE_ROOTS,
  assertHyExp0020CaptureRoot,
  buildDepthRecordEnvelope,
  buildHyExp0020CaptureMetadata,
  buildHyExp0020RawManifest,
  buildRawCaptureFileEntry,
  createDepthSegmentReconstructor,
  expectedHyExp0020CaptureRoot,
  membershipDiff,
  openAppendOnlyNdjson,
  resolveHyExp0020CaptureMode,
  selectHyExp0020CaptureCandidates,
  writeImmutableCaptureManifest
} from '../src/model/hy-exp-0020-capture-runtime.mjs';
import { runHyExp0020Capture } from '../src/model/hy-exp-0020-capture-runtime.mjs';
import { DEFAULT_UNIVERSE_POLICY } from '../src/model/universe.mjs';

const BEFORE_FINAL = Date.parse('2026-08-21T00:00:00.000Z');
const SYMBOL = 'BTCUSDT';

function book() {
  return {
    bids: Array.from({ length: 1000 }, (_, index) => [1000 - index, 1]),
    asks: Array.from({ length: 1000 }, (_, index) => [2000 + index, 1])
  };
}

function newReconstructor() {
  return createDepthSegmentReconstructor({ symbol: SYMBOL, maxEventGapMs: 1_000 });
}

function seed(state) {
  const levels = book();
  state.ingestSnapshot({
    receivedAt: 1_000,
    data: { s: SYMBOL, lastUpdateId: 100, bids: levels.bids, asks: levels.asks }
  });
}

function diff({ U = 99, u = 101, pu = null, bids = [['1000', '2']], asks = [] } = {}) {
  return { e: 'depthUpdate', E: 1_100 + u, T: 1_099 + u, s: SYMBOL, U, u, pu, b: bids, a: asks };
}

function response(data, onBodyComplete = () => {}) {
  return {
    ok: true,
    status: 200,
    async json() {
      await new Promise(resolve => setTimeout(resolve, 8));
      onBodyComplete(Date.now());
      return data;
    }
  };
}

class FakeWebSocket {
  static connections = 0;

  constructor() {
    this.listeners = new Map();
    FakeWebSocket.connections++;
    setImmediate(() => {
      this.emit('open', {});
      setTimeout(() => this.emit('message', { data: JSON.stringify({
        e: 'depthUpdate', E: Date.now(), T: Date.now(), s: SYMBOL,
        U: 99, u: 101, pu: null, b: [['1000', '2']], a: []
      }) }), 1);
      setTimeout(() => this.emit('message', { data: JSON.stringify({
        e: 'depthUpdate', E: Date.now(), T: Date.now(), s: SYMBOL,
        U: 102, u: 102, pu: 101, b: [], a: [['2000', '2']]
      }) }), 4);
    });
  }

  addEventListener(name, handler) {
    const handlers = this.listeners.get(name) ?? [];
    handlers.push(handler);
    this.listeners.set(name, handlers);
  }

  emit(name, event) {
    for (const handler of this.listeners.get(name) ?? []) handler(event);
  }

  close() {
    this.emit('close', {});
  }
}

class ScenarioWebSocket {
  static config = null;
  static connections = 0;

  constructor() {
    this.listeners = new Map();
    this.closed = false;
    const config = ScenarioWebSocket.config;
    const connectionNumber = ++ScenarioWebSocket.connections;
    setImmediate(() => {
      if (this.closed) return;
      this.emit('open', {});
      const events = typeof config.events === 'function'
        ? config.events({ connectionNumber })
        : config.events;
      for (const event of events ?? []) {
        setTimeout(() => {
          if (this.closed) return;
          const at = Date.now();
          config.timeline.emissions.push({ symbol: event.symbol, U: event.U, u: event.u, at });
          this.emit('message', { data: JSON.stringify({
            e: 'depthUpdate',
            E: at,
            T: at,
            s: event.symbol,
            U: event.U,
            u: event.u,
            pu: event.pu ?? null,
            b: event.bids ?? [['1000', '2']],
            a: event.asks ?? []
          }) });
        }, event.atMs);
      }
    });
  }

  addEventListener(name, handler) {
    const handlers = this.listeners.get(name) ?? [];
    handlers.push(handler);
    this.listeners.set(name, handlers);
  }

  emit(name, event) {
    for (const handler of this.listeners.get(name) ?? []) handler(event);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', {});
  }
}

async function runCombinedScenario({
  symbols,
  snapshotIds = {},
  snapshotDelays = {},
  events,
  maxRuntimeMs = 500
}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hengyu-0020-alignment-'));
  const levels = book();
  const timeline = { emissions: [], snapshots: {}, snapshotRecords: [] };
  const snapshotRequestCounts = new Map();
  const exchangeSymbols = symbols.map(symbol => ({
    symbol,
    onboardDate: Date.parse('2023-01-01T00:00:00.000Z'),
    status: 'TRADING',
    contractType: 'PERPETUAL',
    baseAsset: symbol.replace(/USDT$/, ''),
    quoteAsset: 'USDT'
  }));
  const fetchImpl = async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/depth')) {
      const symbol = url.searchParams.get('symbol');
      const snapshotAttempt = (snapshotRequestCounts.get(symbol) ?? 0) + 1;
      snapshotRequestCounts.set(symbol, snapshotAttempt);
      const configuredDelay = snapshotDelays[symbol];
      const delayMs = Array.isArray(configuredDelay)
        ? (configuredDelay[snapshotAttempt - 1] ?? configuredDelay.at(-1) ?? 0)
        : (typeof configuredDelay === 'function' ? configuredDelay(snapshotAttempt) : (configuredDelay ?? 0));
      await new Promise(resolve => setTimeout(resolve, delayMs));
      const configuredId = snapshotIds[symbol];
      const lastUpdateId = Array.isArray(configuredId)
        ? (configuredId[snapshotAttempt - 1] ?? configuredId.at(-1))
        : (typeof configuredId === 'function' ? configuredId(snapshotAttempt) : (configuredId ?? 100));
      return response(
        { lastUpdateId, bids: levels.bids, asks: levels.asks },
        () => {
          const receivedAt = Date.now();
          timeline.snapshots[symbol] = receivedAt;
          timeline.snapshotRecords.push({ symbol, snapshotAttempt, receivedAt, lastUpdateId });
        }
      );
    }
    if (url.pathname.endsWith('/fundingRate')) {
      return response([{ symbol: url.searchParams.get('symbol'), fundingRate: '0.0001', fundingTime: Date.now() }]);
    }
    if (url.pathname.endsWith('/exchangeInfo')) return response({ symbols: exchangeSymbols });
    if (url.pathname.endsWith('/ticker/24hr')) {
      return response(symbols.map(symbol => ({ symbol, quoteVolume: '10000000' })));
    }
    throw new Error(`unexpected scenario endpoint: ${url}`);
  };
  ScenarioWebSocket.connections = 0;
  ScenarioWebSocket.config = { events, timeline };
  try {
    const result = await runHyExp0020Capture({
      projectRoot,
      requestedMode: 'ENGINEERING_DRY_RUN',
      now: BEFORE_FINAL,
      maxRuntimeMs,
      fundingPollMs: 10_000,
      exchangeInfoPollMs: 10_000,
      reconnectBackoffMs: 1,
      universePolicy: { ...DEFAULT_UNIVERSE_POLICY, maxSymbols: symbols.length, minTierBQuoteVolumeUsdt: 0 },
      fetchImpl,
      WebSocketImpl: ScenarioWebSocket
    });
    return { result, timeline };
  } finally {
    ScenarioWebSocket.config = null;
  }
}

test('capture mode is forced to engineering dry-run before final OOS and rejects final mode', () => {
  assert.equal(resolveHyExp0020CaptureMode({ requestedMode: 'ENGINEERING_DRY_RUN', now: BEFORE_FINAL }), 'ENGINEERING_DRY_RUN');
  assert.throws(
    () => resolveHyExp0020CaptureMode({ requestedMode: 'FINAL_OOS', now: BEFORE_FINAL }),
    /locked until 2026-09-01/
  );
});

test('dry-run and final OOS roots are distinct and custom mixing is rejected', () => {
  const projectRoot = 'E:/Codex/Hengyu';
  const dryRoot = expectedHyExp0020CaptureRoot({ projectRoot, mode: 'ENGINEERING_DRY_RUN' });
  const finalRoot = expectedHyExp0020CaptureRoot({ projectRoot, mode: 'FINAL_OOS' });
  assert.notEqual(dryRoot, finalRoot);
  assert.ok(dryRoot.endsWith(path.join(...HY_EXP_0020_CAPTURE_ROOTS.engineeringDryRun.split(path.sep))));
  assert.equal(assertHyExp0020CaptureRoot({ projectRoot, mode: 'ENGINEERING_DRY_RUN', outputRoot: dryRoot }), dryRoot);
  assert.throws(
    () => assertHyExp0020CaptureRoot({ projectRoot, mode: 'ENGINEERING_DRY_RUN', outputRoot: finalRoot }),
    /isolated/
  );
});

test('capture metadata is paper-only and dry-run is ineligible for training and final OOS', () => {
  const metadata = buildHyExp0020CaptureMetadata({
    mode: 'ENGINEERING_DRY_RUN', runId: 'dry-run', startedAt: BEFORE_FINAL, symbols: [SYMBOL]
  });
  assert.equal(metadata.authorization, 'PAPER_ONLY');
  assert.equal(metadata.apiTradingEnabled, false);
  assert.equal(metadata.orderApiEnabled, false);
  assert.equal(metadata.pnlComputed, false);
  assert.equal(metadata.trainingEligible, false);
  assert.equal(metadata.finalOosEligible, false);
  assert.equal(metadata.dataClass, 'ENGINEERING_DRY_RUN');
});

test('dynamic capture candidates use frozen quote/status/listing/stable-base/volume policy and membership diffs are explicit', () => {
  const observedAt = Date.parse('2026-08-22T00:00:00.000Z');
  const policy = {
    allowedQuoteAssets: ['USDT', 'USDC'],
    minListingAgeMs: 30 * 86_400_000,
    minTierBQuoteVolumeUsdt: 1_000_000,
    maxSymbols: 2,
    excludedBaseAssets: ['USDT', 'USDC', 'BUSD']
  };
  const result = selectHyExp0020CaptureCandidates({
    observedAt,
    policy,
    exchangeInfo: [
      { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING', onboardDate: observedAt - 40 * 86_400_000 },
      { symbol: 'USDCUSDT', baseAsset: 'USDC', quoteAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING', onboardDate: observedAt - 40 * 86_400_000 },
      { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING', onboardDate: observedAt - 10 * 86_400_000 },
      { symbol: 'XRPUSD', baseAsset: 'XRP', quoteAsset: 'USD', contractType: 'PERPETUAL', status: 'TRADING', onboardDate: observedAt - 40 * 86_400_000 },
      { symbol: 'INVALID.SYMBOL', baseAsset: 'INVALID', quoteAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING', onboardDate: observedAt - 40 * 86_400_000 }
    ],
    tickers: [
      { symbol: 'BTCUSDT', quoteVolume: '5000000' },
      { symbol: 'USDCUSDT', quoteVolume: '5000000' },
      { symbol: 'ETHUSDT', quoteVolume: '5000000' },
      { symbol: 'XRPUSD', quoteVolume: '5000000' },
      { symbol: 'INVALID.SYMBOL', quoteVolume: '5000000' }
    ]
  });
  assert.deepEqual(result.symbols, ['BTCUSDT']);
  assert.ok(result.excluded.some(row => row.symbol === 'USDCUSDT' && row.reasons.includes('excluded_base_asset')));
  assert.ok(result.excluded.some(row => row.symbol === 'INVALID.SYMBOL' && row.reasons.includes('invalid_symbol')));
  assert.deepEqual(membershipDiff(['BTCUSDT', 'ETHUSDT'], ['BTCUSDT', 'SOLUSDT']), {
    added: ['SOLUSDT'], removed: ['ETHUSDT'], unchanged: ['BTCUSDT']
  });
});

test('append-only NDJSON preserves raw records and never truncates an existing file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hengyu-0020-raw-'));
  const file = path.join(directory, 'raw.ndjson');
  const first = openAppendOnlyNdjson(file);
  first.append({ receivedAt: 1, data: 'first' });
  first.close();
  const second = openAppendOnlyNdjson(file);
  second.append({ receivedAt: 2, data: 'second' });
  second.close();
  assert.deepEqual(fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line)), [
    { receivedAt: 1, data: 'first' }, { receivedAt: 2, data: 'second' }
  ]);
});

test('depth reconstructor aligns REST snapshot, accepts first null pu, and enforces later continuity', () => {
  const state = newReconstructor();
  seed(state);
  const first = state.ingestDiff({ data: diff(), receivedAt: 1_100 });
  assert.equal(first.lastUpdateId, 101);
  const second = state.ingestDiff({ data: diff({ U: 102, u: 102, pu: 101, asks: [['2000', '2']] }), receivedAt: 1_200 });
  assert.equal(second.lastUpdateId, 102);
  assert.equal(state.summary.updates, 2);
});

test('depth reconstructor marks duplicate, gap, out-of-order and crossed segments invalid', () => {
  const duplicate = newReconstructor();
  seed(duplicate);
  duplicate.ingestDiff({ data: diff(), receivedAt: 1_100 });
  assert.throws(() => duplicate.ingestDiff({ data: diff(), receivedAt: 1_200 }), /duplicate_update/);

  const gap = newReconstructor();
  seed(gap);
  gap.ingestDiff({ data: diff(), receivedAt: 1_100 });
  assert.throws(() => gap.ingestDiff({ data: diff({ U: 103, u: 103, pu: 102 }), receivedAt: 1_200 }), /sequence_gap/);

  const outOfOrder = newReconstructor();
  seed(outOfOrder);
  outOfOrder.ingestDiff({ data: diff(), receivedAt: 1_100 });
  assert.throws(() => outOfOrder.ingestDiff({ data: diff({ U: 102, u: 102, pu: 101 }), receivedAt: 1_050 }), /out_of_order_receipt/);

  const crossed = newReconstructor();
  seed(crossed);
  assert.throws(() => crossed.ingestDiff({ data: diff({ bids: [['1000', '0']], asks: [['999', '2']] }), receivedAt: 1_100 }), /crossed_book/);
});

test('depth record envelopes preserve receipt and do not synthesize REST snapshot E/T', () => {
  const snapshot = buildDepthRecordEnvelope({
    symbol: SYMBOL,
    kind: 'snapshot',
    segmentId: 'segment-1',
    receivedAt: 1234,
    data: { s: SYMBOL, lastUpdateId: 10, bids: [['100', '1']], asks: [['101', '1']] }
  });
  assert.equal(snapshot.receivedAt, 1234);
  assert.equal(snapshot.data.E, undefined);
  assert.equal(snapshot.data.T, undefined);
});

test('raw manifest hashes every append-only file and immutable manifest cannot be rewritten', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hengyu-0020-manifest-'));
  const rawFile = path.join(directory, 'depth.ndjson');
  fs.writeFileSync(rawFile, '{"kind":"diff"}\n');
  const metadata = buildHyExp0020CaptureMetadata({
    mode: 'ENGINEERING_DRY_RUN', runId: 'dry-run', startedAt: BEFORE_FINAL, symbols: [SYMBOL]
  });
  const manifest = buildHyExp0020RawManifest({
    metadata,
    startedAt: BEFORE_FINAL,
    finishedAt: BEFORE_FINAL + 1000,
    files: [buildRawCaptureFileEntry({ root: directory, filePath: rawFile })],
    segments: [{ segmentId: 'segment-1', symbol: SYMBOL, status: 'VALID' }]
  });
  assert.equal(manifest.status, 'complete');
  assert.equal(manifest.finalOosEligible, false);
  const written = writeImmutableCaptureManifest({ directory, manifest });
  assert.match(fs.readFileSync(written.manifestPath, 'utf8'), /"pnlComputed": false/);
  assert.throws(() => writeImmutableCaptureManifest({ directory, manifest }), /EEXIST/);
});

test('final mode is allowed only inside the frozen OOS window', () => {
  assert.equal(resolveHyExp0020CaptureMode({ requestedMode: 'FINAL_OOS', now: Date.parse('2026-09-01T00:00:00.000Z') }), 'FINAL_OOS');
  assert.throws(
    () => resolveHyExp0020CaptureMode({ requestedMode: 'FINAL_OOS', now: Date.parse('2027-03-01T00:00:00.000Z') }),
    /window is closed/
  );
});

test('engineering dry-run collector captures public snapshot/diff/funding/exchangeInfo and writes an isolated manifest', async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hengyu-0020-collector-'));
  const levels = book();
  const bodyCompletedAt = new Map();
  const bodyDone = name => timestamp => bodyCompletedAt.set(name, timestamp);
  const fetchImpl = async input => {
    await new Promise(resolve => setTimeout(resolve, 8));
    const url = String(input);
    if (url.includes('/depth?')) return response({ lastUpdateId: 100, bids: levels.bids, asks: levels.asks }, bodyDone('depth'));
    if (url.includes('/fundingRate')) return response([{ symbol: SYMBOL, fundingRate: '0.0001', fundingTime: Date.now() }], bodyDone('funding'));
    if (url.includes('/exchangeInfo')) return response({ serverTime: 1_700_000_000_000, symbols: [{
      symbol: SYMBOL,
      onboardDate: Date.parse('2023-01-01T00:00:00.000Z'),
      status: 'TRADING',
      contractType: 'PERPETUAL',
      baseAsset: 'BTC',
      quoteAsset: 'USDT'
    }] }, bodyDone('exchangeInfo'));
    if (url.includes('/ticker/24hr')) return response([{ symbol: SYMBOL, quoteVolume: '10000000' }], bodyDone('ticker'));
    throw new Error(`unexpected fake endpoint: ${url}`);
  };
  FakeWebSocket.connections = 0;
  const result = await runHyExp0020Capture({
    projectRoot,
    requestedMode: 'ENGINEERING_DRY_RUN',
    now: BEFORE_FINAL,
    maxRuntimeMs: 2_000,
    fundingPollMs: 10_000,
    exchangeInfoPollMs: 10_000,
    reconnectBackoffMs: 1,
    universePolicy: DEFAULT_UNIVERSE_POLICY,
    fetchImpl,
    WebSocketImpl: FakeWebSocket
  });
  assert.equal(result.mode, 'ENGINEERING_DRY_RUN');
  assert.equal(result.manifest.pnlComputed, false);
  assert.equal(result.manifest.trainingEligible, false);
  assert.equal(result.manifest.finalOosEligible, false);
  assert.equal(result.manifest.status, 'complete');
  assert.equal(FakeWebSocket.connections, 1);
  for (const fileName of ['depth-snapshots.ndjson', 'funding.ndjson', 'exchange-info.ndjson', 'ticker.ndjson']) {
    const rows = fs.readFileSync(path.join(result.directory, fileName), 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
    assert.ok(rows.length > 0, `${fileName} should contain a response`);
    for (const row of rows) assert.ok(row.receivedAt > row.requestStartedAt, `${fileName} must record body completion after request start`);
  }
  const timingNames = { 'depth-snapshots.ndjson': 'depth', 'funding.ndjson': 'funding', 'exchange-info.ndjson': 'exchangeInfo', 'ticker.ndjson': 'ticker' };
  for (const [fileName, name] of Object.entries(timingNames)) {
    const row = JSON.parse(fs.readFileSync(path.join(result.directory, fileName), 'utf8').trim().split(/\r?\n/)[0]);
    assert.ok(row.receivedAt >= bodyCompletedAt.get(name), `${fileName} receipt must follow response body completion`);
  }
  const exchangeRow = JSON.parse(fs.readFileSync(path.join(result.directory, 'exchange-info.ndjson'), 'utf8').trim());
  assert.equal(exchangeRow.exchangeObservedAt, 1_700_000_000_000);
  assert.equal(result.manifest.diagnostics.snapshotAlignmentFailures, 0);
  assert.equal(result.manifest.segments[0].perSymbol.BTCUSDT.updates, 2);
  assert.ok(result.manifest.files.some(file => file.path === 'exchange-info.ndjson'));
  assert.ok(result.manifest.files.some(file => file.path === 'ticker.ndjson'));
  assert.ok(result.manifest.files.some(file => file.path === 'universe.ndjson'));
  assert.ok(result.manifest.files.some(file => file.path === 'funding.ndjson'));
  assert.ok(result.directory.includes(path.join('data', 'raw', 'engineering-dry-run', 'HY-EXP-0020')));
  assert.equal(fs.existsSync(path.join(result.directory, 'manifest.sha256')), true);
});

test('combined depth alignment drops only stale per-symbol buffered events before the covering event', async () => {
  const { result } = await runCombinedScenario({
    symbols: ['BTCUSDT'],
    snapshotIds: { BTCUSDT: 100 },
    events: [
      { symbol: 'BTCUSDT', atMs: 1, U: 80, u: 90 },
      { symbol: 'BTCUSDT', atMs: 3, U: 91, u: 99 },
      { symbol: 'BTCUSDT', atMs: 60, U: 99, u: 101 },
      { symbol: 'BTCUSDT', atMs: 80, U: 102, u: 102, pu: 101 }
    ],
    maxRuntimeMs: 300
  });
  const segment = result.manifest.segments[0];
  assert.equal(segment.status, 'VALID');
  assert.equal(segment.perSymbol.BTCUSDT.status, 'ALIGNED');
  assert.equal(segment.perSymbol.BTCUSDT.alignmentFailure, null);
  assert.equal(segment.perSymbol.BTCUSDT.bufferedEventsRemaining, 0);
  assert.equal(segment.perSymbol.BTCUSDT.staleBufferedDropped, 2);
  assert.equal(segment.perSymbol.BTCUSDT.updates, 2);
  assert.equal(result.manifest.diagnostics.snapshotAlignmentFailures, 0);
});

test('combined depth snapshots align independently while another symbol remains buffered', async () => {
  const { result, timeline } = await runCombinedScenario({
    symbols: ['BTCUSDT', 'ETHUSDT'],
    snapshotIds: { BTCUSDT: 100, ETHUSDT: 100 },
    snapshotDelays: { BTCUSDT: 10, ETHUSDT: 500 },
    events: [
      { symbol: 'BTCUSDT', atMs: 30, U: 99, u: 101 },
      { symbol: 'ETHUSDT', atMs: 40, U: 99, u: 101 },
      { symbol: 'BTCUSDT', atMs: 100, U: 102, u: 102, pu: 101 },
      { symbol: 'ETHUSDT', atMs: 120, U: 102, u: 102, pu: 101 }
    ],
    maxRuntimeMs: 1_700
  });
  const segment = result.manifest.segments[0];
  assert.equal(segment.status, 'VALID');
  assert.equal(segment.perSymbol.BTCUSDT.status, 'ALIGNED');
  assert.equal(segment.perSymbol.ETHUSDT.status, 'ALIGNED');
  assert.equal(segment.perSymbol.BTCUSDT.updates, 2);
  assert.equal(segment.perSymbol.ETHUSDT.updates, 2);
  assert.equal(segment.perSymbol.BTCUSDT.bufferedEventsRemaining, 0);
  assert.equal(segment.perSymbol.ETHUSDT.bufferedEventsRemaining, 0);
  assert.ok(result.manifest.diagnostics.alignmentLatencyMs.BTCUSDT < result.manifest.diagnostics.alignmentLatencyMs.ETHUSDT);
  assert.ok(result.manifest.diagnostics.bufferedEventsPeak >= 2);
  assert.ok(segment.perSymbol.BTCUSDT.alignmentLatencyMs < segment.perSymbol.ETHUSDT.alignmentLatencyMs);
  assert.ok(timeline.emissions.find(event => event.symbol === 'BTCUSDT' && event.u === 102).at < timeline.snapshots.ETHUSDT);
  assert.ok(result.manifest.diagnostics.snapshotAlignmentFailures === 0);
});

test('combined depth alignment fails closed when no buffered event covers the snapshot update id', async () => {
  const { result } = await runCombinedScenario({
    symbols: ['BTCUSDT'],
    snapshotIds: { BTCUSDT: 100 },
    events: [{ symbol: 'BTCUSDT', atMs: 1, U: 80, u: 90 }],
    maxRuntimeMs: 250
  });
  const segment = result.manifest.segments[0];
  assert.equal(result.manifest.status, 'DATA_FAIL');
  assert.equal(segment.status, 'INVALID');
  assert.match(segment.reason, /snapshot_alignment/);
  assert.match(segment.perSymbol.BTCUSDT.alignmentFailure, /snapshot_alignment/);
  assert.ok(result.manifest.diagnostics.snapshotAlignmentFailures >= 1);
});

test('combined depth alignment fails closed on a post-alignment pu chain interruption', async () => {
  const { result } = await runCombinedScenario({
    symbols: ['BTCUSDT'],
    snapshotIds: { BTCUSDT: 100 },
    events: [
      { symbol: 'BTCUSDT', atMs: 20, U: 99, u: 101 },
      { symbol: 'BTCUSDT', atMs: 60, U: 103, u: 103, pu: 102 }
    ],
    maxRuntimeMs: 250
  });
  const segment = result.manifest.segments[0];
  assert.equal(result.manifest.status, 'DATA_FAIL');
  assert.equal(segment.status, 'INVALID');
  assert.match(segment.reason, /sequence_gap/);
  assert.ok(result.manifest.diagnostics.sequenceGaps >= 1);
});

test('snapshot-too-old initialization reacquires a fresh snapshot and aligns from the retained buffer', async () => {
  const { result } = await runCombinedScenario({
    symbols: ['BTCUSDT'],
    snapshotIds: { BTCUSDT: [100, 121] },
    events: [{ symbol: 'BTCUSDT', atMs: 1, U: 120, u: 130 }],
    maxRuntimeMs: 1_000
  });
  const segment = result.manifest.segments[0];
  assert.equal(segment.status, 'VALID');
  assert.equal(segment.perSymbol.BTCUSDT.status, 'ALIGNED');
  assert.equal(segment.perSymbol.BTCUSDT.snapshotAttempts, 2);
  assert.equal(segment.perSymbol.BTCUSDT.snapshotTooOldRetries, 1);
  assert.equal(segment.perSymbol.BTCUSDT.alignmentSuccesses, 1);
  assert.equal(segment.perSymbol.BTCUSDT.updates, 1);
  assert.equal(result.manifest.diagnostics.snapshotAlignmentFailures, 0);
  const snapshots = fs.readFileSync(path.join(result.directory, 'depth-snapshots.ndjson'), 'utf8')
    .trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.deepEqual(snapshots.map(row => row.snapshotAttempt), [1, 2]);
});

test('bounded snapshot reacquisition fails closed after five non-overlapping snapshots', async () => {
  const { result } = await runCombinedScenario({
    symbols: ['BTCUSDT'],
    snapshotIds: { BTCUSDT: [100, 101, 102, 103, 104] },
    events: [{ symbol: 'BTCUSDT', atMs: 1, U: 120, u: 130 }],
    maxRuntimeMs: 3_000
  });
  const segment = result.manifest.segments[0];
  assert.equal(result.manifest.status, 'DATA_FAIL');
  assert.equal(segment.status, 'INVALID');
  assert.match(segment.reason, /snapshot_alignment/);
  assert.equal(segment.perSymbol.BTCUSDT.snapshotAttempts, 5);
  assert.equal(segment.perSymbol.BTCUSDT.snapshotTooOldRetries, 4);
  assert.equal(segment.perSymbol.BTCUSDT.alignmentSuccesses, 0);
  assert.ok(result.manifest.diagnostics.snapshotAlignmentFailures >= 1);
});

test('an aligned pu gap fails the segment without snapshot refetch', async () => {
  const { result } = await runCombinedScenario({
    symbols: ['BTCUSDT'],
    snapshotIds: { BTCUSDT: 100 },
    events: [
      { symbol: 'BTCUSDT', atMs: 20, U: 99, u: 101 },
      { symbol: 'BTCUSDT', atMs: 60, U: 103, u: 103, pu: 102 }
    ],
    maxRuntimeMs: 300
  });
  const segment = result.manifest.segments[0];
  assert.equal(result.manifest.status, 'DATA_FAIL');
  assert.match(segment.reason, /sequence_gap/);
  assert.equal(segment.perSymbol.BTCUSDT.snapshotAttempts, 1);
  assert.equal(segment.perSymbol.BTCUSDT.snapshotTooOldRetries, 0);
  assert.equal(result.manifest.diagnostics.snapshotAlignmentFailures, 0);
  assert.ok(result.manifest.diagnostics.sequenceGaps >= 1);
});

test('one symbol can reacquire while another symbol is already aligned and processing live diffs', async () => {
  const { result, timeline } = await runCombinedScenario({
    symbols: ['BTCUSDT', 'ETHUSDT'],
    snapshotIds: { BTCUSDT: [100, 121], ETHUSDT: 100 },
    events: [
      { symbol: 'BTCUSDT', atMs: 1, U: 120, u: 130 },
      { symbol: 'ETHUSDT', atMs: 30, U: 99, u: 101 },
      { symbol: 'ETHUSDT', atMs: 650, U: 102, u: 102, pu: 101 }
    ],
    maxRuntimeMs: 1_800
  });
  const segment = result.manifest.segments[0];
  assert.equal(segment.status, 'VALID');
  assert.equal(segment.perSymbol.BTCUSDT.snapshotAttempts, 2);
  assert.equal(segment.perSymbol.BTCUSDT.alignmentSuccesses, 1);
  assert.equal(segment.perSymbol.ETHUSDT.status, 'ALIGNED');
  assert.equal(segment.perSymbol.ETHUSDT.snapshotAttempts, 1);
  assert.equal(segment.perSymbol.ETHUSDT.updates, 2);
  assert.ok(timeline.snapshotRecords.some(row => row.symbol === 'BTCUSDT' && row.snapshotAttempt === 2));
  assert.equal(result.manifest.diagnostics.snapshotAlignmentFailures, 0);
});
