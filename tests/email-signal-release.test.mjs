import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  EMAIL_SIGNAL_RELEASE_POLICY,
  evaluateEmailSignalRelease as evaluateRawEmailSignalRelease
} from '../src/model/email-signal-release.mjs';

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hengyu-email-release-'));
const TEST_CANDIDATE_PATH = 'artifacts/HY-EXP-0028/holdout-result.json';
const TEST_BASELINE_RESULT_PATH = 'artifacts/HY-EXP-0019/result.json';
const TEST_BASELINE_DATA_PATH = 'artifacts/HY-EXP-0019/data-manifest.json';
const TEST_BASELINE_MANIFEST_PATH = 'artifacts/HY-EXP-0019/baseline-manifest.json';

function writeFileAtRoot(root, relativePath, content) {
  const absolute = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
  return createHash('sha256').update(content).digest('hex');
}

function writeTestFile(relativePath, content) {
  return writeFileAtRoot(TEST_ROOT, relativePath, content);
}

function candidateRootWithBytes(bytes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hengyu-email-candidate-'));
  writeFileAtRoot(root, TEST_CANDIDATE_PATH, bytes);
  return root;
}

const testCandidateArtifact = {
  experimentId: 'HY-EXP-0028',
  status: 'HOLDOUT_FAILED',
  metrics: {
    holdoutWindow: { exactDays: 100 },
    advisoryCount: 100,
    grossExpectancyBps: 4,
    net18ExpectancyBps: 4,
    net18ProfitFactor: 1.2,
    net27ExpectancyBps: 1,
    net27ProfitFactor: 1.1,
    netPnl: 100,
    fundingPnl: 0,
    distinctSymbols: 8,
    largestSingleSymbolShare: 0.2,
    maxMtmDrawdown: 0.08,
    maxMtmDrawdownBps: 800,
    cvar95LossFraction: 0.01,
    cvar95LossBps: 100,
    maxLossStreak: 3,
    bestTrade: { id: 'BTCUSDT:1', netPnl: 20 }
  },
  trades: [
    { decisionTime: Date.UTC(2026, 0, 15), netPnl: 20, costs: { baseTotalBps: 18, stressTotalBps: 27, fundingSeparate: true } },
    ...Array.from({ length: 40 }, (_, index) => ({
      decisionTime: Date.UTC(2026, 0, 15) + (index + 1) * 60_000,
      netPnl: 1,
      costs: { baseTotalBps: 18, stressTotalBps: 27, fundingSeparate: true }
    })),
    ...Array.from({ length: 19 }, (_, index) => ({
      decisionTime: Date.UTC(2026, 0, 15) + (index + 41) * 60_000,
      netPnl: 0,
      costs: { baseTotalBps: 18, stressTotalBps: 27, fundingSeparate: true }
    })),
    ...Array.from({ length: 40 }, (_, index) => ({
      decisionTime: Date.UTC(2026, 1, 15) + index * 60_000,
      netPnl: 1,
      costs: { baseTotalBps: 18, stressTotalBps: 27, fundingSeparate: true }
    }))
  ]
};
const testCandidateBytes = Buffer.from(JSON.stringify(testCandidateArtifact));
const TEST_CANDIDATE_SHA256 = writeTestFile(TEST_CANDIDATE_PATH, testCandidateBytes);
const testBaselineResultBytes = Buffer.from(JSON.stringify({
  experimentId: 'HY-EXP-0019',
  validation: { researchEquityUsdt: 100000 },
  oos: {
    tradeCount: 41,
    netProfitFactor: 0,
    netReturn: -0.012763487537771283,
    netReturnBps: -127.63487537771283,
    markToMarketDrawdown: -0.036301297700173873,
    positiveMonths: 0,
    observedMonths: 12
  }
}));
const TEST_BASELINE_RESULT_SHA256 = writeTestFile(TEST_BASELINE_RESULT_PATH, testBaselineResultBytes);
const TEST_BASELINE_DATA_SHA256 = writeTestFile(TEST_BASELINE_DATA_PATH, Buffer.from('{"manifest":"HY-EXP-0019"}\n'));
const testBaselineManifest = {
  manifestType: 'DERIVED_VALIDATED_BASELINE_MANIFEST',
  baselineExperimentId: 'HY-EXP-0019',
  source: {
    resultArtifactPath: TEST_BASELINE_RESULT_PATH,
    resultArtifactSha256: TEST_BASELINE_RESULT_SHA256,
    dataManifestPath: TEST_BASELINE_DATA_PATH,
    dataManifestSha256: TEST_BASELINE_DATA_SHA256,
    sourceCommit: '9d6b5298fab9760a611c2b5e52e86c500a6688a1',
    frozenAtCommit: '9f23475802f3ca9a85957a5ab2e69ac42b0c1aa2',
    provenanceMode: 'ORIGINAL_IMMUTABLE_HISTORY_REFERENCE'
  },
  validation: {
    windowStart: '2025-07-01T00:00:00.000Z',
    windowEndExclusive: '2026-07-01T00:00:00.000Z',
    tradeCount: 41,
    researchEquityUsdt: 100000
  },
  metrics: {
    netProfitFactor: 0,
    netReturn: -0.012763487537771283,
    netReturnBps: -127.63487537771283,
    normalizedNetBpsPerTrade: -3.113045740919825,
    markToMarketDrawdown: -0.036301297700173873,
    positiveMonths: 0,
    observedMonths: 12,
    costBasis: { feePerFillBps: 5 }
  }
};
const TEST_BASELINE_MANIFEST_SHA256 = writeTestFile(
  TEST_BASELINE_MANIFEST_PATH,
  Buffer.from(JSON.stringify(testBaselineManifest))
);

