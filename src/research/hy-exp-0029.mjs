import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  DEVELOPMENT_END,
  DEVELOPMENT_START,
  FOLDS,
  FOUR_HOURS,
  HOUR,
  FIVE_MINUTES,
  RESEARCH_EQUITY_USDT,
  loadHyExp0024Dataset
} from './hy-exp-0024.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const HY_EXP_0029_EXPERIMENT_ID = 'HY-EXP-0029';
export const HY_EXP_0029_BASE_COMMIT = 'a61cb20318af1e0b188c0276a1a3d65e52bc4467';
export const HY_EXP_0029_PREREGISTRATION_SHA256 = '17c543094ab125f6a89ae542f5f4b8a966c59c0c325236494aa55b40a6610b5e';
export const HY_EXP_0029_SYMBOLS = Object.freeze([
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT',
  'XRPUSDT', 'DOGEUSDT', 'LINKUSDT', 'LTCUSDT'
]);
export const HY_EXP_0029_BASE_COST_BPS = 18;
export const HY_EXP_0029_STRESS_COST_BPS = 27;
export const HY_EXP_0029_MAX_HOLD_BARS = 12;
export const HY_EXP_0029_STOP_ATR_MULTIPLE = 1.5;
export const HY_EXP_0029_OOF_START = Date.parse('2025-01-01T00:00:00.000Z');
export const HY_EXP_0029_OOF_END = DEVELOPMENT_END;
export const HY_EXP_0029_OOF_DAYS = (HY_EXP_0029_OOF_END - HY_EXP_0029_OOF_START) / (24 * HOUR);

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function finite(value) {
  return value != null && Number.isFinite(Number(value));
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function monthKey(time) {
  return new Date(time).toISOString().slice(0, 7);
}

function sideSign(side) {
  if (side === 'BUY') return 1;
  throw new Error(`HY-EXP-0029 only supports BUY, received ${side}`);
}

function directionalReturnBps(side, entryPrice, exitPrice) {
  return sideSign(side) * (exitPrice - entryPrice) / entryPrice * 10_000;
}

function sma(rows, index, period) {
  if (index < period - 1) return null;
  return mean(rows.slice(index - period + 1, index + 1).map(row => Number(row.close)));
}

function atr20(rows, index) {
  if (index < 20) return null;
  const ranges = [];
  for (let cursor = index - 19; cursor <= index; cursor++) {
    const previousClose = Number(rows[cursor - 1].close);
    ranges.push(Math.max(
      Number(rows[cursor].high) - Number(rows[cursor].low),
      Math.abs(Number(rows[cursor].high) - previousClose),
      Math.abs(Number(rows[cursor].low) - previousClose)
    ));
  }
  return mean(ranges);
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
  for (const symbol of HY_EXP_0029_SYMBOLS) {
    const row = bars4hBySymbol[symbol][fourHourIndex];
    const slow = sma(bars4hBySymbol[symbol], fourHourIndex, 180);
    if (!row || slow == null) return null;
    breadthRows[symbol] = {
      close: row.close,
      sma180: slow,
      aboveSma180: row.close > slow
    };
  }
  const breadthAbove = Object.values(breadthRows).filter(row => row.aboveSma180).length;
  const breadthRequired = Math.ceil(HY_EXP_0029_SYMBOLS.length * 2 / 3);
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
    breadthFraction: breadthAbove / HY_EXP_0029_SYMBOLS.length,
    fourHourIndex,
    fourHourCloseBoundary: btcRows[fourHourIndex].closeBoundary,
    bySymbol: breadthRows
  };
}

