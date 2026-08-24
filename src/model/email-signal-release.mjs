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
  researchEquityUsdt: 100000,
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

function finiteOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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
    bytes: file.bytes,
    detail: pass ? 'immutable source bytes and frozen provenance verified' : failures.join('; ')
  };
}

function artifactNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function deriveCandidateActiveMonths(trades) {
  const totals = new Map();
  const counts = new Map();
  for (const trade of trades) {
    const decisionTime = artifactNumber(trade?.decisionTime);
    const netPnl = artifactNumber(trade?.netPnl);
    if (decisionTime === null || netPnl === null) return { activeMonths: null, error: 'trade decisionTime/netPnl is not finite' };
    const date = new Date(decisionTime);
    if (!Number.isFinite(date.getTime())) return { activeMonths: null, error: 'trade decisionTime is invalid' };
    const month = date.toISOString().slice(0, 7);
    totals.set(month, (totals.get(month) ?? 0) + netPnl);
    counts.set(month, (counts.get(month) ?? 0) + 1);
  }
  return {
    activeMonths: [...totals.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([month, baseCostNetPnl]) => ({
        month,
        advisories: counts.get(month),
        baseCostNetPnl,
        positive: baseCostNetPnl > 0
      })),
    error: null
  };
}

function deriveCandidateMetrics(verifiedBytes, policy) {
  if (!verifiedBytes) {
    return {
      pass: false,
      metrics: {},
      errors: ['immutable candidate bytes are unavailable'],
      detail: 'candidate artifact metrics cannot be derived until immutable bytes are verified'
    };
  }
  let artifact;
  try {
    artifact = JSON.parse(verifiedBytes.toString('utf8'));
  } catch {
    return {
      pass: false,
      metrics: {},
      errors: ['candidate artifact is invalid JSON'],
      detail: 'candidate artifact metrics cannot be derived from invalid JSON'
    };
  }

  const expected = frozenCandidate(policy);
  const raw = artifact?.metrics ?? {};
  const errors = [];
  if (artifact?.experimentId !== expected.experimentId) errors.push('candidate artifact experimentId mismatch');
  if (artifact?.status !== expected.status) errors.push('candidate artifact status mismatch');

  const required = (name, value) => {
    const parsed = artifactNumber(value);
    if (parsed === null) errors.push(`candidate artifact metrics.${name} is not finite`);
    return parsed;
  };
  const advisoryCount = required('advisoryCount', raw.advisoryCount);
  const validationDays = required('holdoutWindow.exactDays', raw.holdoutWindow?.exactDays);
  const baseCostNetPnl = required('netPnl', raw.netPnl);
  const netExpectancyBps = required('net18ExpectancyBps', raw.net18ExpectancyBps);
  const netProfitFactor = required('net18ProfitFactor', raw.net18ProfitFactor);
  const stressNetExpectancyBps = required('net27ExpectancyBps', raw.net27ExpectancyBps);
  const maxMtmDrawdown = required('maxMtmDrawdown', raw.maxMtmDrawdown);
  const distinctSymbols = required('distinctSymbols', raw.distinctSymbols);
  const largestSymbolShare = required('largestSingleSymbolShare', raw.largestSingleSymbolShare);
  const maxLossStreak = required('maxLossStreak', raw.maxLossStreak);
  const bestTradeNetPnl = required('bestTrade.netPnl', raw.bestTrade?.netPnl);
  const grossExpectancyBps = required('grossExpectancyBps', raw.grossExpectancyBps);
  const stressNetProfitFactor = required('net27ProfitFactor', raw.net27ProfitFactor);
  const fundingPnl = required('fundingPnl', raw.fundingPnl);
  const maxMtmDrawdownBps = required('maxMtmDrawdownBps', raw.maxMtmDrawdownBps);
  const cvar95LossFraction = required('cvar95LossFraction', raw.cvar95LossFraction);
  const cvar95LossBps = required('cvar95LossBps', raw.cvar95LossBps);

  const trades = artifact?.trades;
  if (!Array.isArray(trades) || trades.length !== advisoryCount) {
    errors.push('candidate trade evidence count does not equal metrics.advisoryCount');
  }
  const activeMonthResult = Array.isArray(trades)
    ? deriveCandidateActiveMonths(trades)
    : { activeMonths: null, error: 'candidate trade evidence is missing' };
  if (activeMonthResult.error) errors.push(activeMonthResult.error);

  const baseCosts = new Set();
  const stressCosts = new Set();
  let fundingSeparate = true;
  for (const trade of Array.isArray(trades) ? trades : []) {
    const base = artifactNumber(trade?.costs?.baseTotalBps);
    const stress = artifactNumber(trade?.costs?.stressTotalBps);
    if (base === null || stress === null) errors.push('candidate trade cost basis is incomplete');
    else {
      baseCosts.add(base);
      stressCosts.add(stress);
    }
    if (trade?.costs?.fundingSeparate !== true) fundingSeparate = false;
  }
  if (baseCosts.size !== 1) errors.push('candidate trade base cost is not uniform');
  if (stressCosts.size !== 1) errors.push('candidate trade stress cost is not uniform');
  if (!fundingSeparate) errors.push('candidate trade funding is not recorded separately');

  const researchEquityUsdt = artifactNumber(expected.researchEquityUsdt);
  if (researchEquityUsdt === null || researchEquityUsdt <= 0) errors.push('frozen candidate research equity is invalid');
  const metrics = {
    validatedSignals: advisoryCount,
    validationDays,
    baseCostBps: baseCosts.size === 1 ? [...baseCosts][0] : null,
    baseCostNetPnl,
    grossExpectancyBps,
    netExpectancyBps,
    netProfitFactor,
    stressCostBps: stressCosts.size === 1 ? [...stressCosts][0] : null,
    stressNetExpectancyBps,
    stressNetProfitFactor,
    maxMtmDrawdownPct: maxMtmDrawdown === null ? null : maxMtmDrawdown * 100,
    maxMtmDrawdown,
    maxMtmDrawdownBps,
    cvar95LossFraction,
    cvar95LossBps,
    distinctSymbols,
    largestSymbolShare,
    netPnlWithoutBestTrade: baseCostNetPnl === null || bestTradeNetPnl === null
      ? null
      : baseCostNetPnl - bestTradeNetPnl,
    activeMonths: activeMonthResult.activeMonths,
    maxLossStreak,
    fundingPnl,
    researchEquityUsdt,
    tradeCount: advisoryCount,
    fundingSeparate
  };
  return {
    pass: errors.length === 0,
    metrics,
    errors,
    detail: errors.length === 0
      ? 'release metrics derived from verified HY-EXP-0028 artifact bytes and trade evidence'
      : errors.join('; ')
  };
}

