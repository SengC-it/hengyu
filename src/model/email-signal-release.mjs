import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const POLICY_PATH = fileURLToPath(new URL('../../config/email-signal-release-policy.json', import.meta.url));
const POLICY = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export const EMAIL_SIGNAL_RELEASE_POLICY = deepFreeze(POLICY);
export const EMAIL_SIGNAL_RELEASE_POLICY_PATH = POLICY_PATH;

function finite(name, value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`invalid ${name}`);
  return parsed;
}

function requiredBoolean(name, value) {
  if (typeof value !== 'boolean') throw new Error(`missing ${name}`);
  return value;
}

function sha256(value, name) {
  if (!/^[a-f0-9]{64}$/.test(value ?? '')) throw new Error(`invalid ${name}`);
  return value;
}

function commit(value) {
  if (!/^[a-f0-9]{40}$/.test(value ?? '')) throw new Error('invalid source commit');
  return value;
}

function gate(pass, detail) {
  return { pass: Boolean(pass), detail };
}

function safetyGates(safety) {
  return {
    signalOnly: gate(requiredBoolean('safety.signalOnly', safety?.signalOnly), 'signal-only mode is required'),
    paperOnly: gate(requiredBoolean('safety.paperOnly', safety?.paperOnly), 'PAPER_ONLY is required'),
    liveOrdersDisabled: gate(safety?.liveOrdersEnabled === false, 'live order capability must be disabled'),
    accountApiDisabled: gate(safety?.accountApi === false, 'account API must be disabled'),
    orderApiDisabled: gate(safety?.orderApi === false, 'order API must be disabled'),
    automaticTradingDisabled: gate(safety?.automaticTrading === false, 'automatic trading must be disabled')
  };
}

function integrityGates(integrity) {
  return {
    noLookaheadOrLeakage: gate(requiredBoolean('integrity.noLookaheadOrLeakage', integrity?.noLookaheadOrLeakage), 'features and labels must be causal'),
    noFutureLabelsInFeatures: gate(requiredBoolean('integrity.noFutureLabelsInFeatures', integrity?.noFutureLabelsInFeatures), 'future labels must not enter features'),
    parametersFrozenBeforeValidation: gate(requiredBoolean('integrity.parametersFrozenBeforeValidation', integrity?.parametersFrozenBeforeValidation), 'parameters must be frozen before validation outcome'),
    independentHoldout: gate(requiredBoolean('integrity.independentHoldout', integrity?.independentHoldout), 'validation must be independent/fresh holdout evidence'),
    noPostOutcomeFiltering: gate(integrity?.postOutcomeFiltering === false, 'post-outcome filtering is forbidden'),
    finalOosUnread: gate(integrity?.finalOosRead === false, 'final OOS must remain unread')
  };
}

