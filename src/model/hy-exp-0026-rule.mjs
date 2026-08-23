const CHANNEL_DISTANCE_INDEX = 7;

export const HY_EXP_0026_EDGE_MODEL_ID = 'HY-EXP-0026-EMPIRICAL-BUCKET-Q75-DIAGNOSTIC';
export const HY_EXP_0026_EDGE_SOURCE = 'HENGYU-HY-EXP-0026-TRAINING-Q75-EMPIRICAL-MEAN-DIAGNOSTIC';
export const HY_EXP_0026_CHANNEL_DISTANCE_FEATURE = 'sideAdjustedPrior60ChannelDistanceOverATR20';
export const HY_EXP_0026_MINIMUM_TRAINING_SAMPLES = 20;

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

function channelDistance(row) {
  const value = row?.features?.[CHANNEL_DISTANCE_INDEX];
  return finite(value) ? Number(value) : null;
}

function grossReturn(row) {
  const value = row?.label?.grossPriceReturnBps;
  return finite(value) ? Number(value) : null;
}

function monthlyClusteredStandardError(rows) {
  const byMonth = new Map();
  for (const row of rows) {
    const value = grossReturn(row);
    if (value == null) continue;
    const month = monthKey(row.signalTime);
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(value);
  }
  const monthlyMeans = [...byMonth.values()].map(values => mean(values));
  const standardDeviation = sampleStandardDeviation(monthlyMeans);
  return standardDeviation == null ? null : standardDeviation / Math.sqrt(monthlyMeans.length);
}

export function trainingQ75(rows) {
  return percentile(rows.map(channelDistance).filter(value => value != null), 0.75);
}

export function fitHyExp0026EdgeDiagnostics(rows, {
  q75 = trainingQ75(rows),
  minimumSamples = HY_EXP_0026_MINIMUM_TRAINING_SAMPLES,
  validationWindow = null
} = {}) {
  const qualifying = rows.filter(row => {
    const feature = channelDistance(row);
    return feature != null && q75 != null && feature >= q75 && grossReturn(row) != null;
  });
  const returns = qualifying.map(grossReturn);
  const standardDeviation = sampleStandardDeviation(returns);
  const standardError = standardDeviation == null ? null : standardDeviation / Math.sqrt(returns.length);
  const available = returns.length >= minimumSamples && standardError != null;
  return {
    available,
    modelId: HY_EXP_0026_EDGE_MODEL_ID,
    edgeModelId: HY_EXP_0026_EDGE_MODEL_ID,
    edgeSource: HY_EXP_0026_EDGE_SOURCE,
    featureName: HY_EXP_0026_CHANNEL_DISTANCE_FEATURE,
    trainingQ75: q75,
    minimumSamples,
    sampleSize: returns.length,
    expectedPriceEdgeBps: available ? mean(returns) : null,
    standardErrorBps: available ? standardError : null,
    standardErrorOfMeanBps: available ? standardError : null,
    monthlyClusteredStandardErrorBps: available ? monthlyClusteredStandardError(qualifying) : null,
    validationWindow,
    rejectionReason: available ? null : 'INSUFFICIENT_TRAINING_Q75_SAMPLE'
  };
}

export function predictHyExp0026EdgeDiagnostics(model, row, validationWindow = model?.validationWindow ?? null) {
  const feature = channelDistance(row);
  if (!model?.available || feature == null || feature < model.trainingQ75) {
    return {
      available: false,
      expectedPriceEdgeBps: null,
      standardErrorBps: null,
      standardErrorOfMeanBps: null,
      monthlyClusteredStandardErrorBps: null,
      edgeSource: HY_EXP_0026_EDGE_SOURCE,
      edgeModelId: HY_EXP_0026_EDGE_MODEL_ID,
      sampleSize: model?.sampleSize ?? 0,
      trainingQ75: model?.trainingQ75 ?? null,
      validationWindow,
      rejectionReason: feature == null ? 'MISSING_CHANNEL_DISTANCE' : 'OUTSIDE_TRAINING_Q75'
    };
  }
  return {
    available: true,
    expectedPriceEdgeBps: model.expectedPriceEdgeBps,
    standardErrorBps: model.standardErrorBps,
    standardErrorOfMeanBps: model.standardErrorOfMeanBps,
    monthlyClusteredStandardErrorBps: model.monthlyClusteredStandardErrorBps,
    edgeSource: model.edgeSource,
    edgeModelId: model.edgeModelId,
    sampleSize: model.sampleSize,
    trainingQ75: model.trainingQ75,
    validationWindow,
    rejectionReason: null
  };
}
