import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

const DRAFT_PATH = 'artifacts/audits/HY-EXP-0024-preregistration-draft.json';
const FORMAL_PATH = 'registry/experiments/HY-EXP-0024/preregistration.json';
const EXPECTED_DRAFT_SHA256 = '0B43CC128101BF7DE635BB1CBF23406595DF4365BBA30EC30D90843C7A5E856A';
const EXPECTED_REGISTRY_HEAD = '99acf242bb9685ece7066f7a0bb503285f1b56872e25ed497634d187f3f12620';

function readDraft() {
  return JSON.parse(fs.readFileSync(DRAFT_PATH, 'utf8'));
}

function readFormal() {
  return JSON.parse(fs.readFileSync(FORMAL_PATH, 'utf8'));
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
}

function readLedger() {
  return fs.readFileSync('registry/ledger.jsonl', 'utf8')
    .trim()
    .split(/\r?\n/)
    .map(line => JSON.parse(line));
}

function syntheticDevelopmentDecision({ close, priorHigh, proxyOpen, exitPrice }) {
  const candidate = close > priorHigh
    ? { exists: true, side: 'BUY', regime: 'BULL', features: { close, priorHigh } }
    : { exists: false, side: null, regime: 'SIDEWAYS', features: { close, priorHigh } };
  const label = candidate.exists ? (exitPrice / proxyOpen - 1) * 10_000 : null;
  return { candidate, label };
}

function expectedFundingAtDecision({ side, latestPublishedRate, nextFundingTime, decisionTime, maxHoldMs }) {
  if (nextFundingTime > decisionTime + maxHoldMs) return 0;
  return (side === 'BUY' ? -1 : 1) * latestPublishedRate * 10_000;
}

function coverageOnlyExtension({ bullCandidates, bearCandidates }) {
  return bullCandidates >= 40 && bearCandidates >= 40
    ? 'UNLOCK_DAY90'
    : 'EXTEND_EXACTLY_90_DAYS';
}

function historicalDevelopmentNetEdge({ expectedPriceEdgeBps, expectedFundingBps, standardErrorBps, fundingStressBps, stressMultiplier = 1 }) {
  const expectedGrossEdgeBps = expectedPriceEdgeBps + expectedFundingBps;
  const totalExecutionCostBps = (10 + 4 + 2 + 2) * stressMultiplier;
  return {
    expectedGrossEdgeBps,
    expectedNetEdgeBps: expectedGrossEdgeBps - totalExecutionCostBps,
    conservativeNetEdgeBps: expectedGrossEdgeBps - totalExecutionCostBps - 1.645 * standardErrorBps - stressMultiplier * fundingStressBps,
    grossToCostRatio: expectedGrossEdgeBps / totalExecutionCostBps
  };
}

function historicalExecutionObservationAccepted({ theoreticalDecisionTime, openTime, delayMs }) {
  return openTime >= theoreticalDecisionTime + delayMs;
}

function schedulerClassification({ theoreticalDecisionTime, decisionTime, maximumDelayMs }) {
  return decisionTime - theoreticalDecisionTime > maximumDelayMs ? 'MISSED_SIGNAL' : 'ELIGIBLE';
}

function exactHistoricalEntry({ theoreticalDecisionTime, bars }) {
  const requiredOpenTime = theoreticalDecisionTime + 300_000;
  const row = bars.find(bar => bar.openTime === requiredOpenTime);
  return row ? { included: true, entryPrice: row.open } : { included: false, entryPrice: null };
}

