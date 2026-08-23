import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  edgeGateFromPrediction,
  fitHyExp0024Ridge,
  HY_EXP_0024_EDGE_MODEL_ID,
  HY_EXP_0024_EDGE_SOURCE,
  HY_EXP_0024_FEATURES,
  predictHyExp0024Ridge
} from '../src/model/hy-exp-0024-edge.mjs';
import {
  DEVELOPMENT_END,
  DEVELOPMENT_START,
  estimateHyExp0024FundingExpectation,
  FOLDS,
  HISTORICAL_EXECUTION_DELAY_MS,
  historicalExecutionOpenTime,
  selectExactHistoricalEntry
} from '../src/research/hy-exp-0024.mjs';

function syntheticRows(count = 120) {
  return Array.from({ length: count }, (_, index) => {
    const x = [
      (index % 23) / 10,
      ((index * 7) % 29) / 10,
      ((index * 11) % 31) / 10,
      (index % 5) / 5,
      1,
      Math.log1p(index + 1),
      0.01 + (index % 7) / 1_000,
      ((index * 13) % 37) / 10
    ];
    return { features: x, targetBps: 15 + 35 * x[0] - 12 * x[1] + 3 * x[6] };
  });
}

test('HY-EXP-0024 Ridge produces candidate-level predictions, not a pooled cell mean', () => {
  const model = fitHyExp0024Ridge(syntheticRows(), {
    lambda: 1,
    minimumSamples: 100,
    cell: 'BULL/BUY/TREND_BREAKOUT'
  });
  assert.ok(model);
  const left = predictHyExp0024Ridge(model, [0, 0, 0, 0.5, 1, 3, 0.01, 0]);
  const right = predictHyExp0024Ridge(model, [5, 5, 5, 0.5, 1, 8, 0.02, 5]);
  assert.equal(left.available, true);
  assert.equal(right.available, true);
  assert.notEqual(left.expectedPriceEdgeBps, right.expectedPriceEdgeBps);
  assert.equal(left.edgeModelId, HY_EXP_0024_EDGE_MODEL_ID);
  assert.equal(left.edgeSource, HY_EXP_0024_EDGE_SOURCE);
  assert.equal(left.sampleSize, 120);
  assert.ok(left.standardErrorBps >= 0);
});

test('HY-EXP-0024 edge is unavailable below the frozen minimum sample size', () => {
  const model = fitHyExp0024Ridge(syntheticRows(99), { minimumSamples: 100 });
  assert.equal(model, null);
  const edge = predictHyExp0024Ridge(model, Array(HY_EXP_0024_FEATURES.length).fill(1));
  assert.equal(edge.available, false);
  assert.equal(edge.expectedPriceEdgeBps, null);
  assert.equal(edge.edgeSource, 'UNVERIFIED');
});

test('HY-EXP-0024 Net Edge applies historical proxy costs after gross edge and uncertainty', () => {
  const edge = {
    available: true,
    expectedPriceEdgeBps: 50,
    standardErrorBps: 2,
    edgeSource: HY_EXP_0024_EDGE_SOURCE,
    edgeModelId: HY_EXP_0024_EDGE_MODEL_ID
  };
  const base = edgeGateFromPrediction(edge, 1, 0.5);
  const stress = edgeGateFromPrediction(edge, 1, 0.5, { executionCostBps: 18, stressMultiplier: 1.5 });
  assert.equal(base.executionCostBps, 18);
  assert.equal(stress.executionCostBps, 27);
  assert.equal(base.expectedGrossEdgeBps, 51);
  assert.equal(stress.expectedGrossEdgeBps, 51);
  assert.ok(stress.conservativeNetEdgeBps < base.conservativeNetEdgeBps);
  assert.equal(edge.featureSummary, undefined);
});

test('HY-EXP-0024 walk-forward folds freeze six-bar purge and embargo', () => {
  assert.equal(FOLDS.length, 6);
  assert.equal(FOLDS[0].trainStartMs, DEVELOPMENT_START);
  assert.equal(FOLDS.at(-1).validationEndMs, DEVELOPMENT_END);
  for (const fold of FOLDS) {
    assert.equal(fold.purgeCutoffMs, fold.validationStartMs - 6 * 60 * 60 * 1_000);
    assert.equal(fold.embargoEndMs, fold.validationEndMs + 6 * 60 * 60 * 1_000);
    assert.ok(fold.trainEndMs <= fold.validationStartMs);
  }
});

test('HY-EXP-0024 historical execution requires the exact +5m bar and never rescues later data', () => {
  const theoreticalDecisionTime = Date.parse('2025-01-01T00:00:00.000Z');
  assert.equal(historicalExecutionOpenTime(theoreticalDecisionTime), theoreticalDecisionTime + HISTORICAL_EXECUTION_DELAY_MS);
  assert.deepEqual(selectExactHistoricalEntry({
    theoreticalDecisionTime,
    bars: [{ openTime: theoreticalDecisionTime + 10 * 60 * 1_000, open: 105 }]
  }), {
    included: false,
    requiredOpenTime: theoreticalDecisionTime + 5 * 60 * 1_000,
    entryPrice: null
  });
  assert.deepEqual(selectExactHistoricalEntry({
    theoreticalDecisionTime,
    bars: [{ openTime: theoreticalDecisionTime + 5 * 60 * 1_000, open: 101 }]
  }), {
    included: true,
    requiredOpenTime: theoreticalDecisionTime + 5 * 60 * 1_000,
    entryPrice: 101
  });
});

test('HY-EXP-0024 funding expectation is causal and does not read a future rate', () => {
  const decisionTime = Date.parse('2025-01-01T00:00:00.000Z');
  const past = { eventTime: decisionTime - 2 * 60 * 60 * 1_000, fundingRate: 0.0002, fundingIntervalHours: 4 };
  const future = { eventTime: decisionTime + 2 * 60 * 60 * 1_000, fundingRate: 0.99, fundingIntervalHours: 4 };
  const withoutFuture = estimateHyExp0024FundingExpectation([past], 'BUY', decisionTime);
  const withFuture = estimateHyExp0024FundingExpectation([past, future], 'BUY', decisionTime);
  assert.deepEqual(withFuture, withoutFuture);
  assert.equal(withFuture.expectedFundingBps, -2);
  assert.equal(estimateHyExp0024FundingExpectation([], 'SELL', decisionTime).usable, false);
});

test('HY-EXP-0024 Development evidence is signal-only and Final OOS remains sealed', () => {
  const result = JSON.parse(fs.readFileSync('artifacts/HY-EXP-0024/development-result.json', 'utf8'));
  const manifest = JSON.parse(fs.readFileSync('artifacts/HY-EXP-0024/development-manifest.json', 'utf8'));
  assert.equal(result.experimentId, 'HY-EXP-0024');
  assert.equal(result.authorization, 'PAPER_ONLY');
  assert.equal(result.signalOnly, true);
  assert.equal(result.liveOrdersEnabled, false);
  assert.equal(result.accountApi, false);
  assert.equal(result.orderApi, false);
  assert.equal(result.finalOosRead, false);
  assert.equal(result.finalOosPnlComputed, false);
  assert.equal(result.development.experimentalReleaseReady, false);
  assert.equal(result.development.metrics.edgeAvailableCount > 0, true);
  assert.equal(result.development.metrics.advisoryCount, 0);
  assert.equal(manifest.finalOosRead, false);
  assert.equal(manifest.developmentPnlComputed, true);
  assert.equal(manifest.finalOosPnlComputed, false);
  assert.equal(manifest.paperOnly, true);
});
