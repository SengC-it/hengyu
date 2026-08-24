import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  HY_EXP_0028_BASE_COST_BPS,
  HY_EXP_0028_ENTRY_OFFSET_MS,
  HY_EXP_0028_FROZEN_Q75,
  HY_EXP_0028_HOLDOUT_RESULT_SHA256,
  HY_EXP_0028_MAX_HOLD_BARS,
  HY_EXP_0028_POLICY_ID,
  HY_EXP_0028_PREREGISTRATION_SHA256,
  HY_EXP_0028_SOURCE_COMMIT,
  HY_EXP_0028_STRESS_COST_BPS,
  HY_EXP_0028_SYMBOLS,
  HY_EXP_0028_STRATEGY_ID,
  HY_VAL_0028_001,
  HY_VAL_0028_001_ID,
  HY_VAL_PUBLIC_ENDPOINTS,
  ShadowValidationActivation,
  buildShadowSignal,
  classifyWarmupRecord,
  combineValidationEvidence,
  countCompletedValidationDays,
  createFrozenRuleACandidate,
  resolveFrozenPaperTrade
} from '../src/validation/hy-val-0028-001.mjs';
import {
  HY_VAL_0028_001_STORAGE_TABLES,
  appendShadowActivation,
  appendShadowSignal,
  shadowStoragePaths
} from '../src/validation/hy-val-0028-001-store.mjs';

const ACTIVATION_TIME = Date.parse('2026-08-24T00:00:00.000Z');

function activation() {
  const value = new ShadowValidationActivation();
  value.setOnce(ACTIVATION_TIME);
  return value;
}

function candidateInput(overrides = {}) {
  const features = Array(8).fill(0);
  features[7] = 20;
  const decisionTime = Date.parse('2026-08-24T04:00:00.000Z');
  return {
    activation: activation(),
    symbol: 'BTCUSDT',
    decisionTime,
    regime: 'BULL',
    side: 'BUY',
    signalClose: 100,
    priorEntryHigh: 99,
    priorEntryBars: Array.from({ length: 120 }, (_, index) => ({
      closeBoundary: decisionTime - (120 - index) * 60 * 60 * 1_000,
      openTime: decisionTime - (121 - index) * 60 * 60 * 1_000,
      high: 99
    })),
    priorExitLow: 80,
    priorExitBars: Array.from({ length: 60 }, (_, index) => ({
      closeBoundary: decisionTime - (60 - index) * 60 * 60 * 1_000,
      openTime: decisionTime - (61 - index) * 60 * 60 * 1_000,
      low: 80
    })),
    atr20: 1,
    features,
    ...overrides
  };
}

function makeShadowSignal() {
  const result = createFrozenRuleACandidate(candidateInput());
  assert.equal(result.accepted, true);
  return buildShadowSignal(result.candidate);
}

test('HY-VAL-0028-001 freezes source identifiers, Q75, universe, and costs', () => {
  assert.equal(HY_VAL_0028_001_ID, 'HY-VAL-0028-001');
  assert.equal(HY_EXP_0028_SOURCE_COMMIT, 'a61cb20318af1e0b188c0276a1a3d65e52bc4467');
  assert.equal(HY_EXP_0028_PREREGISTRATION_SHA256, '4085fad293275ce055a67516d1c8168331f221a91b688f3b093ff2eef11708a3');
  assert.equal(HY_EXP_0028_HOLDOUT_RESULT_SHA256, '92304ec0252be9ee2bba2e13a9ccc64c923f3b067d91e12513be089d56f3d2e5');
  assert.equal(HY_EXP_0028_FROZEN_Q75, 10.051547664406323);
  assert.deepEqual(HY_EXP_0028_SYMBOLS, [
    'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT',
    'XRPUSDT', 'DOGEUSDT', 'LINKUSDT', 'LTCUSDT'
  ]);
  assert.equal(HY_EXP_0028_BASE_COST_BPS, 18);
  assert.equal(HY_EXP_0028_STRESS_COST_BPS, 27);
  assert.equal(HY_EXP_0028_MAX_HOLD_BARS, 6);
  assert.equal(HY_VAL_0028_001.activation.shadowValidationActivatedAt, null);
  assert.equal(HY_VAL_0028_001.activation.hardcodedTimestamp, false);
  assert.equal(HY_VAL_0028_001.immutableSource.files.length, 4);
  assert.deepEqual(HY_VAL_0028_001.immutableSource.dependencyChain, [
    'scripts/hy-exp-0028-holdout.mjs',
    'src/research/hy-exp-0028.mjs',
    'src/research/hy-exp-0024.mjs'
  ]);
});

