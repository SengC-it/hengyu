const BPS = 10_000;

export const HY_EXP_0024_EDGE_MODEL_ID = 'HY-EXP-0024-EDGE-RIDGE-L1';
export const HY_EXP_0024_EDGE_SOURCE = 'HENGYU-HY-EXP-0024-PURGED-RIDGE-FORWARD';
export const HY_EXP_0024_PRIMARY_LAMBDA = 1;
export const HY_EXP_0024_SENSITIVITY_LAMBDAS = Object.freeze([0.1, 1, 10]);
export const HY_EXP_0024_MINIMUM_SAMPLES = 100;
export const HY_EXP_0024_FEATURES = Object.freeze([
  'sideAdjustedBreakoutDistanceOverATR20',
  'sideAdjustedTrendStrengthOverATR20',
  'sideAdjustedSMA60MinusSMA180OverATR20',
  'regimeBreadthFraction',
  'eligibleSymbolCountOverEight',
  'log1pPriorSixCompleted4hQuoteVolume',
  'ATR20OverClose',
  'sideAdjustedPrior60ChannelDistanceOverATR20'
]);

function finite(value) {
  return value != null && Number.isFinite(Number(value));
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function percentile(values, probability) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function invert(matrix) {
  const size = matrix.length;
  const augmented = matrix.map((row, rowIndex) => [
    ...row,
    ...Array.from({ length: size }, (_, column) => column === rowIndex ? 1 : 0)
  ]);
  for (let column = 0; column < size; column++) {
    let pivot = column;
    for (let row = column + 1; row < size; row++) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-12) return null;
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let index = 0; index < size * 2; index++) augmented[column][index] /= divisor;
    for (let row = 0; row < size; row++) {
      if (row === column) continue;
      const factor = augmented[row][column];
      if (factor === 0) continue;
      for (let index = 0; index < size * 2; index++) {
        augmented[row][index] -= factor * augmented[column][index];
      }
    }
  }
  return augmented.map(row => row.slice(size));
}

function matrixVector(matrix, vector) {
  return matrix.map(row => row.reduce((sum, value, index) => sum + value * vector[index], 0));
}

