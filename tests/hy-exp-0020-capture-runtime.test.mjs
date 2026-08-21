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
  openAppendOnlyNdjson,
  resolveHyExp0020CaptureMode,
  writeImmutableCaptureManifest
} from '../src/model/hy-exp-0020-capture-runtime.mjs';
import { runHyExp0020Capture } from '../src/model/hy-exp-0020-capture-runtime.mjs';

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

function response(data) {
  return { ok: true, status: 200, async json() { return data; } };
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
  const fetchImpl = async input => {
    const url = String(input);
    if (url.includes('/depth?')) return response({ lastUpdateId: 100, bids: levels.bids, asks: levels.asks });
    if (url.includes('/fundingRate')) return response([{ symbol: SYMBOL, fundingRate: '0.0001', fundingTime: Date.now() }]);
    if (url.includes('/exchangeInfo')) return response({ symbols: [{ symbol: SYMBOL, status: 'TRADING' }] });
    if (url.includes('/ticker/24hr')) return response([{ symbol: SYMBOL, quoteVolume: '1000000' }]);
    throw new Error(`unexpected fake endpoint: ${url}`);
  };
  FakeWebSocket.connections = 0;
  const result = await runHyExp0020Capture({
    projectRoot,
    requestedMode: 'ENGINEERING_DRY_RUN',
    now: BEFORE_FINAL,
    symbols: [SYMBOL],
    maxRuntimeMs: 100,
    fundingPollMs: 10_000,
    exchangeInfoPollMs: 10_000,
    reconnectBackoffMs: 1,
    fetchImpl,
    WebSocketImpl: FakeWebSocket
  });
  assert.equal(result.mode, 'ENGINEERING_DRY_RUN');
  assert.equal(result.manifest.pnlComputed, false);
  assert.equal(result.manifest.trainingEligible, false);
  assert.equal(result.manifest.finalOosEligible, false);
  assert.equal(result.manifest.status, 'complete');
  assert.equal(FakeWebSocket.connections, 1);
  assert.ok(result.manifest.files.some(file => file.path === 'exchange-info.ndjson'));
  assert.ok(result.manifest.files.some(file => file.path === 'universe.ndjson'));
  assert.ok(result.manifest.files.some(file => file.path === 'funding.ndjson'));
  assert.ok(result.directory.includes(path.join('data', 'raw', 'engineering-dry-run', 'HY-EXP-0020')));
  assert.equal(fs.existsSync(path.join(result.directory, 'manifest.sha256')), true);
});
