import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { evaluateLiveH12Scan, H12_PRODUCTION_POLICY } from '../src/model/live-h12.mjs';
import { buildDynamicUniverse, familyOverlapStats, requiredBreadthForFraction, selectCompletedFourHourSnapshot } from '../scripts/hy-exp-0024-audit.mjs';
import { evaluateNetEdge } from '../src/model/net-edge.mjs';

const audit = JSON.parse(fs.readFileSync('artifacts/audits/HY-EXP-0024-signal-funnel.json', 'utf8'));
const design = JSON.parse(fs.readFileSync('artifacts/audits/HY-EXP-0024-model-design.json', 'utf8'));
const BOOK = {
  bids: [[99.9, 2], [99.8, 5]],
  asks: [[100.1, 1], [100.2, 5]]
};

function fallingSeries(symbol, breakout = false) {
  const step = 4 * 60 * 60 * 1000;
  return Array.from({ length: 182 }, (_, index) => {
    const base = 300 - index;
    const close = breakout && index === 180 ? base - 2 : base;
    return {
      symbol,
      openTime: index * step,
      closeTime: (index + 1) * step - 1,
      open: base + 0.5,
      high: base + 1,
      low: base - 1,
      close
    };
  });
}

function marketBySymbol() {
  return Object.fromEntries(H12_PRODUCTION_POLICY.symbols.map(symbol => [symbol, {
    book: {
      bids: [[100, 1_000]],
      asks: [[100.01, 1_000]],
      receivedAt: 181 * 4 * 60 * 60 * 1000
    },
    funding: {
      fundingRate: 0,
      fundingTime: 180 * 4 * 60 * 60 * 1000,
      nextFundingTime: 182 * 4 * 60 * 60 * 1000,
      markPrice: 100
    }
  }]));
}

test('HY-EXP-0024 audit is research-only and does not reuse 0019 OOS', () => {
  assert.equal(audit.experimentId, 'HY-EXP-0024');
  assert.equal(audit.status, 'AUDIT_ONLY_NOT_PREREGISTERED');
  assert.equal(audit.authorization, 'PAPER_ONLY');
  assert.equal(audit.liveOrdersEnabled, false);
  assert.equal(audit.pnlComputed, false);
  assert.equal(audit.auditWindow.start, '2024-01-01T00:00:00.000Z');
  assert.equal(audit.auditWindow.endExclusive, '2025-07-01T00:00:00.000Z');
  assert.match(audit.auditWindow.prohibitedWindowReuse, /2025-07-01/);
  assert.equal(audit.currentH12Funnel.gmailAdvisories, 0);
  assert.equal(audit.proposedExpansionFunnel.edgeEligible, 0);
  assert.equal(audit.promotionEligible, false);
  assert.equal(audit.noPromotionDecision.betterNetProfitabilityAndUsableSignalCount, false);
});

test('live H12 otherwise-valid breakout remains structurally blocked by unverified Edge', () => {
  const series = Object.fromEntries(H12_PRODUCTION_POLICY.symbols.map(symbol => [
    symbol,
    fallingSeries(symbol, symbol === 'BTCUSDT')
  ]));
  const result = evaluateLiveH12Scan(series, {
    now: 181 * 4 * 60 * 60 * 1000 + 1,
    marketBySymbol: marketBySymbol(),
    policy: { ...H12_PRODUCTION_POLICY, forecastStandardErrorBps: 1 }
  });
  const btc = result.diagnostics.symbols.BTCUSDT;
  assert.equal(result.signals.length, 0);
  assert.equal(result.diagnostics.gmailAdvisories ?? 0, 0);
  assert.equal(btc.edgeSource, 'UNVERIFIED');
  assert.equal(btc.candidate.expectedPriceEdgeBps, null);
  assert.equal(btc.candidate.edgeModelId, null);
  assert.ok(btc.reasons.includes('EDGE_UNVERIFIED'));
  assert.ok(btc.reasons.includes('unverified_price_edge'));
});

