import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  BASE_MAIN_COMMIT,
  COSTS_BPS,
  DEVELOPMENT_END,
  DEVELOPMENT_START,
  FEATURE_NAMES,
  FIXED_SYMBOLS,
  HY_EXP_0038,
  MODEL_LAMBDAS,
  SOURCE_MANIFEST_PATH,
  SOURCE_MANIFEST_SHA256,
  VALIDATION_END,
  VALIDATION_START,
  applyFrequency,
  blockBootstrap,
  buildEmailPreparation,
  candidateSidesForRegime,
  evaluatePromotionGates,
  fitRidge,
  resolveEntryTime,
  runDevelopmentWalkForward,
  selectDevelopmentConfig,
  sha256,
  simulateCandidate,
  summarizeRows
} from '../src/research/hy-exp-0038-email-signal.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = relative => JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));

test('HY-EXP-0038 preregistration freezes conformance correction, windows, source and safety', () => {
  const preregPath = 'registry/experiments/HY-EXP-0038/preregistration.json';
  const preregBytes = fs.readFileSync(path.join(ROOT, preregPath));
  const prereg = JSON.parse(preregBytes);
  assert.equal(prereg.status, 'PREREGISTERED');
  assert.equal(sha256(preregBytes), '3f811704ebdd1cfefbf68201064da075791430fd85e34b599fa2fb85dcfdeb84');
  assert.equal(prereg.baseMainCommit, BASE_MAIN_COMMIT);
  assert.equal(prereg.priorExperiment.invalidReason, 'IMPLEMENTATION_CONFORMANCE_FAILURE');
  assert.equal(prereg.priorExperiment.negativeResultMayNotBeReused, true);
  assert.equal(prereg.dataWindow.development.start, '2024-08-26T00:00:00Z');
  assert.equal(prereg.dataWindow.development.endExclusive, '2025-08-26T00:00:00Z');
  assert.equal(prereg.dataWindow.historicalValidation.start, '2025-08-26T00:00:00Z');
  assert.equal(prereg.dataWindow.historicalValidation.endExclusive, '2026-08-26T00:00:00Z');
  assert.equal(prereg.dataWindow.finalOosRead, false);
  assert.equal(prereg.dataPolicy.sourceManifestPath, SOURCE_MANIFEST_PATH);
  assert.equal(prereg.dataPolicy.sourceManifestSha256, SOURCE_MANIFEST_SHA256);
  assert.deepEqual(prereg.universe.fixedSymbols, FIXED_SYMBOLS);
  assert.equal(prereg.universe.pointInTime, true);
  assert.equal(prereg.universe.survivorshipSelection, false);
  assert.deepEqual(prereg.features.names, FEATURE_NAMES);
  assert.deepEqual(prereg.model.lambdaGrid, MODEL_LAMBDAS);
  assert.equal(prereg.model.target, 'reference trade net27Bps');
  assert.equal(prereg.model.bootstrapIsNotAGate ?? true, true);
  assert.equal(prereg.referenceTrade.maxHoldHours, 12);
  assert.deepEqual(prereg.referenceTrade.costs, {
    baseBps: 18,
    stressBps: 27,
    severeBps: 36,
    charge: 'One frozen all-in execution cost budget per entry and exit fill; source-embedded costs are not charged twice.'
  });
  assert.equal(prereg.safety.SIGNAL_ONLY, true);
  assert.equal(prereg.safety.PAPER_ONLY, true);
  assert.equal(prereg.safety.AUTO_TRADING, false);
  assert.equal(prereg.safety.accountApi, false);
  assert.equal(prereg.safety.orderApi, false);
  assert.equal(prereg.safety.finalOosRead, false);
  assert.equal(HY_EXP_0038, 'HY-EXP-0038');
});

