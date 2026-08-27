import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  HY_DATA_0036_CONTRACT,
  HY_DATA_0036_DEPTH_FEATURE_FIELDS,
  HY_DATA_0036_FEATURE_FIELDS,
  HY_DATA_0036_ID,
  HY_DATA_0036_RESERVED_FAMILIES,
  HY_DATA_0036_SAFETY,
  HY_DATA_0036_STREAMS,
  HY_DATA_0036_SYMBOLS
} from '../src/data/hy-data-0036-contract.mjs';
import {
  assessDailyQuality,
  assertResearchEligibleCaptureRoot,
  computeCausalLargeTradeThreshold,
  createAppendOnlyRawWriter,
  createFeatureSnapshot,
  createImmutableManifest,
  depthFeaturesOrNull,
  HY_DATA_0036_ENGINEERING_ROOT,
  HY_DATA_0036_PROSPECTIVE_ROOT,
  isResearchEligibleCaptureRoot,
  normalizeAggTrade,
  parseBookTicker,
  parseDepth20,
  sha256,
  validateClock,
  validateDepthSequence,
  validateFeatureSnapshot,
  validateRawRecord,
  verifyImmutableManifest
} from '../src/data/hy-data-0036-validator.mjs';
import { createHyData0036CollectorPlan } from '../src/data/hy-data-0036-collector.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const START = Date.parse('2026-08-27T00:00:00.000Z');

function raw(overrides = {}) {
  return {
    source: 'binance-public-usdm',
    stream: 'aggTrade',
    symbol: 'BTCUSDT',
    exchangeEventTime: START + 1_000,
    tradeTime: START + 1_000,
    localReceiveTime: START + 1_010,
    sequence: 1,
    rawPayload: { e: 'aggTrade', s: 'BTCUSDT', a: 1 },
    schemaVersion: 1,
    ...overrides
  };
}

function featureValues() {
  return Object.fromEntries(HY_DATA_0036_FEATURE_FIELDS.map(field => [field, 1]));
}

test('HY-DATA-0036 freezes the eight symbols, public streams, and reserved families', () => {
  assert.deepEqual(HY_DATA_0036_SYMBOLS, ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'LINKUSDT', 'LTCUSDT']);
  assert.deepEqual(HY_DATA_0036_STREAMS.map(stream => stream.id), ['aggTrade', 'bookTicker', 'depth20', 'depth.diff', 'depth.snapshot']);
  assert.deepEqual(HY_DATA_0036_RESERVED_FAMILIES, [
    'ORDER_FLOW_IMBALANCE',
    'LIQUIDITY_VACUUM',
    'AGGRESSIVE_FLOW_EXHAUSTION',
    'MICROPRICE_PRESSURE',
    'CROSS_SYMBOL_FLOW_PROPAGATION'
  ]);
  assert.equal(HY_DATA_0036_CONTRACT.engineeringDryRunEligible, false);
  assert.equal(HY_DATA_0036_CONTRACT.datasetId, HY_DATA_0036_ID);
});

test('all HY-DATA-0036 safety flags are public, paper-only, and disabled for execution', () => {
  assert.deepEqual(HY_DATA_0036_SAFETY, {
    publicMarketDataOnly: true,
    apiKeyRequired: false,
    accountApi: false,
    orderApi: false,
    privateStream: false,
    paperOnly: true,
    signalOnly: true,
    gmail: false,
    scheduler: false,
    realEmail: false,
    autoTrading: false,
    finalOosRead: false,
    pnlComputed: false
  });
});

test('aggTrade maker flag maps to aggressor side without changing the raw event', () => {
  const sell = normalizeAggTrade({ s: 'BTCUSDT', a: 2, p: '100', q: '0.5', T: START + 2_000, m: true });
  const buy = normalizeAggTrade({ s: 'BTCUSDT', a: 3, p: '100', q: '0.5', T: START + 3_000, m: false });
  assert.equal(sell.aggressorSide, 'SELL');
  assert.equal(sell.signedVolume, -50);
  assert.equal(buy.aggressorSide, 'BUY');
  assert.equal(buy.signedVolume, 50);
});

