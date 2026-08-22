import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  HY_EXP_0023_COLLECTOR_PROFILE,
  buildHyExp0023CollectorReadiness
} from '../src/model/hy-exp-0023-collector.mjs';
import {
  HY_EXP_0023_CAPTURE_START,
  HY_EXP_0023_EARLIEST_CANDIDATE_TIME,
  HY_EXP_0023_ENGINEERING_ROOT,
  HY_EXP_0023_FINAL_OOS_END_EXCLUSIVE,
  HY_EXP_0023_FINAL_OOS_START,
  HY_EXP_0023_ID,
  HY_EXP_0023_PREREGISTRATION_COMMIT,
  HY_EXP_0023_PREREGISTRATION_SHA256,
  assertHyExp0023CaptureMode,
  assertHyExp0023EngineeringRoot,
  assertHyExp0023EngineeringNeverDevelopmentInput,
  assertHyExp0023FrozenResolution,
  buildHyExp0023SafetyMetadata,
  resolveHyExp0023CaptureStart
} from '../src/model/hy-exp-0023-prospective.mjs';
import {
  HY_EXP_0023_REQUIRED_ALERTS,
  appendHyExp0023Alert,
  createHyExp0023Supervisor,
  evaluateHyExp0023Alerts,
  measureHyExp0023ClockReadiness,
  measureHyExp0023Storage,
  probeHyExp0023OsClockSyncState,
  probeHyExp0023StorageCapacity
} from '../src/model/hy-exp-0023-operations.mjs';
import { splitDepthSymbols, splitKlineSymbols } from '../src/model/hy-exp-0022-collector.mjs';

function fakeReadinessResult({ sequenceGaps = 0 } = {}) {
  return {
    runId: 'engineering-diagnostic-test',
    barSourceVerification: { status: 'PASS_TRANSPORT_PRECAPTURE_BAR_EXCLUDED' },
    manifest: {
      startedAt: '2026-08-23T12:00:00.000Z',
      finishedAt: '2026-08-23T12:30:00.000Z',
      durationMs: 1_800_000,
      symbols: Array.from({ length: 20 }, (_, index) => `S${index}USDT`),
      diagnostics: {
        validSegments: 1,
        invalidSegments: 0,
        snapshotAlignmentFailures: 0,
        sequenceGaps,
        crossedBooks: 0,
        bufferLimitFailures: 0,
        missingReceivedAt: 0,
        exchangeInfoCaptured: true,
        fundingMissing: 0,
        exchangeInfoValidation: {},
        gapDiagnostics: []
      },
      transport: {
        depth: { endpoint: HY_EXP_0023_COLLECTOR_PROFILE.transportEndpoints.depth, status: 'VERIFIED' },
        kline: { endpoint: HY_EXP_0023_COLLECTOR_PROFILE.transportEndpoints.kline, status: 'VERIFIED' }
      },
      pnlComputed: false,
      developmentAllowed: false,
      noOrderOrAccountApi: true,
      authorization: 'PAPER_ONLY',
      files: [{ path: 'depth.diff.ndjson', sha256: 'abc' }],
      errors: [],
      manifestSha256: 'manifest'
    },
    manifestWrite: { manifestFileSha256: 'manifest-file' },
    diagnostics: {
      validSegments: 1,
      invalidSegments: 0,
      snapshotAlignmentFailures: 0,
      sequenceGaps,
      crossedBooks: 0,
      bufferLimitFailures: 0,
      missingReceivedAt: 0,
      exchangeInfoCaptured: true,
      fundingMissing: 0,
      exchangeInfoSchemaValid: true
    }
  };
}

test('0023 resolution freezes the preregistration hash, capture start and candidate warmup', () => {
  const resolution = JSON.parse(fs.readFileSync('artifacts/HY-EXP-0023/preregistration-resolution.json', 'utf8'));
  assertHyExp0023FrozenResolution({ resolution });
  assert.equal(resolution.preregCommit, HY_EXP_0023_PREREGISTRATION_COMMIT);
  assert.equal(resolution.preregFileSha256, HY_EXP_0023_PREREGISTRATION_SHA256);
  assert.equal(resolveHyExp0023CaptureStart(), HY_EXP_0023_CAPTURE_START);
  assert.equal(resolution.earliestCandidateTime, HY_EXP_0023_EARLIEST_CANDIDATE_TIME);
  assert.equal(resolution.finalOosStart, HY_EXP_0023_FINAL_OOS_START);
  assert.equal(resolution.finalOosEndExclusive, HY_EXP_0023_FINAL_OOS_END_EXCLUSIVE);
  assert.equal(resolution.officialCaptureAuthorized, false);
});