function historicalFundingExpectation({ side, theoreticalDecisionTime, rows, maximumHoldMs = 6 * 60 * 60 * 1_000 }) {
  const pastRows = rows
    .filter(row => row.eventTime <= theoreticalDecisionTime)
    .sort((left, right) => left.eventTime - right.eventTime);
  const latest = pastRows.at(-1);
  if (!latest || !Number.isFinite(latest.fundingRate) || !Number.isFinite(latest.fundingIntervalHours) || latest.fundingIntervalHours <= 0) {
    return { usable: false, expectedFundingBps: null };
  }
  const nextFundingTimeProxy = latest.eventTime + latest.fundingIntervalHours * 60 * 60 * 1_000;
  if (nextFundingTimeProxy <= theoreticalDecisionTime) return { usable: false, expectedFundingBps: null };
  if (nextFundingTimeProxy > theoreticalDecisionTime + maximumHoldMs) return { usable: true, expectedFundingBps: 0 };
  return {
    usable: true,
    expectedFundingBps: (side === 'BUY' ? -1 : 1) * latest.fundingRate * 10_000,
    nextFundingTimeProxy
  };
}

function evaluatePostEntryStop({ side, stopPrice, entryTime, bars }) {
  for (const bar of bars.filter(candidate => candidate.openTime >= entryTime).sort((left, right) => left.openTime - right.openTime)) {
    if (side === 'BUY') {
      if (bar.open <= stopPrice) return { triggered: true, fill: bar.open, reason: 'GAP_OPEN' };
      if (bar.low <= stopPrice) return { triggered: true, fill: stopPrice, reason: 'INTRABAR' };
    } else {
      if (bar.open >= stopPrice) return { triggered: true, fill: bar.open, reason: 'GAP_OPEN' };
      if (bar.high >= stopPrice) return { triggered: true, fill: stopPrice, reason: 'INTRABAR' };
    }
  }
  return { triggered: false, fill: null, reason: null };
}

function sixthCompletedCloseAfterEntry({ entryTime, closes }) {
  return closes
    .filter(close => close.time > entryTime)
    .sort((left, right) => left.time - right.time)[5]?.time ?? null;
}

test('HY-EXP-0024 draft remains immutable and formal preregistration is separately registered', () => {
  const draft = readDraft();
  const formal = readFormal();
  const ledger = readLedger();
  assert.equal(draft.status, 'DRAFT_NOT_PREREGISTERED');
  assert.equal(draft.registryAppended, false);
  assert.equal(draft.developmentAllowed, false);
  assert.equal(draft.trainingAllowed, false);
  assert.equal(draft.backtestAllowed, false);
  assert.equal(draft.oosAllowed, false);
  assert.equal(draft.productionAllowed, false);
  assert.equal(draft.promotionEligible, false);
  assert.equal(draft.pnlComputed, false);
  assert.equal(sha256(DRAFT_PATH), EXPECTED_DRAFT_SHA256);
  assert.equal(formal.status, 'PREREGISTERED');
  assert.equal(formal.authorization, 'PAPER_ONLY');
  assert.equal(formal.signalOnly, true);
  assert.equal(formal.liveOrdersEnabled, false);
  assert.equal(formal.accountApi, false);
  assert.equal(formal.orderApi, false);
  assert.equal(formal.frozenSpecification.authoritative, true);
  assert.equal(formal.frozenSpecification.copyOrOverride, false);
  assert.equal(formal.frozenSpecification.sourceSha256, EXPECTED_DRAFT_SHA256);
  assert.equal(ledger.length, 80);
  assert.equal(ledger.at(-1).hash, EXPECTED_REGISTRY_HEAD);
  const events = ledger.filter(entry => entry.experiment_id === 'HY-EXP-0024');
  assert.equal(events.length, 2);
  assert.equal(events[0].event_type, 'preregistered');
  assert.equal(events[0].payload_path, FORMAL_PATH);
  assert.equal(events[1].event_type, 'failed');
  assert.equal(events[1].payload_path, 'artifacts/HY-EXP-0024/closure.json');
});