test('bookTicker and depth20 parsers require valid public book values', () => {
  const ticker = parseBookTicker({ s: 'ETHUSDT', u: 4, b: '100', B: '2', a: '101', A: '3', E: START + 4_000 });
  assert.equal(ticker.symbol, 'ETHUSDT');
  const depth = parseDepth20({ s: 'ETHUSDT', u: 5, b: [['100', '2']], a: [['101', '3']], E: START + 5_000 });
  assert.equal(depth.bids[0][0], 100);
  assert.throws(() => parseBookTicker({ s: 'ETHUSDT', u: 4, b: '101', B: '2', a: '100', A: '3', E: START }), /crossed/);
});

test('raw records preserve causal timestamps and reject pre-boundary observations', () => {
  const accepted = validateRawRecord(raw(), { collectionStartAt: START });
  assert.equal(accepted.symbol, 'BTCUSDT');
  assert.equal(accepted.receiveLatencyMs, 10);
  assert.throws(() => validateRawRecord(raw({ exchangeEventTime: START - 1 }), { collectionStartAt: START }), /predates collectionStartAt/);
  assert.throws(() => validateRawRecord(raw({ source: 'binance-private' }), { collectionStartAt: START }), /public Binance/);
  assert.throws(() => validateRawRecord(raw({ symbol: 'NEWCOINUSDT' }), { collectionStartAt: START }), /fixed universe/);
});

test('depth sequence accepts stale evidence then exact snapshot overlap and records metadata', () => {
  const result = validateDepthSequence({
    snapshot: { lastUpdateId: 100 },
    updates: [
      { U: 80, u: 90 },
      { U: 91, u: 99 },
      { U: 99, u: 101 },
      { U: 102, u: 105, pu: 101 }
    ]
  });
  assert.equal(result.status, 'VALID');
  assert.equal(result.bookStateValid, true);
  assert.deepEqual(result.staleUpdateIds, [90, 99]);
  assert.equal(result.firstUpdateId, 99);
  assert.equal(result.finalUpdateId, 105);
  assert.equal(result.previousFinalUpdateId, 101);
  assert.equal(result.resyncRequired, false);
});

test('depth sequence fails closed for no overlap, gaps, duplicates, and out-of-order updates', () => {
  const noOverlap = validateDepthSequence({ snapshot: { lastUpdateId: 100 }, updates: [{ U: 120, u: 130 }] });
  assert.equal(noOverlap.reason, 'SNAPSHOT_ALIGNMENT_FAILED');
  assert.equal(noOverlap.resyncRequired, true);
  const gap = validateDepthSequence({ snapshot: { lastUpdateId: 100 }, updates: [{ U: 99, u: 101 }, { U: 103, u: 105, pu: 101 }] });
  assert.equal(gap.reason, 'SEQUENCE_GAP');
  const duplicate = validateDepthSequence({ snapshot: { lastUpdateId: 100 }, updates: [{ U: 99, u: 101 }, { U: 101, u: 101, pu: 101 }] });
  assert.equal(duplicate.reason, 'DUPLICATE_DEPTH_UPDATE');
  const outOfOrder = validateDepthSequence({ snapshot: { lastUpdateId: 100 }, updates: [{ U: 99, u: 101 }, { U: 100, u: 100, pu: 101 }] });
  assert.equal(outOfOrder.reason, 'OUT_OF_ORDER_DEPTH_UPDATE');
});

test('invalid local book suppresses every depth-derived feature', () => {
  const suppressed = depthFeaturesOrNull(false, { midPrice: 100, spreadBps: 2 });
  for (const field of HY_DATA_0036_DEPTH_FEATURE_FIELDS) assert.equal(suppressed[field], null);
  assert.throws(() => validateFeatureSnapshot({
    snapshotAt: START,
    symbol: 'BTCUSDT',
    interval: '1s',
    ...featureValues(),
    bookStateValid: false,
    clockStatus: 'CLOCK_TRUSTED',
    featureCoverage: 1
  }, { collectionStartAt: START }), /invalid book/);
});

test('append-only raw writer seals records and cannot silently rewrite a segment', () => {
  const writer = createAppendOnlyRawWriter();
  writer.append(raw());
  assert.equal(writer.snapshot().length, 1);
  writer.seal();
  assert.equal(writer.sealed, true);
  assert.throws(() => writer.append(raw({ sequence: 2 })), /RAW_APPEND_ONLY_SEALED/);
  assert.equal(typeof writer.delete, 'undefined');
  assert.equal(typeof writer.update, 'undefined');
});

