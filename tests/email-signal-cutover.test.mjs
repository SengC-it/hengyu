import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EMAIL_SIGNAL_CUTOVER_CONFIG,
  evaluateEmailSignalAdmission,
  isEmailSignalCutoverConfigValid
} from '../src/model/email-signal-cutover.mjs';
import { buildHyExp0028EmailAdvisory } from '../src/model/hy-exp-0028-email-signal.mjs';
import { formatAdvisoryEmail } from '../src/model/alert-outbox.mjs';

const NOW = Date.parse('2026-08-24T12:00:00.000Z');

function releasedConfig() {
  return {
    ...EMAIL_SIGNAL_CUTOVER_CONFIG,
    releaseState: 'EMAIL_SIGNAL_RELEASED'
  };
}

function validAdvisory(overrides = {}) {
  return {
    experiment_id: 'HY-EXP-0028',
    advisory_type: 'REVIEW_BUY',
    symbol: 'BTCUSDT',
    authorization_mode: 'PAPER_ONLY',
    live_orders_enabled: false,
    signal_at: '2026-08-24T11:55:00.000Z',
    expires_at: '2026-08-24T12:15:00.000Z',
    metadata: {
      strategyId: 'HY-EXP-0028',
      rule: 'RULE_A_CHANNEL_DISTANCE_Q75',
      candidateAuthority: 'EMAIL_SIGNAL_CANDIDATE',
      frozenQ75: 10.051547664406323,
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
      }
    },
    ...overrides
  };
}

function validCandidate(overrides = {}) {
  return {
    id: 'BTCUSDT:1787572500000',
    strategyId: 'HY-EXP-0028',
    candidateAuthority: 'EMAIL_SIGNAL_CANDIDATE',
    outcomeDataUsedForAdmission: false,
    symbol: 'BTCUSDT',
    side: 'BUY',
    regime: 'BULL',
    rule: 'RULE_A_CHANNEL_DISTANCE_Q75',
    frozenQ75: 10.051547664406323,
    decisionTime: NOW - 60 * 60 * 1_000,
    theoreticalEntryTime: NOW - 55 * 60 * 1_000,
    atr20: 2,
    ...overrides
  };
}

function validEntryBar(candidate = validCandidate()) {
  return {
    openTime: candidate.theoreticalEntryTime,
    closeTime: candidate.theoreticalEntryTime + 5 * 60 * 1_000 - 1,
    open: 100,
    high: 102,
    low: 99,
    close: 101,
    source: 'CONTRACT_PRICE',
    finalClosed: true,
    receivedAt: NOW - 50 * 60 * 1_000
  };
}

test('cutover config is immutable, current state is READY, and safety is closed', () => {
  assert.equal(Object.isFrozen(EMAIL_SIGNAL_CUTOVER_CONFIG), true);
  assert.equal(isEmailSignalCutoverConfigValid(), true);
  assert.equal(EMAIL_SIGNAL_CUTOVER_CONFIG.releaseState, 'EMAIL_SIGNAL_RELEASE_READY');
  assert.equal(EMAIL_SIGNAL_CUTOVER_CONFIG.releaseStateRequiredForEmail, 'EMAIL_SIGNAL_RELEASED');
  assert.equal(EMAIL_SIGNAL_CUTOVER_CONFIG.legacyEmailAuthority.emailAllowed, false);
  assert.equal(EMAIL_SIGNAL_CUTOVER_CONFIG.safety.signal_only, true);
  assert.equal(EMAIL_SIGNAL_CUTOVER_CONFIG.safety.authorization_mode, 'PAPER_ONLY');
  assert.equal(EMAIL_SIGNAL_CUTOVER_CONFIG.safety.live_orders_enabled, false);
  assert.equal(EMAIL_SIGNAL_CUTOVER_CONFIG.safety.account_api, false);
  assert.equal(EMAIL_SIGNAL_CUTOVER_CONFIG.safety.order_api, false);
  assert.equal(EMAIL_SIGNAL_CUTOVER_CONFIG.safety.automatic_trading, false);
  assert.equal(EMAIL_SIGNAL_CUTOVER_CONFIG.safety.shadow_activated, false);
});

test('legacy H12 and any other strategy cannot impersonate the new email authority', () => {
  assert.deepEqual(
    evaluateEmailSignalAdmission({
      advisory: validAdvisory({ experiment_id: 'HY-EXP-0018' }),
      config: releasedConfig(),
      now: NOW
    }),
    { allowed: false, reason: 'EMAIL_STRATEGY_NOT_AUTHORIZED' }
  );
  assert.deepEqual(
    evaluateEmailSignalAdmission({
      advisory: validAdvisory({ experiment_id: 'HY-EXP-9999' }),
      config: releasedConfig(),
      now: NOW
    }),
    { allowed: false, reason: 'EMAIL_STRATEGY_NOT_AUTHORIZED' }
  );
  assert.deepEqual(
    evaluateEmailSignalAdmission({
      advisory: validAdvisory({ symbol: 'NOTUSDT' }),
      config: releasedConfig(),
      now: NOW
    }),
    { allowed: false, reason: 'EMAIL_CANDIDATE_IDENTITY_INVALID' }
  );
});

