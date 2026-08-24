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
export const HY_EXP_0028_SOURCE_FILE_HASHES = Object.freeze({
  'scripts/hy-exp-0028-holdout.mjs': 'f5f04b5cde4ce00c235f0e6c0be08904a71ea0fe2335582724a2298b14ab1ab7',
  'src/research/hy-exp-0024.mjs': 'd8120efd3650e828bfa6c6277c70605ccab51396e0ecb9107df38b934cd87174',
  'src/research/hy-exp-0028.mjs': 'a665bc805ea107dcc97df5326b31fc29a9cfba0f01119448e338b2f741d8ce17',
  'artifacts/HY-EXP-0028/frozen-q75.json': '1d85f472c24d45b3ea09ecb28be68269fe89f298464b0a58d9da286445ae3ed3'
});
export const HY_VAL_PUBLIC_ENDPOINTS = Object.freeze([
  'https://fapi.binance.com/fapi/v1/klines',
  'https://fapi.binance.com/fapi/v1/fundingRate',
  'https://fapi.binance.com/fapi/v1/exchangeInfo'
]);

const HOUR = 60 * 60 * 1_000;
const FIVE_MINUTES = 5 * 60 * 1_000;
const FOUR_HOURS = 4 * HOUR;
const REQUIRED_FEATURE_INDEX = 7;
const DERIVED_CONTEXT_TOKEN = Symbol('HY-VAL-0028-001 derived causal context');

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

export function validateProspectiveResolvedEvidence(row) {
  if (!row || typeof row !== 'object') return { ok: false, reason: 'EVIDENCE_ROW_REQUIRED' };
  if (row.validationId !== HY_VAL_0028_001_ID) return { ok: false, reason: 'EVIDENCE_VALIDATION_ID_MISMATCH' };
  if (row.strategyId !== HY_EXP_0028_STRATEGY_ID) return { ok: false, reason: 'EVIDENCE_STRATEGY_ID_MISMATCH' };
  if (row.policyId !== HY_EXP_0028_POLICY_ID) return { ok: false, reason: 'EVIDENCE_POLICY_ID_MISMATCH' };
  if (row.sourceCommit !== HY_EXP_0028_SOURCE_COMMIT) return { ok: false, reason: 'EVIDENCE_SOURCE_COMMIT_MISMATCH' };
  if (row.status !== 'RESOLVED') return { ok: false, reason: 'EVIDENCE_STATUS_NOT_RESOLVED' };
  if (row.paperPnlComputed !== true) return { ok: false, reason: 'EVIDENCE_PNL_NOT_COMPUTED' };
  if (row.immutable !== true) return { ok: false, reason: 'EVIDENCE_NOT_IMMUTABLE' };
  if (!HY_EXP_0028_SYMBOLS.includes(row.symbol)) return { ok: false, reason: 'EVIDENCE_SYMBOL_NOT_FROZEN' };
  if (typeof row.decisionTime !== 'number' || !Number.isFinite(row.decisionTime)) {
    return { ok: false, reason: 'EVIDENCE_DECISION_TIME_INVALID' };
  }
  if (row.signalId !== `${row.symbol}:${row.decisionTime}`) return { ok: false, reason: 'EVIDENCE_SIGNAL_ID_NON_CANONICAL' };
  if (row.idempotencyKey !== `${row.validationId}:${row.signalId}`) {
    return { ok: false, reason: 'EVIDENCE_IDEMPOTENCY_KEY_NON_CANONICAL' };
  }
  if (row.costs?.baseCostBps !== HY_EXP_0028_BASE_COST_BPS) return { ok: false, reason: 'EVIDENCE_BASE_COST_MISMATCH' };
  if (row.costs?.stressCostBps !== HY_EXP_0028_STRESS_COST_BPS) return { ok: false, reason: 'EVIDENCE_STRESS_COST_MISMATCH' };
  if (row.costs?.fundingSeparate !== true) return { ok: false, reason: 'EVIDENCE_FUNDING_COST_NOT_SEPARATE' };
  if (row.emailSent !== false) return { ok: false, reason: 'EVIDENCE_EMAIL_SAFETY_VIOLATION' };
  if (row.productionAdvisory !== false) return { ok: false, reason: 'EVIDENCE_ADVISORY_SAFETY_VIOLATION' };
  if (row.orderPlaced !== false) return { ok: false, reason: 'EVIDENCE_ORDER_SAFETY_VIOLATION' };
  const safety = row.safety;
  if (safety?.signal_only !== true
    || safety?.authorization_mode !== 'PAPER_ONLY'
    || safety?.live_orders_enabled !== false
    || safety?.account_api !== false
    || safety?.order_api !== false
    || safety?.automatic_trading !== false
    || safety?.final_oos_read !== false) {
    return { ok: false, reason: 'EVIDENCE_SAFETY_ENVELOPE_INVALID' };
  }
  if (typeof row.shadowValidationActivatedAt !== 'number'
    || !Number.isFinite(row.shadowValidationActivatedAt)) {
    return { ok: false, reason: 'EVIDENCE_ACTIVATION_PROOF_MISSING' };
  }
  if (row.decisionTime < row.shadowValidationActivatedAt) {
    return { ok: false, reason: 'EVIDENCE_PRE_ACTIVATION_DECISION' };
  }
  return { ok: true, reason: null };
}