test('HY-EXP-0024 primary universe, regime, direction and candidate family are frozen', () => {
  const primary = readDraft().primaryModel;
  assert.deepEqual(primary.universe.symbols, [
    'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT',
    'XRPUSDT', 'DOGEUSDT', 'LINKUSDT', 'LTCUSDT'
  ]);
  assert.equal(primary.universe.market, 'Binance USD-M');
  assert.equal(primary.universe.quoteAsset, 'USDT');
  assert.equal(primary.universe.contractType, 'PERPETUAL');
  assert.equal(primary.universe.breadth.primaryFraction, 2 / 3);
  assert.equal(primary.universe.breadth.formula, 'ceil(eligibleSymbols * 2/3)');
  assert.equal(primary.universe.breadth.sensitivityOnlyFraction, 0.5);
  assert.equal(primary.regime.btcFastSmaBars, 60);
  assert.equal(primary.regime.btcSlowSmaBars, 180);
  assert.equal(primary.direction.bull, 'BUY only');
  assert.equal(primary.direction.bear, 'SELL only');
  assert.equal(primary.direction.counterTrend, 'Forbidden in the primary model');
  assert.equal(primary.candidate.family, 'TREND_BREAKOUT');
  assert.equal(primary.candidate.referenceWindowExcludesBreakoutBar, true);
  assert.equal(primary.candidate.exploratoryFamilies.PULLBACK_CONTINUATION, 'EXPLORATORY_ONLY; NOT_PRIMARY; NOT_PROMOTION_ELIGIBLE');
  assert.equal(primary.candidate.exploratoryFamilies.VOLATILITY_EXPANSION, 'EXPLORATORY_ONLY; NOT_PRIMARY; NOT_PROMOTION_ELIGIBLE');
});

test('HY-EXP-0024 draft freezes causal timing, executable entry and exact exit', () => {
  const { causality, entry, exit } = readDraft().primaryModel;
  const { historicalDevelopmentExecutionProxy } = entry;
  assert.equal(causality.forming4hUse, false);
  assert.equal(causality.regimeSnapshotRule.includes('completedCloseTime <= decisionTime'), true);
  assert.equal(entry.maximumScannerDelayMs, 900000);
  assert.equal(entry.delayRule.includes('MISSED_SIGNAL'), true);
  assert.equal(entry.executableReference.entryPrice.includes('never a 1h/4h bar open'), true);
  assert.equal(entry.executableReference.maximumBookAgeMs, 1000);
  assert.equal(historicalDevelopmentExecutionProxy.name, 'HISTORICAL_5M_EXECUTION_PROXY');
  assert.equal(historicalDevelopmentExecutionProxy.entryPrice.includes('5m bar OPEN'), true);
  assert.equal(historicalDevelopmentExecutionProxy.classification.includes('NOT_L2'), true);
  assert.equal(historicalDevelopmentExecutionProxy.classification.includes('DEVELOPMENT_ONLY'), true);
  assert.equal(historicalDevelopmentExecutionProxy.historicalExecutionDelayProxyMs, 300000);
  assert.equal(historicalDevelopmentExecutionProxy.requiredExecutionOpenTime, 'theoreticalDecisionTime + 300000ms');
  assert.equal(historicalDevelopmentExecutionProxy.laterBarRescueForbidden, true);
  assert.equal(historicalDevelopmentExecutionProxy.historicalNextBarLookahead, false);
  assert.equal(entry.historicalExecutionRule.includes('exact archived 5m observation'), true);
  assert.equal(entry.noRetroactiveAdvisory, true);
  assert.equal(exit.atrBars, 20);
  assert.equal(exit.channelBars, 60);
  assert.equal(exit.maximumHoldBars, 6);
  assert.equal(exit.terminalExit.includes('sixth completed 1h bar'), true);
  assert.equal(exit.researchExpirySeparation.includes('never substitutes'), true);
});

