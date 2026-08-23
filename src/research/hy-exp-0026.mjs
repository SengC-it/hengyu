import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  buildHyExp0024CandidateRows,
  DEVELOPMENT_END,
  DEVELOPMENT_START,
  FOLDS,
  HOUR,
  HISTORICAL_BASE_COST_BPS,
  HISTORICAL_STRESS_COST_BPS,
  loadHyExp0024Dataset,
  RESEARCH_EQUITY_USDT,
  PURGE_BARS,
  EMBARGO_BARS
} from './hy-exp-0024.mjs';
import {
  HY_EXP_0026_CHANNEL_DISTANCE_FEATURE,
  HY_EXP_0026_EDGE_MODEL_ID,
  HY_EXP_0026_EDGE_SOURCE,
  fitHyExp0026EdgeDiagnostics,
  predictHyExp0026EdgeDiagnostics,
  trainingQ75
} from '../model/hy-exp-0026-rule.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const HY_EXP_0026_EXPERIMENT_ID = 'HY-EXP-0026';
export const HY_EXP_0026_PRIMARY_CELL = 'BULL/BUY/TREND_BREAKOUT';
export const HY_EXP_0026_PREREGISTRATION_SHA256 = '4b2f94db67b51ddd3cf1734371643f25ea4f2ba1212425abfdf97fc50e59a46f';
export const HY_EXP_0026_SYMBOLS = Object.freeze([
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

function sampleStandardDeviation(values) {
  if (values.length < 2) return null;
  const center = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1));
}

