import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FOUR_HOURS,
  aggregateFourHourBars,
  detectRelativeValueSignals,
  developmentScreen,
  executeRelativeValueSignal,
  summarizeRelativeValueTrades
} from '../src/research/exp011.mjs';

const FIVE_MINUTES = 5 * 60 * 1000;

function bar(openTime, open, close = open, quoteVolume = 1_000_000) {
  return {
    openTime,
    closeTime: openTime + FIVE_MINUTES - 1,
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    quoteVolume
  };
}

function fourHourBar(openTime, close) {
  return {
    openTime,
    closeTime: openTime + FOUR_HOURS - 1,
    open: close,
    high: close,
    low: close,
    close,
    quoteVolume: 10_000_000
  };
}

test('4h aggregation requires 48 complete UTC-aligned 5m bars', () => {
  const start = Date.UTC(2024, 0, 1);
  const bars = Array.from({ length: 96 }, (_, index) =>
    bar(start + index * FIVE_MINUTES, 100 + index / 100, 100 + (index + 1) / 100));
  const aggregated = aggregateFourHourBars(bars, 'BTCUSDT');
  assert.equal(aggregated.length, 2);
  assert.equal(aggregated[0].openTime, start);
  assert.equal(aggregated[0].closeTime, start + FOUR_HOURS - 1);
  assert.equal(aggregated[0].close, bars[47].close);
});

test('relative-value signal estimates only prior beta and waits a full 5m processing bar', () => {
  const start = Date.UTC(2024, 0, 1);
  const xCloses = [100, 101, 100, 102, 101, 103, 102, 104, 103, 105, 104, 106];
  const yCloses = [50, 50.5, 50, 51, 50.5, 51.5, 51, 65, 51.5, 52.5, 52, 53];
  const x4h = xCloses.map((value, index) => fourHourBar(start + index * FOUR_HOURS, value));
  const y4h = yCloses.map((value, index) => fourHourBar(start + index * FOUR_HOURS, value));
  const fiveBars = Array.from({ length: 12 * 48 + 20 }, (_, index) =>
    bar(start + index * FIVE_MINUTES, 100));
  const result = detectRelativeValueSignals({
    pairId: 'TEST',
    xSymbol: 'XUSDT',
    ySymbol: 'YUSDT',
    xFourHourBars: x4h,
    yFourHourBars: y4h,
    xFiveMinuteBars: fiveBars,
    yFiveMinuteBars: fiveBars,
    evaluationStart: x4h[7].closeTime,
    evaluationEnd: start + 12 * FOUR_HOURS,
    lookbackBars: 5,
    minimumBeta: 0.1,
    maximumBeta: 3,
    entryAbsoluteZscore: 2,
    rearmAbsoluteZscore: 1,
    maximumHoldBars: 2,
    baseFillOffsetBars: 1,
    maximumFillDelayBars: 1,
    capacityLookbackBars: 2
  });
  assert.equal(result.signals.length, 1);
  const signal = result.signals[0];
  assert.equal(signal.signalTime, x4h[7].closeTime);
  assert.equal(signal.baseEntryTime, x4h[7].openTime + FOUR_HOURS + FIVE_MINUTES);
  assert.equal(signal.direction, 'Y_RICH');
  assert.ok(Math.abs(signal.legs.reduce((total, leg) => total + Math.abs(leg.weight), 0) - 0.25) < 1e-12);
});

test('pair execution moves both fills under delay and charges funding and four fills', () => {
  const times = Array.from({ length: 12 }, (_, index) => index * FIVE_MINUTES);
  const signal = {
    eventId: 'event',
    pairId: 'PAIR',
    signalTime: 0,
    decisionTime: 0,
    baseEntryTime: times[2],
    baseExitTime: times[6],
    exitReason: 'center_cross',
    beta: 1,
    entryZscore: 3.5,
    direction: 'Y_RICH',
    legs: [
      { symbol: 'XUSDT', role: 'X_HEDGE', weight: 0.125 },
      { symbol: 'YUSDT', role: 'Y_RESIDUAL', weight: -0.125 }
    ]
  };
  const data = Object.fromEntries(['XUSDT', 'YUSDT'].map((symbol, index) => [symbol, {
    contractByTime: new Map(times.map(time => [time, bar(time, 100 + index)])),
    funding: [{ eventTime: times[4], fundingRate: index ? 0.01 : 0.001 }],
    markByTime: new Map([[times[4], bar(times[4], 100 + index)]])
  }]));
  const trade = executeRelativeValueSignal(signal, data, {
    name: 'delay5m',
    fillDelayBars: 1,
    slippagePerFill: 0.0007,
    feePerFill: 0.0005
  });
  assert.equal(trade.entryTime, times[3]);
  assert.equal(trade.exitTime, times[7]);
  assert.equal(trade.legs.length, 2);
  assert.ok(trade.fees > 0);
  assert.ok(trade.fundingReturn > 0);
});

test('development screen enforces pair and entry-day concentration', () => {
  const trades = Array.from({ length: 40 }, (_, index) => ({
    eventId: String(index),
    pairId: `P${index % 4}`,
    entryTime: Date.UTC(2024 + Math.floor(index / 16), index % 12, 1 + (index % 3)),
    exitTime: Date.UTC(2024 + Math.floor(index / 16), index % 12, 2 + (index % 3)),
    direction: index % 2 ? 'Y_RICH' : 'Y_CHEAP',
    entryZscore: index % 2 ? 3.1 : -3.1,
    grossPriceReturn: 0.002,
    fees: 0.0002,
    fundingReturn: 0,
    netReturn: 0.001
  }));
  const summary = summarizeRelativeValueTrades(trades, ['P0', 'P1', 'P2', 'P3']);
  const screen = developmentScreen(summary, summary, summary, {
    minimumTrades: 40,
    minimumStressProfitFactor: 1.3,
    maximumDrawdown: -0.2,
    minimumProfitablePairs: 3,
    minimumProfitableHalfYears: 3,
    maximumMonthContributionShare: 0.4,
    maximumPairContributionShare: 0.4,
    minimumDelayProfitFactor: 1
  });
  assert.equal(summary.pairTrades, 40);
  assert.equal(summary.profitablePairs, 4);
  assert.ok(summary.maxPositivePairContributionShare <= 0.4);
  assert.equal(screen.checks.pairConcentration, true);
});
