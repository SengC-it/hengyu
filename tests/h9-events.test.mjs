import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_H9_POLICY,
  buildPressureWindows,
  detectH9Events,
  replayH9Event,
  summarizeH9Trades
} from '../src/model/h9-events.mjs';

const policy = {
  ...DEFAULT_H9_POLICY,
  windowMs: 1_000,
  tradeLookbackMs: 5_000,
  warmupMs: 0,
  pressureQuantile: 0.5,
  cooldownMs: 2_000,
  recoveryDelayMs: 1_000,
  recoveryObservationMaxDelayMs: 100,
  preEventDepthWindowMs: 1_000,
  maxSignalToFillMs: 100,
  maxHoldMs: 3_000,
  clusterMs: 5_000
};

function book(symbol, eventTime, mid, quantity = 10) {
  const bids = Array.from({ length: 5 }, (_, index) => [mid - 0.01 - index * 0.01, quantity]);
  const asks = Array.from({ length: 5 }, (_, index) => [mid + 0.01 + index * 0.01, quantity]);
  return { symbol, eventTime, receivedAt: eventTime, bids, asks };
}

test('pressure thresholds are causal and do not include the current window', () => {
  const rows = buildPressureWindows({
    symbols: ['BTCUSDT'],
    forceOrders: [
      { symbol: 'BTCUSDT', eventTime: 900, pressure: -100 },
      { symbol: 'BTCUSDT', eventTime: 1_900, pressure: -500 }
    ],
    trades: [
      { symbol: 'BTCUSDT', eventTime: 500, quoteNotional: 1_000 },
      { symbol: 'BTCUSDT', eventTime: 1_500, quoteNotional: 1_000 }
    ],
    windowEnds: [1_000, 2_000],
    warmupUntil: 0,
    policy
  });
  assert.equal(rows[0].pressure, -0.1);
  assert.equal(rows[0].threshold, null);
  assert.equal(rows[1].pressure, -0.25);
  assert.equal(rows[1].threshold, 0.1);
});

test('delayed pressure messages cannot be backfilled into an earlier window', () => {
  const rows = buildPressureWindows({
    symbols: ['BTCUSDT'],
    forceOrders: [{ symbol: 'BTCUSDT', eventTime: 900, receivedAt: 2_000, pressure: -100 }],
    trades: [{ symbol: 'BTCUSDT', eventTime: 500, receivedAt: 500, quoteNotional: 1_000 }],
    windowEnds: [1_000],
    warmupUntil: 0,
    policy
  });
  assert.equal(rows[0].pressure, 0);
  assert.equal(rows[0].lateForceOrders, 1);
});

test('recovery event uses only pre-event depth and rejects a new adverse extreme', () => {
  const pressureWindows = [{
    symbol: 'BTCUSDT',
    windowStart: 1_000,
    windowEnd: 2_000,
    pressure: -0.5,
    threshold: 0.1,
    warmupComplete: true
  }];
  const result = detectH9Events({
    pressureWindows,
    books: [
      book('BTCUSDT', 500, 100),
      book('BTCUSDT', 1_000, 100),
      book('BTCUSDT', 1_500, 98),
      book('BTCUSDT', 2_900, 97),
      book('BTCUSDT', 3_000, 99)
    ],
    policy
  });
  assert.equal(result.events.length, 0);
  assert.equal(result.rejected[0].reason, 'new_event_direction_extreme');
});

function qualifyingEvent() {
  return detectH9Events({
    pressureWindows: [{
      symbol: 'BTCUSDT',
      windowStart: 1_000,
      windowEnd: 2_000,
      pressure: -0.5,
      threshold: 0.1,
      warmupComplete: true
    }],
    books: [
      book('BTCUSDT', 500, 100),
      book('BTCUSDT', 1_000, 100),
      book('BTCUSDT', 1_500, 98),
      book('BTCUSDT', 3_000, 99),
      book('BTCUSDT', 6_000, 101)
    ],
    policy
  }).events[0];
}

test('replay enters at the first post-decision book, applies fees and stress, and exits at time', () => {
  const event = qualifyingEvent();
  assert.ok(event);
  const result = replayH9Event({
    event,
    books: [
      book('BTCUSDT', 500, 100),
      book('BTCUSDT', 1_000, 100),
      book('BTCUSDT', 1_500, 98),
      book('BTCUSDT', 3_000, 99),
      book('BTCUSDT', 6_000, 101)
    ],
    quantity: 1,
    policy
  });
  assert.equal(result.status, 'CLOSED');
  assert.equal(result.exitReason, 'TIME');
  assert.equal(result.signalToFillMs, 0);
  assert.ok(result.netPnl > 0);
  assert.ok(result.stressNetPnl < result.netPnl);
  assert.equal(result.clusterId, event.clusterId);
});

test('funding crossing without a causal mark price is rejected', () => {
  const event = qualifyingEvent();
  const result = replayH9Event({
    event,
    books: [
      book('BTCUSDT', 500, 100),
      book('BTCUSDT', 1_000, 100),
      book('BTCUSDT', 1_500, 98),
      book('BTCUSDT', 3_000, 99),
      book('BTCUSDT', 6_000, 101)
    ],
    fundingRates: [{ symbol: 'BTCUSDT', fundingTime: 5_000, fundingRate: 0.001 }],
    quantity: 1,
    policy
  });
  assert.equal(result.status, 'REJECTED');
  assert.equal(result.reason, 'missing_funding_mark');
});

test('summary PF is based on stressed net results and best-five removal is explicit', () => {
  const summary = summarizeH9Trades([
    { status: 'CLOSED', eventId: 'a', exitTime: 1, clusterId: '1', netPnl: 10, stressNetPnl: 8 },
    { status: 'CLOSED', eventId: 'b', exitTime: 2, clusterId: '2', netPnl: -4, stressNetPnl: -5 },
    { status: 'CLOSED', eventId: 'c', exitTime: 3, clusterId: '3', netPnl: 2, stressNetPnl: 1 }
  ]);
  assert.equal(summary.closedTrades, 3);
  assert.equal(summary.profitFactor, 9 / 5);
  assert.equal(summary.afterBest5ClusterStressNetPnl, 0);
});
