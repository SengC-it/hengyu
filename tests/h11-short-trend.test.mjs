import assert from 'node:assert/strict';
import test from 'node:test';
import { replayH10Trend } from '../src/research/h10-trend.mjs';
import { h11PromotionDecision, summarizeH11 } from '../src/research/h11-short-trend.mjs';

test('short-only replay ignores a long breakout', () => {
  const step = 4 * 60 * 60 * 1000;
  const bars = Array.from({ length: 123 }, (_, index) => ({
    symbol: 'BTCUSDT', openTime: index * step, closeTime: (index + 1) * step - 1,
    open: 100, high: 101, low: 99, close: index === 120 ? 102 : 100
  }));
  const trades = replayH10Trend(bars, {
    evaluationStart: 0, evaluationEnd: 123 * step,
    allowLong: false, allowShort: true
  });
  assert.equal(trades.length, 0);
});

test('H11 summary separates the frozen half periods', () => {
  const midpoint = Date.parse('2026-02-12T00:00:00Z');
  const summary = summarizeH11([
    { symbol: 'BTCUSDT', side: 'SELL', exitTime: midpoint - 1, grossReturn: 0.02, netReturn: 0.01, exitReason: 'channel' },
    { symbol: 'ETHUSDT', side: 'SELL', exitTime: midpoint, grossReturn: -0.01, netReturn: -0.02, exitReason: 'stop' }
  ], { midpoint, monthKeys: ['2026-02'] });
  assert.ok(summary.byHalfPeriod.first > 0);
  assert.ok(summary.byHalfPeriod.second < 0);
});

test('H11 promotion requires both half periods to profit', () => {
  const decision = h11PromotionDecision({
    trades: 40, profitFactor: 1.5, netReturnFraction: 0.1,
    maximumClosedEquityDrawdownFraction: -0.1, profitWithoutBest5Trades: 0.01,
    positiveMonths: 7, observedMonths: 13, profitableSymbols: 4,
    byHalfPeriod: { first: 0.2, second: -0.1 }
  }, {
    minimum_closed_trades: 30, minimum_profit_factor: 1.3,
    maximum_closed_equity_drawdown_fraction: -0.15,
    minimum_positive_month_share: 0.5, minimum_profitable_symbols: 3
  });
  assert.equal(decision.pass, false);
  assert.deepEqual(decision.failures, ['bothHalfPeriods']);
});
