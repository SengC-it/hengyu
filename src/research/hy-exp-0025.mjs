import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { evaluatePortfolioRisk } from '../model/net-edge.mjs';
import {
  HY_EXP_0025_CHANNEL_DISTANCE_FEATURE,
  HY_EXP_0025_EDGE_MODEL_ID,
  HY_EXP_0025_EDGE_SOURCE,
  evaluateHyExp0025NetEdge,
  fitHyExp0025EmpiricalBucket,
  predictHyExp0025EmpiricalBucket,
  trainingQ75
} from '../model/hy-exp-0025-edge.mjs';
import {
  buildHyExp0024CandidateRows,
  DEVELOPMENT_END,
  DEVELOPMENT_START,
  FOLDS,
  FUNDING_STRESS_BUFFER_BPS,
  HISTORICAL_BASE_COST_BPS,
  HISTORICAL_STRESS_COST_BPS,
  HOUR,
  loadHyExp0024Dataset,
  RESEARCH_EQUITY_USDT,
  PURGE_BARS,
  EMBARGO_BARS
} from './hy-exp-0024.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PREREGISTRATION_PATH = path.join(ROOT, 'registry', 'experiments', 'HY-EXP-0025', 'preregistration.json');
export const HY_EXP_0025_EXPERIMENT_ID = 'HY-EXP-0025';
export const HY_EXP_0025_PRIMARY_CELL = 'BULL/BUY/TREND_BREAKOUT';
export const HY_EXP_0025_PREREGISTRATION_SHA256 = '5a27a6107c0dc1c9d7b2ac87e86cfa34b5e21562a915fc638054b88f153c993d';
export const HY_EXP_0025_CONFIDENCE_Z = 1.645;
export const HY_EXP_0025_MINIMUM_CONSERVATIVE_NET_BPS = 3;
export const HY_EXP_0025_MINIMUM_GROSS_TO_COST_RATIO = 1.5;
export const HY_EXP_0025_SYMBOLS = Object.freeze([
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT',
  'XRPUSDT', 'DOGEUSDT', 'LINKUSDT', 'LTCUSDT'
]);

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function finite(value) {
  return value != null && Number.isFinite(Number(value));
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function sampleStandardDeviation(values) {
  if (values.length < 2) return null;
  const center = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1));
}

function percentile(values, probability) {
  const ordered = [...values].sort((left, right) => left - right);
  if (!ordered.length) return null;
  const position = (ordered.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return ordered[lower];
  return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower);
}

function monthKey(time) {
  return new Date(time).toISOString().slice(0, 7);
}

function dayKey(time) {
  return new Date(time).toISOString().slice(0, 10);
}

