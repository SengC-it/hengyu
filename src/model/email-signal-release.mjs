import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const POLICY_PATH = fileURLToPath(new URL('../../config/email-signal-release-policy.json', import.meta.url));
const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const POLICY = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));

const DEFAULT_FROZEN_CANDIDATE = Object.freeze({
  experimentId: 'HY-EXP-0028',
  sourceCommit: 'a61cb20318af1e0b188c0276a1a3d65e52bc4467',
  artifactPath: 'artifacts/HY-EXP-0028/holdout-result.json',
  artifactSha256: '92304ec0252be9ee2bba2e13a9ccc64c923f3b067d91e12513be089d56f3d2e5',
  status: 'HOLDOUT_FAILED'
});

const DEFAULT_VALIDATED_BASELINE = Object.freeze({
  experimentId: 'HY-EXP-0019',
  manifestPath: 'artifacts/HY-EXP-0019/baseline-manifest.json'
});

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

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function gate(pass, detail) {
  return { pass: Boolean(pass), detail };
}

function resolveWithinRoot(root, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) return null;
  const rootAbsolute = path.resolve(root);
  const absolute = path.resolve(rootAbsolute, relativePath.replaceAll('\\', '/'));
  const relative = path.relative(rootAbsolute, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return absolute;
}

function readHashedFile(root, relativePath) {
  const absolute = resolveWithinRoot(root, relativePath);
  if (!absolute) return { absolute: null, bytes: null, sha256: null, error: 'path escapes verification root' };
  try {
    const bytes = fs.readFileSync(absolute);
    return { absolute, bytes, sha256: sha256Bytes(bytes), error: null };
  } catch (error) {
    return { absolute, bytes: null, sha256: null, error: error.code === 'ENOENT' ? 'missing file' : 'unreadable file' };
  }
}

function frozenCandidate(policy) {
  return policy.frozenEvidence?.candidate ?? DEFAULT_FROZEN_CANDIDATE;
}

function verifyImmutableSource(source, policy) {
  const expected = frozenCandidate(policy);
  const artifactPath = source?.artifactPath ?? null;
  const artifactRoot = source?.artifactRoot ?? PROJECT_ROOT;
  const file = readHashedFile(artifactRoot, artifactPath);
  const pathMatches = artifactPath === expected.artifactPath;
  const commitMatches = source?.commit === expected.sourceCommit;
  const declaredHashMatches = source?.artifactSha256 === expected.artifactSha256;
  const statusMatches = source?.status === expected.status;
  const computedHashMatches = file.sha256 === expected.artifactSha256;
  const pass = pathMatches
    && commitMatches
    && declaredHashMatches
    && statusMatches
    && computedHashMatches;
  const failures = [];
  if (!pathMatches) failures.push('artifact path mismatch');
  if (!commitMatches) failures.push('source commit mismatch');
  if (!declaredHashMatches) failures.push('declared SHA-256 mismatch');
  if (!statusMatches) failures.push('source status mismatch');
  if (file.error) failures.push(file.error);
  else if (!computedHashMatches) failures.push('computed SHA-256 mismatch');
  return {
    pass,
    expectedArtifactPath: expected.artifactPath,
    expectedSha256: expected.artifactSha256,
    computedSha256: file.sha256,
    declaredSha256: source?.artifactSha256 ?? null,
    sourceCommit: source?.commit ?? null,
    resolvedPath: file.absolute,
    pathMatches,
    commitMatches,
    declaredHashMatches,
    statusMatches,
    computedHashMatches,
    detail: pass ? 'immutable source bytes and frozen provenance verified' : failures.join('; ')
  };
}