test('READY is fail-closed while an explicitly released config admits only a valid candidate', () => {
  assert.deepEqual(
    evaluateEmailSignalAdmission({ advisory: validAdvisory(), now: NOW }),
    { allowed: false, reason: 'EMAIL_STRATEGY_NOT_RELEASED' }
  );
  assert.equal(
    evaluateEmailSignalAdmission({ advisory: validAdvisory(), config: releasedConfig(), now: NOW }).allowed,
    true
  );
});

test('invalid or incomplete cutover config fails closed', () => {
  assert.deepEqual(
    evaluateEmailSignalAdmission({ advisory: validAdvisory(), config: null, now: NOW }),
    { allowed: false, reason: 'EMAIL_CUTOVER_CONFIG_INVALID' }
  );
  assert.equal(isEmailSignalCutoverConfigValid({ ...releasedConfig(), strategyId: 'HY-EXP-0018' }), false);
  assert.equal(isEmailSignalCutoverConfigValid({ ...releasedConfig(), evaluationSource: undefined }), false);
});

test('future, expired, stale, and outcome-dependent candidates never enter email admission', () => {
  assert.deepEqual(
    evaluateEmailSignalAdmission({
      advisory: validAdvisory({ signal_at: '2026-08-24T12:01:00.000Z' }),
      config: releasedConfig(),
      now: NOW
    }),
    { allowed: false, reason: 'EMAIL_CANDIDATE_FUTURE' }
  );
  assert.deepEqual(
    evaluateEmailSignalAdmission({
      advisory: validAdvisory({ expires_at: '2026-08-24T11:59:59.000Z' }),
      config: releasedConfig(),
      now: NOW
    }),
    { allowed: false, reason: 'EMAIL_SIGNAL_EXPIRED' }
  );
  for (const metadata of [
    { causalDataQuality: 'FAIL' },
    { continuityValid: false },
    { alignmentValid: false },
    { outcomeDataUsedForAdmission: true },
    { safety: { ...validAdvisory().metadata.safety, automatic_trading: true } }
  ]) {
    assert.deepEqual(
      evaluateEmailSignalAdmission({
        advisory: validAdvisory({ metadata: { ...validAdvisory().metadata, ...metadata } }),
        config: releasedConfig(),
        now: NOW
      }),
      { allowed: false, reason: 'EMAIL_CANDIDATE_DATA_QUALITY_INVALID' }
    );
  }
});

test('HY-EXP-0028 candidate adapter requires an exact completed contract-price entry bar', () => {
  const candidate = validCandidate();
  const accepted = buildHyExp0028EmailAdvisory({
    candidate,
    entryBar: validEntryBar(candidate),
    expiresAt: '2026-08-24T12:15:00.000Z',
    now: NOW
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.advisory.experiment_id, 'HY-EXP-0028');
  assert.equal(accepted.advisory.advisory_type, 'REVIEW_BUY');
  assert.equal(accepted.advisory.entry_reference, 100);
  assert.equal(accepted.advisory.stop_reference, 96);
  assert.equal(accepted.advisory.metadata.outcomeDataUsedForAdmission, false);
  assert.equal(accepted.email.requested, true);
  for (const change of [
    { source: 'MARK_PRICE' },
    { finalClosed: false },
    { openTime: candidate.theoreticalEntryTime + 5 * 60 * 1_000 },
    { receivedAt: validEntryBar(candidate).closeTime }
  ]) {
    assert.equal(
      buildHyExp0028EmailAdvisory({
        candidate,
        entryBar: { ...validEntryBar(candidate), ...change },
        expiresAt: '2026-08-24T12:15:00.000Z',
        now: NOW
      }).accepted,
      false
    );
  }
});

test('HY-EXP-0028 email uses the approved paper-only dynamic-exit template', () => {
  const { text, subject } = formatAdvisoryEmail({
    alertLevel: 'MEDIUM',
    action: 'REVIEW_BUY',
    symbol: 'BTCUSDT',
    expiresAt: '2026-08-24T12:15:00.000Z',
    reference: { entryPrice: 100, stopPrice: 96 },
    marketState: 'BULL',
    reasons: ['HY_EXP_0028_BULL_REGIME'],
    hypothesisId: 'HY-EXP-0028',
    reviewModel: 'DYNAMIC_CHANNEL_OR_ATR_EXIT',
    exitRule: 'ATR20止损或此前60根已完成1小时通道退出；系统不自动平仓。'
  });
  assert.match(subject, /BTCUSDT/);
  assert.match(text, /方向：做多/);
  assert.match(text, /止盈价：无固定止盈价（动态退出）/);
  assert.match(text, /失效时间：2026-08-24 20:15（北京时间）/);
  assert.match(text, /超过失效时间未入场，则本信号作废。/);
  assert.match(text, /失效时间仅限制新入场；已入场后仍按原止盈、止损或退出规则执行。/);
  assert.doesNotMatch(text, /Funding|Basis|Taker Buy|Taker Buy Ratio/i);
  assert.doesNotMatch(text, /建议仓位|建议杠杆/);
});
