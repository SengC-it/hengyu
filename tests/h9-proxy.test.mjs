import assert from 'node:assert/strict';
import test from 'node:test';
import { continuationDecision, summarizeH9Proxy } from '../src/research/h9-proxy.mjs';

test('proxy summary uses closed trades and stressed net returns', () => {
  const summary = summarizeH9Proxy([
    { symbol: 'BTCUSDT', side: 'BUY', eventTime: 1, exitTime: 2, grossReturn: 0.021, netReturn: 0.02 },
    { symbol: 'BTCUSDT', side: 'SELL', eventTime: 3, exitTime: 4, grossReturn: -0.009, netReturn: -0.01 }
  ]);
  assert.equal(summary.trades, 2);
  assert.equal(summary.winRate, 0.5);
  assert.equal(summary.profitFactor, 2);
  assert.equal(summary.maximumDrawdownReturnUnits, -0.01);
});

test('continuation screen requires every frozen gate', () => {
  const decision = continuationDecision({
    trades: 100, profitFactor: 1.2, netReturnUnits: 0.1,
    maximumDrawdownReturnUnits: -0.1, profitWithoutBest5Trades: -0.01,
    positiveMonths: 7, observedMonths: 12, profitableSymbols: 4,
    byDirection: { BUY: 0.1, SELL: 0.01 }
  }, {
    minimum_closed_trades: 60, minimum_profit_factor: 1,
    maximum_drawdown_return_units: -0.2, minimum_positive_month_share: 0.5,
    minimum_profitable_symbols: 3
  });
  assert.equal(decision.continueExactH9Collection, false);
  assert.deepEqual(decision.failures, ['withoutBest5']);
});
