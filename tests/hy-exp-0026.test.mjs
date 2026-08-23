import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  HY_EXP_0026_EDGE_MODEL_ID,
  fitHyExp0026EdgeDiagnostics,
  predictHyExp0026EdgeDiagnostics
} from '../src/model/hy-exp-0026-rule.mjs';

const PREREG_PATH = 'registry/experiments/HY-EXP-0026/preregistration.json';
const RESULT_PATH = 'artifacts/HY-EXP-0026/development-result.json';
const MANIFEST_PATH = 'artifacts/HY-EXP-0026/development-manifest.json';
const CLOSURE_PATH = 'artifacts/HY-EXP-0026/closure.json';
const OLD_0025_RESULT_PATH = 'artifacts/HY-EXP-0025/development-result.json';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function syntheticRow(feature, gross, month) {
  return {
    id: `${month}:${feature}:${gross}`,
    signalTime: Date.parse(`${month}-01T00:00:00.000Z`),
    features: [0, 0, 0, 0, 0, 0, 0, feature],
    label: { grossPriceReturnBps: gross }
  };
}

test('HY-EXP-0026 preregistration freezes the rule and removes the per-signal uncertainty veto', () => {
  const prereg = readJson(PREREG_PATH);
  assert.equal(sha256File(PREREG_PATH), '4b2f94db67b51ddd3cf1734371643f25ea4f2ba1212425abfdf97fc50e59a46f');
  assert.equal(prereg.status, 'PREREGISTERED');
  assert.equal(prereg.authorization, 'PAPER_ONLY');
  assert.equal(prereg.signalOnly, true);
  assert.equal(prereg.liveOrdersEnabled, false);
  assert.equal(prereg.accountApi, false);
  assert.equal(prereg.orderApi, false);
  assert.equal(prereg.oosRead, false);
  assert.equal(prereg.primaryHypothesis.direction, 'BULL/BUY/TREND_BREAKOUT');
  assert.equal(prereg.primaryHypothesis.bearSellAllowed, false);
  assert.equal(prereg.primaryHypothesis.ridgeAllowed, false);
  assert.equal(prereg.q75Protocol.global0024Q4CutpointAllowed, false);
  assert.equal(prereg.q75Protocol.validationUsesFrozenTrainingQ75, true);
  assert.equal(prereg.ruleAdvisorySemantics.perSignalUncertaintyVeto, false);
  assert.equal(prereg.ruleAdvisorySemantics.conservativeNetEdgeVeto, false);
  assert.equal(prereg.edgeDiagnostics.minimumTrainingSamples, 20);
  assert.equal(prereg.development.walkForward.folds.length, 6);
});

test('HY-EXP-0026 empirical edge is diagnostic only and preserves candidate advisory eligibility', () => {
  const rows = [
    syntheticRow(3.25, 30, '2024-03'),
    syntheticRow(4, 40, '2024-04')
  ];
  const model = fitHyExp0026EdgeDiagnostics(rows, { q75: 3.25, minimumSamples: 1 });
  assert.equal(model.edgeModelId, HY_EXP_0026_EDGE_MODEL_ID);
  assert.equal(model.trainingQ75, 3.25);
  assert.equal(model.sampleSize, 2);
  const prediction = predictHyExp0026EdgeDiagnostics(model, rows[1]);
  assert.equal(prediction.available, true);
  assert.equal(prediction.edgeModelId, HY_EXP_0026_EDGE_MODEL_ID);
  assert.equal(prediction.expectedPriceEdgeBps, 35);
  assert.equal(prediction.standardErrorBps, 5);
});

