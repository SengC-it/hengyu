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
  HY_EXP_0028_SOURCE_FILE_HASHES,
  HY_EXP_0028_STRESS_COST_BPS,
  HY_EXP_0028_SYMBOLS,
  HY_EXP_0028_STRATEGY_ID,
  HY_VAL_0028_001,
  HY_VAL_0028_001_ID,
  HY_VAL_PUBLIC_ENDPOINTS,
  ShadowValidationActivation,
  assertProspectiveResolvedEvidence,
  buildFrozenShadowCandidates,
  buildFrozenProductionEmailCandidates,
  buildShadowSignal,
  classifyWarmupRecord,
  combineValidationEvidence,
  countCompletedValidationDays,
  createFrozenRuleACandidate,
  resolveFrozenPaperTrade,
  validateProspectiveResolvedEvidence,
  verifyFrozenSourceManifest
} from '../src/validation/hy-val-0028-001.mjs';
import {
  HY_VAL_0028_001_STORAGE_TABLES,
  appendShadowActivation,
  appendShadowResolution,
  appendShadowSignal,
  shadowStoragePaths
} from '../src/validation/hy-val-0028-001-store.mjs';

const HOUR = 60 * 60 * 1_000;
const FIVE_MINUTES = 5 * 60 * 1_000;
const SIGNAL_INDEX = 720;
const FIXTURE_START = Date.parse('2026-08-24T00:00:00.000Z');
const ACTIVATION_TIME = FIXTURE_START;
const DECISION_TIME = FIXTURE_START + (SIGNAL_INDEX + 1) * HOUR;

function activation(at = ACTIVATION_TIME) {
  const value = new ShadowValidationActivation();
  value.setOnce(at);
  return value;
}

function signalCloseForDistance(distance) {
  // The 19 prior ATR ranges are 10 and the signal bar true range is close - 85.
  return (1_600 + 105 * distance) / (20 - distance);
}

function makeOneHourBars(distance = 15) {
  const signalClose = signalCloseForDistance(distance);
  return Array.from({ length: SIGNAL_INDEX + 1 }, (_, index) => {
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
    return {
      openTime,
      closeBoundary: openTime + HOUR,
      open: 85,
      high: 90,
      low: 80,
      close: 85
    };
  });
}

function makeFourHourBars(mode = 'BULL') {
  return Array.from({ length: 180 }, (_, index) => {
    const close = mode === 'BULL'
      ? (index < 120 ? 90 : 110)
      : mode === 'BEAR'
        ? (index < 60 ? 110 : 90)
        : 100;
    const openTime = FIXTURE_START + index * 4 * HOUR;
    return {
      openTime,
      closeBoundary: openTime + 4 * HOUR,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      quoteVolume: 1_000
    };
  });
}

function makeCausalDataset({ mode = 'BULL', distance = 15 } = {}) {
  const bars1h = makeOneHourBars(distance);
  const bars4h = makeFourHourBars(mode);
  return {
    signalIndex: SIGNAL_INDEX,
    bars1hBySymbol: Object.fromEntries(HY_EXP_0028_SYMBOLS.map(symbol => [symbol, bars1h.map(row => ({ ...row, symbol }))])),
    bars4hBySymbol: Object.fromEntries(HY_EXP_0028_SYMBOLS.map(symbol => [symbol, bars4h.map(row => ({ ...row, symbol }))]))
  };
}

function buildFixture({ mode = 'BULL', distance = 15, at = ACTIVATION_TIME } = {}) {
  const dataset = makeCausalDataset({ mode, distance });
  const built = buildFrozenShadowCandidates({
    activation: activation(at),
    ...dataset
  });
  return { dataset, built };
}

function makeShadowSignal() {
  const { built } = buildFixture();
  assert.equal(built.candidates.length, 8);
  return buildShadowSignal(built.candidates[0]);
}

