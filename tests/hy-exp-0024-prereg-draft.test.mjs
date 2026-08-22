import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const DRAFT_PATH = 'artifacts/audits/HY-EXP-0024-preregistration-draft.json';
const EXPECTED_REGISTRY_HEAD = '2fad0c8968251456f59167adf42a6c387a3fdaa0ca4071933712800fff551b91';

function readDraft() {
  return JSON.parse(fs.readFileSync(DRAFT_PATH, 'utf8'));
}

function readLedger() {
  return fs.readFileSync('registry/ledger.jsonl', 'utf8')
    .trim()
    .split(/\r?\n/)
    .map(line => JSON.parse(line));
}

test('HY-EXP-0024 draft is not preregistered and leaves registry unchanged', () => {
  const draft = readDraft();
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
  assert.equal(ledger.length, 78);
  assert.equal(ledger.at(-1).hash, EXPECTED_REGISTRY_HEAD);
  assert.equal(ledger.filter(entry => entry.experiment_id === 'HY-EXP-0024').length, 0);
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
  assert.equal(causality.forming4hUse, false);
  assert.equal(causality.regimeSnapshotRule.includes('completedCloseTime <= decisionTime'), true);
  assert.equal(entry.maximumScannerDelayMs, 900000);
  assert.equal(entry.delayRule.includes('MISSED_SIGNAL'), true);
  assert.equal(entry.executableReference.entryPrice.includes('never a 1h/4h bar open'), true);
  assert.equal(entry.executableReference.maximumBookAgeMs, 1000);
  assert.equal(entry.historicalNextBarLookahead, false);
  assert.equal(entry.historicalExecutionRule.includes('next bar'), true);
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
  assert.equal(costs.engine.includes('HENGYU-NET-EDGE-001'), true);
  assert.equal(costs.fundingDoubleCount, false);
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
  assert.equal(oosFirewall.startResolution.endExclusive, 'oosStart + 90 * 24 hours');
  assert.deepEqual(oosFirewall.dataWorkflow.beforeDevelopmentPass, ['write', 'hash', 'integrity_check']);
  assert.equal(oosFirewall.dataWorkflow.unknownOperation, 'Reject');
  assert.equal(draft.gates.failureAction.includes('Final OOS unreadable'), true);
});

test('HY-EXP-0024 draft preserves paper-only delivery and historical experiment boundaries', () => {
  const draft = readDraft();
  assert.equal(draft.safetyInvariants.PAPER_ONLY, true);
  assert.equal(draft.safetyInvariants.SIGNAL_ONLY, true);
  assert.equal(draft.safetyInvariants.accountApi, false);
  assert.equal(draft.safetyInvariants.orderApi, false);
  assert.equal(draft.safetyInvariants.noProductionH12Change, true);
  assert.equal(draft.safetyInvariants.noGmailDeliveryChange, true);
  assert.equal(draft.experimentIsolation['HY-EXP-0023'].mustNotBeModified, true);
  assert.equal(draft.reviewRequired.preregistrationCommitMustBeSeparate, true);
});
