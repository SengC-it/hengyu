import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateTradePathMetrics } from '../src/model/trade-metrics.mjs';

test('trade path metrics retain MAE, MFE and mark-to-market drawdown', () => {
  const metrics = calculateTradePathMetrics({
    side: 'BUY',
    entryPrice: 100,
    marks: [
      { time: 1, price: 100 },
      { time: 2, price: 98 },
      { time: 3, price: 103 },
      { time: 4, price: 101 }
    ]
  });
  assert.equal(metrics.maeBps, -200);
  assert.equal(metrics.mfeBps, 300);
  assert.equal(metrics.markToMarketDrawdownBps, 200);
});
