import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  DEVELOPMENT_END,
  DEVELOPMENT_START,
  FOLDS,
  HOUR,
  FIVE_MINUTES,
  RESEARCH_EQUITY_USDT,
  loadHyExp0024Dataset
} from './hy-exp-0024.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const HY_EXP_0030_EXPERIMENT_ID = 'HY-EXP-0030';
export const HY_EXP_0030_BASE_COMMIT = '61a8c9199919cfd42bb305de31a3078375278d73';
export const HY_EXP_0030_PREREGISTRATION_SHA256 = 'a249cf384df2d82c831e8181381a3607aef5c47a463663bb58893f0b5848ab14';
export const HY_EXP_0030_SYMBOLS = Object.freeze([
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT',
  'XRPUSDT', 'DOGEUSDT', 'LINKUSDT', 'LTCUSDT'
]);
export const HY_EXP_0030_BASE_COST_BPS = 18;
export const HY_EXP_0030_STRESS_COST_BPS = 27;
export const HY_EXP_0030_MAX_HOLD_BARS = 12;
export const HY_EXP_0030_STOP_ATR_MULTIPLE = 1.5;
export const HY_EXP_0030_COMPRESSION_LOOKBACK = 120;
export const HY_EXP_0030_BREAKOUT_LOOKBACK = 24;
export const HY_EXP_0030_COMPRESSION_TR_MULTIPLE = 1.5;
export const HY_EXP_0030_OOF_START = Date.parse('2025-01-01T00:00:00.000Z');
export const HY_EXP_0030_OOF_END = DEVELOPMENT_END;
export const HY_EXP_0030_OOF_DAYS = (HY_EXP_0030_OOF_END - HY_EXP_0030_OOF_START) / (24 * HOUR);

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}
function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  if (!ordered.length) return null;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function monthKey(time) {
  return new Date(time).toISOString().slice(0, 7);
}

function sma(rows, index, period) {
  if (index < period - 1) return null;
  return mean(rows.slice(index - period + 1, index + 1).map(row => Number(row.close)));
}

function trueRange(rows, index) {
  if (index <= 0) return null;
  const row = rows[index];
  const previousClose = rows[index - 1].close;
  return Math.max(
    row.high - row.low,
    Math.abs(row.high - previousClose),
    Math.abs(row.low - previousClose)
  );
}

function atr20(rows, index) {
  if (index < 20) return null;
  const ranges = [];
  for (let cursor = index - 19; cursor <= index; cursor++) ranges.push(trueRange(rows, cursor));
  return ranges.every(value => value != null) ? mean(ranges) : null;
}

function isCompletedBar(row) {
  return Boolean(row && row.closeBoundary != null && row.final !== false && row.closed !== false);
}

function latestCompletedFourHourIndex(rows, decisionTime) {
  let selected = -1;
  for (let index = 0; index < rows.length; index++) {
    if (rows[index].closeBoundary <= decisionTime) selected = index;
    else break;
  }
  return selected;
}

function regimeAt({ bars4hBySymbol, decisionTime }) {
  const btcRows = bars4hBySymbol.BTCUSDT;
  const fourHourIndex = latestCompletedFourHourIndex(btcRows, decisionTime);
  if (fourHourIndex < 0) return null;
  const btcFast = sma(btcRows, fourHourIndex, 60);
  const btcSlow = sma(btcRows, fourHourIndex, 180);
  if (btcFast == null || btcSlow == null) return null;
  const breadthRows = {};
  for (const symbol of HY_EXP_0030_SYMBOLS) {
    const row = bars4hBySymbol[symbol][fourHourIndex];
    const slow = sma(bars4hBySymbol[symbol], fourHourIndex, 180);
    if (!row || slow == null) return null;
    breadthRows[symbol] = { close: row.close, sma180: slow, aboveSma180: row.close > slow };
  }
  const breadthAbove = Object.values(breadthRows).filter(row => row.aboveSma180).length;
  const breadthRequired = Math.ceil(HY_EXP_0030_SYMBOLS.length * 2 / 3);
  const bull = btcFast > btcSlow
    && btcRows[fourHourIndex].close > btcSlow
    && breadthAbove >= breadthRequired;
  return {
    regime: bull ? 'BULL' : 'SIDEWAYS',
    side: bull ? 'BUY' : null,
    btcFastSma60: btcFast,
    btcSlowSma180: btcSlow,
    breadthAbove,
    breadthRequired,
    breadthFraction: breadthAbove / HY_EXP_0030_SYMBOLS.length,
    fourHourIndex,
    fourHourCloseBoundary: btcRows[fourHourIndex].closeBoundary,
    bySymbol: breadthRows
  };
}