function verifyValidatedBaseline(policy) {
  const configured = policy.frozenEvidence?.validatedBaseline ?? DEFAULT_VALIDATED_BASELINE;
  const baselineRoot = configured.root ?? PROJECT_ROOT;
  const manifestFile = readHashedFile(baselineRoot, configured.manifestPath);
  const errors = [];
  let manifest = null;
  if (manifestFile.error) errors.push(manifestFile.error);
  else {
    try {
      manifest = JSON.parse(manifestFile.bytes.toString('utf8'));
    } catch {
      errors.push('baseline manifest is invalid JSON');
    }
  }
  const manifestHashMatches = manifestFile.sha256 === configured.manifestSha256
    && /^[a-f0-9]{64}$/.test(configured.manifestSha256 ?? '');
  if (!manifestHashMatches) errors.push('baseline manifest SHA-256 mismatch');
  const source = manifest?.source ?? {};
  const resultFile = readHashedFile(baselineRoot, source.resultArtifactPath);
  const dataManifestFile = readHashedFile(baselineRoot, source.dataManifestPath);
  if (resultFile.error) errors.push(`baseline result ${resultFile.error}`);
  if (dataManifestFile.error) errors.push(`baseline data manifest ${dataManifestFile.error}`);
  const resultHashMatches = resultFile.sha256 === source.resultArtifactSha256;
  const dataManifestHashMatches = dataManifestFile.sha256 === source.dataManifestSha256;
  if (!resultFile.error && !resultHashMatches) errors.push('baseline result SHA-256 mismatch');
  if (!dataManifestFile.error && !dataManifestHashMatches) errors.push('baseline data manifest SHA-256 mismatch');
  const identityMatches = manifest?.baselineExperimentId === configured.experimentId
    && manifest?.baselineExperimentId === 'HY-EXP-0019'
    && source.sourceCommit === '9d6b5298fab9760a611c2b5e52e86c500a6688a1'
    && source.frozenAtCommit === '9f23475802f3ca9a85957a5ab2e69ac42b0c1aa2'
    && source.provenanceMode === 'ORIGINAL_IMMUTABLE_HISTORY_REFERENCE'
    && manifest?.validation?.windowStart === '2025-07-01T00:00:00.000Z'
    && manifest?.validation?.windowEndExclusive === '2026-07-01T00:00:00.000Z';
  if (!identityMatches) errors.push('baseline identity or validation window mismatch');
  const validation = manifest?.validation ?? {};
  const metrics = manifest?.metrics ?? {};
  const metricsValid = Number.isFinite(Number(validation.tradeCount))
    && Number(validation.tradeCount) > 0
    && Number.isFinite(Number(metrics.netProfitFactor))
    && Number.isFinite(Number(metrics.netReturnBps))
    && Number.isFinite(Number(metrics.normalizedNetBpsPerTrade));
  if (!metricsValid) errors.push('baseline comparable metrics are incomplete');
  const provenanceVerified = errors.length === 0;
  return {
    pass: provenanceVerified,
    provenanceVerified,
    manifestPath: configured.manifestPath,
    manifestSha256: manifestFile.sha256,
    expectedManifestSha256: configured.manifestSha256 ?? null,
    resultArtifactPath: source.resultArtifactPath ?? null,
    resultArtifactSha256: source.resultArtifactSha256 ?? null,
    resultComputedSha256: resultFile.sha256,
    dataManifestComputedSha256: dataManifestFile.sha256,
    errors,
    metrics: {
      tradeCount: Number(validation.tradeCount),
      netProfitFactor: Number(metrics.netProfitFactor),
      netReturn: Number(metrics.netReturn),
      netReturnBps: Number(metrics.netReturnBps),
      normalizedNetBpsPerTrade: Number(metrics.normalizedNetBpsPerTrade),
      researchEquityUsdt: Number(validation.researchEquityUsdt),
      costBasis: manifest?.costBasis ?? null
    },
    manifest
  };
}

