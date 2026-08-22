import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  HY_EXP_0023_COLLECTOR_PROFILE,
  buildHyExp0023CollectorReadiness,
  createHyExp0023ProspectiveCaptureController,
  sha256HyExp0023Artifact
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
import {
  hashCaptureFile,
  buildJustClosedKlineUrl,
  openHyExp0022AppendOnlyNdjson,
  splitDepthSymbols,
  splitKlineSymbols,
  writeImmutableHyExp0022Manifest
} from '../src/model/hy-exp-0022-collector.mjs';

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

function readinessFixture(directory, overrides = {}) {
  const filePath = path.join(directory, 'engineering-readiness.json');
  fs.writeFileSync(filePath, `${JSON.stringify({
    schemaVersion: 1,
    experimentId: HY_EXP_0023_ID,
    status: 'PASS',
    officialCaptureAuthorized: false,
    pnlComputed: false,
    orderApiEnabled: false,
    accountApiEnabled: false,
    ...overrides
  })}\n`);
  return { filePath, sha256: sha256HyExp0023Artifact(filePath) };
}

function copyFrozenHyExp0023Inputs(projectRoot, { withCorrection = false } = {}) {
  const preregistrationDirectory = path.join(projectRoot, 'registry', 'experiments', HY_EXP_0023_ID);
  const resolutionDirectory = path.join(projectRoot, 'artifacts', HY_EXP_0023_ID);
  const registryDirectory = path.join(projectRoot, 'registry');
  fs.mkdirSync(preregistrationDirectory, { recursive: true });
  fs.mkdirSync(resolutionDirectory, { recursive: true });
  fs.mkdirSync(registryDirectory, { recursive: true });
  const sourceLedger = fs.readFileSync(path.join('registry', 'ledger.jsonl'), 'utf8');
  const sourceEntries = sourceLedger.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  for (const entry of sourceEntries) {
    const sourcePayload = path.resolve(entry.payload_path);
    const targetPayload = path.join(projectRoot, entry.payload_path);
    fs.mkdirSync(path.dirname(targetPayload), { recursive: true });
    fs.copyFileSync(sourcePayload, targetPayload);
    if (entry.event_type === 'completed') {
      const bundle = JSON.parse(fs.readFileSync(sourcePayload, 'utf8'));
      for (const artifact of bundle.artifacts ?? []) {
        const sourceArtifact = path.resolve(artifact.path);
        const targetArtifact = path.join(projectRoot, artifact.path);
        fs.mkdirSync(path.dirname(targetArtifact), { recursive: true });
        fs.copyFileSync(sourceArtifact, targetArtifact);
      }
    }
  }
  fs.copyFileSync(
    path.join('registry', 'experiments', HY_EXP_0023_ID, 'preregistration.json'),
    path.join(preregistrationDirectory, 'preregistration.json')
  );
  const ledgerLines = sourceLedger
    .split(/\r?\n/)
    .filter(Boolean)
    .filter(line => {
      if (withCorrection) return true;
      return JSON.parse(line).payload_path !== `artifacts/${HY_EXP_0023_ID}/preregistration-resolution-correction.json`;
    });
  fs.writeFileSync(path.join(registryDirectory, 'ledger.jsonl'), `${ledgerLines.join('\n')}\n`);
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

test('0023 closure is a frozen pre-capture withdrawal and preserves all historical inputs', () => {
  const closurePath = 'artifacts/HY-EXP-0023/closure.json';
  const closure = JSON.parse(fs.readFileSync(closurePath, 'utf8'));
  assert.equal(closure.status, 'WITHDRAWN_PRE_CAPTURE_FROZEN');
  assert.equal(closure.registryEventType, 'failed');
  assert.equal(closure.reason, 'RESEARCH_DIRECTION_CHANGED_AND_REQUIRED_PRECAPTURE_READINESS_NOT_COMPLETED');
  assert.equal(closure.captureStart, HY_EXP_0023_CAPTURE_START);
  assert.ok(Date.parse(closure.recordedAt) < Date.parse(closure.captureStart));
  assert.equal(closure.officialCaptureStarted, false);
  assert.equal(closure.stageAPassed, false);
  assert.equal(closure.formalReadinessPassed, false);
  assert.equal(closure.developmentStarted, false);
  assert.equal(closure.developmentAllowed, false);
  assert.equal(closure.developmentDataCollected, false);
  assert.equal(closure.finalOosRead, false);
  assert.equal(closure.pnlComputed, false);
  assert.equal(closure.accountApiUsed, false);
  assert.equal(closure.orderApiUsed, false);
  assert.equal(closure.liveOrdersEnabled, false);
  assert.equal(closure.paperOnly, true);
  assert.equal(closure.backfillPermitted, false);
  assert.equal(closure.captureStartMoved, false);
  assert.equal(closure.canResume, false);
  assert.equal(closure.futureRetryRequiresNewExperimentId, true);

  const expectedFrozen = new Map([
    ['registry/experiments/HY-EXP-0023/preregistration.json', '6fcd11c3c5767259b4c43e4a96ca733857f31d72f73e6f8eed0ff3e8eb61934e'],
    ['artifacts/HY-EXP-0023/preregistration-resolution.json', '6c83ed256900963357570daed55dcb8df57ae40b9a1335da0959d42bfde1e4ae'],
    ['artifacts/HY-EXP-0023/preregistration-resolution-correction.json', '6039a9fc6000fbebfd89b9273b19e1f3fd0f9208e8ecd6425b12784860db71df']
  ]);
  assert.deepEqual(
    closure.frozenArtifacts.map(artifact => [artifact.path, artifact.sha256]),
    [...expectedFrozen.entries()]
  );
  for (const [relativePath, expectedHash] of expectedFrozen) {
    assert.equal(sha256HyExp0023Artifact(relativePath), expectedHash);
  }
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

test('0023 frozen inputs without the append-only correction block official capture fail-closed', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hengyu-0023-frozen-hash-'));
  copyFrozenHyExp0023Inputs(projectRoot);
  const readiness = readinessFixture(projectRoot);
  const controller = createHyExp0023ProspectiveCaptureController({
    projectRoot,
    outputRoot: path.join(projectRoot, 'data', 'raw', 'prospective-development', HY_EXP_0023_ID),
    readinessPath: readiness.filePath,
    readinessSha256: readiness.sha256,
    now: () => Date.parse('2026-08-23T11:59:00.000Z')
  });
  assert.throws(() => controller.arm(), error => error.code === 'HY_EXP_0023_GOVERNANCE_CORRECTION_INVALID');
});

function assertGovernanceMutationRejected(mutate, label) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), `hengyu-0023-${label}-`));
  copyFrozenHyExp0023Inputs(projectRoot, { withCorrection: true });
  mutate(projectRoot);
  const readiness = readinessFixture(projectRoot);
  const controller = createHyExp0023ProspectiveCaptureController({
    projectRoot,
    outputRoot: path.join(projectRoot, 'data', 'raw', 'prospective-development', HY_EXP_0023_ID),
    readinessPath: readiness.filePath,
    readinessSha256: readiness.sha256,
    now: () => Date.parse('2026-08-23T11:59:00.000Z')
  });
  assert.throws(() => controller.arm(), error => error.code === 'HY_EXP_0023_GOVERNANCE_CORRECTION_INVALID');
}