test('HY-EXP-0026 validates every qualifying OOF rule candidate as an advisory without SEM veto', () => {
  const result = readJson(RESULT_PATH);
  const reports = result.development.foldReports;
  assert.equal(result.status, 'EXPERIMENTAL_RELEASE_BLOCKED');
  assert.equal(result.experimentalReleaseReady, false);
  assert.equal(result.development.metrics.rawCandidateCount, 1434);
  assert.equal(result.development.metrics.labeledCandidateCount, 1434);
  assert.equal(result.development.metrics.oofPredictionCount, 119);
  assert.equal(result.development.metrics.edgeAvailableCount, 119);
  assert.equal(result.development.metrics.advisoryCount, 119);
  assert.equal(result.development.metrics.uncertaintyVetoApplied, false);
  assert.equal(result.development.metrics.conservativeNetEdgeVetoApplied, false);
  assert.equal(result.diagnostics.length, 119);
  assert.equal(result.diagnostics.every(row => row.status === 'ADVISORY'), true);
  assert.equal(result.diagnostics.every(row => row.ruleEligibility.uncertaintyVetoApplied === false), true);
  assert.equal(reports.length, 6);
  assert.deepEqual(reports.map(row => Number(row.trainingQ75.toFixed(6))), [10.241161, 10.229723, 10.266323, 10.253874, 10.239784, 10.10592]);
  assert.equal(reports.every(row => row.uncertaintyUsedAsVeto === false), true);
  assert.equal(result.development.metrics.netExpectancy18Bps > 10, true);
  assert.equal(result.development.metrics.netProfitFactor18 > 1.2, true);
  assert.equal(result.development.metrics.stressNetExpectancy27Bps > 0, true);
  assert.equal(result.development.metrics.stressProfitFactor27 > 1.05, true);
});

test('HY-EXP-0026 fails only its preregistered release gates and keeps OOS/live paths sealed', () => {
  const result = readJson(RESULT_PATH);
  const closure = readJson(CLOSURE_PATH);
  const manifest = readJson(MANIFEST_PATH);
  const checks = result.development.metrics.fastGates.checks;
  assert.equal(checks.advisoryCountAtLeast60, true);
  assert.equal(checks.usableAdvisoriesPer30CalendarDaysAtLeast6, false);
  assert.equal(checks.netExpectancy18BpsGreaterThan10, true);
  assert.equal(checks.netProfitFactor18GreaterThan1_20, true);
  assert.equal(checks.stressNetExpectancy27BpsGreaterThan0, true);
  assert.equal(checks.stressProfitFactor27GreaterThan1_05, true);
  assert.equal(checks.positiveMonthShareAtLeast0_55, false);
  assert.equal(checks.distinctCalendarMonthsAtLeast6, true);
  assert.equal(checks.distinctSymbolsAtLeast5, true);
  assert.equal(checks.maximumSingleSymbolShareAtMost0_40, true);
  assert.equal(checks.maxMtmDrawdownAtMost15Percent, true);
  assert.equal(result.development.metrics.risk.riskMetricStatus, 'EVALUABLE');
  assert.equal(result.development.metrics.maxMtmDrawdown <= 0.15, true);
  assert.equal(result.development.metrics.cvar95LossFraction != null, true);
  assert.equal(result.development.metrics.maxLossStreak, 15);
  assert.equal(result.finalOosRead, false);
  assert.equal(result.finalOosPnlComputed, false);
  assert.equal(result.livePath.implemented, false);
  assert.equal(result.livePath.deployed, false);
  assert.equal(closure.status, 'FAILED');
  assert.equal(closure.terminal, true);
  assert.equal(closure.failureReason, 'DEVELOPMENT_GATES_FAILED');
  assert.equal(closure.uncertaintyVetoApplied, false);
  assert.equal(manifest.paperOnly, true);
  assert.equal(manifest.signalOnly, true);
  assert.equal(manifest.finalOosRead, false);
});

test('HY-EXP-0025 remains terminal and its frozen result is unchanged', () => {
  assert.equal(sha256File(OLD_0025_RESULT_PATH), '6bf84357a6cbe7ece35ef929175dab0d07ff7840a143ce81265d179906af19ec');
  const ledger = fs.readFileSync('registry/ledger.jsonl', 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  const oldEvents = ledger.filter(row => row.experiment_id === 'HY-EXP-0025');
  assert.equal(oldEvents.length, 2);
  assert.equal(oldEvents.at(-1).event_type, 'failed');
});
