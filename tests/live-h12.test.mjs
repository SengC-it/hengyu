import assert from 'node:assert/strict';
import test from 'node:test';
import { detectLiveH12Signals, evaluateLiveH12Scan, fetchLiveH12Series, h12AdvisoryBundle, H12_PRODUCTION_POLICY } from '../src/model/live-h12.mjs';

function fallingSeries(symbol, { breakout = false } = {}) {
  const step = 4 * 60 * 60 * 1000;
  return Array.from({ length: 182 }, (_, index) => {
    const base = 300 - index;
    const close = breakout && index === 180 ? base - 2 : base;
    return {
      symbol, openTime: index * step, closeTime: (index + 1) * step - 1,
      open: base + 0.5, high: base + 1, low: base - 1, close
    };
  });
}

function marketBySymbol() {
  return Object.fromEntries(H12_PRODUCTION_POLICY.symbols.map(symbol => [symbol, {
    book: {
      bids: [[100, 1_000], [99.99, 1_000]],
      asks: [[100.01, 1_000], [100.02, 1_000]],
      receivedAt: 181 * 4 * 60 * 60 * 1000
    },
    receivedAt: 181 * 4 * 60 * 60 * 1000,
    funding: { fundingRate: 0, nextFundingTime: 182 * 4 * 60 * 60 * 1000, markPrice: 100 }
  }]));
}

test('live H12 emits only causal short breakouts in a broad bear regime', () => {
  const series = Object.fromEntries(H12_PRODUCTION_POLICY.symbols.map(symbol => [
    symbol, fallingSeries(symbol, { breakout: symbol === 'BTCUSDT' })
  ]));
  const signals = detectLiveH12Signals(series, {
    now: 181 * 4 * 60 * 60 * 1000 + 1,
    marketBySymbol: marketBySymbol(),
    policy: { ...H12_PRODUCTION_POLICY, forecastStandardErrorBps: 1 }
  });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].symbol, 'BTCUSDT');
  assert.equal(signals[0].side, 'SELL');
  assert.equal(signals[0].entryPrice, 100);
  assert.notEqual(signals[0].entryPrice, signals[0].theoreticalOpen);
  assert.equal(signals[0].executablePrice, 100);
  assert.equal(signals[0].costs.feeBps, 10);
  assert.equal(signals[0].funding.expectedFundingBps, 0);
  assert.ok(signals[0].stopPrice > signals[0].entryPrice);
});

test('H12 marks a delayed breakout MISSED_SIGNAL instead of emitting a tradeable advisory', () => {
  const series = Object.fromEntries(H12_PRODUCTION_POLICY.symbols.map(symbol => [
    symbol, fallingSeries(symbol, { breakout: symbol === 'BTCUSDT' })
  ]));
  const theoreticalOpenAt = 181 * 4 * 60 * 60 * 1000;
  const evaluated = detectLiveH12Signals(series, {
    now: theoreticalOpenAt + 101,
    marketBySymbol: marketBySymbol(),
    policy: {
      ...H12_PRODUCTION_POLICY,
      maxSchedulerDelayMs: 100,
      forecastStandardErrorBps: 1
    }
  });
  assert.equal(evaluated.length, 0);
  const diagnostics = evaluateLiveH12Scan(series, {
    now: theoreticalOpenAt + 101,
    marketBySymbol: marketBySymbol(),
    policy: { ...H12_PRODUCTION_POLICY, maxSchedulerDelayMs: 100, forecastStandardErrorBps: 1 }
  }).diagnostics;
  assert.equal(diagnostics.status, 'MISSED_SIGNAL');
  assert.equal(diagnostics.symbols.BTCUSDT.status, 'MISSED_SIGNAL');
  assert.ok(diagnostics.symbols.BTCUSDT.reasons.includes('SCHEDULER_DELAY_EXCEEDED'));
});

