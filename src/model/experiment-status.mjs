export const EXPERIMENT_VALIDATION = Object.freeze({
  'HY-EXP-0018': Object.freeze({
    experimentId: 'HY-EXP-0018',
    pass: false,
    status: 'FAILED',
    evidenceClass: 'D0_ITERATED_POST_HOC_HISTORICAL_DEVELOPMENT',
    failures: Object.freeze(['positiveMonthShare']),
    reason: 'Historical H12 failed the positive-month-share promotion gate; it is not a validated profitable strategy.'
  })
});

export function experimentValidation(experimentId) {
  const value = EXPERIMENT_VALIDATION[String(experimentId ?? '').toUpperCase()];
  return value ? { ...value, failures: [...value.failures] } : {
    experimentId: String(experimentId ?? 'UNKNOWN'),
    pass: false,
    status: 'UNKNOWN',
    evidenceClass: 'UNKNOWN',
    failures: ['missing_validation_record'],
    reason: 'No validation record is available.'
  };
}