test('HY-EXP-0024 draft has two candidate-level ridge cells and gross-only edge semantics', () => {
  const { edgeTarget, edgeModel, costs } = readDraft().primaryModel;
  assert.equal(edgeTarget.name, 'GROSS_DIRECTIONAL_PRICE_RETURN_BPS');
  assert.equal(edgeTarget.invariant, 'EDGE_TARGET_MUST_EXCLUDE_NET_EDGE_COST_COMPONENTS');
  assert.equal(edgeTarget.noDoubleCounting, true);
  assert.equal(edgeModel.method.startsWith('Ridge regression'), true);
  assert.equal(edgeModel.primaryLambda, 1);
  assert.deepEqual(edgeModel.sensitivityLambdas, [0.1, 1, 10]);
  assert.deepEqual(edgeModel.modelCells, ['BULL/BUY/TREND_BREAKOUT', 'BEAR/SELL/TREND_BREAKOUT']);
  assert.equal(edgeModel.pooledMeanForbidden, true);
  assert.equal(edgeModel.minimumTrainingSamplesPerCell, 100);
  assert.equal(edgeModel.featureTransform.targetTransform, 'No target winsorization or normalization; target remains bps.');
  assert.deepEqual(edgeModel.featuresInOrder, [
    'sideAdjustedBreakoutDistanceOverATR20',
    'sideAdjustedTrendStrengthOverATR20',
    'sideAdjustedSMA60MinusSMA180OverATR20',
    'regimeBreadthFraction',
    'eligibleSymbolCountOverEight',
    'log1pPriorSixCompleted4hQuoteVolume',
    'ATR20OverClose',
    'sideAdjustedPrior60ChannelDistanceOverATR20'
  ]);
  assert.equal(edgeModel.featureParity.primaryFeaturesReproducibleInHistoricalDevelopment, true);
  assert.equal(edgeModel.featureParity.fundingOutsideEdgeModel, true);
  assert.equal(edgeModel.featureParity.spreadBookOutsideEdgeModel, true);
  assert.equal(edgeModel.featureParity.schedulerDelayOutsideEdgeModel, true);
  assert.deepEqual(edgeModel.featureParity.forbiddenPrimaryFeatures, [
    'latestKnownFundingRateBps',
    'bookSpreadBps',
    'schedulerDelayFractionOf15Minutes'
  ]);
  assert.equal(costs.engine.includes('HENGYU-NET-EDGE-001'), true);
  assert.equal(costs.engine.includes('Prospective Final OOS'), true);
  assert.equal(costs.fundingDoubleCount, false);
});

test('Historical Development Net Edge uses a fixed non-book proxy and Final OOS uses real Net Edge', () => {
  const draft = readDraft();
  const proxy = draft.primaryModel.costs.historicalDevelopmentNetEdgeProxy;
  assert.deepEqual(proxy.baseCostsBps, {
    feeBps: 10,
    spreadAndBookProxyBps: 4,
    impactBps: 2,
    latencyBps: 2,
    totalExecutionCostBps: 18
  });
  assert.deepEqual(proxy.evidenceClass, ['DEVELOPMENT_ONLY', 'NOT_L2', 'NOT_EXACT_EXECUTION', 'NOT_PROMOTION_EVIDENCE_BY_ITSELF']);
  assert.equal(proxy.fabricatedHistoricalBook, false);
  const base = historicalDevelopmentNetEdge({ expectedPriceEdgeBps: 50, expectedFundingBps: 1, standardErrorBps: 2, fundingStressBps: 0.5 });
  const stressed = historicalDevelopmentNetEdge({ expectedPriceEdgeBps: 50, expectedFundingBps: 1, standardErrorBps: 2, fundingStressBps: 0.5, stressMultiplier: 1.5 });
  assert.deepEqual(base, {
    expectedGrossEdgeBps: 51,
    expectedNetEdgeBps: 33,
    conservativeNetEdgeBps: 29.21,
    grossToCostRatio: 51 / 18
  });
  assert.deepEqual(stressed, {
    expectedGrossEdgeBps: 51,
    expectedNetEdgeBps: 24,
    conservativeNetEdgeBps: 19.96,
    grossToCostRatio: 51 / 27
  });
  assert.equal(stressed.expectedNetEdgeBps < base.expectedNetEdgeBps, true);
  assert.equal(proxy.thresholds.minimumConservativeNetBps, 3);
  assert.equal(proxy.thresholds.minimumGrossToCostRatio, 1.5);
  assert.equal(draft.prospectiveFinalOos.execution.netEdgeEngine, 'HENGYU-NET-EDGE-001');
  assert.equal(draft.prospectiveFinalOos.execution.requiresRealCausalBook, true);
  assert.equal(draft.prospectiveFinalOos.execution.historicalDevelopmentNetEdgeProxyAllowed, false);
  assert.equal(draft.safetyInvariants.DEVELOPMENT_NET_EDGE_PROXY_NEVER_USED_IN_FINAL_OOS, true);
});