test('H12 records NO_SIGNAL reasons and Net Edge rejection without emitting an advisory', () => {
  const noBreakoutSeries = Object.fromEntries(H12_PRODUCTION_POLICY.symbols.map(symbol => [
    symbol, fallingSeries(symbol)
  ]));
  const noBreakout = evaluateLiveH12Scan(noBreakoutSeries, {
    now: 181 * 4 * 60 * 60 * 1000 + 1,
    marketBySymbol: marketBySymbol()
  });
  assert.equal(noBreakout.status, 'NO_SIGNAL');
  assert.equal(noBreakout.signals.length, 0);
  assert.ok(noBreakout.diagnostics.symbols.BTCUSDT.reasons.includes('NO_BREAKOUT'));

  const breakoutSeries = Object.fromEntries(H12_PRODUCTION_POLICY.symbols.map(symbol => [
    symbol, fallingSeries(symbol, { breakout: symbol === 'BTCUSDT' })
  ]));
  const rejected = evaluateLiveH12Scan(breakoutSeries, {
    now: 181 * 4 * 60 * 60 * 1000 + 1,
    marketBySymbol: marketBySymbol(),
    policy: { ...H12_PRODUCTION_POLICY, forecastStandardErrorBps: 1_000 }
  });
  assert.equal(rejected.status, 'NO_SIGNAL');
  assert.equal(rejected.signals.length, 0);
  assert.equal(rejected.diagnostics.symbols.BTCUSDT.status, 'NO_TRADE');
  assert.ok(rejected.diagnostics.symbols.BTCUSDT.reasons.includes('insufficient_conservative_net_edge'));
});

test('H12 production bundle remains paper-only and declares dynamic exit', () => {
  const bundle = h12AdvisoryBundle({
    signalId: 'H12:BTCUSDT:SELL:1', experimentId: 'HY-EXP-0018', symbol: 'BTCUSDT', side: 'SELL',
     alertLevel: 'MEDIUM', signalTime: 1, entryTime: 2, decisionTime: 3, expiresAt: 4_000,
     theoreticalOpenAt: 2, theoreticalOpen: 100, executablePrice: 100,
     entryPrice: 100,
     stopPrice: 105, signalClose: 99, priorEntryChannelLow: 100, atr: 2.5,
    initialExitChannelPrice: 110, exitRule: 'dynamic rule',
    funding: { expectedFundingBps: 5, fundingCostBps: -5, holdingPeriodMs: 86_400_000, settlementCount: 3 }
  }, { generatedAt: 3 });
  assert.equal(bundle.record.advisory.live_orders_enabled, false);
  assert.equal(bundle.record.advisory.authorization_mode, 'PAPER_ONLY');
  assert.equal(bundle.record.advisory.exit_reference, null);
  assert.equal(bundle.record.advisory.holding_period_ms, 86_400_000);
  assert.equal(bundle.record.advisory.funding_cost_bps, -5);
  assert.equal(bundle.record.advisory.funding_event_count, 3);
  assert.equal(bundle.record.advisory.dedupe_key, 'HY-EXP-0018:BTCUSDT:SELL:1');
  assert.equal(bundle.record.advisory.metadata.reviewModel, 'DYNAMIC_DONCHIAN_NOT_FIXED_TP_SL');
  assert.equal(bundle.record.advisory.metadata.source, 'vercel-h12-worker');
});

test('live H12 falls back to the next official Binance futures endpoint', async () => {
  const calls = [];
  const rows = [[0, '100', '102', '98', '101', '1', 14_399_999]];
  const fetchImpl = async url => {
    calls.push(url.hostname);
    if (calls.length === 1) return { ok: false, status: 451, text: async () => '' };
    return { ok: true, status: 200, text: async () => JSON.stringify(rows) };
  };
  const series = await fetchLiveH12Series('BTCUSDT', { fetchImpl });
  assert.deepEqual(calls, ['fapi.binance.com', 'fapi1.binance.com']);
  assert.equal(series[0].symbol, 'BTCUSDT');
  assert.equal(series[0].close, 101);
});