test('0023 governance correction rejects edited resolution, preregistration, correction hash and unregistered correction', () => {
  assertGovernanceMutationRejected(projectRoot => {
    const filePath = path.join(projectRoot, 'artifacts', HY_EXP_0023_ID, 'preregistration-resolution.json');
    fs.appendFileSync(filePath, ' ');
  }, 'edited-resolution');
  assertGovernanceMutationRejected(projectRoot => {
    const filePath = path.join(projectRoot, 'registry', 'experiments', HY_EXP_0023_ID, 'preregistration.json');
    fs.appendFileSync(filePath, ' ');
  }, 'edited-prereg');
  assertGovernanceMutationRejected(projectRoot => {
    const filePath = path.join(projectRoot, 'artifacts', HY_EXP_0023_ID, 'preregistration-resolution-correction.json');
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    value.correctedPreregSha256 = '0'.repeat(64);
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
  }, 'edited-correction');

  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hengyu-0023-unregistered-correction-'));
  copyFrozenHyExp0023Inputs(projectRoot);
  fs.copyFileSync(
    path.join('artifacts', HY_EXP_0023_ID, 'preregistration-resolution-correction.json'),
    path.join(projectRoot, 'artifacts', HY_EXP_0023_ID, 'preregistration-resolution-correction.json')
  );
  const readiness = readinessFixture(projectRoot);
  const controller = createHyExp0023ProspectiveCaptureController({
    projectRoot,
    outputRoot: path.join(projectRoot, 'data', 'raw', 'prospective-development', HY_EXP_0023_ID),
    readinessPath: readiness.filePath,
    readinessSha256: readiness.sha256,
    now: () => Date.parse('2026-08-23T11:59:00.000Z')
  });
  assert.throws(() => controller.arm(), error => error.code === 'HY_EXP_0023_GOVERNANCE_CORRECTION_INVALID');
});

