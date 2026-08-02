import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCarryPortfolio,
  buildRebalanceEvents,
  computeCarryFeatures,
  developmentScreen,
  executeCarryPortfolio,
  summarizeCarryPortfolios
} from '../src/research/exp010.mjs';

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

test('rebalance waits for a complete post-settlement bar and another 5m before entry', () => {
  const start = Date.UTC(2024, 0, 1);
  const bars = Array.from({ length: 30 }, (_, index) =>
    bar(start + index * FIVE_MINUTES, 100, 100 + index / 10));
  const anchor = start + 6 * FIVE_MINUTES;
  const events = buildRebalanceEvents({
    btcBars: bars,
    anchorTime: anchor,
    evaluationStart: anchor,
    evaluationEnd: start + 20 * FIVE_MINUTES,
    rebalanceDays: 1 / 288,
    baseEntryOffsetBars: 2,
    holdBars: 2,
    maximumEntryDelayBars: 1
  });
  assert.equal(events[0].eventTime, anchor);
  assert.equal(events[0].decisionTime, anchor + FIVE_MINUTES - 1);
  assert.equal(events[0].baseEntryTime, anchor + 2 * FIVE_MINUTES);
});

test('carry score includes only funding known by the decision event', () => {
  const start = Date.UTC(2024, 0, 1);
  const btc = [];
  const alt = [];
  let btcClose = 100;
  let altClose = 50;
  for (let index = 0; index < 12; index++) {
    const btcOpen = btcClose;
    const altOpen = altClose;
    btcClose *= Math.exp(index % 2 ? 0.001 : -0.0005);
    altClose *= Math.exp(index % 2 ? 0.0018 : -0.0008);
    btc.push(bar(start + index * FIVE_MINUTES, btcOpen, btcClose));
    alt.push(bar(start + index * FIVE_MINUTES, altOpen, altClose));
  }
  const eventTime = start + 8 * FIVE_MINUTES;
  const features = computeCarryFeatures({
    symbol: 'ETHUSDT',
    bars: alt,
    btcBars: btc,
    fundingRows: [
      { eventTime: eventTime - 2 * FIVE_MINUTES, fundingRate: 0.001 },
      { eventTime, fundingRate: 0.002 },
      { eventTime: eventTime + FIVE_MINUTES, fundingRate: 0.5 }
    ],
    events: [{ eventId: 'event', eventTime }],
    fundingLookbackDays: 1,
    minimumFundingEvents: 2,
    betaLookbackBars: 4,
    capacityLookbackBars: 2
  });
  assert.equal(features.length, 1);
  assert.equal(features[0].fundingEvents, 2);
  assert.ok(Math.abs(features[0].fundingScore - 0.003) < 1e-12);
  assert.ok(Number.isFinite(features[0].beta));
});

test('portfolio ranks funding tails, inverse-vol weights and removes beta exposure', () => {
  const event = {
    eventId: 'event',
    eventTime: 1,
    decisionTime: 2,
    baseEntryTime: 3,
    priorBtcReturn: -0.1,
    btcTrendRegime: 'DOWN'
  };
  const candidates = Array.from({ length: 12 }, (_, index) => ({
    symbol: `ALT${index}USDT`,
    fundingScore: -0.012 + index * 0.002,
    fundingEvents: 42,
    beta: 0.7 + index * 0.03,
    residualVolatility: 0.01 + index * 0.001,
    liquidityQuoteVolume: 20_000_000 - index,
    capacityQuoteVolume: 10_000_000
  }));
  const portfolio = buildCarryPortfolio({
    event,
    candidates,
    benchmarkFeature: {
      fundingScore: 0.001,
      fundingEvents: 42,
      capacityQuoteVolume: 10_000_000
    },
    minimumProjectedFundingReturn: 0,
    maximumBetaExposure: 1e-12,
    holdBars: 2
  });
  assert.equal(portfolio.status, 'trade');
  assert.equal(portfolio.legs.filter(row => row.role === 'LONG_LOW').length, 3);
  assert.equal(portfolio.legs.filter(row => row.role === 'SHORT_HIGH').length, 3);
  assert.ok(Math.abs(portfolio.betaExposure) < 1e-12);
  assert.ok(portfolio.projectedFundingReturn > 0);
});

