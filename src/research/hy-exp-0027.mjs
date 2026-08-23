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
  HY_EXP_0027_MINIMUM_TRAINING_ROWS,
  HY_EXP_0027_RULE_EDGE_MODEL_ID,
  HY_EXP_0027_RULE_EDGE_SOURCE,
  HY_EXP_0027_RULES,
  fitRuleDiagnostic,
  predictRuleDiagnostic,
  trainingQ75
} from '../model/hy-exp-0027-rules.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const HY_EXP_0027_EXPERIMENT_ID = 'HY-EXP-0027';
export const HY_EXP_0027_PRIMARY_CELL = 'BULL/BUY/TREND_BREAKOUT';
export const HY_EXP_0027_PREREGISTRATION_SHA256 = 'a09b7c47b4dcd17f4e11cba202cf980ece68c3b9b54594b168407e68e706b3d0';
export const HY_EXP_0027_SYMBOLS = Object.freeze([
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT',
  'XRPUSDT', 'DOGEUSDT', 'LINKUSDT', 'LTCUSDT'
]);
export const HY_EXP_0027_OOF_EXPOSURE_START = Date.parse('2025-01-01T00:00:00.000Z');
export const HY_EXP_0027_OOF_EXPOSURE_END = Date.parse('2026-07-01T00:00:00.000Z');
const DAY = 24 * HOUR;

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

