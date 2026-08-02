import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectPairEvents,
  developmentScreen,
  executePairEvent,
  parseFundingHistoryJson,
  robustStats,
  summarizePairTrades
} from '../src/research/exp007.mjs';

const FIVE_MINUTES = 5 * 60 * 1000;

function pairRow(openTime, spread, overrides = {}) {
  const fx = overrides.fx ?? 1;
  const usdcPrice = overrides.usdcPrice ?? 100;
  const usdtPrice = usdcPrice * fx * Math.exp(spread);
  const makeBar = (open, close = open, quoteVolume = 1_000_000) => ({
    openTime,
    closeTime: openTime + FIVE_MINUTES - 1,
    open,
    high: Math.max(open, close),
    low: Math.min(open, close),
    close,
    quoteVolume
  });
  return {
    baseAsset: 'BTC',
    openTime,
    closeTime: openTime + FIVE_MINUTES - 1,
    spread,
    usdt: makeBar(overrides.usdtOpen ?? usdtPrice, usdtPrice),
    usdc: makeBar(overrides.usdcOpen ?? usdcPrice, usdcPrice),
    fx: makeBar(fx),
    usdtQuoteVolume: 1_000_000,
    usdcQuoteVolumeUsdt: 1_000_000
  };
}

test('robust statistics use median and scaled MAD', () => {
  const stats = robustStats([-1, 0, 1, 100]);
  assert.equal(stats.center, 0.5);
  assert.equal(stats.scale, 1.4826);
});

test('official funding history keeps the settlement mark price and normalizes sub-second lag', () => {
  const rows = parseFundingHistoryJson(Buffer.from(JSON.stringify([{
    symbol: 'BTCUSDT',
    fundingTime: 1_782_691_200_006,
    fundingRate: '0.00003112',
    markPrice: '59550.30000000',
    rateType: 'Regular'
  }])), 'BTCUSDT');
  assert.equal(rows[0].eventTime, 1_782_691_200_000);
  assert.equal(rows[0].fundingRate, 0.00003112);
  assert.equal(rows[0].markPrice, 59550.3);
});

test('pair signal uses the frozen prior-day window and enters at the next open', () => {
  const start = Date.UTC(2024, 0, 1, 23, 45);
  const spreads = [-0.001, 0, 0.001, 0.01, -0.001, 0, 0, 0];
  const series = spreads.map((spread, index) => pairRow(start + index * FIVE_MINUTES, spread));
  const events = detectPairEvents(series, {
    robustLookbackBars: 3,
    minimumAbsoluteDeviation: 0.006,
    minimumAbsoluteRobustZ: 4,
    rearmAbsoluteDeviation: 0.003,
    rearmAbsoluteRobustZ: 2,
    liquidityLookbackBars: 2,
    minimumQuoteVolume: 1,
    referenceLegNotional: 1,
    maximumPriorBarParticipation: 1,
    maximumHoldBars: 3,
    evaluationStart: start,
    evaluationEnd: start + 20 * FIVE_MINUTES
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].signalTime, series[3].closeTime);
  assert.equal(events[0].entryTime, series[4].openTime);
  assert.equal(events[0].exitTime, series[5].openTime);
  assert.equal(events[0].direction, 'USDT_RICH');
});

function executionFixture() {
  const start = Date.UTC(2024, 0, 1);
  const series = [
    pairRow(start, 0),
    pairRow(start + FIVE_MINUTES, 0, { usdtOpen: 100, usdcOpen: 100 }),
    pairRow(start + 2 * FIVE_MINUTES, 0, { usdtOpen: 100, usdcOpen: 100 }),
    pairRow(start + 3 * FIVE_MINUTES, 0, { usdtOpen: 99, usdcOpen: 100 })
  ];
  const event = {
    baseAsset: 'BTC',
    signalIndex: 0,
    signalTime: series[0].closeTime,
    entryIndex: 1,
    entryTime: series[1].openTime,
    exitIndex: 3,
    exitTime: series[3].openTime,
    entryDeviation: 0.01,
    direction: 'USDT_RICH',
    sideUsdt: -1,
    sideUsdc: 1
  };
  const mark = new Map([[series[2].openTime, { open: 100 }]]);
  const fxByTime = new Map(series.map(row => [row.openTime, row.fx]));
  const funding = [{ eventTime: series[2].openTime, fundingRate: 0.001 }];
  return { start, series, event, mark, fxByTime, funding };
}

test('pair execution charges four fills and both realized funding legs', () => {
  const fixture = executionFixture();
  const trade = executePairEvent({
    event: fixture.event,
    series: fixture.series,
    usdtFunding: fixture.funding,
    usdcFunding: fixture.funding,
    usdtMarkByTime: fixture.mark,
    usdcMarkByTime: fixture.mark,
    fxByTime: fixture.fxByTime,
    scenario: {
      name: 'base',
      feePerFill: 0.0005,
      slippagePerFill: 0.0001,
      referenceGrossNotional: 10_000,
      singleLegDelay: false
    }
  });
  assert.ok(trade.fees > 0.00099 && trade.fees < 0.00101);
  assert.ok(Math.abs(trade.fundingReturn) < 1e-12);
  assert.ok(trade.netReturn < trade.grossPriceReturnUnits);
  assert.equal(trade.delayedLeg, null);
});

test('extreme execution retains the worse one-leg delay ordering', () => {
  const fixture = executionFixture();
  fixture.series[2].usdt.open = 90;
  const trade = executePairEvent({
    event: fixture.event,
    series: fixture.series,
    usdtFunding: [],
    usdcFunding: [],
    usdtMarkByTime: new Map(),
    usdcMarkByTime: new Map(),
    fxByTime: fixture.fxByTime,
    scenario: {
      name: 'extreme',
      feePerFill: 0.0005,
      slippagePerFill: 0.0015,
      referenceGrossNotional: 10_000,
      singleLegDelay: true
    }
  });
  assert.equal(trade.delayedLeg, 'USDT');
  assert.ok(trade.netReturn < 0);
});

test('development screen uses event pairs and requires the extreme result to remain positive', () => {
  const sample = Array.from({ length: 30 }, (_, index) => ({
    baseAsset: ['BTC', 'ETH', 'BNB', 'SOL'][index % 4],
    entryTime: Date.UTC(2024 + Math.floor(index / 12), index % 12, 1),
    exitTime: Date.UTC(2024 + Math.floor(index / 12), index % 12, 1, 1),
    direction: index % 2 ? 'USDT_RICH' : 'USDC_RICH',
    entryDeviation: index % 2 ? 0.007 : -0.007,
    grossPriceReturnUnits: 0.01,
    netReturn: 0.005,
    fees: 0.001,
    fundingReturn: 0,
    usdtLegNet: 0.0025,
    usdcLegNet: 0.0025
  }));
  const stress = summarizePairTrades(sample);
  const extreme = { ...stress, netReturnUnits: -0.01 };
  const screen = developmentScreen(stress, extreme, {
    minimumEvents: 30,
    minimumProfitFactor: 1.3,
    maximumDrawdown: -0.2,
    minimumProfitableBaseAssets: 4,
    minimumProfitableHalfYears: 3,
    maximumPositiveMonthContributionShare: 0.4,
    minimumMedianEntryDislocation: 0.006
  });
  assert.equal(screen.checks.minimumEvents, true);
  assert.equal(screen.checks.extremeSingleLegDelay, false);
  assert.equal(screen.pass, false);
});