test('0023 engineering data is isolated, never Development input, and official capture is locked', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hengyu-0023-root-'));
  assert.throws(() => assertHyExp0023EngineeringNeverDevelopmentInput({
    projectRoot,
    inputPath: path.join(HY_EXP_0023_ENGINEERING_ROOT, 'run')
  }));
  assert.throws(() => assertHyExp0023CaptureMode('DEVELOPMENT_CAPTURE'));
  assert.equal(assertHyExp0023CaptureMode('ENGINEERING_DRY_RUN'), 'ENGINEERING_DRY_RUN');
  assert.throws(() => assertHyExp0023EngineeringRoot({
    projectRoot,
    outputRoot: path.join('data', 'raw', 'engineering-dry-run', 'HY-EXP-0022')
  }));
  assert.throws(() => assertHyExp0023EngineeringRoot({
    projectRoot,
    outputRoot: path.join('data', 'raw', 'engineering-dry-run', 'HY-EXP-0023-lookalike')
  }));
  const safety = buildHyExp0023SafetyMetadata({ runId: 'run-1', startedAt: Date.now() });
  assert.equal(safety.experimentId, HY_EXP_0023_ID);
  assert.equal(safety.developmentAllowed, false);
  assert.equal(safety.pnlComputed, false);
  assert.equal(HY_EXP_0023_COLLECTOR_PROFILE.maxSymbolsPerConnection, 20);
  assert.equal(HY_EXP_0023_COLLECTOR_PROFILE.klineSymbolsPerConnection, 20);
});

test('0023 splits a dynamic universe into bounded depth connections without a total-universe cap', () => {
  const symbols = Array.from({ length: 41 }, (_, index) => `SYM${String(index).padStart(2, '0')}USDT`);
  const batches = splitDepthSymbols(symbols, HY_EXP_0023_COLLECTOR_PROFILE.maxSymbolsPerConnection);
  assert.deepEqual(batches.map(batch => batch.length), [20, 20, 1]);
  assert.deepEqual(batches.flat().sort(), symbols.sort());
  const klineBatches = splitKlineSymbols(symbols, HY_EXP_0023_COLLECTOR_PROFILE.klineSymbolsPerConnection);
  assert.deepEqual(klineBatches.map(batch => batch.length), [20, 20, 1]);
  assert.deepEqual(klineBatches.flat().sort(), symbols.sort());
});

test('0023 supports the engineering batch size of five while retaining all selected symbols', () => {
  const symbols = Array.from({ length: 41 }, (_, index) => `SYM${String(index).padStart(2, '0')}USDT`);
  const batches = splitDepthSymbols(symbols, 5);
  assert.equal(batches.length, 9);
  assert.deepEqual(batches.map(batch => batch.length), [5, 5, 5, 5, 5, 5, 5, 5, 1]);
  assert.equal(Math.max(...batches.map(batch => batch.length)), 5);
  assert.deepEqual(batches.flat().sort(), symbols.sort());
});

test('0023 readiness cannot pass when any live sequence gap is recorded', () => {
  const result = buildHyExp0023CollectorReadiness({
    result: fakeReadinessResult({ sequenceGaps: 1 }),
    operations: {
      collectorProcessHealthy: true,
      automaticRestartVerified: true,
      websocketReconnectVerified: true,
      segmentRotationVerified: true,
      alertsActive: true,
      clockReady: true,
      storageReady: true
    }
  });
  assert.equal(result.status, 'COLLECTOR_NOT_READY');
  assert.equal(result.checks.sequenceGaps, false);
  assert.equal(result.officialCaptureAuthorized, false);
});

test('0023 supervisor restarts a dead child with a new engineering segment and never official capture', () => {
  const children = [];
  const timers = [];
  class FakeChild {
    constructor() { this.listeners = new Map(); this.killed = false; }
    on(name, handler) { this.listeners.set(name, handler); return this; }
    emit(name, ...args) { this.listeners.get(name)?.(...args); }
    kill() { this.killed = true; }
  }
  const supervisor = createHyExp0023Supervisor({
    spawnImpl: () => { const child = new FakeChild(); children.push(child); return child; },
    setTimeoutImpl: callback => { timers.push(callback); return timers.length; },
    clearTimeoutImpl: () => {}
  });
  assert.throws(() => supervisor.start({ officialCaptureAuthorized: true }));
  supervisor.start({ officialCaptureAuthorized: false });
  assert.equal(children.length, 1);
  children[0].emit('exit', 1, null);
  assert.equal(supervisor.diagnostics().alerts[0].type, 'collector_death');
  timers.shift()();
  assert.equal(children.length, 2);
  assert.equal(supervisor.diagnostics().segmentIndex, 2);
  supervisor.stop();
});