/** Evaluate the frozen compression state and expansion trigger causally. */
export function evaluateCompressionExpansion({ bars, index } = {}) {
  const current = bars?.[index];
  const previous = bars?.[index - 1];
  const baseline = bars?.slice(index - HY_EXP_0030_COMPRESSION_LOOKBACK, index) ?? [];
  const prior24 = bars?.slice(index - HY_EXP_0030_BREAKOUT_LOOKBACK, index) ?? [];
  const currentAtr20 = atr20(bars, index);
  const previousAtr20 = atr20(bars, index - 1);
  const historyComplete = Boolean(isCompletedBar(current)
    && isCompletedBar(previous)
    && baseline.length === HY_EXP_0030_COMPRESSION_LOOKBACK
    && prior24.length === HY_EXP_0030_BREAKOUT_LOOKBACK
    && baseline.every(isCompletedBar)
    && prior24.every(isCompletedBar)
    && currentAtr20 != null
    && previousAtr20 != null
    && current.close > 0
    && previous.close > 0);
  const previousNormalizedAtr = historyComplete ? previousAtr20 / previous.close : null;
  const baselineNormalizedAtr = historyComplete
    ? baseline.map((row, offset) => {
      const rowIndex = index - HY_EXP_0030_COMPRESSION_LOOKBACK + offset;
      const rowAtr = atr20(bars, rowIndex);
      return rowAtr == null ? null : rowAtr / row.close;
    })
    : [];
  const compressionMedian = baselineNormalizedAtr.length && baselineNormalizedAtr.every(value => value != null)
    ? median(baselineNormalizedAtr)
    : null;
  const compression = historyComplete
    && previousNormalizedAtr < compressionMedian;
  const currentTrueRange = historyComplete ? trueRange(bars, index) : null;
  const prior24High = historyComplete ? Math.max(...prior24.map(row => row.high)) : null;
  const range = historyComplete ? current.high - current.low : null;
  const expansionRange = historyComplete && currentTrueRange >= HY_EXP_0030_COMPRESSION_TR_MULTIPLE * currentAtr20;
  const breakout = historyComplete && current.close > prior24High;
  const green = historyComplete && current.close > current.open;
  const upper25Close = historyComplete && range > 0
    && current.close >= current.high - 0.25 * range;
  return {
    historyComplete,
    compression,
    expansionRange,
    breakout,
    green,
    upper25Close,
    qualifies: Boolean(historyComplete && compression && expansionRange && breakout && green && upper25Close),
    atr20: currentAtr20,
    previousAtr20,
    previousNormalizedAtr,
    compressionMedian,
    compressionBaseline: baselineNormalizedAtr,
    currentTrueRange,
    prior24High,
    currentRange: range,
    triggerBarExcludedFromBaseline: true,
    triggerBarExcludedFromPrior24: true
  };
}

function fiveMinuteAt(source, openTime) {
  if (source instanceof Map) return source.get(openTime) ?? null;
  let lower = 0;
  let upper = (source?.length ?? 0) - 1;
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const row = source[middle];
    if (row.openTime === openTime) return row;
    if (row.openTime < openTime) lower = middle + 1;
    else upper = middle - 1;
  }
  return null;
}

function appendMark(marks, row, entryPrice) {
  for (const [offset, price] of [[0, row.low], [1, row.high], [2, row.close]]) {
    marks.push({
      time: row.openTime + offset,
      price,
      returnBps: (price - entryPrice) / entryPrice * 10_000
    });
  }
}

function fundingMarkAtOrBefore(bars5m, eventTime, fallback) {
  let mark = fallback;
  for (const bar of bars5m) {
    if (bar.openTime > eventTime) break;
    mark = bar.close;
  }
  return mark;
}

function realizedFunding({ entryPrice, entryTime, exitTime, fundingRows, bars5m }) {
  let fundingPnlPerUnit = 0;
  const details = [];
  for (const row of fundingRows) {
    if (row.eventTime < entryTime || row.eventTime > exitTime) continue;
    const markPrice = fundingMarkAtOrBefore(bars5m, row.eventTime, entryPrice);
    const payment = -markPrice * row.fundingRate;
    fundingPnlPerUnit += payment;
    details.push({ fundingTime: row.eventTime, fundingRate: row.fundingRate, markPrice, payment });
  }
  return {
    fundingPnlPerUnit,
    fundingPnlBps: fundingPnlPerUnit / entryPrice * 10_000,
    events: details
  };
}

