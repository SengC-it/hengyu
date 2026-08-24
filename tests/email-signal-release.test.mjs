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
  netExpectancyBps: 4,
  netProfitFactor: 1.2,
  stressNetExpectancyBps: 1,
  maxMtmDrawdownPct: 8,
  distinctSymbols: 8,
  largestSymbolShare: 0.2,
  netPnlWithoutBestTrade: 80,
  positiveActiveMonthShare: 0.75,
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

test('positive active-month share is a fixed hard gate', () => {
  const result = evaluateEmailSignalRelease(validInput({ positiveActiveMonthShare: 0.49 }));
  assert.equal(result.state, 'RESEARCH_ONLY');
  assert.equal(result.hardGates.monthlyIndependence.pass, false);
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

test('the committed HY-EXP-0028 evaluation is machine-readable and candidate-only', () => {
  const artifact = JSON.parse(fs.readFileSync(
    new URL('../artifacts/HY-EXP-0028/email-signal-release-evaluation.json', import.meta.url),
    'utf8'
  ));
  assert.equal(artifact.status, 'EMAIL_SIGNAL_CANDIDATE');
  assert.equal(artifact.releaseEligible, false);
  assert.equal(artifact.immutableSource.rewritten, false);
  assert.equal(artifact.authorization.liveOrdersEnabled, false);
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
      netExpectancyBps: 5.237781100313037,
      netProfitFactor: 1.1506895886413784,
      stressNetExpectancyBps: -3.7622188996869474,
      maxMtmDrawdownPct: 7.723556081371896,
      distinctSymbols: 8,
      largestSymbolShare: 0.20930232558139536,
      netPnlWithoutBestTrade: 4.4107091824917,
      positiveActiveMonthShare: 0.5,
      maxLossStreak: 12
    }
  });
  assert.equal(result.state, 'EMAIL_SIGNAL_CANDIDATE');
  assert.deepEqual(result.hardGateFailures, ['minimumValidatedSignals', 'minimumValidationSpan']);
  assert.equal(result.warnings.COST_STRESS_WARNING, true);
  assert.equal(result.warnings.LOSS_STREAK_WARNING, true);
  assert.equal(result.source.status, 'HOLDOUT_FAILED');
});
