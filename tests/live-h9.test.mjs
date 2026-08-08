import assert from 'node:assert/strict';
import test from 'node:test';
import { LiveH9Scanner } from '../src/model/live-h9.mjs';
import { buildH9AdvisorySignal } from '../src/model/advisory-signal.mjs';

const policy = {
  windowMs: 60,
  tradeLookbackMs: 60,
  warmupMs: 0,
  pressureThresholdLookbackMs: 300,
  pressureQuantile: 0.995,
  cooldownMs: 120,
  recoveryDelayMs: 5,
  recoveryObservationMaxDelayMs: 2,
  preEventDepthWindowMs: 60,
  depthBps: 10,
  depthLevels: 5,
  recoveryDepthRatio: 0.8,
  stopImpulseFraction: 0.75,
  takeProfitImpulseMultiplier: 1,
  alertLevel: 'MEDIUM',
  maxSignalToFillMs: 2_000,
  maxHoldMs: 900_000,
  fixedNotionalPerEvent: 100,
  feeRatePerFill: 0.0005,
  bookStressMultiplier: 2,
  impactBufferBpsPerFill: 1,
  latencyBufferBpsPerFill: 1
};

function book(symbol, eventTime, mid, receivedAt = eventTime) {
  return {
    symbol,
    eventTime,
    receivedAt,
    bids: [[mid - 0.01, 10], [mid - 0.02, 10], [mid - 0.03, 10]],
    asks: [[mid + 0.01, 10], [mid + 0.02, 10], [mid + 0.03, 10]]
  };
}

function addPressure(scanner, eventTime, pressure) {
  scanner.recordTrade({ symbol: 'BTCUSDT', eventTime, receivedAt: eventTime, quoteNotional: 100 });
  scanner.recordForceOrder({ symbol: 'BTCUSDT', eventTime, receivedAt: eventTime, pressure });
}

test('live H9 closes causal windows and emits a directional TP/SL signal', () => {
  const scanner = new LiveH9Scanner({ symbols: ['BTCUSDT'], policy, now: 0 });
  for (const end of [60, 120, 180, 240, 300]) {
    addPressure(scanner, end - 10, 100);
    scanner.tick(end);
  }
  scanner.recordBook(book('BTCUSDT', 250, 100));
  scanner.recordBook(book('BTCUSDT', 299, 100));
  scanner.recordBook(book('BTCUSDT', 310, 98));
  scanner.recordBook(book('BTCUSDT', 340, 98));
  addPressure(scanner, 350, -1_000);
  scanner.tick(360);
  scanner.recordBook(book('BTCUSDT', 365, 99));

  const events = scanner.tick(365);
  assert.equal(events.length, 1);
  assert.equal(events[0].side, 'BUY');
  assert.equal(events[0].stopPrice, 97.5);
  assert.equal(events[0].takeProfitPrice, 101.01);
  assert.equal(events[0].alertLevel, 'MEDIUM');

  const signal = buildH9AdvisorySignal({ event: events[0], policy });
  assert.equal(signal.reference.entryPrice, 99.01);
  assert.equal(signal.reference.stopPrice, 97.5);
  assert.equal(signal.reference.takeProfitPrice, 101.01);
  assert.equal(signal.alertLevel, 'MEDIUM');
  assert.equal(signal.delivery.email, 'DIGEST_15M');
});

test('live H9 state snapshot retains warmup history without raw event buffers', () => {
  const scanner = new LiveH9Scanner({ symbols: ['BTCUSDT'], policy, now: 0 });
  addPressure(scanner, 50, 100);
  scanner.tick(60);
  const snapshot = scanner.snapshot();
  assert.equal(snapshot.symbols.BTCUSDT.trades, undefined);
  assert.equal(snapshot.symbols.BTCUSDT.pressureWindows.length, 1);
  const restored = new LiveH9Scanner({ symbols: ['BTCUSDT'], policy, state: snapshot, now: 60 });
  assert.equal(restored.status().warmup.BTCUSDT.pressureWindows, 1);
});
