import assert from 'node:assert/strict';
import test from 'node:test';
import {
  auditHistoricalExchangeInfoMetadata,
  buildFourHourDecisionTimes,
  normalizeBinanceExchangeInfo,
  validateHistoricalExchangeInfo
} from '../src/model/hy-exp-0020-exchange-info.mjs';

const SYMBOL = 'BTCUSDT';
const OBSERVED = '2024-01-01T00:00:00.000Z';

function payload(overrides = {}) {
  return {
    symbols: [{
      symbol: SYMBOL,
      onboardDate: Date.parse('2023-01-01T00:00:00.000Z'),
      status: 'TRADING',
      contractType: 'PERPETUAL',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      filters: [
        { filterType: 'PRICE_FILTER', tickSize: '0.10' },
        { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
        { filterType: 'MIN_NOTIONAL', minNotional: '5' }
      ],
      ...overrides
    }]
  };
}

function historicalSnapshot(overrides = {}) {
  return {
    ...normalizeBinanceExchangeInfo({
      payload: payload(),
      observedAt: OBSERVED,
      receivedAt: '2024-01-01T00:00:00.100Z',
      source: {
        kind: 'historical', pointInTime: true, vendor: 'tardis',
        datasetId: 'binance-futures-exchange-info-2024-01-01',
        sourceUrl: 'https://api.tardis.dev/v1/exchanges/binance-futures',
        license: 'authorized-test-fixture'
      }
    }),
    ...overrides
  };
}

test('normalizes Binance USD-M filters without using current exchangeInfo fallback', () => {
  const result = normalizeBinanceExchangeInfo({
    payload: payload(),
    observedAt: OBSERVED,
    receivedAt: '2024-01-01T00:00:00.100Z'
  });
  assert.equal(result.source.kind, 'current_exchange_info');
  assert.equal(result.symbols[0].tickSize, 0.1);
  assert.equal(result.symbols[0].stepSize, 0.001);
  assert.equal(result.symbols[0].minQty, 0.001);
  assert.equal(result.symbols[0].minNotional, 5);
});

test('PIT exchangeInfo passes only with historical provenance at every decision time', () => {
  const result = validateHistoricalExchangeInfo({
    snapshots: [historicalSnapshot()],
    symbols: [SYMBOL],
    decisionTimes: [
      '2024-01-01T00:00:00.000Z',
      '2024-01-01T03:59:59.000Z'
    ]
  });
  assert.equal(result.status, 'DATA_FEASIBLE');
  assert.equal(result.decision, 'CONTINUE');
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.checked.length, 2);
});

test('PIT exchangeInfo rejects current snapshots, stale coverage and missing historical fields', () => {
  const current = normalizeBinanceExchangeInfo({
    payload: payload(), observedAt: OBSERVED, receivedAt: '2024-01-01T00:00:00.100Z'
  });
  const currentResult = validateHistoricalExchangeInfo({
    snapshots: [current], symbols: [SYMBOL], decisionTimes: [OBSERVED]
  });
  assert.equal(currentResult.status, 'DATA_FAIL');
  assert.ok(currentResult.errors.some(error => error.includes('current_exchangeInfo_not_allowed_for_history')));

  const staleResult = validateHistoricalExchangeInfo({
    snapshots: [historicalSnapshot()], symbols: [SYMBOL],
    decisionTimes: ['2024-01-01T08:00:00.000Z'], maxSnapshotAgeMs: 4 * 60 * 60 * 1_000
  });
  assert.ok(staleResult.errors.some(error => error.includes('snapshot_stale')));

  const missing = historicalSnapshot();
  missing.symbols[0].minNotional = null;
  const missingResult = validateHistoricalExchangeInfo({
    snapshots: [missing], symbols: [SYMBOL], decisionTimes: [OBSERVED]
  });
  assert.ok(missingResult.errors.some(error => error.includes('missing_minNotional')));
});

test('PIT exchangeInfo rejects future listing and non-trading contracts', () => {
  const future = historicalSnapshot();
  future.symbols[0].listingAt = Date.parse('2024-02-01T00:00:00.000Z');
  future.symbols[0].status = 'PENDING';
  const result = validateHistoricalExchangeInfo({
    snapshots: [future], symbols: [SYMBOL], decisionTimes: [OBSERVED]
  });
  assert.ok(result.errors.some(error => error.includes('listed_after_decision')));
  assert.ok(result.errors.some(error => error.includes('status_not_TRADING')));
});

test('PIT metadata audit fails closed and forbids current exchangeInfo backfill', () => {
  const result = auditHistoricalExchangeInfoMetadata({
    requiredSymbols: [SYMBOL],
    metadata: {
      authorized: true, dataAvailable: true, pointInTime: true,
      currentExchangeInfoFallback: true, symbols: [SYMBOL], fields: []
    }
  });
  assert.equal(result.status, 'DATA_FAIL');
  assert.equal(result.fallbackUsed, false);
  assert.ok(result.errors.includes('current_exchangeInfo_fallback_forbidden'));
  assert.ok(result.errors.includes('historical_exchangeInfo_field_missing:tickSize'));
});

test('four-hour PIT decision grid is deterministic for the frozen historical window', () => {
  const times = buildFourHourDecisionTimes({
    windowStart: '2024-01-01T00:00:00.000Z',
    windowEndExclusive: '2024-01-01T08:00:00.000Z'
  });
  assert.deepEqual(times, [
    Date.parse('2024-01-01T00:00:00.000Z'),
    Date.parse('2024-01-01T04:00:00.000Z')
  ]);
});
