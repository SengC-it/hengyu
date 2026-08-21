import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_PROFIT_V3_CONFIG,
  FOUR_HOURS,
  buildResearchBook,
  runProfitV3Backtest
} from '../src/research/profit-v3.mjs';

const START = Date.parse('2024-01-01T00:00:00.000Z');

function bar(symbol, index, close, quoteVolume = 2_000_000) {
  const openTime = START + index * FOUR_HOURS;
  const open = close;
  return {
    symbol,
    openTime,
    closeTime: openTime + FOUR_HOURS - 1,
    open,
    high: close + 1,
    low: Math.max(1, close - 1),
    close,
    quoteVolume
  };
}

function syntheticDataset() {
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
  const barsBySymbol = Object.fromEntries(symbols.map(symbol => [symbol, []]));
  for (let index = 0; index < 55; index++) {
    const trend = index < 22
      ? index
      : index < 40
        ? 22 - (index - 22) * 1.5
        : 0;
    const base = 100 + trend * (index < 22 ? 3 : 4);
    for (const [position, symbol] of symbols.entries()) {
      const close = base + position * 5;
      barsBySymbol[symbol].push(bar(symbol, index, close));
    }
  }
  const fundingBySymbol = Object.fromEntries(symbols.map(symbol => [symbol, [
    { symbol, eventTime: START, fundingRate: 0.0001, fundingIntervalHours: 8 }
  ]]));
  return { symbols, barsBySymbol, fundingBySymbol, coverage: {} };
}

test('research executable book records a PIT receipt and is not a theoretical bar open', () => {
  const book = buildResearchBook({ midPrice: 100, quoteDepthUsdt: 100_000, receivedAt: 1234 });
  assert.equal(book.receivedAt, 1234);
  assert.notEqual(book.asks[0][0], 100);
  assert.notEqual(book.bids[0][0], 100);
});

test('Profit V3 backtest keeps bull/bear/sideways regimes and dynamic universe diagnostics', () => {
  const dataset = syntheticDataset();
  const config = {
    ...DEFAULT_PROFIT_V3_CONFIG,
    evaluationStart: START + 6 * FOUR_HOURS,
    developmentEnd: START + 30 * FOUR_HOURS,
    evaluationEnd: START + 54 * FOUR_HOURS,
    entryChannelBars: 3,
    exitChannelBars: 2,
    atrBars: 2,
    btcFastSmaBars: 2,
    slowSmaBars: 4,
    volumeLookbackBars: 2,
    regimeBreadthFraction: 0.5,
    edgeHorizonBars: 2,
    edgePurgeBars: 2,
    minimumEdgeSamples: 1,
    researchNotionalUsdt: 100,
    researchEquityUsdt: 100_000,
    depthProxyFraction: 0.01
  };
  const result = runProfitV3Backtest({
    dataset,
    config,
    universePolicy: {
      minListingAgeMs: 0,
      minTierAQuoteVolumeUsdt: 1,
      minTierBQuoteVolumeUsdt: 1,
      minTierADepthUsdt: 1,
      minTierBDepthUsdt: 1,
      maxDepthAgeMs: 5_000
    }
  });
  assert.equal(result.experimentId, 'HY-EXP-0019');
  assert.equal(result.authorization, 'PAPER_ONLY');
  assert.equal(result.liveOrdersEnabled, false);
  assert.ok(result.scans.some(scan => scan.regime.regime === 'BULL'));
  assert.ok(result.scans.some(scan => scan.regime.regime === 'BEAR'));
  assert.ok(result.scans.some(scan => scan.regime.regime === 'SIDEWAYS'));
  assert.ok(result.scans.every(scan => scan.universeSymbols.length === 3));
  assert.ok(result.observations.bySide.BUY > 0);
  assert.ok(result.observations.bySide.SELL > 0);
  assert.equal(result.validation.oos.noOosLabelsUsedForEdge, true);
  assert.equal(result.promotionEligible, false);
});
