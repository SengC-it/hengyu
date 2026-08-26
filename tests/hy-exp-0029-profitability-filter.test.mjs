import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COST_BPS,
  FEATURE_NAMES,
  SOURCE_ARTIFACT_SHA256,
  analyzeFrozenHoldout,
  extractPreEntryFeatures,
  loadFrozenHoldout,
  validatePortfolioRiskEvidence
} from '../src/research/hy-exp-0029-profitability-filter.mjs';

test('HY-EXP-0029 binds to the immutable HY-EXP-0028 holdout and never reads Final OOS', () => {
  const source = loadFrozenHoldout();
  assert.equal(source.sha256, SOURCE_ARTIFACT_SHA256);
  assert.equal(source.artifact.experimentId, 'HY-EXP-0028');
  assert.equal(source.artifact.status, 'HOLDOUT_FAILED');
  assert.equal(source.artifact.finalOosRead, false);
  assert.equal(source.artifact.finalOosPnlComputed, false);
});

test('HY-EXP-0029 feature extraction is causal and independent of outcome fields', () => {
  const { artifact } = loadFrozenHoldout();
  const original = artifact.trades[0];
  const mutated = {
    ...original,
    exitTime: original.exitTime + 86400000,
    exitPrice: original.exitPrice * 2,
    exitReason: 'COUNTERFACTUAL',
    net18Bps: 99999,
    netPnl: 99999,
    realizedFundingBps: -99999,
    maeBps: -99999,
    mfeBps: 99999
  };
  assert.deepEqual(extractPreEntryFeatures(original), extractPreEntryFeatures(mutated));
  assert.deepEqual(FEATURE_NAMES, [
    'channelDistanceOverFrozenQ75',
    'regimeBull',
    'sideBuy',
    'decisionHourSin',
    'decisionHourCos'
  ]);
});

test('purged walk-forward fails closed when the frozen sample cannot supply causal training rows', () => {
  const result = analyzeFrozenHoldout();
  assert.equal(result.oof.predictionCount, 0);
  assert.equal(result.oof.acceptedCount, 0);
  assert.equal(result.oof.noOofCount, 43);
  assert.ok(result.oof.folds.every(fold => fold.fit === 'INSUFFICIENT_TRAINING_ROWS'));
  assert.equal(result.filteredMetrics.riskMetricStatus, 'EMPTY_SAMPLE_NOT_EVALUABLE');
  assert.equal(result.researchGate.edgeUncertainty, 'EDGE_UNCERTAIN');
  assert.equal(result.researchGate.portfolioRiskRequired, true);
  assert.equal(result.researchGate.portfolioRiskStatus, 'NOT_RECONSTRUCTED');
  assert.ok(result.researchGate.reasons.includes('PORTFOLIO_MTM_NOT_RECONSTRUCTED'));
  assert.ok(result.researchGate.reasons.includes('PORTFOLIO_CVAR_NOT_RECONSTRUCTED'));
  assert.equal(result.promotionEligible, false);
});

test('HY-EXP-0029 separates source-reported portfolio risk from derived trade-level proxies', () => {
  const result = analyzeFrozenHoldout();
  assert.equal(result.baselineMetrics.maxMtmDrawdownFraction, 0.07723556081371896);
  assert.equal(result.baselineMetrics.maxMtmDrawdownSource, 'HY-EXP-0028 frozen portfolio risk evidence');
  assert.equal(result.baselineDerivedMetrics.maxSingleTradeAdverseExcursionFraction, 0.01289062499999999);
  assert.equal(Object.hasOwn(result.baselineDerivedMetrics, 'maxMtmDrawdownFraction'), false);
  assert.equal(result.baselineDerivedMetrics.portfolioMtmDrawdownFraction, null);
  assert.equal(result.baselineDerivedMetrics.portfolioMtmStatus, 'NOT_RECONSTRUCTED');
  assert.equal(result.baselineDerivedMetrics.tradeLossCvar95Bps, 628.6667169247434);
  assert.equal(result.baselineDerivedMetrics.portfolioCvar95, null);
  assert.equal(result.baselineDerivedMetrics.portfolioCvarStatus, 'NOT_RECONSTRUCTED');
  assert.equal(Object.hasOwn(result.baselineDerivedMetrics, 'cvar95LossBps'), false);
  assert.equal(Object.hasOwn(result.bootstrap.baseline.metrics, 'maxMtmDrawdownFraction'), false);
  assert.ok(Object.hasOwn(result.bootstrap.baseline.metrics, 'maxSingleTradeAdverseExcursionFraction'));
});

