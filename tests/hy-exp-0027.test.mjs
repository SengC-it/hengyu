import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

import {
  HY_EXP_0027_RULES,
  HY_EXP_0027_RULE_EDGE_MODEL_ID,
  fitRuleDiagnostic,
  predictRuleDiagnostic,
  trainingQ75
} from '../src/model/hy-exp-0027-rules.mjs';

const PREREG_PATH = 'registry/experiments/HY-EXP-0027/preregistration.json';
const RESULT_PATH = 'artifacts/HY-EXP-0027/development-result.json';
const CLOSURE_PATH = 'artifacts/HY-EXP-0027/closure.json';
const MANIFEST_PATH = 'artifacts/HY-EXP-0027/development-manifest.json';
const PREREG_SHA256 = 'a09b7c47b4dcd17f4e11cba202cf980ece68c3b9b54594b168407e68e706b3d0';
const LOCKED_0026_RESULT_SHA256 = '8a378bec5893c2178b8efff41535308794f00eec67cc3659434b80eb2ae6bc07';

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function sha256(path) {
  return createHash('sha256').update(fs.readFileSync(path)).digest('hex');
}

test('HY-EXP-0027 preregistration is immutable, paper-only, and fully rule based', () => {
  const prereg = readJson(PREREG_PATH);
  assert.equal(sha256(PREREG_PATH), PREREG_SHA256);
  assert.equal(prereg.experimentId, 'HY-EXP-0027');
  assert.equal(prereg.status, 'PREREGISTERED');
  assert.equal(prereg.authorization, 'PAPER_ONLY');
  assert.equal(prereg.signalOnly, true);
  assert.equal(prereg.liveOrdersEnabled, false);
  assert.equal(prereg.accountApi, false);
  assert.equal(prereg.orderApi, false);
  assert.equal(prereg.primaryHypothesis.direction, 'BULL/BUY/TREND_BREAKOUT');
  assert.equal(prereg.primaryHypothesis.bearSellAllowed, false);
  assert.deepEqual(Object.keys(HY_EXP_0027_RULES).sort(), ['A', 'B']);
  assert.equal(HY_EXP_0027_RULES.A.featureIndex, 7);
  assert.equal(HY_EXP_0027_RULES.B.featureIndex, 0);
  assert.equal(prereg.rules.advisory.perSignalStandardErrorVeto, false);
  assert.equal(prereg.rules.advisory.perSignalConservativePredictionVeto, false);
  assert.equal(prereg.development.frequencyExposureWindow.start, '2025-01-01T00:00:00.000Z');
  assert.equal(prereg.development.frequencyExposureWindow.endExclusive, '2026-07-01T00:00:00.000Z');
});

test('HY-EXP-0027 computes independent fold-local Q75 rule diagnostics', () => {
  const rows = [
    { features: [1, 0, 0, 0, 0, 0, 0, 2], grossPriceReturnBps: 10 },
    { features: [2, 0, 0, 0, 0, 0, 0, 4], grossPriceReturnBps: 20 },
    { features: [3, 0, 0, 0, 0, 0, 0, 6], grossPriceReturnBps: 30 },
    { features: [4, 0, 0, 0, 0, 0, 0, 8], grossPriceReturnBps: 40 }
  ];
  assert.equal(trainingQ75(rows, 'A'), 6.5);
  assert.equal(trainingQ75(rows, 'B'), 3.25);

  const fittingRows = Array.from({ length: 8 }, (_, index) => ({
    features: [index + 1, 0, 0, 0, 0, 0, 0, (index + 1) * 2],
    label: { grossPriceReturnBps: (index + 1) * 10 },
    signalTime: Date.UTC(2025, 0, index + 1)
  }));
  const model = fitRuleDiagnostic(fittingRows, 'A', { minimumRows: 2, validationWindow: { foldId: 'TEST' } });
  assert.equal(model.edgeModelId, HY_EXP_0027_RULE_EDGE_MODEL_ID);
  assert.equal(model.trainingQ75, 12.5);
  assert.equal(model.sampleSize, 2);
  assert.equal(model.expectedPriceEdgeBps, 75);
  assert.equal(model.standardErrorBps, 5);

  const hit = predictRuleDiagnostic(model, fittingRows[7], { foldId: 'TEST' });
  const miss = predictRuleDiagnostic(model, fittingRows[0], { foldId: 'TEST' });
  assert.equal(hit.available, true);
  assert.equal(hit.rule, 'A');
  assert.equal(hit.edgeModelId, HY_EXP_0027_RULE_EDGE_MODEL_ID);
  assert.equal(miss.available, false);
  assert.equal(miss.rejectionReason, 'RULE_Q75_NOT_MET');
});