test('0023 governance correction rejects post-capture and semantic correction claims', () => {
  for (const [label, mutate] of [
    ['after-capture-start', value => { value.createdAt = '2026-08-23T12:00:00.000Z'; }],
    ['semantic-change', value => { value.strategySemanticsChanged = true; }]
  ]) {
    assertGovernanceMutationRejected(projectRoot => {
      const filePath = path.join(projectRoot, 'artifacts', HY_EXP_0023_ID, 'preregistration-resolution-correction.json');
      const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      mutate(value);
      fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
    }, label);
  }
});

test('0023 prospective capture gate fails closed on missing, non-pass or tampered readiness', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hengyu-0023-gate-fail-'));
  copyFrozenHyExp0023Inputs(projectRoot, { withCorrection: true });
  const missing = createHyExp0023ProspectiveCaptureController({
    projectRoot,
    readinessPath: path.join(projectRoot, 'missing-readiness.json'),
    readinessSha256: '0'.repeat(64),
    now: () => Date.parse('2026-08-23T11:59:00.000Z')
  });
  assert.throws(() => missing.arm(), error => error.code === 'HY_EXP_0023_ARTIFACT_MISSING');

  const notReady = readinessFixture(projectRoot, { status: 'COLLECTOR_NOT_READY' });
  const notReadyController = createHyExp0023ProspectiveCaptureController({
    projectRoot,
    readinessPath: notReady.filePath,
    readinessSha256: notReady.sha256,
    now: () => Date.parse('2026-08-23T11:59:00.000Z')
  });
  assert.throws(() => notReadyController.arm(), error => error.code === 'HY_EXP_0023_READINESS_NOT_PASS');

  const pass = readinessFixture(projectRoot);
  const tamperedHashController = createHyExp0023ProspectiveCaptureController({
    projectRoot,
    readinessPath: pass.filePath,
    readinessSha256: 'f'.repeat(64),
    now: () => Date.parse('2026-08-23T11:59:00.000Z')
  });
  assert.throws(() => tamperedHashController.arm(), error => error.code === 'HY_EXP_0023_READINESS_HASH_MISMATCH');

  assert.throws(() => createHyExp0023ProspectiveCaptureController({
    projectRoot,
    outputRoot: path.join(projectRoot, 'lookalike-HY-EXP-0023'),
    readinessPath: pass.filePath,
    readinessSha256: pass.sha256,
    now: () => Date.parse('2026-08-23T11:59:00.000Z')
  }), error => error.code === 'HY_EXP_0023_DEVELOPMENT_ROOT_MISMATCH');
});

test('0023 arms before captureStart, rejects pre-capture writes, and atomically starts Development', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hengyu-0023-gate-transition-'));
  copyFrozenHyExp0023Inputs(projectRoot, { withCorrection: true });
  const readiness = readinessFixture(projectRoot);
  let now = Date.parse('2026-08-23T11:59:59.000Z');
  const written = [];
  const controller = createHyExp0023ProspectiveCaptureController({
    projectRoot,
    readinessPath: readiness.filePath,
    readinessSha256: readiness.sha256,
    now: () => now,
    appendRecord: record => written.push(record)
  });
  assert.equal(controller.arm().state, 'ARMED_PROSPECTIVE_CAPTURE');
  assert.throws(() => controller.writeRecord({
    stream: 'kline.4h',
    sourceExchangeTimestamp: now,
    receivedAt: now
  }), error => error.code === 'HY_EXP_0023_PRE_CAPTURE_WRITE_REJECTED');
  assert.equal(written.length, 0);
  now = Date.parse('2026-08-23T12:00:00.000Z');
  assert.equal(controller.start().state, 'DEVELOPMENT_CAPTURE');
  const record = controller.writeRecord({
    stream: 'kline.4h',
    sourceExchangeTimestamp: now,
    receivedAt: now + 1,
    symbol: 'BTCUSDT'
  });
  assert.equal(record.captureMode, 'DEVELOPMENT_CAPTURE');
  assert.equal(record.authorization, 'PAPER_ONLY');
  assert.equal(written.length, 1);
  assert.equal(controller.diagnostics().rejectedPreCaptureCount, 1);
  assert.equal(controller.getGate().officialCaptureAuthorized, false);
  assert.equal(controller.getGate().developmentAllowed, true);
  assert.throws(() => controller.writeRecord({
    stream: 'depth.diff',
    sourceExchangeTimestamp: now + 10,
    receivedAt: now + 5,
    symbol: 'BTCUSDT'
  }), error => error.code === 'HY_EXP_0023_FUTURE_SOURCE_TIMESTAMP');
});

