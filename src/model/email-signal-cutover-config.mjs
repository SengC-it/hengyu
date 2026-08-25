import rawConfig from '../../config/email-signal-cutover.json' with { type: 'json' };
import { fileURLToPath } from 'node:url';
import {
  HY_EXP_0028_FROZEN_Q75,
  HY_EXP_0028_HOLDOUT_RESULT_SHA256,
  HY_EXP_0028_POLICY_ID,
  HY_EXP_0028_SOURCE_COMMIT,
  HY_EXP_0028_STRATEGY_ID,
  HY_EXP_0028_SYMBOLS
} from '../validation/hy-exp-0028-frozen-constants.mjs';

const CONFIG_URL = new URL('../../config/email-signal-cutover.json', import.meta.url);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export const EMAIL_SIGNAL_CUTOVER_CONFIG = deepFreeze(rawConfig);
export const EMAIL_SIGNAL_CUTOVER_CONFIG_PATH = fileURLToPath(CONFIG_URL);

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

function sameArray(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function safetyMatches(safety) {
  return safety && Object.entries(REQUIRED_SAFETY).every(([key, value]) => safety[key] === value);
}

/**
 * Validates only the release gate contract. This module intentionally has no
 * market-data, database, mail, or runner imports so READY requests can stop
 * before those dependencies are loaded.
 */
export function isLightweightEmailSignalCutoverConfigValid(config = EMAIL_SIGNAL_CUTOVER_CONFIG) {
  if (!config || config.immutable !== true) return false;
  const expectedStatus = {
    EMAIL_SIGNAL_RELEASE_READY: 'DRAFT_CUTOVER_PREPARED',
    EMAIL_SIGNAL_RELEASED: 'CUTOVER_RELEASED'
  }[config.releaseState];
  if (!expectedStatus || config.status !== expectedStatus) return false;
  if (config.strategyId !== HY_EXP_0028_STRATEGY_ID
    || config.releaseStateRequiredForEmail !== 'EMAIL_SIGNAL_RELEASED'
    || config.humanApprovalRequiredForReleased !== true) return false;

  const source = config.evaluationSource;
  if (source?.policyId !== HY_EXP_0028_POLICY_ID
    || source?.policyVersion !== 2
    || source?.evaluationStatus !== 'EMAIL_SIGNAL_RELEASE_READY'
    || source?.sourceCommit !== HY_EXP_0028_SOURCE_COMMIT
    || source?.artifactPath !== 'artifacts/HY-EXP-0028/holdout-result.json'
    || source?.artifactSha256 !== HY_EXP_0028_HOLDOUT_RESULT_SHA256) return false;

  const candidate = config.candidateEngine;
  if (candidate?.strategyId !== HY_EXP_0028_STRATEGY_ID
    || candidate?.rule !== 'RULE_A_CHANNEL_DISTANCE_Q75'
    || candidate?.direction !== 'BULL/BUY'
    || candidate.frozenQ75 !== HY_EXP_0028_FROZEN_Q75
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