function dot(left, right) {
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

function designMatrix(features) {
  return [1, ...features];
}

function fitTransforms(rows) {
  return HY_EXP_0024_FEATURES.map((name, index) => {
    const values = rows.map(row => Number(row.features[index]));
    const lower = percentile(values, 0.01);
    const upper = percentile(values, 0.99);
    const clipped = values.map(value => Math.min(upper, Math.max(lower, value)));
    const center = mean(clipped);
    const variance = clipped.reduce((sum, value) => sum + (value - center) ** 2, 0) / clipped.length;
    return {
      name,
      lower,
      upper,
      mean: center,
      standardDeviation: Math.sqrt(variance),
      zeroVariance: !(Math.sqrt(variance) > 0)
    };
  });
}

function transformFeatures(features, transforms) {
  if (!Array.isArray(features) || features.length !== HY_EXP_0024_FEATURES.length
    || !Array.isArray(transforms) || transforms.length !== HY_EXP_0024_FEATURES.length) return null;
  return features.map((value, index) => {
    if (!finite(value)) return null;
    const transform = transforms[index];
    const clipped = Math.min(transform.upper, Math.max(transform.lower, Number(value)));
    return transform.zeroVariance ? 0 : (clipped - transform.mean) / transform.standardDeviation;
  });
}

function normalEquation(rows, lambda, transforms) {
  const dimension = HY_EXP_0024_FEATURES.length + 1;
  const xtx = Array.from({ length: dimension }, () => Array(dimension).fill(0));
  const xty = Array(dimension).fill(0);
  for (const row of rows) {
    const transformed = transformFeatures(row.features, transforms);
    if (!transformed || !finite(row.targetBps)) continue;
    const x = designMatrix(transformed);
    for (let left = 0; left < dimension; left++) {
      xty[left] += x[left] * Number(row.targetBps);
      for (let right = 0; right < dimension; right++) xtx[left][right] += x[left] * x[right];
    }
  }
  for (let index = 1; index < dimension; index++) xtx[index][index] += lambda;
  const inverse = invert(xtx);
  if (!inverse) return null;
  return { inverse, coefficients: matrixVector(inverse, xty) };
}

/** Fit the frozen Ridge model. The intercept is deliberately unpenalized. */
export function fitHyExp0024Ridge(rows, {
  lambda = HY_EXP_0024_PRIMARY_LAMBDA,
  minimumSamples = HY_EXP_0024_MINIMUM_SAMPLES,
  cell = null
} = {}) {
  if (!Array.isArray(rows)) throw new Error('Ridge rows are required');
  const usable = rows.filter(row => Array.isArray(row?.features)
    && row.features.length === HY_EXP_0024_FEATURES.length
    && row.features.every(finite)
    && finite(row.targetBps));
  if (usable.length < minimumSamples) return null;
  const transforms = fitTransforms(usable);
  const equation = normalEquation(usable, Number(lambda), transforms);
  if (!equation) return null;
  const residuals = usable.map(row => {
    const transformed = transformFeatures(row.features, transforms);
    return Number(row.targetBps) - dot(equation.coefficients, designMatrix(transformed));
  });
  const residualSse = residuals.reduce((sum, value) => sum + value ** 2, 0);
  const parameterCount = HY_EXP_0024_FEATURES.length + 1;
  const residualMse = residualSse / Math.max(1, usable.length - parameterCount);
  return {
    modelId: HY_EXP_0024_EDGE_MODEL_ID,
    edgeSource: HY_EXP_0024_EDGE_SOURCE,
    cell,
    lambda: Number(lambda),
    sampleSize: usable.length,
    featureNames: [...HY_EXP_0024_FEATURES],
    transforms,
    coefficients: equation.coefficients,
    inverseNormalMatrix: equation.inverse,
    residualMse,
    targetUnits: 'gross_directional_price_return_bps',
    targetCostExclusions: ['fee', 'funding', 'spread', 'book_cost', 'slippage', 'impact', 'latency', 'funding_stress']
  };
}

export function predictHyExp0024Ridge(model, features, {
  validationWindow,
  sampleSize = model?.sampleSize ?? 0
} = {}) {
  const transformed = model ? transformFeatures(features, model.transforms) : null;
  if (!model || !transformed) {
    return {
      available: false,
      expectedPriceEdgeBps: null,
      standardErrorBps: null,
      edgeSource: 'UNVERIFIED',
      edgeModelId: HY_EXP_0024_EDGE_MODEL_ID,
      sampleSize: 0,
      validationWindow: validationWindow ?? null,
      rejectionReason: 'EDGE_FEATURE_MISSING_OR_MODEL_UNAVAILABLE'
    };
  }
  const x = designMatrix(transformed);
  const prediction = dot(model.coefficients, x);
  const leverage = Math.max(0, dot(x, matrixVector(model.inverseNormalMatrix, x)));
  const standardErrorBps = Math.sqrt(Math.max(0, model.residualMse * (1 + leverage)));
  return {
    available: true,
    expectedPriceEdgeBps: prediction,
    standardErrorBps,
    edgeSource: model.edgeSource,
    edgeModelId: model.modelId,
    sampleSize,
    validationWindow: validationWindow ?? null,
    rejectionReason: null,
    featureSummary: Object.fromEntries(HY_EXP_0024_FEATURES.map((name, index) => [name, features[index]]))
  };
}

function rank(values) {
  const ordered = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const output = Array(values.length);
  for (let start = 0; start < ordered.length;) {
    let end = start + 1;
    while (end < ordered.length && ordered[end].value === ordered[start].value) end++;
    const averageRank = (start + end - 1) / 2 + 1;
    for (let cursor = start; cursor < end; cursor++) output[ordered[cursor].index] = averageRank;
    start = end;
  }
  return output;
}

function correlation(left, right) {
  if (left.length < 2 || left.length !== right.length) return null;
  const leftMean = mean(left);
  const rightMean = mean(right);
  const numerator = left.reduce((sum, value, index) => sum + (value - leftMean) * (right[index] - rightMean), 0);
  const leftSse = left.reduce((sum, value) => sum + (value - leftMean) ** 2, 0);
  const rightSse = right.reduce((sum, value) => sum + (value - rightMean) ** 2, 0);
  return leftSse > 0 && rightSse > 0 ? numerator / Math.sqrt(leftSse * rightSse) : null;
}

function regression(actual, predicted) {
  const predictedMean = mean(predicted);
  const actualMean = mean(actual);
  const denominator = predicted.reduce((sum, value) => sum + (value - predictedMean) ** 2, 0);
  const slope = denominator > 0
    ? predicted.reduce((sum, value, index) => sum + (value - predictedMean) * (actual[index] - actualMean), 0) / denominator
    : null;
  return {
    slope,
    intercept: slope == null ? null : actualMean - slope * predictedMean
  };
}

function errorMetrics(rows) {
  const errors = rows.map(row => row.realizedBps - row.predictedBps);
  return {
    count: rows.length,
    maeBps: errors.length ? errors.reduce((sum, error) => sum + Math.abs(error), 0) / errors.length : null,
    rmseBps: errors.length ? Math.sqrt(errors.reduce((sum, error) => sum + error ** 2, 0) / errors.length) : null,
    meanPredictedBps: rows.length ? mean(rows.map(row => row.predictedBps)) : null,
    meanRealizedBps: rows.length ? mean(rows.map(row => row.realizedBps)) : null,
    ...regression(rows.map(row => row.realizedBps), rows.map(row => row.predictedBps)),
    rankCorrelation: rows.length ? correlation(rank(rows.map(row => row.predictedBps)), rank(rows.map(row => row.realizedBps))) : null
  };
}

/** Calibration is calculated from out-of-fold, pre-Net-Edge candidates. */
export function summarizeHyExp0024Calibration(rows) {
  const usable = (rows ?? []).filter(row => finite(row?.predictedBps) && finite(row?.realizedBps));
  const decileRows = [...usable].sort((a, b) => a.predictedBps - b.predictedBps);
  const deciles = [];
  for (let decile = 0; decile < 10; decile++) {
    const start = Math.floor(decile * decileRows.length / 10);
    const end = Math.floor((decile + 1) * decileRows.length / 10);
    const members = decileRows.slice(start, end);
    deciles.push({ decile: decile + 1, ...errorMetrics(members) });
  }
  const zeroBaseline = usable.map(row => ({ predictedBps: 0, realizedBps: row.realizedBps }));
  const metrics = errorMetrics(usable);
  const baseline = errorMetrics(zeroBaseline);
  return {
    population: usable.length,
    pooled: metrics,
    zeroEdgeBaseline: baseline,
    modelMaeOverZeroBaseline: metrics.maeBps != null && baseline.maeBps > 0 ? metrics.maeBps / baseline.maeBps : null,
    modelRmseOverZeroBaseline: metrics.rmseBps != null && baseline.rmseBps > 0 ? metrics.rmseBps / baseline.rmseBps : null,
    deciles,
    byCell: Object.fromEntries([...new Set(usable.map(row => row.cell))].sort().map(cell => [
      cell,
      errorMetrics(usable.filter(row => row.cell === cell))
    ]))
  };
}

export function edgeGateFromPrediction(edge, expectedFundingBps, fundingStressBps, {
  executionCostBps = 18,
  minimumConservativeNetBps = 3,
  minimumGrossToCostRatio = 1.5,
  confidenceZ = 1.645,
  stressMultiplier = 1
} = {}) {
  const expected = edge?.expectedPriceEdgeBps;
  const standardError = edge?.standardErrorBps;
  const available = edge?.available === true && finite(expected) && finite(standardError)
    && standardError >= 0;
  const costs = executionCostBps * stressMultiplier;
  const gross = (available ? Number(expected) : 0) + Number(expectedFundingBps ?? 0);
  const conservative = gross - costs - confidenceZ * (available ? Number(standardError) : 0)
    - Number(fundingStressBps ?? 0) * stressMultiplier;
  const grossToCostRatio = costs > 0 ? gross / costs : Infinity;
  const reasons = [];
  if (!available) reasons.push('EDGE_UNAVAILABLE');
  if (available && Number(expected) <= 0) reasons.push('NON_POSITIVE_PRICE_EDGE');
  if (grossToCostRatio < minimumGrossToCostRatio) reasons.push('INSUFFICIENT_COST_COVERAGE');
  if (conservative < minimumConservativeNetBps) reasons.push('INSUFFICIENT_CONSERVATIVE_NET_EDGE');
  return {
    decision: reasons.length ? 'NO_TRADE' : 'TRADE',
    reasons,
    expectedGrossEdgeBps: gross,
    expectedNetEdgeBps: gross - costs,
    conservativeNetEdgeBps: conservative,
    grossToCostRatio,
    executionCostBps: costs,
    uncertaintyPenaltyBps: confidenceZ * (available ? Number(standardError) : 0),
    fundingStressBps: Number(fundingStressBps ?? 0) * stressMultiplier
  };
}

export const BPS_CONSTANT = BPS;
