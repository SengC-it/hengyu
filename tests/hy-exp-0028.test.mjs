import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  HY_EXP_0028_FROZEN_Q75,
  HY_EXP_0028_HOLDOUT_END,
  HY_EXP_0028_HOLDOUT_START,
  HY_EXP_0028_PREREGISTRATION_SHA256,
  HY_EXP_0028_SYMBOLS
} from '../src/research/hy-exp-0028.mjs';

const PREREG_PATH = 'registry/experiments/HY-EXP-0028/preregistration.json';
const Q75_PATH = 'artifacts/HY-EXP-0028/frozen-q75.json';
const MANIFEST_PATH = 'artifacts/HY-EXP-0028/holdout-data-manifest.json';
const RESULT_PATH = 'artifacts/HY-EXP-0028/holdout-result.json';
const CLOSURE_PATH = 'artifacts/HY-EXP-0028/closure.json';
const LOCKED_0026_RESULT_SHA256 = '8a378bec5893c2178b8efff41535308794f00eec67cc3659434b80eb2ae6bc07';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

test('HY-EXP-0028 freezes the prior Rule A Q75 before holdout retrieval', () => {
  const prereg = readJson(PREREG_PATH);
  const q75 = readJson(Q75_PATH);
  assert.equal(sha256(fs.readFileSync(PREREG_PATH)), HY_EXP_0028_PREREGISTRATION_SHA256);
  assert.equal(sha256(fs.readFileSync(Q75_PATH)), '1d85f472c24d45b3ea09ecb28be68269fe89f298464b0a58d9da286445ae3ed3');
  assert.equal(prereg.experimentId, 'HY-EXP-0028');
  assert.equal(prereg.status, 'PREREGISTERED');
  assert.equal(prereg.baseCommit, '6fe8c045d09d028cab0cfa48d338183e6fe73bf1');
  assert.equal(prereg.authorization, 'PAPER_ONLY');
  assert.equal(prereg.signalOnly, true);
  assert.equal(prereg.liveOrdersEnabled, false);
  assert.equal(prereg.accountApi, false);
  assert.equal(prereg.orderApi, false);
  assert.equal(prereg.frozenRule.filter.frozenQ75, HY_EXP_0028_FROZEN_Q75);
  assert.equal(prereg.frozenRule.filter.frozenQ75ArtifactSha256, sha256(fs.readFileSync(Q75_PATH)));
  assert.equal(q75.frozenQ75, HY_EXP_0028_FROZEN_Q75);
  assert.equal(q75.population.trainingRowCount, 1434);
  assert.equal(q75.holdoutDataRead, false);
  assert.equal(q75.holdoutOutcomesUsed, false);
  assert.equal(prereg.holdout.start, '2026-07-01T00:00:00.000Z');
  assert.equal(prereg.holdout.endExclusive, '2026-08-23T00:00:00.000Z');
  assert.equal(prereg.frozenRule.filter.ruleBAllowed, false);
  assert.equal(prereg.frozenRule.filter.featureSearchAllowed, false);
  assert.equal(prereg.frozenRule.filter.q75TuningAllowed, false);
});

test('HY-EXP-0028 holdout manifest is immutable, hashed, complete, and public-only', () => {
  const manifest = readJson(MANIFEST_PATH);
  const body = { ...manifest };
  delete body.manifestSha256;
  assert.equal(manifest.status, 'DATA_LOCKED');
  assert.equal(manifest.immutable, true);
  assert.equal(manifest.experimentId, 'HY-EXP-0028');
  assert.equal(manifest.windowStart, '2026-07-01T00:00:00.000Z');
  assert.equal(manifest.windowEndExclusive, '2026-08-23T00:00:00.000Z');
  assert.equal(manifest.manifestSha256, sha256(Buffer.from(canonicalJson(body))));
  assert.equal(manifest.files.length, 17);
  assert.deepEqual(manifest.symbols, HY_EXP_0028_SYMBOLS);
  assert.equal(manifest.noPrivateApi, true);
  assert.equal(manifest.noAccountApi, true);
  assert.equal(manifest.noOutcomeOutsideWindow, true);
  for (const file of manifest.files) {
    const absolute = path.resolve(file.path);
    assert.ok(absolute.startsWith(path.resolve('.')), `manifest path must remain inside project: ${file.path}`);
    assert.equal(sha256(fs.readFileSync(absolute)), file.sha256, `${file.path} hash`);
  }
  for (const symbol of HY_EXP_0028_SYMBOLS) {
    assert.equal(manifest.coverage[symbol].klineRows, 24480);
    assert.equal(manifest.coverage[symbol].fundingRows, 255);
  }
});

