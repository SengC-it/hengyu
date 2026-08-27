import { createHash } from 'node:crypto';
import {
  blockBootstrap as referenceBlockBootstrap,
  reconstructPortfolioMtm,
  simulateCandidate
} from './hy-exp-0039-email-signal.mjs';
import {
  COSTS_BPS,
  DAY,
  DEVELOPMENT_END,
  DEVELOPMENT_START,
  FEATURE_NAMES,
  FIFTEEN_MINUTES,
  FIXED_SYMBOLS,
  HOUR,
  MAX_HOLD_MS,
  MODEL_LAMBDAS,
  VALIDATION_END,
  VALIDATION_START,
  HY_EXP_0040
} from './hy-exp-0040-aggtrade.mjs';

export { FEATURE_NAMES, MODEL_LAMBDAS };

function finite(value) {
  return Number.isFinite(value);
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function sampleStd(values, average = mean(values)) {
  if (values.length < 2 || average == null) return 0;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

function quantile(values, probability) {
  if (!values.length) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return lower === upper ? sorted[lower] : sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function sigmoid(value) {
  if (value >= 0) {
    const e = Math.exp(-Math.min(40, value));
    return 1 / (1 + e);
  }
  const e = Math.exp(Math.max(-40, value));
  return e / (1 + e);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function iso(value) {
  return new Date(value).toISOString();
}

function deterministicTrainingRows(rows, maxRows = 100_000) {
  if (rows.length <= maxRows) return rows;
  const output = [];
  const step = (rows.length - 1) / (maxRows - 1);
  for (let index = 0; index < maxRows; index += 1) output.push(rows[Math.round(index * step)]);
  return output;
}

export function fitLogistic(trainingRows, lambda, { iterations = 18, maxRows = 100_000 } = {}) {
  if (!trainingRows.length) return null;
  const training = deterministicTrainingRows(trainingRows, maxRows);
  const means = Array(FEATURE_NAMES.length).fill(0);
  const stds = Array(FEATURE_NAMES.length).fill(0);
  for (const row of training) {
    if (!Array.isArray(row.features) || row.features.length !== FEATURE_NAMES.length
      || row.features.some(value => !finite(value))) return null;
    for (let index = 0; index < FEATURE_NAMES.length; index += 1) means[index] += row.features[index];
  }
  for (let index = 0; index < FEATURE_NAMES.length; index += 1) means[index] /= training.length;
  for (const row of training) {
    for (let index = 0; index < FEATURE_NAMES.length; index += 1) stds[index] += (row.features[index] - means[index]) ** 2;
  }
  for (let index = 0; index < FEATURE_NAMES.length; index += 1) stds[index] = Math.sqrt(stds[index] / Math.max(1, training.length - 1)) || 1;
  const positive = training.filter(row => row.net27Bps > 0).map(row => row.net27Bps);
  const negative = training.filter(row => row.net27Bps <= 0).map(row => row.net27Bps);
  if (!positive.length || !negative.length) return null;
  const meanPositiveNet27 = mean(positive);
  const meanNegativeNet27 = mean(negative);
  const weights = Array(FEATURE_NAMES.length).fill(0);
  let intercept = Math.log(positive.length / negative.length);
  const learningRate = 0.35 / (1 + lambda);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const gradient = Array(FEATURE_NAMES.length).fill(0);
    let interceptGradient = 0;
    for (const row of training) {
      let score = intercept;
      for (let index = 0; index < FEATURE_NAMES.length; index += 1) {
        score += weights[index] * (row.features[index] - means[index]) / stds[index];
      }
      const error = sigmoid(score) - (row.net27Bps > 0 ? 1 : 0);
      interceptGradient += error;
      for (let index = 0; index < FEATURE_NAMES.length; index += 1) {
        gradient[index] += error * (row.features[index] - means[index]) / stds[index];
      }
    }
    const scale = 1 / training.length;
    intercept -= learningRate * interceptGradient * scale;
    for (let index = 0; index < weights.length; index += 1) {
      weights[index] -= learningRate * (gradient[index] * scale + lambda * weights[index] * 0.01);
    }
  }
  return {
    name: 'REGULARIZED_LOGISTIC_EDGE_MODEL',
    lambda,
    trainingRows: trainingRows.length,
    trainingRowsUsed: training.length,
    scaler: { means, stds },
    coefficients: { intercept, weights },
    meanPositiveNet27,
    meanNegativeNet27,
    predictProbability(features) {
      if (!Array.isArray(features) || features.length !== FEATURE_NAMES.length || features.some(value => !finite(value))) {
        throw new Error('NON_FINITE_FEATURE_VECTOR');
      }
      let score = intercept;
      for (let index = 0; index < FEATURE_NAMES.length; index += 1) score += weights[index] * (features[index] - means[index]) / stds[index];
      return sigmoid(score);
    },
    predictEdge(features) {
      const probability = this.predictProbability(features);
      return {
        probabilityOfPositiveNet27: probability,
        predictedEdgeBps: probability * meanPositiveNet27 + (1 - probability) * meanNegativeNet27
      };
    }
  };
}

function lastCompleted(rows, time) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (rows[middle].closeTime < time) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

export function resolveReferenceOutcome(candidate, series) {
  const result = simulateCandidate(candidate, series);
  return {
    ...result,
    experimentId: HY_EXP_0040,
    candidateId: candidate.candidateId,
    features: candidate.features
  };
}

export function generateResolvedCandidates({ symbol, candidates, series } = {}) {
  return candidates.map(candidate => resolveReferenceOutcome(candidate, series));
}

export function compactPrediction(row, model, fold, lambda) {
  const prediction = model.predictEdge(row.features);
  return {
    candidateId: row.candidateId,
    experimentId: HY_EXP_0040,
    symbol: row.symbol,
    side: row.side,
    regime: row.regime,
    decisionTime: row.decisionTime,
    entryTime: row.entryTime,
    exitTime: row.exitTime,
    entryPrice: row.entryPrice,
    exitPrice: row.exitPrice,
    exitReason: row.exitReason,
    grossPriceBps: row.grossPriceBps,
    fundingBps: row.fundingBps,
    grossReturnBps: row.grossReturnBps,
    net18Bps: row.grossReturnBps - COSTS_BPS[18],
    net27Bps: row.grossReturnBps - COSTS_BPS[27],
    net36Bps: row.grossReturnBps - COSTS_BPS[36],
    features: row.features,
    probabilityOfPositiveNet27: prediction.probabilityOfPositiveNet27,
    predictedEdgeBps: prediction.predictedEdgeBps,
    fold,
    lambda,
    outcomeStatus: row.outcomeStatus
  };
}

export function runDevelopmentWalkForward(rows, {
  start = DEVELOPMENT_START,
  end = DEVELOPMENT_END,
  minimumTrainingDays = 180,
  validationBlockDays = 30,
  purgeHours = 24,
  embargoHours = 12
} = {}) {
  const resolved = rows.filter(row => row.outcomeStatus === 'RESOLVED'
    && row.decisionTime >= start && row.decisionTime < end)
    .sort((left, right) => left.decisionTime - right.decisionTime || left.candidateId.localeCompare(right.candidateId));
  const predictionsByLambda = Object.fromEntries(MODEL_LAMBDAS.map(lambda => [String(lambda), []]));
  const folds = [];
  let fold = 0;
  const firstValidation = start + minimumTrainingDays * DAY + (purgeHours + embargoHours) * HOUR;
  for (let validationStart = firstValidation; validationStart < end; validationStart += validationBlockDays * DAY) {
    const validationEnd = Math.min(end, validationStart + validationBlockDays * DAY);
    const trainingCutoff = validationStart - (purgeHours + embargoHours) * HOUR;
    const purgeCutoff = validationStart - purgeHours * HOUR;
    const training = resolved.filter(row => row.decisionTime < trainingCutoff && row.exitTime < purgeCutoff);
    const validation = resolved.filter(row => row.decisionTime >= validationStart && row.decisionTime < validationEnd);
    if (training.length < 180 || !validation.length) continue;
    fold += 1;
    const lambdaModels = new Map(MODEL_LAMBDAS.map(lambda => [lambda, fitLogistic(training, lambda)]));
    const lambdaFolds = [];
    for (const lambda of MODEL_LAMBDAS) {
      const model = lambdaModels.get(lambda);
      if (!model) throw new Error('DEVELOPMENT_LOGISTIC_FIT_FAILED:' + lambda);
      const predictions = predictionsByLambda[String(lambda)];
      for (const row of validation) predictions.push(compactPrediction(row, model, fold, lambda));
      lambdaFolds.push({ lambda, trainingRows: model.trainingRows, trainingRowsUsed: model.trainingRowsUsed, validationRows: validation.length });
    }
    folds.push({
      fold,
      trainStart: iso(start),
      trainEnd: iso(trainingCutoff),
      validationStart: iso(validationStart),
      validationEnd: iso(validationEnd),
      trainingRows: training.length,
      validationRows: validation.length,
      purgeHours,
      embargoHours,
      lambdaFolds
    });
  }
  const first = predictionsByLambda[String(MODEL_LAMBDAS[0])];
  const firstIds = first.map(row => row.candidateId).sort();
  const oofCandidateIdsEqual = MODEL_LAMBDAS.every(lambda => {
    const ids = predictionsByLambda[String(lambda)].map(row => row.candidateId).sort();
    return ids.length === firstIds.length && ids.every((id, index) => id === firstIds[index]);
  });
  if (!oofCandidateIdsEqual) throw new Error('INCONSISTENT_LAMBDA_OOF_CANDIDATE_UNIVERSE');
  return {
    predictions: MODEL_LAMBDAS.flatMap(lambda => predictionsByLambda[String(lambda)]),
    predictionsByLambda,
    folds,
    oofCandidateIdsEqual,
    oofCountsByLambda: Object.fromEntries(MODEL_LAMBDAS.map(lambda => [String(lambda), predictionsByLambda[String(lambda)].length])),
    expectedOofCountPerLambda: first.length,
    oofCoverageRatioByLambda: Object.fromEntries(MODEL_LAMBDAS.map(lambda => [String(lambda), first.length ? predictionsByLambda[String(lambda)].length / first.length : 0]))
  };
}

function canonicalCandidateRows(rows) {
  return rows.slice().sort((left, right) => left.decisionTime - right.decisionTime
    || (right.predictedEdgeBps ?? -Infinity) - (left.predictedEdgeBps ?? -Infinity)
    || left.candidateId.localeCompare(right.candidateId));
}

export function applyFrequency(rows, threshold) {
  const byDecisionSymbol = new Map();
  for (const row of rows) {
    const key = row.symbol + ':' + row.decisionTime;
    const current = byDecisionSymbol.get(key);
    if (!current || row.predictedEdgeBps > current.predictedEdgeBps
      || (row.predictedEdgeBps === current.predictedEdgeBps && row.side.localeCompare(current.side) < 0)) {
      byDecisionSymbol.set(key, row);
    }
  }
  const selected = [];
  const cooldown = new Map();
  const daily = new Map();
  for (const row of canonicalCandidateRows([...byDecisionSymbol.values()])) {
    if (!(row.predictedEdgeBps >= threshold)) continue;
    const day = new Date(row.decisionTime).toISOString().slice(0, 10);
    if ((daily.get(day) ?? 0) >= 2) continue;
    if ((cooldown.get(row.symbol) ?? -Infinity) > row.decisionTime) continue;
    selected.push(row);
    daily.set(day, (daily.get(day) ?? 0) + 1);
    cooldown.set(row.symbol, row.decisionTime + 12 * HOUR);
  }
  return selected;
}

export function profitFactor(rows, field = 'net27Bps') {
  const gains = rows.filter(row => row[field] > 0).reduce((sum, row) => sum + row[field], 0);
  const losses = Math.abs(rows.filter(row => row[field] < 0).reduce((sum, row) => sum + row[field], 0));
  return losses ? gains / losses : gains > 0 ? Infinity : null;
}

function maxLossStreak(rows, field) {
  let current = 0;
  let maximum = 0;
  for (const row of rows.slice().sort((left, right) => left.exitTime - right.exitTime || left.candidateId.localeCompare(right.candidateId))) {
    current = row[field] < 0 ? current + 1 : 0;
    maximum = Math.max(maximum, current);
  }
  return maximum;
}

export function summarizeMetrics(rows, costBps) {
  const field = 'net' + costBps + 'Bps';
  const values = rows.map(row => row[field]).filter(finite);
  const netPnl = values.reduce((sum, value) => sum + value, 0);
  const monthlyNetPnl = {};
  const symbolNetPnl = {};
  for (const row of rows) {
    const month = iso(row.exitTime).slice(0, 7);
    monthlyNetPnl[month] = (monthlyNetPnl[month] ?? 0) + row[field];
    symbolNetPnl[row.symbol] = (symbolNetPnl[row.symbol] ?? 0) + row[field];
  }
  const ordered = rows.slice().sort((left, right) => right[field] - left[field] || left.exitTime - right.exitTime || left.candidateId.localeCompare(right.candidateId));
  const activeMonths = Object.keys(monthlyNetPnl).sort();
  const bestMonth = activeMonths.slice().sort((left, right) => monthlyNetPnl[right] - monthlyNetPnl[left] || left.localeCompare(right))[0] ?? null;
  const bestMonthPnl = bestMonth == null ? null : monthlyNetPnl[bestMonth];
  const positiveMonthPool = Object.values(monthlyNetPnl).reduce((sum, value) => sum + Math.max(0, value), 0);
  const positiveSymbolPool = Object.values(symbolNetPnl).reduce((sum, value) => sum + Math.max(0, value), 0);
  const bestSymbol = Object.entries(symbolNetPnl).filter(([, value]) => value > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? null;
  return {
    costBps,
    count: values.length,
    netPnlBps: netPnl,
    netExpectancyBps: values.length ? netPnl / values.length : null,
    profitFactor: profitFactor(rows, field),
    positiveRate: values.length ? values.filter(value => value > 0).length / values.length : null,
    activeMonths: activeMonths.length,
    activeMonthKeys: activeMonths,
    positiveMonths: Object.values(monthlyNetPnl).filter(value => value > 0).length,
    positiveMonthShare: activeMonths.length ? Object.values(monthlyNetPnl).filter(value => value > 0).length / activeMonths.length : null,
    monthlyNetPnlBps: monthlyNetPnl,
    bestMonth,
    bestMonthNetPnlBps: bestMonthPnl,
    netPnlWithoutBestMonthBps: bestMonthPnl == null ? null : netPnl - bestMonthPnl,
    bestEventNetPnlBps: ordered[0]?.[field] ?? null,
    netPnlWithoutBestEventBps: ordered.length ? netPnl - ordered[0][field] : null,
    netPnlWithoutBest5EventsBps: netPnl - ordered.slice(0, 5).reduce((sum, row) => sum + row[field], 0),
    maxLossStreak: values.length ? maxLossStreak(rows, field) : null,
    symbolNetPnlBps: symbolNetPnl,
    largestSymbol: bestSymbol?.[0] ?? null,
    largestSymbolProfitContribution: positiveSymbolPool > 0 ? bestSymbol[1] / positiveSymbolPool : null,
    largestMonthProfitContribution: positiveMonthPool > 0 && bestMonth != null ? bestMonthPnl / positiveMonthPool : null,
    fundingBps: rows.reduce((sum, row) => sum + (row.fundingBps ?? 0), 0),
    executionCostBps: rows.length * costBps,
    exitReasons: Object.fromEntries([...new Set(rows.map(row => row.exitReason))].sort().map(reason => [reason, rows.filter(row => row.exitReason === reason).length])),
    directionCounts: rows.reduce((out, row) => ({ ...out, [row.side]: (out[row.side] ?? 0) + 1 }), {})
  };
}

export function computePortfolioRisk(rows, series, { costBps, start, end } = {}) {
  if (!rows.length) return {
    status: 'EMPTY_SAMPLE_NOT_EVALUABLE',
    portfolioMtmStatus: 'NOT_RECONSTRUCTED',
    portfolioMtmDrawdownFraction: null,
    portfolioCvar95: null,
    portfolioCvarStatus: 'NOT_EVALUATED',
    equity: [],
    dailyReturns: []
  };
  return reconstructPortfolioMtm(rows, series, { costBps, start, end });
}

export function blockBootstrap(rows, { start = VALIDATION_START, end = VALIDATION_END } = {}) {
  return referenceBlockBootstrap(rows, { start, end, seed: 400040 });
}

function ratePer30Days(rows, start, end) {
  return rows.length / ((end - start) / DAY) * 30;
}

function percentiles() {
  const output = [];
  for (let step = 900; step <= 999; step += 1) output.push(step / 10);
  return output;
}

function metricsForAccepted(rows) {
  return {
    net18: summarizeMetrics(rows, 18),
    net27: summarizeMetrics(rows, 27),
    net36: summarizeMetrics(rows, 36)
  };
}

export function selectDevelopmentConfig(predictionsByLambda, { series = null } = {}) {
  const grid = [];
  for (const lambda of MODEL_LAMBDAS) {
    const predictions = predictionsByLambda[String(lambda)] ?? [];
    const edges = predictions.map(row => row.predictedEdgeBps);
    for (const percentile of percentiles()) {
      const thresholdBps = quantile(edges, percentile / 100);
      const accepted = thresholdBps == null ? [] : applyFrequency(predictions, thresholdBps);
      const metrics = metricsForAccepted(accepted);
      const rate = ratePer30Days(accepted, DEVELOPMENT_START + 180 * DAY, DEVELOPMENT_END);
      const risk = series && accepted.length ? computePortfolioRisk(accepted, series, {
        costBps: 27, start: DEVELOPMENT_START, end: DEVELOPMENT_END
      }) : null;
      grid.push({
        lambda,
        thresholdPercentile: percentile,
        thresholdBps,
        acceptedSignals: accepted.length,
        signalsPer30Days: rate,
        BUY: accepted.filter(row => row.side === 'BUY').length,
        SELL: accepted.filter(row => row.side === 'SELL').length,
        net18ExpectancyBps: metrics.net18.netExpectancyBps,
        PF18: metrics.net18.profitFactor,
        net27ExpectancyBps: metrics.net27.netExpectancyBps,
        PF27: metrics.net27.profitFactor,
        net27Pnl: metrics.net27.netPnlBps,
        net36ExpectancyBps: metrics.net36.netExpectancyBps,
        PF36: metrics.net36.profitFactor,
        portfolioMtmDrawdownFraction: risk?.portfolioMtmDrawdownFraction ?? null,
        ratePass: rate >= 20 && rate <= 40,
        edgePass: finite(metrics.net27.netExpectancyBps) && metrics.net27.netExpectancyBps > 0,
        pfPass: metrics.net27.profitFactor === Infinity || (finite(metrics.net27.profitFactor) && metrics.net27.profitFactor >= 1.10),
        eligible: rate >= 20 && rate <= 40 && finite(metrics.net27.netExpectancyBps)
          && metrics.net27.netExpectancyBps > 0
          && (metrics.net27.profitFactor === Infinity || (finite(metrics.net27.profitFactor) && metrics.net27.profitFactor >= 1.10)),
        _accepted: accepted
      });
    }
  }
  const eligible = grid.filter(row => row.eligible).sort((left, right) => right.net27ExpectancyBps - left.net27ExpectancyBps
    || (right.PF27 ?? -Infinity) - (left.PF27 ?? -Infinity)
    || (left.portfolioMtmDrawdownFraction ?? Infinity) - (right.portfolioMtmDrawdownFraction ?? Infinity)
    || left.lambda - right.lambda || left.thresholdPercentile - right.thresholdPercentile);
  const diagnostic = {
    gridCount: grid.length,
    rateEligibleConfigCount: grid.filter(row => row.ratePass).length,
    positiveExpectancyConfigCount: grid.filter(row => row.edgePass).length,
    pfPassingConfigCount: grid.filter(row => row.pfPass).length,
    fullyEligibleConfigCount: eligible.length,
    bestRateEligibleExpectancyConfig: grid.filter(row => row.ratePass).sort((a, b) => b.net27ExpectancyBps - a.net27ExpectancyBps)[0] ?? null,
    bestRateEligiblePFConfig: grid.filter(row => row.ratePass).sort((a, b) => (b.PF27 ?? -Infinity) - (a.PF27 ?? -Infinity))[0] ?? null
  };
  if (!eligible.length) return {
    status: 'NO_DEVELOPMENT_CONFIG',
    reason: 'NO_OOF_THRESHOLD_MEETS_RATE_AND_EDGE',
    candidates: [],
    selectionGrid: grid.map(({ _accepted, ...row }) => row),
    selectionDiagnostics: diagnostic,
    oofCountsByLambda: Object.fromEntries(MODEL_LAMBDAS.map(lambda => [String(lambda), (predictionsByLambda[String(lambda)] ?? []).length]))
  };
  const best = eligible[0];
  return {
    status: 'DEVELOPMENT_CONFIG_FOUND',
    lambda: best.lambda,
    edgeThresholdBps: best.thresholdBps,
    edgePercentile: best.thresholdPercentile,
    selectionRatePer30Days: best.signalsPer30Days,
    selectionNet27ExpectancyBps: best.net27ExpectancyBps,
    selectionPF27: best.PF27,
    selectionPortfolioMtmDrawdownFraction: best.portfolioMtmDrawdownFraction,
    acceptedDevelopmentRows: best._accepted,
    selectionGrid: grid.map(({ _accepted, ...row }) => row),
    selectionDiagnostics: diagnostic,
    candidates: eligible.slice(0, 3).map(({ _accepted, ...row }) => row)
  };
}

function monthIntervals(start, end) {
  const output = [];
  let cursor = start;
  while (cursor < end) {
    const date = new Date(cursor);
    const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    output.push({ start: cursor, end: Math.min(end, next) });
    cursor = next;
  }
  return output;
}

export function runHistoricalValidation(rows, developmentConfig) {
  if (developmentConfig.status !== 'DEVELOPMENT_CONFIG_FOUND') {
    return { status: 'NOT_RUN_NO_DEVELOPMENT_CONFIG', reason: developmentConfig.reason, predictions: [], accepted: [], folds: [] };
  }
  const resolved = rows.filter(row => row.outcomeStatus === 'RESOLVED').sort((a, b) => a.decisionTime - b.decisionTime);
  const predictions = [];
  const accepted = [];
  const folds = [];
  let fold = 0;
  for (const interval of monthIntervals(VALIDATION_START, VALIDATION_END)) {
    const trainingEnd = interval.start - 36 * HOUR;
    const training = resolved.filter(row => row.decisionTime >= interval.start - 365 * DAY
      && row.decisionTime < trainingEnd && row.exitTime < interval.start - 24 * HOUR);
    const validation = resolved.filter(row => row.decisionTime >= interval.start && row.decisionTime < interval.end);
    if (training.length < 180) {
      folds.push({ fold: folds.length + 1, validationStart: iso(interval.start), validationEnd: iso(interval.end), trainingRows: training.length, status: 'SKIPPED_INSUFFICIENT_TRAINING' });
      continue;
    }
    const model = fitLogistic(training, developmentConfig.lambda);
    if (!model) throw new Error('HISTORICAL_LOGISTIC_FIT_FAILED');
    fold += 1;
    const block = validation.map(row => compactPrediction(row, model, fold, developmentConfig.lambda));
    const selected = applyFrequency(block, developmentConfig.edgeThresholdBps);
    predictions.push(...block);
    accepted.push(...selected);
    folds.push({
      fold,
      validationStart: iso(interval.start),
      validationEnd: iso(interval.end),
      trainingStart: iso(interval.start - 365 * DAY),
      trainingEnd: iso(trainingEnd),
      trainingRows: training.length,
      validationRows: validation.length,
      acceptedRows: selected.length,
      lambda: developmentConfig.lambda,
      edgeThresholdBps: developmentConfig.edgeThresholdBps
    });
  }
  return { status: 'HISTORICAL_VALIDATION_COMPUTED', predictions, accepted, folds };
}

function gatesForHistory(accepted, series, developmentConfig) {
  const metrics = metricsForAccepted(accepted);
  const risk = computePortfolioRisk(accepted, series, { costBps: 27, start: VALIDATION_START, end: VALIDATION_END });
  const bootstrap = blockBootstrap(accepted);
  const net27 = metrics.net27;
  const gates = {
    signals: net27.count >= 240 && net27.count <= 480,
    signalsPer30Days: net27.count / 12 >= 20 && net27.count / 12 <= 40,
    activeMonths: net27.activeMonths >= 10,
    symbolBreadth: Object.keys(net27.symbolNetPnlBps).length >= 6,
    net27Expectancy: net27.netExpectancyBps >= 5,
    PF27: net27.profitFactor === Infinity || (finite(net27.profitFactor) && net27.profitFactor >= 1.2),
    net27Pnl: net27.netPnlBps > 0,
    net36Expectancy: metrics.net36.netExpectancyBps > 0,
    portfolioMtm: risk.portfolioMtmStatus === 'RECONSTRUCTED' && risk.portfolioMtmDrawdownFraction <= 0.1,
    portfolioCvar: risk.portfolioCvarStatus === 'EVALUABLE' && finite(risk.portfolioCvar95),
    maxLossStreak: net27.maxLossStreak <= 8,
    positiveMonths: net27.positiveMonths >= 7,
    withoutBestEvent: net27.netPnlWithoutBestEventBps > 0,
    withoutBest5: net27.netPnlWithoutBest5EventsBps > 0,
    withoutBestMonth: net27.netPnlWithoutBestMonthBps > 0,
    largestSymbolContribution: net27.largestSymbolProfitContribution != null && net27.largestSymbolProfitContribution <= 0.4,
    largestMonthContribution: net27.largestMonthProfitContribution != null && net27.largestMonthProfitContribution <= 0.4,
    bootstrapNet27LowerPositive: bootstrap.net27ExpectancyBpsLower95 > 0
  };
  return { metrics, risk, bootstrap, gates, failures: Object.entries(gates).filter(([, value]) => !value).map(([key]) => key), pass: Object.values(gates).every(Boolean), developmentConfig };
}

export function buildDevelopmentReport({ candidates, outcomes, walkForward, developmentConfig, coverage, series } = {}) {
  const selected = developmentConfig.acceptedDevelopmentRows ?? [];
  return {
    schemaVersion: 1,
    artifactType: 'HY_EXP_0040_DEVELOPMENT_REPORT',
    immutable: true,
    experimentId: HY_EXP_0040,
    window: { start: iso(DEVELOPMENT_START), endExclusive: iso(DEVELOPMENT_END), calendarDays: 365 },
    dataBoundary: { outcomeRead: true, finalOosRead: false, historicalValidationNotRead: true },
    candidateCounts: {
      raw: candidates.length,
      resolved: outcomes.filter(row => row.outcomeStatus === 'RESOLVED').length,
      invalid: outcomes.filter(row => row.outcomeStatus !== 'RESOLVED').length
    },
    candidateCoverage: coverage,
    walkForward: {
      folds: walkForward.folds,
      oofCountsByLambda: walkForward.oofCountsByLambda,
      expectedOofCountPerLambda: walkForward.expectedOofCountPerLambda,
      oofCoverageRatioByLambda: walkForward.oofCoverageRatioByLambda,
      oofCandidateIdsEqual: walkForward.oofCandidateIdsEqual,
      randomSplit: false,
      oofOnly: true
    },
    selection: {
      status: developmentConfig.status,
      reason: developmentConfig.reason ?? null,
      lambda: developmentConfig.lambda ?? null,
      edgePercentile: developmentConfig.edgePercentile ?? null,
      edgeThresholdBps: developmentConfig.edgeThresholdBps ?? null,
      acceptedSignals: selected.length,
      signalsPer30Days: developmentConfig.selectionRatePer30Days ?? null,
      net27ExpectancyBps: developmentConfig.selectionNet27ExpectancyBps ?? null,
      PF27: developmentConfig.selectionPF27 ?? null,
      portfolioMtmDrawdownFraction: developmentConfig.selectionPortfolioMtmDrawdownFraction ?? null,
      gridCount: developmentConfig.selectionDiagnostics?.gridCount ?? 0
    },
    selectedMetrics: metricsForAccepted(selected),
    status: developmentConfig.status,
    promotionEligible: false,
    safety: { paperOnly: true, signalOnly: true, gmail: false, scheduler: false, realEmail: false, automaticTrading: false, accountApi: false, orderApi: false, finalOosRead: false }
  };
}

export function buildHistoricalValidationReport({ history, series, developmentConfig, preregistrationSha256, dataManifestSha256 } = {}) {
  const evaluation = gatesForHistory(history.accepted ?? [], series, developmentConfig);
  const notRun = history.status === 'NOT_RUN_NO_DEVELOPMENT_CONFIG';
  const pass = !notRun && evaluation.pass;
  return {
    schemaVersion: 1,
    artifactType: 'HY_EXP_0040_HISTORICAL_VALIDATION',
    immutable: true,
    experimentId: HY_EXP_0040,
    preregistrationSha256,
    dataManifestSha256,
    window: { start: iso(VALIDATION_START), endExclusive: iso(VALIDATION_END), calendarDays: 365, validationType: 'REGISTERED_HISTORICAL_VALIDATION_NOT_FINAL_OOS' },
    sourceBoundary: { outcomeRead: true, pnlComputed: true, finalOosRead: false, previouslyObservedDisclosure: true },
    status: history.status,
    reason: history.reason ?? null,
    counts: { predictions: history.predictions.length, accepted: history.accepted.length, folds: history.folds.length },
    developmentConfig: { status: developmentConfig.status, lambda: developmentConfig.lambda ?? null, edgeThresholdBps: developmentConfig.edgeThresholdBps ?? null },
    metrics: evaluation.metrics,
    portfolioRisk: evaluation.risk,
    bootstrap: evaluation.bootstrap,
    gates: evaluation.gates,
    gateFailures: notRun ? ['NO_DEVELOPMENT_CONFIG'] : evaluation.failures,
    result: pass ? 'HISTORICAL_VALIDATION_PASS' : 'NO_PROFITABLE_AGGTRADE_EMAIL_STRATEGY_FOUND',
    productConclusion: pass ? 'HISTORICAL_VALIDATION_PASS' : 'NO_PROFITABLE_AGGTRADE_EMAIL_STRATEGY_FOUND',
    failureStage: pass ? null : notRun ? 'DEVELOPMENT' : 'HISTORICAL_VALIDATION',
    emailPreparationEligible: pass,
    futureValidation: { experimentId: 'HY-FWD-0040-001', prepared: pass, activated: false, minimumDays: 90, minimumSignals: 20 },
    safety: { paperOnly: true, signalOnly: true, gmail: false, scheduler: false, realEmail: false, automaticTrading: false, accountApi: false, orderApi: false, finalOosRead: false },
    folds: history.folds
  };
}

export function buildFrozenModelSpec({ developmentConfig, preregistrationSha256, dataManifestSha256 } = {}) {
  return {
    schemaVersion: 1,
    artifactType: 'HY_EXP_0040_FROZEN_MODEL_SPEC',
    immutable: true,
    experimentId: HY_EXP_0040,
    preregistrationSha256,
    dataManifestSha256,
    model: 'REGULARIZED_LOGISTIC_EDGE_MODEL',
    featureNames: FEATURE_NAMES,
    lambdaGrid: MODEL_LAMBDAS,
    selectedLambda: developmentConfig.lambda ?? null,
    selectedEdgeThresholdBps: developmentConfig.edgeThresholdBps ?? null,
    noRandomSplit: true,
    purgedWalkForward: true,
    embargoHours: 12,
    purgeHours: 24,
    noPostOutcomeTuning: true,
    safety: { paperOnly: true, signalOnly: true, gmail: false, scheduler: false, realEmail: false, automaticTrading: false, accountApi: false, orderApi: false, finalOosRead: false }
  };
}

export function buildCompletionBundle({ codeCommit, preregistrationSha256, dataManifestSha256, artifactEntries, finalResult, emailPreparation = null } = {}) {
  return {
    schemaVersion: 1,
    artifactType: 'HY_EXP_0040_COMPLETION_BUNDLE',
    immutable: true,
    experiment_id: HY_EXP_0040,
    code_commit: codeCommit,
    preregistration_sha256: preregistrationSha256,
    data_manifest_sha256: dataManifestSha256,
    outcomeRead: true,
    pnlComputed: true,
    finalOosRead: false,
    finalResult,
    artifacts: artifactEntries,
    emailPreparation: emailPreparation ? 'artifacts/HY-EXP-0040/email-preparation.json' : null,
    safety: { paperOnly: true, signalOnly: true, gmail: false, scheduler: false, realEmail: false, automaticTrading: false, accountApi: false, orderApi: false, finalOosRead: false, productionDeploy: false }
  };
}