test('portfolio DD and CVaR absence fails closed instead of accepting single-trade proxies', () => {
  assert.deepEqual(validatePortfolioRiskEvidence({
    maxSingleTradeAdverseExcursionFraction: 0.01,
    tradeLossCvar95Bps: 100
  }), {
    eligible: false,
    status: 'NOT_RECONSTRUCTED',
    reasons: ['PORTFOLIO_MTM_NOT_RECONSTRUCTED', 'PORTFOLIO_CVAR_NOT_RECONSTRUCTED']
  });
  assert.deepEqual(validatePortfolioRiskEvidence({
    portfolioMtmDrawdownFraction: 0.04,
    portfolioMtmStatus: 'RECONSTRUCTED',
    portfolioCvar95: 0.02,
    portfolioCvarStatus: 'RECONSTRUCTED'
  }), {
    eligible: true,
    status: 'RECONSTRUCTED',
    reasons: []
  });
});

test('base, stress and severe-stress edge projections preserve the preregistered cost deltas', () => {
  const result = analyzeFrozenHoldout();
  assert.equal(COST_BPS.base, 18);
  assert.equal(COST_BPS.stress, 27);
  assert.equal(COST_BPS.severe, 36);
  assert.ok(Math.abs(result.baselineMetrics.net27ExpectancyBps - (result.baselineMetrics.net18ExpectancyBps - 9)) < 1e-10);
  assert.ok(Math.abs(result.baselineMetrics.net36ExpectancyBps - (result.baselineMetrics.net18ExpectancyBps - 18)) < 1e-10);
  assert.ok(result.baselineMetrics.net18ExpectancyBps > 0);
  assert.ok(result.baselineMetrics.net27ExpectancyBps < 0);
  assert.ok(result.baselineMetrics.net36ExpectancyBps < 0);
});

test('HY-EXP-0029 reports frozen failure decomposition without post-outcome filtering', () => {
  const result = analyzeFrozenHoldout();
  assert.equal(result.sourceArtifactSha256, SOURCE_ARTIFACT_SHA256);
  assert.equal(result.baselineMetrics.candidateCount, 43);
  assert.equal(result.baselineMetrics.advisoryCount, 43);
  assert.equal(result.rootCauseAnalysis.exitReason.ATR_STOP.count, 15);
  assert.equal(result.rootCauseAnalysis.exitReason.TERMINAL_EXIT.count, 28);
  assert.equal(result.rootCauseAnalysis.regime.BULL.count, 43);
  assert.equal(result.rootCauseAnalysis.side.BUY.count, 43);
  assert.equal(result.rootCauseAnalysis.fundingImpact.negativeFundingRows > 0, true);
  assert.equal(result.promotionEligible, false);
  assert.equal(result.freshHoldoutCreated, false);
});

test('HY-EXP-0029 safety envelope is permanently paper-only', () => {
  const result = analyzeFrozenHoldout();
  assert.deepEqual(result.safety, {
    signalOnly: true,
    paperOnly: true,
    liveOrdersEnabled: false,
    accountApi: false,
    orderApi: false,
    automaticTrading: false,
    gmailSendEnabled: false,
    schedulerActivated: false,
    realEmailSent: false,
    finalOosRead: false
  });
});