function normalizeActiveMonths(value) {
  if (!Array.isArray(value)) return null;
  const totals = new Map();
  for (const row of value) {
    if (!/^\d{4}-\d{2}$/.test(row?.month ?? '')) return null;
    const pnl = artifactNumber(row?.baseCostNetPnl);
    if (pnl === null) return null;
    totals.set(row.month, (totals.get(row.month) ?? 0) + pnl);
  }
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([month, baseCostNetPnl]) => ({ month, baseCostNetPnl }));
}

function approximatelyEqual(left, right) {
  return typeof left === 'number'
    && typeof right === 'number'
    && Number.isFinite(left)
    && Number.isFinite(right)
    && Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right));
}

const CANDIDATE_ASSERTION_FIELDS = Object.freeze([
  'validatedSignals',
  'validationDays',
  'baseCostBps',
  'baseCostNetPnl',
  'grossExpectancyBps',
  'netExpectancyBps',
  'netProfitFactor',
  'stressCostBps',
  'stressNetExpectancyBps',
  'stressNetProfitFactor',
  'maxMtmDrawdownPct',
  'distinctSymbols',
  'largestSymbolShare',
  'netPnlWithoutBestTrade',
  'activeMonths',
  'maxLossStreak',
  'researchEquityUsdt',
  'tradeCount',
  'maxMtmDrawdown',
  'maxMtmDrawdownBps',
  'cvar95LossFraction',
  'cvar95LossBps',
  'fundingPnl',
  'fundingSeparate'
]);

