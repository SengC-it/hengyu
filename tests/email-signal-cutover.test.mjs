import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EMAIL_SIGNAL_CUTOVER_CONFIG,
  evaluateEmailSignalAdmission,
  isEmailSignalCutoverConfigValid
} from '../src/model/email-signal-cutover.mjs';
import {
  buildHyExp0028Candidates,
  buildHyExp0028EmailAdvisory
} from '../src/model/hy-exp-0028-email-signal.mjs';
import { HY_EXP_0028_FROZEN_Q75, HY_EXP_0028_SYMBOLS } from '../src/validation/hy-val-0028-001.mjs';
import { buildDispatchAdmissionAdvisory } from '../api/_lib/gmail.mjs';
import { formatAdvisoryEmail } from '../src/model/alert-outbox.mjs';

const NOW = Date.parse('2026-08-24T12:00:00.000Z');
const HOUR = 60 * 60 * 1_000;
const FOUR_HOURS = 4 * HOUR;
const SIGNAL_INDEX = 720;
const SIGNAL_TIME = NOW - 11 * HOUR;
const FIXTURE_START = SIGNAL_TIME - (SIGNAL_INDEX + 1) * HOUR;

function releasedConfig() {
  return {
    ...EMAIL_SIGNAL_CUTOVER_CONFIG,
    releaseState: 'EMAIL_SIGNAL_RELEASED'
  };
}

