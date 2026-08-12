import assert from 'node:assert/strict';
import test from 'node:test';
import { detectLiveH12Signals, fetchLiveH12Series, h12AdvisoryBundle, H12_PRODUCTION_POLICY } from '../src/model/live-h12.mjs';

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

test('live H12 emits only causal short breakouts in a broad bear regime', () => {
  const series = Object.fromEntries(H12_PRODUCTION_POLICY.symbols.map(symbol => [
    symbol, fallingSeries(symbol, { breakout: symbol === 'BTCUSDT' })
  ]));
  const signals = detectLiveH12Signals(series, { now: 181 * 4 * 60 * 60 * 1000 + 1 });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].symbol, 'BTCUSDT');
  assert.equal(signals[0].side, 'SELL');
  assert.ok(signals[0].stopPrice > signals[0].entryPrice);
});

test('H12 production bundle remains paper-only and declares dynamic exit', () => {
  const bundle = h12AdvisoryBundle({
    signalId: 'H12:BTCUSDT:SELL:1', experimentId: 'HY-EXP-0018', symbol: 'BTCUSDT',
    alertLevel: 'MEDIUM', signalTime: 1, entryTime: 2, entryPrice: 100,
    stopPrice: 105, signalClose: 99, priorEntryChannelLow: 100, atr: 2.5,
    initialExitChannelPrice: 110, exitRule: 'dynamic rule'
  }, { generatedAt: 3 });
  assert.equal(bundle.record.advisory.live_orders_enabled, false);
  assert.equal(bundle.record.advisory.authorization_mode, 'PAPER_ONLY');
  assert.equal(bundle.record.advisory.exit_reference, null);
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