test('HY-EXP-0024 draft freezes development folds, gates and fail-closed OOS firewall', () => {
  const draft = readDraft();
  const development = draft.development;
  assert.equal(development.window.start, '2024-01-01T00:00:00.000Z');
  assert.equal(development.window.endExclusive, '2026-07-01T00:00:00.000Z');
  assert.equal(development.dataSources.bars.includes('contract-price'), true);
  assert.equal(development.dataSources.depth.includes('No historical full-L2'), true);
  assert.equal(development.walkForward.initialTrainingWindow, 'At least 12 calendar months');
  assert.equal(development.walkForward.validationBlock, '3 calendar months');
  assert.equal(development.walkForward.step, '3 calendar months');
  assert.equal(development.walkForward.purgeBars, 6);
  assert.equal(development.walkForward.embargoBars, 6);
  assert.equal(development.walkForward.folds.length, 6);
  assert.equal(development.walkForward.folds.at(-1).validationEndExclusive, development.window.endExclusive);

  const dev = draft.gates.development;
  const oos = draft.gates.finalOos;
  assert.equal(dev.advisoryCountMin, 220);
  assert.equal(dev.monthlyAdvisoryRatePer30dMin, 12);
  assert.equal(dev.bullBuyAdvisoryCountMin, 72);
  assert.equal(dev.bearSellAdvisoryCountMin, 72);
  assert.equal(dev.netExpectancyBpsMinBase, 8);
  assert.equal(dev.costStress1_5x.netExpectancyBpsMin, 3);
  assert.equal(oos.advisoryCountMin, 36);
  assert.equal(oos.monthlyAdvisoryRatePer30dMin, 12);
  assert.equal(oos.bullBuyAdvisoryCountMin, 12);
  assert.equal(oos.bearSellAdvisoryCountMin, 12);
  assert.equal(oos.netExpectancyBpsMinBase, 6);
  assert.equal(oos.costStress1_5x.netExpectancyBpsMin, 2);
  assert.equal(dev.lambdaStability.selectionAfterOutcomes, false);
  assert.equal(oos.lambdaStability.selectionAfterOutcomes, false);

  const oosFirewall = draft.prospectiveFinalOos;
  assert.equal(oosFirewall.startResolution.developmentPassRequired, true);
  assert.equal(oosFirewall.startResolution.edgeModelArtifactLockRequired, true);
  assert.equal(oosFirewall.startResolution.earlyStartForbidden, true);
  assert.equal(oosFirewall.startResolution.endExclusive.includes('180'), true);
  assert.deepEqual(oosFirewall.dataWorkflow.beforeDevelopmentPass, ['write', 'hash', 'integrity_check']);
  assert.equal(oosFirewall.dataWorkflow.unknownOperation, 'Reject');
  assert.equal(oosFirewall.dataWorkflow.accessClasses.ONLINE_INFERENCE_INPUT.allowedDuringOos, true);
  assert.equal(oosFirewall.dataWorkflow.accessClasses.ONLINE_DECISION_OUTPUT.allowedDuringOos, true);
  assert.equal(oosFirewall.dataWorkflow.accessClasses.SEALED_OUTCOME_EVALUATION.allowedBeforeUnlock, false);
  assert.equal(oosFirewall.coverageOnlyExtension.perCellMinimumEdgeAvailableCandidates, 40);
  assert.equal(oosFirewall.coverageOnlyExtension.maximumOosDays, 180);
  assert.equal(draft.gates.failureAction.includes('Final OOS unreadable'), true);
});

