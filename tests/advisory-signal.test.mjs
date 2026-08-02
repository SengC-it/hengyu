import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advisoryFreshness,
  buildH9AdvisorySignal
} from '../src/model/advisory-signal.mjs';

const policy = {
  fixedNotionalPerEvent: 100,
  maxSignalToFillMs: 100,
  maxHoldMs: 3_000,
  feeRatePerFill: 0.0005,
  bookStressMultiplier: 2,
  impactBufferBpsPerFill: 1,
  latencyBufferBpsPerFill: 1
};

const event = {
  eventId: 'BTCUSDT:2000:BUY',
  symbol: 'BTCUSDT',
  side: 'BUY',
  decisionTime: 3_000,
  decisionReceivedAt: 3_001,
  decisionMid: 99,
  stopPrice: 98,
  pressure: -0.5,
  threshold: 0.1,
  recoveryRatio: 0.9,
  eventImpulse: 2,
  clusterId: '1',
  decisionBook: {
    bids: [[98.9, 20], [98.8, 20]],
    asks: [[99.1, 20], [99.2, 20]]
  }
};

test('H9 event becomes a manual-review signal with causal timing and reference prices', () => {
  const signal = buildH9AdvisorySignal({ event, policy });
  assert.equal(signal.action, 'REVIEW_BUY');
  assert.equal(signal.reference.oppositeBestPrice, 99.1);
  assert.equal(signal.validUntil, 3_101);
  assert.equal(signal.expiresAt, 6_000);
  assert.ok(signal.reference.stopDistanceBps > 100);
  assert.equal(signal.manualOnly.requiresHumanConfirmation, true);
  assert.equal(signal.manualOnly.autoExecution, false);
  assert.equal(signal.manualOnly.orderPlacement, false);
  assert.equal(signal.evidenceClass, 'F0_PENDING');
  assert.equal(signal.researchExecution.fillableAtDecisionBook, true);
});

test('signal freshness rejects late review rather than extending its validity', () => {
  const signal = buildH9AdvisorySignal({ event, policy });
  assert.deepEqual(advisoryFreshness(signal, { now: 3_001 }), { status: 'FRESH', fresh: true });
  assert.deepEqual(advisoryFreshness(signal, { now: 3_101 }), { status: 'FRESH', fresh: true });
  assert.deepEqual(advisoryFreshness(signal, { now: 3_102 }), { status: 'EXPIRED', fresh: false });
  assert.deepEqual(advisoryFreshness(signal, { now: 3_000 }), { status: 'NOT_YET_RECEIVED', fresh: false });
});

test('signal construction refuses an incomplete decision book', () => {
  assert.throws(
    () => buildH9AdvisorySignal({ event: { ...event, decisionBook: { bids: [] } }, policy }),
    /decision book has no opposite quote/
  );
});

