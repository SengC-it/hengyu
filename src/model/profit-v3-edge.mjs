const BPS = 10_000;

export const PROFIT_V3_EDGE_MODEL_ID = 'HENGYU-EDGE-FORWARD-MEAN-001';
export const PROFIT_V3_EDGE_SOURCE = 'HENGYU-PROFIT-V3-FORWARD-MEAN';

function finite(name, value, { minimum = -Infinity, exclusiveMinimum = false } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (exclusiveMinimum ? parsed <= minimum : parsed < minimum)) {
    throw new Error(`invalid ${name}`);
  }
  return parsed;
}

function integer(name, value, { minimum = 0 } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`invalid ${name}`);
  return parsed;
}

function sideOf(value) {
  const side = String(value ?? '').toUpperCase();
  if (side !== 'BUY' && side !== 'SELL') throw new Error('invalid edge side');
  return side;
}

function regimeOf(value) {
  const regime = String(value ?? '').toUpperCase();
  if (!['BULL', 'BEAR', 'SIDEWAYS'].includes(regime)) throw new Error('invalid edge regime');
  return regime;
}

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function standardError(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  const variance = values.reduce((total, value) => total + (value - average) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance / values.length);
}

function timeOf(row, field, fallback = null) {
  const value = row?.[field] ?? fallback;
  return value == null ? null : integer(`${field}`, value);
}

function normalizeWindow(window, defaults) {
  const value = window && typeof window === 'object' ? window : {};
  return {
    trainStart: value.trainStart ?? defaults.trainStart ?? null,
    trainEnd: value.trainEnd ?? defaults.trainEnd ?? null,
    asOf: value.asOf ?? defaults.asOf ?? null,
    horizonBars: defaults.horizonBars,
    purgeBars: defaults.purgeBars,
    method: value.method ?? 'expanding_walk_forward_purged',
    trainingScope: value.trainingScope ?? defaults.trainingScope ?? 'causal_prior_labels_only'
  };
}

/**
 * Estimate price edge from labels that were fully known before the purged
 * cutoff. Breakout distance is retained as a feature summary only; it never
 * enters the expected edge arithmetic.
 */
export function estimateProfitV3Edge({
  candidate,
  observations = [],
  asOf = candidate?.decisionTime ?? Date.now(),
  trainStart = -Infinity,
  trainEnd = asOf,
  horizonBars = 6,
  barIntervalMs = 4 * 60 * 60 * 1_000,
  purgeBars = horizonBars,
  minimumSamples = 30,
  validationWindow = null,
  edgeModelId = PROFIT_V3_EDGE_MODEL_ID,
  edgeSource = PROFIT_V3_EDGE_SOURCE
} = {}) {
  if (!candidate || typeof candidate !== 'object') throw new Error('candidate is required');
  const side = sideOf(candidate.side);
  const regime = regimeOf(candidate.regime);
  const targetTime = integer('edge asOf', asOf);
  const start = Number.isFinite(Number(trainStart)) ? Number(trainStart) : -Infinity;
  const end = integer('edge trainEnd', trainEnd);
  const horizon = integer('edge horizonBars', horizonBars, { minimum: 1 });
  const purge = integer('edge purgeBars', purgeBars, { minimum: 0 });
  const minimum = integer('edge minimumSamples', minimumSamples, { minimum: 1 });
  const purgeMs = purge * integer('edge barIntervalMs', barIntervalMs, { minimum: 1 });
  const targetSignalTime = integer('candidate signalTime', candidate.signalTime ?? candidate.decisionTime);
  const causalCutoff = targetSignalTime - purgeMs;
  const samples = observations.filter(row => {
    if (!row || typeof row !== 'object') return false;
    if (sideOf(row.side) !== side || regimeOf(row.regime) !== regime) return false;
    const signalTime = timeOf(row, 'signalTime');
    const labelEndTime = timeOf(row, 'labelEndTime');
    const value = Number(row.forwardReturnBps);
    if (signalTime == null || labelEndTime == null || !Number.isFinite(value)) return false;
    if (signalTime < start || signalTime >= end || signalTime >= targetSignalTime) return false;
    // A training split is closed only when the complete forward label is
    // inside that split. This blocks development-boundary label leakage.
    if (labelEndTime > end) return false;
    // Purge all labels that overlap the target's information boundary.
    if (labelEndTime > causalCutoff) return false;
    return true;
  }).sort((left, right) => left.signalTime - right.signalTime || String(left.symbol).localeCompare(String(right.symbol)));
  const values = samples.map(row => Number(row.forwardReturnBps));
  const available = values.length >= minimum;
  const expectedPriceEdgeBps = available ? mean(values) : null;
  const standardErrorBps = available ? standardError(values) : null;
  const window = normalizeWindow(validationWindow, {
    trainStart: Number.isFinite(start) ? start : null,
    trainEnd: end,
    asOf: targetTime,
    horizonBars: horizon,
    purgeBars: purge,
    trainingScope: end < targetSignalTime ? 'development_only_frozen' : 'causal_prior_labels_only'
  });
  return {
    expectedPriceEdgeBps,
    standardErrorBps,
    edgeSource: available ? edgeSource : 'UNVERIFIED',
    edgeModelId,
    sampleSize: values.length,
    validationWindow: window,
    available,
    rejectionReason: available ? null : 'EDGE_INSUFFICIENT_SAMPLES',
    featureSummary: {
      side,
      regime,
      breakoutDistanceBps: candidate.breakoutDistanceBps ?? null,
      featurePolicy: 'breakout_distance_is_feature_metadata_only'
    },
    sampleTimes: samples.map(row => row.signalTime),
    sampleMeanBps: available ? expectedPriceEdgeBps : null,
    sampleStandardErrorBps: available ? standardErrorBps : null,
    units: 'bps',
    bpsConstant: BPS
  };
}