/** Apply exact +5m entry, frozen ATR stop, trigger-midpoint exit, and 12-bar max hold. */
export function labelCompressionExpansion({ candidate, bars1h, bars5m, fiveByOpenTime } = {}) {
  const entryTime = candidate.decisionTime + FIVE_MINUTES;
  const entryBar = fiveMinuteAt(fiveByOpenTime, entryTime);
  if (!entryBar) return { usable: false, rejection: 'MISSING_EXACT_5M_EXECUTION_BAR' };
  const entryPrice = entryBar.open;
  const stopPrice = entryPrice - HY_EXP_0030_STOP_ATR_MULTIPLE * candidate.atr20;
  if (!(stopPrice > 0)) return { usable: false, rejection: 'INVALID_STOP_PRICE' };
  const evaluationBars = bars1h
    .map((row, index) => ({ row, index }))
    .filter(item => item.row.closeBoundary > entryTime && isCompletedBar(item.row))
    .slice(0, HY_EXP_0030_MAX_HOLD_BARS);
  if (evaluationBars.length < HY_EXP_0030_MAX_HOLD_BARS) {
    return { usable: false, rejection: 'INSUFFICIENT_FORWARD_1H_BARS' };
  }
  let cursor = entryTime;
  const marks = [];
  let exit = null;
  for (const { row, index } of evaluationBars) {
    const periodRows = [];
    for (let openTime = cursor; openTime < row.closeBoundary; openTime += FIVE_MINUTES) {
      const five = fiveMinuteAt(fiveByOpenTime, openTime);
      if (!five) return { usable: false, rejection: 'MISSING_FORWARD_5M_LABEL_BAR' };
      periodRows.push(five);
    }
    for (const five of periodRows) {
      appendMark(marks, five, entryPrice);
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
    if (row.close < candidate.triggerMidpoint) {
      exit = { price: row.close, time: row.closeBoundary, reason: 'MIDPOINT_FAILURE' };
      break;
    }
    cursor = row.closeBoundary;
    if (evaluationBars.at(-1).row.openTime === row.openTime) {
      exit = { price: row.close, time: row.closeBoundary, reason: 'TERMINAL_TWELFTH_BAR' };
    }
  }
  if (!exit) return { usable: false, rejection: 'MISSING_FROZEN_EXIT_LABEL' };
  const funding = realizedFunding({
    entryPrice,
    entryTime,
    exitTime: exit.time,
    fundingRows: candidate.fundingRows,
    bars5m
  });
  return {
    usable: true,
    entryTime,
    entryPrice,
    executablePrice: entryPrice,
    stopPrice,
    exitTime: exit.time,
    exitPrice: exit.price,
    exitReason: exit.reason,
    labelEndTime: exit.time,
    grossPriceReturnBps: (exit.price - entryPrice) / entryPrice * 10_000,
    realizedFunding: funding,
    marks,
    historicalExecution: {
      source: 'Binance USD-M contract-price archived 5m bar',
      requiredOpenTime: entryTime,
      exact: true,
      laterBarRescue: false,
      orderOrAccountApi: false
    }
  };
}

function positionSize(candidate) {
  const stopDistanceBps = Math.abs(candidate.label.entryPrice - candidate.label.stopPrice)
    / candidate.label.entryPrice * 10_000;
  if (!(stopDistanceBps > 0)) return null;
  const lossBudget = RESEARCH_EQUITY_USDT * 0.0025;
  const riskNotional = lossBudget / (stopDistanceBps / 10_000);
  const notional = Math.min(riskNotional, RESEARCH_EQUITY_USDT * 0.5);
  return {
    notional,
    quantity: notional / candidate.label.entryPrice,
    stopDistanceBps,
    lossAtStop: notional * stopDistanceBps / 10_000
  };
}

function buildAdvisory(candidate) {
  const size = positionSize(candidate);
  if (!size) throw new Error(`HY-EXP-0030 invalid position size for ${candidate.id}`);
  const fundingPnlBps = candidate.label.realizedFunding.fundingPnlBps;
  const net18Bps = candidate.label.grossPriceReturnBps + fundingPnlBps - HY_EXP_0030_BASE_COST_BPS;
  const net27Bps = candidate.label.grossPriceReturnBps + fundingPnlBps - HY_EXP_0030_STRESS_COST_BPS;
  return {
    experimentId: HY_EXP_0030_EXPERIMENT_ID,
    phase: 'development_oof',
    status: 'PAPER_VALIDATION_ADVISORY',
    id: candidate.id,
    symbol: candidate.symbol,
    side: 'BUY',
    regime: 'BULL',
    family: 'VOLATILITY_COMPRESSION_EXPANSION',
    signalTime: candidate.signalTime,
    decisionTime: candidate.decisionTime,
    entryTime: candidate.label.entryTime,
    entryPrice: candidate.label.entryPrice,
    executablePrice: candidate.label.executablePrice,
    exitTime: candidate.label.exitTime,
    exitPrice: candidate.label.exitPrice,
    exitReason: candidate.label.exitReason,
    stopPrice: candidate.label.stopPrice,
    atr20: candidate.atr20,
    normalizedAtr: candidate.normalizedAtr,
    previousNormalizedAtr: candidate.previousNormalizedAtr,
    compressionMedian: candidate.compressionMedian,
    expansionTrueRange: candidate.currentTrueRange,
    prior24High: candidate.prior24High,
    triggerMidpoint: candidate.triggerMidpoint,
    quantity: size.quantity,
    notional: size.notional,
    lossAtStop: size.lossAtStop,
    grossPriceReturnBps: candidate.label.grossPriceReturnBps,
    realizedFundingBps: fundingPnlBps,
    realizedFunding: candidate.label.realizedFunding,
    net18Bps,
    net27Bps,
    netReturnBps: net18Bps,
    stressNetReturnBps: net27Bps,
    netPnl: size.notional * net18Bps / 10_000,
    stressNetPnl: size.notional * net27Bps / 10_000,
    maeBps: Math.min(...candidate.label.marks.map(mark => mark.returnBps)),
    mfeBps: Math.max(...candidate.label.marks.map(mark => mark.returnBps)),
    markToMarketDrawdownBps: markDrawdown(candidate.label.marks),
    marks: candidate.label.marks,
    costs: {
      baseTotalBps: HY_EXP_0030_BASE_COST_BPS,
      stressTotalBps: HY_EXP_0030_STRESS_COST_BPS,
      fundingSeparate: true,
      realizedFundingRequired: true
    },
    historicalExecution: candidate.label.historicalExecution,
    paperOnly: true,
    signalOnly: true,
    liveOrdersEnabled: false,
    accountApi: false,
    orderApi: false,
    automaticTrading: false
  };
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

function contributionAt(advisory, time) {
  if (time < advisory.entryTime) return 0;
  if (time >= advisory.exitTime) return advisory.netPnl;
  let mark = { returnBps: 0 };
  for (const candidate of advisory.marks) {
    if (candidate.time > time) break;
    mark = candidate;
  }
  const funding = advisory.realizedFunding.events
    .filter(row => row.fundingTime <= time)
    .reduce((sum, row) => sum + row.payment / advisory.entryPrice * advisory.notional, 0);
  return advisory.notional * mark.returnBps / 10_000 - advisory.notional * 9 / 10_000 + funding;
}

function markToMarketMetrics(advisories) {
  if (!advisories.length) {
    return {
      maxMtmDrawdown: null,
      maxMtmDrawdownBps: null,
      cvar95LossFraction: null,
      cvar95LossBps: null,
      curvePoints: 0,
      dailyObservations: 0,
      riskMetricStatus: 'EMPTY_SAMPLE_NOT_EVALUABLE'
    };
  }
  const times = new Set([HY_EXP_0030_OOF_START, HY_EXP_0030_OOF_END - 1]);
  for (const advisory of advisories) {
    times.add(advisory.entryTime);
    times.add(advisory.exitTime);
    for (const mark of advisory.marks) times.add(mark.time);
    for (const funding of advisory.realizedFunding.events) times.add(funding.fundingTime);
  }
  const curve = [...times].sort((left, right) => left - right).map(time => ({
    time,
    equity: RESEARCH_EQUITY_USDT + advisories.reduce((sum, row) => sum + contributionAt(row, time), 0)
  }));
  let peak = RESEARCH_EQUITY_USDT;
  let maxDrawdown = 0;
  for (const row of curve) {
    peak = Math.max(peak, row.equity);
    maxDrawdown = Math.max(maxDrawdown, 1 - row.equity / peak);
  }
  const daily = new Map();
  for (const row of curve) daily.set(new Date(row.time).toISOString().slice(0, 10), row.equity);
  const dailyEquity = [...daily.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, equity]) => equity);
  const dailyReturns = dailyEquity.slice(1).map((equity, index) => equity / dailyEquity[index] - 1).sort((a, b) => a - b);
  const tailCount = dailyReturns.length ? Math.max(1, Math.ceil(dailyReturns.length * 0.05)) : 0;
  const cvarLoss = tailCount ? -mean(dailyReturns.slice(0, tailCount)) : null;
  return {
    maxMtmDrawdown: maxDrawdown,
    maxMtmDrawdownBps: maxDrawdown * 10_000,
    cvar95LossFraction: cvarLoss,
    cvar95LossBps: cvarLoss == null ? null : cvarLoss * 10_000,
    curvePoints: curve.length,
    dailyObservations: dailyReturns.length,
    riskMetricStatus: 'EVALUABLE'
  };
}

