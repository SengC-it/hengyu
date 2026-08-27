import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createPerSymbolDepthBook,
  createHyData0036Runtime,
  HY_DATA_0036_RUNTIME_SAFETY
} from '../src/data/hy-data-0036-runtime.mjs';
import {
  createBinancePublicRestGovernor,
  parseRetryAfter
} from '../src/data/hy-data-0036-rest.mjs';
import {
  createCausalFeatureBuilder,
  HY_DATA_0036_RUNTIME_FEATURE_FIELDS
} from '../src/data/hy-data-0036-features.mjs';
import {
  createEngineeringFeatureStore,
  verifyFeatureManifest,
  verifyFeatureManifestFiles
} from '../src/data/hy-data-0036-feature-store.mjs';
import {
  createS3CompatibleSealedPartitionAdapter,
  evaluateStorageCapacity
} from '../src/data/hy-data-0036-storage.mjs';
import { readHostNtpEvidence } from '../src/data/hy-data-0036-clock.mjs';
import { runEngineeringPreflight } from '../src/data/hy-data-0036-preflight.mjs';

const NOW = Date.parse('2026-08-27T00:00:00.000Z');

function depthUpdate(U, u, pu = null, symbol = 'BTCUSDT', eventTime = NOW) {
  return {
    symbol,
    U,
    u,
    pu,
    bids: [[99, 2]],
    asks: [[101, 3]],
    eventTime
  };
}

function depthSnapshot(lastUpdateId = 100) {
  return { lastUpdateId, bids: [['99', '2']], asks: [['101', '3']] };
}

function headers(values = {}) {
  const normalized = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return { get: name => normalized.get(String(name).toLowerCase()) ?? null };
}

function restResponse(body, { status = 200, headers: responseHeaders = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headers(responseHeaders),
    text: async () => body
  };
}

function fakeGovernor(overrides = {}) {
  return {
    state: () => ({ blocked: false, status: 'READY' }),
    request: async () => ({
      response: restResponse('{"serverTime":1}'),
      body: '{"serverTime":1}',
      requestStartedAt: NOW,
      receivedAt: NOW + 1,
      responseMeta: { status: 200, requestStartedAt: NOW, receivedAt: NOW + 1 }
    }),
    diagnostics: {
      requestCount: 1,
      http429Count: 0,
      http418Count: 0,
      rateGovernorCooldownCount: 0,
      retryCount: 0,
      retryAfterObserved: [],
      maxUsedWeight: 1,
      depthSnapshotRequestCount: 0
    },
    responseLog: () => [],
    ...overrides
  };
}

class PreflightSocket {
  constructor() {
    this.listeners = new Map();
    queueMicrotask(() => this.emit('open'));
  }

