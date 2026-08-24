import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  EMAIL_SIGNAL_RELEASE_POLICY,
  evaluateEmailSignalRelease
} from '../src/model/email-signal-release.mjs';

const source = {
  artifactPath: 'artifacts/HY-EXP-0028/holdout-result.json',
  artifactSha256: '92304ec0252be9ee2bba2e13a9ccc64c923f3b067d91e12513be089d56f3d2e5',
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
  maxMtmDrawdownPct: 8,
  distinctSymbols: 8,
  largestSymbolShare: 0.2,
  netPnlWithoutBestTrade: 80,
  activeMonths: [
    { month: '2026-01', baseCostNetPnl: 60 },
    { month: '2026-02', baseCostNetPnl: 40 }
  ],
  maxLossStreak: 3
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
  assert.equal(EMAIL_SIGNAL_RELEASE_POLICY.hardGates.baseCostBps, 18);
  assert.equal(EMAIL_SIGNAL_RELEASE_POLICY.hardGates.minimumValidatedSignals, 80);
  assert.equal(EMAIL_SIGNAL_RELEASE_POLICY.hardGates.minimumValidationDays, 90);
  assert.equal(EMAIL_SIGNAL_RELEASE_POLICY.warnings.stressIsVeto, false);
  assert.equal(EMAIL_SIGNAL_RELEASE_POLICY.warnings.lossStreakIsVeto, false);
  assert.equal(EMAIL_SIGNAL_RELEASE_POLICY.authorization.liveOrdersEnabled, false);
  assert.equal(EMAIL_SIGNAL_RELEASE_POLICY.monthlyRobustness.noPositiveMonthShareThreshold, true);
  assert.match(EMAIL_SIGNAL_RELEASE_POLICY.monthlyRobustness.rule, /remove the highest-PnL month/);
});

test('a fully qualifying sample is release-ready but never automatic trading', () => {
  const result = evaluateEmailSignalRelease(validInput());
  assert.equal(result.state, 'EMAIL_SIGNAL_RELEASE_READY');
  assert.equal(result.releaseEligible, true);
  assert.equal(result.noAutomaticTradingPermission, true);
});

for (const [name, field, value] of [
  ['79 signals', 'validatedSignals', 79],
  ['89 days', 'validationDays', 89],
  ['negative net expectancy', 'netExpectancyBps', -0.01],
  ['profit factor below 1.10', 'netProfitFactor', 1.099],
  ['MTM drawdown above 10%', 'maxMtmDrawdownPct', 10.01],
  ['fewer than 6 symbols', 'distinctSymbols', 5],
  ['symbol concentration above 40%', 'largestSymbolShare', 0.4001],
  ['non-positive PnL without best trade', 'netPnlWithoutBestTrade', 0]
]) {
  test(`${name} fails the email release gate`, () => {
    const result = evaluateEmailSignalRelease(validInput({ [field]: value }));
    const gateNames = {
      validatedSignals: 'minimumValidatedSignals',
      validationDays: 'minimumValidationSpan',
      netExpectancyBps: 'netExpectancyPositive',
      netProfitFactor: 'netProfitFactor',
      maxMtmDrawdownPct: 'mtmDrawdown',
      distinctSymbols: 'distinctSymbols',
      largestSymbolShare: 'symbolConcentration',
      netPnlWithoutBestTrade: 'positiveWithoutBestTrade'
    };
    assert.equal(result.state, field === 'validatedSignals' || field === 'validationDays'
      ? 'EMAIL_SIGNAL_CANDIDATE'
      : 'RESEARCH_ONLY');
    assert.equal(result.hardGates[gateNames[field]].pass, false);
  });
}

test('monthly independence is deferred before 90 validation days', () => {
  const result = evaluateEmailSignalRelease(validInput({ validationDays: 53 }));
  assert.equal(result.state, 'EMAIL_SIGNAL_CANDIDATE');
  assert.equal(result.monthlyRobustness.status, 'DEFERRED');
  assert.equal(result.monthlyRobustness.evaluable, false);
  assert.equal(result.monthlyRobustness.monthlyIndependenceEvaluable, false);
  assert.equal(result.monthlyRobustness.bestMonth, '2026-01');
  assert.equal(result.monthlyRobustness.bestMonthNetPnl, 60);
  assert.equal(result.monthlyRobustness.netPnlWithoutBestMonth, 40);
  assert.equal(result.hardGates.monthlyIndependence.pass, null);
});

test('90-day monthly independence fails when the best month is removed', () => {
  const result = evaluateEmailSignalRelease(validInput({
    validationDays: 90,
    activeMonths: [
      { month: '2026-01', baseCostNetPnl: 100 },
      { month: '2026-02', baseCostNetPnl: -100 }
    ]
  }));
  assert.equal(result.state, 'RESEARCH_ONLY');
  assert.equal(result.monthlyRobustness.status, 'FAIL');
  assert.equal(result.monthlyRobustness.netPnlWithoutBestMonth, -100);
  assert.equal(result.hardGates.monthlyIndependence.pass, false);
});

test('90-day monthly independence passes when the best month is removed and PnL remains positive', () => {
  const result = evaluateEmailSignalRelease(validInput({ validationDays: 90 }));
  assert.equal(result.state, 'EMAIL_SIGNAL_RELEASE_READY');
  assert.equal(result.monthlyRobustness.status, 'PASS');
  assert.equal(result.monthlyRobustness.netPnlWithoutBestMonth, 40);
  assert.equal(result.hardGates.monthlyIndependence.pass, true);
});

test('negative 27bps stress is a warning, not a veto', () => {
  const result = evaluateEmailSignalRelease(validInput({ stressNetExpectancyBps: -1 }));
  assert.equal(result.state, 'EMAIL_SIGNAL_RELEASE_READY');
  assert.equal(result.warnings.COST_STRESS_WARNING, true);
});

test('loss streak above six is a warning, not a veto', () => {
  const result = evaluateEmailSignalRelease(validInput({ maxLossStreak: 7 }));
  assert.equal(result.state, 'EMAIL_SIGNAL_RELEASE_READY');
  assert.equal(result.warnings.LOSS_STREAK_WARNING, true);
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

test('the committed HY-EXP-0028 evaluation is machine-readable and candidate-only', () => {
  const artifact = JSON.parse(fs.readFileSync(
    new URL('../artifacts/HY-EXP-0028/email-signal-release-evaluation.json', import.meta.url),
    'utf8'
  ));
  assert.equal(artifact.status, 'EMAIL_SIGNAL_CANDIDATE');
  assert.equal(artifact.releaseEligible, false);
  assert.equal(artifact.immutableSource.rewritten, false);
  assert.equal(artifact.authorization.liveOrdersEnabled, false);
  assert.equal(artifact.hardGates.monthlyIndependence.status, 'DEFERRED');
  assert.equal(artifact.hardGates.monthlyIndependence.pass, null);
  assert.equal(artifact.monthlyRobustness.monthlyIndependenceEvaluable, false);
});

test('HY-EXP-0028 remains an email candidate under the new policy', () => {
  const result = evaluateEmailSignalRelease({
    experimentId: 'HY-EXP-0028',
    source,
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
  });
  assert.equal(result.state, 'EMAIL_SIGNAL_CANDIDATE');
  assert.deepEqual(result.hardGateFailures, ['minimumValidatedSignals', 'minimumValidationSpan']);
  assert.equal(result.warnings.COST_STRESS_WARNING, true);
  assert.equal(result.warnings.LOSS_STREAK_WARNING, true);
  assert.equal(result.source.status, 'HOLDOUT_FAILED');
});