function monthKeys(start, endExclusive) {
  const output = [];
  const cursor = new Date(start);
  cursor.setUTCDate(1);
  const end = new Date(endExclusive);
  while (cursor < end) {
    output.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return output;
}

function validPrimaryRows(dataset) {
  const source = buildHyExp0024CandidateRows({ dataset });
  const primary = source.candidates.filter(row => row.cell === HY_EXP_0025_PRIMARY_CELL
    && row.signalTime >= DEVELOPMENT_START
    && row.signalTime < DEVELOPMENT_END
    && row.label?.labelEndTime < DEVELOPMENT_END
    && Array.isArray(row.features)
    && finite(row.features[7]));
  return {
    ...source,
    primaryRows: primary,
    primaryRawCandidateCount: primary.length
  };
}

function foldTrainingRows(rows, fold) {
  return rows.filter(row => row.signalTime >= fold.trainStartMs
    && row.signalTime < fold.trainEndMs
    && row.label.labelEndTime <= fold.purgeCutoffMs);
}

function foldValidationRows(rows, fold) {
  return rows.filter(row => row.signalTime >= fold.validationStartMs
    && row.signalTime < fold.validationEndMs
    && row.label.labelEndTime < DEVELOPMENT_END);
}

function validationWindow(fold) {
  return {
    foldId: fold.id,
    trainStart: fold.trainStart,
    trainEndExclusive: fold.trainEndExclusive,
    validationStart: fold.validationStart,
    validationEndExclusive: fold.validationEndExclusive,
    purgeBars: PURGE_BARS,
    embargoBars: EMBARGO_BARS,
    method: 'expanding_walk_forward_purged'
  };
}

function buildFoldPredictions(primaryRows) {
  const predictions = [];
  const foldReports = [];
  for (const fold of FOLDS) {
    const training = foldTrainingRows(primaryRows, fold);
    const q75 = trainingQ75(training);
    const model = fitHyExp0025EmpiricalBucket(training, {
      q75,
      validationWindow: validationWindow(fold)
    });
    const smaValues = training.map(row => Number(row.features[2])).filter(Number.isFinite);
    const breakoutValues = training.map(row => Number(row.features[0])).filter(Number.isFinite);
    const trainingSmaQ25 = percentile(smaValues, 0.25);
    const trainingBreakoutQ75 = percentile(breakoutValues, 0.75);
    const validation = foldValidationRows(primaryRows, fold);
    const qualifyingValidation = validation.filter(row => row.features[7] >= q75);
    for (const row of qualifyingValidation) {
      const edge = predictHyExp0025EmpiricalBucket(model, row, validationWindow(fold));
      if (!edge.available) continue;
      predictions.push({
        ...row,
        foldId: fold.id,
        edge,
        secondaryDiagnostics: {
          sma60MinusSma180Q1: trainingSmaQ25 != null && row.features[2] <= trainingSmaQ25,
          breakoutDistanceQ4: trainingBreakoutQ75 != null && row.features[0] >= trainingBreakoutQ75
        }
      });
    }
    foldReports.push({
      foldId: fold.id,
      validationWindow: validationWindow(fold),
      trainingCandidateCount: training.length,
      trainingQ75: q75,
      qualifyingTrainingRows: model.sampleSize,
      standardErrorOfMeanBps: model.standardErrorOfMeanBps,
      monthlyClusteredStandardErrorBps: model.monthlyClusteredStandardErrorBps,
      validationCandidateCount: validation.length,
      validationQ75CandidateCount: qualifyingValidation.length,
      edgeAvailableValidationCount: predictions.filter(row => row.foldId === fold.id && row.edge?.available).length,
      trainingSma60MinusSma180Q25: trainingSmaQ25,
      trainingBreakoutDistanceQ75: trainingBreakoutQ75,
      edgeModelId: model.modelId,
      edgeSource: model.edgeSource,
      minimumTrainingSamples: model.minimumSamples
    });
  }
  return { predictions, foldReports };
}

function positionSize(row) {
  const stopDistanceBps = Math.abs(row.label.entryPrice - row.label.stopPrice) / row.label.entryPrice * 10_000;
  if (!(stopDistanceBps > 0)) return null;
  const lossBudget = RESEARCH_EQUITY_USDT * 0.0025;
  const riskNotional = lossBudget / (stopDistanceBps / 10_000);
  const notional = Math.min(riskNotional, RESEARCH_EQUITY_USDT * 0.5);
  return {
    notional,
    quantity: notional / row.label.entryPrice,
    stopDistanceBps,
    lossAtStop: notional * stopDistanceBps / 10_000
  };
}

function activePositionRows(trades, decisionTime) {
  return trades.filter(trade => trade.decisionTime <= decisionTime && trade.exitTime > decisionTime);
}

function portfolioGate(row, size, admitted) {
  const open = activePositionRows(admitted, row.decisionTime).map(trade => ({
    symbol: trade.symbol,
    side: trade.side,
    notional: trade.notional,
    beta: 1,
    lossAtStop: trade.lossAtStop,
    cluster: trade.cluster
  }));
  if (open.some(position => position.symbol === row.symbol)) {
    return { decision: 'NO_TRADE', reasons: ['POSITION_ALREADY_OPEN'], metrics: null };
  }
  return evaluatePortfolioRisk({
    equity: RESEARCH_EQUITY_USDT,
    positions: [...open, {
      symbol: row.symbol,
      side: row.side,
      notional: size.notional,
      beta: 1,
      lossAtStop: size.lossAtStop,
      cluster: `${row.regime}:${row.signalTime}`
    }],
    limits: {
      maximumPositions: 5,
      maximumGrossLeverage: 1,
      maximumNetExposureFraction: 0.2,
      maximumBetaExposureFraction: 0.2,
      maximumPortfolioLossFraction: 0.02,
      maximumSinglePositionFraction: 0.5,
      maximumClusterLossFraction: 0.01
    }
  });
}

function buildTrade(row, size, baseGate, stressGate, portfolio) {
  const realizedFundingBps = row.label.realizedFunding.fundingPnlBps;
  const netReturnBps = row.label.grossPriceReturnBps - HISTORICAL_BASE_COST_BPS + realizedFundingBps;
  const stressNetReturnBps = row.label.grossPriceReturnBps - HISTORICAL_STRESS_COST_BPS + realizedFundingBps;
  return {
    experimentId: HY_EXP_0025_EXPERIMENT_ID,
    phase: 'development',
    id: row.id,
    symbol: row.symbol,
    side: row.side,
    regime: row.regime,
    cell: row.cell,
    signalTime: row.signalTime,
    decisionTime: row.decisionTime,
    theoreticalDecisionTime: row.theoreticalDecisionTime,
    entryTime: row.label.entryTime,
    entryPrice: row.label.entryPrice,
    executablePrice: row.label.entryPrice,
    exitTime: row.label.exitTime,
    exitPrice: row.label.exitPrice,
    exitReason: row.label.exitReason,
    stopPrice: row.label.stopPrice,
    quantity: size.quantity,
    notional: size.notional,
    lossAtStop: size.lossAtStop,
    cluster: `${row.regime}:${row.signalTime}`,
    grossPriceReturnBps: row.label.grossPriceReturnBps,
    expectedPriceEdgeBps: row.edge.expectedPriceEdgeBps,
    standardErrorBps: row.edge.standardErrorBps,
    standardErrorOfMeanBps: row.edge.standardErrorOfMeanBps,
    monthlyClusteredStandardErrorBps: row.edge.monthlyClusteredStandardErrorBps,
    edgeSource: row.edge.edgeSource,
    edgeModelId: row.edge.edgeModelId,
    edgeSampleSize: row.edge.sampleSize,
    trainingQ75: row.edge.trainingQ75,
    foldId: row.foldId,
    validationWindow: row.edge.validationWindow,
    expectedFundingBps: row.expectedFunding.expectedFundingBps,
    realizedFundingBps,
    realizedFunding: row.label.realizedFunding,
    costs: {
      baseTotalBps: HISTORICAL_BASE_COST_BPS,
      stressTotalBps: HISTORICAL_STRESS_COST_BPS,
      fundingPnlBps: realizedFundingBps
    },
    netReturnBps,
    stressNetReturnBps,
    netPnl: size.notional * netReturnBps / 10_000,
    stressNetPnl: size.notional * stressNetReturnBps / 10_000,
    maeBps: Math.min(...row.label.marks.map(mark => mark.returnBps)),
    mfeBps: Math.max(...row.label.marks.map(mark => mark.returnBps)),
    markToMarketDrawdownBps: markDrawdown(row.label.marks),
    marks: row.label.marks,
    edgeGate: baseGate,
    stressEdgeGate: stressGate,
    portfolioGate: portfolio,
    paperOnly: true,
    liveOrdersEnabled: false,
    accountApi: false,
    orderApi: false
  };
}

function admitAdvisories(rows) {
  const admitted = [];
  const diagnostics = [];
  for (const row of [...rows].sort((left, right) => left.decisionTime - right.decisionTime || left.symbol.localeCompare(right.symbol))) {
    const reasons = [];
    const size = row.edge.available ? positionSize(row) : null;
    if (!size) reasons.push('SIZE_UNAVAILABLE');
    if (!row.expectedFunding.usable) reasons.push('MISSING_OR_INVALID_FUNDING_SCHEDULE');
    const expectedFundingBps = row.expectedFunding.expectedFundingBps ?? 0;
    const fundingStressBps = Math.abs(expectedFundingBps) + FUNDING_STRESS_BUFFER_BPS;
    const baseGate = evaluateHyExp0025NetEdge(row.edge, expectedFundingBps, fundingStressBps, {
      executionCostBps: HISTORICAL_BASE_COST_BPS,
      confidenceZ: HY_EXP_0025_CONFIDENCE_Z,
      minimumConservativeNetBps: HY_EXP_0025_MINIMUM_CONSERVATIVE_NET_BPS,
      minimumGrossToCostRatio: HY_EXP_0025_MINIMUM_GROSS_TO_COST_RATIO
    });
    const stressGate = evaluateHyExp0025NetEdge(row.edge, expectedFundingBps, fundingStressBps, {
      executionCostBps: HISTORICAL_BASE_COST_BPS,
      stressMultiplier: 1.5,
      confidenceZ: HY_EXP_0025_CONFIDENCE_Z,
      minimumConservativeNetBps: HY_EXP_0025_MINIMUM_CONSERVATIVE_NET_BPS,
      minimumGrossToCostRatio: HY_EXP_0025_MINIMUM_GROSS_TO_COST_RATIO
    });
    if (baseGate.decision !== 'TRADE') reasons.push(...baseGate.reasons);
    let portfolio = null;
    if (!reasons.length) {
      portfolio = portfolioGate(row, size, admitted);
      if (portfolio.decision !== 'PORTFOLIO_ALLOWED') reasons.push(...portfolio.reasons.map(reason => `PORTFOLIO_${reason}`));
    }
    if (!reasons.length) {
      const trade = buildTrade(row, size, baseGate, stressGate, portfolio);
      admitted.push(trade);
      diagnostics.push({
        id: row.id,
        status: 'ADVISORY',
        reasons: [],
        edge: row.edge,
        baseGate,
        stressGate,
        portfolio
      });
    } else {
      diagnostics.push({
        id: row.id,
        status: 'NO_SIGNAL',
        reasons: [...new Set(reasons)],
        edge: row.edge,
        baseGate,
        stressGate,
        portfolio
      });
    }
  }
  return { admitted, diagnostics };
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

function contributionAt(trade, time) {
  if (time < trade.entryTime) return 0;
  if (time >= trade.exitTime) return trade.netPnl;
  let mark = { returnBps: 0 };
  for (const candidate of trade.marks) {
    if (candidate.time > time) break;
    mark = candidate;
  }
  const funding = trade.realizedFunding.details
    .filter(row => row.fundingTime <= time)
    .reduce((sum, row) => sum + row.payment / trade.entryPrice * trade.notional, 0);
  return trade.notional * mark.returnBps / 10_000 - trade.notional * 9 / 10_000 + funding;
}

function markToMarketMetrics(trades) {
  const times = new Set([DEVELOPMENT_START, DEVELOPMENT_END - 1]);
  for (const trade of trades) {
    times.add(trade.entryTime);
    times.add(trade.exitTime);
    for (const mark of trade.marks) times.add(mark.time);
    for (const funding of trade.realizedFunding.details) times.add(funding.fundingTime);
  }
  const curve = [...times].sort((left, right) => left - right).map(time => ({
    time,
    equity: RESEARCH_EQUITY_USDT + trades.reduce((sum, trade) => sum + contributionAt(trade, time), 0)
  }));
  let peak = RESEARCH_EQUITY_USDT;
  let maxDrawdown = 0;
  for (const row of curve) {
    peak = Math.max(peak, row.equity);
    maxDrawdown = Math.max(maxDrawdown, 1 - row.equity / peak);
  }
  const daily = new Map();
  for (const row of curve) daily.set(dayKey(row.time), row.equity);
  const dailyEquity = [...daily.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, equity]) => equity);
  const dailyReturns = dailyEquity.slice(1).map((equity, index) => equity / dailyEquity[index] - 1).sort((left, right) => left - right);
  const tailCount = dailyReturns.length ? Math.max(1, Math.ceil(dailyReturns.length * 0.05)) : 0;
  const cvarLoss = tailCount ? -mean(dailyReturns.slice(0, tailCount)) : null;
  return {
    maxMtmDrawdown: maxDrawdown,
    maxMtmDrawdownBps: maxDrawdown * 10_000,
    cvar95LossFraction: cvarLoss,
    cvar95LossBps: cvarLoss == null ? null : cvarLoss * 10_000,
    curvePoints: curve.length,
    dailyObservations: dailyReturns.length
  };
}