test('0023 boundary integration simulation keeps raw/manifest isolated and admits only causal records', () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hengyu-0023-boundary-simulation-'));
  copyFrozenHyExp0023Inputs(projectRoot, { withCorrection: true });
  const readiness = readinessFixture(projectRoot);
  const outputRoot = path.join(projectRoot, 'data', 'raw', 'prospective-development', HY_EXP_0023_ID);
  const rawPath = path.join(outputRoot, 'boundary.ndjson');
  const rawWriter = openHyExp0022AppendOnlyNdjson(rawPath);
  let now = Date.parse('2026-08-23T11:59:59.000Z');
  const controller = createHyExp0023ProspectiveCaptureController({
    projectRoot,
    outputRoot,
    readinessPath: readiness.filePath,
    readinessSha256: readiness.sha256,
    now: () => now,
    appendRecord: record => rawWriter.append(record)
  });
  assert.equal(controller.arm().state, 'ARMED_PROSPECTIVE_CAPTURE');
  assert.throws(() => controller.writeRecord({
    stream: 'depth.diff',
    sourceExchangeTimestamp: now,
    receivedAt: now
  }), error => error.code === 'HY_EXP_0023_PRE_CAPTURE_WRITE_REJECTED');

  now = Date.parse('2026-08-23T12:00:00.000Z');
  assert.equal(controller.start().state, 'DEVELOPMENT_CAPTURE');
  now = Date.parse('2026-08-23T16:00:00.000Z');
  const barOpen = Date.parse('2026-08-23T12:00:00.000Z');
  const barClose = barOpen + 4 * 60 * 60 * 1_000 - 1;
  const restUrl = buildJustClosedKlineUrl({ symbol: 'BTCUSDT', openTime: barOpen, closeTime: barClose });
  controller.writeRecord({
    stream: 'depth.diff',
    segmentId: 'boundary-depth-segment-1',
    symbol: 'BTCUSDT',
    sourceExchangeTimestamp: now,
    receivedAt: now + 1,
    aligned: true,
    U: 100,
    u: 101,
    pu: null
  });
  controller.writeRecord({
    stream: 'kline.4h',
    kind: 'websocket',
    segmentId: 'boundary-kline-segment-1',
    symbol: 'BTCUSDT',
    sourceExchangeTimestamp: barClose,
    receivedAt: now + 2,
    source: 'CONTRACT_PRICE',
    finalClosed: true,
    openTime: barOpen,
    closeTime: barClose,
    open: '100',
    high: '102',
    low: '99',
    close: '101',
    volume: '1',
    quoteVolume: '100',
    tradeCount: 10
  });
  controller.writeRecord({
    stream: 'kline.4h',
    kind: 'rest_confirmation',
    symbol: 'BTCUSDT',
    sourceExchangeTimestamp: barClose,
    receivedAt: now + 3,
    requestStartedAt: now + 2,
    endpoint: restUrl,
    source: 'CONTRACT_PRICE',
    openTime: barOpen,
    closeTime: barClose,
    open: '100',
    high: '102',
    low: '99',
    close: '101',
    volume: '1',
    quoteVolume: '100',
    tradeCount: 10,
    result: 'CONFIRMED'
  });
  controller.writeRecord({
    stream: 'funding',
    symbol: 'BTCUSDT',
    sourceExchangeTimestamp: now,
    receivedAt: now + 4,
    fundingTime: now,
    fundingRate: '0.0001'
  });
  rawWriter.close();

  const selectedSymbols = Array.from({ length: 41 }, (_, index) => `S${String(index).padStart(2, '0')}USDT`);
  const klineBatches = splitKlineSymbols(selectedSymbols, 20);
  assert.deepEqual(klineBatches.map(batch => batch.length), [20, 20, 1]);
  assert.deepEqual(klineBatches.flat().sort(), selectedSymbols.sort());
  const rawFile = hashCaptureFile(rawPath);
  const manifest = {
    schemaVersion: 1,
    experimentId: HY_EXP_0023_ID,
    captureMode: 'DEVELOPMENT_CAPTURE',
    root: path.relative(projectRoot, outputRoot).replaceAll(path.sep, '/'),
    files: [{ path: 'boundary.ndjson', ...rawFile }],
    officialCaptureAuthorized: false,
    authorization: 'PAPER_ONLY',
    developmentAllowed: false,
    pnlComputed: false,
    historicalBackfillUsed: false,
    proxyDepthUsed: false,
    noOrderOrAccountApi: true
  };
  const sealed = writeImmutableHyExp0022Manifest({ directory: outputRoot, manifest });
  assert.ok(fs.existsSync(sealed.manifestPath));
  assert.ok(fs.existsSync(sealed.hashPath));
  assert.equal(controller.diagnostics().officialCaptureAuthorized, false);
  assert.equal(controller.diagnostics().pnlComputed, false);
  assert.equal(controller.diagnostics().rejectedPreCaptureCount, 1);
  assert.deepEqual(HY_EXP_0023_COLLECTOR_PROFILE.orderEndpoints, []);
  assert.deepEqual(HY_EXP_0023_COLLECTOR_PROFILE.accountEndpoints, []);
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