test('execution charges all fills and credits long-negative and short-positive funding', () => {
  const times = Array.from({ length: 8 }, (_, index) => index * FIVE_MINUTES);
  const portfolio = {
    eventId: 'event',
    eventTime: 0,
    decisionTime: FIVE_MINUTES - 1,
    baseEntryTime: times[2],
    priorBtcReturn: 0.1,
    btcTrendRegime: 'UP',
    projectedFundingReturn: 0.01,
    longMeanFundingScore: -0.01,
    shortMeanFundingScore: 0.01,
    betaExposure: 0,
    holdBars: 2,
    legs: [
      { symbol: 'LONGUSDT', role: 'LONG_LOW', weight: 0.5, beta: 1, fundingScore: -0.01, fundingEvents: 42 },
      { symbol: 'SHORTUSDT', role: 'SHORT_HIGH', weight: -0.5, beta: 1, fundingScore: 0.01, fundingEvents: 42 }
    ]
  };
  const data = Object.fromEntries(['LONGUSDT', 'SHORTUSDT'].map((symbol, index) => [symbol, {
    contractByTime: new Map(times.map(time => [time, bar(time, 100 + index)])),
    funding: [{ eventTime: times[3], fundingRate: index ? 0.01 : -0.01 }],
    markByTime: new Map([[times[3], bar(times[3], 100 + index)]])
  }]));
  const trade = executeCarryPortfolio(portfolio, data, {
    name: 'stress',
    entryDelayBars: 0,
    slippagePerFill: 0.0007,
    feePerFill: 0.0005
  });
  assert.equal(trade.entryTime, times[2]);
  assert.equal(trade.exitTime, times[4]);
  assert.ok(trade.fundingReturn > 0.0099);
  assert.ok(trade.fees > 0);
  assert.ok(trade.slippageCost > 0);
});

test('development screen uses portfolios and requires funding to cover execution costs', () => {
  const rows = Array.from({ length: 40 }, (_, index) => ({
    eventId: String(index),
    entryTime: Date.UTC(2024 + Math.floor(index / 12), index % 12, 1),
    exitTime: Date.UTC(2024 + Math.floor(index / 12), index % 12, 15),
    btcTrendRegime: index % 2 ? 'UP' : 'DOWN',
    betaExposure: 0,
    projectedFundingReturn: 0.01,
    grossPriceReturn: 0.001,
    priceReturnAfterSlippage: 0.0005,
    slippageCost: 0.0005,
    fees: 0.0005,
    fundingReturn: 0.01,
    netReturn: 0.01,
    legs: [
      { symbol: 'ETHUSDT', role: 'LONG_LOW', netReturn: 0.005 },
      { symbol: 'XRPUSDT', role: 'SHORT_HIGH', netReturn: 0.005 }
    ]
  }));
  const summary = summarizeCarryPortfolios(rows, ['ETHUSDT', 'XRPUSDT']);
  const screen = developmentScreen(summary, summary, summary, {
    minimumEvents: 40,
    minimumStressProfitFactor: 1.3,
    maximumDrawdown: -0.2,
    minimumProfitableAltSymbols: 2,
    minimumProfitableHalfYears: 3,
    maximumMonthContributionShare: 0.4,
    minimumDelayProfitFactor: 1
  });
  assert.equal(summary.eventPortfolios, 40);
  assert.ok(summary.fundingAfterExecutionCosts > 0);
  assert.equal(screen.checks.actualFundingPositive, true);
  assert.equal(screen.checks.fundingAfterExecutionCosts, true);
});