test('public endpoint contract contains no private, account, or order API', () => {
  assert.ok(HY_VAL_PUBLIC_ENDPOINTS.every(endpoint => endpoint.startsWith('https://fapi.binance.com/fapi/v1/')));
  assert.ok(HY_VAL_PUBLIC_ENDPOINTS.every(endpoint => !/private|account|order/i.test(endpoint)));
  assert.equal(HY_VAL_0028_001.safety.signal_only, true);
  assert.equal(HY_VAL_0028_001.safety.authorization_mode, 'PAPER_ONLY');
  assert.equal(HY_VAL_0028_001.safety.live_orders_enabled, false);
  assert.equal(HY_VAL_0028_001.safety.account_api, false);
  assert.equal(HY_VAL_0028_001.safety.order_api, false);
  assert.equal(HY_VAL_0028_001.safety.automatic_trading, false);
  assert.equal(HY_VAL_0028_001.safety.final_oos_read, false);
});

test('activation is unset in the PR, accepts one controlled timestamp, and is immutable', () => {
  const value = new ShadowValidationActivation();
  assert.equal(value.activatedAt, null);
  assert.deepEqual(value.eligibility(ACTIVATION_TIME), {
    eligible: false,
    reason: 'SHADOW_ACTIVATION_NOT_SET'
  });
  assert.equal(value.setOnce(ACTIVATION_TIME), ACTIVATION_TIME);
  assert.throws(() => value.setOnce(ACTIVATION_TIME + 1), /immutable/);
});

test('pre-activation signal is rejected and warmup never counts as validation', () => {
  const value = activation();
  const preActivation = createFrozenRuleACandidate(candidateInput({
    activation: value,
    decisionTime: '2026-08-23T23:00:00.000Z'
  }));
  assert.deepEqual(preActivation, { accepted: false, rejection: 'PRE_ACTIVATION_SIGNAL' });
  const warmup = classifyWarmupRecord('2026-08-23T23:59:59.000Z', value);
  assert.equal(warmup.tag, 'WARMUP_ONLY');
  assert.equal(warmup.countsAsValidation, false);
  assert.equal(warmup.countsAsPnl, false);
  const prospective = classifyWarmupRecord('2026-08-24T00:00:00.000Z', value);
  assert.equal(prospective.tag, 'PROSPECTIVE');
  assert.equal(prospective.countsAsValidation, true);
});

test('Rule A candidate parity keeps identity, Q75, BULL/BUY direction, and feature formula', () => {
  const result = createFrozenRuleACandidate(candidateInput());
  assert.equal(result.accepted, true);
  assert.equal(result.candidate.rule, 'RULE_A_CHANNEL_DISTANCE_Q75');
  assert.equal(result.candidate.regime, 'BULL');
  assert.equal(result.candidate.side, 'BUY');
  assert.equal(result.candidate.channelDistance, 20);
  assert.equal(result.candidate.frozenQ75, HY_EXP_0028_FROZEN_Q75);
  assert.equal(result.candidate.theoreticalEntryTime, result.candidate.decisionTime + HY_EXP_0028_ENTRY_OFFSET_MS);
  assert.equal(createFrozenRuleACandidate(candidateInput({ side: 'SELL' })).rejection, 'RULE_A_REQUIRES_BULL_BUY');
  assert.equal(createFrozenRuleACandidate(candidateInput({ features: [0, 0, 0, 0, 0, 0, 0, 19] })).rejection, 'FROZEN_FEATURE_PARITY_MISMATCH');
});

