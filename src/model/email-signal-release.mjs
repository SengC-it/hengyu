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

function deferredGate(detail, fields = {}) {
  return {
    pass: null,
    status: 'DEFERRED',
    evaluable: false,
    detail,
    ...fields
  };
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

function costBasisGates(metrics, policy) {
  const baseCostBps = metrics?.baseCostBps;
  const stressCostBps = metrics?.stressCostBps;
  return {
    baseCostBasis: gate(
      typeof baseCostBps === 'number'
        && Number.isFinite(baseCostBps)
        && baseCostBps === policy.hardGates.baseCostBps,
      `metrics.baseCostBps must equal frozen ${policy.hardGates.baseCostBps}`
    ),
    stressCostBasis: gate(
      typeof stressCostBps === 'number'
        && Number.isFinite(stressCostBps)
        && stressCostBps === policy.warnings.stressCostBps,
      `metrics.stressCostBps must equal frozen ${policy.warnings.stressCostBps}`
    )
  };
}

function aggregateMonthlyBaseCostPnl(activeMonths) {
  if (!Array.isArray(activeMonths) || activeMonths.length === 0) return null;
  const totals = new Map();
  for (const row of activeMonths) {
    if (!/^\d{4}-\d{2}$/.test(row?.month ?? '')) return null;
    const pnl = Number(row?.baseCostNetPnl);
    if (!Number.isFinite(pnl)) return null;
    totals.set(row.month, (totals.get(row.month) ?? 0) + pnl);
  }
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([month, baseCostNetPnl]) => ({ month, baseCostNetPnl }));
}

function monthlyRobustness(metrics, policy) {
  const minimumDays = policy.hardGates.minimumValidationDays;
  const validationDays = Number(metrics?.validationDays);
  const activeMonths = aggregateMonthlyBaseCostPnl(metrics?.activeMonths);
  if (!Number.isFinite(validationDays) || validationDays < minimumDays) {
    const total = activeMonths?.reduce((sum, row) => sum + row.baseCostNetPnl, 0) ?? null;
    const best = activeMonths?.length
      ? [...activeMonths].sort((left, right) => right.baseCostNetPnl - left.baseCostNetPnl)[0]
      : null;
    return deferredGate(
      `monthly robustness is deferred until validation reaches ${minimumDays} days`,
      {
        activeMonths: activeMonths ?? [],
        bestMonth: best?.month ?? null,
        bestMonthNetPnl: best?.baseCostNetPnl ?? null,
        netPnlWithoutBestMonth: best == null ? null : total - best.baseCostNetPnl,
        monthlyIndependenceEvaluable: false
      }
    );
  }
  if (!activeMonths?.length) {
    return {
      pass: false,
      status: 'NOT_EVALUABLE',
      evaluable: false,
      activeMonths: [],
      bestMonth: null,
      bestMonthNetPnl: null,
      netPnlWithoutBestMonth: null,
      monthlyIndependenceEvaluable: false,
      detail: 'at least 90 validation days require auditable calendar-month base-cost PnL'
    };
  }
  const total = activeMonths.reduce((sum, row) => sum + row.baseCostNetPnl, 0);
  const best = [...activeMonths]
    .sort((left, right) => right.baseCostNetPnl - left.baseCostNetPnl || left.month.localeCompare(right.month))[0];
  const netPnlWithoutBestMonth = total - best.baseCostNetPnl;
  const pass = netPnlWithoutBestMonth > 0;
  return {
    pass,
    status: pass ? 'PASS' : 'FAIL',
    evaluable: true,
    activeMonths,
    bestMonth: best.month,
    bestMonthNetPnl: best.baseCostNetPnl,
    netPnlWithoutBestMonth,
    monthlyIndependenceEvaluable: true,
    detail: 'remove the highest-PnL calendar month; remaining base-cost net PnL must be > 0'
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
  const costChecks = costBasisGates(metrics, policy);
  const monthlyCheck = monthlyRobustness(metrics, policy);
  const hardGates = {
    ...safetyChecks,
    ...integrityChecks,
    ...costChecks,
    minimumValidatedSignals: gate(
      finite('validated signals', metrics.validatedSignals) >= policy.hardGates.minimumValidatedSignals,
      `requires >= ${policy.hardGates.minimumValidatedSignals} independent validated signals`
    ),
    minimumValidationSpan: gate(
      finite('validation days', metrics.validationDays) >= policy.hardGates.minimumValidationDays,
      `requires >= ${policy.hardGates.minimumValidationDays} calendar days`
    ),
    baseCostNetPnlPositive: gate(
      costChecks.baseCostBasis.pass
        && finite('base-cost net PnL', metrics.baseCostNetPnl) > policy.hardGates.minimumBaseCostNetPnl,
      costChecks.baseCostBasis.pass
        ? `base-cost net PnL must be > ${policy.hardGates.minimumBaseCostNetPnl}`
        : 'base-cost net PnL is unavailable until baseCostBps matches the frozen policy'
    ),
    netExpectancyPositive: gate(
      costChecks.baseCostBasis.pass
        && finite('net expectancy', metrics.netExpectancyBps) > policy.hardGates.minimumNetExpectancyBps,
      costChecks.baseCostBasis.pass
        ? `net expectancy at ${policy.hardGates.baseCostBps}bps must be > ${policy.hardGates.minimumNetExpectancyBps}bps`
        : 'net expectancy is unavailable until baseCostBps matches the frozen policy'
    ),
    netProfitFactor: gate(
      costChecks.baseCostBasis.pass
        && finite('net profit factor', metrics.netProfitFactor) >= policy.hardGates.minimumProfitFactor,
      costChecks.baseCostBasis.pass
        ? `net PF at ${policy.hardGates.baseCostBps}bps must be >= ${policy.hardGates.minimumProfitFactor}`
        : 'net profit factor is unavailable until baseCostBps matches the frozen policy'
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
    monthlyIndependence: monthlyCheck
  };

  const warnings = {
    COST_STRESS_WARNING: costChecks.stressCostBasis.pass
      && finite('stress net expectancy', metrics.stressNetExpectancyBps) < 0,
    LOSS_STREAK_WARNING: finite('maximum loss streak', metrics.maxLossStreak) > policy.warnings.lossStreakWarningAbove
  };

  const hardFailures = Object.entries(hardGates)
    .filter(([, result]) => result.pass === false)
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
    monthlyRobustness: monthlyCheck,
    costBasis: {
      baseCostBps: metrics.baseCostBps ?? null,
      stressCostBps: metrics.stressCostBps ?? null,
      expectedBaseCostBps: policy.hardGates.baseCostBps,
      expectedStressCostBps: policy.warnings.stressCostBps,
      checks: costChecks
    },
    warnings,
    safety: safetyChecks,
    noAutomaticTradingPermission: true,
    evaluatedArtifactIsDerived: true
  };
}