export function evaluateEmailSignalRelease(input, { policy = EMAIL_SIGNAL_RELEASE_POLICY } = {}) {
  const source = input?.source ?? {};
  const metrics = input?.metrics ?? {};
  const integrity = input?.integrity ?? {};
  const safety = input?.safety ?? {};

  const sourceArtifactSha256 = sha256(source.artifactSha256, 'source artifact SHA-256');
  const sourceCommit = commit(source.commit);
  const sourceArtifactPath = String(source.artifactPath ?? '');
  if (!sourceArtifactPath) throw new Error('missing source artifact path');

  const safetyChecks = safetyGates(safety);
  const integrityChecks = integrityGates(integrity);
  const hardGates = {
    ...safetyChecks,
    ...integrityChecks,
    minimumValidatedSignals: gate(
      finite('validated signals', metrics.validatedSignals) >= policy.hardGates.minimumValidatedSignals,
      `requires >= ${policy.hardGates.minimumValidatedSignals} independent validated signals`
    ),
    minimumValidationSpan: gate(
      finite('validation days', metrics.validationDays) >= policy.hardGates.minimumValidationDays,
      `requires >= ${policy.hardGates.minimumValidationDays} calendar days`
    ),
    baseCostNetPnlPositive: gate(
      finite('base-cost net PnL', metrics.baseCostNetPnl) > policy.hardGates.minimumBaseCostNetPnl,
      `base-cost net PnL must be > ${policy.hardGates.minimumBaseCostNetPnl}`
    ),
    netExpectancyPositive: gate(
      finite('net expectancy', metrics.netExpectancyBps) > policy.hardGates.minimumNetExpectancyBps,
      `net expectancy at ${policy.hardGates.baseCostBps}bps must be > ${policy.hardGates.minimumNetExpectancyBps}bps`
    ),
    netProfitFactor: gate(
      finite('net profit factor', metrics.netProfitFactor) >= policy.hardGates.minimumProfitFactor,
      `net PF at ${policy.hardGates.baseCostBps}bps must be >= ${policy.hardGates.minimumProfitFactor}`
    ),
    mtmDrawdown: gate(
      finite('MTM drawdown', metrics.maxMtmDrawdownPct) <= policy.hardGates.maximumMtmDrawdownPct,
      `max MTM DD must be <= ${policy.hardGates.maximumMtmDrawdownPct}%`
    ),
    distinctSymbols: gate(
      finite('distinct symbols', metrics.distinctSymbols) >= policy.hardGates.minimumDistinctSymbols,
      `requires >= ${policy.hardGates.minimumDistinctSymbols} distinct symbols`
    ),
    symbolConcentration: gate(
      finite('largest symbol share', metrics.largestSymbolShare) <= policy.hardGates.maximumLargestSymbolShare,
      `largest symbol share must be <= ${policy.hardGates.maximumLargestSymbolShare * 100}%`
    ),
    positiveWithoutBestTrade: gate(
      finite('net PnL without best trade', metrics.netPnlWithoutBestTrade) > 0,
      'net PnL must remain positive after removing the best trade'
    ),
    monthlyIndependence: gate(
      finite('positive active month share', metrics.positiveActiveMonthShare) >= policy.hardGates.minimumPositiveActiveMonthShare,
      `positive active-month share must be >= ${policy.hardGates.minimumPositiveActiveMonthShare * 100}%`
    )
  };

  const warnings = {
    COST_STRESS_WARNING: finite('stress net expectancy', metrics.stressNetExpectancyBps) < 0,
    LOSS_STREAK_WARNING: finite('maximum loss streak', metrics.maxLossStreak) > policy.warnings.lossStreakWarningAbove
  };

  const hardFailures = Object.entries(hardGates)
    .filter(([, result]) => !result.pass)
    .map(([name]) => name);
  const safetyFailure = Object.keys(safetyChecks).some(name => !safetyChecks[name].pass);
  const integrityFailure = Object.keys(integrityChecks).some(name => !integrityChecks[name].pass);
  const readinessFailures = new Set(['minimumValidatedSignals', 'minimumValidationSpan']);
  const onlyReadinessShortfall = hardFailures.length > 0
    && hardFailures.every(name => readinessFailures.has(name));
  const state = safetyFailure || integrityFailure || (hardFailures.length > 0 && !onlyReadinessShortfall)
    ? 'RESEARCH_ONLY'
    : hardFailures.length
      ? 'EMAIL_SIGNAL_CANDIDATE'
      : 'EMAIL_SIGNAL_RELEASE_READY';

  return {
    policyId: policy.policyId,
    policyVersion: policy.version,
    experimentId: input?.experimentId ?? null,
    state,
    releaseEligible: state === 'EMAIL_SIGNAL_RELEASE_READY',
    emailSignalOnly: true,
    source: {
      artifactPath: sourceArtifactPath,
      artifactSha256: sourceArtifactSha256,
      commit: sourceCommit,
      status: source.status ?? null
    },
    hardGates,
    hardGateFailures: hardFailures,
    warnings,
    safety: safetyChecks,
    noAutomaticTradingPermission: true,
    evaluatedArtifactIsDerived: true
  };
}