  addEventListener(event, listener) {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  emit(event, value = {}) {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }

  send() {
    queueMicrotask(() => this.emit('message', { data: JSON.stringify({ result: null, id: 1 }) }));
  }

  close() {}
}

test('REST Retry-After parsing and global governor timing are fail-closed and observable', async () => {
  assert.equal(parseRetryAfter('2', NOW), 2_000);
  assert.equal(parseRetryAfter(new Date(NOW + 3_000).toUTCString(), NOW), 3_000);
  assert.equal(parseRetryAfter('not-a-date', NOW), null);

  let clock = NOW;
  let calls = 0;
  const governor = createBinancePublicRestGovernor({
    now: () => clock,
    sleep: async milliseconds => { clock += milliseconds; },
    fetchImpl: async () => {
      calls += 1;
      clock += 1;
      if (calls === 1) return restResponse('{}', { status: 429, headers: { 'Retry-After': '2', 'X-MBX-USED-WEIGHT-1M': '10', Date: 'Wed, 01 Jan 2020 00:00:00 GMT' } });
      return restResponse('{"ok":true}', { headers: { 'X-MBX-USED-WEIGHT-1M': '12' } });
    },
    random: () => 0
  });
  const result = await governor.request('https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT&limit=1000');
  assert.equal(result.response.status, 200);
  assert.equal(calls, 2);
  assert.equal(governor.diagnostics.http429Count, 1);
  assert.deepEqual(governor.diagnostics.retryAfterObserved, [2_000]);
  assert.equal(governor.diagnostics.maxUsedWeight, 12);
  assert.ok(result.receivedAt > result.requestStartedAt);
  assert.ok(governor.responseLog().every(entry => entry.receivedAt >= entry.requestStartedAt));
  assert.equal(governor.responseLog()[0].status, 429);
});

test('418 enters a global IP-ban state without retry or IP rotation, and missing Retry-After fails closed', async () => {
  let calls = 0;
  const banned = createBinancePublicRestGovernor({
    now: () => NOW,
    fetchImpl: async () => { calls += 1; return restResponse('{}', { status: 418, headers: { 'Retry-After': '10' } }); }
  });
  await assert.rejects(banned.request('https://fapi.binance.com/fapi/v1/time'), error => error.code === 'IP_RATE_LIMIT_BANNED');
  await assert.rejects(banned.request('https://fapi.binance.com/fapi/v1/time'), error => error.code === 'IP_RATE_LIMIT_BANNED');
  assert.equal(calls, 1);
  assert.equal(banned.diagnostics.http418Count, 1);

  const missing = createBinancePublicRestGovernor({
    fetchImpl: async () => restResponse('{}', { status: 429 })
  });
  await assert.rejects(missing.request('https://fapi.binance.com/fapi/v1/time'), error => error.code === 'RATE_LIMIT_RETRY_AFTER_MISSING');
});

test('depth state distinguishes snapshot-too-old, retained bridge, timeout, and bounded buffer overflow', () => {
  const tooOld = createPerSymbolDepthBook({ symbol: 'BTCUSDT', maxBufferedEvents: 10 });
  tooOld.buffer(depthUpdate(120, 130));
  assert.equal(tooOld.align(depthSnapshot(100), NOW).reason, 'SNAPSHOT_TOO_OLD');
  assert.equal(tooOld.diagnostics().snapshotTooOld, 1);

  const bridge = createPerSymbolDepthBook({ symbol: 'ETHUSDT', maxBufferedEvents: 10 });
  bridge.buffer(depthUpdate(200, 205, null, 'ETHUSDT'));
  assert.equal(bridge.align(depthSnapshot(210), NOW).reason, 'SNAPSHOT_AHEAD_WAITING_BRIDGE');
  assert.equal(bridge.buffer(depthUpdate(206, 210, 205, 'ETHUSDT'), NOW + 1).ok, true);
  assert.equal(bridge.status, 'ALIGNED');
  assert.equal(bridge.diagnostics().bridgeWaitSuccess, 1);

  const timedOut = createPerSymbolDepthBook({ symbol: 'BNBUSDT', maxBufferedEvents: 10 });
  timedOut.buffer(depthUpdate(300, 305, null, 'BNBUSDT'));
  timedOut.align(depthSnapshot(310), NOW);
  assert.equal(timedOut.checkBridgeTimeout(NOW + 5_000, 5_000).timedOut, true);
  assert.equal(timedOut.status, 'ALIGNING');

  const bounded = createPerSymbolDepthBook({ symbol: 'SOLUSDT', maxBufferedEvents: 1 });
  bounded.buffer(depthUpdate(1, 1, null, 'SOLUSDT'));
  assert.equal(bounded.buffer(depthUpdate(2, 2, 1, 'SOLUSDT')).reason, 'BUFFER_LIMIT_FAILURE');
  assert.equal(bounded.diagnostics().bufferLimitFailures, 1);
});

test('snapshot recovery uses bounded jitter and enforces the frozen attempt/time limits', async () => {
  assert.throws(() => createHyData0036Runtime({
    dryRun: true,
    noNetwork: true,
    symbols: ['BTCUSDT'],
    maxSnapshotAttempts: 6
  }), /maxSnapshotAttempts exceeds frozen bound/);
  assert.throws(() => createHyData0036Runtime({
    dryRun: true,
    noNetwork: true,
    symbols: ['BTCUSDT'],
    maxSnapshotRecoveryMs: 10_001
  }), /maxSnapshotRecoveryMs exceeds frozen bound/);

  const delays = [];
  const rawStore = { append: async () => {}, seal: async () => [], get sealed() { return false; } };
  const runtime = createHyData0036Runtime({
    dryRun: true,
    symbols: ['BTCUSDT'],
    rawStore,
    fetchImpl: async () => restResponse('{}'),
    maxSnapshotAttempts: 2,
    snapshotRetryDelayMs: 250,
    snapshotRetryRandom: () => 0,
    snapshotSleep: async milliseconds => { delays.push(milliseconds); },
    maxSnapshotRecoveryMs: 1_000
  });
  const result = await runtime.alignAllSnapshots();
  assert.equal(result[0].reason, 'SNAPSHOT_ALIGNMENT_FAILED');
  assert.equal(delays.length, 1);
  assert.notEqual(delays[0], 250);
  assert.ok(delays[0] >= 1 && delays[0] <= 5_000);
});

test('host NTP is primary evidence and Binance time is not used to manufacture clock trust', async () => {
  const chrony = await readHostNtpEvidence({
    platform: 'linux',
    commandRunner: async command => {
      assert.equal(command, 'chronyc');
      return 'System time     : 0.000100 seconds fast\nLeap status     : Normal\nReference time  : Wed Jan 01 00:00:00 2020';
    },
    now: () => NOW
  });
  assert.equal(chrony.clockSource, 'HOST_NTP_EVIDENCE');
  assert.equal(chrony.status, 'CLOCK_TRUSTED');
  assert.equal(chrony.offsetMs, 0.1);
  assert.match(chrony.evidenceMethod, /chronyc/);

  const timedatectl = await readHostNtpEvidence({
    platform: 'linux',
    commandRunner: async (command, args) => {
      if (command === 'chronyc') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      assert.equal(command, 'timedatectl');
      assert.deepEqual(args, ['show', '--property=NTPSynchronized', '--property=NTPOffsetUSec']);
      return 'NTPSynchronized=yes\nNTPOffsetUSec=250000';
    },
    now: () => NOW
  });
  assert.equal(timedatectl.status, 'CLOCK_TRUSTED');
  assert.equal(timedatectl.offsetMs, 250);
});

test('causal feature snapshots expose the frozen runtime fields and never q-fallback visible flow or synthesize empty intervals', () => {
  const builder = createCausalFeatureBuilder({ symbol: 'BTCUSDT', clockStatus: 'CLOCK_TRUSTED' });
  assert.deepEqual(builder.materializeAt(NOW), []);
  builder.ingest('bookTicker', { bidPrice: 100, askPrice: 101, bidQuantity: 2, askQuantity: 3 }, NOW);
  builder.setDepthBook({ bids: [[100, 2]], asks: [[101, 3]] }, NOW, true);
  builder.ingest('aggTrade', {
    aggressorSide: 'BUY',
    totalAggressorNotional: 250,
    normalQuantity: null,
    visibleBookComparableAggressorNotional: null,
    signedVolume: 250
  }, NOW);
  const rows = builder.materializeAt(NOW);
  assert.ok(rows.length >= 1);
  const row = rows.find(candidate => candidate.interval === '1s');
  assert.ok(row);
  for (const field of HY_DATA_0036_RUNTIME_FEATURE_FIELDS) assert.ok(Object.hasOwn(row, field), field);
  assert.equal(row.totalAggressiveBuyNotional, 250);
  assert.equal(row.visibleAggressiveBuyNotional, null);
  assert.equal(row.visibleOrderFlowImbalance, null);
  assert.equal(row.bookStateValid, true);
  assert.equal(row.clockStatus, 'CLOCK_TRUSTED');

  const before = builder.getSnapshots('1s').find(candidate => candidate.snapshotAt === NOW);
  builder.ingest('bookTicker', { bidPrice: 100, askPrice: 101, bidQuantity: 4, askQuantity: 5 }, NOW - 500);
  assert.equal(builder.diagnostics().lateEventCount, 1);
  assert.deepEqual(builder.getSnapshots('1s').find(candidate => candidate.snapshotAt === NOW), before);
});

test('feature sink writes immutable per-interval files and verifies their actual hashes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hy-data-0036-features-'));
  const builder = createCausalFeatureBuilder({ symbol: 'ETHUSDT' });
  builder.ingest('bookTicker', { bidPrice: 100, askPrice: 101, bidQuantity: 1, askQuantity: 1 }, NOW);
  builder.setDepthBook({ bids: [[100, 1]], asks: [[101, 1]] }, NOW, true);
  const row = builder.materializeAt(NOW).find(candidate => candidate.interval === '1s');
  const store = createEngineeringFeatureStore({ rootDir: root, runId: 'feature-test' });
  await store.append(row);
  const manifest = await store.seal();
  assert.equal(store.writeCount, 1);
  assert.equal(verifyFeatureManifest(manifest), true);
  assert.equal(await verifyFeatureManifestFiles(manifest, { rootDir: root }), true);
  assert.equal((await store.seal()).length, 0);
  assert.equal((await fs.readdir(path.join(root, '1s'))).some(file => file.endsWith('.part')), false);
});