test('causal large-trade threshold uses only a complete prior 24-hour window', () => {
  const asOf = START + 48 * 60 * 60 * 1000;
  const trades = [
    { eventTime: asOf - 86_400_000 + 1_000, quoteNotional: 10 },
    { eventTime: asOf - 86_400_000 + 2_000, quoteNotional: 20 },
    { eventTime: asOf - 86_400_000 + 3_000, quoteNotional: 30 },
    { eventTime: asOf - 86_400_000 + 4_000, quoteNotional: 40 },
    { eventTime: asOf - 1_000, quoteNotional: 100 }
  ];
  const warmup = computeCausalLargeTradeThreshold(trades, { asOf, priorWindowComplete: false });
  assert.equal(warmup.threshold, null);
  const threshold = computeCausalLargeTradeThreshold(trades, { asOf, priorWindowComplete: true });
  assert.equal(threshold.threshold, 100);
  assert.throws(() => computeCausalLargeTradeThreshold([...trades, { eventTime: asOf, quoteNotional: 10_000 }], { asOf, priorWindowComplete: true }), /future/);
});

test('feature snapshots require aligned causal windows and preserve null missing values', () => {
  const snapshot = createFeatureSnapshot({
    symbol: 'BTCUSDT',
    snapshotAt: START,
    interval: '5s',
    bookStateValid: true,
    clockStatus: 'CLOCK_TRUSTED',
    featureCoverage: 1,
    values: featureValues(),
    collectionStartAt: START
  });
  assert.equal(snapshot.orderFlowImbalance, 1);
  assert.equal(validateFeatureSnapshot(snapshot, { collectionStartAt: START }).interval, '5s');
  assert.throws(() => createFeatureSnapshot({
    symbol: 'BTCUSDT', snapshotAt: START + 1, interval: '5s', bookStateValid: true, clockStatus: 'CLOCK_TRUSTED', values: featureValues()
  }), /interval aligned/);
});

test('clock drift over 500ms marks latency untrusted without rewriting raw timestamps', () => {
  const trusted = validateClock({ exchangeEventTime: START, localReceiveTime: START + 20, clockDriftMs: 200 });
  assert.equal(trusted.status, 'CLOCK_TRUSTED');
  assert.equal(trusted.receiveLatencyMs, 20);
  const untrusted = validateClock({ exchangeEventTime: START, localReceiveTime: START + 20, clockDriftMs: 501 });
  assert.equal(untrusted.status, 'CLOCK_UNTRUSTED');
  assert.equal(untrusted.latencyTrusted, false);
});

test('immutable manifest binds raw hashes, row counts, and its own SHA-256', () => {
  const manifest = createImmutableManifest({
    coverage: { start: START, end: START + 1_000 },
    files: [{ path: 'BTCUSDT/aggTrade.jsonl.zst', bytes: 'raw', rowCount: 1, symbol: 'BTCUSDT', stream: 'aggTrade' }]
  });
  assert.equal(manifest.files[0].sha256, sha256('raw'));
  assert.equal(verifyImmutableManifest(manifest), true);
  assert.equal(verifyImmutableManifest({ ...manifest, manifestSha256: '0'.repeat(64) }), false);
  assert.throws(() => createImmutableManifest({ files: [{ path: 'bad', rowCount: 0 }] }), /SHA-256/);
});

test('daily quality gates return DATA_QUALITY_FAIL below the frozen targets', () => {
  const pass = assessDailyQuality({ uptime: 0.99, bookValidCoverage: 0.98, aggTradeCoverage: 0.99, bookTickerCoverage: 0.99 });
  assert.equal(pass.status, 'DATA_QUALITY_PASS');
  const failResult = assessDailyQuality({ uptime: 0.989, bookValidCoverage: 1, aggTradeCoverage: 1, bookTickerCoverage: 1 });
  assert.equal(failResult.status, 'DATA_QUALITY_FAIL');
  assert.deepEqual(failResult.failedGates, ['uptime']);
});

test('canonical root containment keeps engineering dry runs permanently ineligible', () => {
  const prospective = path.join(ROOT, HY_DATA_0036_PROSPECTIVE_ROOT);
  const engineering = path.join(ROOT, HY_DATA_0036_ENGINEERING_ROOT);
  const misleading = path.join(ROOT, 'other', `copy-${HY_DATA_0036_ID}`, 'raw');
  assert.equal(isResearchEligibleCaptureRoot(prospective, { repositoryRoot: ROOT }), true);
  assert.equal(isResearchEligibleCaptureRoot(engineering, { repositoryRoot: ROOT }), false);
  assert.equal(isResearchEligibleCaptureRoot(misleading, { repositoryRoot: ROOT }), false);
  assert.equal(assertResearchEligibleCaptureRoot(prospective, { repositoryRoot: ROOT }), path.resolve(prospective));
  assert.throws(() => assertResearchEligibleCaptureRoot(engineering, { repositoryRoot: ROOT }), /canonical/);
});

