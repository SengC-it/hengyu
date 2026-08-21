import assert from 'node:assert/strict';
import test from 'node:test';
import { attributeTrade, summarizeRows, FOUR_HOURS } from '../src/research/profit-v3-failure-attribution.mjs';

test('failure attribution reconstructs first MFE and profit giveback without changing the trade result', () => {
  const bars = [{
    symbol: 'BTCUSDT',
    openTime: 0,
    closeTime: FOUR_HOURS - 1,
    open: 100,
    high: 105,
    low: 99,
    close: 102,
    quoteVolume: 1_000_000
  }];
  const trade = {
    experimentId: 'HY-EXP-0019',
    phase: 'oos',
    symbol: 'BTCUSDT',
    side: 'BUY',
    regime: 'BULL',
    signalTime: FOUR_HOURS - 1,
    entryTime: 0,
    exitTime: FOUR_HOURS - 1,
    entryMidPrice: 100,
    entryPrice: 100,
    executablePrice: 100,
    exitReason: 'DYNAMIC_DONCHIAN_EXIT',
    executablePriceReturnBps: 200,
    netReturnBps: -50,
    netPnl: -5,
    fees: 2,
    fundingPnl: -1,
    edge: {
      expectedPriceEdgeBps: 250,
      featureSummary: { breakoutDistanceBps: 40 }
    }
  };
  const attributed = attributeTrade({ trade, bars, atrPeriod: 1 });
  assert.equal(attributed.reconstructedMfeBps, 500);
  assert.equal(attributed.reconstructedMaeBps, -100);
  assert.equal(attributed.timeToMfeMs, 1);
  assert.equal(attributed.timeToMfeBars, 1 / FOUR_HOURS);
  assert.equal(attributed.mfeTime, new Date(1).toISOString());
  assert.equal(attributed.exitLabel, 'CHANNEL_EXIT');
  assert.equal(attributed.profitGivebackBps, 550);
  assert.equal(attributed.predictionErrorBps, -50);
  assert.equal(attributed.pricePnlAfterExecution, -2);
  assert.equal(attributed.breakoutDistanceBps, 40);
});

test('failure attribution summaries keep fees and funding separate from price outcomes', () => {
  const summary = summarizeRows([
    { netPnl: -10, netReturnBps: -100, mfeBps: 50, maeBps: -200, fees: 2, fundingPnl: -3 },
    { netPnl: 5, netReturnBps: 50, mfeBps: 100, maeBps: -20, fees: 1, fundingPnl: 2 }
  ]);
  assert.equal(summary.count, 2);
  assert.equal(summary.totalNetPnl, -5);
  assert.equal(summary.netProfitFactor, 0.5);
  assert.equal(summary.totalFees, 3);
  assert.equal(summary.totalFundingPnl, -1);
});
