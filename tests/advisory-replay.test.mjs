import assert from 'node:assert/strict';
import test from 'node:test';
import { buildNetEdgeAdvisorySignal } from '../src/model/net-edge-advisory.mjs';
import { simulateAdvisorySignal, summarizeAdvisoryTrades } from '../src/model/advisory-replay.mjs';

const BOOK = {
  bids: [[99.9, 10], [99.8, 10]],
  asks: [[100.1, 10], [100.2, 10]]
};

const EXIT_BOOK = {
  bids: [[100.5, 10], [100.4, 10]],
  asks: [[100.6, 10], [100.7, 10]]
};

test('advisory replay uses causal entry, expiry exit, fees and stress', () => {
  const signal = buildNetEdgeAdvisorySignal({
    candidate: {
      hypothesisId: 'H1',
      symbol: 'BTCUSDT',
      side: 'BUY',
      quantity: 1,
      expectedPriceEdgeBps: 130,
      forecastStandardErrorBps: 2,
      expectedFundingBps: 0,
      fundingStressBps: 0,
      forecastTime: 10_000,
      bookTime: 10_000,
      decisionTime: 10_000,
      maxHoldMs: 2_000,
      expectedExitPrice: 101,
      stopPrice: 99
    },
    book: BOOK,
    now: 10_000
  });
  const trade = simulateAdvisorySignal({
    signal,
    books: [
      { symbol: 'BTCUSDT', eventTime: 10_000, receivedAt: 10_000, ...BOOK },
      { symbol: 'BTCUSDT', eventTime: 11_000, receivedAt: 11_000, ...BOOK },
      { symbol: 'BTCUSDT', eventTime: 12_000, receivedAt: 12_000, ...EXIT_BOOK }
    ]
  });
  assert.equal(trade.status, 'CLOSED');
  assert.equal(trade.exitReason, 'TIME');
  assert.equal(trade.accountDataUsed, false);
  assert.ok(trade.stressNetPnl < trade.netPnl);
  const summary = summarizeAdvisoryTrades([trade]);
  assert.equal(summary.closedTrades, 1);
  assert.equal(summary.symbols[0], 'BTCUSDT');
});

test('advisory replay rejects missing causal fill or exit book', () => {
  const signal = {
    signalId: 's',
    experimentId: 'HY-EXP-0014',
    hypothesisId: 'H1',
    symbol: 'BTCUSDT',
    side: 'BUY',
    decisionTime: 10_000,
    generatedAt: 10_000,
    validUntil: 10_100,
    expiresAt: 12_000,
    reference: { stopPrice: null, exitReferencePrice: null }
  };
  const result = simulateAdvisorySignal({ signal, books: [] });
  assert.equal(result.status, 'REJECTED');
  assert.equal(result.reason, 'signal_to_fill_timeout');
});

