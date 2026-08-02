import assert from 'node:assert/strict';
import test from 'node:test';
import { FIVE_MINUTES } from '../src/research/archive.mjs';
import {
  applyExecution,
  detectFundingUnwindSignals,
  developmentScreen,
  summarizeFundingTrades
} from '../src/research/exp002.mjs';

function kline(openTime, open) {
  return { openTime, open, close: open, high: open, low: open };
}

test('funding unwind uses only prior event premiums and waits five minutes after settlement', () => {
  const fundingRows = Array.from({ length: 92 }, (_, index) => ({
    eventTime: index * 8 * 60 * 60 * 1000,
    fundingRate: 0.0001,
    fundingIntervalHours: 8
  }));
  const premiumBars = fundingRows.map((row, index) =>
    kline(row.eventTime - FIVE_MINUTES, index === 90 ? 0.003 : (index % 2 ? 0.0001 : -0.0001)));
  const contractBars = [];
  for (const row of fundingRows) {
    contractBars.push(kline(row.eventTime + FIVE_MINUTES, 100));
    contractBars.push(kline(row.eventTime + 65 * 60 * 1000, 99));
  }
  const signals = detectFundingUnwindSignals({
    symbol: 'TESTUSDT',
    contractBars,
    premiumBars,
    fundingRows,
    evaluationStart: fundingRows[90].eventTime,
    evaluationEnd: fundingRows[91].eventTime,
    historyEvents: 90,
    minimumAbsolutePremium: 0.0025,
    minimumAbsoluteZscore: 3,
    entryDelayBars: 1,
    holdBars: 12
  });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].side, -1);
  assert.equal(signals[0].entryTime, fundingRows[90].eventTime + FIVE_MINUTES);
});

test('left-boundary funding event without a prior premium bar is excluded before evaluation', () => {
  const eventTime = 0;
  const signals = detectFundingUnwindSignals({
    symbol: 'TESTUSDT',
    contractBars: [],
    premiumBars: [],
    fundingRows: [{ eventTime, fundingRate: 0.0001, fundingIntervalHours: 8 }],
    evaluationStart: eventTime + FIVE_MINUTES,
    evaluationEnd: Infinity,
    historyEvents: 90,
    minimumAbsolutePremium: 0.0025,
    minimumAbsoluteZscore: 3,
    entryDelayBars: 1,
    holdBars: 12
  });
  assert.deepEqual(signals, []);
});

test('missing pre-event premium bar fails inside evaluation', () => {
  assert.throws(() => detectFundingUnwindSignals({
    symbol: 'TESTUSDT',
    contractBars: [],
    premiumBars: [],
    fundingRows: [{ eventTime: 0, fundingRate: 0.0001, fundingIntervalHours: 8 }],
    evaluationStart: 0,
    evaluationEnd: Infinity,
    historyEvents: 90,
    minimumAbsolutePremium: 0.0025,
    minimumAbsoluteZscore: 3,
    entryDelayBars: 1,
    holdBars: 12
  }), /missing pre-event premium bar/);
});

test('execution charges fees on each fill notional', () => {
  const signal = {
    symbol: 'TESTUSDT',
    side: 1,
    entryTime: 1,
    exitTime: 2,
    entryPrice: 100,
    exitPrice: 101
  };
  const trade = applyExecution(signal, [], [], {
    name: 'stress',
    feePerSide: 0.0005,
    slippagePerSide: 0.0007
  });
  const expectedFees = 0.0005 * (trade.entryFill + trade.exitFill) / 100;
  assert.equal(trade.fees, expectedFees);
  assert.ok(trade.netReturn < 0.01);
});

test('screen removes best event clusters and enforces month concentration', () => {
  const trades = Array.from({ length: 10 }, (_, index) => ({
    symbol: index % 2 ? 'A' : 'B',
    side: index % 2 ? 1 : -1,
    eventTime: index < 6 ? 0 : index,
    entryTime: Date.UTC(2025, index % 2, 1),
    exitTime: Date.UTC(2025, index % 2, 1),
    grossPriceReturn: index === 0 ? 1 : -0.01,
    netReturn: index === 0 ? 1 : -0.01,
    fees: 0,
    fundingReturn: 0
  }));
  const summary = summarizeFundingTrades(trades);
  const screen = developmentScreen(summary, {
    minimumTrades: 10,
    minimumProfitFactor: 1.1,
    minimumProfitableSymbols: 1,
    minimumProfitableHalfYears: 1,
    maximumPositiveMonthContributionShare: 0.4
  });
  assert.equal(screen.pass, false);
  assert.ok(screen.failures.includes('withoutBest5EventClusters'));
});