test('HY-EXP-0027 OOF metrics use the exact exposure denominator and OR deduplication', () => {
  const result = readJson(RESULT_PATH);
  const metrics = result.development.metrics;
  assert.equal(metrics.rawCandidateCount, 1434);
  assert.equal(metrics.labeledCandidateCount, 1434);
  assert.equal(metrics.ruleACount, 119);
  assert.equal(metrics.ruleBCount, 150);
  assert.equal(metrics.overlapCount, 52);
  assert.equal(metrics.dedupAdvisoryCount, 217);
  assert.equal(metrics.oofPredictionCount, 217);
  assert.equal(metrics.edgeAvailableCount, 217);
  assert.equal(metrics.advisoryCount, 217);
  assert.equal(metrics.oofExposureStart, '2025-01-01T00:00:00.000Z');
  assert.equal(metrics.oofExposureEndExclusive, '2026-07-01T00:00:00.000Z');
  assert.equal(metrics.oofExposureDays, 546);
  assert.equal(metrics.usableAdvisoriesPer30CalendarDays, 217 * 30 / 546);

  const diagnostics = result.diagnostics;
  assert.equal(diagnostics.length, 217);
  assert.ok(diagnostics.every(row => row.status === 'ADVISORY'));
  assert.ok(diagnostics.every(row => ['A', 'B', 'A+B'].includes(row.matchedRule)));
  assert.equal(metrics.uncertaintyVetoApplied, false);
  assert.equal(metrics.conservativePredictionVetoApplied, false);
  assert.equal(new Set(diagnostics.map(row => row.id)).size, diagnostics.length);
});

test('HY-EXP-0027 development result reports temporal robustness and frozen gates without rescue', () => {
  const result = readJson(RESULT_PATH);
  const metrics = result.development.metrics;
  const checks = metrics.fastGates.checks;
  assert.equal(result.status, 'EXPERIMENTAL_RELEASE_BLOCKED');
  assert.equal(result.experimentalReleaseReady, false);
  assert.equal(result.finalOosRead, false);
  assert.equal(result.finalOosPnlComputed, false);
  assert.equal(result.deploymentPrepared, false);
  assert.equal(result.livePath.implemented, false);
  assert.equal(metrics.netExpectancy18Bps, 10.505844190690599);
  assert.equal(metrics.netProfitFactor18, 1.0339190916248424);
  assert.equal(metrics.stressNetExpectancy27Bps, 1.5058441906906002);
  assert.equal(metrics.stressProfitFactor27, 0.9178359095334085);
  assert.equal(metrics.activeMonthCount, 11);
  assert.equal(metrics.positiveActiveMonths, 4);
  assert.equal(metrics.positiveActiveMonthShare, 4 / 11);
  assert.equal(metrics.bestPositiveMonth, '2025-07');
  assert.equal(metrics.bestMonthPositivePnlShare, 0.6806735318551496);
  assert.equal(metrics.netPnlWithoutBestMonth, -6593.015666824991);
  assert.equal(metrics.distinctSymbols, 8);
  assert.equal(metrics.largestSingleSymbolShare, 0.16129032258064516);
  assert.equal(metrics.maxLossStreak, 15);
  assert.equal(metrics.risk.riskMetricStatus, 'EVALUABLE');
  assert.equal(metrics.risk.maxMtmDrawdown, 0.08804141086289341);
  assert.equal(metrics.risk.cvar95LossFraction, 0.018650267857368397);
  assert.equal(metrics.fundingPnl, -149.3834609604353);
  assert.equal(checks.advisoryCountAtLeast100, true);
  assert.equal(checks.usableAdvisoriesPer30CalendarDaysAtLeast6, true);
  assert.equal(checks.netExpectancy18BpsGreaterThan10, true);
  assert.equal(checks.netProfitFactor18GreaterThan1_20, false);
  assert.equal(checks.stressNetExpectancy27BpsGreaterThan0, true);
  assert.equal(checks.stressProfitFactor27GreaterThan1_05, false);
  assert.equal(checks.activeMonthCountAtLeast9, true);
  assert.equal(checks.positiveActiveMonthShareAtLeast0_40, false);
  assert.equal(checks.distinctSymbolsAtLeast5, true);
  assert.equal(checks.maximumSingleSymbolShareAtMost0_40, true);
  assert.equal(checks.maxMtmDrawdownAtMost15Percent, true);
  assert.equal(checks.bestMonthPositivePnlShareAtMost0_60, false);
  assert.equal(checks.netPnlWithoutBestMonthGreaterThan0, false);
  assert.equal(metrics.fastGates.pass, false);
});

test('HY-EXP-0027 terminal closure and locked predecessor remain fail-closed', () => {
  const result = readJson(RESULT_PATH);
  const closure = readJson(CLOSURE_PATH);
  const manifest = readJson(MANIFEST_PATH);
  assert.equal(closure.status, 'FAILED');
  assert.equal(closure.terminal, true);
  assert.deepEqual(closure.failedGates, [
    'netProfitFactor18GreaterThan1_20',
    'stressProfitFactor27GreaterThan1_05',
    'positiveActiveMonthShareAtLeast0_40',
    'bestMonthPositivePnlShareAtMost0_60',
    'netPnlWithoutBestMonthGreaterThan0'
  ]);
  assert.equal(closure.finalOosRead, false);
  assert.equal(closure.productionDeploy, false);
  assert.equal(closure.paperOnly, true);
  assert.equal(closure.signalOnly, true);
  assert.equal(result.oos.status, 'SEALED');
  assert.equal(manifest.finalOosRead, false);
  assert.equal(manifest.liveOrdersEnabled, false);
  assert.equal(sha256('artifacts/HY-EXP-0026/development-result.json'), LOCKED_0026_RESULT_SHA256);
});
