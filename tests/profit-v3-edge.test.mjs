import assert from 'node:assert/strict';
import test from 'node:test';
import {
  estimateProfitV3Edge,
  PROFIT_V3_EDGE_MODEL_ID,
  PROFIT_V3_EDGE_SOURCE
} from '../src/model/profit-v3-edge.mjs';

test('Profit V3 edge is a causal purged forward-return estimate, not breakout distance', () => {
  const candidate = {
    side: 'BUY',
    regime: 'BULL',
    signalTime: 20_000,
    decisionTime: 20_000,
    breakoutDistanceBps: 900
  };
  const result = estimateProfitV3Edge({
    candidate,
    observations: [
      { symbol: 'BTCUSDT', side: 'BUY', regime: 'BULL', signalTime: 1_000, labelEndTime: 2_000, forwardReturnBps: 20 },
      { symbol: 'ETHUSDT', side: 'BUY', regime: 'BULL', signalTime: 3_000, labelEndTime: 4_000, forwardReturnBps: 40 },
      { symbol: 'SOLUSDT', side: 'BUY', regime: 'BULL', signalTime: 6_000, labelEndTime: 7_000, forwardReturnBps: 60 },
      // This label overlaps the target purge window and must not be used.
      { symbol: 'BNBUSDT', side: 'BUY', regime: 'BULL', signalTime: 18_000, labelEndTime: 19_000, forwardReturnBps: 900 },
      // A future observation must not be used either.
      { symbol: 'XRPUSDT', side: 'BUY', regime: 'BULL', signalTime: 21_000, labelEndTime: 22_000, forwardReturnBps: 1_000 },
      { symbol: 'DOGEUSDT', side: 'SELL', regime: 'BEAR', signalTime: 1_000, labelEndTime: 2_000, forwardReturnBps: 999 }
    ],
    asOf: 20_000,
    trainStart: 0,
    trainEnd: 20_000,
    horizonBars: 2,
    barIntervalMs: 1_000,
    purgeBars: 2,
    minimumSamples: 3
  });
  assert.equal(result.available, true);
  assert.equal(result.expectedPriceEdgeBps, 40);
  assert.ok(result.standardErrorBps > 0);
  assert.equal(result.edgeSource, PROFIT_V3_EDGE_SOURCE);
  assert.equal(result.edgeModelId, PROFIT_V3_EDGE_MODEL_ID);
  assert.equal(result.sampleSize, 3);
  assert.deepEqual(result.sampleTimes, [1_000, 3_000, 6_000]);
  assert.equal(result.featureSummary.breakoutDistanceBps, 900);
  assert.notEqual(result.expectedPriceEdgeBps, candidate.breakoutDistanceBps);
  assert.equal(result.validationWindow.purgeBars, 2);
});

test('insufficient causal samples are explicitly unverified', () => {
  const result = estimateProfitV3Edge({
    candidate: { side: 'SELL', regime: 'BEAR', signalTime: 10_000, decisionTime: 10_000 },
    observations: [
      { side: 'SELL', regime: 'BEAR', signalTime: 1_000, labelEndTime: 2_000, forwardReturnBps: 12 }
    ],
    asOf: 10_000,
    trainEnd: 10_000,
    horizonBars: 2,
    barIntervalMs: 1_000,
    purgeBars: 2,
    minimumSamples: 2
  });
  assert.equal(result.available, false);
  assert.equal(result.expectedPriceEdgeBps, null);
  assert.equal(result.standardErrorBps, null);
  assert.equal(result.edgeSource, 'UNVERIFIED');
  assert.equal(result.rejectionReason, 'EDGE_INSUFFICIENT_SAMPLES');
});

test('a label that crosses the development/OOS boundary is excluded from OOS training', () => {
  const result = estimateProfitV3Edge({
    candidate: { side: 'BUY', regime: 'BULL', signalTime: 30_000, decisionTime: 30_000 },
    observations: [
      { side: 'BUY', regime: 'BULL', signalTime: 1_000, labelEndTime: 2_000, forwardReturnBps: 10 },
      { side: 'BUY', regime: 'BULL', signalTime: 19_000, labelEndTime: 21_000, forwardReturnBps: 1_000 }
    ],
    asOf: 30_000,
    trainStart: 0,
    trainEnd: 20_000,
    horizonBars: 1,
    barIntervalMs: 1_000,
    purgeBars: 0,
    minimumSamples: 1
  });
  assert.equal(result.sampleSize, 1);
  assert.equal(result.expectedPriceEdgeBps, 10);
  assert.deepEqual(result.sampleTimes, [1_000]);
});
