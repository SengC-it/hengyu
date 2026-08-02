import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildH1Candidate,
  buildH2Candidate,
  buildH3Candidate,
  buildH5Candidate,
  buildHypothesisCandidate
} from '../src/model/hypotheses.mjs';
import { evaluateHypothesisObservation } from '../src/model/advisory-evaluator.mjs';

const BOOK = {
  bids: [[99.9, 10], [99.8, 10]],
  asks: [[100.1, 10], [100.2, 10]]
};

test('H1 turns sell liquidation pressure and recovered depth into a long candidate', () => {
  const result = buildH1Candidate({
    event: { symbol: 'BTCUSDT', pressureBps: -20, recoveryRatio: 0.9, eventImpulseBps: 40, decisionTime: 10_000 },
    quantity: 1,
    now: 10_000
  });
  assert.equal(result.status, 'CANDIDATE');
  assert.equal(result.candidate.side, 'BUY');
  assert.ok(result.candidate.expectedPriceEdgeBps > 0);
});

test('H2 requires same-direction funding and OI crowding', () => {
  const result = buildH2Candidate({
    observation: { symbol: 'ETHUSDT', fundingBps: 12, oiChangeBps: 8 },
    quantity: 1,
    now: 10_000
  });
  assert.equal(result.candidate.side, 'SELL');
  const rejected = buildH2Candidate({
    observation: { symbol: 'ETHUSDT', fundingBps: 12, oiChangeBps: -8 },
    quantity: 1,
    now: 10_000
  });
  assert.equal(rejected.status, 'NO_CANDIDATE');
  assert.ok(rejected.reasons.includes('funding_oi_not_crowded'));
});

test('H3 removes beta and trades residual mean reversion', () => {
  const result = buildH3Candidate({
    observation: { symbol: 'SOLUSDT', assetReturnBps: -30, marketReturnBps: -10, beta: 1 },
    quantity: 1,
    now: 10_000
  });
  assert.equal(result.features.residualBps, -20);
  assert.equal(result.candidate.side, 'BUY');
});

test('H5 buys an under-reacting symbol after a positive BTC shock', () => {
  const result = buildH5Candidate({
    observation: { symbol: 'XRPUSDT', btcShockBps: 100, symbolReturnBps: 20, beta: 1 },
    quantity: 1,
    now: 10_000
  });
  assert.equal(result.features.responseGapBps, 80);
  assert.equal(result.candidate.side, 'BUY');
});

test('dispatcher rejects unregistered hypotheses', () => {
  assert.throws(() => buildHypothesisCandidate({ hypothesisId: 'H4' }), /unsupported hypothesis/);
});

test('observation evaluator always returns a manual-only envelope', () => {
  const signal = evaluateHypothesisObservation({
    hypothesisId: 'H2',
    observation: { symbol: 'ETHUSDT', fundingBps: 1, oiChangeBps: 1 },
    book: BOOK,
    quantity: 1,
    now: 10_000
  });
  assert.equal(signal.status, 'NO_TRADE');
  assert.equal(signal.manualOnly.orderPlacement, false);
  assert.equal(signal.manualOnly.accountAccess, false);
});

test('data quality failure blocks hypothesis evaluation before feature logic', () => {
  const signal = evaluateHypothesisObservation({
    hypothesisId: 'H1',
    observation: { symbol: 'BTCUSDT', pressureBps: -100, recoveryRatio: 1, eventImpulseBps: 100 },
    book: BOOK,
    quantity: 1,
    now: 10_000,
    quality: { status: 'NOT_READY', reasons: ['depth_sequence_gap'] }
  });
  assert.equal(signal.status, 'NO_TRADE');
  assert.deepEqual(signal.reasons, ['depth_sequence_gap']);
});
