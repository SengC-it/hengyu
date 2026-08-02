import assert from 'node:assert/strict';
import test from 'node:test';
import { FIVE_MINUTES } from '../src/research/archive.mjs';
import {
  buildEventPortfolio,
  collapseMetricsCollisions,
  computeSymbolEventFeatures,
  detectMarketShocks,
  developmentScreen,
  executePortfolio,
  parseMetricsArchiveLines,
  summarizePortfolios
} from '../src/research/exp004.mjs';

function bars(symbol, count, shock = false) {
  const output = [];
  let price = 100;
  for (let index = 0; index < count; index++) {
    const open = price;
    price *= shock && index === count - 1 ? 0.95 : 1 + (index % 2 ? 0.0001 : -0.0001);
    output.push({
      symbol,
      openTime: index * FIVE_MINUTES,
      closeTime: (index + 1) * FIVE_MINUTES - 1,
      open,
      high: Math.max(open, price),
      low: Math.min(open, price),
      close: price,
      quoteVolume: 1000 + index
    });
  }
  return output;
}

test('shock detector uses only prior returns and delays repeated events', () => {
  const input = bars('BTCUSDT', 30, true);
  const events = detectMarketShocks(input, {
    shockWindowBars: 1,
    volatilityLookbackBars: 10,
    evaluationStart: 0,
    evaluationEnd: Infinity,
    maximumReturn: -0.02,
    maximumZscore: -4,
    cooldownBars: 10
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].eventTime, input.at(-1).closeTime + 1);
});

test('metrics parser rejects duplicate period-end timestamps', () => {
  const row = '2024-01-01 00:00:00,TESTUSDT,10,1000,1,1,1,1';
  assert.throws(() => parseMetricsArchiveLines([row, row], 'TESTUSDT'), /duplicate/);
});

test('metrics parser normalizes only preregistered publication lag', () => {
  const row = '2024-01-01 00:05:06,TESTUSDT,10,1000,1,1,1,1';
  const parsed = parseMetricsArchiveLines([row], 'TESTUSDT', {
    maximumPublicationLagMs: 10000
  });
  assert.equal(parsed[0].createTime, Date.parse('2024-01-01T00:05:00Z'));
  assert.equal(parsed[0].publicationLagMs, 6000);
  assert.throws(() => parseMetricsArchiveLines([row], 'TESTUSDT', {
    maximumPublicationLagMs: 5000
  }), /unaligned/);
});

test('unrelated zero OI can parse but required event OI must be positive', () => {
  const row = '2024-01-01 00:05:00,TESTUSDT,0,0,1,1,1,1';
  assert.equal(parseMetricsArchiveLines([row], 'TESTUSDT')[0].openInterest, 0);
});

test('duplicate metrics snapshots become ambiguous without choosing a value', () => {
  const collapsed = collapseMetricsCollisions([
    { symbol: 'TESTUSDT', createTime: 0, openInterest: 10 },
    { symbol: 'TESTUSDT', createTime: 0, openInterest: 11 }
  ]);
  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0].ambiguous, true);
  assert.equal(collapsed[0].openInterest, undefined);
});

test('ambiguous required OI excludes only that symbol-event', () => {
  const input = bars('TESTUSDT', 30);
  const btc = bars('BTCUSDT', 30);
  const eventTime = 25 * FIVE_MINUTES;
  const features = computeSymbolEventFeatures({
    symbol: 'TESTUSDT',
    symbolBars: input,
    btcBars: btc,
    metrics: new Map([
      [eventTime - 2 * FIVE_MINUTES, { ambiguous: true }],
      [eventTime, { openInterest: 10 }]
    ]),
    events: [{ eventTime, shockReturn: -0.03 }],
    betaLookbackBars: 10,
    liquidityLookbackBars: 10,
    shockWindowBars: 2,
    invalidOiPolicy: 'exclude_symbol_for_event'
  });
  assert.deepEqual(features, []);
});

test('portfolio is beta hedged and execution charges every leg', () => {
  const symbols = Array.from({ length: 12 }, (_, index) => `S${index}USDT`);
  const count = 30;
  const btc = bars('BTCUSDT', count);
  const eventTime = 25 * FIVE_MINUTES;
  const barsBySymbol = { BTCUSDT: btc };
  const metricsBySymbol = {};
  for (const [index, symbol] of symbols.entries()) {
    const series = bars(symbol, count);
    series[24].close *= 1 + (index - 6) * 0.001;
    barsBySymbol[symbol] = series;
    metricsBySymbol[symbol] = new Map([
      [eventTime - 2 * FIVE_MINUTES, { openInterest: 100 + index }],
      [eventTime, { openInterest: 90 + 2 * index }]
    ]);
  }
  const portfolio = buildEventPortfolio({
    event: {
      eventTime,
      shockReturn: -0.03,
      shockZscore: -5
    },
    barsBySymbol,
    metricsBySymbol,
    benchmark: 'BTCUSDT',
    eligibleSymbols: symbols,
    betaLookbackBars: 10,
    liquidityLookbackBars: 10,
    shockWindowBars: 2,
    longCount: 3,
    shortCount: 3,
    minimumValidSymbols: 12
  });
  assert.ok(Math.abs(portfolio.exAnteBeta) < 1e-12);
  const dataBySymbol = Object.fromEntries(['BTCUSDT', ...symbols].map(symbol => [
    symbol,
    { contract: barsBySymbol[symbol], mark: [], funding: [] }
  ]));
  const trade = executePortfolio(portfolio, dataBySymbol, {
    name: 'stress',
    feePerSide: 0.0005,
    slippagePerSide: 0.0007
  }, 2);
  assert.ok(trade.fees > 0);
  assert.ok(trade.legs.length >= 6);
});

test('development screen operates on event portfolios, not dependent legs', () => {
  const summary = summarizePortfolios([], ['A']);
  const screen = developmentScreen(summary, {
    minimumEvents: 20,
    minimumProfitFactor: 1.15,
    maximumDrawdown: -0.2,
    minimumProfitableSymbols: 1,
    minimumProfitableHalfYears: 1,
    maximumPositiveMonthContributionShare: 0.4
  });
  assert.equal(screen.pass, false);
  assert.ok(screen.failures.includes('minimumEvents'));
});
