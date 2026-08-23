import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { emptySampleRiskMetrics, EMPTY_SAMPLE_NOT_EVALUABLE } from '../src/research/reporting-semantics.mjs';

const CLOSURE_PATH = 'artifacts/HY-EXP-0024/closure.json';
const DECOMPOSITION_PATH = 'artifacts/HY-EXP-0024/failure-decomposition.json';
const FROZEN_RESULT_PATH = 'artifacts/HY-EXP-0024/development-result.json';
const LEDGER_PATH = 'registry/ledger.jsonl';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('HY-EXP-0024 has one terminal failed closure and remains paper-only', () => {
  const closure = readJson(CLOSURE_PATH);
  const ledger = fs.readFileSync(LEDGER_PATH, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
  const events = ledger.filter(entry => entry.experiment_id === 'HY-EXP-0024');
  assert.equal(closure.status, 'FAILED');
  assert.equal(closure.terminal, true);
  assert.equal(closure.failureReason, 'DEVELOPMENT_EDGE_MODEL_FAILED_AND_ZERO_ADVISORIES');
  assert.equal(closure.experimentalReleaseReady, false);
  assert.equal(closure.finalOosRead, false);
  assert.equal(closure.productionDeploy, false);
  assert.equal(closure.signalOnly, true);
  assert.equal(closure.paperOnly, true);
  assert.equal(events.length, 2);
  assert.equal(events.at(-1).event_type, 'failed');
  assert.equal(events.at(-1).payload_path, CLOSURE_PATH);
  assert.equal(events.filter(entry => entry.event_type === 'failed').length, 1);
});

test('HY-EXP-0024 closure preserves the frozen result and records separate populations', () => {
  const closure = readJson(CLOSURE_PATH);
  const result = readJson(FROZEN_RESULT_PATH);
  const evidence = closure.frozenDevelopmentEvidence;
  assert.deepEqual(evidence, {
    rawCandidates: 2459,
    labeledCandidates: 2459,
    oofPredictions: 1412,
    edgeAvailable: 1412,
    advisories: 0,
    rejections: {
      INSUFFICIENT_CONSERVATIVE_NET_EDGE: 1412,
      INSUFFICIENT_COST_COVERAGE: 738,
      NON_POSITIVE_PRICE_EDGE: 334
    },
    calibration: {
      MAE: 182.5993,
      RMSE: 240.2098,
      zeroMAE: 173.1599,
      zeroRMSE: 232.7283,
      maeRatio: 1.0545,
      rmseRatio: 1.0321,
      slope: -0.7127,
      spearman: -0.1267
    }
  });
  assert.equal(sha256File(FROZEN_RESULT_PATH), closure.sourceEvidence.frozenDevelopmentResultSha256);
  assert.equal(result.finalOosRead, false);
  assert.equal(result.finalOosPnlComputed, false);
  assert.equal(result.experimentalReleaseReady, false);
  assert.equal(closure.riskMetricStatus, EMPTY_SAMPLE_NOT_EVALUABLE);
});

test('failure decomposition is deterministic and pre-Net-Edge', () => {
  const decomposition = readJson(DECOMPOSITION_PATH);
  assert.equal(decomposition.status, 'FAILURE_DECOMPOSITION_COMPLETE');
  assert.match(decomposition.source.sourceHashes.lockedDiagnosticsSha256, /^[a-f0-9]{64}$/);
  assert.match(decomposition.source.sourceHashes.sourceManifestSha256, /^[a-f0-9]{64}$/);
  assert.equal(decomposition.source.rawCandidateCount, 2459);
  assert.equal(decomposition.source.labeledCandidateCount, 2459);
  assert.equal(decomposition.source.oofPredictionCount, 1412);
  assert.equal(decomposition.source.edgeAvailableCount, 1412);
  assert.equal(decomposition.source.advisoryCount, 0);
  assert.equal(decomposition.populations.advisory.maxMTMDD, null);
  assert.equal(decomposition.populations.advisory.CVaR95, null);
  assert.equal(decomposition.populations.advisory.riskMetricStatus, EMPTY_SAMPLE_NOT_EVALUABLE);
  assert.equal(decomposition.featureQuartiles.length, 8);
  assert.equal(Object.keys(decomposition.groups.predictedEdgeDecileOof).length, 10);
  assert.equal(Object.keys(decomposition.groups.realizedGrossReturnDecileOof).length, 10);
  assert.equal(decomposition.robustOpportunity.decision, 'QUALIFYING_DIRECTIONS_FOUND');
  assert.ok(decomposition.robustOpportunity.directions.length <= 3);
  assert.equal(decomposition.safety.finalOosRead, false);
  assert.equal(decomposition.safety.noNewExperimentCreated, true);
  assert.equal(decomposition.experimentId, 'HY-EXP-0024');
});

test('empty advisory risk metrics are explicitly non-evaluable', () => {
  assert.deepEqual(emptySampleRiskMetrics(0), {
    maxMtmDrawdown: null,
    maxMtmDrawdownBps: null,
    cvar95LossFraction: null,
    cvar95LossBps: null,
    riskMetricStatus: EMPTY_SAMPLE_NOT_EVALUABLE
  });
  assert.equal(emptySampleRiskMetrics(1), null);
});