test('collector plan is preparation-only and has no network or execution path', () => {
  const plan = createHyData0036CollectorPlan();
  assert.equal(plan.status, 'PREPARATION_ONLY');
  assert.equal(plan.networkStarted, false);
  assert.equal(plan.publicOnly, true);
  assert.equal(plan.boundedSymbolBatches, true);
  assert.equal(plan.reconnectCreatesNewSegment, true);
  assert.equal(plan.safety.accountApi, false);
  assert.equal(plan.safety.orderApi, false);
  const source = fs.readFileSync(path.join(ROOT, 'src/data/hy-data-0036-collector.mjs'), 'utf8');
  assert.doesNotMatch(source, /fetch\s*\(|WebSocket\s*\(|sendMail\s*\(/);
});

test('0034 closure is separate and does not rewrite its immutable tournament result', () => {
  const closure = JSON.parse(fs.readFileSync(path.join(ROOT, 'artifacts/HY-EXP-0034/closure.json'), 'utf8'));
  const resultPath = path.join(ROOT, 'artifacts/HY-EXP-0034/tournament-result.json');
  assert.equal(closure.status, 'NO_ACTIONABLE_ALPHA_FOUND');
  assert.equal(closure.reason, 'PUBLIC_OHLCV_MARK_FUNDING_REGISTERED_SEARCH_SPACE_EXHAUSTED');
  assert.equal(closure.scope.preregisteredFamilies, 5);
  assert.equal(closure.scope.executionProfiles, 3);
  assert.equal(closure.scope.totalSpecifications, 15);
  assert.equal(sha256(fs.readFileSync(resultPath)), closure.sourceEvidence.tournamentResult.sha256);
  assert.equal(closure.sourceEvidence.terminalRegistryEvent.sequence, 80);
  assert.equal(fs.existsSync(path.join(ROOT, 'registry/experiments/HY-EXP-0035')), false);
});

test('0036 registration is present before any data lock or outcome artifact', () => {
  const preregPath = path.join(ROOT, 'registry/experiments/HY-DATA-0036/preregistration.json');
  const contractPath = path.join(ROOT, 'artifacts/HY-DATA-0036/data-contract.json');
  const prereg = JSON.parse(fs.readFileSync(preregPath, 'utf8'));
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  const ledger = fs.readFileSync(path.join(ROOT, 'registry/ledger.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(prereg.experimentId, HY_DATA_0036_ID);
  assert.equal(prereg.status, 'PREREGISTERED_DATA_COLLECTION_PREPARATION');
  assert.equal(prereg.collectionBoundary.historicalBackfill, false);
  assert.equal(prereg.collectionBoundary.futureOutcomeRead, false);
  assert.equal(contract.datasetId, HY_DATA_0036_ID);
  assert.equal(contract.contractStatus, 'FROZEN_BEFORE_COLLECTION');
  const dataRegistration = ledger.find(entry => entry.sequence === 81);
  assert.equal(dataRegistration.experiment_id, HY_DATA_0036_ID);
  assert.equal(dataRegistration.event_type, 'preregistered');
  assert.equal(ledger.some(entry => entry.experiment_id === 'HY-EXP-0037' && entry.event_type === 'preregistered'), true);
  assert.equal(fs.existsSync(path.join(ROOT, 'artifacts/HY-DATA-0036/result.json')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'artifacts/HY-DATA-0036/trades.jsonl')), false);
});

test('feature families remain reserved only with no thresholds, outcomes, or PnL', () => {
  const prereg = JSON.parse(fs.readFileSync(path.join(ROOT, 'registry/experiments/HY-DATA-0036/preregistration.json'), 'utf8'));
  assert.equal(prereg.reservedFeatureFamilies.status, 'FEATURE_FAMILY_RESERVED_ONLY');
  assert.equal(prereg.reservedFeatureFamilies.thresholds, false);
  assert.equal(prereg.reservedFeatureFamilies.outcomes, false);
  assert.equal(prereg.reservedFeatureFamilies.pnl, false);
  assert.equal(prereg.reservedFeatureFamilies.strategySelection, false);
});