test('HY-EXP-0028 performance rows are fresh holdout Rule A advisories only', () => {
  const result = readJson(RESULT_PATH);
  assert.equal(result.experimentId, 'HY-EXP-0028');
  assert.equal(result.holdout.start, '2026-07-01T00:00:00.000Z');
  assert.equal(result.holdout.endExclusive, '2026-08-23T00:00:00.000Z');
  assert.equal(result.frozenQ75, HY_EXP_0028_FROZEN_Q75);
  assert.equal(result.metrics.candidateCount, 43);
  assert.equal(result.metrics.advisoryCount, 43);
  assert.equal(result.metrics.signalsPer30Days, 43 * 30 / 53);
  assert.equal(result.metrics.noRuleB, true);
  assert.equal(result.metrics.noSemVeto, true);
  assert.equal(result.metrics.postOutcomeFiltering, false);
  assert.equal(result.trades.length, 43);
  assert.equal(result.diagnostics.length, 43);
  assert.ok(result.trades.every(trade => trade.rule === 'RULE_A_CHANNEL_DISTANCE_Q75'));
  assert.ok(result.trades.every(trade => trade.signalTime >= HY_EXP_0028_HOLDOUT_START && trade.signalTime < HY_EXP_0028_HOLDOUT_END));
  assert.ok(result.trades.every(trade => trade.exitTime < HY_EXP_0028_HOLDOUT_END));
  assert.ok(result.trades.every(trade => trade.frozenQ75 === HY_EXP_0028_FROZEN_Q75));
  assert.ok(result.trades.every(trade => trade.costs.baseTotalBps === 18 && trade.costs.stressTotalBps === 27));
  assert.ok(result.trades.every(trade => trade.historicalExecutionProxy.laterBarRescue === false));
  assert.ok(result.diagnostics.every(row => row.matchedRule === 'A' && row.postOutcomeFilter === false));
});

test('HY-EXP-0028 evaluates all ten frozen gates without rescue', () => {
  const result = readJson(RESULT_PATH);
  const metrics = result.metrics;
  const checks = metrics.gates.checks;
  assert.equal(result.status, 'HOLDOUT_FAILED');
  assert.equal(result.holdoutPass, false);
  assert.equal(result.experimentalReleaseReady, false);
  assert.equal(result.finalOosRead, false);
  assert.equal(result.finalOosPnlComputed, false);
  assert.equal(result.deploymentPrepared, false);
  assert.equal(metrics.grossExpectancyBps, 23.60880158162159);
  assert.equal(metrics.net18ExpectancyBps, 5.237781100313037);
  assert.equal(metrics.net18ProfitFactor, 1.1506895886413784);
  assert.equal(metrics.net27ExpectancyBps, -3.7622188996869474);
  assert.equal(metrics.net27ProfitFactor, 1.0701186290763716);
  assert.equal(metrics.distinctSymbols, 8);
  assert.equal(metrics.largestSingleSymbolShare, 0.20930232558139536);
  assert.equal(metrics.maxMtmDrawdown, 0.07723556081371896);
  assert.equal(metrics.cvar95LossFraction, 0.005648740225660531);
  assert.equal(metrics.maxLossStreak, 12);
  assert.equal(metrics.bestTradePositivePnlShare, 0.1300960784771409);
  assert.equal(checks.advisoryCountAtLeast8, true);
  assert.equal(checks.net18ExpectancyGreaterThan0, true);
  assert.equal(checks.net18ProfitFactorGreaterThan1_10, true);
  assert.equal(checks.net27ExpectancyGreaterThan0, false);
  assert.equal(checks.net27ProfitFactorGreaterThan1_00, true);
  assert.equal(checks.distinctSymbolsAtLeast4, true);
  assert.equal(checks.largestSingleSymbolShareAtMost0_40, true);
  assert.equal(checks.maxMtmDrawdownAtMost15Percent, true);
  assert.equal(checks.maxLossStreakAtMost6, false);
  assert.equal(checks.bestTradePositivePnlShareAtMost0_50, true);
  assert.equal(metrics.gates.pass, false);
});

test('HY-EXP-0028 terminal closure preserves prior experiments and paper-only safety', () => {
  const result = readJson(RESULT_PATH);
  const closure = readJson(CLOSURE_PATH);
  assert.equal(sha256(fs.readFileSync(RESULT_PATH)), closure.holdoutResultSha256);
  assert.deepEqual(closure.failedGates, ['net27ExpectancyGreaterThan0', 'maxLossStreakAtMost6']);
  assert.equal(closure.status, 'FAILED');
  assert.equal(closure.terminal, true);
  assert.equal(closure.noRuleB, true);
  assert.equal(closure.finalOosRead, false);
  assert.equal(closure.productionDeploy, false);
  assert.equal(closure.paperOnly, true);
  assert.equal(closure.signalOnly, true);
  assert.equal(result.safety.liveOrdersEnabled, false);
  assert.equal(result.safety.accountApi, false);
  assert.equal(result.safety.orderApi, false);
  assert.equal(sha256(fs.readFileSync('artifacts/HY-EXP-0026/development-result.json')), LOCKED_0026_RESULT_SHA256);
});