/** Evaluate the frozen rule using only completed bars and the causal indicator values. */
export function evaluatePullbackReclaim({ bars, index } = {}) {
  const current = bars?.[index];
  const previous = bars?.[index - 1];
  const prior = bars?.slice(index - 3, index) ?? [];
  const currentSma20 = sma(bars, index, 20);
  const currentSma50 = sma(bars, index, 50);
  const currentAtr20 = atr20(bars, index);
  const priorIndicators = prior.map((bar, offset) => {
    const priorIndex = index - 3 + offset;
    return {
      openTime: bar.openTime,
      low: bar.low,
      close: bar.close,
      sma20: sma(bars, priorIndex, 20),
      sma50: sma(bars, priorIndex, 50)
    };
  });
  const historyComplete = Boolean(isCompletedBar(current) && isCompletedBar(previous) && prior.length === 3
    && prior.every(isCompletedBar)
    && currentSma20 != null && currentSma50 != null && currentAtr20 != null
    && priorIndicators.every(row => row.sma20 != null && row.sma50 != null));
  const symbolTrend = historyComplete && currentSma20 > currentSma50 && current.close > currentSma50;
  const pullbackTouch = historyComplete && priorIndicators.some(row => row.low <= row.sma20);
  const pullbackIntact = historyComplete && priorIndicators.every(row => row.close >= row.sma50);
  const reclaim = historyComplete && current.close > currentSma20 && current.close > previous.high;
  return {
    symbolTrend,
    pullbackTouch,
    pullbackIntact,
    reclaim,
    qualifies: historyComplete && symbolTrend && pullbackTouch && pullbackIntact && reclaim,
    currentSma20,
    currentSma50,
    atr20: currentAtr20,
    priorIndicators,
    currentBarExcludedFromPullback: true
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
      returnBps: directionalReturnBps('BUY', entryPrice, price)
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
    details.push({
      fundingTime: row.eventTime,
      fundingRate: row.fundingRate,
      markPrice,
      payment
    });
  }
  return {
    fundingPnlPerUnit,
    fundingPnlBps: fundingPnlPerUnit / entryPrice * 10_000,
    events: details
  };
}

