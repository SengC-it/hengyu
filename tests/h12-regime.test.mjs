import assert from 'node:assert/strict';
import test from 'node:test';
import { broadBearRegimeTimes } from '../src/research/h12-regime.mjs';

test('broad bear regime requires BTC trend and frozen cross-symbol breadth', () => {
  const symbols = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'];
  const seriesBySymbol = Object.fromEntries(symbols.map((symbol, symbolIndex) => [symbol,
    Array.from({ length: 6 }, (_, index) => ({
      openTime: index,
      close: symbolIndex < 4 ? 100 - index : 100 + index
    }))
  ]));
  const eligible = broadBearRegimeTimes(seriesBySymbol, {
    symbols, fastBars: 2, slowBars: 4, minimumBreadth: 4
  });
  assert.equal(eligible.has(5), true);
});

test('broad bear regime rejects insufficient breadth', () => {
  const symbols = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'];
  const seriesBySymbol = Object.fromEntries(symbols.map((symbol, symbolIndex) => [symbol,
    Array.from({ length: 6 }, (_, index) => ({ openTime: index, close: symbolIndex < 3 ? 100 - index : 100 + index }))
  ]));
  const eligible = broadBearRegimeTimes(seriesBySymbol, {
    symbols, fastBars: 2, slowBars: 4, minimumBreadth: 4
  });
  assert.equal(eligible.size, 0);
});