test('HY-EXP-0024 design keeps candidate families separate and requires candidate-level edge', () => {
  assert.deepEqual(design.candidateEngine, ['Candidate', 'Edge Model', 'Net Edge Gate', 'Portfolio Risk Gate', 'Advisory']);
  assert.equal(design.edgeModel.training, 'separate ridge regression for each candidate family x regime x side; intercept included; lambda=1.0 frozen; no pooled BUY/BULL mean');
  assert.deepEqual(Object.keys(design.entry.families).sort(), ['PULLBACK_CONTINUATION', 'TREND_BREAKOUT', 'VOLATILITY_EXPANSION']);
  assert.equal(design.exits.maximumHoldBars, 6);
  assert.equal(design.exits.maxHold, '6 completed 1h bars; terminal exit at the sixth bar if stop/channel has not fired');
  assert.match(design.exits.researchExpiry, /not a trade holding-period exit/);
  assert.equal(design.edgeExitAlignment.status, 'ALIGNED_PROPOSAL_PENDING_PREREGISTRATION_REVIEW');
  assert.equal(design.edgeExitAlignment.recommendedArchitecture, 'B_EXACT_EXECUTION_LABEL_WITH_FROZEN_EVALUATION_CAP');
  assert.equal(design.edgeExitAlignment.proposedArchitecture.evaluationCapBars, 6);
  assert.equal(design.edgeExitAlignment.proposedArchitecture.maximumHoldBars, 6);
  assert.equal(design.edgeExitAlignment.proposedArchitecture.noHorizonTuning, true);
  assert.equal(design.invariants.EDGE_TARGET_MUST_EXCLUDE_NET_EDGE_COST_COMPONENTS, true);
  assert.equal(design.edgeModel.targetType, 'GROSS_PRICE_EDGE_ONLY');
  assert.deepEqual(design.edgeModel.targetCostExclusions, ['fee', 'funding', 'spread', 'book_cost', 'slippage', 'impact', 'latency', 'funding_stress']);
  assert.equal(design.riskAndDelivery.orderApi, false);
  assert.equal(design.riskAndDelivery.accountApi, false);
});

test('SELL_ONLY attribution is fixed-six BULL/BUY only', () => {
  const direction = audit.currentH12Funnel.directionOnlyComparison;
  assert.equal(direction.bearSellCandidates, audit.historicalCandidateCounts.currentH12);
  assert.equal(direction.bullBuyCandidates, direction.sellOnlyImpact);
  assert.equal(direction.bidirectionalTotal, direction.bearSellCandidates + direction.bullBuyCandidates);
  assert.equal(audit.historicalCandidateCounts.fixedSixBidirectional4h, direction.bidirectionalTotal);
});

test('direction, universe-only and 50% breadth increments reconcile independently', () => {
  const stages = audit.controlledComparisons;
  assert.equal(stages.bidirectional.incrementalCandidateCount, stages.bidirectional.bidirectionalTotal - stages.baseline.candidateCount);
  assert.equal(stages.observedUniverse.breadthFraction, 2 / 3);
  assert.match(stages.observedUniverse.requiredBreadthRule, /2\/3/);
  assert.equal(stages.observedUniverse.incrementalCandidateCount, stages.observedUniverse.candidateCount - stages.bidirectional.bidirectionalTotal);
  assert.equal(stages.breadth50.previousBreadthFraction, 2 / 3);
  assert.equal(stages.breadth50.breadthFraction, 0.5);
  assert.equal(stages.breadth50.incrementalCandidateCount, stages.breadth50.candidateCount - stages.observedUniverse.candidateCount);
  assert.equal(audit.historicalCandidateCounts.directionImpact, stages.bidirectional.incrementalCandidateCount);
  assert.equal(audit.historicalCandidateCounts.universeImpact, stages.observedUniverse.incrementalCandidateCount);
  assert.equal(audit.historicalCandidateCounts.breadth50Impact, stages.breadth50.incrementalCandidateCount);
});

test('universe-only control preserves H12 4/6 as equivalent 2/3 breadth', () => {
  assert.equal(requiredBreadthForFraction(6, 2 / 3), 4);
  assert.equal(requiredBreadthForFraction(8, 2 / 3), 6);
  assert.equal(requiredBreadthForFraction(8, 0.5), 4);
  assert.equal(audit.controlledComparisons.observedUniverse.breadthFraction, 2 / 3);
  assert.equal(audit.controlledComparisons.breadth50.previousBreadthFraction, 2 / 3);
});

test('gross Edge target excludes Net Edge costs and is not double-counted', () => {
  const candidate = {
    symbol: 'BTCUSDT',
    side: 'BUY',
    expectedPriceEdgeBps: 50,
    forecastStandardErrorBps: 0,
    expectedFundingBps: 0,
    fundingStressBps: 0,
    quantity: 1,
    forecastTime: 9_000,
    bookTime: 9_500,
    edgeSource: 'VALIDATED_GROSS_PRICE_MODEL'
  };
  const policy = {
    confidenceZ: 1.645,
    minimumConservativeNetBps: 0,
    minimumGrossToCostRatio: 1,
    maximumForecastAgeMs: 5_000,
    maximumBookAgeMs: 1_000,
    maximumVisibleBookFraction: 1,
    feeRatePerFill: 0.0005,
    bookStressMultiplier: 2,
    impactBufferBpsPerFill: 1,
    latencyBufferBpsPerFill: 1
  };
  const result = evaluateNetEdge({ candidate, book: BOOK, policy, now: 10_000 });
  assert.equal(candidate.expectedPriceEdgeBps, 50);
  assert.equal(result.metrics.expectedGrossEdgeBps, 50);
  assert.ok(result.metrics.execution.totalExecutionCostBps > 0);
  assert.equal(result.metrics.expectedNetEdgeBps, 50 - result.metrics.execution.totalExecutionCostBps);
  assert.ok(result.metrics.expectedNetEdgeBps < candidate.expectedPriceEdgeBps);
});