test('historical 5m proxy changes only the post-decision label, never candidate creation', () => {
  const first = syntheticDevelopmentDecision({ close: 110, priorHigh: 100, proxyOpen: 100, exitPrice: 101 });
  const second = syntheticDevelopmentDecision({ close: 110, priorHigh: 100, proxyOpen: 105, exitPrice: 101 });
  assert.deepEqual(second.candidate, first.candidate);
  assert.notEqual(second.label, first.label);
  assert.equal(readDraft().primaryModel.entry.historicalDevelopmentExecutionProxy.cannotAffect.includes('candidate existence'), true);
  assert.equal(readDraft().development.executionProxy.developmentOnly, true);
  assert.equal(readDraft().development.executionProxy.notL2, true);
});

test('historical entry waits five minutes while live delay above fifteen minutes misses the signal', () => {
  const draft = readDraft();
  const theoreticalDecisionTime = Date.parse('2026-01-01T00:00:00.000Z');
  assert.equal(historicalExecutionObservationAccepted({ theoreticalDecisionTime, openTime: theoreticalDecisionTime + 299_999, delayMs: 300_000 }), false);
  assert.equal(historicalExecutionObservationAccepted({ theoreticalDecisionTime, openTime: theoreticalDecisionTime + 300_000, delayMs: 300_000 }), true);
  assert.equal(draft.development.executionProxy.historicalExecutionDelayProxyMs, 300000);
  assert.equal(draft.development.executionProxy.selection.includes('openTime === requiredExecutionOpenTime'), true);
  assert.equal(schedulerClassification({ theoreticalDecisionTime, decisionTime: theoreticalDecisionTime + 900_001, maximumDelayMs: draft.primaryModel.entry.maximumScannerDelayMs }), 'MISSED_SIGNAL');
  assert.equal(draft.primaryModel.entry.maximumScannerDelayMs, 900000);
});

test('historical entry requires the exact +5m bar and never rescues with a later bar', () => {
  const theoreticalDecisionTime = Date.parse('2026-01-01T00:00:00.000Z');
  const missingExact = exactHistoricalEntry({
    theoreticalDecisionTime,
    bars: [{ openTime: theoreticalDecisionTime + 600_000, open: 105 }]
  });
  const exact = exactHistoricalEntry({
    theoreticalDecisionTime,
    bars: [
      { openTime: theoreticalDecisionTime + 600_000, open: 105 },
      { openTime: theoreticalDecisionTime + 300_000, open: 101 }
    ]
  });
  assert.deepEqual(missingExact, { included: false, entryPrice: null });
  assert.deepEqual(exact, { included: true, entryPrice: 101 });
  const proxy = readDraft().development.executionProxy;
  assert.equal(proxy.requiredExecutionOpenTime, 'theoreticalDecisionTime + 300000ms');
  assert.equal(proxy.laterBarRescue, false);
  assert.equal(readDraft().safetyInvariants.HISTORICAL_ENTRY_LATER_BAR_RESCUE_FORBIDDEN, true);
});