test('S3-compatible storage deletes local files only after remote hash verification and capacity gate uses 90-day evidence', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hy-data-0036-storage-'));
  const filePath = path.join(root, 'hour.jsonl');
  await fs.writeFile(filePath, 'sealed\n');
  const objects = new Map();
  const client = {
    async putObject({ key, body, metadata }) { objects.set(key, { body, metadata }); },
    async headObject({ key }) { return { metadata: objects.get(key).metadata }; }
  };
  const adapter = createS3CompatibleSealedPartitionAdapter({ client, bucket: 'research', prefix: 'hy-data-0036' });
  const uploaded = await adapter.uploadSealedPartition({ filePath, objectKey: 'hour.jsonl' });
  assert.equal(uploaded.verified, true);
  assert.equal(await fs.stat(filePath).then(() => true).catch(() => false), false);

  const blockedPath = path.join(root, 'blocked.jsonl');
  await fs.writeFile(blockedPath, 'sealed\n');
  const badAdapter = createS3CompatibleSealedPartitionAdapter({
    client: { async putObject() {}, async headObject() { return { metadata: { sha256: '0'.repeat(64) } }; } },
    bucket: 'research'
  });
  await assert.rejects(badAdapter.uploadSealedPartition({ filePath: blockedPath, objectKey: 'blocked.jsonl' }), error => error.code === 'REMOTE_HASH_MISMATCH');
  assert.equal(await fs.stat(blockedPath).then(() => true).catch(() => false), true);

  const capacity = evaluateStorageCapacity({ bytesPerHour: 100, remoteCapacityBytes: 432_000, localAvailableBytes: 7_200 });
  assert.equal(capacity.status, 'CAPACITY_PASS');
  assert.equal(capacity.projectedRawBytes['90d'], 216_000);
  assert.equal(capacity.twoX90DayHeadroom, true);
  assert.equal(capacity.localSpool72h, true);
  assert.equal(evaluateStorageCapacity({ bytesPerHour: 100 }).status, 'STORAGE_CAPACITY_BLOCKED');
});