test('HY-EXP-0038 research implementation has no external or private execution path', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/research/hy-exp-0038-email-signal.mjs'), 'utf8');
  const script = fs.readFileSync(path.join(ROOT, 'scripts/hy-exp-0038.mjs'), 'utf8');
  for (const value of [source, script]) {
    assert.equal(value.includes('fetch('), false);
    assert.equal(value.includes('createTransport'), false);
    assert.equal(value.includes('nodemailer'), false);
    assert.equal(value.includes('PRIVATE_STREAM'), false);
    assert.equal(value.includes('ACCOUNT_API'), false);
    assert.equal(value.includes('ORDER_API'), false);
  }
});

test('every complete decision emits BUY and SELL in BULL, BEAR and SIDEWAYS contexts', () => {
  const decisions = Array.from({ length: 100 }, (_, index) => candidateSidesForRegime(['BULL', 'BEAR', 'SIDEWAYS'][index % 3]));
  assert.equal(decisions.length, 100);
  assert.equal(decisions.flat().filter(side => side === 'BUY').length, 100);
  assert.equal(decisions.flat().filter(side => side === 'SELL').length, 100);
  for (const sides of decisions) assert.deepEqual(sides, ['BUY', 'SELL']);
});

test('entry is the first contract 5m open at or after the completed 15m decision', () => {
  const rows = [{ openTime: 300_000 }, { openTime: 600_000 }, { openTime: 900_000 }];
  assert.equal(resolveEntryTime(rows, 300_000), 300_000);
  assert.equal(resolveEntryTime(rows, 301_000), 600_000);
  assert.equal(resolveEntryTime(rows, 901_000), null);
  const source = fs.readFileSync(path.join(ROOT, 'src/research/hy-exp-0038-email-signal.mjs'), 'utf8');
  assert.equal(source.includes('signalTime: decisionTime'), true);
});

test('terminal max-hold exits at bar open before reading terminal high/low', () => {
  const entryTime = Date.parse('2025-01-01T00:00:00Z');
  const bars = Array.from({ length: 145 }, (_, index) => ({
    openTime: entryTime + index * 5 * 60 * 1000,
    open: 100,
    high: 101,
    low: 99,
    close: 100
  }));
  bars[144] = { ...bars[144], open: 100, high: 10_000, low: 1 };
  const candidate = {
    candidateId: 'terminal',
    symbol: 'BTCUSDT',
    side: 'BUY',
    regime: 'SIDEWAYS',
    signalTime: entryTime,
    decisionTime: entryTime,
    entryTime,
    atr20: 1,
    features: []
  };
  const series = {
    BTCUSDT: {
      contract5: bars,
      contract5ByTime: new Map(bars.map((row, index) => [row.openTime, index])),
      funding: [],
      mark5ByTime: new Map()
    }
  };
  const result = simulateCandidate(candidate, series);
  assert.equal(result.outcomeStatus, 'RESOLVED');
  assert.equal(result.exitReason, 'MAX_HOLD');
  assert.equal(result.exitTime, entryTime + 12 * 60 * 60 * 1000);
  assert.equal(result.exitPrice, 100);
});

test('fitRidge winsorizes only training targets and does not clip transformed features', () => {
  const training = Array.from({ length: 180 }, (_, index) => ({
    features: FEATURE_NAMES.map((_, feature) => ((index + 1) * (feature + 1) % 17) / 17),
    net27Bps: index === 179 ? 10_000 : ((index % 11) - 5) + index / 100
  }));
  const model = fitRidge(training, 1);
  assert.ok(model);
  assert.ok(model.targetWinsorization.upperP99 < 10_000);
  assert.equal('bounds' in model.scaler, false);
  const transformed = model.scaler.transform([1_000_000, ...Array(FEATURE_NAMES.length - 1).fill(0)]);
  assert.ok(transformed[0] > 100_000);
  assert.equal(Number.isFinite(model.predict(training[0].features)), true);
  assert.equal(fitRidge(training.slice(0, 149), 1), null);
});