function compareValidatedBaseline(metrics, policy) {
  const baseline = verifyValidatedBaseline(policy);
  const candidateMetrics = {
    baseCostNetPnl: Number(metrics?.baseCostNetPnl),
    netExpectancyBps: Number(metrics?.netExpectancyBps),
    netProfitFactor: Number(metrics?.netProfitFactor),
    normalizedNetBpsPerTrade: Number(metrics?.netExpectancyBps)
  };
  const comparisons = {
    candidateBaseCostNetResultPositive: candidateMetrics.baseCostNetPnl > 0,
    baselineFrozenNetResultNegative: baseline.metrics.netReturnBps < 0,
    candidateProfitFactorGreater: candidateMetrics.netProfitFactor > baseline.metrics.netProfitFactor,
    candidateNormalizedNetBpsPerTradeGreater: candidateMetrics.normalizedNetBpsPerTrade > baseline.metrics.normalizedNetBpsPerTrade
  };
  const pass = baseline.provenanceVerified && Object.values(comparisons).every(Boolean);
  return {
    pass,
    baselineExperimentId: 'HY-EXP-0019',
    provenance: baseline,
    candidateMetrics,
    baselineMetrics: baseline.metrics,
    comparisons,
    detail: pass
      ? 'candidate is positive after its frozen costs and improves every compatible baseline metric'
      : 'baseline provenance and compatible metrics must be verified before comparison can pass'
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
  const minimumDays = policy.monthlyRobustness?.requiresValidationDays
    ?? policy.hardGates.minimumValidationDays;
  const validationDays = Number(metrics?.validationDays);
  const activeMonths = aggregateMonthlyBaseCostPnl(metrics?.activeMonths);
  const evaluable = Number.isFinite(validationDays) && validationDays >= minimumDays;
  if (!activeMonths?.length) {
    return {
      pass: null,
      status: 'NOT_EVALUABLE',
      evaluable: false,
      activeMonths: [],
      bestMonth: null,
      bestMonthNetPnl: null,
      netPnlWithoutBestMonth: null,
      monthlyIndependenceEvaluable: false,
      detail: 'auditable calendar-month base-cost PnL is required to evaluate concentration'
    };
  }
  const total = activeMonths.reduce((sum, row) => sum + row.baseCostNetPnl, 0);
  const best = [...activeMonths]
    .sort((left, right) => right.baseCostNetPnl - left.baseCostNetPnl || left.month.localeCompare(right.month))[0];
  const netPnlWithoutBestMonth = total - best.baseCostNetPnl;
  const pass = evaluable ? netPnlWithoutBestMonth > 0 : null;
  return {
    pass,
    status: netPnlWithoutBestMonth > 0
      ? (evaluable ? 'PASS' : 'NOT_EVALUABLE')
      : 'WARNING',
    evaluable,
    activeMonths,
    bestMonth: best.month,
    bestMonthNetPnl: best.baseCostNetPnl,
    netPnlWithoutBestMonth,
    monthlyIndependenceEvaluable: evaluable,
    detail: 'remove the highest-PnL calendar month; remaining base-cost net PnL is reported as a warning only'
  };
}

export function evaluateEmailSignalRelease(input, { policy = EMAIL_SIGNAL_RELEASE_POLICY } = {}) {
  const source = input?.source ?? {};
  const metrics = input?.metrics ?? {};
  const integrity = input?.integrity ?? {};
  const safety = input?.safety ?? {};

  const sourceArtifactPath = source.artifactPath ?? null;

  const sourceVerification = verifyImmutableSource(source, policy);
  const safetyChecks = safetyGates(safety);
  const integrityChecks = integrityGates(integrity);
  const costChecks = costBasisGates(metrics, policy);
  const monthlyCheck = monthlyRobustness(metrics, policy);
  const baselineComparison = compareValidatedBaseline(metrics, policy);
  const hardGates = {
    ...safetyChecks,
    ...integrityChecks,
    ...costChecks,
    immutableSourceVerified: gate(
      sourceVerification.pass,
      sourceVerification.detail
    ),
    betterThanValidatedBaseline: gate(
      baselineComparison.pass,
      baselineComparison.detail
    ),
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
    )
  };

  const warnings = {
    COST_STRESS_WARNING: costChecks.stressCostBasis.pass
      && finite('stress net expectancy', metrics.stressNetExpectancyBps) <= 0,
    LOSS_STREAK_WARNING: finite('maximum loss streak', metrics.maxLossStreak) > policy.warnings.lossStreakWarningAbove,
    MONTH_CONCENTRATION_WARNING: monthlyCheck.netPnlWithoutBestMonth != null
      && monthlyCheck.netPnlWithoutBestMonth <= 0
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
      artifactSha256: sourceVerification.computedSha256 ?? source.artifactSha256 ?? null,
      declaredArtifactSha256: source.artifactSha256 ?? null,
      commit: source.commit ?? null,
      status: source.status ?? null
    },
    immutableSourceVerification: sourceVerification,
    baselineComparison,
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
