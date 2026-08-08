import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchFuturesAggTrades, fetchFuturesKlines } from '../api/_lib/market-data.mjs';

function response(payload) {
  return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
}

test('market data adapter normalizes public futures klines', async () => {
  const calls = [];
  const rows = await fetchFuturesKlines('BTCUSDT', 1_000, 61_000, {
    fetchImpl: async url => {
      calls.push(String(url));
      return response([
        [1_000, '100', '101', '99', '100.5', '1', 59_999],
        [60_000, '100.5', '102', '100', '101', '1', 61_000]
      ]);
    }
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { openTime: 1_000, open: 100, high: 101, low: 99, close: 100.5, closeTime: 59_999 });
  assert.match(calls[0], /interval=1m/);
});

test('market data adapter normalizes aggregate trades for exact trigger order', async () => {
  const rows = await fetchFuturesAggTrades('BTCUSDT', 1_000, 2_000, {
    fetchImpl: async () => response([
      { a: 2, p: '99', q: '0.1', T: 1_100 },
      { a: 3, p: '101', q: '0.1', T: 1_200 }
    ])
  });
  assert.deepEqual(rows.map(row => row.time), [1_100, 1_200]);
  assert.equal(rows[0].price, 99);
  assert.equal(rows[1].id, 3);
});
