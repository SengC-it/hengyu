import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  HY_EXP_0028_FROZEN_Q75,
  HY_EXP_0028_POLICY_ID,
  HY_EXP_0028_SOURCE_COMMIT,
  HY_EXP_0028_SYMBOLS
} from '../validation/hy-val-0028-001.mjs';

const CONFIG_PATH = fileURLToPath(new URL('../../config/email-signal-cutover.json', import.meta.url));
const RAW_CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export const EMAIL_SIGNAL_CUTOVER_CONFIG = deepFreeze(RAW_CONFIG);
export const EMAIL_SIGNAL_CUTOVER_CONFIG_PATH = CONFIG_PATH;

const REQUIRED_SAFETY = Object.freeze({
  signal_only: true,
  authorization_mode: 'PAPER_ONLY',
  live_orders_enabled: false,
  account_api: false,
  order_api: false,
  automatic_trading: false,
  final_oos_read: false,
  shadow_activated: false
});

function finiteTimestamp(value) {
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sameArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function safetyMatches(safety) {
  return safety && Object.entries(REQUIRED_SAFETY).every(([key, value]) => safety[key] === value);
}

export function isEmailSignalCutoverConfigValid(config = EMAIL_SIGNAL_CUTOVER_CONFIG) {
  if (!config || config.immutable !== true) return false;
  const expectedStatus = {
    EMAIL_SIGNAL_RELEASE_READY: 'DRAFT_CUTOVER_PREPARED',
    EMAIL_SIGNAL_RELEASED: 'CUTOVER_RELEASED'
  }[config.releaseState];
  if (!expectedStatus || config.status !== expectedStatus) return false;
  if (config.strategyId !== 'HY-EXP-0028'
    || config.releaseStateRequiredForEmail !== 'EMAIL_SIGNAL_RELEASED'
    || config.humanApprovalRequiredForReleased !== true) return false;
  const source = config.evaluationSource;
  if (source?.policyId !== HY_EXP_0028_POLICY_ID
    || source?.policyVersion !== 2
    || source?.evaluationStatus !== 'EMAIL_SIGNAL_RELEASE_READY'
    || source?.sourceCommit !== HY_EXP_0028_SOURCE_COMMIT
    || source?.artifactPath !== 'artifacts/HY-EXP-0028/holdout-result.json'
    || source?.artifactSha256 !== '92304ec0252be9ee2bba2e13a9ccc64c923f3b067d91e12513be089d56f3d2e5') return false;
  const candidate = config.candidateEngine;
  if (candidate?.strategyId !== 'HY-EXP-0028'
    || candidate?.rule !== 'RULE_A_CHANNEL_DISTANCE_Q75'
    || candidate?.direction !== 'BULL/BUY'
    || candidate?.frozenQ75 !== HY_EXP_0028_FROZEN_Q75
    || !sameArray(candidate.symbols, HY_EXP_0028_SYMBOLS)
    || candidate.entry?.offsetMs !== 300000
    || candidate.entry?.laterBarRescue !== false
    || candidate.entry?.waitForBarClose !== false
    || candidate.entry?.maxEntryCaptureDelayMs !== 90000
    || candidate.exit?.outcomeResolutionUsedForAdmission !== false) return false;
  if (!sameArray(config.legacyEmailAuthority?.strategyIds, ['HY-EXP-0018'])
    || config.legacyEmailAuthority.emailAllowed !== false
    || config.legacyEmailAuthority.diagnosticsAllowed !== true
    || config.legacyEmailAuthority.mutuallyExclusiveWithNewAuthority !== true) return false;
  return safetyMatches(config.safety);
}

function candidateMetadata(advisory) {
  return advisory?.metadata && typeof advisory.metadata === 'object'
    ? advisory.metadata
    : {};
}

function candidateQualityIsCausal(advisory, metadata) {
  return metadata.causalDataQuality === 'PASS'
    && metadata.continuityValid === true
    && metadata.alignmentValid === true
    && metadata.outcomeDataUsedForAdmission === false
    && metadata.safety?.signal_only === true
    && metadata.safety?.authorization_mode === 'PAPER_ONLY'
    && metadata.safety?.live_orders_enabled === false
    && metadata.safety?.account_api === false
    && metadata.safety?.order_api === false
    && metadata.safety?.automatic_trading === false
    && metadata.safety?.final_oos_read === false
    && metadata.safety?.shadow_activated === false
    && advisory.authorization_mode === 'PAPER_ONLY'
    && advisory.live_orders_enabled === false;
}

export function evaluateEmailSignalAdmission({
  advisory,
  config = EMAIL_SIGNAL_CUTOVER_CONFIG,
  now = Date.now()
} = {}) {
  if (!isEmailSignalCutoverConfigValid(config)) {
    return { allowed: false, reason: 'EMAIL_CUTOVER_CONFIG_INVALID' };
  }
  const experimentId = advisory?.experiment_id ?? advisory?.experimentId;
  if (experimentId !== config.strategyId) {
    return { allowed: false, reason: 'EMAIL_STRATEGY_NOT_AUTHORIZED' };
  }
  if (config.releaseState !== config.releaseStateRequiredForEmail) {
    return { allowed: false, reason: 'EMAIL_STRATEGY_NOT_RELEASED' };
  }
  if (advisory?.status !== 'ACTIVE') {
    return { allowed: false, reason: 'EMAIL_CANDIDATE_STATUS_INVALID' };
  }
  const metadata = candidateMetadata(advisory);
  if (!HY_EXP_0028_SYMBOLS.includes(advisory?.symbol)) {
    return { allowed: false, reason: 'EMAIL_CANDIDATE_IDENTITY_INVALID' };
  }
  if (!candidateQualityIsCausal(advisory, metadata)) {
    return { allowed: false, reason: 'EMAIL_CANDIDATE_DATA_QUALITY_INVALID' };
  }
  if (metadata.strategyId !== config.strategyId
    || metadata.rule !== config.candidateEngine.rule
    || metadata.candidateAuthority !== 'EMAIL_SIGNAL_CANDIDATE'
    || metadata.candidateOnly !== true
    || metadata.policyId !== HY_EXP_0028_POLICY_ID
    || metadata.sourceCommit !== HY_EXP_0028_SOURCE_COMMIT
    || metadata.source !== 'hy-exp-0028-frozen-candidate-engine'
    || metadata.modelId !== 'HY-EXP-0028-RULE-A-EMAIL-001'
    || metadata.frozenQ75 !== config.candidateEngine.frozenQ75
    || metadata.entryReferenceSource !== 'CONTRACT_PRICE_5M_OPEN') {
    return { allowed: false, reason: 'EMAIL_CANDIDATE_IDENTITY_INVALID' };
  }
  if (advisory.advisory_type !== 'REVIEW_BUY') {
    return { allowed: false, reason: 'EMAIL_CANDIDATE_DIRECTION_INVALID' };
  }
  const signalAt = finiteTimestamp(advisory.signal_at ?? advisory.signalAt);
  const expiresAt = finiteTimestamp(advisory.expires_at ?? advisory.expiresAt);
  const currentTime = finiteTimestamp(now);
  if (signalAt === null || expiresAt === null || currentTime === null || expiresAt <= signalAt) {
    return { allowed: false, reason: 'EMAIL_CANDIDATE_TIME_INVALID' };
  }
  if (signalAt > currentTime) return { allowed: false, reason: 'EMAIL_CANDIDATE_FUTURE' };
  const candidateDecisionTime = finiteTimestamp(metadata.decisionTime);
  const entryObservedAt = finiteTimestamp(metadata.entryObservedAt);
  const entryCaptureDelayMs = Number(metadata.entryCaptureDelayMs);
  const expectedEntryTime = candidateDecisionTime === null
    ? null
    : candidateDecisionTime + config.candidateEngine.entry.offsetMs;
  if (candidateDecisionTime === null
    || signalAt !== candidateDecisionTime
    || metadata.candidateId !== `${advisory.symbol}:${candidateDecisionTime}`
    || finiteTimestamp(metadata.entryTime) !== expectedEntryTime
    || entryObservedAt === null
    || !Number.isFinite(entryCaptureDelayMs)
    || entryObservedAt !== expectedEntryTime + entryCaptureDelayMs
    || entryCaptureDelayMs < 0
    || entryCaptureDelayMs > config.candidateEngine.entry.maxEntryCaptureDelayMs
    || entryObservedAt > currentTime) {
    return { allowed: false, reason: 'EMAIL_CANDIDATE_ENTRY_PROVENANCE_INVALID' };
  }
  if (expiresAt <= currentTime) return { allowed: false, reason: 'EMAIL_SIGNAL_EXPIRED' };
  return {
    allowed: true,
    reason: null,
    strategyId: config.strategyId,
    releaseState: config.releaseState
  };
}

export function assertEmailSignalAdmission(input) {
  const result = evaluateEmailSignalAdmission(input);
  if (!result.allowed) {
    const error = new Error(result.reason);
    error.code = result.reason;
    throw error;
  }
  return result;
}