export function assertProspectiveResolvedEvidence(row) {
  const validation = validateProspectiveResolvedEvidence(row);
  if (!validation.ok) throw new Error(`invalid prospective resolved evidence: ${validation.reason}`);
  return row;
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

export function verifyFrozenSourceManifest(source = HY_VAL_0028_001.immutableSource) {
  if (source?.commit !== HY_EXP_0028_SOURCE_COMMIT
    || source?.preregistrationSha256 !== HY_EXP_0028_PREREGISTRATION_SHA256
    || source?.holdoutResultSha256 !== HY_EXP_0028_HOLDOUT_RESULT_SHA256) {
    throw new Error('HY-EXP-0028 immutable source provenance drifted');
  }
  const configured = Object.fromEntries((source.files ?? []).map(file => [file.path, file.sha256]));
  const configuredKeys = Object.keys(configured).sort();
  const expectedKeys = Object.keys(HY_EXP_0028_SOURCE_FILE_HASHES).sort();
  if (JSON.stringify(configuredKeys) !== JSON.stringify(expectedKeys)
    || configuredKeys.some(key => configured[key] !== HY_EXP_0028_SOURCE_FILE_HASHES[key])) {
    throw new Error('HY-EXP-0028 immutable source file hash drifted');
  }
  return { ok: true, files: configured };
}

function validateFrozenSource(sourceCommit = HY_EXP_0028_SOURCE_COMMIT) {
  verifyFrozenSourceManifest();
  if (sourceCommit !== HY_EXP_0028_SOURCE_COMMIT) throw new Error('HY-EXP-0028 source commit drifted');
}

function expectedChannelDistance({ signalClose, priorExitLow, atr20 }) {
  if (!(atr20 > 0)) return null;
  return (signalClose - priorExitLow) / atr20;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function simpleMovingAverage(rows, index, period) {
  if (index < period - 1) return null;
  return mean(rows.slice(index - period + 1, index + 1).map(row => Number(row.close)));
}

function averageTrueRange(rows, index, period = 20) {
  if (index < period) return null;
  const ranges = [];
  for (let cursor = index - period + 1; cursor <= index; cursor += 1) {
    const previousClose = Number(rows[cursor - 1].close);
    const high = Number(rows[cursor].high);
    const low = Number(rows[cursor].low);
    ranges.push(Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose)));
  }
  return mean(ranges);
}

function parseBoundary(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim())) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasFiniteNumericValue(value) {
  return value != null && value !== '' && Number.isFinite(Number(value));
}