test('historical funding expectation uses only the latest past row and fails closed on bad schedules', () => {
  const theoreticalDecisionTime = Date.parse('2026-01-01T00:00:00.000Z');
  const pastRow = { eventTime: theoreticalDecisionTime - 2 * 60 * 60 * 1_000, fundingIntervalHours: 4, fundingRate: 0.0002 };
  const futureRow = { eventTime: theoreticalDecisionTime + 2 * 60 * 60 * 1_000, fundingIntervalHours: 4, fundingRate: 0.0099 };
  const expectedWithoutFuture = historicalFundingExpectation({ side: 'BUY', theoreticalDecisionTime, rows: [pastRow] });
  const expectedWithFuture = historicalFundingExpectation({ side: 'BUY', theoreticalDecisionTime, rows: [pastRow, futureRow] });
  assert.deepEqual(expectedWithFuture, expectedWithoutFuture);
  assert.equal(expectedWithFuture.expectedFundingBps, -2);
  assert.equal(historicalFundingExpectation({ side: 'SELL', theoreticalDecisionTime, rows: [pastRow] }).expectedFundingBps, 2);
  assert.equal(historicalFundingExpectation({ side: 'BUY', theoreticalDecisionTime, rows: [{ ...pastRow, fundingIntervalHours: 9 }] }).expectedFundingBps, 0);
  assert.equal(historicalFundingExpectation({ side: 'BUY', theoreticalDecisionTime, rows: [{ ...pastRow, fundingIntervalHours: 0 }] }).usable, false);
  assert.equal(historicalFundingExpectation({ side: 'BUY', theoreticalDecisionTime, rows: [] }).usable, false);
  const proxy = readDraft().primaryModel.fundingCausality.historicalDevelopmentFundingExpectationProxy;
  assert.equal(proxy.futureFundingRateRead, false);
  assert.equal(proxy.classification.includes('NOT_LIVE_FUNDING_FORECAST'), true);
  assert.equal(readDraft().safetyInvariants.noFutureFundingRowRateForHistoricalExpectation, true);
});

test('stop labels use post-entry 5m bars, conservative gap fills, and shared OOS semantics', () => {
  const entryTime = Date.parse('2026-01-01T00:05:00.000Z');
  const buyStop = 100;
  const buyBars = [
    { openTime: entryTime - 300_000, open: 99, low: 95, high: 101 },
    { openTime: entryTime, open: 102, low: 99, high: 103 },
    { openTime: entryTime + 300_000, open: 98, low: 97, high: 99 }
  ];
  assert.deepEqual(evaluatePostEntryStop({ side: 'BUY', stopPrice: buyStop, entryTime, bars: buyBars }), { triggered: true, fill: 100, reason: 'INTRABAR' });
  assert.deepEqual(evaluatePostEntryStop({ side: 'BUY', stopPrice: buyStop, entryTime, bars: [{ openTime: entryTime, open: 99, low: 98, high: 101 }] }), { triggered: true, fill: 99, reason: 'GAP_OPEN' });
  assert.deepEqual(evaluatePostEntryStop({ side: 'SELL', stopPrice: 100, entryTime, bars: [{ openTime: entryTime, open: 101, low: 99, high: 102 }] }), { triggered: true, fill: 101, reason: 'GAP_OPEN' });
  assert.deepEqual(evaluatePostEntryStop({ side: 'SELL', stopPrice: 100, entryTime, bars: [{ openTime: entryTime, open: 98, low: 97, high: 101 }] }), { triggered: true, fill: 100, reason: 'INTRABAR' });
  const exit = readDraft().primaryModel.exit;
  assert.equal(exit.stopMonitoring.startsAt, 'entryTime inclusive');
  assert.equal(exit.stopMonitoring.preEntryPricesUsed, false);
  assert.equal(exit.stopMonitoring.noPreEntryContainingHour, true);
  assert.equal(exit.channelMonitoring.completed1hCloseOnly, true);
  assert.equal(exit.channelMonitoring.referenceExcludesCurrentBar, true);
  assert.equal(exit.sameBarPrecedence.includes('stop fill is applied first'), true);
  assert.equal(sixthCompletedCloseAfterEntry({ entryTime, closes: Array.from({ length: 6 }, (_, index) => ({ time: entryTime + (index + 1) * 60 * 60 * 1_000 })) }), entryTime + 6 * 60 * 60 * 1_000);
  assert.equal(exit.prospectiveOosUsesIdenticalLabelSemantics, true);
  assert.equal(readDraft().prospectiveFinalOos.execution.labelSemantics.includes('same frozen outcome definitions'), true);
  assert.equal(readDraft().safetyInvariants.historicalStopUsesPostEntry5mOnly, true);
  assert.equal(readDraft().safetyInvariants.channelReferenceExcludesCurrent1hBar, true);
  assert.equal(readDraft().safetyInvariants.terminalExitSixthCompleted1hCloseAfterEntry, true);
});

