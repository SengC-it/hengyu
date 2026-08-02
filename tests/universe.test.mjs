import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildUniverseSnapshot,
  depthQuoteWithinBps,
  eligibleSymbols,
  summarizeUniverse
} from '../src/model/universe.mjs';

const NOW = 10_000_000_000;
const OLD = NOW - 31 * 86_400_000;

function info(symbol, baseAsset = symbol.replace('USDT', '')) {
  return {
    symbol,
    baseAsset,
    quoteAsset: 'USDT',
    contractType: 'PERPETUAL',
    status: 'TRADING',
    onboardDate: OLD,
    asOf: NOW - 100
  };
}

function ticker(symbol, quoteVolumeUsdt, asOf = NOW - 100) {
  return { symbol, quoteVolume: quoteVolumeUsdt, asOf };
}

function depth(symbol, asOf = NOW - 100) {
  return {
    symbol,
    asOf,
    bids: [[99.95, 3_000], [99.94, 3_000]],
    asks: [[100.05, 3_000], [100.06, 3_000]]
  };
}

test('depth metrics use numeric prices and require two-sided depth', () => {
  const metrics = depthQuoteWithinBps({
    bids: [['99.95', '3000']],
    asks: [['100.05', '3000']]
  });
  assert.equal(metrics.midPrice, 100);
  assert.equal(metrics.minSideDepthUsdt, 299850);
});

test('universe is point-in-time, tiered, and excludes invalid contracts', () => {
  const snapshot = buildUniverseSnapshot({
    observedAt: NOW,
    exchangeInfo: [
      info('BTCUSDT'),
      info('ETHUSDT'),
      info('USDCUSDT', 'USDC'),
      { ...info('NEWUSDT'), onboardDate: NOW - 2 * 86_400_000 },
      { ...info('DELUSDT'), status: 'PENDING_TRADING' }
    ],
    tickers: [
      ticker('BTCUSDT', 20_000_000),
      ticker('ETHUSDT', 2_000_000),
      ticker('USDCUSDT', 20_000_000),
      ticker('NEWUSDT', 20_000_000),
      ticker('DELUSDT', 20_000_000)
    ],
    depths: [depth('BTCUSDT'), depth('ETHUSDT'), depth('USDCUSDT'), depth('NEWUSDT'), depth('DELUSDT')]
  });
  assert.deepEqual(snapshot.symbols, ['BTCUSDT', 'ETHUSDT']);
  assert.equal(snapshot.counts.tierA, 1);
  assert.equal(snapshot.counts.tierB, 1);
  assert.deepEqual(eligibleSymbols(snapshot), ['BTCUSDT', 'ETHUSDT']);
  assert.deepEqual(summarizeUniverse(snapshot).tiers, { A: ['BTCUSDT'], B: ['ETHUSDT'] });
  assert.equal(snapshot.futureDataUsed, false);
  assert.ok(snapshot.universeVersion.length === 64);
  assert.ok(snapshot.excluded.find(row => row.symbol === 'NEWUSDT').reasons.includes('listing_age_under_30d'));
});

test('future-dated source data is rejected rather than silently used', () => {
  assert.throws(() => buildUniverseSnapshot({
    observedAt: NOW,
    exchangeInfo: [info('BTCUSDT')],
    tickers: [ticker('BTCUSDT', 20_000_000, NOW + 1)],
    depths: [depth('BTCUSDT')]
  }), /future data/);
});