function validateNumericBar(row, {
  kind,
  intervalMs,
  requireQuoteVolume = false,
  boundaryField = 'closeBoundary',
  boundaryOffsetMs = intervalMs
} = {}) {
  if (!row || typeof row !== 'object') return `${kind}_BAR_INVALID`;
  const openTime = parseBoundary(row.openTime);
  const boundary = parseBoundary(row[boundaryField]);
  if (openTime == null || boundary == null || boundary !== openTime + boundaryOffsetMs) {
    return `${kind}_BOUNDARY_INVALID`;
  }
  if (openTime % intervalMs !== 0) return `${kind}_OPEN_TIME_MISALIGNED`;
  for (const field of ['open', 'high', 'low', 'close']) {
    if (!hasFiniteNumericValue(row[field])) return `${kind}_OHLC_INVALID`;
  }
  const open = Number(row.open);
  const high = Number(row.high);
  const low = Number(row.low);
  const close = Number(row.close);
  if (high < low || high < Math.max(open, close) || low > Math.min(open, close)) {
    return `${kind}_OHLC_INVALID`;
  }
  if (requireQuoteVolume
    && (!hasFiniteNumericValue(row.quoteVolume) || Number(row.quoteVolume) < 0)) {
    return `${kind}_QUOTE_VOLUME_INVALID`;
  }
  return null;
}

function validateSeries(rows, {
  kind,
  intervalMs,
  requireQuoteVolume = false,
  boundaryField = 'closeBoundary',
  boundaryOffsetMs = intervalMs
} = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, rejection: `${kind}_MISSING` };
  }
  let previousOpenTime = null;
  for (const row of rows) {
    const numericFailure = validateNumericBar(row, {
      kind,
      intervalMs,
      requireQuoteVolume,
      boundaryField,
      boundaryOffsetMs
    });
    if (numericFailure) return { ok: false, rejection: numericFailure };
    const openTime = parseBoundary(row.openTime);
    if (previousOpenTime != null) {
      if (openTime === previousOpenTime) {
        return { ok: false, rejection: `${kind}_DUPLICATE_OPEN_TIME` };
      }
      if (openTime < previousOpenTime) {
        return { ok: false, rejection: `${kind}_OUT_OF_ORDER` };
      }
      if (openTime - previousOpenTime !== intervalMs) {
        return { ok: false, rejection: `${kind}_GAP` };
      }
    }
    previousOpenTime = openTime;
  }
  return { ok: true, rejection: null };
}