const TEST_POLICY = JSON.parse(JSON.stringify(EMAIL_SIGNAL_RELEASE_POLICY));
TEST_POLICY.frozenEvidence.candidate = {
  ...TEST_POLICY.frozenEvidence.candidate,
  artifactSha256: TEST_CANDIDATE_SHA256
};
TEST_POLICY.frozenEvidence.validatedBaseline = {
  experimentId: 'HY-EXP-0019',
  root: TEST_ROOT,
  manifestPath: TEST_BASELINE_MANIFEST_PATH,
  manifestSha256: TEST_BASELINE_MANIFEST_SHA256
};

function evaluateEmailSignalRelease(input, options = {}) {
  return evaluateRawEmailSignalRelease(input, { policy: TEST_POLICY, ...options });
}

const source = {
  artifactPath: TEST_CANDIDATE_PATH,
  artifactRoot: TEST_ROOT,
  artifactSha256: TEST_CANDIDATE_SHA256,
  commit: 'a61cb20318af1e0b188c0276a1a3d65e52bc4467',
  status: 'HOLDOUT_FAILED'
};

const integrity = {
  noLookaheadOrLeakage: true,
  noFutureLabelsInFeatures: true,
  parametersFrozenBeforeValidation: true,
  independentHoldout: true,
  postOutcomeFiltering: false,
  finalOosRead: false
};

const safety = {
  signalOnly: true,
  paperOnly: true,
  liveOrdersEnabled: false,
  accountApi: false,
  orderApi: false,
  automaticTrading: false
};

const metrics = {
  validatedSignals: 100,
  validationDays: 100,
  baseCostNetPnl: 100,
  baseCostBps: 18,
  netExpectancyBps: 4,
  netProfitFactor: 1.2,
  stressCostBps: 27,
  stressNetExpectancyBps: 1,
  stressNetProfitFactor: 1.1,
  maxMtmDrawdownPct: 8,
  distinctSymbols: 8,
  largestSymbolShare: 0.2,
  netPnlWithoutBestTrade: 80,
  activeMonths: [
    { month: '2026-01', baseCostNetPnl: 60 },
    { month: '2026-02', baseCostNetPnl: 40 }
  ],
  maxLossStreak: 3,
  researchEquityUsdt: 100000
};

