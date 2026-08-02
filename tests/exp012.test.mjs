import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMomentumPortfolio,
  buildWeeklyEvents,
  computeMomentumFeatures,
  developmentScreen,
  executeMomentumPortfolio,
  summarizeMomentumPortfolios
} from '../src/research/exp012.mjs';

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

test('weekly event waits one complete 5m bar and has non-overlapping feature warmup', () => {
  const start = Date.UTC(2024, 0, 1);
  const bars = Array.from({ length: 40 }, (_, index) =>
    bar(start + index * FIVE_MINUTES, 100, 100 + index / 100));
  const anchor = start + 20 * FIVE_MINUTES;
  const events = buildWeeklyEvents({
    btcBars: bars,
    anchorTime: anchor,
    evaluationStart: anchor,
    evaluationEnd: start + 35 * FIVE_MINUTES,
    rebalanceDays: 1 / 288,
    momentumLookbackBars: 4,
    skipBars: 2,
    betaLookbackBars: 5,
    baseEntryOffsetBars: 1,
    holdBars: 2,
    maximumEntryDelayBars: 1
  });
  assert.equal(events[0].decisionTime, anchor - 1);
  assert.equal(events[0].baseEntryTime, anchor + FIVE_MINUTES);
});

test('momentum feature estimates beta before the skipped and momentum windows', () => {
  const start = Date.UTC(2024, 0, 1);
  const btc = [];
  const alt = [];
  let btcClose = 100;
  let altClose = 50;
  for (let index = 0; index < 30; index++) {
    const btcOpen = btcClose;
    const altOpen = altClose;
    const btcReturn = index % 2 ? 0.001 : -0.0005;
    const altReturn = index <= 15 ? 2 * btcReturn : index <= 19 ? 0.01 : 0;
    btcClose *= Math.exp(btcReturn);
    altClose *= Math.exp(altReturn);
    btc.push(bar(start + index * FIVE_MINUTES, btcOpen, btcClose));
    alt.push(bar(start + index * FIVE_MINUTES, altOpen, altClose));
  }
  const eventTime = start + 22 * FIVE_MINUTES;
  const features = computeMomentumFeatures({
    symbol: 'ETHUSDT',
    bars: alt,
    btcBars: btc,
    events: [{ eventId: 'event', eventTime }],
    momentumLookbackBars: 4,
    skipBars: 2,
    betaLookbackBars: 6,
    liquidityLookbackBars: 3,
    capacityLookbackBars: 2
  });
  assert.equal(features.length, 1);
  assert.ok(Math.abs(features[0].beta - 2) < 0.2);
  assert.ok(features[0].momentumScore > 0);
});

test('portfolio buys winners, shorts losers and removes beta exposure', () => {
  const event = {
    eventId: 'event',
    eventTime: 1,
    decisionTime: 0,
    baseEntryTime: 2,
    btcMomentumReturn: -0.1,
    btcTrendRegime: 'DOWN'
  };
  const candidates = Array.from({ length: 12 }, (_, index) => ({
    symbol: `ALT${index}USDT`,
    beta: 0.7 + index * 0.03,
    residualVolatility: 0.01 + index * 0.001,
    momentumScore: -2 + index * 0.4,
    liquidityQuoteVolume: 20_000_000 - index,
    capacityQuoteVolume: 10_000_000
  }));
  const portfolio = buildMomentumPortfolio({
    event,
    candidates,
    benchmarkFeature: { capacityQuoteVolume: 10_000_000 },
    maximumBetaExposure: 1e-12,
    holdBars: 2
  });
  assert.equal(portfolio.status, 'trade');
  assert.equal(portfolio.legs.filter(row => row.role === 'LONG_WINNER').length, 3);
  assert.equal(portfolio.legs.filter(row => row.role === 'SHORT_LOSER').length, 3);
  assert.ok(Math.abs(portfolio.betaExposure) < 1e-12);
  assert.ok(portfolio.longMeanScore > portfolio.shortMeanScore);
});

test('execution moves the weekly portfolio under delay and charges every leg', () => {
  const times = Array.from({ length: 8 }, (_, index) => index * FIVE_MINUTES);
  const portfolio = {
    eventId: 'event',
    eventTime: 0,
    decisionTime: 0,
    baseEntryTime: times[2],
    btcMomentumReturn: 0.1,
    btcTrendRegime: 'UP',
    longMeanScore: 2,
    shortMeanScore: -2,
    scoreSpread: 4,
    betaExposure: 0,
    holdBars: 2,
    legs: [
      { symbol: 'LONGUSDT', role: 'LONG_WINNER', weight: 0.5, beta: 1, momentumScore: 2 },
      { symbol: 'SHORTUSDT', role: 'SHORT_LOSER', weight: -0.5, beta: 1, momentumScore: -2 }
    ]
  };
  const data = Object.fromEntries(['LONGUSDT', 'SHORTUSDT'].map((symbol, index) => [symbol, {
    contractByTime: new Map(times.map(time => [time, bar(time, 100 + index)])),
    funding: [{ eventTime: times[4], fundingRate: index ? 0.01 : -0.01 }],
    markByTime: new Map([[times[4], bar(times[4], 100 + index)]])
  }]));
  const trade = executeMomentumPortfolio(portfolio, data, {
    name: 'delay5m',
    entryDelayBars: 1,
    slippagePerFill: 0.0007,
    feePerFill: 0.0005
  });
  assert.equal(trade.entryTime, times[3]);
  assert.equal(trade.exitTime, times[5]);
  assert.ok(trade.fees > 0);
  assert.ok(trade.fundingReturn > 0);
});

test('development screen applies symbol concentration to weekly portfolios', () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({
    eventId: String(index),
    entryTime: Date.UTC(2024 + Math.floor(index / 36), index % 12, 1),
    exitTime: Date.UTC(2024 + Math.floor(index / 36), index % 12, 8),
    btcTrendRegime: index % 2 ? 'UP' : 'DOWN',
    betaExposure: 0,
    grossPriceReturn: 0.002,
    fees: 0.0005,
    fundingReturn: 0,
    netReturn: 0.001,
    legs: [
      { symbol: `L${index % 8}`, role: 'LONG_WINNER', netReturn: 0.0005 },
      { symbol: `S${index % 8}`, role: 'SHORT_LOSER', netReturn: 0.0005 }
    ]
  }));
  const symbols = [...Array.from({ length: 8 }, (_, index) => `L${index}`),
    ...Array.from({ length: 8 }, (_, index) => `S${index}`)];
  const summary = summarizeMomentumPortfolios(rows, symbols);
  const screen = developmentScreen(summary, summary, summary, {
    minimumEvents: 100,
    minimumStressProfitFactor: 1.3,
    maximumDrawdown: -0.2,
    minimumProfitableAltSymbols: 8,
    minimumProfitableHalfYears: 3,
    maximumMonthContributionShare: 0.4,
    maximumSymbolContributionShare: 0.25,
    minimumDelayProfitFactor: 1
  });
  assert.equal(summary.eventPortfolios, 100);
  assert.ok(summary.maxPositiveAltSymbolContributionShare <= 0.25);
  assert.equal(screen.checks.symbolConcentration, true);
});
