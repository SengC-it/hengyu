import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEVELOPMENT_END,
  DEVELOPMENT_START,
  FIVE_MINUTES,
  HOUR,
  HY_EXP_0024_SYMBOLS,
  loadHyExp0024Dataset
} from './hy-exp-0024.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const HY_SCREEN_0001_ID = 'HY-SCREEN-0001';
export const HY_SCREEN_0001_BASE_COMMIT = '81593062a41ee32c219b352337170b807db9f0f9';
export const HY_SCREEN_0001_SYMBOLS = Object.freeze([...HY_EXP_0024_SYMBOLS]);
export const HY_SCREEN_0001_OOF_START = Date.parse('2025-01-01T00:00:00.000Z');
export const HY_SCREEN_0001_OOF_END = Date.parse('2026-07-01T00:00:00.000Z');
export const HY_SCREEN_0001_OOF_DAYS = (HY_SCREEN_0001_OOF_END - HY_SCREEN_0001_OOF_START) / (24 * HOUR);
export const HY_SCREEN_0001_BASE_COST_BPS = 18;
export const HY_SCREEN_0001_STRESS_COST_BPS = 27;
export const HY_SCREEN_0001_OUTCOME_HOLD_BARS = 6;

export const HY_SCREEN_0001_FAMILIES = Object.freeze([
  'CROSS_SECTIONAL_MOMENTUM',
  'SHORT_TERM_MEAN_REVERSION',
  'FUNDING_DISLOCATION',
  'TREND_ACCELERATION',
  'VOLATILITY_REVERSAL'
]);

const FAMILY_LABELS = Object.freeze({
  CROSS_SECTIONAL_MOMENTUM: 'CROSS_SECTIONAL_MOMENTUM',
  SHORT_TERM_MEAN_REVERSION: 'SHORT_TERM_MEAN_REVERSION',
  FUNDING_DISLOCATION: 'FUNDING_DISLOCATION',
  TREND_ACCELERATION: 'TREND_ACCELERATION',
  VOLATILITY_REVERSAL: 'VOLATILITY_REVERSAL'
});