function validateCausalInputs({ bars1hBySymbol, bars4hBySymbol, signalIndexes = [] } = {}) {
  for (const symbol of HY_EXP_0028_SYMBOLS) {
    const oneHour = validateSeries(bars1hBySymbol?.[symbol], {
      kind: 'CAUSAL_1H',
      intervalMs: HOUR,
      requireQuoteVolume: false
    });
    if (!oneHour.ok) return { ok: false, symbol, rejection: oneHour.rejection };
    const fourHour = validateSeries(bars4hBySymbol?.[symbol], {
      kind: 'CAUSAL_4H',
      intervalMs: FOUR_HOURS,
      requireQuoteVolume: true
    });
    if (!fourHour.ok) return { ok: false, symbol, rejection: fourHour.rejection };
  }

  const reference4h = bars4hBySymbol.BTCUSDT;
  const maximumFourHourLength = Math.max(...HY_EXP_0028_SYMBOLS.map(symbol => bars4hBySymbol[symbol].length));
  for (let index = 0; index < maximumFourHourLength; index += 1) {
    const reference = reference4h[index];
    if (!reference) return { ok: false, symbol: 'BTCUSDT', rejection: 'CAUSAL_4H_BUCKET_MISALIGNED' };
    const referenceOpenTime = parseBoundary(reference.openTime);
    const referenceCloseBoundary = parseBoundary(reference.closeBoundary);
    for (const symbol of HY_EXP_0028_SYMBOLS) {
      const row = bars4hBySymbol[symbol]?.[index];
      if (!row
        || parseBoundary(row.openTime) !== referenceOpenTime
        || parseBoundary(row.closeBoundary) !== referenceCloseBoundary) {
        return { ok: false, symbol, rejection: 'CAUSAL_4H_BUCKET_MISALIGNED' };
      }
    }
  }

  for (const index of signalIndexes) {
    if (!Number.isInteger(index) || index < 1) {
      return { ok: false, symbol: 'ALL', rejection: 'CAUSAL_1H_SIGNAL_INDEX_INVALID' };
    }
    const reference = bars1hBySymbol.BTCUSDT[index];
    if (!reference) return { ok: false, symbol: 'ALL', rejection: 'CAUSAL_1H_SIGNAL_BAR_MISSING' };
    const signalOpenTime = parseBoundary(reference.openTime);
    for (const symbol of HY_EXP_0028_SYMBOLS) {
      const rows = bars1hBySymbol[symbol];
      const signalBar = rows?.[index];
      const previousBar = rows?.[index - 1];
      if (!signalBar || parseBoundary(signalBar.openTime) !== signalOpenTime) {
        return { ok: false, symbol, rejection: 'CAUSAL_1H_SIGNAL_ALIGNMENT' };
      }
      if (!previousBar
        || parseBoundary(previousBar.closeBoundary) !== signalOpenTime) {
        return { ok: false, symbol, rejection: 'CAUSAL_1H_PREVIOUS_BAR_BOUNDARY' };
      }
      const priorEntry = rows.slice(index - 120, index);
      const priorExit = rows.slice(index - 60, index);
      if (priorEntry.length !== 120
        || parseBoundary(priorEntry.at(-1)?.closeBoundary) !== signalOpenTime) {
        return { ok: false, symbol, rejection: 'CAUSAL_1H_ENTRY_HISTORY_END_MISMATCH' };
      }
      if (priorExit.length !== 60
        || parseBoundary(priorExit.at(-1)?.closeBoundary) !== signalOpenTime) {
        return { ok: false, symbol, rejection: 'CAUSAL_1H_EXIT_HISTORY_END_MISMATCH' };
      }
    }
  }
  return { ok: true, symbol: null, rejection: null };
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

function latestCompletedFourHourIndex(rows, decisionTime) {
  let selected = -1;
  for (let index = 0; index < rows.length; index += 1) {
    if (Number(rows[index].closeBoundary) <= decisionTime) selected = index;
    else break;
  }
  return selected;
}

function deriveRegime({ bars4hBySymbol, fourHourIndex }) {
  const btc = bars4hBySymbol.BTCUSDT;
  if (!btc?.[fourHourIndex]) return null;
  const btcFastSma = simpleMovingAverage(btc, fourHourIndex, 60);
  const btcSlowSma = simpleMovingAverage(btc, fourHourIndex, 180);
  if (btcFastSma == null || btcSlowSma == null) return null;
  const breadthRequired = Math.ceil(HY_EXP_0028_SYMBOLS.length * 2 / 3);
  const breadthRows = {};
  for (const symbol of HY_EXP_0028_SYMBOLS) {
    const rows = bars4hBySymbol[symbol];
    const row = rows?.[fourHourIndex];
    const slowSma = row ? simpleMovingAverage(rows, fourHourIndex, 180) : null;
    if (!row || slowSma == null) return null;
    breadthRows[symbol] = {
      close: Number(row.close),
      slowSma,
      aboveSlowSma: Number(row.close) > slowSma,
      belowSlowSma: Number(row.close) < slowSma
    };
  }
  const breadthAbove = Object.values(breadthRows).filter(row => row.aboveSlowSma).length;
  const breadthBelow = Object.values(breadthRows).filter(row => row.belowSlowSma).length;
  const btcClose = Number(btc[fourHourIndex].close);
  const bull = btcFastSma > btcSlowSma && btcClose > btcSlowSma && breadthAbove >= breadthRequired;
  const bear = btcFastSma < btcSlowSma && btcClose < btcSlowSma && breadthBelow >= breadthRequired;
  const breadth = bull ? breadthAbove : bear ? breadthBelow : Math.max(breadthAbove, breadthBelow);
  return {
    regime: bull ? 'BULL' : bear ? 'BEAR' : 'SIDEWAYS',
    side: bull ? 'BUY' : bear ? 'SELL' : null,
    btcFastSma,
    btcSlowSma,
    breadth,
    breadthFraction: breadth / HY_EXP_0028_SYMBOLS.length,
    breadthAbove,
    breadthBelow,
    breadthRequired,
    fourHourIndex,
    fourHourCloseTime: Number(btc[fourHourIndex].closeBoundary),
    bySymbol: breadthRows
  };
}

function deriveFrozenContext({ bars1hBySymbol, bars4hBySymbol, index }) {
  const btc1h = bars1hBySymbol.BTCUSDT;
  const signalBar = btc1h?.[index];
  if (!signalBar) return null;
  const signalOpenTime = Number(signalBar.openTime);
  const decisionTime = signalOpenTime + HOUR;
  const fourHourIndex = latestCompletedFourHourIndex(bars4hBySymbol.BTCUSDT ?? [], decisionTime);
  const regime = deriveRegime({ bars4hBySymbol, fourHourIndex });
  if (!regime) return null;
  const symbols = {};
  for (const symbol of HY_EXP_0028_SYMBOLS) {
    const rows = bars1hBySymbol[symbol];
    const row = rows?.[index];
    if (!row || Number(row.openTime) !== signalOpenTime) return null;
    const priorEntry = rows.slice(index - 120, index);
    const priorExit = rows.slice(index - 60, index);
    const causalHistoryValid = hasCausalCompletedHistory(priorEntry, decisionTime, 120)
      && hasCausalCompletedHistory(priorExit, decisionTime, 60);
    const atr20 = averageTrueRange(rows, index, 20);
    const sma60 = simpleMovingAverage(rows, index, 60);
    const sma180 = simpleMovingAverage(rows, index, 180);
    const priorEntryHigh = priorEntry.length === 120
      ? Math.max(...priorEntry.map(item => Number(item.high))) : null;
    const priorExitLow = priorExit.length === 60
      ? Math.min(...priorExit.map(item => Number(item.low))) : null;
    const priorExitHigh = priorExit.length === 60
      ? Math.max(...priorExit.map(item => Number(item.high))) : null;
    const side = regime.side;
    const breakout = side === 'BUY'
      ? priorEntryHigh != null && Number(row.close) > priorEntryHigh
      : side === 'SELL'
        ? priorEntry.length === 120 && Number(row.close) < Math.min(...priorEntry.map(item => Number(item.low)))
        : false;
    const priorFourHour = (bars4hBySymbol[symbol] ?? []).slice(regime.fourHourIndex - 5, regime.fourHourIndex + 1);
    const priorSixQuoteVolume = priorFourHour.length === 6
      ? priorFourHour.reduce((sum, item) => sum + Number(item.quoteVolume), 0)
      : null;
    const sideMultiplier = side ? sideSign(side) : 1;
    const features = breakout && atr20 > 0 && sma60 != null && sma180 != null
      && priorExitLow != null && priorExitHigh != null && priorSixQuoteVolume != null
      ? [
        sideMultiplier * (Number(row.close) - (side === 'BUY' ? priorEntryHigh : Math.min(...priorEntry.map(item => Number(item.low))))) / atr20,
        sideMultiplier * (Number(row.close) - sma60) / atr20,
        sideMultiplier * (sma60 - sma180) / atr20,
        regime.breadthFraction,
        HY_EXP_0028_SYMBOLS.length / 8,
        Math.log1p(priorSixQuoteVolume),
        atr20 / Number(row.close),
        sideMultiplier * (Number(row.close) - (side === 'BUY' ? priorExitLow : Math.max(...priorExit.map(item => Number(item.high))))) / atr20
      ]
      : null;
    symbols[symbol] = {
      symbol,
      side,
      breakout,
      signalClose: Number(row.close),
      atr20,
      sma60,
      sma180,
      priorEntryHigh,
      priorExitLow,
      priorExitHigh,
      priorEntryBars: priorEntry,
      priorExitBars: priorExit,
      causalHistoryValid,
      features,
      reasons: []
    };
  }
  const context = {
    signalTime: decisionTime,
    theoreticalDecisionTime: decisionTime,
    index,
    decisionTime,
    regime,
    symbols,
    universeSymbols: [...HY_EXP_0028_SYMBOLS]
  };
  for (const detail of Object.values(context.symbols)) {
    if (detail.features) Object.freeze(detail.features);
    Object.freeze(detail.priorEntryBars);
    Object.freeze(detail.priorExitBars);
    Object.freeze(detail);
  }
  Object.freeze(context.regime.bySymbol);
  Object.freeze(context.regime);
  Object.freeze(context.symbols);
  Object.freeze(context.universeSymbols);
  Object.defineProperty(context, DERIVED_CONTEXT_TOKEN, { value: true });
  return Object.freeze(context);
}

function candidateFromDerived({ activation, context, detail, sourceCommit }) {
  const parsedDecisionTime = timestamp('decisionTime', context.decisionTime);
  const prospective = activation.eligibility(parsedDecisionTime);
  if (!prospective.eligible) return { accepted: false, rejection: prospective.reason };
  if (detail.causalHistoryValid !== true) return { accepted: false, rejection: 'INSUFFICIENT_FROZEN_HISTORY' };
  if (detail.side !== 'BUY' || context.regime.regime !== 'BULL') {
    return { accepted: false, rejection: 'RULE_A_REQUIRES_BULL_BUY' };
  }
  if (!detail.breakout) return { accepted: false, rejection: 'NO_BREAKOUT' };
  if (!Array.isArray(detail.features)) return { accepted: false, rejection: 'MISSING_FROZEN_FEATURE_VECTOR' };
  const channelDistance = detail.features[REQUIRED_FEATURE_INDEX];
  if (!(channelDistance >= HY_EXP_0028_FROZEN_Q75)) {
    return { accepted: false, rejection: 'BELOW_FROZEN_Q75' };
  }
  return {
    accepted: true,
    candidate: {
      validationId: HY_VAL_0028_001_ID,
      strategyId: HY_EXP_0028_STRATEGY_ID,
      policyId: HY_EXP_0028_POLICY_ID,
      sourceCommit,
      id: `${detail.symbol}:${parsedDecisionTime}`,
      symbol: detail.symbol,
      side: 'BUY',
      regime: 'BULL',
      rule: 'RULE_A_CHANNEL_DISTANCE_Q75',
      decisionTime: parsedDecisionTime,
      theoreticalDecisionTime: parsedDecisionTime,
      theoreticalEntryTime: parsedDecisionTime + HY_EXP_0028_ENTRY_OFFSET_MS,
      shadowValidationActivatedAt: activation.activatedAt,
      signalClose: detail.signalClose,
      atr20: detail.atr20,
      priorEntryHigh: detail.priorEntryHigh,
      priorExitLow: detail.priorExitLow,
      channelDistance,
      frozenQ75: HY_EXP_0028_FROZEN_Q75,
      features: [...detail.features],
      countedProspective: true,
      candidateAuthority: 'NONE',
      emailSent: false,
      productionAdvisory: false,
      orderPlaced: false,
      safety: publicSafety()
    }
  };
}

export function createFrozenRuleACandidate({
  activation,
  derivedContext,
  symbol = null,
  diagnostics = {},
  sourceCommit = HY_EXP_0028_SOURCE_COMMIT
} = {}) {
  validateFrozenSource(sourceCommit);
  if (!derivedContext?.[DERIVED_CONTEXT_TOKEN] || !derivedContext?.regime || !derivedContext?.symbols) {
    return { accepted: false, rejection: 'CAUSAL_CANDIDATE_CONTEXT_REQUIRED' };
  }
  const diagnosticSymbol = symbol ?? diagnostics.symbol;
  const detail = derivedContext.symbols[diagnosticSymbol];
  if (!detail) return { accepted: false, rejection: 'SYMBOL_NOT_IN_FROZEN_UNIVERSE' };
  const result = candidateFromDerived({ activation, context: derivedContext, detail, sourceCommit });
  if (!result.accepted) return result;
  const expectedDiagnostics = {
    regime: derivedContext.regime.regime,
    side: detail.side,
    signalClose: detail.signalClose,
    atr20: detail.atr20,
    channelDistance: detail.features[REQUIRED_FEATURE_INDEX]
  };
  const mismatchedDiagnostic = Object.entries(diagnostics)
    .filter(([key]) => key !== 'symbol')
    .find(([key, value]) => Number.isFinite(Number(value))
      ? Number(value) !== Number(expectedDiagnostics[key])
      : value !== expectedDiagnostics[key]);
  if (mismatchedDiagnostic) return { accepted: false, rejection: 'FROZEN_PARITY_ASSERTION_MISMATCH' };
  return result;
}

export function buildFrozenShadowCandidates({
  activation,
  bars1hBySymbol,
  bars4hBySymbol,
  signalIndex = null,
  sourceCommit = HY_EXP_0028_SOURCE_COMMIT
} = {}) {
  validateFrozenSource(sourceCommit);
  const reference = bars1hBySymbol?.BTCUSDT;
  if (!Array.isArray(reference)) throw new Error('BTCUSDT causal 1h bars are required');
  const firstIndex = Math.max(180 * 4, 180, 120, 60, 20);
  const indexes = signalIndex == null
    ? Array.from({ length: Math.max(0, reference.length - firstIndex) }, (_, offset) => firstIndex + offset)
    : [Number(signalIndex)];
  const continuity = validateCausalInputs({
    bars1hBySymbol,
    bars4hBySymbol,
    signalIndexes: indexes
  });
  if (!continuity.ok) {
    return {
      contexts: [],
      candidates: [],
      rejections: [{
        symbol: continuity.symbol,
        decisionTime: null,
        rejection: continuity.rejection
      }]
    };
  }
  const contexts = [];
  const candidates = [];
  const rejections = [];
  for (const index of indexes) {
    const context = deriveFrozenContext({ bars1hBySymbol, bars4hBySymbol, index });
    if (!context) continue;
    contexts.push(context);
    for (const symbol of HY_EXP_0028_SYMBOLS) {
      const result = createFrozenRuleACandidate({
        activation,
        derivedContext: context,
        symbol,
        sourceCommit
      });
      if (result.accepted) candidates.push(result.candidate);
      else rejections.push({ symbol, decisionTime: context.decisionTime, rejection: result.rejection });
    }
  }
  return { contexts, candidates, rejections };
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
  return (source ?? []).find(row => parseBoundary(row.openTime) === openTime) ?? null;
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
    emailSent: false,
    productionAdvisory: false,
    orderPlaced: false,
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
  const fiveMinuteRows = (bars5m ?? []).filter(row => {
    const openTime = parseBoundary(row.openTime);
    const closeTime = parseBoundary(row.closeTime ?? (openTime == null ? null : openTime + FIVE_MINUTES - 1));
    return closeTime != null && closeTime <= asOf;
  });
  if (fiveMinuteRows.length) {
    const continuity = validateSeries(fiveMinuteRows, {
      kind: 'FORWARD_5M',
      intervalMs: FIVE_MINUTES,
      boundaryField: 'closeTime',
      boundaryOffsetMs: FIVE_MINUTES - 1
    });
    if (!continuity.ok) {
      return {
        ...pending('FORWARD_5M_CONTINUITY_FAILURE', asOf, signal),
        continuityRejection: continuity.rejection
      };
    }
  }
  const entryBar = fiveMinuteAt(fiveMinuteRows, requiredOpenTime);
  if (!entryBar) return pending('ENTRY_BAR_NOT_YET_OBSERVED', requiredOpenTime + FIVE_MINUTES - 1, signal);
  const entryPrice = finite('entryPrice', entryBar.open);
  const stopPrice = entryPrice - 2 * finite('atr20', signal.atr20);
  if (!(stopPrice > 0)) throw new Error('invalid frozen stop price');
  const observed1h = (bars1h ?? []).filter(row => {
    const openTime = parseBoundary(row.openTime);
    const closeBoundary = parseBoundary(row.closeBoundary ?? (openTime == null ? null : openTime + HOUR));
    return closeBoundary != null && closeBoundary <= asOf;
  });
  if (!observed1h.length) {
    return {
      ...pending('FORWARD_1H_CONTINUITY_FAILURE', asOf, signal),
      continuityRejection: 'FORWARD_1H_MISSING'
    };
  }
  const oneHourContinuity = validateSeries(observed1h, {
    kind: 'FORWARD_1H',
    intervalMs: HOUR
  });
  if (!oneHourContinuity.ok) {
    return {
      ...pending('FORWARD_1H_CONTINUITY_FAILURE', asOf, signal),
      continuityRejection: oneHourContinuity.rejection
    };
  }
  const evaluationStartIndex = observed1h.findIndex(row => parseBoundary(row.closeBoundary) > requiredOpenTime);
  if (evaluationStartIndex < 0) {
    return pending('MAX_HOLD_WINDOW_NOT_YET_OBSERVED', requiredOpenTime + HY_EXP_0028_MAX_HOLD_BARS * HOUR, signal);
  }
  const firstEvaluationBar = observed1h[evaluationStartIndex];
  if (parseBoundary(firstEvaluationBar.openTime) !== decisionTime
    || parseBoundary(firstEvaluationBar.closeBoundary) !== decisionTime + HOUR) {
    return pending('EVALUATION_1H_ALIGNMENT_FAILURE', decisionTime + HOUR, signal);
  }
  const evaluationBars = observed1h
    .slice(evaluationStartIndex, evaluationStartIndex + HY_EXP_0028_MAX_HOLD_BARS)
    .map((row, offset) => ({ row, index: evaluationStartIndex + offset }));
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
    if (priorChannel.length !== 60
      || parseBoundary(priorChannel.at(-1)?.closeBoundary) !== parseBoundary(row.openTime)) {
      return pending('DYNAMIC_CHANNEL_HISTORY_INCOMPLETE', closeBoundary, signal);
    }
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
  if (!exit) return pending('EXIT_EVIDENCE_INCOMPLETE', asOf, signal);
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
    shadowValidationActivatedAt: activationAt,
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
    paperPnlComputed: true,
    paperNotional: size.paperNotional,
    paperPnl: size.paperNotional * net18Bps / 10_000,
    stressPaperPnl: size.paperNotional * net27Bps / 10_000,
    maeBps: Math.min(...marks.map(mark => mark.returnBps)),
    mfeBps: Math.max(...marks.map(mark => mark.returnBps)),
    markToMarketDrawdownBps: markDrawdown(marks),
    marks,
    costs: { baseCostBps: 18, stressCostBps: 27, fundingSeparate: true },
    emailSent: false,
    productionAdvisory: false,
    orderPlaced: false,
    safety: publicSafety()
  };
}

