import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyExecution,
  detectSignals,
  developmentScreen,
  FIVE_MINUTES,
  summarizeTrades
} from '../src/research/exp001.mjs';

function bar(index, patch = {}) {
  const openTime = index * FIVE_MINUTES;
  return {
    symbol: 'TESTUSDT',
    openTime,
    closeTime: openTime + FIVE_MINUTES - 1,
    open: 100,
    high: 100.2,
    low: 99.8,
    close: 100,
    quoteVolume: 100,
    takerBuyQuoteVolume: 50,
    ...patch
  };
}

test('signal uses a completed shock bar and enters at the next open', () => {
  const bars = Array.from({ length: 20 }, (_, index) => bar(index));
  bars[9] = bar(9, {
    high: 102,
    low: 99.9,
    close: 101,
    quoteVolume: 500,
    takerBuyQuoteVolume: 400
  });
  bars[10] = bar(10, { open: 101.1, close: 100.8 });
  const signals = detectSignals(bars, {
    evaluationStart: 0,
    evaluationEnd: Infinity,
    returnBars: 1,
    volatilityLookback: 5,
    minimumAbsoluteReturn: 0.005,
    volatilityMultiple: 0,
    volumeLookback: 5,
    minimumVolumeMultiple: 3,
    minimumImbalance: 0.25,
    minimumWick: 0.4,
    holdBars: 2
  });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].side, -1);
  assert.equal(signals[0].entryTime, bars[10].openTime);
  assert.equal(signals[0].entryPrice, bars[10].open);
});

test('execution applies adverse slippage, two fees and realized funding', () => {
  const signal = {
    symbol: 'TESTUSDT',
    side: 1,
    entryTime: 1000,
    exitTime: 3000,
    entryPrice: 100,
    exitPrice: 101
  };
  const trade = applyExecution(signal, [
    { fundingTime: 2000, fundingRate: 0.0001 }
  ], {
    name: 'stress',
    feePerSide: 0.0005,
    slippagePerSide: 0.0007
  });
  assert.equal(trade.entryFill, 100.07);
  assert.equal(trade.exitFill, 100.9293);
  assert.equal(trade.fundingReturn, -0.0001);
  assert.ok(trade.netReturn < signal.exitPrice / signal.entryPrice - 1);
});

test('development screen requires breadth and best-five robustness', () => {
  const trades = Array.from({ length: 10 }, (_, index) => ({
    symbol: index % 2 ? 'A' : 'B',
    side: index % 2 ? 1 : -1,
    entryTime: index,
    exitTime: index,
    grossPriceReturn: index === 0 ? 1 : -0.01,
    netReturn: index === 0 ? 1 : -0.01,
    fees: 0,
    fundingReturn: 0
  }));
  const summary = summarizeTrades(trades);
  const screen = developmentScreen(summary, {
    minimumTrades: 10,
    minimumProfitFactor: 1.1,
    minimumProfitableSymbols: 1,
    minimumProfitableHalfYears: 1
  });
  assert.equal(screen.pass, false);
  assert.ok(screen.failures.includes('withoutBest5'));
});
