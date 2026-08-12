import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateFourHourBars, promotionDecision, summarizeH10Trend } from '../src/research/h10-trend.mjs';

test('aggregates exactly 48 five-minute bars into one UTC 4h bar', () => {
  const bars = Array.from({ length: 48 }, (_, index) => ({
    symbol: 'BTCUSDT', openTime: index * 300_000, open: 100 + index,
    high: 102 + index, low: 99 + index, close: 101 + index, quoteVolume: 10
  }));
  const [bar] = aggregateFourHourBars(bars);
  assert.equal(bar.open, 100);
  assert.equal(bar.close, 148);
  assert.equal(bar.high, 149);
  assert.equal(bar.low, 99);
  assert.equal(bar.quoteVolume, 480);
});

test('summary uses stressed trade returns and one-sixth portfolio allocation', () => {
  const summary = summarizeH10Trend([
    { symbol: 'BTCUSDT', side: 'BUY', exitTime: Date.parse('2026-01-02'), grossReturn: 0.021, netReturn: 0.02, exitReason: 'channel' },
    { symbol: 'ETHUSDT', side: 'SELL', exitTime: Date.parse('2026-02-02'), grossReturn: -0.009, netReturn: -0.01, exitReason: 'stop' }
  ], { allocationFraction: 1 / 6, monthKeys: ['2026-01', '2026-02'] });
  assert.equal(summary.trades, 2);
  assert.equal(summary.winRate, 0.5);
  assert.equal(summary.profitFactor, 2);
  assert.ok(Math.abs(summary.netReturnFraction - 0.01 / 6) < 1e-12);
  assert.ok(Math.abs(summary.maximumClosedEquityDrawdownFraction + 0.01 / 6) < 1e-12);
});

test('promotion requires every frozen gate', () => {
  const decision = promotionDecision({
    trades: 50, profitFactor: 1.3, netReturnFraction: 0.1,
    maximumClosedEquityDrawdownFraction: -0.1, profitWithoutBest5Trades: -0.01,
    positiveMonths: 7, observedMonths: 13, profitableSymbols: 4,
    byDirection: { BUY: 0.1, SELL: 0.01 }
  }, {
    minimum_closed_trades: 30, minimum_profit_factor: 1.2,
    maximum_closed_equity_drawdown_fraction: -0.2,
    minimum_positive_month_share: 0.5, minimum_profitable_symbols: 3
  });
  assert.equal(decision.pass, false);
  assert.deepEqual(decision.failures, ['withoutBest5']);
});
