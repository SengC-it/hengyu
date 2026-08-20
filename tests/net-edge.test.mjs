import assert from 'node:assert/strict';
import test from 'node:test';
import {
  estimateRoundTripCost,
  evaluateNetEdge,
  evaluatePortfolioRisk,
  sizeByStopRisk,
  walkBook
} from '../src/model/net-edge.mjs';

const BOOK = {
  bids: [[99.9, 2], [99.8, 5]],
  asks: [[100.1, 1], [100.2, 5]]
};

const POLICY = {
  confidenceZ: 1.645,
  minimumConservativeNetBps: 3,
  minimumGrossToCostRatio: 1.5,
  maximumForecastAgeMs: 5_000,
  maximumBookAgeMs: 1_000,
  maximumVisibleBookFraction: 0.25,
  feeRatePerFill: 0.0005,
  bookStressMultiplier: 2,
  impactBufferBpsPerFill: 1,
  latencyBufferBpsPerFill: 1
};

function candidate(overrides = {}) {
  return {
    symbol: 'BTCUSDT',
    side: 'BUY',
    expectedPriceEdgeBps: 100,
    forecastStandardErrorBps: 5,
    expectedFundingBps: -1,
    fundingStressBps: 1,
    quantity: 1,
    forecastTime: 9_000,
    bookTime: 9_500,
    ...overrides
  };
}

test('book walk uses adverse levels and rejects unavailable quantity', () => {
  const fill = walkBook({ side: 'BUY', quantity: 2, book: BOOK });
  assert.equal(fill.fillable, true);
  assert.equal(fill.usedLevels, 2);
  assert.ok(Math.abs(fill.vwap - 100.15) < 1e-12);
  assert.equal(walkBook({ side: 'BUY', quantity: 7, book: BOOK }).fillable, false);
});

test('round-trip cost includes two fees, both book sides and stress buffers', () => {
  const cost = estimateRoundTripCost({
    side: 'BUY',
    quantity: 1,
    book: BOOK,
    feeRatePerFill: 0.0005,
    bookStressMultiplier: 2,
    impactBufferBpsPerFill: 1,
    latencyBufferBpsPerFill: 1
  });
  assert.equal(cost.fillable, true);
  assert.equal(cost.feeBps, 10);
  assert.ok(cost.spreadBps > 0);
  assert.ok(cost.slippageBps >= 0);
  assert.equal(cost.impactBufferBps, 2);
  assert.equal(cost.latencyBufferBps, 2);
  assert.ok(cost.totalExecutionCostBps > 30);
});

test('net-edge gate trades only after costs, uncertainty and funding stress', () => {
  const pass = evaluateNetEdge({ candidate: candidate(), book: BOOK, policy: POLICY, now: 10_000 });
  assert.equal(pass.decision, 'TRADE');
  assert.ok(pass.metrics.conservativeNetEdgeBps >= POLICY.minimumConservativeNetBps);

  const fail = evaluateNetEdge({
    candidate: candidate({ expectedPriceEdgeBps: 55, forecastStandardErrorBps: 8 }),
    book: BOOK,
    policy: POLICY,
    now: 10_000
  });
  assert.equal(fail.decision, 'NO_TRADE');
  assert.ok(fail.reasons.includes('insufficient_conservative_net_edge'));
});

test('net-edge gate rejects stale or capacity-heavy candidates', () => {
  const result = evaluateNetEdge({
    candidate: candidate({ quantity: 1.8, forecastTime: 1_000, bookTime: 1_000 }),
    book: BOOK,
    policy: POLICY,
    now: 10_000
  });
  assert.equal(result.decision, 'NO_TRADE');
  assert.ok(result.reasons.includes('stale_forecast'));
  assert.ok(result.reasons.includes('stale_book'));
  assert.ok(result.reasons.includes('visible_depth_participation'));
});

test('risk sizing caps notional and rounds down to the exchange step', () => {
  const size = sizeByStopRisk({
    equity: 10_000,
    riskFraction: 0.0025,
    stopDistanceBps: 100,
    price: 101,
    quantityStep: 0.01,
    minimumNotional: 5,
    maximumNotional: 2_000,
    maximumGrossLeverage: 1
  });
  assert.equal(size.decision, 'SIZE_AVAILABLE');
  assert.equal(size.quantity, 19.8);
  assert.ok(size.notional <= 2_000);
  assert.ok(size.lossAtStop <= size.lossBudget);
});

test('portfolio gate rejects hidden directional, beta and event-cluster risk', () => {
  const result = evaluatePortfolioRisk({
    equity: 10_000,
    positions: [
      { symbol: 'ETHUSDT', side: 'BUY', notional: 4_000, beta: 1.2, lossAtStop: 80, cluster: 'event-a' },
      { symbol: 'SOLUSDT', side: 'BUY', notional: 3_000, beta: 1.5, lossAtStop: 70, cluster: 'event-a' }
    ],
    limits: {
      maximumPositions: 5,
      maximumGrossLeverage: 1,
      maximumNetExposureFraction: 0.2,
      maximumBetaExposureFraction: 0.2,
      maximumPortfolioLossFraction: 0.02,
      maximumSinglePositionFraction: 0.5,
      maximumClusterLossFraction: 0.01
    }
  });
  assert.equal(result.decision, 'NO_TRADE');
  assert.ok(result.reasons.includes('net_exposure'));
  assert.ok(result.reasons.includes('beta_exposure'));
  assert.ok(result.reasons.includes('cluster_stop_loss'));
});