export function countCompletedValidationDays({ completedUtcDays = [], coveredUtcDays = [] } = {}) {
  const completed = new Set(completedUtcDays);
  return [...new Set(coveredUtcDays)].filter(day => completed.has(day)).length;
}

export function combineValidationEvidence({
  originalValidatedSignals = 43,
  prospectiveResolvedRows = [],
  prospectiveValidatedSignals,
  originalValidationDays = 53,
  prospectiveCompletedValidationDays = 0
} = {}) {
  if (prospectiveValidatedSignals !== undefined) {
    throw new Error('prospectiveValidatedSignals must be derived from immutable resolved rows');
  }
  if (!Array.isArray(prospectiveResolvedRows)) {
    throw new Error('prospectiveResolvedRows must be an array');
  }
  const evidenceKeys = new Set();
  for (const row of prospectiveResolvedRows) {
    assertProspectiveResolvedEvidence(row);
    const key = row.idempotencyKey;
    if (evidenceKeys.has(key)) {
      throw new Error('prospective resolved evidence must have unique immutable keys');
    }
    evidenceKeys.add(key);
  }
  const derivedProspectiveValidatedSignals = prospectiveResolvedRows.length;
  for (const [name, value] of Object.entries({
    originalValidatedSignals,
    prospectiveValidatedSignals: derivedProspectiveValidatedSignals,
    originalValidationDays,
    prospectiveCompletedValidationDays
  })) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`invalid ${name}`);
  }
  return {
    originalValidatedSignals,
    prospectiveValidatedSignals: derivedProspectiveValidatedSignals,
    prospectiveValidatedSignalsDefinition: 'COUNT OF IMMUTABLE RESOLVED SHADOW TRADE EVIDENCE ROWS',
    combinedValidatedSignals: originalValidatedSignals + derivedProspectiveValidatedSignals,
    originalValidationDays,
    prospectiveCompletedValidationDays,
    combinedValidationDays: originalValidationDays + prospectiveCompletedValidationDays,
    metricsMustBeRecomputedFromTradeRows: true
  };
}