function profitFactor(rows, field) {
  const positive = rows.filter(row => row[field] > 0).reduce((sum, row) => sum + row[field], 0);
  const negative = rows.filter(row => row[field] < 0).reduce((sum, row) => sum + row[field], 0);
  return negative < 0 ? positive / Math.abs(negative) : positive > 0 ? Infinity : null;
}

function lossStreak(rows) {
  let longest = 0;
  let current = 0;
  for (const row of rows) {
    if (row.netPnl < 0) current++;
    else current = 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

function monthKeys(start, endExclusive) {
  const result = [];
  const cursor = new Date(start);
  cursor.setUTCDate(1);
  const end = new Date(endExclusive);
  while (cursor < end) {
    result.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return result;
}

function summarizeDevelopment({ rawCandidateCount, labeledCandidates, oofCandidates, advisories, foldReports }) {
  const ordered = [...advisories].sort((left, right) => left.exitTime - right.exitTime || left.symbol.localeCompare(right.symbol));
  const months = monthKeys(HY_EXP_0030_OOF_START, HY_EXP_0030_OOF_END);
  const monthlyNetPnl = Object.fromEntries(months.map(month => [month, 0]));
  const monthlyStressPnl = Object.fromEntries(months.map(month => [month, 0]));
  for (const advisory of ordered) {
    const month = monthKey(advisory.signalTime);
    if (month in monthlyNetPnl) {
      monthlyNetPnl[month] += advisory.netPnl;
      monthlyStressPnl[month] += advisory.stressNetPnl;
    }
  }
  const activeMonths = months.filter(month => ordered.some(row => monthKey(row.signalTime) === month));
  const positiveActiveMonths = activeMonths.filter(month => monthlyNetPnl[month] > 0);
  const positiveMonthPnl = positiveActiveMonths.reduce((sum, month) => sum + monthlyNetPnl[month], 0);
  const bestPositiveMonth = positiveActiveMonths.length
    ? positiveActiveMonths.reduce((best, month) => monthlyNetPnl[month] > monthlyNetPnl[best] ? month : best, positiveActiveMonths[0])
    : null;
  const bestPositiveMonthPnl = bestPositiveMonth == null ? null : monthlyNetPnl[bestPositiveMonth];
  const risk = markToMarketMetrics(ordered);
  const bySymbol = Object.fromEntries(HY_EXP_0030_SYMBOLS.map(symbol => [
    symbol,
    ordered.filter(row => row.symbol === symbol).length
  ]));
  const distinctSymbols = Object.values(bySymbol).filter(value => value > 0).length;
  const largestSymbolShare = ordered.length ? Math.max(...Object.values(bySymbol)) / ordered.length : null;
  const netPnl = ordered.reduce((sum, row) => sum + row.netPnl, 0);
  const netPnlWithoutBestMonth = bestPositiveMonth == null ? netPnl : netPnl - bestPositiveMonthPnl;
  const positiveBestMonthShare = positiveMonthPnl > 0 ? bestPositiveMonthPnl / positiveMonthPnl : null;
  const net18Returns = ordered.map(row => row.net18Bps);
  const net27Returns = ordered.map(row => row.net27Bps);
  const gates = {
    advisoryCountAtLeast120: ordered.length >= 120,
    advisoriesPer30DaysAtLeast8: ordered.length * 30 / HY_EXP_0030_OOF_DAYS >= 8,
    net18ExpectancyGreaterThan8: mean(net18Returns) != null && mean(net18Returns) > 8,
    net18ProfitFactorGreaterThan1_15: profitFactor(ordered, 'netPnl') != null && profitFactor(ordered, 'netPnl') > 1.15,
    net27ExpectancyGreaterThan0: mean(net27Returns) != null && mean(net27Returns) > 0,
    net27ProfitFactorGreaterThan1_02: profitFactor(ordered, 'stressNetPnl') != null && profitFactor(ordered, 'stressNetPnl') > 1.02,
    activeMonthCountAtLeast10: activeMonths.length >= 10,
    positiveActiveMonthShareAtLeast0_45: activeMonths.length > 0 && positiveActiveMonths.length / activeMonths.length >= 0.45,
    distinctSymbolsAtLeast6: distinctSymbols >= 6,
    largestSymbolShareAtMost0_35: largestSymbolShare != null && largestSymbolShare <= 0.35,
    maxMtmDrawdownAtMost15Percent: risk.maxMtmDrawdown != null && risk.maxMtmDrawdown <= 0.15,
    maxLossStreakAtMost8: lossStreak(ordered) <= 8,
    bestMonthPositivePnlShareAtMost0_50: positiveMonthPnl > 0 && positiveBestMonthShare <= 0.50,
    netPnlWithoutBestMonthGreaterThan0: netPnlWithoutBestMonth > 0
  };
  return {
    rawCandidateCount,
    labeledCandidateCount: labeledCandidates.length,
    oofPredictionCount: oofCandidates.length,
    edgeAvailableCount: 0,
    advisoryCount: ordered.length,
    oofExposureStart: new Date(HY_EXP_0030_OOF_START).toISOString(),
    oofExposureEndExclusive: new Date(HY_EXP_0030_OOF_END).toISOString(),
    oofExposureDays: HY_EXP_0030_OOF_DAYS,
    advisoriesPer30Days: ordered.length * 30 / HY_EXP_0030_OOF_DAYS,
    grossExpectancyBps: mean(oofCandidates.map(row => row.label.grossPriceReturnBps)),
    net18ExpectancyBps: mean(net18Returns),
    net18ProfitFactor: profitFactor(ordered, 'netPnl'),
    net27ExpectancyBps: mean(net27Returns),
    net27ProfitFactor: profitFactor(ordered, 'stressNetPnl'),
    netPnl,
    netReturn: netPnl / RESEARCH_EQUITY_USDT,
    netReturnBps: netPnl / RESEARCH_EQUITY_USDT * 10_000,
    activeMonthCount: activeMonths.length,
    activeMonths,
    positiveActiveMonths: positiveActiveMonths.length,
    positiveActiveMonthShare: activeMonths.length ? positiveActiveMonths.length / activeMonths.length : null,
    monthlyNetPnl,
    monthlyStressPnl,
    bestPositiveMonth,
    bestPositiveMonthPnl,
    bestMonthPositivePnlShare: positiveBestMonthShare,
    netPnlWithoutBestMonth,
    distinctSymbols,
    symbols: Object.entries(bySymbol).filter(([, count]) => count > 0).map(([symbol]) => symbol).sort(),
    bySymbol,
    largestSymbolShare,
    maxLossStreak: lossStreak(ordered),
    risk,
    maxMtmDrawdown: risk.maxMtmDrawdown,
    cvar95LossFraction: risk.cvar95LossFraction,
    cvar95LossBps: risk.cvar95LossBps,
    fundingPnl: ordered.reduce((sum, row) => sum + row.realizedFunding.fundingPnlPerUnit * row.notional / row.entryPrice, 0),
    foldReports,
    developmentGates: { checks: gates, pass: Object.values(gates).every(Boolean) },
    uncertaintyVetoApplied: false,
    conservativePredictionVetoApplied: false,
    modelSearchApplied: false,
    paperOnly: true,
    signalOnly: true,
    liveOrdersEnabled: false,
    accountApi: false,
    orderApi: false
  };
}

function validatePreregistration(root) {
  const file = path.join(root, 'registry', 'experiments', HY_EXP_0030_EXPERIMENT_ID, 'preregistration.json');
  const buffer = fs.readFileSync(file);
  const preregistration = JSON.parse(buffer);
  if (sha256(buffer) !== HY_EXP_0030_PREREGISTRATION_SHA256) throw new Error('HY-EXP-0030 preregistration hash mismatch');
  if (preregistration.status !== 'PREREGISTERED' || preregistration.experimentId !== HY_EXP_0030_EXPERIMENT_ID) {
    throw new Error('HY-EXP-0030 is not formally preregistered');
  }
  if (preregistration.authorization !== 'PAPER_ONLY'
    || preregistration.signalOnly !== true
    || preregistration.liveOrdersEnabled !== false
    || preregistration.accountApi !== false
    || preregistration.orderApi !== false
    || preregistration.automaticTrading !== false
    || preregistration.oosRead !== false
    || preregistration.candidateFamily.id !== 'VOLATILITY_COMPRESSION_EXPANSION'
    || preregistration.candidateFamily.q75Allowed !== false
    || preregistration.candidateFamily.mlAllowed !== false
    || preregistration.candidateFamily.ridgeAllowed !== false
    || preregistration.execution.exit.maximumHoldCompleted1hBars !== HY_EXP_0030_MAX_HOLD_BARS
    || preregistration.execution.costs.baseExecutionCostBps !== HY_EXP_0030_BASE_COST_BPS
    || preregistration.execution.costs.stressExecutionCostBps !== HY_EXP_0030_STRESS_COST_BPS) {
    throw new Error('HY-EXP-0030 preregistration safety or semantics drifted');
  }
  return { preregistration, preregistrationSha256: sha256(buffer) };
}

function buildDevelopmentCandidates(dataset) {
  const bars5mBySymbol = dataset.bars5mBySymbol;
  const bars1hBySymbol = dataset.bars1hBySymbol;
  const bars4hBySymbol = dataset.bars4hBySymbol;
  const fiveMaps = Object.fromEntries(HY_EXP_0030_SYMBOLS.map(symbol => [
    symbol,
    new Map(bars5mBySymbol[symbol].filter(row => row.openTime + FIVE_MINUTES <= DEVELOPMENT_END).map(row => [row.openTime, row]))
  ]));
  const rawCandidates = [];
  const labeledCandidates = [];
  const contexts = [];
  const reference = bars1hBySymbol.BTCUSDT;
  for (let index = 0; index < reference.length; index++) {
    const signalBar = reference[index];
    const decisionTime = signalBar.closeBoundary;
    if (decisionTime < DEVELOPMENT_START || decisionTime >= DEVELOPMENT_END) continue;
    const regime = regimeAt({ bars4hBySymbol, decisionTime });
    if (!regime) continue;
    contexts.push({ signalTime: decisionTime, regime });
    if (regime.regime !== 'BULL') continue;
    for (const symbol of HY_EXP_0030_SYMBOLS) {
      const bars = bars1hBySymbol[symbol];
      const row = bars[index];
      if (!row || row.openTime !== signalBar.openTime) throw new Error(`HY-EXP-0030 bar alignment failure at ${signalBar.openTime}`);
      const signal = evaluateCompressionExpansion({ bars, index });
      if (!signal.qualifies) continue;
      const candidate = {
        id: `${symbol}:${decisionTime}`,
        experimentId: HY_EXP_0030_EXPERIMENT_ID,
        symbol,
        side: 'BUY',
        family: 'VOLATILITY_COMPRESSION_EXPANSION',
        regime: 'BULL',
        signalTime: decisionTime,
        decisionTime,
        atr20: signal.atr20,
        normalizedAtr: signal.atr20 / row.close,
        previousNormalizedAtr: signal.previousNormalizedAtr,
        compressionMedian: signal.compressionMedian,
        currentTrueRange: signal.currentTrueRange,
        prior24High: signal.prior24High,
        triggerMidpoint: (row.high + row.low) / 2,
        fundingRows: dataset.fundingBySymbol[symbol]
      };
      rawCandidates.push(candidate);
      const label = labelCompressionExpansion({
        candidate,
        bars1h: bars,
        bars5m: bars5mBySymbol[symbol].filter(item => item.openTime + FIVE_MINUTES <= DEVELOPMENT_END),
        fiveByOpenTime: fiveMaps[symbol]
      });
      if (label.usable && label.labelEndTime < DEVELOPMENT_END) labeledCandidates.push({ ...candidate, label });
    }
  }
  return { rawCandidates, labeledCandidates, contexts };
}

function buildOofRows(labeledCandidates) {
  const oofCandidates = [];
  const foldReports = [];
  for (const fold of FOLDS) {
    const trainingRaw = labeledCandidates.filter(row => row.signalTime >= fold.trainStartMs
      && row.signalTime < fold.trainEndMs
      && row.label.labelEndTime <= fold.purgeCutoffMs);
    const validation = labeledCandidates.filter(row => row.signalTime >= fold.validationStartMs
      && row.signalTime < fold.validationEndMs
      && row.label.labelEndTime < DEVELOPMENT_END);
    for (const row of validation) oofCandidates.push({ ...row, foldId: fold.id });
    foldReports.push({
      foldId: fold.id,
      trainStart: fold.trainStart,
      trainEndExclusive: fold.trainEndExclusive,
      validationStart: fold.validationStart,
      validationEndExclusive: fold.validationEndExclusive,
      purgeBars: 6,
      embargoBars: 6,
      trainingRowsAvailableForAudit: trainingRaw.length,
      validationCandidateCount: validation.length,
      validationAdvisoryCount: validation.length,
      ruleSelectionAfterValidation: false,
      modelTraining: false,
      edgeModel: 'NONE_RULE_BASED'
    });
  }
  const seen = new Set();
  for (const row of oofCandidates) {
    if (seen.has(row.id)) throw new Error(`duplicate HY-EXP-0030 OOF advisory ${row.id}`);
    seen.add(row.id);
  }
  return { oofCandidates, foldReports };
}

export function runHyExp0030Development({ root = ROOT, dataset = loadHyExp0024Dataset({ root }) } = {}) {
  const { preregistration, preregistrationSha256 } = validatePreregistration(root);
  if (dataset.sourceExperimentId !== 'HY-EXP-0001') throw new Error('HY-EXP-0030 source must be the locked HY-EXP-0001 Development dataset');
  if (dataset.sourceManifest?.experiment_id !== 'HY-EXP-0001') throw new Error('HY-EXP-0030 source manifest mismatch');
  const { rawCandidates, labeledCandidates, contexts } = buildDevelopmentCandidates(dataset);
  const { oofCandidates, foldReports } = buildOofRows(labeledCandidates);
  const advisories = oofCandidates.map(buildAdvisory);
  const diagnostics = advisories.map(advisory => ({
    id: advisory.id,
    status: 'ADVISORY',
    rule: 'VOLATILITY_COMPRESSION_EXPANSION',
    reasons: [],
    postOutcomeFilter: false,
    outcome: {
      grossPriceReturnBps: advisory.grossPriceReturnBps,
      realizedFundingBps: advisory.realizedFundingBps,
      net18Bps: advisory.net18Bps,
      net27Bps: advisory.net27Bps,
      exitReason: advisory.exitReason
    }
  }));
  const metrics = summarizeDevelopment({
    rawCandidateCount: rawCandidates.length,
    labeledCandidates,
    oofCandidates,
    advisories,
    foldReports
  });
  const developmentPass = metrics.developmentGates.pass;
  return {
    experimentId: HY_EXP_0030_EXPERIMENT_ID,
    baseCommit: HY_EXP_0030_BASE_COMMIT,
    status: developmentPass ? 'DEVELOPMENT_PASS' : 'DEVELOPMENT_FAILED_TERMINAL',
    evidenceClass: 'D0_DEVELOPMENT_ONLY',
    authorization: 'PAPER_ONLY',
    signalOnly: true,
    paperOnly: true,
    liveOrdersEnabled: false,
    accountApi: false,
    orderApi: false,
    automaticTrading: false,
    developmentPnlComputed: true,
    finalOosPnlComputed: false,
    finalOosRead: false,
    experimentalReleaseReady: developmentPass,
    deploymentPrepared: false,
    noParameterRescue: true,
    noSecondDevelopmentPass: true,
    noFeatureSearch: true,
    noMl: true,
    noRidge: true,
    preregistrationSha256,
    development: {
      start: new Date(DEVELOPMENT_START).toISOString(),
      endExclusive: new Date(DEVELOPMENT_END).toISOString(),
      sourceExperimentId: dataset.sourceExperimentId,
      sourceManifestSha256: dataset.sourceManifestSha256,
      sourceRule: preregistration.development.source,
      contexts: contexts.length,
      rawCandidateCount: rawCandidates.length,
      labeledCandidateCount: labeledCandidates.length,
      oofPredictionCount: oofCandidates.length,
      edgeAvailableCount: 0,
      advisoryCount: advisories.length,
      metrics,
      foldReports,
      finalOosRead: false,
      finalOosStatus: 'SEALED_NOT_READ',
      noHoldoutRead: true,
      noFutureData: true
    },
    candidateSpecification: {
      family: 'VOLATILITY_COMPRESSION_EXPANSION',
      regime: 'BULL_ONLY',
      side: 'BUY_ONLY',
      compressionBaselineBars: HY_EXP_0030_COMPRESSION_LOOKBACK,
      expansionPriorHighBars: HY_EXP_0030_BREAKOUT_LOOKBACK,
      expansionTrueRangeMultiple: HY_EXP_0030_COMPRESSION_TR_MULTIPLE,
      stopAtrMultiple: HY_EXP_0030_STOP_ATR_MULTIPLE,
      maximumHoldBars: HY_EXP_0030_MAX_HOLD_BARS,
      exitFailure: 'TRIGGER_BAR_MIDPOINT',
      edgeModel: 'NONE',
      q75: false,
      ridge: false,
      ml: false
    },
    oos: {
      read: false,
      computed: false,
      status: 'SEALED',
      reason: 'HY-EXP-0030 Development did not read HY-EXP-0028 holdout or Final OOS.'
    },
    prospectiveValidation: developmentPass
      ? {
        allowed: true,
        codePrepared: true,
        enabled: false,
        deployed: false,
        activationMustBeRecorded: true,
        minimumDays: 21,
        maximumDays: 30,
        minimumAdvisories: 12,
        noAutomaticTrading: true
      }
      : {
        allowed: false,
        codePrepared: false,
        enabled: false,
        deployed: false,
        reason: 'Development gates failed; stop the strategy family.'
      },
    safety: {
      SIGNAL_ONLY: true,
      PAPER_ONLY: true,
      liveOrdersEnabled: false,
      accountApi: false,
      orderApi: false,
      automaticTrading: false
    },
    advisories,
    diagnostics,
    blockers: developmentPass
      ? ['Prospective validation requires separate activation and human deployment authorization; no deployment performed.']
      : ['DEVELOPMENT_FAILED_TERMINAL; do not tune, rescue, deploy or read Final OOS.']
  };
}