test('shadow signal uses signal+5m entry and never enters Gmail or production advisory paths', () => {
  const signal = makeShadowSignal();
  assert.equal(signal.status, 'SHADOW_SIGNAL');
  assert.equal(signal.entryTime, signal.decisionTime + HY_EXP_0028_ENTRY_OFFSET_MS);
  assert.equal(signal.emailSent, false);
  assert.equal(signal.productionAdvisory, false);
  assert.equal(signal.orderPlaced, false);
  assert.equal(signal.safety.authorization_mode, 'PAPER_ONLY');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-val-0028-001-'));
  try {
    const first = appendShadowSignal({ root, signal });
    const duplicate = appendShadowSignal({ root, signal });
    assert.equal(first.inserted, true);
    assert.equal(duplicate.duplicate, true);
    assert.deepEqual(Object.keys(shadowStoragePaths(root)).sort(), ['activation', 'health', 'resolutions', 'signals']);
    assert.equal(fs.existsSync(path.join(root, 'outbox.ndjson')), false);
    assert.equal(fs.existsSync(path.resolve('data/advisory-outbox.ndjson')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('activation and signal storage are separate immutable shadow tables', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-val-0028-001-'));
  try {
    const record = {
      validationId: HY_VAL_0028_001_ID,
      strategyId: HY_EXP_0028_STRATEGY_ID,
      policyId: HY_EXP_0028_POLICY_ID,
      sourceCommit: HY_EXP_0028_SOURCE_COMMIT,
      shadowValidationActivatedAt: new Date(ACTIVATION_TIME).toISOString(),
      emailSent: false,
      productionAdvisory: false,
      orderPlaced: false,
      safety: {
        signal_only: true,
        authorization_mode: 'PAPER_ONLY',
        live_orders_enabled: false,
        account_api: false,
        order_api: false,
        automatic_trading: false,
        final_oos_read: false
      }
    };
    const first = appendShadowActivation({ root, activationRecord: record });
    const duplicate = appendShadowActivation({ root, activationRecord: record });
    assert.equal(first.inserted, true);
    assert.equal(duplicate.duplicate, true);
    assert.equal(HY_VAL_0028_001_STORAGE_TABLES.activation, 'hengyu_shadow_validation_activation');
    assert.equal(HY_VAL_0028_001_STORAGE_TABLES.signals, 'hengyu_shadow_signals');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('frozen paper resolution uses six completed 1h bars and actual funding', () => {
  const signal = makeShadowSignal();
  const decisionTime = signal.decisionTime;
  const base = decisionTime - 60 * 60 * 1_000 * 60;
  const bars1h = Array.from({ length: 67 }, (_, index) => {
    const openTime = base + index * 60 * 60 * 1_000;
    return {
      openTime,
      closeBoundary: openTime + 60 * 60 * 1_000,
      open: 100,
      high: 101,
      low: 99,
      close: 100
    };
  });
  const bars5m = [];
  for (let openTime = signal.entryTime; openTime < decisionTime + 7 * 60 * 60 * 1_000; openTime += 5 * 60 * 1_000) {
    bars5m.push({
      openTime,
      closeTime: openTime + 5 * 60 * 1_000 - 1,
      open: 100,
      high: 101,
      low: 99,
      close: 100
    });
  }
  const resolution = resolveFrozenPaperTrade({
    signal,
    bars1h,
    bars5m,
    fundingRows: [{ eventTime: decisionTime + 3 * 60 * 60 * 1_000, fundingRate: 0.0001 }],
    asOfTime: decisionTime + 7 * 60 * 60 * 1_000
  });
  assert.equal(resolution.status, 'RESOLVED');
  assert.equal(resolution.entryTime, signal.decisionTime + HY_EXP_0028_ENTRY_OFFSET_MS);
  assert.equal(resolution.entryPrice, 100);
  assert.equal(resolution.exitReason, 'TERMINAL_EXIT');
  assert.equal(resolution.exitTime, decisionTime + 6 * 60 * 60 * 1_000);
  assert.equal(resolution.funding.events.length, 1);
  assert.equal(resolution.funding.fundingPnlBps, -1);
  assert.equal(resolution.net18Bps, -19);
  assert.equal(resolution.net27Bps, -28);
  assert.ok(Number.isFinite(resolution.maeBps));
  assert.ok(Number.isFinite(resolution.mfeBps));
  assert.equal(resolution.safety.automatic_trading, false);
});

test('outcome cannot be resolved for an uncounted pre-activation signal', () => {
  assert.throws(() => resolveFrozenPaperTrade({
    signal: { countedProspective: false },
    asOfTime: ACTIVATION_TIME
  }), /pre-activation/);
});

test('combined evidence keeps original 43 separate and excludes validation gaps', () => {
  const completedDays = countCompletedValidationDays({
    coveredUtcDays: ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27'],
    completedUtcDays: ['2026-08-24', '2026-08-25', '2026-08-27']
  });
  assert.equal(completedDays, 3);
  const combined = combineValidationEvidence({
    originalValidatedSignals: 43,
    prospectiveValidatedSignals: 7,
    originalValidationDays: 53,
    prospectiveCompletedValidationDays: completedDays
  });
  assert.equal(combined.originalValidatedSignals, 43);
  assert.equal(combined.prospectiveValidatedSignals, 7);
  assert.equal(combined.combinedValidatedSignals, 50);
  assert.equal(combined.combinedValidationDays, 56);
  assert.equal(combined.metricsMustBeRecomputedFromTradeRows, true);
});