function validInput(overrides = {}) {
  return {
    experimentId: 'HY-EXP-TEST',
    source,
    integrity,
    safety,
    metrics: { ...metrics, ...overrides }
  };
}

test('policy freezes the independent email-release gates and safety mode', () => {
  assert.equal(EMAIL_SIGNAL_RELEASE_POLICY.version, 2);
  assert.equal(EMAIL_SIGNAL_RELEASE_POLICY.hardGates.baseCostBps, 18);
  assert.equal(EMAIL_SIGNAL_RELEASE_POLICY.hardGates.minimumValidatedSignals, 40);
  assert.equal(EMAIL_SIGNAL_RELEASE_POLICY.hardGates.minimumValidationDays, 45);
  assert.equal(EMAIL_SIGNAL_RELEASE_POLICY.warnings.stressIsVeto, false);
  assert.equal(EMAIL_SIGNAL_RELEASE_POLICY.warnings.lossStreakIsVeto, false);
  assert.equal(EMAIL_SIGNAL_RELEASE_POLICY.warnings.monthlyConcentrationIsVeto, false);
  assert.equal(EMAIL_SIGNAL_RELEASE_POLICY.authorization.liveOrdersEnabled, false);
  assert.equal(EMAIL_SIGNAL_RELEASE_POLICY.monthlyRobustness.noPositiveMonthShareThreshold, true);
  assert.equal(EMAIL_SIGNAL_RELEASE_POLICY.monthlyRobustness.warningOnly, true);
  assert.match(EMAIL_SIGNAL_RELEASE_POLICY.monthlyRobustness.rule, /remove the highest-PnL month/);
});