test('development walk-forward retains a complete independent OOF set for every lambda', () => {
  const rows = Array.from({ length: 720 }, (_, index) => {
    const decisionTime = DEVELOPMENT_START + index * 12 * 60 * 60 * 1000;
    return {
      candidateId: `row-${index}`,
      symbol: FIXED_SYMBOLS[index % FIXED_SYMBOLS.length],
      side: index % 2 ? 'SELL' : 'BUY',
      regime: 'SIDEWAYS',
      decisionTime,
      entryTime: decisionTime,
      exitTime: decisionTime + 60 * 60 * 1000,
      entryPrice: 100,
      exitPrice: 100,
      grossPriceBps: 30,
      fundingBps: 0,
      grossReturnBps: 30,
      net18Bps: 12,
      net27Bps: 3,
      net36Bps: -6,
      outcomeStatus: 'RESOLVED',
      features: FEATURE_NAMES.map((_, feature) => ((index + feature) % 13) / 13)
    };
  });
  const result = runDevelopmentWalkForward(rows);
  const lengths = MODEL_LAMBDAS.map(lambda => result.predictionsByLambda[String(lambda)].length);
  assert.ok(result.folds.length > 0);
  assert.ok(lengths[0] > 0);
  assert.deepEqual(lengths, [lengths[0], lengths[0], lengths[0]]);
  for (const lambda of MODEL_LAMBDAS) {
    assert.equal(new Set(result.predictionsByLambda[String(lambda)].map(row => row.lambda)).size, 1);
    assert.equal(result.predictionsByLambda[String(lambda)][0].lambda, lambda);
  }
  assert.equal(result.predictions.length, lengths.reduce((sum, value) => sum + value, 0));
});

test('lambda and threshold are selected jointly from independent OOF sets', () => {
  const start = DEVELOPMENT_START + 180 * 24 * 60 * 60 * 1000;
  const makeRows = lambda => Array.from({ length: 140 }, (_, index) => ({
    candidateId: `lambda-${lambda}-${index}`,
    symbol: FIXED_SYMBOLS[index % FIXED_SYMBOLS.length],
    side: index % 2 ? 'SELL' : 'BUY',
    decisionTime: start + Math.floor(index * 1.3) * 24 * 60 * 60 * 1000,
    entryTime: start + Math.floor(index * 1.3) * 24 * 60 * 60 * 1000,
    exitTime: start + Math.floor(index * 1.3) * 24 * 60 * 60 * 1000 + 60 * 60 * 1000,
    predictedEdgeBps: 10,
    net27Bps: 8
  }));
  const result = selectDevelopmentConfig(Object.fromEntries(MODEL_LAMBDAS.map(lambda => [String(lambda), makeRows(lambda)])));
  assert.equal(result.status, 'DEVELOPMENT_CONFIG_FOUND');
  assert.equal(result.lambda, 0.1);
  assert.equal(result.selectedMinimumEdgeBps, 10);
  assert.equal(result.NEGATIVE_MODEL_EDGE_THRESHOLD, false);
  assert.equal(result.candidateConfigurations.every(item => MODEL_LAMBDAS.includes(item.lambda)), true);
});

test('frequency rule keeps the higher edge at the same symbol and decision and releases after early exit', () => {
  const start = DEVELOPMENT_START + 200 * 24 * 60 * 60 * 1000;
  const rows = [
    { candidateId: 'same-buy', symbol: 'BTCUSDT', decisionTime: start, exitTime: start + 60 * 60 * 1000, predictedEdgeBps: 11 },
    { candidateId: 'same-sell', symbol: 'BTCUSDT', decisionTime: start, exitTime: start + 60 * 60 * 1000, predictedEdgeBps: 10 },
    { candidateId: 'blocked', symbol: 'BTCUSDT', decisionTime: start + 15 * 60 * 1000, exitTime: start + 2 * 60 * 60 * 1000, predictedEdgeBps: 12 },
    { candidateId: 'released', symbol: 'BTCUSDT', decisionTime: start + 3 * 60 * 60 * 1000, exitTime: start + 4 * 60 * 60 * 1000, predictedEdgeBps: 9 },
    { candidateId: 'other', symbol: 'ETHUSDT', decisionTime: start + 24 * 60 * 60 * 1000, exitTime: start + 36 * 60 * 60 * 1000, predictedEdgeBps: 8 }
  ];
  assert.deepEqual(applyFrequency(rows, 8).map(row => row.candidateId), ['same-buy', 'released', 'other']);
});