function summarizeCandidateOutcomes(rows) {
  const gross = rows.map(row => row.label.grossPriceReturnBps);
  const net18 = rows.map(row => row.label.grossPriceReturnBps - HISTORICAL_BASE_COST_BPS + row.label.realizedFunding.fundingPnlBps);
  const net27 = rows.map(row => row.label.grossPriceReturnBps - HISTORICAL_STRESS_COST_BPS + row.label.realizedFunding.fundingPnlBps);
  const positive = net18.filter(value => value > 0).reduce((sum, value) => sum + value, 0);
  const negative = net18.filter(value => value < 0).reduce((sum, value) => sum + value, 0);
  return {
    sampleCount: rows.length,
    grossExpectancyBps: mean(gross),
    netExpectancy18Bps: mean(net18),
    netExpectancy27Bps: mean(net27),
    profitFactor18: negative < 0 ? positive / Math.abs(negative) : positive > 0 ? Infinity : null,
    positiveRate18: rows.length ? net18.filter(value => value > 0).length / rows.length : null,
    distinctSymbols: [...new Set(rows.map(row => row.symbol))].sort(),
    distinctMonths: [...new Set(rows.map(row => monthKey(row.signalTime)))].sort()
  };
}

function summarizeDevelopment({ primaryRows, predictions, trades, diagnostics, foldReports }) {
  const ordered = [...trades].sort((left, right) => left.exitTime - right.exitTime || left.symbol.localeCompare(right.symbol));
  const months = monthKeys(DEVELOPMENT_START, DEVELOPMENT_END);
  const monthlyNetPnl = Object.fromEntries(months.map(month => [month, 0]));
  const monthlyStressPnl = Object.fromEntries(months.map(month => [month, 0]));
  for (const trade of ordered) {
    const month = monthKey(trade.exitTime);
    if (month in monthlyNetPnl) {
      monthlyNetPnl[month] += trade.netPnl;
      monthlyStressPnl[month] += trade.stressNetPnl;
    }
  }
  const netReturns = ordered.map(row => row.netReturnBps);
  const stressReturns = ordered.map(row => row.stressNetReturnBps);
  const positive = ordered.filter(row => row.netPnl > 0).reduce((sum, row) => sum + row.netPnl, 0);
  const negative = ordered.filter(row => row.netPnl < 0).reduce((sum, row) => sum + row.netPnl, 0);
  const stressPositive = ordered.filter(row => row.stressNetPnl > 0).reduce((sum, row) => sum + row.stressNetPnl, 0);
  const stressNegative = ordered.filter(row => row.stressNetPnl < 0).reduce((sum, row) => sum + row.stressNetPnl, 0);
  const reasonCounts = {};
  for (const item of diagnostics) {
    for (const reason of item.reasons ?? []) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
  }
  const risk = ordered.length
    ? { ...markToMarketMetrics(ordered), riskMetricStatus: 'EVALUABLE' }
    : {
      maxMtmDrawdown: null,
      maxMtmDrawdownBps: null,
      cvar95LossFraction: null,
      cvar95LossBps: null,
      curvePoints: 0,
      dailyObservations: 0,
      riskMetricStatus: 'EMPTY_SAMPLE_NOT_EVALUABLE'
    };
  const bySymbol = Object.fromEntries(HY_EXP_0025_SYMBOLS.map(symbol => [symbol, ordered.filter(row => row.symbol === symbol).length]));
  const distinctSymbols = Object.values(bySymbol).filter(value => value > 0).length;
  const distinctCalendarMonths = [...new Set(ordered.map(row => monthKey(row.exitTime)))].sort();
  const largestSingleSymbolShare = ordered.length ? Math.max(...Object.values(bySymbol)) / ordered.length : null;
  const fullDevelopmentDays = (DEVELOPMENT_END - DEVELOPMENT_START) / (24 * HOUR);
  const gates = {
    advisoryCountAtLeast60: ordered.length >= 60,
    usableAdvisoriesPer30CalendarDaysAtLeast6: ordered.length * 30 / fullDevelopmentDays >= 6,
    netExpectancy18BpsGreaterThan10: mean(netReturns) != null && mean(netReturns) > 10,
    netProfitFactor18GreaterThan1_20: negative < 0 && positive / Math.abs(negative) > 1.2,
    stressNetExpectancy27BpsGreaterThan0: mean(stressReturns) != null && mean(stressReturns) > 0,
    positiveMonthShareAtLeast0_55: months.length > 0 && months.filter(month => monthlyNetPnl[month] > 0).length / months.length >= 0.55,
    distinctCalendarMonthsAtLeast6: distinctCalendarMonths.length >= 6,
    distinctSymbolsAtLeast5: distinctSymbols >= 5,
    maximumSingleSymbolShareAtMost0_40: largestSingleSymbolShare != null && largestSingleSymbolShare <= 0.4,
    maxMtmDrawdownAtMost15Percent: risk.maxMtmDrawdown != null && risk.maxMtmDrawdown <= 0.15
  };
  return {
    rawCandidateCount: primaryRows.length,
    labeledCandidateCount: primaryRows.length,
    oofPredictionCount: predictions.length,
    edgeAvailableCount: predictions.filter(row => row.edge.available).length,
    advisoryCount: ordered.length,
    usableAdvisoriesPer30CalendarDays: ordered.length * 30 / fullDevelopmentDays,
    grossExpectancyBps: predictions.length ? mean(predictions.map(row => row.label.grossPriceReturnBps)) : null,
    netExpectancy18Bps: mean(netReturns),
    netProfitFactor18: negative < 0 ? positive / Math.abs(negative) : positive > 0 ? Infinity : null,
    stressNetExpectancy27Bps: mean(stressReturns),
    stressProfitFactor27: stressNegative < 0 ? stressPositive / Math.abs(stressNegative) : stressPositive > 0 ? Infinity : null,
    netReturn: ordered.reduce((sum, row) => sum + row.netPnl, 0) / RESEARCH_EQUITY_USDT,
    netReturnBps: ordered.reduce((sum, row) => sum + row.netPnl, 0) / RESEARCH_EQUITY_USDT * 10_000,
    positiveMonths: months.filter(month => monthlyNetPnl[month] > 0).length,
    observedMonths: months.length,
    positiveMonthShare: months.length ? months.filter(month => monthlyNetPnl[month] > 0).length / months.length : null,
    monthlyNetPnl,
    monthlyStressPnl,
    distinctCalendarMonths,
    distinctSymbols,
    symbols: Object.entries(bySymbol).filter(([, count]) => count > 0).map(([symbol]) => symbol).sort(),
    bySymbol,
    largestSingleSymbolShare,
    maxLossStreak: lossStreak(ordered),
    risk,
    fundingPnl: ordered.reduce((sum, row) => sum + row.realizedFunding.fundingPnlPerUnit * row.notional / row.entryPrice, 0),
    rejectionReasons: reasonCounts,
    foldReports,
    fastGates: { checks: gates, pass: Object.values(gates).every(Boolean) },
    paperOnly: true,
    signalOnly: true,
    liveOrdersEnabled: false,
    accountApi: false,
    orderApi: false
  };
}