test('dynamic universe is applied and candidate denominators are not conflated', () => {
  const funnel = audit.proposedExpansionFunnel;
  assert.equal(funnel.universeApplication.applied, true);
  assert.ok(funnel.universeApplication.snapshotCount > 0);
  assert.equal(funnel.universeApplication.observedUniverseCoverage, 8);
  assert.equal(funnel.universeApplication.top20CapacityNotDemonstrated, true);
  assert.ok(funnel.regimeEligibleSymbolSlots >= funnel.uniqueCandidateSlots);
  assert.ok(funnel.candidateFamilyObservations >= funnel.uniqueCandidateSlots);
  assert.equal(funnel.oneFamily + funnel.twoFamilies + funnel.threeFamilies, funnel.uniqueCandidateSlots);
  assert.equal(funnel.familyOverlapSlots, funnel.twoFamilies + funnel.threeFamilies);
});

test('dynamic universe uses prior six completed quote-volume bars and deterministic eligibility', () => {
  const interval = 4 * 60 * 60 * 1000;
  const decisionTime = Date.parse('2024-02-01T00:00:00.000Z');
  const makeRows = (symbol, quoteVolume) => Array.from({ length: 7 }, (_, index) => ({
    symbol,
    openTime: index === 0 ? decisionTime - 31 * 24 * 60 * 60 * 1000 : decisionTime - (7 - index) * interval,
    closeTime: decisionTime - (7 - index) * interval + interval - 1,
    quoteVolume
  })).map((row, index) => index === 6 ? { ...row, openTime: decisionTime, closeTime: decisionTime + interval - 1 } : row);
  const bars = Object.fromEntries([
    ['BTCUSDT', makeRows('BTCUSDT', 2_000_000)],
    ['AAAUSDT', makeRows('AAAUSDT', 3_000_000)],
    ['BBB', makeRows('BBB', 100_000)]
  ]);
  const indexes = Object.fromEntries(Object.entries(bars).map(([symbol, rows]) => [symbol, new Map(rows.map((row, index) => [row.openTime, index]))]));
  const snapshot = buildDynamicUniverse({ barsBySymbol: bars, indexesBySymbol: indexes, time: decisionTime, symbols: Object.keys(bars) });
  assert.deepEqual(snapshot.symbols.sort(), ['AAAUSDT', 'BTCUSDT']);
  assert.equal(snapshot.rows.find(row => row.symbol === 'BBB'), undefined);
  assert.equal(snapshot.rows[0].quoteVolumeUsdt, 18_000_000);
});

test('forming 4h candle cannot affect a 1h decision snapshot', () => {
  const closed = { id: 'closed', completedCloseTime: 3_599, regime: 'BEAR' };
  const forming = { id: 'forming', completedCloseTime: 7_199, regime: 'BULL' };
  const atDecision = selectCompletedFourHourSnapshot([closed, forming], 4_000);
  const afterFormingCandleChanges = selectCompletedFourHourSnapshot([
    closed,
    { ...forming, regime: 'SIDEWAYS', symbols: ['A'], rows: [{ quoteVolumeUsdt: 999_999_999 }] }
  ], 4_000);
  assert.equal(atDecision.id, 'closed');
  assert.equal(afterFormingCandleChanges.id, 'closed');
  assert.ok(atDecision.completedCloseTime <= 4_000);
});

test('family overlap accounting reconciles observations to unique slots', () => {
  const rows = [
    { symbol: 'BTCUSDT', signalTime: 1, side: 'BUY', family: 'TREND_BREAKOUT' },
    { symbol: 'BTCUSDT', signalTime: 1, side: 'BUY', family: 'PULLBACK_CONTINUATION' },
    { symbol: 'ETHUSDT', signalTime: 1, side: 'BUY', family: 'VOLATILITY_EXPANSION' }
  ];
  const stats = familyOverlapStats(rows);
  assert.equal(stats.uniqueCandidateSlots, 2);
  assert.equal(stats.familyOverlapSlots, 1);
  assert.equal(stats.oneFamily, 1);
  assert.equal(stats.twoFamilies, 1);
  assert.equal(stats.threeFamilies, 0);
  assert.equal(stats.pairwise.TREND_BREAKOUT_PLUS_PULLBACK, 1);
});