function assertCandidateMetrics(callerMetrics, derivedMetrics) {
  const failures = [];
  const assertedFields = [];
  const caller = callerMetrics ?? {};
  for (const field of CANDIDATE_ASSERTION_FIELDS) {
    const provided = Object.prototype.hasOwnProperty.call(caller, field);
    if (!provided) continue;
    assertedFields.push(field);
    const actual = caller[field];
    const expected = derivedMetrics?.[field];
    if (field === 'activeMonths') {
      const actualMonths = normalizeActiveMonths(actual);
      const expectedMonths = normalizeActiveMonths(expected);
      if (!actualMonths || !expectedMonths || JSON.stringify(actualMonths) !== JSON.stringify(expectedMonths)) {
        failures.push(`${field} disagrees with verified artifact`);
      }
    } else if (field === 'fundingSeparate') {
      if (actual !== expected) failures.push(`${field} disagrees with verified artifact`);
    } else if (!approximatelyEqual(actual, expected)) {
      failures.push(`${field} disagrees with verified artifact`);
    }
  }
  for (const requiredField of ['baseCostBps', 'stressCostBps']) {
    if (!Object.prototype.hasOwnProperty.call(caller, requiredField)) {
      failures.push(`${requiredField} assertion is required`);
    }
  }
  return {
    pass: failures.length === 0,
    assertedFields,
    failures,
    detail: failures.length === 0
      ? 'caller release metrics are assertions consistent with verified artifact bytes'
      : failures.join('; ')
  };
}

function verifyValidatedBaseline(policy) {
  const configured = policy.frozenEvidence?.validatedBaseline ?? DEFAULT_VALIDATED_BASELINE;
  const baselineRoot = configured.root ?? PROJECT_ROOT;
  const manifestFile = readHashedFile(baselineRoot, configured.manifestPath);
  const errors = [];
  let manifest = null;
  let result = null;
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
  if (!resultFile.error) {
    try {
      result = JSON.parse(resultFile.bytes.toString('utf8'));
    } catch {
      errors.push('baseline result is invalid JSON');
    }
  }
  const resultHashMatches = resultFile.sha256 === source.resultArtifactSha256;
  const dataManifestHashMatches = dataManifestFile.sha256 === source.dataManifestSha256;
  if (!resultFile.error && !resultHashMatches) errors.push('baseline result SHA-256 mismatch');
  if (!dataManifestFile.error && !dataManifestHashMatches) errors.push('baseline data manifest SHA-256 mismatch');
  const identityMatches = manifest?.baselineExperimentId === configured.experimentId
    && manifest?.baselineExperimentId === 'HY-EXP-0019'
    && result?.experimentId === 'HY-EXP-0019'
    && source.sourceCommit === '9d6b5298fab9760a611c2b5e52e86c500a6688a1'
    && source.frozenAtCommit === '9f23475802f3ca9a85957a5ab2e69ac42b0c1aa2'
    && source.provenanceMode === 'ORIGINAL_IMMUTABLE_HISTORY_REFERENCE'
    && manifest?.validation?.windowStart === '2025-07-01T00:00:00.000Z'
    && manifest?.validation?.windowEndExclusive === '2026-07-01T00:00:00.000Z';
  if (!identityMatches) errors.push('baseline identity or validation window mismatch');
  const validation = manifest?.validation ?? {};
  const oos = result?.oos ?? {};
  const derivedMetrics = {
    tradeCount: artifactNumber(oos.tradeCount),
    netProfitFactor: artifactNumber(oos.netProfitFactor),
    netReturn: artifactNumber(oos.netReturn),
    netReturnBps: artifactNumber(oos.netReturnBps),
    markToMarketDrawdown: artifactNumber(oos.markToMarketDrawdown),
    positiveMonths: artifactNumber(oos.positiveMonths),
    observedMonths: artifactNumber(oos.observedMonths),
    researchEquityUsdt: artifactNumber(validation.researchEquityUsdt)
  };
  derivedMetrics.normalizedNetBpsPerTrade = derivedMetrics.tradeCount > 0
    && derivedMetrics.netReturnBps !== null
    ? derivedMetrics.netReturnBps / derivedMetrics.tradeCount
    : null;
  const metricsValid = derivedMetrics.tradeCount !== null
    && derivedMetrics.tradeCount > 0
    && derivedMetrics.netProfitFactor !== null
    && derivedMetrics.netReturn !== null
    && derivedMetrics.netReturnBps !== null
    && derivedMetrics.markToMarketDrawdown !== null
    && derivedMetrics.positiveMonths !== null
    && derivedMetrics.observedMonths !== null
    && derivedMetrics.researchEquityUsdt !== null
    && derivedMetrics.researchEquityUsdt > 0
    && derivedMetrics.normalizedNetBpsPerTrade !== null;
  if (!metricsValid) errors.push('baseline comparable metrics are incomplete in verified result.json');
  const manifestMetrics = manifest?.metrics ?? {};
  const manifestMetricComparisons = {
    tradeCount: approximatelyEqual(Number(validation.tradeCount), derivedMetrics.tradeCount),
    researchEquityUsdt: approximatelyEqual(Number(validation.researchEquityUsdt), derivedMetrics.researchEquityUsdt),
    netProfitFactor: approximatelyEqual(Number(manifestMetrics.netProfitFactor), derivedMetrics.netProfitFactor),
    netReturn: approximatelyEqual(Number(manifestMetrics.netReturn), derivedMetrics.netReturn),
    netReturnBps: approximatelyEqual(Number(manifestMetrics.netReturnBps), derivedMetrics.netReturnBps),
    normalizedNetBpsPerTrade: approximatelyEqual(Number(manifestMetrics.normalizedNetBpsPerTrade), derivedMetrics.normalizedNetBpsPerTrade),
    markToMarketDrawdown: approximatelyEqual(Number(manifestMetrics.markToMarketDrawdown), derivedMetrics.markToMarketDrawdown),
    positiveMonths: approximatelyEqual(Number(manifestMetrics.positiveMonths), derivedMetrics.positiveMonths),
    observedMonths: approximatelyEqual(Number(manifestMetrics.observedMonths), derivedMetrics.observedMonths)
  };
  if (Object.values(manifestMetricComparisons).some((pass) => !pass)) {
    errors.push('baseline manifest metrics do not match verified result.json');
  }
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
    manifestMetricsDerivedFromResult: true,
    manifestMetricComparisons,
    errors,
    metrics: {
      ...derivedMetrics,
      equityBpsPerTrade: derivedMetrics.normalizedNetBpsPerTrade,
      costBasis: manifest?.costBasis ?? null
    },
    manifest
  };
}