function lossStreak(trades) {
  let current = 0;
  let maximum = 0;
  for (const trade of trades) {
    current = trade.netPnl < 0 ? current + 1 : 0;
    maximum = Math.max(maximum, current);
  }
  return maximum;
}

function validatePreregistration(root = ROOT) {
  const buffer = fs.readFileSync(path.join(root, 'registry', 'experiments', HY_EXP_0025_EXPERIMENT_ID, 'preregistration.json'));
  const preregistration = JSON.parse(buffer);
  if (sha256(buffer) !== HY_EXP_0025_PREREGISTRATION_SHA256) throw new Error('HY-EXP-0025 preregistration hash mismatch');
  if (preregistration.status !== 'PREREGISTERED' || preregistration.experimentId !== HY_EXP_0025_EXPERIMENT_ID) {
    throw new Error('HY-EXP-0025 is not formally preregistered');
  }
  if (preregistration.authorization !== 'PAPER_ONLY'
    || preregistration.signalOnly !== true
    || preregistration.liveOrdersEnabled !== false
    || preregistration.accountApi !== false
    || preregistration.orderApi !== false
    || preregistration.oosRead !== false) {
    throw new Error('HY-EXP-0025 safety flags are not frozen');
  }
  if (preregistration.primaryHypothesis.direction !== HY_EXP_0025_PRIMARY_CELL
    || preregistration.primaryHypothesis.bearSellAllowed !== false
    || preregistration.primaryHypothesis.ridgeAllowed !== false) {
    throw new Error('HY-EXP-0025 primary direction drifted');
  }
  return { preregistration, preregistrationSha256: sha256(buffer) };
}

