import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateCandidate } from '../src/model/candidate-engine.mjs';
import {
  candidateFromH12Signal,
  candidateFromH9Signal
} from '../src/model/profit-v3-candidates.mjs';

const BOOK = {
  bids: [[99.99, 100], [99.98, 100]],
  asks: [[100.01, 100], [100.02, 100]],
  receivedAt: 9_950
};

function candidate(overrides = {}) {
  return {
    experimentId: 'HY-EXP-0019',
    hypothesisId: 'TEST',
    symbol: 'BTCUSDT',
    side: 'BUY',
    regime: 'BULL',
    quantity: 1,
    researchNotionalUsdt: 1_000,
    forecastTime: 9_900,
    bookTime: 9_950,
    decisionTime: 9_950,
    stopPrice: 99,
    expectedFundingBps: 0,
    fundingStressBps: 0,
    ...overrides
  };
}

function edge(overrides = {}) {
  return {
    expectedPriceEdgeBps: 200,
    standardErrorBps: 1,
    edgeSource: 'TEST_FORWARD_MODEL',
    edgeModelId: 'TEST-EDGE-001',
    sampleSize: 50,
    validationWindow: { method: 'expanding_walk_forward_purged', trainEnd: 9_000 },
    available: true,
    ...overrides
  };
}

test('Candidate Engine is the only layer allowed to create a paper Advisory', () => {
  const result = evaluateCandidate({
    candidate: candidate(),
    edgeModel: { estimate: () => edge() },
    book: BOOK,
    now: 10_000
  });
  assert.equal(result.decision, 'ADVISORY');
  assert.equal(result.netEdge.decision, 'TRADE');
  assert.equal(result.portfolio.decision, 'PORTFOLIO_ALLOWED');
  assert.equal(result.advisory.paperOnly, true);
  assert.equal(result.advisory.liveOrdersEnabled, false);
  assert.equal(result.edge.edgeModelId, 'TEST-EDGE-001');
  assert.equal(result.edge.sampleSize, 50);
  assert.equal(result.advisory.costs.expectedPriceEdgeBps, 200);
});

test('Candidate cannot smuggle a direct expected edge or a final decision', () => {
  assert.throws(() => evaluateCandidate({
    candidate: candidate({ expectedPriceEdgeBps: 900 }),
    book: BOOK,
    now: 10_000
  }), /edge fields must be supplied by Edge Model/);
  assert.throws(() => evaluateCandidate({
    candidate: candidate({ decision: 'TRADE' }),
    edge: edge(),
    book: BOOK,
    now: 10_000
  }), /candidate must not contain decision/);
});

test('unverified Edge Model output can never become an Advisory', () => {
  const result = evaluateCandidate({
    candidate: candidate(),
    edge: edge({
      expectedPriceEdgeBps: null,
      standardErrorBps: null,
      edgeSource: 'UNVERIFIED',
      available: false,
      sampleSize: 0,
      rejectionReason: 'EDGE_INSUFFICIENT_SAMPLES'
    }),
    book: BOOK,
    now: 10_000
  });
  assert.equal(result.decision, 'NO_TRADE');
  assert.ok(result.reasons.includes('EDGE_INSUFFICIENT_SAMPLES'));
  assert.ok(result.reasons.includes('unverified_price_edge'));
  assert.equal(result.advisory.action, null);
});

test('H9 and H12 adapters produce neutral Candidates without strategy decisions', () => {
  for (const adapter of [candidateFromH9Signal, candidateFromH12Signal]) {
    const result = adapter({
      symbol: 'ETHUSDT',
      side: 'SELL',
      quantity: 2,
      signalTime: 1_000,
      decisionTime: 2_000,
      decisionReceivedAt: 2_000,
      decision: 'TRADE',
      status: 'ADVISORY',
      action: 'REVIEW_SELL',
      executablePrice: 99
    }, { experimentId: 'HY-EXP-0019' });
    assert.equal(result.sourceStrategy, adapter === candidateFromH9Signal ? 'H9' : 'H12');
    assert.equal('decision' in result, false);
    assert.equal('status' in result, false);
    assert.equal('action' in result, false);
    assert.equal(result.bookTime, 2_000);
  }
});