function finite(value) {
  return value != null && Number.isFinite(Number(value));
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function monthKey(time) {
  return new Date(time).toISOString().slice(0, 7);
}

function sideSign(side) {
  if (side === 'BUY') return 1;
  if (side === 'SELL') return -1;
  throw new Error(`invalid side ${side}`);
}

export function directionalReturnBps(side, entryPrice, exitPrice) {
  return sideSign(side) * (exitPrice - entryPrice) / entryPrice * 10_000;
}

export function isCompletedOneHourBar(row) {
  return Boolean(row
    && row.openTime + HOUR - 1 === row.closeTime
    && row.closeBoundary === row.openTime + HOUR
    && finite(row.open)
    && finite(row.high)
    && finite(row.low)
    && finite(row.close));
}

export function simpleMovingAverage(rows, index, period) {
  if (!Array.isArray(rows) || index < period - 1) return null;
  const values = rows.slice(index - period + 1, index + 1).map(row => Number(row.close));
  return values.every(Number.isFinite) ? mean(values) : null;
}

export function trueRange(rows, index) {
  if (!Array.isArray(rows) || index <= 0 || !rows[index]) return null;
  const row = rows[index];
  const previousClose = Number(rows[index - 1]?.close);
  if (![row.high, row.low, previousClose].every(Number.isFinite)) return null;
  return Math.max(
    Number(row.high) - Number(row.low),
    Math.abs(Number(row.high) - previousClose),
    Math.abs(Number(row.low) - previousClose)
  );
}

export function averageTrueRange20(rows, index) {
  if (index < 20) return null;
  const ranges = [];
  for (let cursor = index - 19; cursor <= index; cursor++) {
    const range = trueRange(rows, cursor);
    if (!finite(range)) return null;
    ranges.push(range);
  }
  return mean(ranges);
}

function priorCloseReturn(rows, index, bars) {
  const latest = rows[index - 1];
  const earliest = rows[index - 1 - bars];
  if (!latest || !earliest || !(Number(earliest.close) > 0)) return null;
  return Number(latest.close) / Number(earliest.close) - 1;
}

function priorRange(rows, index, bars) {
  const range = rows.slice(index - bars, index);
  if (range.length !== bars || !range.every(isCompletedOneHourBar)) return null;
  return {
    high: Math.max(...range.map(row => Number(row.high))),
    low: Math.min(...range.map(row => Number(row.low)))
  };
}

function previousBarPosition(row) {
  const range = Number(row.high) - Number(row.low);
  if (!(range > 0)) return null;
  return {
    bottom20: Number(row.close) <= Number(row.low) + 0.2 * range,
    top20: Number(row.close) >= Number(row.high) - 0.2 * range,
    midpoint: (Number(row.high) + Number(row.low)) / 2,
    range
  };
}

function latestFunding(rows, decisionTime) {
  let latest = null;
  for (const row of rows ?? []) {
    const eventTime = Number(row.eventTime);
    if (!Number.isFinite(eventTime)) continue;
    if (eventTime > decisionTime) break;
    latest = row;
  }
  return latest && finite(latest.fundingRate) ? latest : null;
}

function candidate({ family, symbol, side, index, decisionTime, features }) {
  return {
    id: `${family}:${symbol}:${decisionTime}`,
    family,
    symbol,
    side,
    index,
    signalTime: decisionTime,
    decisionTime,
    features
  };
}

function evaluateCrossSectionalMomentum({ barsBySymbol, index, decisionTime }) {
  const ranked = HY_SCREEN_0001_SYMBOLS.map(symbol => ({
    symbol,
    prior24hReturn: priorCloseReturn(barsBySymbol[symbol], index, 24)
  }));
  if (ranked.some(row => row.prior24hReturn == null)) return [];
  const descending = [...ranked].sort((left, right) => right.prior24hReturn - left.prior24hReturn || left.symbol.localeCompare(right.symbol));
  const ascending = [...ranked].sort((left, right) => left.prior24hReturn - right.prior24hReturn || left.symbol.localeCompare(right.symbol));
  const selected = [];
  for (const row of descending.slice(0, 2)) {
    if (row.prior24hReturn > 0) {
      selected.push(candidate({
        family: FAMILY_LABELS.CROSS_SECTIONAL_MOMENTUM,
        symbol: row.symbol,
        side: 'BUY',
        index,
        decisionTime,
        features: { prior24hReturn: row.prior24hReturn, rank: descending.indexOf(row) + 1 }
      }));
    }
  }
  for (const row of ascending.slice(0, 2)) {
    if (row.prior24hReturn < 0) {
      selected.push(candidate({
        family: FAMILY_LABELS.CROSS_SECTIONAL_MOMENTUM,
        symbol: row.symbol,
        side: 'SELL',
        index,
        decisionTime,
        features: { prior24hReturn: row.prior24hReturn, rank: ascending.indexOf(row) + 1 }
      }));
    }
  }
  return selected;
}

function evaluateShortTermMeanReversion({ barsBySymbol, index, decisionTime }) {
  const selected = [];
  for (const symbol of HY_SCREEN_0001_SYMBOLS) {
    const rows = barsBySymbol[symbol];
    const current = rows[index];
    const prior3hReturn = priorCloseReturn(rows, index, 3);
    const atr20 = averageTrueRange20(rows, index);
    if (!current || prior3hReturn == null || !(atr20 > 0) || !(Number(current.close) > 0)) continue;
    const normalizedThreshold = 2 * atr20 / Number(current.close);
    const buy = prior3hReturn <= -normalizedThreshold && Number(current.close) > Number(current.open);
    const sell = prior3hReturn >= normalizedThreshold && Number(current.close) < Number(current.open);
    if (buy || sell) {
      selected.push(candidate({
        family: FAMILY_LABELS.SHORT_TERM_MEAN_REVERSION,
        symbol,
        side: buy ? 'BUY' : 'SELL',
        index,
        decisionTime,
        features: { prior3hReturn, atr20, normalizedThreshold }
      }));
    }
  }
  return selected;
}

function evaluateFundingDislocation({ barsBySymbol, fundingBySymbol, index, decisionTime }) {
  const selected = [];
  for (const symbol of HY_SCREEN_0001_SYMBOLS) {
    const current = barsBySymbol[symbol][index];
    const funding = latestFunding(fundingBySymbol[symbol], decisionTime);
    if (!current || !funding) continue;
    const buy = Number(funding.fundingRate) <= -0.0005 && Number(current.close) > Number(current.open);
    const sell = Number(funding.fundingRate) >= 0.0005 && Number(current.close) < Number(current.open);
    if (buy || sell) {
      selected.push(candidate({
        family: FAMILY_LABELS.FUNDING_DISLOCATION,
        symbol,
        side: buy ? 'BUY' : 'SELL',
        index,
        decisionTime,
        features: {
          fundingRate: Number(funding.fundingRate),
          fundingTime: Number(funding.eventTime)
        }
      }));
    }
  }
  return selected;
}

function evaluateTrendAcceleration({ barsBySymbol, index, decisionTime }) {
  const selected = [];
  for (const symbol of HY_SCREEN_0001_SYMBOLS) {
    const rows = barsBySymbol[symbol];
    const current = rows[index];
    const currentSma20 = simpleMovingAverage(rows, index, 20);
    const previousSma20 = simpleMovingAverage(rows, index - 1, 20);
    const currentSma50 = simpleMovingAverage(rows, index, 50);
    const range = priorRange(rows, index, 12);
    if (!current || currentSma20 == null || previousSma20 == null || currentSma50 == null || !range) continue;
    const buy = currentSma20 > currentSma50
      && currentSma20 - previousSma20 > 0
      && Number(current.close) > range.high
      && Number(current.close) > Number(current.open);
    const sell = currentSma20 < currentSma50
      && currentSma20 - previousSma20 < 0
      && Number(current.close) < range.low
      && Number(current.close) < Number(current.open);
    if (buy || sell) {
      selected.push(candidate({
        family: FAMILY_LABELS.TREND_ACCELERATION,
        symbol,
        side: buy ? 'BUY' : 'SELL',
        index,
        decisionTime,
        features: { currentSma20, previousSma20, currentSma50, prior12hHigh: range.high, prior12hLow: range.low }
      }));
    }
  }
  return selected;
}

function evaluateVolatilityReversal({ barsBySymbol, index, decisionTime }) {
  const selected = [];
  for (const symbol of HY_SCREEN_0001_SYMBOLS) {
    const rows = barsBySymbol[symbol];
    const previous = rows[index - 1];
    const current = rows[index];
    const previousAtr20 = averageTrueRange20(rows, index - 1);
    const previousTrueRange = trueRange(rows, index - 1);
    const position = previous ? previousBarPosition(previous) : null;
    if (!previous || !current || !(previousAtr20 > 0) || !(previousTrueRange >= 2 * previousAtr20) || !position) continue;
    const buy = position.bottom20 && Number(current.close) > position.midpoint;
    const sell = position.top20 && Number(current.close) < position.midpoint;
    if (buy || sell) {
      selected.push(candidate({
        family: FAMILY_LABELS.VOLATILITY_REVERSAL,
        symbol,
        side: buy ? 'BUY' : 'SELL',
        index,
        decisionTime,
        features: { previousTrueRange, previousAtr20, previousClosePosition: buy ? 'BOTTOM_20_PERCENT' : 'TOP_20_PERCENT', previousMidpoint: position.midpoint }
      }));
    }
  }
  return selected;
}

export function evaluateFamilyAt({ family, barsBySymbol, fundingBySymbol, index, decisionTime } = {}) {
  if (!HY_SCREEN_0001_FAMILIES.includes(family)) throw new Error(`unknown HY-SCREEN-0001 family: ${family}`);
  if (family === FAMILY_LABELS.CROSS_SECTIONAL_MOMENTUM) return evaluateCrossSectionalMomentum({ barsBySymbol, index, decisionTime });
  if (family === FAMILY_LABELS.SHORT_TERM_MEAN_REVERSION) return evaluateShortTermMeanReversion({ barsBySymbol, index, decisionTime });
  if (family === FAMILY_LABELS.FUNDING_DISLOCATION) return evaluateFundingDislocation({ barsBySymbol, fundingBySymbol, index, decisionTime });
  if (family === FAMILY_LABELS.TREND_ACCELERATION) return evaluateTrendAcceleration({ barsBySymbol, index, decisionTime });
  return evaluateVolatilityReversal({ barsBySymbol, index, decisionTime });
}

function fiveMinuteAt(source, openTime) {
  if (source instanceof Map) return source.get(openTime) ?? null;
  return (source ?? []).find(row => row.openTime === openTime) ?? null;
}

function fundingAtEntryToExit({ side, entryPrice, entryTime, exitTime, fundingRows, bars5m }) {
  let fundingPnlPerUnit = 0;
  const events = [];
  for (const row of fundingRows ?? []) {
    const eventTime = Number(row.eventTime);
    const fundingRate = Number(row.fundingRate);
    if (!Number.isFinite(eventTime) || !Number.isFinite(fundingRate) || eventTime < entryTime || eventTime > exitTime) continue;
    let markPrice = entryPrice;
    for (const bar of bars5m ?? []) {
      if (bar.openTime > eventTime) break;
      markPrice = Number(bar.close);
    }
    const payment = -sideSign(side) * markPrice * fundingRate;
    fundingPnlPerUnit += payment;
    events.push({ fundingTime: eventTime, fundingRate, markPrice, payment });
  }
  return {
    fundingPnlPerUnit,
    fundingPnlBps: fundingPnlPerUnit / entryPrice * 10_000,
    events
  };
}

/** Apply the common exact +5m entry and close of the sixth completed 1h bar; no family exit logic is allowed. */
export function labelScreenCandidate({ candidate: row, bars1h, bars5m, fundingRows, fiveByOpenTime } = {}) {
  const entryTime = Number(row.decisionTime) + FIVE_MINUTES;
  const entryBar = fiveMinuteAt(fiveByOpenTime, entryTime);
  if (!entryBar) return { usable: false, rejection: 'MISSING_EXACT_5M_OPEN' };
  const entryPrice = Number(entryBar.open);
  if (!(entryPrice > 0)) return { usable: false, rejection: 'INVALID_EXACT_5M_OPEN' };
  const firstAfterEntryIndex = Number(row.index) + 1;
  const exitIndex = Number(row.index) + HY_SCREEN_0001_OUTCOME_HOLD_BARS;
  const evaluationBars = (bars1h ?? []).slice(firstAfterEntryIndex, exitIndex + 1);
  if (evaluationBars.length !== HY_SCREEN_0001_OUTCOME_HOLD_BARS || !evaluationBars.every(isCompletedOneHourBar)) {
    return { usable: false, rejection: 'INSUFFICIENT_SIX_COMPLETED_1H_BARS' };
  }
  const exitBar = evaluationBars.at(-1);
  const exitTime = Number(exitBar.closeBoundary);
  if (!(exitTime > entryTime)) return { usable: false, rejection: 'INVALID_COMMON_EXIT_TIME' };
  if (exitTime >= DEVELOPMENT_END) return { usable: false, rejection: 'OUTCOME_REACHES_DEVELOPMENT_END' };
  const realizedFunding = fundingAtEntryToExit({
    side: row.side,
    entryPrice,
    entryTime,
    exitTime,
    fundingRows,
    bars5m
  });
  const grossPriceReturnBps = directionalReturnBps(row.side, entryPrice, Number(exitBar.close));
  const net18Bps = grossPriceReturnBps + realizedFunding.fundingPnlBps - HY_SCREEN_0001_BASE_COST_BPS;
  const net27Bps = grossPriceReturnBps + realizedFunding.fundingPnlBps - HY_SCREEN_0001_STRESS_COST_BPS;
  return {
    usable: true,
    entryTime,
    entryPrice,
    exitTime,
    exitPrice: Number(exitBar.close),
    exitReason: 'SIXTH_COMPLETED_1H_CLOSE',
    grossPriceReturnBps,
    realizedFunding,
    net18Bps,
    net27Bps,
    exact5mOpen: true,
    laterBarRescue: false,
    noFamilySpecificExit: true
  };
}

function profitFactor(rows, field) {
  const positive = sum(rows.filter(row => row[field] > 0).map(row => row[field]));
  const negative = sum(rows.filter(row => row[field] < 0).map(row => row[field]));
  if (negative < 0) return positive / Math.abs(negative);
  return positive > 0 ? null : null;
}

function maxLossStreak(rows) {
  let maximum = 0;
  let current = 0;
  for (const row of rows) {
    if (row.net18Bps < 0) current++;
    else current = 0;
    maximum = Math.max(maximum, current);
  }
  return maximum;
}

function aggregateGroup(rows) {
  if (!rows.length) {
    return {
      count: 0,
      grossExpectancyBps: null,
      net18ExpectancyBps: null,
      net18ProfitFactor: null,
      net27ExpectancyBps: null,
      net27ProfitFactor: null,
      winRate: null,
      positiveNet18Count: 0,
      fundingBps: null
    };
  }
  return {
    count: rows.length,
    grossExpectancyBps: mean(rows.map(row => row.grossPriceReturnBps)),
    net18ExpectancyBps: mean(rows.map(row => row.net18Bps)),
    net18ProfitFactor: profitFactor(rows, 'net18Bps'),
    net27ExpectancyBps: mean(rows.map(row => row.net27Bps)),
    net27ProfitFactor: profitFactor(rows, 'net27Bps'),
    winRate: rows.filter(row => row.net18Bps > 0).length / rows.length,
    positiveNet18Count: rows.filter(row => row.net18Bps > 0).length,
    fundingBps: mean(rows.map(row => row.realizedFundingBps))
  };
}

function byKey(rows, key) {
  const groups = {};
  for (const row of rows) {
    const value = key(row);
    groups[value] ??= [];
    groups[value].push(row);
  }
  return Object.fromEntries(Object.entries(groups).sort(([left], [right]) => left.localeCompare(right)).map(([name, group]) => [name, aggregateGroup(group)]));
}

function summarizeFamily({ rawCandidateCount, advisories }) {
  const ordered = [...advisories].sort((left, right) => left.decisionTime - right.decisionTime || left.symbol.localeCompare(right.symbol) || left.side.localeCompare(right.side));
  const monthly = byKey(ordered, row => monthKey(row.decisionTime));
  const monthlyNet18 = Object.fromEntries(Object.entries(monthly).map(([month, metrics]) => [month, sum(ordered.filter(row => monthKey(row.decisionTime) === month).map(row => row.net18Bps))]));
  const activeMonths = Object.keys(monthly);
  const positiveMonths = activeMonths.filter(month => monthlyNet18[month] > 0);
  const positiveMonthPnl = sum(positiveMonths.map(month => monthlyNet18[month]));
  const bestPositiveMonth = positiveMonths.length ? positiveMonths.reduce((best, month) => monthlyNet18[month] > monthlyNet18[best] ? month : best, positiveMonths[0]) : null;
  const bestMonthPositivePnlShare = positiveMonthPnl > 0 ? monthlyNet18[bestPositiveMonth] / positiveMonthPnl : null;
  const totalNet18 = sum(ordered.map(row => row.net18Bps));
  const bySymbolMetrics = byKey(ordered, row => row.symbol);
  const largestSymbolShare = ordered.length
    ? Math.max(...Object.values(bySymbolMetrics).map(metrics => metrics.count)) / ordered.length
    : null;
  const checks = {
    advisoryCountAtLeast120: ordered.length >= 120,
    advisoriesPer30DaysAtLeast8: ordered.length * 30 / HY_SCREEN_0001_OOF_DAYS >= 8,
    grossExpectancyGreaterThan20: mean(ordered.map(row => row.grossPriceReturnBps)) > 20,
    net18ExpectancyGreaterThan5: mean(ordered.map(row => row.net18Bps)) > 5,
    net18ProfitFactorGreaterThan1_10: (profitFactor(ordered, 'net18Bps') ?? -Infinity) > 1.10,
    net27ExpectancyGreaterThan0: mean(ordered.map(row => row.net27Bps)) > 0,
    net27ProfitFactorGreaterThan1: (profitFactor(ordered, 'net27Bps') ?? -Infinity) > 1,
    activeMonthCountAtLeast10: activeMonths.length >= 10,
    positiveActiveMonthShareAtLeast0_45: activeMonths.length > 0 && positiveMonths.length / activeMonths.length >= 0.45,
    distinctSymbolsAtLeast6: new Set(ordered.map(row => row.symbol)).size >= 6,
    largestSymbolShareAtMost0_35: largestSymbolShare != null && largestSymbolShare <= 0.35,
    bestMonthPositivePnlShareAtMost0_50: bestMonthPositivePnlShare != null && bestMonthPositivePnlShare <= 0.50,
    netPnlWithoutBestMonthGreaterThan0: (bestPositiveMonth == null ? totalNet18 : totalNet18 - monthlyNet18[bestPositiveMonth]) > 0
  };
  return {
    rawCandidateCount,
    oofAdvisoryCount: ordered.length,
    advisoriesPer30Days: ordered.length * 30 / HY_SCREEN_0001_OOF_DAYS,
    buyCount: ordered.filter(row => row.side === 'BUY').length,
    sellCount: ordered.filter(row => row.side === 'SELL').length,
    grossExpectancyBps: mean(ordered.map(row => row.grossPriceReturnBps)),
    net18ExpectancyBps: mean(ordered.map(row => row.net18Bps)),
    net18ProfitFactor: profitFactor(ordered, 'net18Bps'),
    net27ExpectancyBps: mean(ordered.map(row => row.net27Bps)),
    net27ProfitFactor: profitFactor(ordered, 'net27Bps'),
    winRate: ordered.length ? ordered.filter(row => row.net18Bps > 0).length / ordered.length : null,
    activeMonthCount: activeMonths.length,
    positiveActiveMonthCount: positiveMonths.length,
    positiveActiveMonthShare: activeMonths.length ? positiveMonths.length / activeMonths.length : null,
    distinctSymbols: new Set(ordered.map(row => row.symbol)).size,
    largestSymbolShare,
    bestPositiveMonth,
    bestMonthPositivePnlShare,
    netPnlWithoutBestMonth: bestPositiveMonth == null ? totalNet18 : totalNet18 - monthlyNet18[bestPositiveMonth],
    totalNet18PnlBps: totalNet18,
    maxLossStreak: maxLossStreak(ordered),
    totalFundingBps: sum(ordered.map(row => row.realizedFundingBps)),
    bySide: byKey(ordered, row => row.side),
    bySymbol: bySymbolMetrics,
    byMonth: monthly,
    monthlyNet18PnlBps: monthlyNet18,
    checks,
    qualified: Object.values(checks).every(Boolean)
  };
}

function safetyEnvelope() {
  return {
    signalOnly: true,
    paperOnly: true,
    liveOrdersEnabled: false,
    accountApi: false,
    orderApi: false,
    automaticTrading: false,
    mlUsed: false,
    ridgeUsed: false,
    productionModified: false,
    finalOosRead: false,
    holdout0028Read: false,
    newExperimentCreated: false
  };
}

function validateDataset(dataset) {
  if (dataset.sourceExperimentId !== 'HY-EXP-0001') throw new Error('HY-SCREEN-0001 requires only the locked HY-EXP-0001 Development dataset');
  if (dataset.sourceManifest?.experiment_id !== 'HY-EXP-0001') throw new Error('HY-SCREEN-0001 source manifest mismatch');
  if (dataset.sourceManifest?.missing_files !== 0) throw new Error('HY-SCREEN-0001 source manifest is incomplete');
  if (!Array.isArray(dataset.symbols) || dataset.symbols.join(',') !== HY_SCREEN_0001_SYMBOLS.join(',')) {
    throw new Error('HY-SCREEN-0001 fixed eight-symbol universe mismatch');
  }
  for (const symbol of HY_SCREEN_0001_SYMBOLS) {
    const bars = dataset.bars1hBySymbol?.[symbol];
    const five = dataset.bars5mBySymbol?.[symbol];
    const funding = dataset.fundingBySymbol?.[symbol];
    if (!bars?.length || !five?.length || !funding) throw new Error(`${symbol}: missing OHLCV or funding input`);
    if (!bars.every(isCompletedOneHourBar)) throw new Error(`${symbol}: incomplete 1h bar in source input`);
  }
}

function diagnosticsRow(candidateRow, label, oofEligible) {
  return {
    type: 'candidate',
    screenId: HY_SCREEN_0001_ID,
    family: candidateRow.family,
    id: candidateRow.id,
    symbol: candidateRow.symbol,
    side: candidateRow.side,
    decisionTime: new Date(candidateRow.decisionTime).toISOString(),
    rawCandidate: true,
    oofEligible,
    status: label?.usable ? 'ADVISORY' : label?.rejection ?? 'OUTSIDE_OOF_SCORE_WINDOW',
    outcome: label?.usable ? {
      entryTime: new Date(label.entryTime).toISOString(),
      exitTime: new Date(label.exitTime).toISOString(),
      grossPriceReturnBps: label.grossPriceReturnBps,
      realizedFundingBps: label.realizedFunding.fundingPnlBps,
      net18Bps: label.net18Bps,
      net27Bps: label.net27Bps,
      exitReason: label.exitReason
    } : null
  };
}

export function runHyScreen0001({ root = ROOT, dataset = loadHyExp0024Dataset({ root }) } = {}) {
  validateDataset(dataset);
  const barsBySymbol = dataset.bars1hBySymbol;
  const fundingBySymbol = dataset.fundingBySymbol;
  const fiveMaps = Object.fromEntries(HY_SCREEN_0001_SYMBOLS.map(symbol => [
    symbol,
    new Map(dataset.bars5mBySymbol[symbol].map(row => [row.openTime, row]))
  ]));
  const rawByFamily = Object.fromEntries(HY_SCREEN_0001_FAMILIES.map(family => [family, []]));
  const advisoriesByFamily = Object.fromEntries(HY_SCREEN_0001_FAMILIES.map(family => [family, []]));
  const diagnostics = [];
  const reference = barsBySymbol.BTCUSDT;
  for (let index = 0; index < reference.length; index++) {
    const signalBar = reference[index];
    if (!isCompletedOneHourBar(signalBar)) throw new Error(`BTCUSDT: incomplete completed-bar boundary at ${index}`);
    const decisionTime = signalBar.closeBoundary;
    if (decisionTime < DEVELOPMENT_START || decisionTime >= DEVELOPMENT_END) continue;
    for (const family of HY_SCREEN_0001_FAMILIES) {
      const familyCandidates = evaluateFamilyAt({ family, barsBySymbol, fundingBySymbol, index, decisionTime });
      for (const raw of familyCandidates) {
        rawByFamily[family].push(raw);
        const oofEligible = decisionTime >= HY_SCREEN_0001_OOF_START && decisionTime < HY_SCREEN_0001_OOF_END;
        let label = null;
        if (oofEligible) {
          label = labelScreenCandidate({
            candidate: raw,
            bars1h: barsBySymbol[raw.symbol],
            bars5m: dataset.bars5mBySymbol[raw.symbol],
            fundingRows: fundingBySymbol[raw.symbol],
            fiveByOpenTime: fiveMaps[raw.symbol]
          });
          if (label.usable && label.exitTime < HY_SCREEN_0001_OOF_END) {
            advisoriesByFamily[family].push({ ...raw, label, ...label, realizedFundingBps: label.realizedFunding.fundingPnlBps });
          } else if (label.usable) {
            label = { usable: false, rejection: 'OUTCOME_REACHES_OOF_END' };
          }
        }
        diagnostics.push(diagnosticsRow(raw, label, oofEligible));
      }
    }
  }
  const families = Object.fromEntries(HY_SCREEN_0001_FAMILIES.map(family => [
    family,
    summarizeFamily({ rawCandidateCount: rawByFamily[family].length, advisories: advisoriesByFamily[family] })
  ]));
  const qualifying = HY_SCREEN_0001_FAMILIES
    .filter(family => families[family].qualified)
    .sort((left, right) => families[right].net27ExpectancyBps - families[left].net27ExpectancyBps
      || families[right].net27ProfitFactor - families[left].net27ProfitFactor
      || families[right].positiveActiveMonthShare - families[left].positiveActiveMonthShare
      || left.localeCompare(right));
  const recommendation = qualifying.length ? qualifying[0] : null;
  const selection = qualifying.length
    ? {
      status: 'QUALIFIED_FAMILY_FOUND',
      qualifyingFamilies: qualifying,
      recommendedFamily: recommendation,
      ranking: qualifying.map(family => ({
        family,
        net27ExpectancyBps: families[family].net27ExpectancyBps,
        net27ProfitFactor: families[family].net27ProfitFactor,
        temporalRobustness: {
          positiveActiveMonthShare: families[family].positiveActiveMonthShare,
          activeMonthCount: families[family].activeMonthCount
        }
      }))
    }
    : {
      status: 'NO_FAMILY_QUALIFIED',
      qualifyingFamilies: [],
      recommendedFamily: null,
      ranking: []
    };
  const result = {
    screenId: HY_SCREEN_0001_ID,
    baseCommit: HY_SCREEN_0001_BASE_COMMIT,
    status: 'SCREENING_COMPLETE',
    recommendation: recommendation ? `HY_EXP_0031_RECOMMENDED_FAMILY=${recommendation}` : 'NO_FAMILY_QUALIFIED',
    data: {
      sourceExperimentId: dataset.sourceExperimentId,
      sourceManifestSha256: dataset.sourceManifestSha256,
      sourceRule: 'Already-consumed HY-EXP-0001 Development OHLCV/funding only; no L2, no holdout, no Final OOS',
      developmentStart: new Date(DEVELOPMENT_START).toISOString(),
      developmentEndExclusive: new Date(DEVELOPMENT_END).toISOString(),
      oofExposureStart: new Date(HY_SCREEN_0001_OOF_START).toISOString(),
      oofExposureEndExclusive: new Date(HY_SCREEN_0001_OOF_END).toISOString(),
      symbols: [...HY_SCREEN_0001_SYMBOLS],
      inputStreams: ['Binance public contract-price OHLCV', 'realized funding'],
      forbiddenInputs: ['historical L2', 'order-book proxy', 'HY-EXP-0028 holdout', 'Final OOS']
    },
    commonEvaluation: {
      decision: 'completed 1h bar close',
      entry: 'exact contract-price 5m OPEN at decisionTime + 5min',
      outcome: 'close of the sixth completed 1h bar after entry',
      laterBarRescue: false,
      familySpecificExit: false,
      baseCostBps: HY_SCREEN_0001_BASE_COST_BPS,
      stressCostBps: HY_SCREEN_0001_STRESS_COST_BPS,
      fundingSeparate: true,
      pnlUnit: 'equal normalized notional; aggregate netPnl fields are bps contributions, no portfolio sizing'
    },
    familyDefinitions: {
      CROSS_SECTIONAL_MOMENTUM: 'prior 24h return excluding current; BUY top 2 if positive; SELL bottom 2 if negative',
      SHORT_TERM_MEAN_REVERSION: 'prior 3h return excluding current versus 2*ATR20/close; current candle direction confirms',
      FUNDING_DISLOCATION: 'latest funding known by decision; threshold +/-0.0005; current candle direction confirms',
      TREND_ACCELERATION: 'SMA20/SMA50, rising/falling SMA20, prior 12h breakout, current candle direction',
      VOLATILITY_REVERSAL: 'previous TR >= 2*previous ATR20, previous close bottom/top 20%, current close crosses previous midpoint'
    },
    families,
    selection,
    safety: safetyEnvelope()
  };
  return { result, diagnostics };
}