function validPrimaryRows(dataset) {
  const source = buildHyExp0024CandidateRows({ dataset });
  const primaryRows = source.candidates.filter(row => row.cell === HY_EXP_0026_PRIMARY_CELL
    && row.signalTime >= DEVELOPMENT_START
    && row.signalTime < DEVELOPMENT_END
    && row.label?.labelEndTime < DEVELOPMENT_END
    && Array.isArray(row.features)
    && finite(row.features[7]));
  return {
    primaryRows,
    rawCandidateCount: primaryRows.length
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

function percentile(values, probability) {
  const ordered = [...values].sort((left, right) => left - right);
  if (!ordered.length) return null;
  const position = (ordered.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return ordered[lower];
  return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower);
}

function buildFoldPredictions(primaryRows) {
  const predictions = [];
  const foldReports = [];
  for (const fold of FOLDS) {
    const training = foldTrainingRows(primaryRows, fold);
    const q75 = trainingQ75(training);
    const model = fitHyExp0026EdgeDiagnostics(training, {
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
      const edge = predictHyExp0026EdgeDiagnostics(model, row, validationWindow(fold));
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
      expectedPriceEdgeBps: model.expectedPriceEdgeBps,
      standardErrorBps: model.standardErrorBps,
      standardErrorOfMeanBps: model.standardErrorOfMeanBps,
      monthlyClusteredStandardErrorBps: model.monthlyClusteredStandardErrorBps,
      validationCandidateCount: validation.length,
      validationQ75CandidateCount: qualifyingValidation.length,
      advisoryValidationCount: predictions.filter(row => row.foldId === fold.id && row.edge.available).length,
      trainingSma60MinusSma180Q25: trainingSmaQ25,
      trainingBreakoutDistanceQ75: trainingBreakoutQ75,
      edgeModelId: model.edgeModelId,
      edgeSource: model.edgeSource,
      minimumTrainingSamples: model.minimumSamples,
      uncertaintyUsedAsVeto: false
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

function markDrawdown(marks) {
  let peak = -Infinity;
  let drawdown = 0;
  for (const mark of marks) {
    peak = Math.max(peak, mark.returnBps);
    drawdown = Math.max(drawdown, peak - mark.returnBps);
  }
  return drawdown;
}

function buildAdvisory(row) {
  const size = positionSize(row);
  if (!size) throw new Error(`missing position size for ${row.id}`);
  const realizedFundingBps = row.label.realizedFunding.fundingPnlBps;
  const netReturnBps = row.label.grossPriceReturnBps - HISTORICAL_BASE_COST_BPS + realizedFundingBps;
  const stressNetReturnBps = row.label.grossPriceReturnBps - HISTORICAL_STRESS_COST_BPS + realizedFundingBps;
  return {
    experimentId: HY_EXP_0026_EXPERIMENT_ID,
    phase: 'development',
    status: 'PAPER_VALIDATION_ADVISORY',
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
    grossPriceReturnBps: row.label.grossPriceReturnBps,
    expectedPriceEdgeBps: row.edge.expectedPriceEdgeBps,
    standardErrorBps: row.edge.standardErrorBps,
    standardErrorOfMeanBps: row.edge.standardErrorOfMeanBps,
    monthlyClusteredStandardErrorBps: row.edge.monthlyClusteredStandardErrorBps,
    edgeSource: HY_EXP_0026_EDGE_SOURCE,
    edgeModelId: HY_EXP_0026_EDGE_MODEL_ID,
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
    ruleEligibility: {
      bull: true,
      buy: true,
      breakout: true,
      trainingQ75: true,
      uncertaintyVetoApplied: false,
      conservativeNetEdgeVetoApplied: false
    },
    paperOnly: true,
    signalOnly: true,
    liveOrdersEnabled: false,
    accountApi: false,
    orderApi: false
  };
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
  const times = new Set([DEVELOPMENT_START, DEVELOPMENT_END - 1]);
  for (const advisory of advisories) {
    times.add(advisory.entryTime);
    times.add(advisory.exitTime);
    for (const mark of advisory.marks) times.add(mark.time);
    for (const funding of advisory.realizedFunding.events) times.add(funding.fundingTime);
  }
  const curve = [...times].sort((left, right) => left - right).map(time => ({
    time,
    equity: RESEARCH_EQUITY_USDT + advisories.reduce((sum, advisory) => sum + contributionAt(advisory, time), 0)
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
    dailyObservations: dailyReturns.length,
    riskMetricStatus: 'EVALUABLE'
  };
}

function lossStreak(advisories) {
  let current = 0;
  let maximum = 0;
  for (const advisory of advisories) {
    current = advisory.netPnl < 0 ? current + 1 : 0;
    maximum = Math.max(maximum, current);
  }
  return maximum;
}

function profitFactor(advisories, field) {
  const positive = advisories.filter(row => row[field] > 0).reduce((sum, row) => sum + row[field], 0);
  const negative = advisories.filter(row => row[field] < 0).reduce((sum, row) => sum + row[field], 0);
  return negative < 0 ? positive / Math.abs(negative) : positive > 0 ? Infinity : null;
}

function summarizeDevelopment({ primaryRows, predictions, advisories, diagnostics, foldReports }) {
  const ordered = [...advisories].sort((left, right) => left.exitTime - right.exitTime || left.symbol.localeCompare(right.symbol));
  const months = monthKeys(DEVELOPMENT_START, DEVELOPMENT_END);
  const monthlyNetPnl = Object.fromEntries(months.map(month => [month, 0]));
  const monthlyStressPnl = Object.fromEntries(months.map(month => [month, 0]));
  for (const advisory of ordered) {
    const month = monthKey(advisory.exitTime);
    if (month in monthlyNetPnl) {
      monthlyNetPnl[month] += advisory.netPnl;
      monthlyStressPnl[month] += advisory.stressNetPnl;
    }
  }
  const risk = ordered.length
    ? markToMarketMetrics(ordered)
    : {
      maxMtmDrawdown: null,
      maxMtmDrawdownBps: null,
      cvar95LossFraction: null,
      cvar95LossBps: null,
      curvePoints: 0,
      dailyObservations: 0,
      riskMetricStatus: 'EMPTY_SAMPLE_NOT_EVALUABLE'
    };
  const netReturns = ordered.map(row => row.netReturnBps);
  const stressReturns = ordered.map(row => row.stressNetReturnBps);
  const bySymbol = Object.fromEntries(HY_EXP_0026_SYMBOLS.map(symbol => [symbol, ordered.filter(row => row.symbol === symbol).length]));
  const distinctSymbols = Object.values(bySymbol).filter(value => value > 0).length;
  const distinctCalendarMonths = [...new Set(ordered.map(row => monthKey(row.exitTime)))].sort();
  const largestSingleSymbolShare = ordered.length ? Math.max(...Object.values(bySymbol)) / ordered.length : null;
  const fullDevelopmentDays = (DEVELOPMENT_END - DEVELOPMENT_START) / (24 * HOUR);
  const positiveMonthShare = months.length ? months.filter(month => monthlyNetPnl[month] > 0).length / months.length : null;
  const gates = {
    advisoryCountAtLeast60: ordered.length >= 60,
    usableAdvisoriesPer30CalendarDaysAtLeast6: ordered.length * 30 / fullDevelopmentDays >= 6,
    netExpectancy18BpsGreaterThan10: mean(netReturns) != null && mean(netReturns) > 10,
    netProfitFactor18GreaterThan1_20: profitFactor(ordered, 'netPnl') != null && profitFactor(ordered, 'netPnl') > 1.2,
    stressNetExpectancy27BpsGreaterThan0: mean(stressReturns) != null && mean(stressReturns) > 0,
    stressProfitFactor27GreaterThan1_05: profitFactor(ordered, 'stressNetPnl') != null && profitFactor(ordered, 'stressNetPnl') > 1.05,
    positiveMonthShareAtLeast0_55: positiveMonthShare != null && positiveMonthShare >= 0.55,
    distinctCalendarMonthsAtLeast6: distinctCalendarMonths.length >= 6,
    distinctSymbolsAtLeast5: distinctSymbols >= 5,
    maximumSingleSymbolShareAtMost0_40: largestSingleSymbolShare != null && largestSingleSymbolShare <= 0.4,
    maxMtmDrawdownAtMost15Percent: risk.maxMtmDrawdown != null && risk.maxMtmDrawdown <= 0.15,
    nonEmptySample: ordered.length > 0
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
    netProfitFactor18: profitFactor(ordered, 'netPnl'),
    stressNetExpectancy27Bps: mean(stressReturns),
    stressProfitFactor27: profitFactor(ordered, 'stressNetPnl'),
    netReturn: ordered.reduce((sum, row) => sum + row.netPnl, 0) / RESEARCH_EQUITY_USDT,
    netReturnBps: ordered.reduce((sum, row) => sum + row.netPnl, 0) / RESEARCH_EQUITY_USDT * 10_000,
    positiveMonths: months.filter(month => monthlyNetPnl[month] > 0).length,
    observedMonths: months.length,
    positiveMonthShare,
    monthlyNetPnl,
    monthlyStressPnl,
    distinctCalendarMonths,
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
    rejectionReasons: {},
    foldReports,
    fastGates: { checks: gates, pass: Object.values(gates).every(Boolean) },
    paperOnly: true,
    signalOnly: true,
    liveOrdersEnabled: false,
    accountApi: false,
    orderApi: false,
    uncertaintyVetoApplied: false,
    conservativeNetEdgeVetoApplied: false,
    diagnosticsCount: diagnostics.length
  };
}

function validatePreregistration(root = ROOT) {
  const file = path.join(root, 'registry', 'experiments', HY_EXP_0026_EXPERIMENT_ID, 'preregistration.json');
  const buffer = fs.readFileSync(file);
  const preregistration = JSON.parse(buffer);
  if (sha256(buffer) !== HY_EXP_0026_PREREGISTRATION_SHA256) throw new Error('HY-EXP-0026 preregistration hash mismatch');
  if (preregistration.status !== 'PREREGISTERED' || preregistration.experimentId !== HY_EXP_0026_EXPERIMENT_ID) {
    throw new Error('HY-EXP-0026 is not formally preregistered');
  }
  if (preregistration.authorization !== 'PAPER_ONLY'
    || preregistration.signalOnly !== true
    || preregistration.liveOrdersEnabled !== false
    || preregistration.accountApi !== false
    || preregistration.orderApi !== false
    || preregistration.oosRead !== false
    || preregistration.ruleAdvisorySemantics.perSignalUncertaintyVeto !== false
    || preregistration.ruleAdvisorySemantics.conservativeNetEdgeVeto !== false) {
    throw new Error('HY-EXP-0026 safety or rule semantics drifted');
  }
  if (preregistration.primaryHypothesis.direction !== HY_EXP_0026_PRIMARY_CELL
    || preregistration.primaryHypothesis.bearSellAllowed !== false
    || preregistration.primaryHypothesis.ridgeAllowed !== false
    || preregistration.primaryHypothesis.secondarySelectionAllowed !== false) {
    throw new Error('HY-EXP-0026 primary direction drifted');
  }
  return { preregistration, preregistrationSha256: sha256(buffer) };
}

export function runHyExp0026Development({ root = ROOT, dataset = loadHyExp0024Dataset({ root }) } = {}) {
  const { preregistration, preregistrationSha256 } = validatePreregistration(root);
  const source = validPrimaryRows(dataset);
  dataset.bars5mBySymbol = {};
  dataset.bars1hBySymbol = {};
  dataset.bars4hBySymbol = {};
  dataset.sourceManifest = null;
  const { predictions, foldReports } = buildFoldPredictions(source.primaryRows);
  const advisories = predictions.map(buildAdvisory);
  const diagnostics = advisories.map(advisory => ({
    id: advisory.id,
    status: 'ADVISORY',
    reasons: [],
    ruleEligibility: advisory.ruleEligibility,
    edge: {
      expectedPriceEdgeBps: advisory.expectedPriceEdgeBps,
      standardErrorBps: advisory.standardErrorBps,
      standardErrorOfMeanBps: advisory.standardErrorOfMeanBps,
      monthlyClusteredStandardErrorBps: advisory.monthlyClusteredStandardErrorBps,
      edgeSource: advisory.edgeSource,
      edgeModelId: advisory.edgeModelId,
      sampleSize: advisory.edgeSampleSize,
      trainingQ75: advisory.trainingQ75,
      validationWindow: advisory.validationWindow
    },
    outcome: {
      grossPriceReturnBps: advisory.grossPriceReturnBps,
      realizedFundingBps: advisory.realizedFundingBps,
      net18Bps: advisory.netReturnBps,
      net27Bps: advisory.stressNetReturnBps,
      exitReason: advisory.exitReason
    }
  }));
  const metrics = summarizeDevelopment({
    primaryRows: source.primaryRows,
    predictions,
    advisories,
    diagnostics,
    foldReports
  });
  const secondaryDiagnostics = [
    ['BULL/BUY x sideAdjustedSMA60MinusSMA180OverATR20 Q1', row => row.secondaryDiagnostics?.sma60MinusSma180Q1],
    ['BULL/BUY x sideAdjustedBreakoutDistanceOverATR20 Q4', row => row.secondaryDiagnostics?.breakoutDistanceQ4]
  ].map(([name, predicate]) => ({
    name,
    selectedForPrimary: false,
    usedInGates: false,
    count: predictions.filter(predicate).length
  }));
  return {
    experimentId: HY_EXP_0026_EXPERIMENT_ID,
    baseCommit: '5f6303c8c5303d40b8290d4ea2700a5f089ab599',
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
      candidateRule: 'BULL/BUY/TREND_BREAKOUT with training-only ChannelDistance Q75; every qualifying OOF row is a paper validation advisory; no Bear/SELL and no secondary selection',
      metrics,
      foldReports,
      secondaryDiagnostics,
      finalOosRead: false,
      finalOosStatus: 'SEALED_NOT_READ',
      developmentSourceRule: preregistration.development.source.sourceRule,
      ruleAdvisorySemantics: preregistration.ruleAdvisorySemantics
    },
    model: {
      modelId: HY_EXP_0026_EDGE_MODEL_ID,
      edgeSource: HY_EXP_0026_EDGE_SOURCE,
      type: 'RULE_BASED_ADVISORY_WITH_EMPIRICAL_EDGE_DIAGNOSTICS',
      featureName: HY_EXP_0026_CHANNEL_DISTANCE_FEATURE,
      noRidge: true,
      noMl: true,
      candidateDecisionAuthority: 'RULE_QUALIFICATION_ONLY',
      perSignalUncertaintyVeto: false,
      conservativeNetEdgeVeto: false,
      historicalCostModel: { baseBps: HISTORICAL_BASE_COST_BPS, stressBps: HISTORICAL_STRESS_COST_BPS },
      executionSemantics: 'EXACT_5M_ENTRY_2ATR_STOP_PRIOR60_CHANNEL_MAX_HOLD_6_1H_BARS'
    },
    trades: advisories,
    diagnostics,
    oos: {
      read: false,
      computed: false,
      status: 'SEALED',
      reason: 'HY-EXP-0026 Development used only already-consumed Development information; Final OOS was not read.'
    },
    livePath: {
      implemented: false,
      allowedOnlyIfDevelopmentPass: true,
      deployed: false,
      reason: metrics.fastGates.pass ? 'requires post-validation live signal preparation' : 'Development gates failed; no live path prepared'
    },
    blockers: metrics.fastGates.pass
      ? ['Experimental signal-only release requires separate human deployment approval; no deployment performed.']
      : ['HY-EXP-0026 Development gates failed; do not rescue, deploy, or read Final OOS.']
  };
}

export { FOLDS };
