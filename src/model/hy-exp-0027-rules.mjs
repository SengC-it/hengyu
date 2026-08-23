const RULE_DEFINITIONS = Object.freeze({
  A: Object.freeze({
    id: 'RULE_A_CHANNEL_DISTANCE_Q75',
    featureName: 'sideAdjustedPrior60ChannelDistanceOverATR20',
    featureIndex: 7
  }),
  B: Object.freeze({
    id: 'RULE_B_BREAKOUT_DISTANCE_Q75',
    featureName: 'sideAdjustedBreakoutDistanceOverATR20',
    featureIndex: 0
  })
});

export const HY_EXP_0027_RULES = RULE_DEFINITIONS;
export const HY_EXP_0027_RULE_EDGE_MODEL_ID = 'HY-EXP-0027-EMPIRICAL-RULE-DIAGNOSTIC';
export const HY_EXP_0027_RULE_EDGE_SOURCE = 'HENGYU-HY-EXP-0027-TRAINING-Q75-RULE-MEAN-DIAGNOSTIC';
export const HY_EXP_0027_MINIMUM_TRAINING_ROWS = 20;

function finite(value) {
  return value != null && Number.isFinite(Number(value));
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function standardError(values) {
  if (values.length < 2) return null;
  const center = mean(values);
  const deviation = Math.sqrt(values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1));
  return deviation / Math.sqrt(values.length);
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

function featureValue(row, rule) {
  const value = row?.features?.[rule.featureIndex];
  return finite(value) ? Number(value) : null;
}

function grossReturn(row) {
  const value = row?.label?.grossPriceReturnBps;
  return finite(value) ? Number(value) : null;
}

function clusteredStandardError(rows) {
  const byMonth = new Map();
  for (const row of rows) {
    const value = grossReturn(row);
    if (value == null) continue;
    const key = monthKey(row.signalTime);
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(value);
  }
  const monthlyMeans = [...byMonth.values()].map(values => mean(values));
  const error = standardError(monthlyMeans);
  return error;
}

export function trainingQ75(rows, rule) {
  if (!RULE_DEFINITIONS[rule]) throw new Error(`unknown HY-EXP-0027 rule: ${rule}`);
  return percentile(rows.map(row => featureValue(row, RULE_DEFINITIONS[rule])).filter(value => value != null), 0.75);
}

export function fitRuleDiagnostic(rows, rule, {
  q75 = trainingQ75(rows, rule),
  minimumRows = HY_EXP_0027_MINIMUM_TRAINING_ROWS,
  validationWindow = null
} = {}) {
  const definition = RULE_DEFINITIONS[rule];
  if (!definition) throw new Error(`unknown HY-EXP-0027 rule: ${rule}`);
  const qualifying = rows.filter(row => {
    const feature = featureValue(row, definition);
    return feature != null && q75 != null && feature >= q75 && grossReturn(row) != null;
  });
  const returns = qualifying.map(grossReturn);
  const error = standardError(returns);
  const available = returns.length >= minimumRows && error != null;
  return {
    available,
    rule,
    ruleId: definition.id,
    featureName: definition.featureName,
    featureIndex: definition.featureIndex,
    trainingQ75: q75,
    minimumRows,
    sampleSize: returns.length,
    expectedPriceEdgeBps: available ? mean(returns) : null,
    standardErrorBps: available ? error : null,
    standardErrorOfMeanBps: available ? error : null,
    monthlyClusteredStandardErrorBps: available ? clusteredStandardError(qualifying) : null,
    edgeModelId: HY_EXP_0027_RULE_EDGE_MODEL_ID,
    edgeSource: HY_EXP_0027_RULE_EDGE_SOURCE,
    validationWindow,
    rejectionReason: available ? null : 'INSUFFICIENT_TRAINING_RULE_SAMPLE'
  };
}

export function predictRuleDiagnostic(model, row, validationWindow = model?.validationWindow ?? null) {
  const definition = RULE_DEFINITIONS[model?.rule];
  const feature = definition ? featureValue(row, definition) : null;
  const qualifies = model?.available === true && feature != null && feature >= model.trainingQ75;
  return {
    available: qualifies,
    rule: model?.rule ?? null,
    ruleId: model?.ruleId ?? null,
    featureName: model?.featureName ?? null,
    featureValue: feature,
    trainingQ75: model?.trainingQ75 ?? null,
    expectedPriceEdgeBps: qualifies ? model.expectedPriceEdgeBps : null,
    standardErrorBps: qualifies ? model.standardErrorBps : null,
    standardErrorOfMeanBps: qualifies ? model.standardErrorOfMeanBps : null,
    monthlyClusteredStandardErrorBps: qualifies ? model.monthlyClusteredStandardErrorBps : null,
    edgeModelId: model?.edgeModelId ?? HY_EXP_0027_RULE_EDGE_MODEL_ID,
    edgeSource: model?.edgeSource ?? HY_EXP_0027_RULE_EDGE_SOURCE,
    sampleSize: model?.sampleSize ?? 0,
    validationWindow,
    rejectionReason: qualifies ? null : feature == null ? 'MISSING_RULE_FEATURE' : 'RULE_Q75_NOT_MET'
  };
}
