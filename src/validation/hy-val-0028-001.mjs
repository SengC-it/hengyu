import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const CONFIG_PATH = fileURLToPath(new URL('../../config/hy-val-0028-001.json', import.meta.url));
const CONFIG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

export const HY_VAL_0028_001 = Object.freeze(CONFIG);
export const HY_VAL_0028_001_ID = 'HY-VAL-0028-001';
export const HY_EXP_0028_STRATEGY_ID = 'HY-EXP-0028';
export const HY_EXP_0028_POLICY_ID = 'EMAIL_SIGNAL_RELEASE-001';
export const HY_EXP_0028_SOURCE_COMMIT = 'a61cb20318af1e0b188c0276a1a3d65e52bc4467';
export const HY_EXP_0028_PREREGISTRATION_SHA256 = '4085fad293275ce055a67516d1c8168331f221a91b688f3b093ff2eef11708a3';
export const HY_EXP_0028_HOLDOUT_RESULT_SHA256 = '92304ec0252be9ee2bba2e13a9ccc64c923f3b067d91e12513be089d56f3d2e5';
export const HY_EXP_0028_FROZEN_Q75 = 10.051547664406323;
export const HY_EXP_0028_BASE_COST_BPS = 18;
export const HY_EXP_0028_STRESS_COST_BPS = 27;
export const HY_EXP_0028_RESEARCH_EQUITY_USDT = 100_000;
export const HY_EXP_0028_ENTRY_OFFSET_MS = 5 * 60 * 1_000;
export const HY_EXP_0028_MAX_HOLD_BARS = 6;
export const HY_EXP_0028_SYMBOLS = Object.freeze([
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT',
  'XRPUSDT', 'DOGEUSDT', 'LINKUSDT', 'LTCUSDT'
]);
export const HY_VAL_PUBLIC_ENDPOINTS = Object.freeze([
  'https://fapi.binance.com/fapi/v1/klines',
  'https://fapi.binance.com/fapi/v1/fundingRate',
  'https://fapi.binance.com/fapi/v1/exchangeInfo'
]);

const HOUR = 60 * 60 * 1_000;
const FIVE_MINUTES = 5 * 60 * 1_000;
const REQUIRED_FEATURE_INDEX = 7;

function finite(name, value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`invalid ${name}`);
  return parsed;
}

function timestamp(name, value) {
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`invalid ${name}`);
  return parsed;
}

function sideSign(side) {
  if (side === 'BUY') return 1;
  if (side === 'SELL') return -1;
  throw new Error(`invalid side ${side}`);
}

function directionalReturnBps(side, entryPrice, exitPrice) {
  return sideSign(side) * (exitPrice - entryPrice) / entryPrice * 10_000;
}

function publicSafety() {
  return {
    signal_only: true,
    authorization_mode: 'PAPER_ONLY',
    live_orders_enabled: false,
    account_api: false,
    order_api: false,
    automatic_trading: false,
    final_oos_read: false
  };
}

export class ShadowValidationActivation {
  #activatedAt = null;

  get activatedAt() {
    return this.#activatedAt;
  }