function compareValidatedBaseline(metrics, policy, candidateMetricsVerified) {
  const baseline = verifyValidatedBaseline(policy);
  const tradeCount = finiteOrNull(metrics?.tradeCount ?? metrics?.validatedSignals);
  const researchEquityUsdt = finiteOrNull(metrics?.researchEquityUsdt);
  const baseCostNetPnl = finiteOrNull(metrics?.baseCostNetPnl);
  const netProfitFactor = finiteOrNull(metrics?.netProfitFactor);
  const candidateMetrics = {
    baseCostNetPnl,
    netExpectancyBps: finiteOrNull(metrics?.netExpectancyBps),
    netProfitFactor,
    tradeCount,
    researchEquityUsdt,
    equityBpsPerTrade: baseCostNetPnl !== null
      && researchEquityUsdt !== null
      && researchEquityUsdt > 0
      && tradeCount !== null
      && tradeCount > 0
      ? (baseCostNetPnl / researchEquityUsdt) * 10000 / tradeCount
      : null
  };
  const comparisons = {
    candidateBaseCostNetResultPositive: candidateMetrics.baseCostNetPnl > 0,
    baselineFrozenNetResultNegative: baseline.metrics.netReturn < 0,
    candidateProfitFactorGreater: candidateMetrics.netProfitFactor > baseline.metrics.netProfitFactor,
    candidateEquityBpsPerTradeGreater: candidateMetrics.equityBpsPerTrade > baseline.metrics.equityBpsPerTrade
  };
  const pass = candidateMetricsVerified
    && baseline.provenanceVerified
    && Object.values(comparisons).every(Boolean);
  return {
    pass,
    baselineExperimentId: 'HY-EXP-0019',
    provenance: baseline,
    candidateMetrics,
    baselineMetrics: baseline.metrics,
    comparisons,
    detail: pass
      ? 'candidate is positive after its frozen costs and improves every compatible baseline metric'
      : 'candidate artifact metrics, baseline provenance, and compatible equity-normalized metrics must be verified before comparison can pass'
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

function costBasisGates(callerMetrics, derivedMetrics, policy) {
  const callerBaseCostBps = callerMetrics?.baseCostBps;
  const callerStressCostBps = callerMetrics?.stressCostBps;
  const artifactBaseCostBps = derivedMetrics?.baseCostBps;
  const artifactStressCostBps = derivedMetrics?.stressCostBps;
  return {
    baseCostBasis: gate(
      typeof callerBaseCostBps === 'number'
        && Number.isFinite(callerBaseCostBps)
        && callerBaseCostBps === policy.hardGates.baseCostBps
        && artifactBaseCostBps === policy.hardGates.baseCostBps,
      `caller and verified artifact baseCostBps must equal frozen ${policy.hardGates.baseCostBps}`
    ),
    stressCostBasis: gate(
      typeof callerStressCostBps === 'number'
        && Number.isFinite(callerStressCostBps)
        && callerStressCostBps === policy.warnings.stressCostBps
        && artifactStressCostBps === policy.warnings.stressCostBps,
      `caller and verified artifact stressCostBps must equal frozen ${policy.warnings.stressCostBps}`
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
  const callerMetrics = input?.metrics ?? {};
  const integrity = input?.integrity ?? {};
  const safety = input?.safety ?? {};

  const sourceArtifactPath = source.artifactPath ?? null;

  const sourceVerificationWithBytes = verifyImmutableSource(source, policy);
  const artifactDerivedMetrics = deriveCandidateMetrics(
    sourceVerificationWithBytes.pass ? sourceVerificationWithBytes.bytes : null,
    policy
  );
  const { bytes: _verifiedCandidateBytes, ...sourceVerification } = sourceVerificationWithBytes;
  const metrics = artifactDerivedMetrics.pass ? artifactDerivedMetrics.metrics : {};
  const callerMetricAssertions = assertCandidateMetrics(callerMetrics, metrics);
  const safetyChecks = safetyGates(safety);
  const integrityChecks = integrityGates(integrity);
  const costChecks = costBasisGates(callerMetrics, metrics, policy);
  const monthlyCheck = monthlyRobustness(metrics, policy);
  const baselineComparison = compareValidatedBaseline(metrics, policy, artifactDerivedMetrics.pass);
  const validatedSignals = finiteOrNull(metrics.validatedSignals);
  const validationDays = finiteOrNull(metrics.validationDays);
  const baseCostNetPnl = finiteOrNull(metrics.baseCostNetPnl);
  const netExpectancyBps = finiteOrNull(metrics.netExpectancyBps);
  const netProfitFactor = finiteOrNull(metrics.netProfitFactor);
  const maxMtmDrawdownPct = finiteOrNull(metrics.maxMtmDrawdownPct);
  const distinctSymbols = finiteOrNull(metrics.distinctSymbols);
  const largestSymbolShare = finiteOrNull(metrics.largestSymbolShare);
  const netPnlWithoutBestTrade = finiteOrNull(metrics.netPnlWithoutBestTrade);
  const stressNetExpectancyBps = finiteOrNull(metrics.stressNetExpectancyBps);
  const maxLossStreak = finiteOrNull(metrics.maxLossStreak);
  const hardGates = {
    ...safetyChecks,
    ...integrityChecks,
    ...costChecks,
    artifactDerivedMetrics: gate(
      artifactDerivedMetrics.pass,
      artifactDerivedMetrics.detail
    ),
    callerMetricsMatchArtifact: gate(
      callerMetricAssertions.pass,
      callerMetricAssertions.detail
    ),
    immutableSourceVerified: gate(
      sourceVerification.pass,
      sourceVerification.detail
    ),
    betterThanValidatedBaseline: gate(
      baselineComparison.pass,
      baselineComparison.detail
    ),
    minimumValidatedSignals: gate(
      validatedSignals !== null && validatedSignals >= policy.hardGates.minimumValidatedSignals,
      `requires >= ${policy.hardGates.minimumValidatedSignals} independent validated signals`
    ),
    minimumValidationSpan: gate(
      validationDays !== null && validationDays >= policy.hardGates.minimumValidationDays,
      `requires >= ${policy.hardGates.minimumValidationDays} calendar days`
    ),
    baseCostNetPnlPositive: gate(
      costChecks.baseCostBasis.pass
        && baseCostNetPnl !== null
        && baseCostNetPnl > policy.hardGates.minimumBaseCostNetPnl,
      costChecks.baseCostBasis.pass
        ? `base-cost net PnL must be > ${policy.hardGates.minimumBaseCostNetPnl}`
        : 'base-cost net PnL is unavailable until baseCostBps matches the frozen policy'
    ),
    netExpectancyPositive: gate(
      costChecks.baseCostBasis.pass
        && netExpectancyBps !== null
        && netExpectancyBps > policy.hardGates.minimumNetExpectancyBps,
      costChecks.baseCostBasis.pass
        ? `net expectancy at ${policy.hardGates.baseCostBps}bps must be > ${policy.hardGates.minimumNetExpectancyBps}bps`
        : 'net expectancy is unavailable until baseCostBps matches the frozen policy'
    ),
    netProfitFactor: gate(
      costChecks.baseCostBasis.pass
        && netProfitFactor !== null
        && netProfitFactor >= policy.hardGates.minimumProfitFactor,
      costChecks.baseCostBasis.pass
        ? `net PF at ${policy.hardGates.baseCostBps}bps must be >= ${policy.hardGates.minimumProfitFactor}`
        : 'net profit factor is unavailable until baseCostBps matches the frozen policy'
    ),
    mtmDrawdown: gate(
      maxMtmDrawdownPct !== null && maxMtmDrawdownPct <= policy.hardGates.maximumMtmDrawdownPct,
      `max MTM DD must be <= ${policy.hardGates.maximumMtmDrawdownPct}%`
    ),
    distinctSymbols: gate(
      distinctSymbols !== null && distinctSymbols >= policy.hardGates.minimumDistinctSymbols,
      `requires >= ${policy.hardGates.minimumDistinctSymbols} distinct symbols`
    ),
    symbolConcentration: gate(
      largestSymbolShare !== null && largestSymbolShare <= policy.hardGates.maximumLargestSymbolShare,
      `largest symbol share must be <= ${policy.hardGates.maximumLargestSymbolShare * 100}%`
    ),
    positiveWithoutBestTrade: gate(
      netPnlWithoutBestTrade !== null && netPnlWithoutBestTrade > 0,
      'net PnL must remain positive after removing the best trade'
    )
  };

  const warnings = {
    COST_STRESS_WARNING: costChecks.stressCostBasis.pass
      && stressNetExpectancyBps !== null
      && stressNetExpectancyBps <= 0,
    LOSS_STREAK_WARNING: maxLossStreak !== null
      && maxLossStreak > policy.warnings.lossStreakWarningAbove,
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
    artifactDerivedMetrics,
    callerMetricAssertions,
    metrics,
    baselineComparison,
    hardGates,
    hardGateFailures: hardFailures,
    monthlyRobustness: monthlyCheck,
    costBasis: {
      baseCostBps: metrics.baseCostBps ?? null,
      stressCostBps: metrics.stressCostBps ?? null,
      assertedBaseCostBps: callerMetrics.baseCostBps ?? null,
      assertedStressCostBps: callerMetrics.stressCostBps ?? null,
      expectedBaseCostBps: policy.hardGates.baseCostBps,
      expectedStressCostBps: policy.warnings.stressCostBps,
      checks: costChecks
    },
    warnings,
    safety: safetyChecks,
    noAutomaticTradingPermission: true,
    evaluatedArtifactIsDerived: artifactDerivedMetrics.pass
  };
}
