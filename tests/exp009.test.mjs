import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReactionPortfolio,
  computeReactionFeatures,
  detectBtcShocks,
  developmentScreen,
  executeReactionPortfolio,
  summarizeReactionPortfolios
} from '../src/research/exp009.mjs';

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

test('BTC shock waits for a complete reaction bar and enters on the following open', () => {
  const start = Date.UTC(2024, 0, 1);
  const closes = [100, 100, 99.9, 100, 100.1, 102, 102.1, 102, 102, 102, 102, 102];
  const bars = closes.map((close, index) => bar(start + index * FIVE_MINUTES, 100, close));
  const events = detectBtcShocks(bars, {
    shockWindowBars: 3,
    volatilityLookbackBars: 3,
    minimumAbsoluteReturn: 0.015,
    minimumAbsoluteZscore: 4,
    cooldownBars: 20,
    holdBars: 2,
    maximumEntryDelayBars: 1,
    capacityLookbackBars: 2,
    evaluationStart: start,
    evaluationEnd: start + 20 * FIVE_MINUTES
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].shockEndTime, bars[5].closeTime);
  assert.equal(events[0].reactionTime, bars[6].openTime);
  assert.equal(events[0].decisionTime, bars[6].closeTime);
  assert.equal(events[0].baseEntryTime, bars[7].openTime);
});

test('reaction feature estimates beta only before the shock and standardizes the reaction residual', () => {
  const start = Date.UTC(2024, 0, 1);
  const btc = [];
  const alt = [];
  const btcReturns = [0, 0.001, -0.001, 0.002, 0.005, 0.001, 0, 0, 0];
  const altReturns = [0, 0.0021, -0.0021, 0.00405, 0.01, -0.01, 0, 0, 0];
  let btcClose = 100;
  let altClose = 50;
  for (let index = 0; index < 9; index++) {
    const btcOpen = btcClose;
    const altOpen = altClose;
    btcClose = btcOpen * Math.exp(btcReturns[index]);
    altClose = altOpen * Math.exp(altReturns[index]);
    btc.push(bar(start + index * FIVE_MINUTES, btcOpen, btcClose));
    alt.push(bar(start + index * FIVE_MINUTES, altOpen, altClose));
  }
  const event = {
    eventId: 'event',
    shockStartTime: btc[4].openTime,
    reactionTime: btc[5].openTime,
    btcReactionReturn: Math.log(btc[5].close / btc[5].open)
  };
  const features = computeReactionFeatures({
    symbol: 'ETHUSDT',
    bars: alt,
    btcBars: btc,
    events: [event],
    betaLookbackBars: 3,
    capacityLookbackBars: 2
  });
  assert.equal(features.length, 1);
  assert.ok(Math.abs(features[0].beta - 2) < 0.1);
  assert.ok(features[0].reactionScore < 0);
});

test('portfolio selects residual tails, inverse-vol weights them and removes beta exposure', () => {
  const event = {
    eventId: 'event',
    shockEndTime: 1,
    decisionTime: 2,
    baseEntryTime: 3,
    shockReturn: -0.02,
    shockZscore: -5,
    shockDirection: 'DOWN',
    btcReactionReturn: -0.001,
    btcCapacityQuoteVolume: 10_000_000
  };
  const candidates = Array.from({ length: 12 }, (_, index) => ({
    eventId: 'event',
    symbol: `S${index}USDT`,
    beta: 0.5 + index / 20,
    residualVolatility: 0.01 + index / 1000,
    reactionScore: index - 5.5,
    liquidityQuoteVolume: 20_000_000 - index,
    capacityQuoteVolume: 10_000_000
  }));
  const portfolio = buildReactionPortfolio({
    event,
    candidates,
    maximumLongMeanScore: -0.75,
    minimumShortMeanScore: 0.75,
    minimumMeanScoreSpread: 2,
    referenceGrossNotional: 10_000,
    maximumParticipation: 0.02
  });
  assert.equal(portfolio.status, 'trade');
  assert.ok(Math.abs(portfolio.legs.reduce((total, leg) => total + Math.abs(leg.weight), 0) - 1) < 1e-12);
  assert.ok(Math.abs(portfolio.betaExposure) < 1e-12);
  assert.deepEqual(
    portfolio.legs.filter(leg => leg.symbol !== 'BTCUSDT' && leg.weight > 0)
      .map(leg => leg.symbol),
    ['S0USDT', 'S1USDT', 'S2USDT']
  );
});

test('execution charges every leg and delay scenario moves both entry and exit', () => {
  const start = Date.UTC(2024, 0, 1);
  const times = Array.from({ length: 16 }, (_, index) => start + index * FIVE_MINUTES);
  const makeData = prices => ({
    contractByTime: new Map(times.map((time, index) => [time, bar(time, prices[index])])),
    funding: [],
    markByTime: new Map()
  });
  const portfolio = {
    eventId: 'event',
    shockEndTime: times[0],
    decisionTime: times[1],
    baseEntryTime: times[2],
    shockReturn: 0.02,
    shockZscore: 5,
    shockDirection: 'UP',
    btcReactionReturn: 0.001,
    longMeanScore: -2,
    shortMeanScore: 2,
    meanScoreSpread: 4,
    betaExposure: 0,
    holdBars: 2,
    legs: [
      { symbol: 'ETHUSDT', weight: 0.5, beta: 1, reactionScore: -2 },
      { symbol: 'BTCUSDT', weight: -0.5, beta: 1, reactionScore: null }
    ]
  };
  const data = {
    ETHUSDT: makeData(Array.from({ length: 16 }, (_, index) => 100 + index)),
    BTCUSDT: makeData(Array.from({ length: 16 }, (_, index) => 100 + index / 2))
  };
  const trade = executeReactionPortfolio(portfolio, data, {
    name: 'delay5m',
    entryDelayBars: 1,
    slippagePerFill: 0.0007,
    feePerFill: 0.0005
  });
  assert.equal(trade.entryTime, times[3]);
  assert.equal(trade.exitTime, times[5]);
  assert.equal(trade.legs.length, 2);
  assert.ok(trade.fees > 0);
});

test('development screen treats the portfolio event as the observation unit', () => {
  const trades = Array.from({ length: 40 }, (_, index) => ({
    eventId: String(index),
    entryTime: Date.UTC(2024 + Math.floor(index / 12), index % 12, 1),
    exitTime: Date.UTC(2024 + Math.floor(index / 12), index % 12, 1, 1),
    shockDirection: index % 2 ? 'UP' : 'DOWN',
    betaExposure: 0,
    grossPriceReturn: 0.01,
    fees: 0.001,
    fundingReturn: 0,
    netReturn: 0.005,
    legs: [
      { symbol: 'ETHUSDT', side: 1, netReturn: 0.0025 },
      { symbol: 'XRPUSDT', side: -1, netReturn: 0.0025 }
    ]
  }));
  const summary = summarizeReactionPortfolios(trades, ['ETHUSDT', 'XRPUSDT']);
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
  assert.equal(screen.checks.minimumEvents, true);
  assert.equal(screen.checks.bothAltSleeves, true);
});