  setOnce(value) {
    if (this.#activatedAt != null) throw new Error('shadow validation activation is immutable');
    this.#activatedAt = timestamp('shadowValidationActivatedAt', value);
    return this.#activatedAt;
  }

  eligibility(decisionTime) {
    const parsedDecisionTime = timestamp('decisionTime', decisionTime);
    if (this.#activatedAt == null) {
      return { eligible: false, reason: 'SHADOW_ACTIVATION_NOT_SET' };
    }
    if (parsedDecisionTime < this.#activatedAt) {
      return { eligible: false, reason: 'PRE_ACTIVATION_SIGNAL' };
    }
    return { eligible: true, reason: null };
  }
}

export function classifyWarmupRecord(recordTime, activation) {
  const parsedTime = timestamp('recordTime', recordTime);
  const eligibility = activation.eligibility(parsedTime);
  return {
    ...eligibility,
    tag: eligibility.eligible ? 'PROSPECTIVE' : 'WARMUP_ONLY',
    countsAsValidation: eligibility.eligible,
    countsAsPnl: false
  };
}

function validateFrozenSource(sourceCommit = HY_EXP_0028_SOURCE_COMMIT) {
  if (sourceCommit !== HY_EXP_0028_SOURCE_COMMIT) throw new Error('HY-EXP-0028 source commit drifted');
}

function expectedChannelDistance({ signalClose, priorExitLow, atr20 }) {
  if (!(atr20 > 0)) return null;
  return (signalClose - priorExitLow) / atr20;
}

function parseBoundary(value) {
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasCausalCompletedHistory(rows, decisionTime, required) {
  if (!Array.isArray(rows) || rows.length !== required) return false;
  let previousCloseBoundary = null;
  return rows.every(row => {
    const openTime = parseBoundary(row.openTime);
    const closeBoundary = parseBoundary(row.closeBoundary ?? (openTime == null ? null : openTime + HOUR));
    const contiguous = previousCloseBoundary == null || closeBoundary === previousCloseBoundary + HOUR;
    previousCloseBoundary = closeBoundary;
    return openTime != null
      && closeBoundary != null
      && closeBoundary <= decisionTime
      && contiguous;
  });
}

export function createFrozenRuleACandidate({
  activation,
  symbol,
  decisionTime,
  regime,
  side,
  signalClose,
  priorEntryHigh,
  priorEntryBars = [],
  priorExitLow,
  priorExitBars = [],
  atr20,
  features,
  sourceCommit = HY_EXP_0028_SOURCE_COMMIT
} = {}) {
  validateFrozenSource(sourceCommit);
  const parsedDecisionTime = timestamp('decisionTime', decisionTime);
  const prospective = activation.eligibility(parsedDecisionTime);
  if (!prospective.eligible) return { accepted: false, rejection: prospective.reason };
  if (!HY_EXP_0028_SYMBOLS.includes(symbol)) return { accepted: false, rejection: 'SYMBOL_NOT_IN_FROZEN_UNIVERSE' };
  if (regime !== 'BULL' || side !== 'BUY') return { accepted: false, rejection: 'RULE_A_REQUIRES_BULL_BUY' };
  if (!hasCausalCompletedHistory(priorEntryBars, parsedDecisionTime, 120)
    || !hasCausalCompletedHistory(priorExitBars, parsedDecisionTime, 60)) {
    return { accepted: false, rejection: 'INSUFFICIENT_FROZEN_HISTORY' };
  }
  const numericEntryBars = priorEntryBars.map(row => Number(row.high));
  const numericExitBars = priorExitBars.map(row => Number(row.low));
  const computedPriorEntryHigh = Math.max(...numericEntryBars);
  const computedPriorExitLow = Math.min(...numericExitBars);
  if (!numericEntryBars.every(Number.isFinite) || !numericExitBars.every(Number.isFinite)) {
    return { accepted: false, rejection: 'INCOMPLETE_FROZEN_HISTORY' };
  }
  if (Number(priorEntryHigh) !== computedPriorEntryHigh
    || Number(priorExitLow) !== computedPriorExitLow) {
    return { accepted: false, rejection: 'FROZEN_REFERENCE_PARITY_MISMATCH' };
  }
  const numericSignalClose = Number(signalClose);
  const numericAtr20 = Number(atr20);
  const breakout = numericSignalClose > computedPriorEntryHigh;
  const channelDistance = expectedChannelDistance({
    signalClose: numericSignalClose,
    priorExitLow: computedPriorExitLow,
    atr20: numericAtr20
  });
  if (!breakout) return { accepted: false, rejection: 'NO_BREAKOUT' };
  if (!(channelDistance >= HY_EXP_0028_FROZEN_Q75)) {
    return { accepted: false, rejection: 'BELOW_FROZEN_Q75' };
  }
  if (!Array.isArray(features) || features.length <= REQUIRED_FEATURE_INDEX) {
    return { accepted: false, rejection: 'MISSING_FROZEN_FEATURE_VECTOR' };
  }
  const numericFeatures = features.map(Number);
  if (!numericFeatures.every(Number.isFinite)) {
    return { accepted: false, rejection: 'INVALID_FROZEN_FEATURE_VECTOR' };
  }
  if (numericFeatures[REQUIRED_FEATURE_INDEX] !== channelDistance) {
    return { accepted: false, rejection: 'FROZEN_FEATURE_PARITY_MISMATCH' };
  }
  return {
    accepted: true,
    candidate: {
      validationId: HY_VAL_0028_001_ID,
      strategyId: HY_EXP_0028_STRATEGY_ID,
      policyId: HY_EXP_0028_POLICY_ID,
      sourceCommit,
      id: `${symbol}:${parsedDecisionTime}`,
      symbol,
      side: 'BUY',
      regime: 'BULL',
      rule: 'RULE_A_CHANNEL_DISTANCE_Q75',
      decisionTime: parsedDecisionTime,
      theoreticalDecisionTime: parsedDecisionTime,
      theoreticalEntryTime: parsedDecisionTime + HY_EXP_0028_ENTRY_OFFSET_MS,
      shadowValidationActivatedAt: activation.activatedAt,
      signalClose: numericSignalClose,
      atr20: numericAtr20,
      priorEntryHigh: computedPriorEntryHigh,
      priorExitLow: computedPriorExitLow,
      channelDistance,
      frozenQ75: HY_EXP_0028_FROZEN_Q75,
      features: numericFeatures,
      countedProspective: true,
      candidateAuthority: 'NONE',
      emailSent: false,
      productionAdvisory: false,
      orderPlaced: false,
      safety: publicSafety()
    }
  };
}

export function buildShadowSignal(candidate) {
  if (candidate?.countedProspective !== true) throw new Error('only prospective candidates can become shadow signals');
  if (candidate?.emailSent !== false || candidate?.productionAdvisory !== false || candidate?.orderPlaced !== false) {
    throw new Error('shadow signal cannot enter production delivery or trading paths');
  }
  return {
    ...candidate,
    status: 'SHADOW_SIGNAL',
    entryRule: 'decisionTime + 5 minutes exact completed contract-price 5m bar OPEN',
    entryTime: candidate.decisionTime + HY_EXP_0028_ENTRY_OFFSET_MS,
    resolved: false,
    safety: publicSafety()
  };
}

function fiveMinuteAt(source, openTime) {
  if (source instanceof Map) return source.get(openTime) ?? null;
  return (source ?? []).find(row => Number(row.openTime) === openTime) ?? null;
}

function appendMark(marks, side, row, entryPrice) {
  const values = side === 'BUY'
    ? [row.low, row.high, row.close]
    : [row.high, row.low, row.close];
  values.forEach((price, index) => marks.push({
    time: Number(row.openTime) + index,
    price: Number(price),
    returnBps: directionalReturnBps(side, entryPrice, Number(price))
  }));
}

function markDrawdown(marks) {
  let peak = -Infinity;
  let drawdown = 0;
  for (const mark of marks) {
    peak = Math.max(peak, mark.returnBps);
    drawdown = Math.max(drawdown, peak - mark.returnBps);
  }
  return drawdown;
}

function researchPositionSize(entryPrice, stopPrice) {
  const stopDistanceBps = Math.abs(entryPrice - stopPrice) / entryPrice * 10_000;
  if (!(stopDistanceBps > 0)) return null;
  const lossBudget = HY_EXP_0028_RESEARCH_EQUITY_USDT * 0.0025;
  const riskNotional = lossBudget / (stopDistanceBps / 10_000);
  const paperNotional = Math.min(riskNotional, HY_EXP_0028_RESEARCH_EQUITY_USDT * 0.5);
  return {
    paperNotional,
    paperQuantity: paperNotional / entryPrice,
    lossAtStop: paperNotional * stopDistanceBps / 10_000
  };
}

function realizedFunding({ side, entryPrice, entryTime, exitTime, rows, bars5m }) {
  let fundingPnl = 0;
  const events = [];
  for (const row of rows ?? []) {
    const fundingTime = timestamp('fundingTime', row.eventTime ?? row.fundingTime);
    if (fundingTime < entryTime || fundingTime > exitTime) continue;
    let markPrice = entryPrice;
    for (const bar of bars5m) {
      if (Number(bar.openTime) > fundingTime) break;
      markPrice = Number(bar.close);
    }
    const fundingRate = finite('fundingRate', row.fundingRate);
    const payment = -sideSign(side) * (markPrice * fundingRate);
    fundingPnl += payment;
    events.push({ fundingTime, fundingRate, markPrice, payment });
  }
  return {
    fundingPnlBps: fundingPnl / entryPrice * 10_000,
    fundingPnlPerUnit: fundingPnl,
    events
  };
}

function pending(reason, requiredThrough, signal) {
  return {
    validationId: HY_VAL_0028_001_ID,
    strategyId: HY_EXP_0028_STRATEGY_ID,
    policyId: HY_EXP_0028_POLICY_ID,
    sourceCommit: signal.sourceCommit,
    signalId: signal.id,
    symbol: signal.symbol,
    side: signal.side,
    rule: 'RULE_A_CHANNEL_DISTANCE_Q75',
    decisionTime: signal.decisionTime,
    entryTime: signal.entryTime,
    status: 'PENDING',
    reason,
    requiredThrough,
    paperPnlComputed: false,
    safety: publicSafety()
  };
}

export function resolveFrozenPaperTrade({ signal, bars1h = [], bars5m = [], fundingRows = [], asOfTime } = {}) {
  if (signal?.countedProspective !== true) throw new Error('pre-activation signal cannot be resolved');
  validateFrozenSource(signal.sourceCommit);
  const activationAt = timestamp('shadowValidationActivatedAt', signal.shadowValidationActivatedAt);
  const decisionTime = timestamp('decisionTime', signal.decisionTime);
  if (decisionTime < activationAt) {
    throw new Error('pre-activation signal cannot be resolved');
  }
  const asOf = timestamp('asOfTime', asOfTime);
  const requiredOpenTime = decisionTime + HY_EXP_0028_ENTRY_OFFSET_MS;
  const fiveMinuteRows = bars5m
    .filter(row => Number(row.closeTime ?? row.openTime + FIVE_MINUTES - 1) <= asOf)
    .sort((left, right) => Number(left.openTime) - Number(right.openTime));
  const entryBar = fiveMinuteAt(fiveMinuteRows, requiredOpenTime);
  if (!entryBar) return pending('ENTRY_BAR_NOT_YET_OBSERVED', requiredOpenTime + FIVE_MINUTES - 1, signal);
  const entryPrice = finite('entryPrice', entryBar.open);
  const stopPrice = entryPrice - 2 * finite('atr20', signal.atr20);
  if (!(stopPrice > 0)) throw new Error('invalid frozen stop price');
  const observed1h = bars1h
    .filter(row => Number(row.closeBoundary ?? row.openTime + HOUR) <= asOf)
    .sort((left, right) => Number(left.openTime) - Number(right.openTime));
  const evaluationBars = observed1h
    .map((row, index) => ({ row, index }))
    .filter(item => Number(item.row.closeBoundary ?? item.row.openTime + HOUR) > requiredOpenTime)
    .slice(0, HY_EXP_0028_MAX_HOLD_BARS);
  if (evaluationBars.length < HY_EXP_0028_MAX_HOLD_BARS) {
    const requiredThrough = evaluationBars.at(-1)?.row.closeBoundary
      ?? requiredOpenTime + HY_EXP_0028_MAX_HOLD_BARS * HOUR;
    return pending('MAX_HOLD_WINDOW_NOT_YET_OBSERVED', requiredThrough, signal);
  }
  const fiveByOpenTime = new Map(fiveMinuteRows.map(row => [Number(row.openTime), row]));
  let cursor = requiredOpenTime;
  const marks = [];
  let exit = null;
  for (const { row, index } of evaluationBars) {
    const closeBoundary = Number(row.closeBoundary ?? row.openTime + HOUR);
    const periodRows = [];
    for (let openTime = cursor; openTime < closeBoundary; openTime += FIVE_MINUTES) {
      const five = fiveMinuteAt(fiveByOpenTime, openTime);
      if (!five) return pending('FORWARD_5M_BAR_NOT_YET_OBSERVED', closeBoundary - 1, signal);
      periodRows.push(five);
    }
    for (const five of periodRows) {
      appendMark(marks, 'BUY', five, entryPrice);
      if (Number(five.open) <= stopPrice) {
        exit = { price: Number(five.open), time: Number(five.openTime), reason: 'ATR_STOP' };
        break;
      }
      if (Number(five.low) <= stopPrice) {
        exit = { price: stopPrice, time: Number(five.openTime) + 1, reason: 'ATR_STOP' };
        break;
      }
    }
    if (exit) break;
    const priorChannel = observed1h.slice(index - 60, index);
    if (priorChannel.length !== 60) throw new Error('MISSING_FROZEN_CHANNEL_HISTORY');
    const channelLow = Math.min(...priorChannel.map(item => Number(item.low)));
    if (Number(row.close) <= channelLow) {
      exit = { price: Number(row.close), time: closeBoundary, reason: 'DYNAMIC_CHANNEL_EXIT' };
      break;
    }
    cursor = closeBoundary;
    if (evaluationBars.at(-1).row.openTime === row.openTime) {
      exit = { price: Number(row.close), time: closeBoundary, reason: 'TERMINAL_EXIT' };
    }
  }
  if (!exit) throw new Error('MISSING_FROZEN_EXIT');
  const funding = realizedFunding({
    side: 'BUY',
    entryPrice,
    entryTime: requiredOpenTime,
    exitTime: exit.time,
    rows: fundingRows,
    bars5m: fiveMinuteRows
  });
  const grossPriceReturnBps = directionalReturnBps('BUY', entryPrice, exit.price);
  const net18Bps = grossPriceReturnBps - HY_EXP_0028_BASE_COST_BPS + funding.fundingPnlBps;
  const net27Bps = grossPriceReturnBps - HY_EXP_0028_STRESS_COST_BPS + funding.fundingPnlBps;
  const size = researchPositionSize(entryPrice, stopPrice);
  return {
    validationId: HY_VAL_0028_001_ID,
    strategyId: HY_EXP_0028_STRATEGY_ID,
    policyId: HY_EXP_0028_POLICY_ID,
    sourceCommit: signal.sourceCommit,
    signalId: signal.id,
    symbol: signal.symbol,
    side: 'BUY',
    rule: 'RULE_A_CHANNEL_DISTANCE_Q75',
    status: 'RESOLVED',
    decisionTime,
    entryTime: requiredOpenTime,
    entryPrice,
    executablePrice: entryPrice,
    exitTime: exit.time,
    exitPrice: exit.price,
    exitReason: exit.reason,
    stopPrice,
    grossPriceReturnBps,
    funding,
    net18Bps,
    net27Bps,
    paperNotional: size.paperNotional,
    paperPnl: size.paperNotional * net18Bps / 10_000,
    stressPaperPnl: size.paperNotional * net27Bps / 10_000,
    maeBps: Math.min(...marks.map(mark => mark.returnBps)),
    mfeBps: Math.max(...marks.map(mark => mark.returnBps)),
    markToMarketDrawdownBps: markDrawdown(marks),
    marks,
    costs: { baseCostBps: 18, stressCostBps: 27, fundingSeparate: true },
    safety: publicSafety()
  };
}

export function countCompletedValidationDays({ completedUtcDays = [], coveredUtcDays = [] } = {}) {
  const completed = new Set(completedUtcDays);
  return [...new Set(coveredUtcDays)].filter(day => completed.has(day)).length;
}

export function combineValidationEvidence({
  originalValidatedSignals = 43,
  prospectiveValidatedSignals = 0,
  originalValidationDays = 53,
  prospectiveCompletedValidationDays = 0
} = {}) {
  for (const [name, value] of Object.entries({
    originalValidatedSignals,
    prospectiveValidatedSignals,
    originalValidationDays,
    prospectiveCompletedValidationDays
  })) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`invalid ${name}`);
  }
  return {
    originalValidatedSignals,
    prospectiveValidatedSignals,
    combinedValidatedSignals: originalValidatedSignals + prospectiveValidatedSignals,
    originalValidationDays,
    prospectiveCompletedValidationDays,
    combinedValidationDays: originalValidationDays + prospectiveCompletedValidationDays,
    metricsMustBeRecomputedFromTradeRows: true
  };
}
