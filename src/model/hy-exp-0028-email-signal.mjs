import {
  buildFrozenProductionEmailCandidates,
  HY_EXP_0028_BASE_COST_BPS,
  HY_EXP_0028_ENTRY_OFFSET_MS,
  HY_EXP_0028_FROZEN_Q75,
  HY_EXP_0028_POLICY_ID,
  HY_EXP_0028_SOURCE_COMMIT,
  HY_EXP_0028_STRESS_COST_BPS,
  HY_EXP_0028_SYMBOLS
} from '../validation/hy-val-0028-001.mjs';
import {
  EMAIL_SIGNAL_CUTOVER_CONFIG,
  isEmailSignalCutoverConfigValid
} from './email-signal-cutover.mjs';

export const HY_EXP_0028_EMAIL_SIGNAL_ENGINE = Object.freeze({
  strategyId: 'HY-EXP-0028',
  policyId: HY_EXP_0028_POLICY_ID,
  sourceCommit: HY_EXP_0028_SOURCE_COMMIT,
  rule: 'RULE_A_CHANNEL_DISTANCE_Q75',
  direction: 'BULL/BUY',
  frozenQ75: HY_EXP_0028_FROZEN_Q75,
  symbols: HY_EXP_0028_SYMBOLS,
  baseCostBps: HY_EXP_0028_BASE_COST_BPS,
  stressCostBps: HY_EXP_0028_STRESS_COST_BPS,
  entryRule: 'decisionTime + 5 minutes exact completed contract-price 5m bar OPEN',
  outcomeResolutionUsedForAdmission: false
});

function finite(name, value, { minimum = -Infinity, exclusiveMinimum = false } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (exclusiveMinimum ? parsed <= minimum : parsed < minimum)) {
    throw new Error(`invalid ${name}`);
  }
  return parsed;
}

function timestamp(name, value) {
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`invalid ${name}`);
  return parsed;
}

function isFinalContractPriceBar(row) {
  const finalClosed = row?.finalClosed === true
    || row?.final === true
    || row?.closed === true
    || row?.x === true;
  const source = String(row?.source ?? row?.sourceType ?? row?.barSource ?? '').toUpperCase();
  return finalClosed && source === 'CONTRACT_PRICE';
}

export function buildHyExp0028Candidates(input = {}) {
  if (!isEmailSignalCutoverConfigValid(EMAIL_SIGNAL_CUTOVER_CONFIG)) {
    return {
      contexts: [],
      candidates: [],
      rejections: [{ symbol: null, decisionTime: null, rejection: 'EMAIL_CUTOVER_CONFIG_INVALID' }]
    };
  }
  return buildFrozenProductionEmailCandidates(input);
}