test('preflight requires REST/host/storage/WS evidence and blocks before the canary when any hard gate is absent', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hy-data-0036-preflight-'));
  const trustedHost = async () => ({ status: 'CLOCK_TRUSTED', clockSource: 'HOST_NTP_EVIDENCE', synchronized: true, offsetMs: 1, evidenceMethod: 'test' });
  const pass = await runEngineeringPreflight({
    restGovernor: fakeGovernor(),
    hostNtpEvidenceImpl: trustedHost,
    webSocketFactory: () => new PreflightSocket(),
    rootDir: root,
    remoteStorage: { configured: true, verified: true },
    minimumLocalSpoolBytes: 1,
    now: () => NOW,
    wsTimeoutMs: 100
  });
  assert.equal(pass.status, 'PREFLIGHT_PASS');
  assert.equal(pass.canaryAllowed, true);
  assert.equal(pass.safety.pnlComputed, false);

  const blocked = await runEngineeringPreflight({
    restGovernor: fakeGovernor(),
    hostNtpEvidenceImpl: async () => ({ status: 'CLOCK_UNTRUSTED', clockSource: 'HOST_NTP_EVIDENCE', synchronized: false, offsetMs: null, evidenceMethod: 'test' }),
    webSocketFactory: () => new PreflightSocket(),
    rootDir: root,
    now: () => NOW,
    wsTimeoutMs: 100
  });
  assert.equal(blocked.status, 'PREFLIGHT_FAIL');
  assert.equal(blocked.canaryAllowed, false);
  assert.ok(blocked.failures.includes('CLOCK_UNTRUSTED'));
  assert.ok(blocked.failures.includes('STORAGE_BACKEND_NOT_CONFIGURED'));

  const rateBlocked = await runEngineeringPreflight({
    restGovernor: fakeGovernor({ state: () => ({ blocked: true, status: 'IP_RATE_LIMIT_BANNED' }), request: async () => { throw new Error('must not request'); } }),
    hostNtpEvidenceImpl: trustedHost,
    webSocketFactory: () => new PreflightSocket(),
    rootDir: root,
    now: () => NOW,
    wsTimeoutMs: 100
  });
  assert.equal(rateBlocked.status, 'PREFLIGHT_RATE_LIMIT_BLOCKED');
  assert.equal(rateBlocked.canaryAllowed, false);
});

test('HY-DATA-0036 runtime safety remains public, paper-only, and non-research', () => {
  assert.equal(HY_DATA_0036_RUNTIME_SAFETY.publicMarketDataOnly, true);
  assert.equal(HY_DATA_0036_RUNTIME_SAFETY.privateStream, false);
  assert.equal(HY_DATA_0036_RUNTIME_SAFETY.accountApi, false);
  assert.equal(HY_DATA_0036_RUNTIME_SAFETY.orderApi, false);
  assert.equal(HY_DATA_0036_RUNTIME_SAFETY.paperOnly, true);
  assert.equal(HY_DATA_0036_RUNTIME_SAFETY.signalOnly, true);
  assert.equal(HY_DATA_0036_RUNTIME_SAFETY.pnlComputed, false);
  assert.equal(HY_DATA_0036_RUNTIME_SAFETY.finalOosRead, false);
});