test('expected funding is decision-time only and realized funding is outcome-only', () => {
  const draft = readDraft();
  const funding = draft.primaryModel.fundingCausality;
  const decisionTime = Date.parse('2026-01-01T00:00:00.000Z');
  const nextFundingTime = Date.parse('2026-01-01T04:00:00.000Z');
  const first = expectedFundingAtDecision({ side: 'BUY', latestPublishedRate: 0.0001, nextFundingTime, decisionTime, maxHoldMs: 6 * 60 * 60 * 1_000 });
  const second = expectedFundingAtDecision({ side: 'BUY', latestPublishedRate: 0.0001, nextFundingTime, decisionTime, maxHoldMs: 6 * 60 * 60 * 1_000 });
  assert.equal(first, second);
  assert.equal(funding.expectedFundingBps.futureRealizedRateRead, false);
  assert.equal(funding.realizedFundingBps.candidateInput, false);
  assert.equal(funding.realizedFundingBps.netEdgeDecisionInput, false);
  assert.equal(funding.leakageRule.includes('future realized funding'), true);
});

test('OOS extension decision uses coverage only and calibration is pre-Net-Edge', () => {
  const draft = readDraft();
  assert.equal(coverageOnlyExtension({ bullCandidates: 40, bearCandidates: 40 }), 'UNLOCK_DAY90');
  assert.equal(coverageOnlyExtension({ bullCandidates: 1000, bearCandidates: 39 }), 'EXTEND_EXACTLY_90_DAYS');
  assert.equal(coverageOnlyExtension({ bullCandidates: 40, bearCandidates: 40, pnl: -1_000_000, pf: 0 }), 'UNLOCK_DAY90');
  assert.equal(draft.gates.measurementDefinitions.calibrationPopulation.includes('before Net Edge and Portfolio Risk filtering'), true);
  assert.equal(draft.gates.development.calibrationMinimumValidationSamplesPerCell, 100);
  assert.equal(draft.gates.finalOos.calibrationMinimumValidationSamplesPerCell, 40);
  assert.equal(draft.gates.development.modelMAEOverZeroEdgeBaselineMax, 0.95);
  assert.equal(draft.gates.development.modelRMSEOverZeroEdgeBaselineMax, 0.98);
  assert.equal(draft.gates.finalOos.modelMAEOverZeroEdgeBaselineMax, 1);
  assert.equal(draft.gates.finalOos.modelRMSEOverZeroEdgeBaselineMax, 1);
});

test('HY-EXP-0024 draft preserves paper-only delivery and historical experiment boundaries', () => {
  const draft = readDraft();
  assert.equal(draft.safetyInvariants.PAPER_ONLY, true);
  assert.equal(draft.safetyInvariants.SIGNAL_ONLY, true);
  assert.equal(draft.safetyInvariants.accountApi, false);
  assert.equal(draft.safetyInvariants.orderApi, false);
  assert.equal(draft.safetyInvariants.noProductionH12Change, true);
  assert.equal(draft.safetyInvariants.noGmailDeliveryChange, true);
  assert.equal(draft.safetyInvariants.noCurrentExchangeInfoBackfill, true);
  assert.equal(draft.safetyInvariants.noFutureRealizedFundingDecisionInput, true);
  assert.equal(draft.safetyInvariants.oosOnlineInferenceAllowed, true);
  assert.equal(draft.safetyInvariants.oosOutcomeEvaluationSealed, true);
  assert.equal(draft.experimentIsolation['HY-EXP-0023'].mustNotBeModified, true);
  assert.equal(draft.reviewRequired.preregistrationCommitMustBeSeparate, true);
});