/** Apply the exact +5m entry and frozen 1.5 ATR/SMA20/12-bar exit with no rescue. */
export function labelPullbackReclaim({ candidate, bars1h, bars5m, fiveByOpenTime } = {}) {
  const entryTime = candidate.decisionTime + FIVE_MINUTES;
  const entryBar = fiveMinuteAt(fiveByOpenTime, entryTime);
  if (!entryBar) return { usable: false, rejection: 'MISSING_EXACT_5M_EXECUTION_BAR' };
  const entryPrice = entryBar.open;
  const stopPrice = entryPrice - HY_EXP_0029_STOP_ATR_MULTIPLE * candidate.atr20;
  if (!(stopPrice > 0)) return { usable: false, rejection: 'INVALID_STOP_PRICE' };
  const evaluationBars = bars1h
    .map((row, index) => ({ row, index }))
    .filter(item => item.row.closeBoundary > entryTime && isCompletedBar(item.row))
    .slice(0, HY_EXP_0029_MAX_HOLD_BARS);
  if (evaluationBars.length < HY_EXP_0029_MAX_HOLD_BARS) {
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
    const causalSma20 = sma(bars1h, index, 20);
    if (causalSma20 == null) return { usable: false, rejection: 'MISSING_CAUSAL_SMA20_EXIT' };
    if (row.close < causalSma20) {
      exit = { price: row.close, time: row.closeBoundary, reason: 'SMA20_TREND_FAILURE' };
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
    grossPriceReturnBps: directionalReturnBps('BUY', entryPrice, exit.price),
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
  if (!size) throw new Error(`HY-EXP-0029 invalid position size for ${candidate.id}`);
  const fundingPnlBps = candidate.label.realizedFunding.fundingPnlBps;
  const netReturnBps = candidate.label.grossPriceReturnBps + fundingPnlBps - HY_EXP_0029_BASE_COST_BPS;
  const stressNetReturnBps = candidate.label.grossPriceReturnBps + fundingPnlBps - HY_EXP_0029_STRESS_COST_BPS;
  return {
    experimentId: HY_EXP_0029_EXPERIMENT_ID,
    phase: 'development_oof',
    status: 'PAPER_VALIDATION_ADVISORY',
    id: candidate.id,
    symbol: candidate.symbol,
    side: 'BUY',
    regime: 'BULL',
    family: 'TREND_PULLBACK_RECLAIM',
    signalTime: candidate.signalTime,
    decisionTime: candidate.decisionTime,
    entryTime: candidate.label.entryTime,
    entryPrice: candidate.label.entryPrice,
    executablePrice: candidate.label.executablePrice,
    exitTime: candidate.label.exitTime,
    exitPrice: candidate.label.exitPrice,
    exitReason: candidate.label.exitReason,
    stopPrice: candidate.label.stopPrice,
    sma20: candidate.sma20,
    sma50: candidate.sma50,
    atr20: candidate.atr20,
    quantity: size.quantity,
    notional: size.notional,
    lossAtStop: size.lossAtStop,
    grossPriceReturnBps: candidate.label.grossPriceReturnBps,
    realizedFundingBps: fundingPnlBps,
    realizedFunding: candidate.label.realizedFunding,
    net18Bps: netReturnBps,
    net27Bps: stressNetReturnBps,
    netReturnBps,
    stressNetReturnBps,
    netPnl: size.notional * netReturnBps / 10_000,
    stressNetPnl: size.notional * stressNetReturnBps / 10_000,
    maeBps: Math.min(...candidate.label.marks.map(mark => mark.returnBps)),
    mfeBps: Math.max(...candidate.label.marks.map(mark => mark.returnBps)),
    markToMarketDrawdownBps: markDrawdown(candidate.label.marks),
    marks: candidate.label.marks,
    costs: {
      baseTotalBps: HY_EXP_0029_BASE_COST_BPS,
      stressTotalBps: HY_EXP_0029_STRESS_COST_BPS,
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
  const times = new Set([HY_EXP_0029_OOF_START, HY_EXP_0029_OOF_END - 1]);
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
  const months = monthKeys(HY_EXP_0029_OOF_START, HY_EXP_0029_OOF_END);
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
  const bySymbol = Object.fromEntries(HY_EXP_0029_SYMBOLS.map(symbol => [
    symbol,
    ordered.filter(row => row.symbol === symbol).length
  ]));
  const distinctSymbols = Object.values(bySymbol).filter(value => value > 0).length;
  const largestSingleSymbolShare = ordered.length ? Math.max(...Object.values(bySymbol)) / ordered.length : null;
  const netPnl = ordered.reduce((sum, row) => sum + row.netPnl, 0);
  const netPnlWithoutBestMonth = bestPositiveMonth == null ? netPnl : netPnl - bestPositiveMonthPnl;
  const positiveTradePnl = ordered.filter(row => row.netPnl > 0).reduce((sum, row) => sum + row.netPnl, 0);
  const positiveBestMonthShare = positiveMonthPnl > 0 ? bestPositiveMonthPnl / positiveMonthPnl : null;
  const net18Returns = ordered.map(row => row.net18Bps);
  const net27Returns = ordered.map(row => row.net27Bps);
  const gates = {
    advisoryCountAtLeast120: ordered.length >= 120,
    usableAdvisoriesPer30DaysAtLeast8: ordered.length * 30 / HY_EXP_0029_OOF_DAYS >= 8,
    net18ExpectancyGreaterThan8: mean(net18Returns) != null && mean(net18Returns) > 8,
    net18ProfitFactorGreaterThan1_15: profitFactor(ordered, 'netPnl') != null && profitFactor(ordered, 'netPnl') > 1.15,
    net27ExpectancyGreaterThan0: mean(net27Returns) != null && mean(net27Returns) > 0,
    net27ProfitFactorGreaterThan1_02: profitFactor(ordered, 'stressNetPnl') != null && profitFactor(ordered, 'stressNetPnl') > 1.02,
    activeMonthCountAtLeast10: activeMonths.length >= 10,
    positiveActiveMonthShareAtLeast0_45: activeMonths.length > 0 && positiveActiveMonths.length / activeMonths.length >= 0.45,
    distinctSymbolsAtLeast6: distinctSymbols >= 6,
    largestSingleSymbolShareAtMost0_35: largestSingleSymbolShare != null && largestSingleSymbolShare <= 0.35,
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
    oofExposureStart: new Date(HY_EXP_0029_OOF_START).toISOString(),
    oofExposureEndExclusive: new Date(HY_EXP_0029_OOF_END).toISOString(),
    oofExposureDays: HY_EXP_0029_OOF_DAYS,
    usableAdvisoriesPer30Days: ordered.length * 30 / HY_EXP_0029_OOF_DAYS,
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
    largestSingleSymbolShare,
    maxLossStreak: lossStreak(ordered),
    risk,
    maxMtmDrawdown: risk.maxMtmDrawdown,
    cvar95LossFraction: risk.cvar95LossFraction,
    cvar95LossBps: risk.cvar95LossBps,
    fundingPnl: ordered.reduce((sum, row) => sum + row.realizedFunding.fundingPnlPerUnit * row.notional / row.entryPrice, 0),
    positiveTradePnl,
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
  const file = path.join(root, 'registry', 'experiments', HY_EXP_0029_EXPERIMENT_ID, 'preregistration.json');
  const buffer = fs.readFileSync(file);
  const preregistration = JSON.parse(buffer);
  if (sha256(buffer) !== HY_EXP_0029_PREREGISTRATION_SHA256) throw new Error('HY-EXP-0029 preregistration hash mismatch');
  if (preregistration.status !== 'PREREGISTERED' || preregistration.experimentId !== HY_EXP_0029_EXPERIMENT_ID) {
    throw new Error('HY-EXP-0029 is not formally preregistered');
  }
  if (preregistration.authorization !== 'PAPER_ONLY'
    || preregistration.signalOnly !== true
    || preregistration.liveOrdersEnabled !== false
    || preregistration.accountApi !== false
    || preregistration.orderApi !== false
    || preregistration.automaticTrading !== false
    || preregistration.oosRead !== false
    || preregistration.candidateFamily.id !== 'TREND_PULLBACK_RECLAIM'
    || preregistration.candidateFamily.parameterOptimizationAllowed !== false
    || preregistration.candidateFamily.featureSearchAllowed !== false
    || preregistration.execution.exit.maximumHoldCompleted1hBars !== HY_EXP_0029_MAX_HOLD_BARS
    || preregistration.execution.costs.baseExecutionCostBps !== HY_EXP_0029_BASE_COST_BPS
    || preregistration.execution.costs.stressExecutionCostBps !== HY_EXP_0029_STRESS_COST_BPS) {
    throw new Error('HY-EXP-0029 preregistration safety or semantics drifted');
  }
  return { preregistration, preregistrationSha256: sha256(buffer) };
}

function buildDevelopmentCandidates(dataset) {
  const bars5mBySymbol = dataset.bars5mBySymbol;
  const bars1hBySymbol = dataset.bars1hBySymbol;
  const bars4hBySymbol = dataset.bars4hBySymbol;
  const fiveMaps = Object.fromEntries(HY_EXP_0029_SYMBOLS.map(symbol => [
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
    for (const symbol of HY_EXP_0029_SYMBOLS) {
      const bars = bars1hBySymbol[symbol];
      const row = bars[index];
      if (!row || row.openTime !== signalBar.openTime) throw new Error(`HY-EXP-0029 bar alignment failure at ${signalBar.openTime}`);
      const signal = evaluatePullbackReclaim({ bars, index });
      if (!signal.qualifies) continue;
      const candidate = {
        id: `${symbol}:${decisionTime}`,
        experimentId: HY_EXP_0029_EXPERIMENT_ID,
        symbol,
        side: 'BUY',
        family: 'TREND_PULLBACK_RECLAIM',
        regime: 'BULL',
        signalTime: decisionTime,
        decisionTime,
        sma20: signal.currentSma20,
        sma50: signal.currentSma50,
        atr20: signal.atr20,
        pullback: signal.priorIndicators,
        regimeSnapshot: regime,
        fundingRows: dataset.fundingBySymbol[symbol]
      };
      rawCandidates.push(candidate);
      const label = labelPullbackReclaim({
        candidate,
        bars1h: bars,
        bars5m: bars5mBySymbol[symbol].filter(row => row.openTime + FIVE_MINUTES <= DEVELOPMENT_END),
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
    if (seen.has(row.id)) throw new Error(`duplicate HY-EXP-0029 OOF advisory ${row.id}`);
    seen.add(row.id);
  }
  return { oofCandidates, foldReports };
}

export function runHyExp0029Development({ root = ROOT, dataset = loadHyExp0024Dataset({ root }) } = {}) {
  const { preregistration, preregistrationSha256 } = validatePreregistration(root);
  if (dataset.sourceExperimentId !== 'HY-EXP-0001') throw new Error('HY-EXP-0029 source must be the locked HY-EXP-0001 Development dataset');
  if (dataset.sourceManifest?.experiment_id !== 'HY-EXP-0001') throw new Error('HY-EXP-0029 source manifest mismatch');
  const { rawCandidates, labeledCandidates, contexts } = buildDevelopmentCandidates(dataset);
  const { oofCandidates, foldReports } = buildOofRows(labeledCandidates);
  const advisories = oofCandidates.map(buildAdvisory);
  const diagnostics = advisories.map(advisory => ({
    id: advisory.id,
    status: 'ADVISORY',
    rule: 'TREND_PULLBACK_RECLAIM',
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
    experimentId: HY_EXP_0029_EXPERIMENT_ID,
    baseCommit: HY_EXP_0029_BASE_COMMIT,
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
      family: 'TREND_PULLBACK_RECLAIM',
      regime: 'BULL_ONLY',
      side: 'BUY_ONLY',
      sma20: 'completed 1h causal',
      sma50: 'completed 1h causal',
      pullbackBars: 3,
      stopAtrMultiple: HY_EXP_0029_STOP_ATR_MULTIPLE,
      maximumHoldBars: HY_EXP_0029_MAX_HOLD_BARS,
      edgeModel: 'NONE',
      q75: false,
      ruleA: false,
      ruleB: false,
      ridge: false,
      ml: false
    },
    oos: {
      read: false,
      computed: false,
      status: 'SEALED',
      reason: 'HY-EXP-0029 Development did not read HY-EXP-0028 holdout or Final OOS.'
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