test('0023 supervisor detects an alive child with stale data progress and emits restart alerts', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hengyu-0023-alerts-'));
  const alertFile = path.join(projectRoot, 'alerts.ndjson');
  const heartbeatFile = path.join(projectRoot, 'heartbeat.json');
  const children = [];
  let childArgs = null;
  let currentChild = null;
  const supervisor = createHyExp0023Supervisor({
    spawnImpl: (_, args) => {
      const child = { pid: 700 + children.length, killed: false, listeners: new Map(), on(name, handler) { this.listeners.set(name, handler); return this; }, kill() { this.killed = true; } };
      children.push(child);
      childArgs = args;
      currentChild = child;
      return child;
    },
    heartbeatTimeoutMs: 1_000,
    heartbeatFile,
    alertFile,
    now: () => 0
  });
  supervisor.start();
  assert.ok(childArgs.includes('--heartbeat-file'));
  fs.writeFileSync(heartbeatFile, `${JSON.stringify({
    processId: currentChild.pid,
    segmentId: 'segment-1',
    lastDepthReceivedAt: 100,
    lastKlineReceivedAt: null,
    lastExchangeEventAt: 100,
    eventCount: 1,
    writtenBytes: 128,
    heartbeatAt: 0
  })}\n`);
  assert.equal(supervisor.checkHealth({ at: 0 }).healthy, true);
  const stale = supervisor.checkHealth({ at: 1_001 });
  assert.equal(stale.healthy, false);
  assert.equal(stale.staleData, true);
  assert.equal(children[0].killed, true);
  assert.deepEqual(supervisor.diagnostics().alerts.map(alert => alert.type), ['stale_data', 'collector_death']);
  const records = fs.readFileSync(alertFile, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.deepEqual(records.map(record => record.type), ['stale_data', 'collector_death']);
  supervisor.stop();
});

test('0023 alert sink is append-only and exposes every required fault channel', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hengyu-0023-alert-sink-'));
  const alertFile = path.join(projectRoot, 'alerts.ndjson');
  for (const type of HY_EXP_0023_REQUIRED_ALERTS) appendHyExp0023Alert(alertFile, { type, faultInjection: true });
  const before = fs.readFileSync(alertFile, 'utf8');
  appendHyExp0023Alert(alertFile, { type: 'collector_death', faultInjection: true });
  const after = fs.readFileSync(alertFile, 'utf8');
  assert.equal(after.startsWith(before), true);
  assert.equal(after.trim().split(/\r?\n/).length, HY_EXP_0023_REQUIRED_ALERTS.length + 1);
  assert.deepEqual(evaluateHyExp0023Alerts({ activeAlerts: HY_EXP_0023_REQUIRED_ALERTS }).missing, []);
});

test('0023 alert readiness does not pass from a writable file alone', () => {
  const configured = [...HY_EXP_0023_REQUIRED_ALERTS];
  const failClosed = evaluateHyExp0023Alerts({
    activeAlerts: configured,
    configuredAlertTypes: configured,
    verifiedRuntimeAlertTypes: [],
    alertSinkWritable: true
  });
  assert.equal(failClosed.ready, false);
  assert.deepEqual(failClosed.missingRuntime, HY_EXP_0023_REQUIRED_ALERTS);
  const verified = evaluateHyExp0023Alerts({
    activeAlerts: configured,
    configuredAlertTypes: configured,
    verifiedRuntimeAlertTypes: configured,
    alertSinkWritable: true
  });
  assert.equal(verified.ready, true);
});

test('0023 clock readiness records multiple Binance server-time RTT and midpoint drift samples', async () => {
  const readiness = await measureHyExp0023ClockReadiness({
    clockSyncStateProvider: async () => ({ synchronized: true, source: 'test-ntp' }),
    fetchImpl: async () => ({
      ok: true,
      text: async () => {
        await new Promise(resolve => setTimeout(resolve, 1));
        return JSON.stringify({ serverTime: Date.now() });
      }
    }),
    serverTimeSampleCount: 3
  });
  assert.equal(readiness.samples.length, 3);
  assert.equal(readiness.validSampleCount, 3);
  assert.ok(readiness.samples.every(sample => sample.receivedAt >= sample.requestStartedAt));
  assert.ok(readiness.samples.every(sample => Number.isFinite(sample.roundTripMs)));
  assert.ok(Number.isFinite(readiness.maxAbsDriftMs));
});

test('0023 NTP and alert gates fail closed, while storage metrics remain observable', async () => {
  const clock = await probeHyExp0023OsClockSyncState({
    platform: 'win32',
    execFileImpl: async () => { throw new Error('clock unavailable'); }
  });
  assert.equal(clock.synchronized, false);
  const readiness = await measureHyExp0023ClockReadiness({
    clockSyncStateProvider: async () => ({ synchronized: false, source: 'test' }),
    fetchImpl: async () => { throw new Error('must not fetch server time'); }
  });
  assert.equal(readiness.ready, false);
  assert.equal(evaluateHyExp0023Alerts({ activeAlerts: [] }).ready, false);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hengyu-0023-storage-'));
  fs.writeFileSync(path.join(root, 'depth.diff.ndjson'), '{"receivedAt":1}\n');
  fs.mkdirSync(path.join(root, 'second-segment'));
  fs.writeFileSync(path.join(root, 'second-segment', 'depth.diff.ndjson'), '{"symbol":"BTCUSDT","receivedAt":2}\n');
  const metrics = measureHyExp0023Storage({
    root,
    startedAt: 1_000,
    finishedAt: 2_000,
    symbols: ['BTCUSDT']
  });
  assert.equal(metrics.totalEvents, 2);
  assert.equal(metrics.byStream.depth.events, 2);
  assert.equal(metrics.bySymbol.BTCUSDT.events, 1);
  assert.equal(metrics.projected4HourBytes >= 0, true);
  assert.ok(metrics.projectedFullExperimentBytes >= 0);
  assert.ok(Number.isFinite(probeHyExp0023StorageCapacity(root).availableBytes));
});
