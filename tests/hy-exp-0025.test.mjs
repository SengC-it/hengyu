import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  HY_EXP_0025_EDGE_MODEL_ID,
  HY_EXP_0025_EDGE_SOURCE,
  fitHyExp0025EmpiricalBucket,
  predictHyExp0025EmpiricalBucket
} from '../src/model/hy-exp-0025-edge.mjs';

const PREREG_PATH = 'registry/experiments/HY-EXP-0025/preregistration.json';
const RESULT_PATH = 'artifacts/HY-EXP-0025/development-result.json';
const MANIFEST_PATH = 'artifacts/HY-EXP-0025/development-manifest.json';
const CLOSURE_PATH = 'artifacts/HY-EXP-0025/closure.json';

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

test('HY-EXP-0025 preregistration is frozen before Development and has one primary direction', () => {
  const prereg = readJson(PREREG_PATH);
  assert.equal(sha256File(PREREG_PATH), '5a27a6107c0dc1c9d7b2ac87e86cfa34b5e21562a915fc638054b88f153c993d');
  assert.equal(prereg.status, 'PREREGISTERED');
  assert.equal(prereg.authorization, 'PAPER_ONLY');
  assert.equal(prereg.signalOnly, true);
  assert.equal(prereg.liveOrdersEnabled, false);
  assert.equal(prereg.accountApi, false);
  assert.equal(prereg.orderApi, false);
  assert.equal(prereg.primaryHypothesis.direction, 'BULL/BUY/TREND_BREAKOUT');
  assert.equal(prereg.primaryHypothesis.bearSellAllowed, false);
  assert.equal(prereg.primaryHypothesis.ridgeAllowed, false);
  assert.equal(prereg.q75Protocol.global0024Q4CutpointAllowed, false);
  assert.equal(prereg.q75Protocol.validationUsesFrozenTrainingQ75, true);
  assert.equal(prereg.development.walkForward.folds.length, 6);
});

test('HY-EXP-0025 empirical edge is a conditional mean with standard error of the mean', () => {
  const rows = [
    syntheticRow(1, 10, '2024-01'),
    syntheticRow(2, 20, '2024-02'),
    syntheticRow(3, 30, '2024-03'),
    syntheticRow(4, 40, '2024-04')
  ];
  const model = fitHyExp0025EmpiricalBucket(rows, { minimumSamples: 2 });
  assert.equal(model.trainingQ75, 3.25);
  assert.equal(model.sampleSize, 1);
  assert.equal(model.available, false);

  const qualifyingRows = [
    syntheticRow(3.25, 30, '2024-03'),
    syntheticRow(4, 40, '2024-04')
  ];
  const fitted = fitHyExp0025EmpiricalBucket(qualifyingRows, { q75: 3.25, minimumSamples: 2 });
  assert.equal(fitted.available, true);
  assert.equal(fitted.expectedPriceEdgeBps, 35);
  assert.equal(fitted.standardErrorBps, 5);
  assert.equal(fitted.standardErrorOfMeanBps, 5);
  assert.equal(fitted.modelId, HY_EXP_0025_EDGE_MODEL_ID);
  assert.equal(fitted.edgeSource, HY_EXP_0025_EDGE_SOURCE);
  const prediction = predictHyExp0025EmpiricalBucket(fitted, qualifyingRows[0]);
  assert.equal(prediction.expectedPriceEdgeBps, 35);
  assert.equal(prediction.trainingQ75, 3.25);
});

test('HY-EXP-0025 Development uses six fold-specific Q75 values and no Ridge', () => {
  const result = readJson(RESULT_PATH);
  const reports = result.development.foldReports;
  assert.equal(reports.length, 6);
  assert.equal(result.model.type, 'EMPIRICAL_BUCKET_EDGE');
  assert.equal(result.model.noRidge, true);
  assert.equal(result.model.noMl, true);
  assert.equal(result.model.modelId, HY_EXP_0025_EDGE_MODEL_ID);
  assert.equal(result.model.edgeSource, HY_EXP_0025_EDGE_SOURCE);
  for (const fold of reports) {
    assert.equal(fold.edgeModelId, HY_EXP_0025_EDGE_MODEL_ID);
    assert.equal(fold.trainingQ75 > 0, true);
    assert.equal(fold.trainingQ75 < 20, true);
    assert.equal(fold.qualifyingTrainingRows >= 20, true);
    assert.equal(fold.validationWindow.purgeBars, 6);
    assert.equal(fold.validationWindow.embargoBars, 6);
  }
  assert.equal(result.development.metrics.rawCandidateCount, 1434);
  assert.equal(result.development.metrics.labeledCandidateCount, 1434);
  assert.equal(result.development.metrics.oofPredictionCount, 119);
  assert.equal(result.development.metrics.edgeAvailableCount, 119);
  assert.equal(result.development.metrics.advisoryCount, 0);
  assert.equal(result.development.metrics.grossExpectancyBps > 0, true);
  assert.equal(result.development.metrics.risk.riskMetricStatus, 'EMPTY_SAMPLE_NOT_EVALUABLE');
  assert.equal(result.development.metrics.risk.maxMtmDrawdown, null);
  assert.equal(result.development.metrics.risk.cvar95LossBps, null);
});

test('HY-EXP-0025 fails closed without selecting secondary diagnostics or implementing live path', () => {
  const result = readJson(RESULT_PATH);
  const closure = readJson(CLOSURE_PATH);
  const manifest = readJson(MANIFEST_PATH);
  assert.equal(result.status, 'EXPERIMENTAL_RELEASE_BLOCKED');
  assert.equal(result.experimentalReleaseReady, false);
  assert.equal(result.finalOosRead, false);
  assert.equal(result.deploymentPrepared, false);
  assert.equal(result.livePath.implemented, false);
  assert.equal(result.noSecondarySelection, true);
  assert.equal(result.development.secondaryDiagnostics.every(row => row.selectedForPrimary === false && row.usedInGates === false), true);
  assert.equal(closure.status, 'FAILED');
  assert.equal(closure.terminal, true);
  assert.equal(closure.failureReason, 'DEVELOPMENT_GATES_FAILED');
  assert.equal(closure.experimentalReleaseReady, false);
  assert.equal(closure.finalOosRead, false);
  assert.equal(closure.productionDeploy, false);
  assert.equal(manifest.paperOnly, true);
  assert.equal(manifest.signalOnly, true);
  assert.equal(manifest.finalOosRead, false);
});

test('HY-EXP-0025 rejects zero-advisory risk metrics as not evaluable', () => {
  const result = readJson(RESULT_PATH);
  const metrics = result.development.metrics;
  assert.equal(metrics.advisoryCount, 0);
  assert.equal(metrics.risk.maxMtmDrawdown, null);
  assert.equal(metrics.risk.cvar95LossFraction, null);
  assert.equal(metrics.risk.riskMetricStatus, 'EMPTY_SAMPLE_NOT_EVALUABLE');
  assert.equal(result.experimentalReleaseReady, false);
});
