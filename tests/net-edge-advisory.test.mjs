import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advisoryFreshness,
  buildModelSimulationRecord,
  buildNetEdgeAdvisorySignal
} from '../src/model/net-edge-advisory.mjs';

const BOOK = {
  bids: [[99.9, 10], [99.8, 10]],
  asks: [[100.1, 10], [100.2, 10]]
};

const POLICY = {
  experimentId: 'HY-EXP-0014',
  signalValidityMs: 2_000,
  researchExpiryMs: 900_000,
  feeRatePerFill: 0.0005,
  bookStressMultiplier: 2,
  impactBufferBpsPerFill: 1,
  latencyBufferBpsPerFill: 1,
  confidenceZ: 1.645,
  minimumConservativeNetBps: 3,
  minimumGrossToCostRatio: 1.5,
  maximumForecastAgeMs: 5_000,
  maximumBookAgeMs: 1_000,
  maximumVisibleBookFraction: 0.25,
  strongMinConservativeNetBps: 6,
  strongMinGrossToCostRatio: 2,
  mediumMinConservativeNetBps: 3,
  mediumMinGrossToCostRatio: 1.5
};

function candidate(overrides = {}) {
  return {
    hypothesisId: 'H1',
    symbol: 'BTCUSDT',
    side: 'BUY',
    quantity: 1,
    expectedPriceEdgeBps: 130,
    forecastStandardErrorBps: 2,
    expectedFundingBps: 0,
    fundingStressBps: 0,
    forecastTime: 9_000,
    bookTime: 9_500,
    decisionTime: 9_500,
    stopPrice: 99,
    expectedExitPrice: 101,
    ...overrides
  };
}

test('net-edge advisory emits strong manual-only signal without account fields', () => {
  const signal = buildNetEdgeAdvisorySignal({ candidate: candidate(), book: BOOK, policy: POLICY, now: 10_000 });
  assert.equal(signal.status, 'ADVISORY');
  assert.equal(signal.alertLevel, 'STRONG');
  assert.equal(signal.action, 'REVIEW_BUY');
  assert.equal(signal.manualOnly.orderPlacement, false);
  assert.equal(signal.manualOnly.quantityProvided, false);
  assert.equal(Object.hasOwn(signal, 'quantity'), false);
  assert.equal(Object.hasOwn(signal, 'leverage'), false);
  assert.equal(signal.reference.stopPrice, 99);
  assert.ok(signal.costs.conservativeNetEdgeBps >= 6);
});

test('sub-threshold positive edge is observed and never emailed', () => {
  const signal = buildNetEdgeAdvisorySignal({
    candidate: candidate({ expectedPriceEdgeBps: 62, forecastStandardErrorBps: 4 }),
    book: BOOK,
    policy: POLICY,
    now: 10_000
  });
  assert.equal(signal.alertLevel, 'OBSERVE');
  assert.equal(signal.delivery.email, 'NONE');
  assert.equal(signal.status, 'OBSERVE');
});

test('stale candidate is NO_TRADE and simulation contains model fields only', () => {
  const signal = buildNetEdgeAdvisorySignal({
    candidate: candidate({ forecastTime: 1_000, bookTime: 1_000 }),
    book: BOOK,
    policy: POLICY,
    now: 10_000
  });
  assert.equal(signal.status, 'NO_TRADE');
  assert.equal(signal.alertLevel, 'NONE');
  assert.ok(signal.reasons.includes('stale_forecast'));
  const simulation = buildModelSimulationRecord({
    signal,
    outcome: { status: 'CLOSED', netPnl: -2, stressNetPnl: -3, entryTime: 10_000, exitTime: 11_000 }
  });
  assert.equal(simulation.accountDataUsed, false);
  assert.equal(simulation.humanFeedbackRecorded, false);
  assert.equal(Object.hasOwn(simulation, 'quantity'), false);
});

test('advisory freshness is bounded by generated validity', () => {
  const signal = buildNetEdgeAdvisorySignal({ candidate: candidate(), book: BOOK, policy: POLICY, now: 10_000 });
  assert.deepEqual(advisoryFreshness(signal, { now: 10_000 }), { status: 'FRESH', fresh: true });
  assert.deepEqual(advisoryFreshness(signal, { now: 12_001 }), { status: 'EXPIRED', fresh: false });
});