function makePersistedEvidenceRow() {
  const signal = makeShadowSignal();
  const result = resolveFrozenPaperTrade({ signal, ...makeEvaluationData(signal, 'TERMINAL') });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-val-0028-001-evidence-'));
  try {
    return appendShadowResolution({ root, result }).row;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function referenceMean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function referenceSma(rows, index, period) {
  if (index < period - 1) return null;
  return referenceMean(rows.slice(index - period + 1, index + 1).map(row => Number(row.close)));
}

function referenceAtr(rows, index, period = 20) {
  if (index < period) return null;
  const ranges = [];
  for (let cursor = index - period + 1; cursor <= index; cursor += 1) {
    const previousClose = Number(rows[cursor - 1].close);
    ranges.push(Math.max(
      Number(rows[cursor].high) - Number(rows[cursor].low),
      Math.abs(Number(rows[cursor].high) - previousClose),
      Math.abs(Number(rows[cursor].low) - previousClose)
    ));
  }
  return referenceMean(ranges);
}

function lockedReferenceCandidates({ bars1hBySymbol, bars4hBySymbol }, index = SIGNAL_INDEX) {
  const signalBar = bars1hBySymbol.BTCUSDT[index];
  const decisionTime = Number(signalBar.openTime) + HOUR;
  let fourHourIndex = -1;
  for (let cursor = 0; cursor < bars4hBySymbol.BTCUSDT.length; cursor += 1) {
    if (Number(bars4hBySymbol.BTCUSDT[cursor].closeBoundary) <= decisionTime) fourHourIndex = cursor;
  }
  const btc4h = bars4hBySymbol.BTCUSDT;
  const btcFast = referenceSma(btc4h, fourHourIndex, 60);
  const btcSlow = referenceSma(btc4h, fourHourIndex, 180);
  const breadth = HY_EXP_0028_SYMBOLS.map(symbol => {
    const rows = bars4hBySymbol[symbol];
    const row = rows[fourHourIndex];
    const slow = referenceSma(rows, fourHourIndex, 180);
    return Number(row.close) > slow ? 'above' : Number(row.close) < slow ? 'below' : 'equal';
  });
  const above = breadth.filter(value => value === 'above').length;
  const below = breadth.filter(value => value === 'below').length;
  const btcClose = Number(btc4h[fourHourIndex].close);
  const required = Math.ceil(HY_EXP_0028_SYMBOLS.length * 2 / 3);
  const bull = btcFast > btcSlow && btcClose > btcSlow && above >= required;
  const bear = btcFast < btcSlow && btcClose < btcSlow && below >= required;
  const regime = bull ? 'BULL' : bear ? 'BEAR' : 'SIDEWAYS';
  const side = bull ? 'BUY' : bear ? 'SELL' : null;
  const breadthCount = bull ? above : bear ? below : Math.max(above, below);
  const candidates = [];
  for (const symbol of HY_EXP_0028_SYMBOLS) {
    const rows = bars1hBySymbol[symbol];
    const row = rows[index];
    const priorEntry = rows.slice(index - 120, index);
    const priorExit = rows.slice(index - 60, index);
    const atr20 = referenceAtr(rows, index);
    const sma60 = referenceSma(rows, index, 60);
    const sma180 = referenceSma(rows, index, 180);
    const priorHigh = priorEntry.length === 120 ? Math.max(...priorEntry.map(item => Number(item.high))) : null;
    const priorLow = priorEntry.length === 120 ? Math.min(...priorEntry.map(item => Number(item.low))) : null;
    const priorExitHigh = priorExit.length === 60 ? Math.max(...priorExit.map(item => Number(item.high))) : null;
    const priorExitLow = priorExit.length === 60 ? Math.min(...priorExit.map(item => Number(item.low))) : null;
    const breakout = side === 'BUY'
      ? priorHigh != null && Number(row.close) > priorHigh
      : side === 'SELL'
        ? priorLow != null && Number(row.close) < priorLow
        : false;
    const sixBars = bars4hBySymbol[symbol].slice(fourHourIndex - 5, fourHourIndex + 1);
    const sixQuoteVolume = sixBars.length === 6
      ? sixBars.reduce((sum, item) => sum + Number(item.quoteVolume), 0)
      : null;
    const sideMultiplier = side === 'BUY' ? 1 : side === 'SELL' ? -1 : 1;
    const features = breakout && atr20 > 0 && sma60 != null && sma180 != null
      && priorExitLow != null && priorExitHigh != null && sixQuoteVolume != null
      ? [
        sideMultiplier * (Number(row.close) - (side === 'BUY' ? priorHigh : priorLow)) / atr20,
        sideMultiplier * (Number(row.close) - sma60) / atr20,
        sideMultiplier * (sma60 - sma180) / atr20,
        breadthCount / HY_EXP_0028_SYMBOLS.length,
        HY_EXP_0028_SYMBOLS.length / 8,
        Math.log1p(sixQuoteVolume),
        atr20 / Number(row.close),
        sideMultiplier * (Number(row.close) - (side === 'BUY' ? priorExitLow : priorExitHigh)) / atr20
      ]
      : null;
    if (regime === 'BULL' && side === 'BUY' && breakout && features && features[7] >= HY_EXP_0028_FROZEN_Q75) {
      candidates.push({
        id: `${symbol}:${decisionTime}`,
        symbol,
        decisionTime,
        regime,
        side,
        atr20,
        channelDistance: features[7],
        features,
        entryTime: decisionTime + HY_EXP_0028_ENTRY_OFFSET_MS,
        frozenQ75: HY_EXP_0028_FROZEN_Q75
      });
    }
  }
  return { candidates, regime, side, decisionTime };
}

function makeEvaluationData(signal, exitMode = 'TERMINAL', { includeEntry = true, includeFunding = false } = {}) {
  const decisionTime = signal.decisionTime;
  const base = decisionTime - 60 * HOUR;
  const bars1h = Array.from({ length: 66 }, (_, index) => {
    const openTime = base + index * HOUR;
    const evaluation = index >= 60;
    const close = evaluation && index === 60 && exitMode === 'CHANNEL' ? 89 : 100;
    return {
      openTime,
      closeBoundary: openTime + HOUR,
      open: 100,
      high: 101,
      low: evaluation ? Math.min(99, close) : 90,
      close
    };
  });
  const stopPrice = 100 - 2 * signal.atr20;
  const bars5m = [];
  for (let openTime = signal.entryTime; openTime < decisionTime + 7 * HOUR; openTime += FIVE_MINUTES) {
    const isStopBar = exitMode === 'ATR_STOP' && openTime === signal.entryTime + FIVE_MINUTES;
    bars5m.push({
      openTime,
      closeTime: openTime + FIVE_MINUTES - 1,
      open: 100,
      high: 101,
      low: isStopBar ? stopPrice - 1 : 99,
      close: 100
    });
  }
  if (!includeEntry) bars5m.shift();
  const fundingRows = includeFunding
    ? [{ eventTime: decisionTime + 3 * HOUR, fundingRate: 0.0001 }]
    : [];
  return {
    bars1h,
    bars5m,
    fundingRows,
    asOfTime: decisionTime + 7 * HOUR
  };
}

function lockedReferenceLabel(signal, data) {
  const fiveMinuteRows = data.bars5m
    .filter(row => row.closeTime <= data.asOfTime)
    .sort((left, right) => left.openTime - right.openTime);
  const entryBar = fiveMinuteRows.find(row => row.openTime === signal.entryTime);
  if (!entryBar) return { status: 'PENDING', reason: 'ENTRY_BAR_NOT_YET_OBSERVED' };
  const entryPrice = entryBar.open;
  const stopPrice = entryPrice - 2 * signal.atr20;
  const evaluationBars = data.bars1h
    .map((row, index) => ({ row, index }))
    .filter(item => item.row.closeBoundary > signal.entryTime)
    .slice(0, HY_EXP_0028_MAX_HOLD_BARS);
  let cursor = signal.entryTime;
  let exit = null;
  for (const { row, index } of evaluationBars) {
    for (let openTime = cursor; openTime < row.closeBoundary; openTime += FIVE_MINUTES) {
      const five = fiveMinuteRows.find(item => item.openTime === openTime);
      if (!five) return { status: 'PENDING', reason: 'FORWARD_5M_BAR_NOT_YET_OBSERVED' };
      if (five.open <= stopPrice) {
        exit = { price: five.open, time: five.openTime, reason: 'ATR_STOP' };
        break;
      }
      if (five.low <= stopPrice) {
        exit = { price: stopPrice, time: five.openTime + 1, reason: 'ATR_STOP' };
        break;
      }
    }
    if (exit) break;
    const channelLow = Math.min(...data.bars1h.slice(index - 60, index).map(item => item.low));
    if (row.close <= channelLow) {
      exit = { price: row.close, time: row.closeBoundary, reason: 'DYNAMIC_CHANNEL_EXIT' };
      break;
    }
    cursor = row.closeBoundary;
    if (evaluationBars.at(-1).row.openTime === row.openTime) {
      exit = { price: row.close, time: row.closeBoundary, reason: 'TERMINAL_EXIT' };
    }
  }
  const fundingEvents = [];
  let fundingPnl = 0;
  for (const row of data.fundingRows) {
    if (row.eventTime < signal.entryTime || row.eventTime > exit.time) continue;
    let markPrice = entryPrice;
    for (const bar of fiveMinuteRows) {
      if (bar.openTime > row.eventTime) break;
      markPrice = bar.close;
    }
    const payment = -markPrice * row.fundingRate;
    fundingPnl += payment;
    fundingEvents.push({ fundingTime: row.eventTime, fundingRate: row.fundingRate, markPrice, payment });
  }
  const grossPriceReturnBps = (exit.price - entryPrice) / entryPrice * 10_000;
  const fundingPnlBps = fundingPnl / entryPrice * 10_000;
  return {
    status: 'RESOLVED',
    entryTime: signal.entryTime,
    entryPrice,
    stopPrice,
    exitTime: exit.time,
    exitPrice: exit.price,
    exitReason: exit.reason,
    grossPriceReturnBps,
    funding: { fundingPnlBps, events: fundingEvents },
    net18Bps: grossPriceReturnBps - HY_EXP_0028_BASE_COST_BPS + fundingPnlBps,
    net27Bps: grossPriceReturnBps - HY_EXP_0028_STRESS_COST_BPS + fundingPnlBps
  };
}

test('HY-VAL-0028-001 freezes source identifiers, hashes, universe, and costs', () => {
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
  assert.equal(HY_VAL_0028_001.candidateEngine.externalPrecomputedValuesAuthority, false);
  assert.equal(HY_VAL_0028_001.candidateEngine.diagnosticParityAssertionsOnly, true);
  assert.deepEqual(verifyFrozenSourceManifest(), { ok: true, files: HY_EXP_0028_SOURCE_FILE_HASHES });
  assert.throws(() => verifyFrozenSourceManifest({
    ...HY_VAL_0028_001.immutableSource,
    files: [{ path: 'src/research/hy-exp-0024.mjs', sha256: 'tampered' }]
  }), /hash drifted/);
});

test('public endpoint contract contains no private, account, order, OOS, or trading API', () => {
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
  assert.deepEqual(value.eligibility(ACTIVATION_TIME), { eligible: false, reason: 'SHADOW_ACTIVATION_NOT_SET' });
  assert.equal(value.setOnce(ACTIVATION_TIME), ACTIVATION_TIME);
  assert.throws(() => value.setOnce(ACTIVATION_TIME + 1), /immutable/);
});

test('pre-activation signal is rejected and warmup never counts as validation', () => {
  const value = activation(DECISION_TIME + HOUR);
  const built = buildFrozenShadowCandidates({ activation: value, ...makeCausalDataset() });
  assert.equal(built.candidates.length, 0);
  assert.equal(built.rejections.filter(row => row.rejection === 'PRE_ACTIVATION_SIGNAL').length, 8);
  const warmup = classifyWarmupRecord('2026-08-23T23:59:59.000Z', value);
  assert.equal(warmup.tag, 'WARMUP_ONLY');
  assert.equal(warmup.countsAsValidation, false);
  assert.equal(warmup.countsAsPnl, false);
  const prospective = classifyWarmupRecord(new Date(DECISION_TIME + HOUR).toISOString(), value);
  assert.equal(prospective.tag, 'PROSPECTIVE');
  assert.equal(prospective.countsAsValidation, true);
});

test('frozen candidate engine derives regime, breadth, ATR, channels, and features internally', () => {
  const { dataset, built } = buildFixture();
  const reference = lockedReferenceCandidates(dataset);
  assert.equal(built.candidates.length, reference.candidates.length);
  assert.deepEqual(built.candidates.map(row => row.id), reference.candidates.map(row => row.id));
  for (const candidate of built.candidates) {
    const expected = reference.candidates.find(row => row.id === candidate.id);
    assert.ok(expected);
    assert.equal(candidate.symbol, expected.symbol);
    assert.equal(candidate.decisionTime, expected.decisionTime);
    assert.equal(candidate.regime, expected.regime);
    assert.equal(candidate.side, expected.side);
    assert.equal(candidate.frozenQ75, expected.frozenQ75);
    assert.equal(candidate.atr20, expected.atr20);
    assert.equal(candidate.channelDistance, expected.channelDistance);
    assert.deepEqual(candidate.features, expected.features);
    assert.equal(candidate.theoreticalEntryTime, expected.entryTime);
  }
  const asserted = createFrozenRuleACandidate({
    activation: activation(),
    derivedContext: built.contexts[0],
    symbol: 'BTCUSDT',
    diagnostics: { regime: 'BEAR', side: 'SELL', atr20: 0, channelDistance: 0 }
  });
  assert.deepEqual(asserted, { accepted: false, rejection: 'FROZEN_PARITY_ASSERTION_MISMATCH' });
});

test('candidate parity fixtures cover bull, sideways, bear, Q75 rejection, and exact Q75', () => {
  const cases = [
    { name: 'BULL admitted signal', mode: 'BULL', distance: 15, expected: 8 },
    { name: 'SIDEWAYS rejection', mode: 'SIDEWAYS', distance: 15, expected: 0 },
    { name: 'BEAR rejection', mode: 'BEAR', distance: 15, expected: 0 },
    { name: 'below-Q75 rejection', mode: 'BULL', distance: HY_EXP_0028_FROZEN_Q75 - 0.01, expected: 0 },
    { name: 'exact-Q75 boundary', mode: 'BULL', distance: HY_EXP_0028_FROZEN_Q75, expected: 8 }
  ];
  for (const fixture of cases) {
    const { built } = buildFixture(fixture);
    assert.equal(built.candidates.length, fixture.expected, fixture.name);
    if (fixture.name === 'below-Q75 rejection') {
      assert.equal(built.rejections.filter(row => row.rejection === 'BELOW_FROZEN_Q75').length, 8);
    }
  }
});

test('production email candidates reuse frozen Rule A parity without shadow activation or outcomes', () => {
  const dataset = makeCausalDataset();
  const shadow = buildFrozenShadowCandidates({ activation: activation(), ...dataset });
  const production = buildFrozenProductionEmailCandidates(dataset);
  assert.equal(production.candidates.length, shadow.candidates.length);
  assert.deepEqual(
    production.candidates.map(row => row.id),
    shadow.candidates.map(row => row.id)
  );
  for (const candidate of production.candidates) {
    const expected = shadow.candidates.find(row => row.id === candidate.id);
    assert.ok(expected);
    assert.equal(candidate.symbol, expected.symbol);
    assert.equal(candidate.decisionTime, expected.decisionTime);
    assert.equal(candidate.channelDistance, expected.channelDistance);
    assert.deepEqual(candidate.features, expected.features);
    assert.equal(candidate.theoreticalEntryTime, expected.theoreticalEntryTime);
    assert.equal(candidate.candidateAuthority, 'EMAIL_SIGNAL_CANDIDATE');
    assert.equal(candidate.candidateOnly, true);
    assert.equal(candidate.outcomeDataUsedForAdmission, false);
    assert.equal(candidate.shadowValidationActivatedAt, undefined);
    assert.equal(candidate.emailSent, false);
    assert.equal(candidate.productionAdvisory, false);
    assert.equal(candidate.orderPlaced, false);
  }
});

test('causal 1h missing bar immediately before signal is rejected', () => {
  const dataset = structuredClone(makeCausalDataset());
  dataset.bars1hBySymbol.BTCUSDT.splice(SIGNAL_INDEX - 1, 1);
  const built = buildFrozenShadowCandidates({ activation: activation(), ...dataset });
  assert.equal(built.candidates.length, 0);
  assert.equal(built.rejections[0].rejection, 'CAUSAL_1H_GAP');
});

test('causal 1h gap inside the prior 120-entry history is rejected', () => {
  const dataset = structuredClone(makeCausalDataset());
  dataset.bars1hBySymbol.ETHUSDT.splice(SIGNAL_INDEX - 60, 1);
  const built = buildFrozenShadowCandidates({ activation: activation(), ...dataset });
  assert.equal(built.candidates.length, 0);
  assert.equal(built.rejections[0].rejection, 'CAUSAL_1H_GAP');
});

test('causal 1h duplicate timestamp is rejected', () => {
  const dataset = structuredClone(makeCausalDataset());
  const duplicate = { ...dataset.bars1hBySymbol.BNBUSDT[SIGNAL_INDEX - 10] };
  dataset.bars1hBySymbol.BNBUSDT.splice(SIGNAL_INDEX - 10, 0, duplicate);
  const built = buildFrozenShadowCandidates({ activation: activation(), ...dataset });
  assert.equal(built.candidates.length, 0);
  assert.equal(built.rejections[0].rejection, 'CAUSAL_1H_DUPLICATE_OPEN_TIME');
});

test('one-symbol 1h signal misalignment is rejected', () => {
  const dataset = structuredClone(makeCausalDataset());
  dataset.bars1hBySymbol.SOLUSDT = dataset.bars1hBySymbol.SOLUSDT.map(row => ({
    ...row,
    openTime: row.openTime + HOUR,
    closeBoundary: row.closeBoundary + HOUR
  }));
  const built = buildFrozenShadowCandidates({ activation: activation(), ...dataset });
  assert.equal(built.candidates.length, 0);
  assert.equal(built.rejections[0].rejection, 'CAUSAL_1H_SIGNAL_ALIGNMENT');
});

test('causal 4h gap inside BTC regime history is rejected', () => {
  const dataset = structuredClone(makeCausalDataset());
  dataset.bars4hBySymbol.BTCUSDT.splice(100, 1);
  const built = buildFrozenShadowCandidates({ activation: activation(), ...dataset });
  assert.equal(built.candidates.length, 0);
  assert.equal(built.rejections[0].rejection, 'CAUSAL_4H_GAP');
});

test('one-symbol 4h bucket misalignment is rejected', () => {
  const dataset = structuredClone(makeCausalDataset());
  dataset.bars4hBySymbol.LTCUSDT = dataset.bars4hBySymbol.LTCUSDT.map(row => ({
    ...row,
    openTime: row.openTime + 4 * HOUR,
    closeBoundary: row.closeBoundary + 4 * HOUR
  }));
  const built = buildFrozenShadowCandidates({ activation: activation(), ...dataset });
  assert.equal(built.candidates.length, 0);
  assert.equal(built.rejections[0].rejection, 'CAUSAL_4H_BUCKET_MISALIGNED');
});

test('malformed causal OHLC is rejected without coercion', () => {
  const dataset = structuredClone(makeCausalDataset());
  const row = dataset.bars1hBySymbol.BTCUSDT[SIGNAL_INDEX];
  row.high = row.close - 1;
  const built = buildFrozenShadowCandidates({ activation: activation(), ...dataset });
  assert.equal(built.candidates.length, 0);
  assert.equal(built.rejections[0].rejection, 'CAUSAL_1H_OHLC_INVALID');
});

test('negative and non-finite required 4h quote volume are rejected', () => {
  for (const quoteVolume of [-1, Number.NaN]) {
    const dataset = structuredClone(makeCausalDataset());
    dataset.bars4hBySymbol.BTCUSDT[100].quoteVolume = quoteVolume;
    const built = buildFrozenShadowCandidates({ activation: activation(), ...dataset });
    assert.equal(built.candidates.length, 0);
    assert.equal(built.rejections[0].rejection, 'CAUSAL_4H_QUOTE_VOLUME_INVALID');
  }
});

test('shadow signal uses signal+5m entry and never enters Gmail or production advisory paths', () => {
  const signal = makeShadowSignal();
  assert.equal(signal.status, 'SHADOW_SIGNAL');
  assert.equal(signal.entryTime, signal.decisionTime + HY_EXP_0028_ENTRY_OFFSET_MS);
  assert.equal(signal.emailSent, false);
  assert.equal(signal.productionAdvisory, false);
  assert.equal(signal.orderPlaced, false);
  assert.equal(signal.safety.authorization_mode, 'PAPER_ONLY');
  assert.equal(signal.safety.final_oos_read, false);

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

test('resolver emits a complete safe RESOLVED record that persists end-to-end', () => {
  const signal = makeShadowSignal();
  const data = makeEvaluationData(signal, 'TERMINAL', { includeFunding: true });
  const result = resolveFrozenPaperTrade({ signal, ...data });
  assert.equal(result.status, 'RESOLVED');
  assert.equal(result.paperPnlComputed, true);
  assert.equal(result.emailSent, false);
  assert.equal(result.productionAdvisory, false);
  assert.equal(result.orderPlaced, false);
  assert.deepEqual(result.safety, {
    signal_only: true,
    authorization_mode: 'PAPER_ONLY',
    live_orders_enabled: false,
    account_api: false,
    order_api: false,
    automatic_trading: false,
    final_oos_read: false
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-val-0028-001-'));
  try {
    const persisted = appendShadowResolution({ root, result });
    assert.equal(persisted.inserted, true);
    const duplicate = appendShadowResolution({ root, result });
    assert.equal(duplicate.duplicate, true);
    assert.throws(() => appendShadowResolution({
      root,
      result: { ...result, net18Bps: result.net18Bps + 1 }
    }), /immutable shadow key conflict/);
    const rows = fs.readFileSync(shadowStoragePaths(root).resolutions, 'utf8').trim().split(/\r?\n/);
    assert.equal(rows.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('only a real immutable resolved row proves provenance and counts once', () => {
  const row = makePersistedEvidenceRow();
  assert.deepEqual(validateProspectiveResolvedEvidence(row), { ok: true, reason: null });
  assert.doesNotThrow(() => assertProspectiveResolvedEvidence(row));
  const combined = combineValidationEvidence({ prospectiveResolvedRows: [row] });
  assert.equal(combined.prospectiveValidatedSignals, 1);
  assert.throws(() => combineValidationEvidence({ prospectiveResolvedRows: [row, row] }), /unique immutable keys/);
});

test('prospective evidence counting fails closed on provenance, identity, cost, safety, and activation mismatches', () => {
  const row = makePersistedEvidenceRow();
  const decisionBeforeActivation = row.shadowValidationActivatedAt - 1;
  const invalidCases = [
    ['wrong validationId', { validationId: 'HY-VAL-WRONG' }, 'EVIDENCE_VALIDATION_ID_MISMATCH'],
    ['wrong strategyId', { strategyId: 'HY-EXP-WRONG' }, 'EVIDENCE_STRATEGY_ID_MISMATCH'],
    ['wrong policyId', { policyId: 'POLICY-WRONG' }, 'EVIDENCE_POLICY_ID_MISMATCH'],
    ['wrong sourceCommit', { sourceCommit: 'deadbeef' }, 'EVIDENCE_SOURCE_COMMIT_MISMATCH'],
    ['invalid symbol', { symbol: 'NOTUSDT' }, 'EVIDENCE_SYMBOL_NOT_FROZEN'],
    ['mismatched signalId', { signalId: 'BTCUSDT:wrong' }, 'EVIDENCE_SIGNAL_ID_NON_CANONICAL'],
    ['non-canonical idempotencyKey', { idempotencyKey: 'manual-key' }, 'EVIDENCE_IDEMPOTENCY_KEY_NON_CANONICAL'],
    ['baseCostBps mismatch', { costs: { ...row.costs, baseCostBps: 10 } }, 'EVIDENCE_BASE_COST_MISMATCH'],
    ['stressCostBps mismatch', { costs: { ...row.costs, stressCostBps: 20 } }, 'EVIDENCE_STRESS_COST_MISMATCH'],
    ['unsafe safety envelope', { safety: { ...row.safety, account_api: true } }, 'EVIDENCE_SAFETY_ENVELOPE_INVALID'],
    ['emailSent true', { emailSent: true }, 'EVIDENCE_EMAIL_SAFETY_VIOLATION'],
    ['orderPlaced true', { orderPlaced: true }, 'EVIDENCE_ORDER_SAFETY_VIOLATION'],
    ['missing activation proof', { shadowValidationActivatedAt: undefined }, 'EVIDENCE_ACTIVATION_PROOF_MISSING'],
    ['decision before activation', {
      decisionTime: decisionBeforeActivation,
      signalId: `${row.symbol}:${decisionBeforeActivation}`,
      idempotencyKey: `${row.validationId}:${row.symbol}:${decisionBeforeActivation}`
    }, 'EVIDENCE_PRE_ACTIVATION_DECISION'],
    ['manually constructed minimal RESOLVED row', {
      validationId: undefined,
      strategyId: undefined,
      policyId: undefined,
      sourceCommit: undefined,
      status: 'RESOLVED',
      paperPnlComputed: true,
      immutable: true
    }, 'EVIDENCE_VALIDATION_ID_MISMATCH']
  ];
  for (const [name, changes, reason] of invalidCases) {
    const invalid = { ...row, ...changes };
    assert.deepEqual(validateProspectiveResolvedEvidence(invalid), { ok: false, reason }, name);
    assert.throws(() => combineValidationEvidence({ prospectiveResolvedRows: [invalid] }), /invalid prospective resolved evidence/, name);
    assert.throws(() => assertProspectiveResolvedEvidence(invalid), /invalid prospective resolved evidence/, name);
  }
});

test('PENDING resolution is runtime-only and cannot block later immutable RESOLVED storage', () => {
  const signal = makeShadowSignal();
  const pending = resolveFrozenPaperTrade({ signal, bars1h: [], bars5m: [], fundingRows: [], asOfTime: signal.decisionTime });
  assert.equal(pending.status, 'PENDING');
  assert.equal(pending.paperPnlComputed, false);
  const pendingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-val-pending-'));
  try {
    assert.throws(() => appendShadowResolution({ root: pendingRoot, result: pending }), /only final RESOLVED/);
    assert.equal(fs.existsSync(shadowStoragePaths(pendingRoot).resolutions), false);
  } finally {
    fs.rmSync(pendingRoot, { recursive: true, force: true });
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hy-val-0028-001-'));
  try {
    assert.equal(fs.existsSync(shadowStoragePaths(root).resolutions), false);
    const resolved = resolveFrozenPaperTrade({ signal, ...makeEvaluationData(signal, 'TERMINAL') });
    const persisted = appendShadowResolution({ root, result: resolved });
    assert.equal(persisted.inserted, true);
    assert.equal(appendShadowResolution({ root, result: resolved }).duplicate, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('behavioral parity matches frozen exit, entry, funding, and cost semantics', () => {
  const signal = makeShadowSignal();
  for (const mode of ['ATR_STOP', 'CHANNEL', 'TERMINAL']) {
    const data = makeEvaluationData(signal, mode, { includeFunding: mode === 'TERMINAL' });
    const expected = lockedReferenceLabel(signal, data);
    const actual = resolveFrozenPaperTrade({ signal, ...data });
    for (const field of ['status', 'entryTime', 'entryPrice', 'stopPrice', 'exitTime', 'exitPrice', 'exitReason', 'grossPriceReturnBps', 'net18Bps', 'net27Bps']) {
      assert.equal(actual[field], expected[field], mode + ':' + field);
    }
    assert.equal(actual.funding.fundingPnlBps, expected.funding.fundingPnlBps, mode + ':fundingPnlBps');
    assert.deepEqual(actual.funding.events, expected.funding.events, mode + ':fundingEvents');
  }
});

test('missing exact +5m entry remains pending and never fabricates a later entry', () => {
  const signal = makeShadowSignal();
  const data = makeEvaluationData(signal, 'TERMINAL', { includeEntry: false });
  const result = resolveFrozenPaperTrade({ signal, ...data });
  assert.equal(result.status, 'PENDING');
  assert.equal(result.reason, 'ENTRY_BAR_NOT_YET_OBSERVED');
  assert.equal(result.paperPnlComputed, false);
  assert.equal(result.emailSent, false);
  assert.equal(result.productionAdvisory, false);
  assert.equal(result.orderPlaced, false);
});

test('missing forward 5m bar remains PENDING and is never resolved', () => {
  const signal = makeShadowSignal();
  const data = makeEvaluationData(signal, 'TERMINAL');
  const missingOpenTime = signal.entryTime + FIVE_MINUTES;
  data.bars5m = data.bars5m.filter(row => row.openTime !== missingOpenTime);
  const result = resolveFrozenPaperTrade({ signal, ...data });
  assert.equal(result.status, 'PENDING');
  assert.equal(result.reason, 'FORWARD_5M_CONTINUITY_FAILURE');
  assert.equal(result.continuityRejection, 'FORWARD_5M_GAP');
  assert.equal(result.paperPnlComputed, false);
});

test('gap in the prior 60-bar dynamic exit history cannot resolve evidence', () => {
  const signal = makeShadowSignal();
  const data = makeEvaluationData(signal, 'TERMINAL');
  data.bars1h.splice(30, 1);
  const result = resolveFrozenPaperTrade({ signal, ...data });
  assert.equal(result.status, 'PENDING');
  assert.equal(result.reason, 'FORWARD_1H_CONTINUITY_FAILURE');
  assert.equal(result.continuityRejection, 'FORWARD_1H_GAP');
  assert.equal(result.paperPnlComputed, false);
});

test('outcome cannot be resolved for an uncounted or pre-activation signal', () => {
  const signal = makeShadowSignal();
  assert.throws(() => resolveFrozenPaperTrade({ signal: { countedProspective: false }, asOfTime: ACTIVATION_TIME }), /pre-activation/);
  assert.throws(() => resolveFrozenPaperTrade({
    signal: { ...signal, countedProspective: true, decisionTime: ACTIVATION_TIME - HOUR },
    asOfTime: ACTIVATION_TIME + 10 * HOUR
  }), /pre-activation/);
});

test('combined evidence keeps original 43 separate and excludes validation gaps', () => {
  const completedDays = countCompletedValidationDays({
    coveredUtcDays: ['2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27'],
    completedUtcDays: ['2026-08-24', '2026-08-25', '2026-08-27']
  });
  assert.equal(completedDays, 3);
  const baseEvidence = makePersistedEvidenceRow();
  const prospectiveRows = HY_EXP_0028_SYMBOLS.slice(0, 7).map(symbol => ({
    ...baseEvidence,
    symbol,
    signalId: `${symbol}:${baseEvidence.decisionTime}`,
    idempotencyKey: `${baseEvidence.validationId}:${symbol}:${baseEvidence.decisionTime}`
  }));
  const combined = combineValidationEvidence({
    originalValidatedSignals: 43,
    prospectiveResolvedRows: prospectiveRows,
    originalValidationDays: 53,
    prospectiveCompletedValidationDays: completedDays
  });
  assert.equal(combined.originalValidatedSignals, 43);
  assert.equal(combined.prospectiveValidatedSignals, 7);
  assert.equal(combined.prospectiveValidatedSignalsDefinition, 'COUNT OF IMMUTABLE RESOLVED SHADOW TRADE EVIDENCE ROWS');
  assert.equal(combined.combinedValidatedSignals, 50);
  assert.equal(combined.combinedValidationDays, 56);
  assert.equal(combined.metricsMustBeRecomputedFromTradeRows, true);
  assert.throws(() => combineValidationEvidence({
    prospectiveValidatedSignals: 1
  }), /derived from immutable resolved rows/);
  assert.throws(() => combineValidationEvidence({
    prospectiveResolvedRows: [{ status: 'PENDING', paperPnlComputed: false, immutable: true, idempotencyKey: 'pending' }]
  }), /invalid prospective resolved evidence/);
});
