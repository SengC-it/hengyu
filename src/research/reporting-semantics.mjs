export const EMPTY_SAMPLE_NOT_EVALUABLE = 'EMPTY_SAMPLE_NOT_EVALUABLE';

export function emptySampleRiskMetrics(advisoryCount) {
  if (advisoryCount !== 0) return null;
  return {
    maxMtmDrawdown: null,
    maxMtmDrawdownBps: null,
    cvar95LossFraction: null,
    cvar95LossBps: null,
    riskMetricStatus: EMPTY_SAMPLE_NOT_EVALUABLE
  };
}