export function buildHyExp0028EmailAdvisory({
  candidate,
  entryBar,
  expiresAt,
  now = Date.now(),
  alertLevel = 'MEDIUM'
} = {}) {
  if (!candidate || candidate.strategyId !== HY_EXP_0028_EMAIL_SIGNAL_ENGINE.strategyId
    || candidate.candidateAuthority !== 'EMAIL_SIGNAL_CANDIDATE'
    || candidate.outcomeDataUsedForAdmission !== false) {
    return { accepted: false, rejection: 'EMAIL_CANDIDATE_IDENTITY_INVALID' };
  }
  if (candidate.side !== 'BUY' || candidate.regime !== 'BULL'
    || candidate.rule !== HY_EXP_0028_EMAIL_SIGNAL_ENGINE.rule
    || candidate.frozenQ75 !== HY_EXP_0028_EMAIL_SIGNAL_ENGINE.frozenQ75) {
    return { accepted: false, rejection: 'EMAIL_CANDIDATE_SEMANTICS_INVALID' };
  }
  const currentTime = timestamp('now', now);
  const decisionTime = timestamp('decisionTime', candidate.decisionTime);
  if (decisionTime > currentTime) return { accepted: false, rejection: 'EMAIL_CANDIDATE_FUTURE' };
  if (!isFinalContractPriceBar(entryBar)) {
    return { accepted: false, rejection: 'ENTRY_BAR_NOT_FINAL_CONTRACT_PRICE' };
  }
  const entryOpenTime = timestamp('entryBar.openTime', entryBar.openTime);
  const expectedEntryTime = decisionTime + HY_EXP_0028_ENTRY_OFFSET_MS;
  if (entryOpenTime !== expectedEntryTime) {
    return { accepted: false, rejection: 'ENTRY_BAR_ALIGNMENT_INVALID' };
  }
  const entryCloseTime = timestamp('entryBar.closeTime', entryBar.closeTime);
  if (entryCloseTime !== entryOpenTime + HY_EXP_0028_ENTRY_OFFSET_MS - 1) {
    return { accepted: false, rejection: 'ENTRY_BAR_BOUNDARY_INVALID' };
  }
  const receivedAt = timestamp('entryBar.receivedAt', entryBar.receivedAt);
  if (receivedAt <= entryCloseTime || entryCloseTime > currentTime) {
    return { accepted: false, rejection: 'ENTRY_BAR_RECEIPT_INVALID' };
  }
  const entryPrice = finite('entryBar.open', entryBar.open, { minimum: 0, exclusiveMinimum: true });
  const atr20 = finite('candidate.atr20', candidate.atr20, { minimum: 0, exclusiveMinimum: true });
  const stopPrice = entryPrice - 2 * atr20;
  if (!(stopPrice > 0)) return { accepted: false, rejection: 'EMAIL_STOP_INVALID' };
  const expiryTime = timestamp('expiresAt', expiresAt);
  if (expiryTime <= entryOpenTime || expiryTime <= currentTime) {
    return { accepted: false, rejection: 'EMAIL_SIGNAL_EXPIRED' };
  }
  const advisoryId = `HY-EXP-0028:${candidate.id}`;
  const signalTime = new Date(decisionTime).toISOString();
  const entryTime = new Date(entryOpenTime).toISOString();
  return {
    accepted: true,
    advisory: {
      advisory_id: advisoryId,
      experiment_id: HY_EXP_0028_EMAIL_SIGNAL_ENGINE.strategyId,
      symbol: candidate.symbol,
      advisory_type: 'REVIEW_BUY',
      alert_level: alertLevel,
      signal_at: signalTime,
      expires_at: new Date(expiryTime).toISOString(),
      entry_reference: entryPrice,
      stop_reference: stopPrice,
      exit_reference: null,
      status: 'ACTIVE',
      pnl_eligible: false,
      authorization_mode: 'PAPER_ONLY',
      live_orders_enabled: false,
      dedupe_key: advisoryId,
      metadata: {
        source: 'hy-exp-0028-frozen-candidate-engine',
        strategyId: HY_EXP_0028_EMAIL_SIGNAL_ENGINE.strategyId,
        hypothesisId: HY_EXP_0028_EMAIL_SIGNAL_ENGINE.strategyId,
        modelId: 'HY-EXP-0028-RULE-A-EMAIL-001',
        candidateAuthority: 'EMAIL_SIGNAL_CANDIDATE',
        candidateOnly: true,
        causalDataQuality: 'PASS',
        continuityValid: true,
        alignmentValid: true,
        outcomeDataUsedForAdmission: false,
        safety: {
          signal_only: true,
          authorization_mode: 'PAPER_ONLY',
          live_orders_enabled: false,
          account_api: false,
          order_api: false,
          automatic_trading: false,
          final_oos_read: false,
          shadow_activated: false
        },
        rule: HY_EXP_0028_EMAIL_SIGNAL_ENGINE.rule,
        frozenQ75: HY_EXP_0028_EMAIL_SIGNAL_ENGINE.frozenQ75,
        entryRule: HY_EXP_0028_EMAIL_SIGNAL_ENGINE.entryRule,
        entryTime,
        exitRule: 'ATR20 stop or prior 60 completed 1h low dynamic channel; no automatic exit',
        reviewModel: 'DYNAMIC_CHANNEL_OR_ATR_EXIT',
        reasons: ['HY_EXP_0028_BULL_REGIME', 'HY_EXP_0028_RULE_A_BREAKOUT_Q75']
      }
    },
    email: {
      requested: true,
      manual_only: true,
      order_placement: false,
      account_access: false
    }
  };
}
