import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewSentSignal, summarizeSentReviews } from '../src/model/signal-review.mjs';

function signal(overrides = {}) {
  return {
    signalId: 'review-1',
    experimentId: 'HY-EXP-0014',
    symbol: 'BTCUSDT',
    side: 'BUY',
    sentAt: 1_000,
    expiresAt: 2_000,
    reference: {
      entryPrice: 100,
      stopPrice: 99,
      takeProfitPrice: 101
    },
    ...overrides
  };
}

test('sent review closes at the first TP/SL trade and calculates directional return', () => {
  const result = reviewSentSignal({
    signal: signal(),
    candles: [{ openTime: 1_000, closeTime: 1_999, open: 100, high: 101.5, low: 99.8, close: 101.2 }],
    trades: [{ time: 1_500, price: 100.4 }, { time: 1_700, price: 101.01 }],
    now: 2_000,
    requireExactTrigger: true
  });
  assert.equal(result.status, 'CLOSED');
  assert.equal(result.exitReason, 'TP');
  assert.equal(result.exitPrice, 101);
  assert.equal(result.pnlBps, 100);
  assert.equal(result.triggerPrecision, 'TRADE');
});

test('same-candle TP and SL use trade order instead of candle order', () => {
  const result = reviewSentSignal({
    signal: signal(),
    candles: [{ openTime: 1_000, closeTime: 1_999, open: 100, high: 102, low: 98, close: 100 }],
    trades: [{ time: 1_200, price: 98.5 }, { time: 1_400, price: 101.2 }],
    now: 2_000,
    requireExactTrigger: true
  });
  assert.equal(result.status, 'CLOSED');
  assert.equal(result.exitReason, 'SL');
  assert.equal(result.pnlBps, -100);
});

test('short review reverses TP/SL direction and keeps the price-return sign correct', () => {
  const result = reviewSentSignal({
    signal: signal({
      signalId: 'review-short',
      side: 'SELL',
      reference: { entryPrice: 100, stopPrice: 101, takeProfitPrice: 99 }
    }),
    candles: [{ openTime: 1_000, closeTime: 1_999, open: 100, high: 100.2, low: 98.8, close: 99.2 }],
    trades: [{ time: 1_500, price: 98.9 }],
    now: 2_000,
    requireExactTrigger: true
  });
  assert.equal(result.status, 'CLOSED');
  assert.equal(result.exitReason, 'TP');
  assert.equal(result.pnlBps, 100);
});

test('a signal remains holding after its research expiry when neither level is touched', () => {
  const result = reviewSentSignal({
    signal: signal(),
    candles: [
      { openTime: 1_000, closeTime: 1_999, open: 100, high: 100.4, low: 99.8, close: 100.2 },
      { openTime: 3_000, closeTime: 3_999, open: 100.2, high: 100.6, low: 99.7, close: 100.3 }
    ],
    now: 10_000
  });
  assert.equal(result.status, 'HOLDING');
  assert.equal(result.exitAt, null);
  assert.equal(result.exitReason, null);
  assert.ok(Math.abs(result.markPnlBps - 30) < 1e-9);
});

test('a declared maximum hold closes at the first causal candle boundary', () => {
  const result = reviewSentSignal({
    signal: signal({
      reference: { entryPrice: 100, stopPrice: 99, takeProfitPrice: 101, maximumHoldMs: 1_000 }
    }),
    candles: [
      { openTime: 1_000, closeTime: 1_999, open: 100, high: 100.4, low: 99.8, close: 100.2 },
      { openTime: 2_000, closeTime: 2_999, open: 100.2, high: 100.6, low: 99.7, close: 100.3 }
    ],
    now: 3_000
  });
  assert.equal(result.status, 'CLOSED');
  assert.equal(result.exitReason, 'TIME');
  assert.equal(result.exitAt, 2_000);
  assert.ok(Math.abs(result.pnlBps - 20) < 1e-9);
});

test('a threshold hit without exact trade evidence is not forced into a PnL result', () => {
  const result = reviewSentSignal({
    signal: signal(),
    candles: [{ openTime: 1_000, closeTime: 1_999, open: 100, high: 102, low: 98, close: 100 }],
    now: 2_000,
    requireExactTrigger: true
  });
  assert.equal(result.status, 'DATA_INSUFFICIENT');
  assert.equal(result.pnlBps, null);
  assert.equal(result.reason, 'tp_sl_order_unknown_in_same_candle');
});

test('summary reports realized results separately from open and unverified signals', () => {
  const summary = summarizeSentReviews([
    { status: 'CLOSED', pnlBps: 100 },
    { status: 'CLOSED', pnlBps: -100 },
    { status: 'HOLDING', markPnlBps: 30 },
    { status: 'DATA_INSUFFICIENT' },
    { status: 'INVALID' }
  ]);
  assert.equal(summary.closedSignals, 2);
  assert.equal(summary.holdingSignals, 1);
  assert.equal(summary.wins, 1);
  assert.equal(summary.losses, 1);
  assert.equal(summary.realizedPnlBps, 0);
  assert.equal(summary.openMarkPnlBps, 30);
});