function validAdvisory(overrides = {}) {
  const entryTime = SIGNAL_TIME + 5 * 60 * 1_000;
  const entryObservedAt = entryTime + 30_000;
  return {
    experiment_id: 'HY-EXP-0028',
    advisory_type: 'REVIEW_BUY',
    symbol: 'BTCUSDT',
    status: 'ACTIVE',
    authorization_mode: 'PAPER_ONLY',
    live_orders_enabled: false,
    signal_at: new Date(SIGNAL_TIME).toISOString(),
    expires_at: '2026-08-24T12:15:00.000Z',
    metadata: {
      source: 'hy-exp-0028-frozen-candidate-engine',
      strategyId: 'HY-EXP-0028',
      policyId: 'EMAIL_SIGNAL_RELEASE-001',
      sourceCommit: 'a61cb20318af1e0b188c0276a1a3d65e52bc4467',
      candidateId: `BTCUSDT:${SIGNAL_TIME}`,
      decisionTime: SIGNAL_TIME,
      modelId: 'HY-EXP-0028-RULE-A-EMAIL-001',
      rule: 'RULE_A_CHANNEL_DISTANCE_Q75',
      candidateAuthority: 'EMAIL_SIGNAL_CANDIDATE',
      candidateOnly: true,
      frozenQ75: HY_EXP_0028_FROZEN_Q75,
      causalDataQuality: 'PASS',
      continuityValid: true,
      alignmentValid: true,
      outcomeDataUsedForAdmission: false,
      entryTime: new Date(entryTime).toISOString(),
      entryObservedAt,
      entryCaptureDelayMs: 30_000,
      entryReferenceSource: 'CONTRACT_PRICE_5M_OPEN',
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
    open: 100,
    source: 'CONTRACT_PRICE',
    receivedAt: candidate.theoreticalEntryTime + 30_000
  };
}

function signalCloseForDistance(distance) {
  return (1_600 + 105 * distance) / (20 - distance);
}

function makeProductionDataset(distance = 15) {
  const signalClose = signalCloseForDistance(distance);
  const bars1h = Array.from({ length: SIGNAL_INDEX + 1 }, (_, index) => {
    const openTime = FIXTURE_START + index * HOUR;
    if (index === SIGNAL_INDEX) {
      return {
        openTime,
        closeBoundary: openTime + HOUR,
        open: signalClose,
        high: signalClose,
        low: signalClose,
        close: signalClose
      };
    }
    return { openTime, closeBoundary: openTime + HOUR, open: 85, high: 90, low: 80, close: 85 };
  });
  const bars4h = Array.from({ length: 180 }, (_, index) => {
    const close = index < 120 ? 90 : 110;
    const openTime = FIXTURE_START + index * FOUR_HOURS;
    return {
      openTime,
      closeBoundary: openTime + FOUR_HOURS,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      quoteVolume: 1_000
    };
  });
  return {
    signalIndex: SIGNAL_INDEX,
    bars1hBySymbol: Object.fromEntries(HY_EXP_0028_SYMBOLS.map(symbol => [
      symbol, bars1h.map(row => ({ ...row, symbol }))
    ])),
    bars4hBySymbol: Object.fromEntries(HY_EXP_0028_SYMBOLS.map(symbol => [
      symbol, bars4h.map(row => ({ ...row, symbol }))
    ]))
  };
}

function realProductionCandidate() {
  const built = buildHyExp0028Candidates(makeProductionDataset());
  assert.equal(built.candidates.length, HY_EXP_0028_SYMBOLS.length);
  return built.candidates[0];
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
  assert.equal(EMAIL_SIGNAL_CUTOVER_CONFIG.candidateEngine.entry.waitForBarClose, false);
  assert.equal(EMAIL_SIGNAL_CUTOVER_CONFIG.candidateEngine.entry.maxEntryCaptureDelayMs, 90_000);
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

test('dispatch reload shape preserves admission fields and fails closed by status and strategy', () => {
  const reloaded = buildDispatchAdmissionAdvisory(validAdvisory());
  assert.deepEqual(Object.keys(reloaded).sort(), [
    'advisory_type', 'authorization_mode', 'experiment_id', 'expires_at',
    'live_orders_enabled', 'metadata', 'signal_at', 'status', 'symbol'
  ]);
  assert.equal(
    evaluateEmailSignalAdmission({ advisory: reloaded, config: releasedConfig(), now: NOW }).allowed,
    true
  );
  assert.equal(
    evaluateEmailSignalAdmission({
      advisory: { ...reloaded, symbol: undefined },
      config: releasedConfig(),
      now: NOW
    }).reason,
    'EMAIL_CANDIDATE_IDENTITY_INVALID'
  );
  for (const status of ['CANCELLED', 'INACTIVE', 'CLOSED', 'SUSPENDED']) {
    assert.equal(
      evaluateEmailSignalAdmission({
        advisory: { ...reloaded, status },
        config: releasedConfig(),
        now: NOW
      }).reason,
      'EMAIL_CANDIDATE_STATUS_INVALID',
      status
    );
  }
  assert.equal(
    evaluateEmailSignalAdmission({ advisory: reloaded, now: NOW }).reason,
    'EMAIL_STRATEGY_NOT_RELEASED'
  );
  assert.equal(
    evaluateEmailSignalAdmission({
      advisory: { ...reloaded, experiment_id: 'HY-EXP-0018' },
      config: releasedConfig(),
      now: NOW
    }).reason,
    'EMAIL_STRATEGY_NOT_AUTHORIZED'
  );
  assert.equal(
    evaluateEmailSignalAdmission({
      advisory: { ...reloaded, experiment_id: 'HY-EXP-9999' },
      config: releasedConfig(),
      now: NOW
    }).reason,
    'EMAIL_STRATEGY_NOT_AUTHORIZED'
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

test('HY-EXP-0028 accepts the live exact +5m contract-price OPEN without waiting for close', () => {
  const candidate = realProductionCandidate();
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
  assert.equal(accepted.advisory.stop_reference, 100 - 2 * candidate.atr20);
  assert.equal(accepted.advisory.metadata.outcomeDataUsedForAdmission, false);
  assert.equal(accepted.advisory.metadata.entryReferenceSource, 'CONTRACT_PRICE_5M_OPEN');
  assert.equal(accepted.advisory.metadata.entryCaptureDelayMs, 30_000);
  assert.equal(accepted.advisory.metadata.policyId, 'EMAIL_SIGNAL_RELEASE-001');
  assert.equal(accepted.advisory.metadata.sourceCommit, 'a61cb20318af1e0b188c0276a1a3d65e52bc4467');
  assert.equal(accepted.advisory.metadata.candidateId, candidate.id);
  assert.equal(
    evaluateEmailSignalAdmission({
      advisory: accepted.advisory,
      config: releasedConfig(),
      now: NOW
    }).allowed,
    true
  );
  assert.equal(accepted.email.requested, true);
  const liveBar = {
    ...validEntryBar(candidate),
    finalClosed: false,
    high: Number.MAX_VALUE,
    low: 0.01,
    close: Number.MAX_VALUE
  };
  const liveAccepted = buildHyExp0028EmailAdvisory({
    candidate, entryBar: liveBar, expiresAt: '2026-08-24T12:15:00.000Z', now: NOW
  });
  assert.equal(liveAccepted.accepted, true);
  assert.equal(liveAccepted.advisory.entry_reference, accepted.advisory.entry_reference);
});

test('live entry observation is rejected when wrong, delayed, early, or rescued by a later bar', () => {
  const candidate = realProductionCandidate();
  const base = { candidate, expiresAt: '2026-08-24T12:15:00.000Z', now: NOW };
  const rejected = [
    ['wrong source', { source: 'MARK_PRICE' }],
    ['later bar rescue', { openTime: candidate.theoreticalEntryTime + 5 * 60 * 1_000 }],
    ['received before open', { receivedAt: candidate.theoreticalEntryTime - 1 }],
    ['ten-minute delay', { receivedAt: candidate.theoreticalEntryTime + 10 * 60 * 1_000 }],
    ['over frozen max delay', { receivedAt: candidate.theoreticalEntryTime + 90_001 }],
    ['invalid open', { open: Number.NaN }]
  ];
  for (const [name, change] of rejected) {
    const result = buildHyExp0028EmailAdvisory({
      ...base,
      entryBar: { ...validEntryBar(candidate), ...change }
    });
    assert.equal(result.accepted, false, name);
  }
});

test('handcrafted candidate and incomplete persisted provenance cannot impersonate the frozen engine', () => {
  const candidate = validCandidate({
    policyId: 'EMAIL_SIGNAL_RELEASE-001',
    sourceCommit: 'a61cb20318af1e0b188c0276a1a3d65e52bc4467',
    candidateOnly: true,
    causalDataQuality: 'PASS',
    continuityValid: true,
    alignmentValid: true,
    safety: {
      signal_only: true, authorization_mode: 'PAPER_ONLY', live_orders_enabled: false,
      account_api: false, order_api: false, automatic_trading: false,
      final_oos_read: false, shadow_activated: false
    },
    channelDistance: HY_EXP_0028_FROZEN_Q75
  });
  assert.equal(buildHyExp0028EmailAdvisory({
    candidate, entryBar: validEntryBar(candidate), expiresAt: '2026-08-24T12:15:00.000Z', now: NOW
  }).accepted, false);

  for (const field of ['policyId', 'sourceCommit']) {
    assert.equal(
      evaluateEmailSignalAdmission({
        advisory: validAdvisory({ metadata: { ...validAdvisory().metadata, [field]: undefined } }),
        config: releasedConfig(),
        now: NOW
      }).reason,
      'EMAIL_CANDIDATE_IDENTITY_INVALID',
      field
    );
  }
  assert.equal(
    buildHyExp0028EmailAdvisory({
      candidate: realProductionCandidate(),
      entryBar: validEntryBar(realProductionCandidate()),
      expiresAt: '2026-08-24T12:15:00.000Z',
      now: NOW
    }).accepted,
    true
  );
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