test('restored historical evidence files match their frozen byte hashes', () => {
  const expected = {
    '../artifacts/HY-EXP-0028/holdout-result.json': '92304ec0252be9ee2bba2e13a9ccc64c923f3b067d91e12513be089d56f3d2e5',
    '../artifacts/HY-EXP-0019/result.json': '3c45646c589f9576a1645d43ff30d73469900c4aebccbed7a7c2bc3cf8f4878f',
    '../artifacts/HY-EXP-0019/data-manifest.json': '136ba1268cb91c700f55cdfa5a487aa3e9bd0c0575996bece314fb5223cf4986'
  };
  for (const [relativePath, sha256] of Object.entries(expected)) {
    const bytes = fs.readFileSync(new URL(relativePath, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256);
  }
});

test('a fully qualifying sample is release-ready but never automatic trading', () => {
  const result = evaluateEmailSignalRelease(validInput());
  assert.equal(result.state, 'EMAIL_SIGNAL_RELEASE_READY');
  assert.equal(result.releaseEligible, true);
  assert.equal(result.noAutomaticTradingPermission, true);
});

for (const [name, field, value] of [
  ['39 signals', 'validatedSignals', 39],
  ['44 days', 'validationDays', 44],
  ['negative net expectancy', 'netExpectancyBps', -0.01],
  ['profit factor below 1.10', 'netProfitFactor', 1.099],
  ['MTM drawdown above 10%', 'maxMtmDrawdownPct', 10.01],
  ['fewer than 6 symbols', 'distinctSymbols', 5],
  ['symbol concentration above 40%', 'largestSymbolShare', 0.4001],
  ['non-positive PnL without best trade', 'netPnlWithoutBestTrade', 0]
]) {
  test(`${name} caller assertion fails closed instead of overriding artifact`, () => {
    const result = evaluateEmailSignalRelease(validInput({ [field]: value }));
    assert.equal(result.state, 'RESEARCH_ONLY');
    assert.equal(result.hardGates.artifactDerivedMetrics.pass, true);
    assert.equal(result.hardGates.callerMetricsMatchArtifact.pass, false);
  });
}

test('caller cannot lower the artifact-derived V2 readiness minimums', () => {
  const result = evaluateEmailSignalRelease(validInput({
    validatedSignals: 40,
    validationDays: 45
  }));
  assert.equal(result.state, 'RESEARCH_ONLY');
  assert.equal(result.metrics.validatedSignals, 100);
  assert.equal(result.metrics.validationDays, 100);
  assert.equal(result.hardGates.minimumValidatedSignals.pass, true);
  assert.equal(result.hardGates.minimumValidationSpan.pass, true);
  assert.equal(result.hardGates.callerMetricsMatchArtifact.pass, false);
});

test('caller cannot alter artifact-derived monthly evaluation', () => {
  const result = evaluateEmailSignalRelease(validInput({ validationDays: 44 }));
  assert.equal(result.state, 'RESEARCH_ONLY');
  assert.equal(result.monthlyRobustness.status, 'PASS');
  assert.equal(result.monthlyRobustness.evaluable, true);
  assert.equal(result.monthlyRobustness.bestMonth, '2026-01');
  assert.equal(result.monthlyRobustness.bestMonthNetPnl, 60);
  assert.equal(result.monthlyRobustness.netPnlWithoutBestMonth, 40);
  assert.equal(result.warnings.MONTH_CONCENTRATION_WARNING, false);
  assert.equal(result.hardGates.callerMetricsMatchArtifact.pass, false);
});

test('caller cannot replace artifact-derived monthly concentration with a counterfactual', () => {
  const result = evaluateEmailSignalRelease(validInput({
    validationDays: 100,
    activeMonths: [
      { month: '2026-01', baseCostNetPnl: 100 },
      { month: '2026-02', baseCostNetPnl: -100 }
    ]
  }));
  assert.equal(result.state, 'RESEARCH_ONLY');
  assert.equal(result.monthlyRobustness.status, 'PASS');
  assert.equal(result.monthlyRobustness.evaluable, true);
  assert.equal(result.monthlyRobustness.pass, true);
  assert.equal(result.monthlyRobustness.netPnlWithoutBestMonth, 40);
  assert.equal(result.warnings.MONTH_CONCENTRATION_WARNING, false);
  assert.equal(result.hardGates.callerMetricsMatchArtifact.pass, false);
});

test('monthly concentration is derived from immutable trade timestamps', () => {
  const result = evaluateEmailSignalRelease(validInput({ validationDays: 45 }));
  assert.equal(result.state, 'RESEARCH_ONLY');
  assert.equal(result.monthlyRobustness.status, 'PASS');
  assert.equal(result.monthlyRobustness.netPnlWithoutBestMonth, 40);
  assert.equal(result.monthlyRobustness.pass, true);
  assert.equal(result.warnings.MONTH_CONCENTRATION_WARNING, false);
  assert.equal(result.hardGates.callerMetricsMatchArtifact.pass, false);
});

test('caller cannot replace artifact-derived stress expectancy', () => {
  const result = evaluateEmailSignalRelease(validInput({ stressNetExpectancyBps: -1 }));
  assert.equal(result.state, 'RESEARCH_ONLY');
  assert.equal(result.warnings.COST_STRESS_WARNING, false);
  assert.equal(result.hardGates.callerMetricsMatchArtifact.pass, false);
});

test('caller cannot replace artifact-derived zero stress expectancy', () => {
  const result = evaluateEmailSignalRelease(validInput({ stressNetExpectancyBps: 0 }));
  assert.equal(result.state, 'RESEARCH_ONLY');
  assert.equal(result.warnings.COST_STRESS_WARNING, false);
  assert.equal(result.hardGates.callerMetricsMatchArtifact.pass, false);
});

test('caller cannot replace artifact-derived loss streak', () => {
  const result = evaluateEmailSignalRelease(validInput({ maxLossStreak: 7 }));
  assert.equal(result.state, 'RESEARCH_ONLY');
  assert.equal(result.warnings.LOSS_STREAK_WARNING, false);
  assert.equal(result.hardGates.callerMetricsMatchArtifact.pass, false);
});

for (const [label, field, value, gateName] of [
  ['base cost 10bps', 'baseCostBps', 10, 'baseCostBasis'],
  ['missing base cost', 'baseCostBps', undefined, 'baseCostBasis'],
  ['stress cost 20bps', 'stressCostBps', 20, 'stressCostBasis'],
  ['missing stress cost', 'stressCostBps', undefined, 'stressCostBasis']
]) {
  test(`${label} fails cost-basis integrity closed`, () => {
    const result = evaluateEmailSignalRelease(validInput({ [field]: value }));
    assert.equal(result.state, 'RESEARCH_ONLY');
    assert.equal(result.hardGates[gateName].pass, false);
  });
}

for (const [field, gateName] of [
  ['liveOrdersEnabled', 'liveOrdersDisabled'],
  ['accountApi', 'accountApiDisabled'],
  ['orderApi', 'orderApiDisabled']
]) {
  test(`${field}=true fails closed`, () => {
    const unsafe = evaluateEmailSignalRelease({
      ...validInput(),
      safety: { ...safety, [field]: true }
    });
    assert.equal(unsafe.state, 'RESEARCH_ONLY');
  assert.equal(unsafe.hardGates[gateName].pass, false);
  });
}

for (const [field, label] of [
  ['automaticTrading', 'automaticTrading'],
  ['signalOnly', 'signalOnly'],
  ['paperOnly', 'paperOnly']
]) {
  const unsafeValue = field === 'automaticTrading' ? true : false;
  test(`${label}=${unsafeValue} safety mode fails closed`, () => {
    const unsafe = evaluateEmailSignalRelease({
      ...validInput(),
      safety: { ...safety, [field]: unsafeValue }
    });
    assert.equal(unsafe.state, 'RESEARCH_ONLY');
    const gateName = field === 'automaticTrading'
      ? 'automaticTradingDisabled'
      : field === 'signalOnly' ? 'signalOnly' : 'paperOnly';
    assert.equal(unsafe.hardGates[gateName].pass, false);
  });
}

test('the committed HY-EXP-0028 evaluation is machine-readable and fail-closed', () => {
  const artifact = JSON.parse(fs.readFileSync(
    new URL('../artifacts/HY-EXP-0028/email-signal-release-evaluation.json', import.meta.url),
    'utf8'
  ));
  assert.equal(artifact.status, 'EMAIL_SIGNAL_RELEASE_READY');
  assert.equal(artifact.releaseEligible, true);
  assert.equal(artifact.immutableSource.rewritten, false);
  assert.equal(artifact.authorization.liveOrdersEnabled, false);
  assert.equal(artifact.policyVersion, 2);
  assert.equal(artifact.immutableSourceVerification.pass, true);
  assert.equal(artifact.hardGates.immutableSourceVerified.pass, true);
  assert.equal(artifact.hardGates.artifactDerivedMetrics.pass, true);
  assert.equal(artifact.hardGates.callerMetricsMatchArtifact.pass, true);
  assert.equal(artifact.hardGates.betterThanValidatedBaseline.pass, true);
  assert.deepEqual(artifact.hardGateFailures, []);
  assert.equal(artifact.immutableSourceVerification.computedSha256, '92304ec0252be9ee2bba2e13a9ccc64c923f3b067d91e12513be089d56f3d2e5');
  assert.equal(artifact.baselineComparison.baselineExperimentId, 'HY-EXP-0019');
  assert.equal(artifact.baselineComparison.provenance.resultComputedSha256, '3c45646c589f9576a1645d43ff30d73469900c4aebccbed7a7c2bc3cf8f4878f');
  assert.equal(artifact.baselineComparison.candidateMetrics.equityBpsPerTrade, 1.5622755066204606);
  assert.equal(artifact.baselineComparison.baselineMetrics.equityBpsPerTrade, -3.113045740919825);
  assert.equal(artifact.monthlyRobustness.monthlyIndependenceEvaluable, true);
  assert.equal(artifact.warnings.MONTH_CONCENTRATION_WARNING, true);
});

test('HY-EXP-0028 is V2 release-ready but never released automatically', () => {
  const result = evaluateRawEmailSignalRelease({
    experimentId: 'HY-EXP-0028',
    source: {
      artifactPath: 'artifacts/HY-EXP-0028/holdout-result.json',
      artifactSha256: '92304ec0252be9ee2bba2e13a9ccc64c923f3b067d91e12513be089d56f3d2e5',
      commit: 'a61cb20318af1e0b188c0276a1a3d65e52bc4467',
      status: 'HOLDOUT_FAILED'
    },
    integrity,
    safety,
    metrics: {
      validatedSignals: 43,
      validationDays: 53,
      baseCostNetPnl: 671.778467846798,
      baseCostBps: 18,
      netExpectancyBps: 5.237781100313037,
      netProfitFactor: 1.1506895886413784,
      stressCostBps: 27,
      stressNetExpectancyBps: -3.7622188996869474,
      maxMtmDrawdownPct: 7.723556081371896,
      distinctSymbols: 8,
      largestSymbolShare: 0.20930232558139536,
      netPnlWithoutBestTrade: 4.4107091824917,
      activeMonths: [
        { month: '2026-07', baseCostNetPnl: -564.8740225660517 },
        { month: '2026-08', baseCostNetPnl: 1236.65249041285 }
      ],
      maxLossStreak: 12
    }
  }, { policy: EMAIL_SIGNAL_RELEASE_POLICY });
  assert.equal(result.state, 'EMAIL_SIGNAL_RELEASE_READY');
  assert.deepEqual(result.hardGateFailures, []);
  assert.equal(result.releaseEligible, true);
  assert.equal(result.monthlyRobustness.status, 'WARNING');
  assert.equal(result.monthlyRobustness.monthlyIndependenceEvaluable, true);
  assert.equal(result.warnings.COST_STRESS_WARNING, true);
  assert.equal(result.warnings.LOSS_STREAK_WARNING, true);
  assert.equal(result.warnings.MONTH_CONCENTRATION_WARNING, true);
  assert.equal(result.source.status, 'HOLDOUT_FAILED');
  assert.equal(result.artifactDerivedMetrics.pass, true);
  assert.equal(result.baselineComparison.candidateMetrics.equityBpsPerTrade, 1.5622755066204606);
  assert.equal(result.baselineComparison.baselineMetrics.equityBpsPerTrade, -3.113045740919825);
});

test('immutable source verification recomputes exact bytes and baseline comparison passes', () => {
  const result = evaluateEmailSignalRelease(validInput());
  assert.equal(result.hardGates.immutableSourceVerified.pass, true);
  assert.equal(result.immutableSourceVerification.computedSha256, TEST_CANDIDATE_SHA256);
  assert.equal(result.baselineComparison.provenance.provenanceVerified, true);
  assert.equal(result.hardGates.betterThanValidatedBaseline.pass, true);
});

test('one-byte immutable source mutation fails closed', () => {
  const mutatedRoot = candidateRootWithBytes(Buffer.from('immutable HY-EXP-0028 test artifact!\n'));
  const result = evaluateEmailSignalRelease({
    ...validInput(),
    source: { ...source, artifactRoot: mutatedRoot }
  });
  assert.equal(result.state, 'RESEARCH_ONLY');
  assert.equal(result.hardGates.immutableSourceVerified.pass, false);
  assert.notEqual(result.immutableSourceVerification.computedSha256, TEST_CANDIDATE_SHA256);
});

test('a syntactically valid but incorrect declared SHA-256 fails closed', () => {
  const result = evaluateEmailSignalRelease({
    ...validInput(),
    source: { ...source, artifactSha256: 'a'.repeat(64) }
  });
  assert.equal(result.state, 'RESEARCH_ONLY');
  assert.equal(result.hardGates.immutableSourceVerified.pass, false);
  assert.equal(result.immutableSourceVerification.computedSha256, TEST_CANDIDATE_SHA256);
});

test('a missing immutable source artifact fails closed', () => {
  const missingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hengyu-email-missing-'));
  const result = evaluateEmailSignalRelease({
    ...validInput(),
    source: { ...source, artifactRoot: missingRoot }
  });
  assert.equal(result.state, 'RESEARCH_ONLY');
  assert.equal(result.hardGates.immutableSourceVerified.pass, false);
  assert.equal(result.immutableSourceVerification.computedSha256, null);
});

test('an immutable source path mismatch fails closed', () => {
  const mismatchedPath = 'artifacts/HY-EXP-0028/other.json';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hengyu-email-path-'));
  writeFileAtRoot(root, mismatchedPath, testCandidateBytes);
  const result = evaluateEmailSignalRelease({
    ...validInput(),
    source: { ...source, artifactPath: mismatchedPath, artifactRoot: root }
  });
  assert.equal(result.state, 'RESEARCH_ONLY');
  assert.equal(result.hardGates.immutableSourceVerified.pass, false);
  assert.equal(result.immutableSourceVerification.pathMatches, false);
});

test('missing baseline provenance fails the comparison gate closed', () => {
  const policy = JSON.parse(JSON.stringify(TEST_POLICY));
  policy.frozenEvidence.validatedBaseline.manifestSha256 = '0'.repeat(64);
  const result = evaluateEmailSignalRelease(validInput(), { policy });
  assert.equal(result.state, 'RESEARCH_ONLY');
  assert.equal(result.hardGates.betterThanValidatedBaseline.pass, false);
  assert.equal(result.baselineComparison.provenance.provenanceVerified, false);
});

test('baseline release metrics must match the verified HY-EXP-0019 result bytes', () => {
  const mismatchPath = 'artifacts/HY-EXP-0019/baseline-mismatch.json';
  const mismatchManifest = JSON.parse(JSON.stringify(testBaselineManifest));
  mismatchManifest.metrics.netReturnBps = -999;
  const mismatchSha = writeTestFile(mismatchPath, Buffer.from(JSON.stringify(mismatchManifest)));
  const policy = JSON.parse(JSON.stringify(TEST_POLICY));
  policy.frozenEvidence.validatedBaseline.manifestPath = mismatchPath;
  policy.frozenEvidence.validatedBaseline.manifestSha256 = mismatchSha;
  const result = evaluateEmailSignalRelease(validInput(), { policy });
  assert.equal(result.state, 'RESEARCH_ONLY');
  assert.equal(result.baselineComparison.provenance.provenanceVerified, false);
  assert.equal(result.baselineComparison.provenance.manifestMetricComparisons.netReturnBps, false);
  assert.match(result.baselineComparison.provenance.errors.join('; '), /manifest metrics do not match/);
});

test('equity bps per trade is derived from verified net PnL, frozen equity, and trade count', () => {
  const result = evaluateEmailSignalRelease(validInput());
  assert.equal(result.baselineComparison.candidateMetrics.baseCostNetPnl, 100);
  assert.equal(result.baselineComparison.candidateMetrics.tradeCount, 100);
  assert.equal(result.baselineComparison.candidateMetrics.researchEquityUsdt, 100000);
  assert.equal(result.baselineComparison.candidateMetrics.equityBpsPerTrade, 0.1);
  assert.equal(result.baselineComparison.candidateMetrics.normalizedNetBpsPerTrade, undefined);
});

test('additional caller evidence assertions cannot override artifact-derived trade fields', () => {
  const result = evaluateEmailSignalRelease(validInput({
    tradeCount: 99,
    fundingSeparate: false
  }));
  assert.equal(result.state, 'RESEARCH_ONLY');
  assert.equal(result.hardGates.artifactDerivedMetrics.pass, true);
  assert.equal(result.hardGates.callerMetricsMatchArtifact.pass, false);
  assert.match(result.callerMetricAssertions.failures.join('; '), /tradeCount/);
  assert.match(result.callerMetricAssertions.failures.join('; '), /fundingSeparate/);
});
