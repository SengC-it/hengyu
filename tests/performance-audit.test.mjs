import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluatePromotion,
  lossContainmentComparison,
  summarizePerformance
} from '../src/model/performance-audit.mjs';

const rows = [
  { scenario: 'stress', eventTime: Date.parse('2026-01-01T00:00:00Z'), netReturn: 0.02 },
  { scenario: 'stress', eventTime: Date.parse('2026-01-08T00:00:00Z'), netReturn: -0.03 },
  { scenario: 'stress', eventTime: Date.parse('2026-02-01T00:00:00Z'), netReturn: -0.01 },
  { scenario: 'base', eventTime: Date.parse('2026-02-08T00:00:00Z'), netReturn: 1 }
];

test('performance audit reports return quality, drawdown and monthly stability', () => {
  const summary = summarizePerformance(rows, {
    scenario: 'stress',
    periodStart: '2026-01-01T00:00:00Z',
    periodEnd: '2026-03-01T00:00:00Z'
  });
  assert.equal(summary.trades, 3);
  assert.equal(summary.wins, 1);
  assert.equal(summary.losses, 2);
  assert.ok(Math.abs(summary.netReturnUnits + 0.02) < 1e-12);
  assert.ok(Math.abs(summary.profitFactor - 0.5) < 1e-12);
  assert.ok(Math.abs(summary.maximumDrawdownReturnUnits + 0.04) < 1e-12);
  assert.equal(summary.maximumConsecutiveLosses, 2);
  assert.equal(summary.positiveMonths, 0);
  assert.equal(summary.negativeMonths, 2);
});

test('failed frozen gates eliminate the exact specification and block promotion', () => {
  const summary = summarizePerformance(rows, {
    scenario: 'stress',
    periodStart: '2026-01-01T00:00:00Z',
    periodEnd: '2026-03-01T00:00:00Z'
  });
  const result = evaluatePromotion(summary, {
    minimumTrades: 100,
    minimumProfitFactor: 1.3,
    maximumDrawdownReturnUnits: -0.02
  });
  assert.equal(result.status, 'ELIMINATED');
  assert.equal(result.newSignalsAllowed, false);
  assert.deepEqual(result.failures, [
    'minimumTrades', 'profitFactor', 'positiveNet', 'positiveWithoutBest5', 'maximumDrawdown'
  ]);
});

test('loss containment comparison labels NO_TRADE as avoided loss, not profit', () => {
  const comparison = lossContainmentComparison({ trades: 10, netReturnUnits: -0.2 }, {
    referenceNotionalUsdt: 10_000
  });
  assert.equal(comparison.before.pnlUsdt, -2_000);
  assert.equal(comparison.after.pnlUsdt, 0);
  assert.equal(comparison.historicalLossExposureRemovedUsdt, 2_000);
  assert.match(comparison.warning, /not retroactive avoided loss/);
});