export function runHyExp0025Development({ root = ROOT, dataset = loadHyExp0024Dataset({ root }) } = {}) {
  const { preregistration, preregistrationSha256 } = validatePreregistration(root);
  const source = validPrimaryRows(dataset);
  dataset.bars5mBySymbol = {};
  dataset.bars1hBySymbol = {};
  dataset.bars4hBySymbol = {};
  dataset.sourceManifest = null;
  const { predictions, foldReports } = buildFoldPredictions(source.primaryRows);
  const { admitted, diagnostics } = admitAdvisories(predictions);
  const metrics = summarizeDevelopment({
    primaryRows: source.primaryRows,
    predictions,
    trades: admitted,
    diagnostics,
    foldReports
  });
  const secondaryDiagnostics = [
    ['BULL/BUY x sideAdjustedSMA60MinusSMA180OverATR20 Q1', row => row.secondaryDiagnostics?.sma60MinusSma180Q1],
    ['BULL/BUY x sideAdjustedBreakoutDistanceOverATR20 Q4', row => row.secondaryDiagnostics?.breakoutDistanceQ4]
  ].map(([name, predicate]) => {
    const rows = predictions.filter(predicate);
    return {
      name,
      selectedForPrimary: false,
      usedInGates: false,
      performance: summarizeCandidateOutcomes(rows)
    };
  });
  return {
    experimentId: HY_EXP_0025_EXPERIMENT_ID,
    baseCommit: 'e43924784fd604a9f731897ce1abf342ec6d57b1',
    status: metrics.fastGates.pass ? 'EXPERIMENTAL_SIGNAL_ONLY_REVIEW_REQUIRED' : 'EXPERIMENTAL_RELEASE_BLOCKED',
    evidenceClass: 'D0_DEVELOPMENT_ONLY',
    authorization: 'PAPER_ONLY',
    signalOnly: true,
    paperOnly: true,
    liveOrdersEnabled: false,
    accountApi: false,
    orderApi: false,
    developmentPnlComputed: true,
    finalOosPnlComputed: false,
    finalOosRead: false,
    experimentalReleaseReady: metrics.fastGates.pass,
    deploymentPrepared: false,
    noParameterRescue: true,
    noSecondarySelection: true,
    preregistrationSha256,
    development: {
      start: new Date(DEVELOPMENT_START).toISOString(),
      endExclusive: new Date(DEVELOPMENT_END).toISOString(),
      sourceExperimentId: dataset.sourceExperimentId,
      sourceManifestSha256: dataset.sourceManifestSha256,
      candidateRule: 'BULL/BUY/TREND_BREAKOUT with training-only ChannelDistance Q75; no Bear/SELL and no secondary filter selection',
      metrics,
      foldReports,
      secondaryDiagnostics,
      finalOosRead: false,
      finalOosStatus: 'SEALED_NOT_READ',
      developmentSourceRule: preregistration.development.source.sourceRule
    },
    model: {
      modelId: HY_EXP_0025_EDGE_MODEL_ID,
      edgeSource: HY_EXP_0025_EDGE_SOURCE,
      type: 'EMPIRICAL_BUCKET_EDGE',
      featureName: HY_EXP_0025_CHANNEL_DISTANCE_FEATURE,
      noRidge: true,
      noMl: true,
      candidateDecisionAuthority: 'NONE',
      netEdgeModelId: 'HENGYU-NET-EDGE-001',
      costBps: { base: HISTORICAL_BASE_COST_BPS, stress: HISTORICAL_STRESS_COST_BPS },
      confidenceZ: HY_EXP_0025_CONFIDENCE_Z
    },
    trades: admitted,
    diagnostics,
    oos: {
      read: false,
      computed: false,
      status: 'SEALED',
      reason: 'HY-EXP-0025 Development is limited to already-consumed Development information; Final OOS was not read.'
    },
    livePath: {
      implemented: false,
      allowedOnlyIfDevelopmentPass: true,
      deployed: false
    },
    blockers: metrics.fastGates.pass
      ? ['Experimental signal-only release requires review; no deployment performed.']
      : ['Development gates failed; do not implement or deploy the live experimental path.']
  };
}

export { FOLDS };