test('HY-EXP-0038 promotion risk gate is fail-closed and bootstrap is diagnostic only', () => {
  const risk = {
    portfolioMtmStatus: 'NOT_RECONSTRUCTED',
    portfolioMtmDrawdownFraction: null,
    portfolioCvarStatus: 'NOT_EVALUATED',
    portfolioCvar95: null
  };
  const bootstrap = blockBootstrap([]);
  const gates = evaluatePromotionGates([], { status: 'NO_DEVELOPMENT_CONFIG' }, risk, bootstrap);
  assert.equal(gates.pass, false);
  assert.equal(gates.checks.portfolioMtm, false);
  assert.equal(gates.checks.portfolioCvar, false);
  assert.equal('bootstrapNet27Lower95' in gates.checks, false);
  assert.equal(bootstrap.status, 'EMPTY_SAMPLE_NOT_EVALUABLE');
  assert.equal(bootstrap.iterations, 5000);
  assert.equal(bootstrap.seed, 370038);
});

test('summary uses the best net27 event and positive-profit concentration pools', () => {
  const rows = [
    { candidateId: 'low', symbol: 'BTCUSDT', side: 'BUY', exitTime: Date.parse('2025-01-02T00:00:00Z'), net27Bps: 2, fundingBps: 0, exitReason: 'TARGET' },
    { candidateId: 'best', symbol: 'ETHUSDT', side: 'SELL', exitTime: Date.parse('2025-01-01T00:00:00Z'), net27Bps: 10, fundingBps: 0, exitReason: 'TARGET' },
    { candidateId: 'loss', symbol: 'BTCUSDT', side: 'BUY', exitTime: Date.parse('2025-02-01T00:00:00Z'), net27Bps: -4, fundingBps: 0, exitReason: 'ATR_STOP' }
  ];
  const summary = summarizeRows(rows, 'net27Bps');
  assert.equal(summary.bestEventNetPnlBps, 10);
  assert.equal(summary.netPnlWithoutBestEventBps, -2);
  assert.equal(summary.largestSymbol, 'ETHUSDT');
  assert.equal(summary.largestSymbolProfitContribution, 1);
  assert.equal(summary.largestMonth, '2025-01');
  assert.equal(summary.largestMonthProfitContribution, 12 / 12);
  assert.equal(summary.symbolProfitContributionStatus, 'EVALUABLE');
  const negative = summarizeRows([{ ...rows[2] }], 'net27Bps');
  assert.equal(negative.largestSymbolProfitContribution, null);
  assert.equal(negative.symbolProfitContributionStatus, 'NOT_EVALUABLE_NO_POSITIVE_PROFIT_POOL');
});

test('HY-EXP-0038 preserves costs and explicit non-email preparation', () => {
  assert.deepEqual(COSTS_BPS, { 18: 18, 27: 27, 36: 36 });
  const preparation = buildEmailPreparation({
    validation: { emailPreparationEligible: true },
    codeCommit: 'a'.repeat(40),
    preregistrationSha256: 'b'.repeat(64),
    dataManifestSha256: 'c'.repeat(64)
  });
  assert.equal(preparation.EMAIL_PREPARED, true);
  assert.equal(preparation.EMAIL_ACTIVATED, false);
  assert.equal(preparation.gmailSendEnabled, false);
  assert.equal(preparation.noQuantity, true);
  assert.equal(preparation.noLeverage, true);
  assert.equal(preparation.noOrderInstruction, true);
  assert.equal(preparation.finalOosRead, false);
  assert.equal(VALIDATION_END - VALIDATION_START, 365 * 24 * 60 * 60 * 1000);
  assert.equal(DEVELOPMENT_END - DEVELOPMENT_START, 365 * 24 * 60 * 60 * 1000);
});