function exposureMonths(start, endExclusive) {
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

function percentile(values, probability) {
  const ordered = [...values].sort((left, right) => left - right);
  if (!ordered.length) return null;
  const position = (ordered.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return ordered[lower];
  return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower);
}

function validPrimaryRows(dataset) {
  const source = buildHyExp0024CandidateRows({ dataset });
  const primaryRows = source.candidates.filter(row => row.cell === HY_EXP_0027_PRIMARY_CELL
    && row.signalTime >= DEVELOPMENT_START
    && row.signalTime < DEVELOPMENT_END
    && row.label?.labelEndTime < DEVELOPMENT_END
    && Array.isArray(row.features)
    && finite(row.features[0])
    && finite(row.features[7]));
  return { primaryRows, rawCandidateCount: primaryRows.length };
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
    const models = {
      A: fitRuleDiagnostic(training, 'A', { q75: trainingQ75(training, 'A'), validationWindow: validationWindow(fold) }),
      B: fitRuleDiagnostic(training, 'B', { q75: trainingQ75(training, 'B'), validationWindow: validationWindow(fold) })
    };
    const validation = foldValidationRows(primaryRows, fold);
    let ruleACount = 0;
    let ruleBCount = 0;
    let overlapCount = 0;
    for (const row of validation) {
      const ruleDiagnostics = {
        A: predictRuleDiagnostic(models.A, row, validationWindow(fold)),
        B: predictRuleDiagnostic(models.B, row, validationWindow(fold))
      };
      const matchedRules = Object.entries(ruleDiagnostics)
        .filter(([, diagnostic]) => diagnostic.available)
        .map(([rule]) => rule);
      if (!matchedRules.length) continue;
      if (matchedRules.includes('A')) ruleACount++;
      if (matchedRules.includes('B')) ruleBCount++;
      if (matchedRules.length === 2) overlapCount++;
      predictions.push({
        ...row,
        foldId: fold.id,
        matchedRule: matchedRules.join('+'),
        ruleDiagnostics
      });
    }
    foldReports.push({
      foldId: fold.id,
      validationWindow: validationWindow(fold),
      trainingCandidateCount: training.length,
      ruleA: {
        trainingQ75: models.A.trainingQ75,
        qualifyingTrainingRows: models.A.sampleSize,
        expectedPriceEdgeBps: models.A.expectedPriceEdgeBps,
        standardErrorBps: models.A.standardErrorBps,
        validationQ75Count: ruleACount,
        edgeModelId: models.A.edgeModelId
      },
      ruleB: {
        trainingQ75: models.B.trainingQ75,
        qualifyingTrainingRows: models.B.sampleSize,
        expectedPriceEdgeBps: models.B.expectedPriceEdgeBps,
        standardErrorBps: models.B.standardErrorBps,
        validationQ75Count: ruleBCount,
        edgeModelId: models.B.edgeModelId
      },
      validationCandidateCount: validation.length,
      ruleAValidationCount: ruleACount,
      ruleBValidationCount: ruleBCount,
      overlapValidationCount: overlapCount,
      dedupAdvisoryCount: ruleACount + ruleBCount - overlapCount,
      minimumTrainingRows: HY_EXP_0027_MINIMUM_TRAINING_ROWS,
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

function diagnosticEdge(row) {
  const diagnostics = Object.values(row.ruleDiagnostics).filter(value => value.available);
  return {
    edgeModelId: HY_EXP_0027_RULE_EDGE_MODEL_ID,
    edgeSource: HY_EXP_0027_RULE_EDGE_SOURCE,
    matchedRule: row.matchedRule,
    expectedPriceEdgeBps: mean(diagnostics.map(value => value.expectedPriceEdgeBps)),
    standardErrorBps: mean(diagnostics.map(value => value.standardErrorBps)),
    sampleSize: diagnostics.reduce((sum, value) => sum + value.sampleSize, 0),
    rules: row.ruleDiagnostics
  };
}

function buildAdvisory(row) {
  const size = positionSize(row);
  if (!size) throw new Error(`missing position size for ${row.id}`);
  const realizedFundingBps = row.label.realizedFunding.fundingPnlBps;
  const netReturnBps = row.label.grossPriceReturnBps - HISTORICAL_BASE_COST_BPS + realizedFundingBps;
  const stressNetReturnBps = row.label.grossPriceReturnBps - HISTORICAL_STRESS_COST_BPS + realizedFundingBps;
  const edge = diagnosticEdge(row);
  return {
    experimentId: HY_EXP_0027_EXPERIMENT_ID,
    phase: 'development',
    status: 'PAPER_VALIDATION_ADVISORY',
    id: row.id,
    symbol: row.symbol,
    side: row.side,
    regime: row.regime,
    cell: row.cell,
    matchedRule: row.matchedRule,
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
    expectedPriceEdgeBps: edge.expectedPriceEdgeBps,
    standardErrorBps: edge.standardErrorBps,
    edgeSource: edge.edgeSource,
    edgeModelId: edge.edgeModelId,
    edgeSampleSize: edge.sampleSize,
    ruleDiagnostics: row.ruleDiagnostics,
    trainingQ75: {
      A: row.ruleDiagnostics.A.trainingQ75,
      B: row.ruleDiagnostics.B.trainingQ75
    },
    foldId: row.foldId,
    validationWindow: row.ruleDiagnostics.A.validationWindow,
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

function summarizeDevelopment({ primaryRows, predictions, advisories, diagnostics, foldReports, ruleCounts }) {
  const ordered = [...advisories].sort((left, right) => left.exitTime - right.exitTime || left.symbol.localeCompare(right.symbol));
  const months = exposureMonths(HY_EXP_0027_OOF_EXPOSURE_START, HY_EXP_0027_OOF_EXPOSURE_END);
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
  const bySymbol = Object.fromEntries(HY_EXP_0027_SYMBOLS.map(symbol => [symbol, ordered.filter(row => row.symbol === symbol).length]));
  const distinctSymbols = Object.values(bySymbol).filter(value => value > 0).length;
  const largestSingleSymbolShare = ordered.length ? Math.max(...Object.values(bySymbol)) / ordered.length : null;
  const exposureDays = (HY_EXP_0027_OOF_EXPOSURE_END - HY_EXP_0027_OOF_EXPOSURE_START) / DAY;
  const netPnl = ordered.reduce((sum, row) => sum + row.netPnl, 0);
  const netPnlWithoutBestMonth = bestPositiveMonth == null ? netPnl : netPnl - bestPositiveMonthPnl;
  const gates = {
    advisoryCountAtLeast100: ordered.length >= 100,
    usableAdvisoriesPer30CalendarDaysAtLeast6: ordered.length * 30 / exposureDays >= 6,
    netExpectancy18BpsGreaterThan10: mean(netReturns) != null && mean(netReturns) > 10,
    netProfitFactor18GreaterThan1_20: profitFactor(ordered, 'netPnl') != null && profitFactor(ordered, 'netPnl') > 1.2,
    stressNetExpectancy27BpsGreaterThan0: mean(stressReturns) != null && mean(stressReturns) > 0,
    stressProfitFactor27GreaterThan1_05: profitFactor(ordered, 'stressNetPnl') != null && profitFactor(ordered, 'stressNetPnl') > 1.05,
    activeMonthCountAtLeast9: activeMonths.length >= 9,
    positiveActiveMonthShareAtLeast0_40: activeMonths.length > 0 && positiveActiveMonths.length / activeMonths.length >= 0.4,
    distinctSymbolsAtLeast5: distinctSymbols >= 5,
    maximumSingleSymbolShareAtMost0_40: largestSingleSymbolShare != null && largestSingleSymbolShare <= 0.4,
    maxMtmDrawdownAtMost15Percent: risk.maxMtmDrawdown != null && risk.maxMtmDrawdown <= 0.15,
    bestMonthPositivePnlShareAtMost0_60: positiveMonthPnl > 0 && bestPositiveMonthPnl / positiveMonthPnl <= 0.6,
    netPnlWithoutBestMonthGreaterThan0: netPnlWithoutBestMonth > 0,
    nonEmptySample: ordered.length > 0
  };
  return {
    rawCandidateCount: primaryRows.length,
    labeledCandidateCount: primaryRows.length,
    ruleACount: ruleCounts.A,
    ruleBCount: ruleCounts.B,
    overlapCount: ruleCounts.overlap,
    dedupAdvisoryCount: ordered.length,
    oofPredictionCount: predictions.length,
    edgeAvailableCount: predictions.length,
    advisoryCount: ordered.length,
    oofExposureStart: new Date(HY_EXP_0027_OOF_EXPOSURE_START).toISOString(),
    oofExposureEndExclusive: new Date(HY_EXP_0027_OOF_EXPOSURE_END).toISOString(),
    oofExposureDays: exposureDays,
    usableAdvisoriesPer30CalendarDays: ordered.length * 30 / exposureDays,
    grossExpectancyBps: mean(predictions.map(row => row.label.grossPriceReturnBps)),
    netExpectancy18Bps: mean(netReturns),
    netProfitFactor18: profitFactor(ordered, 'netPnl'),
    stressNetExpectancy27Bps: mean(stressReturns),
    stressProfitFactor27: profitFactor(ordered, 'stressNetPnl'),
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
    totalPositiveMonthPnl: positiveMonthPnl,
    bestMonthPositivePnlShare: positiveMonthPnl > 0 ? bestPositiveMonthPnl / positiveMonthPnl : null,
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
    foldReports,
    fastGates: { checks: gates, pass: Object.values(gates).every(Boolean) },
    uncertaintyVetoApplied: false,
    conservativePredictionVetoApplied: false,
    paperOnly: true,
    signalOnly: true,
    liveOrdersEnabled: false,
    accountApi: false,
    orderApi: false,
    diagnosticsCount: diagnostics.length
  };
}

function validatePreregistration(root = ROOT) {
  const file = path.join(root, 'registry', 'experiments', HY_EXP_0027_EXPERIMENT_ID, 'preregistration.json');
  const buffer = fs.readFileSync(file);
  const preregistration = JSON.parse(buffer);
  if (sha256(buffer) !== HY_EXP_0027_PREREGISTRATION_SHA256) throw new Error('HY-EXP-0027 preregistration hash mismatch');
  if (preregistration.status !== 'PREREGISTERED' || preregistration.experimentId !== HY_EXP_0027_EXPERIMENT_ID) {
    throw new Error('HY-EXP-0027 is not formally preregistered');
  }
  if (preregistration.authorization !== 'PAPER_ONLY'
    || preregistration.signalOnly !== true
    || preregistration.liveOrdersEnabled !== false
    || preregistration.accountApi !== false
    || preregistration.orderApi !== false
    || preregistration.oosRead !== false
    || preregistration.rules.advisory.perSignalStandardErrorVeto !== false
    || preregistration.rules.advisory.perSignalConservativePredictionVeto !== false) {
    throw new Error('HY-EXP-0027 safety or rule semantics drifted');
  }
  return { preregistration, preregistrationSha256: sha256(buffer) };
}

export function runHyExp0027Development({ root = ROOT, dataset = loadHyExp0024Dataset({ root }) } = {}) {
  const { preregistration, preregistrationSha256 } = validatePreregistration(root);
  const source = validPrimaryRows(dataset);
  dataset.bars5mBySymbol = {};
  dataset.bars1hBySymbol = {};
  dataset.bars4hBySymbol = {};
  dataset.sourceManifest = null;
  const { predictions, foldReports } = buildFoldPredictions(source.primaryRows);
  const unique = new Map();
  for (const row of predictions) {
    if (unique.has(row.id)) throw new Error(`duplicate HY-EXP-0027 advisory key: ${row.id}`);
    unique.set(row.id, row);
  }
  const deduplicatedRows = [...unique.values()];
  const ruleCounts = {
    A: predictions.filter(row => row.matchedRule === 'A' || row.matchedRule === 'A+B').length,
    B: predictions.filter(row => row.matchedRule === 'B' || row.matchedRule === 'A+B').length,
    overlap: predictions.filter(row => row.matchedRule === 'A+B').length
  };
  const advisories = deduplicatedRows.map(buildAdvisory);
  const diagnostics = advisories.map(advisory => ({
    id: advisory.id,
    status: 'ADVISORY',
    matchedRule: advisory.matchedRule,
    reasons: [],
    ruleDiagnostics: advisory.ruleDiagnostics,
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
    predictions: deduplicatedRows,
    advisories,
    diagnostics,
    foldReports,
    ruleCounts
  });
  return {
    experimentId: HY_EXP_0027_EXPERIMENT_ID,
    baseCommit: '3ef163255633240037de59341975d252cb32e3af',
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
      candidateRule: 'BULL/BUY/TREND_BREAKOUT with fold-local training Q75 Rule A OR Rule B; dedup by symbol/decisionTime; no Bear/SELL or search',
      metrics,
      foldReports,
      finalOosRead: false,
      finalOosStatus: 'SEALED_NOT_READ',
      developmentSourceRule: preregistration.development.source.sourceRule,
      frequencyExposureWindow: preregistration.development.frequencyExposureWindow
    },
    model: {
      modelId: HY_EXP_0027_RULE_EDGE_MODEL_ID,
      edgeSource: HY_EXP_0027_RULE_EDGE_SOURCE,
      type: 'RULE_BASED_OR_ADVISORY_WITH_RULE_EDGE_DIAGNOSTICS',
      rules: {
        A: preregistration.rules.A,
        B: preregistration.rules.B
      },
      noRidge: true,
      noMl: true,
      parameterSearch: false,
      deduplicationKey: 'symbol+decisionTime',
      perSignalStandardErrorVeto: false,
      perSignalConservativePredictionVeto: false,
      historicalCostModel: { baseBps: HISTORICAL_BASE_COST_BPS, stressBps: HISTORICAL_STRESS_COST_BPS },
      executionSemantics: 'EXACT_5M_ENTRY_2ATR_STOP_PRIOR60_CHANNEL_MAX_HOLD_6_1H_BARS'
    },
    trades: advisories,
    diagnostics,
    oos: {
      read: false,
      computed: false,
      status: 'SEALED',
      reason: 'HY-EXP-0027 Development used only already-consumed Development information; Final OOS was not read.'
    },
    livePath: {
      implemented: false,
      allowedOnlyIfDevelopmentPass: true,
      deployed: false,
      reason: metrics.fastGates.pass ? 'requires post-validation live signal preparation' : 'Development gates failed; no live path prepared'
    },
    blockers: metrics.fastGates.pass
      ? ['Experimental signal-only release requires separate human deployment approval; no deployment performed.']
      : ['HY-EXP-0027 Development gates failed; do not rescue, deploy, or read Final OOS.']
  };
}

export { FOLDS };
