import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateFundingStats, estimateFundingCarryBps } from '../src/model/funding.mjs';

test('funding carry uses side direction and the full holding-period settlement count', () => {
  assert.ok(Math.abs(estimateFundingCarryBps({
    side: 'SELL',
    fundingRate: 0.0001,
    holdingPeriodMs: 24 * 60 * 60 * 1_000
  }) - 3) < 1e-12);
  assert.ok(Math.abs(estimateFundingCarryBps({
    side: 'BUY',
    fundingRate: 0.0001,
    holdingPeriodMs: 24 * 60 * 60 * 1_000
  }) + 3) < 1e-12);
});

test('realized funding stats report holding period, event count, PnL and cost', () => {
  const stats = calculateFundingStats({
    side: 'BUY',
    quantity: 1,
    entryPrice: 100,
    entryTime: 0,
    exitTime: 16 * 60 * 60 * 1_000,
    fundingRates: [
      { fundingTime: 8 * 60 * 60 * 1_000, fundingRate: 0.0001 },
      { fundingTime: 16 * 60 * 60 * 1_000, fundingRate: -0.0002 }
    ],
    markPrices: [
      { time: 8 * 60 * 60 * 1_000, price: 100 },
      { time: 16 * 60 * 60 * 1_000, price: 110 }
    ]
  });
  assert.equal(stats.holdingPeriodMs, 16 * 60 * 60 * 1_000);
  assert.equal(stats.fundingEvents, 2);
  assert.ok(Math.abs(stats.fundingPnl - 0.012) < 1e-12);
  assert.ok(Math.abs(stats.fundingCostBps + 1.2) < 1e-12);
});
