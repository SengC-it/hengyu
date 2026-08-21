function symbolOf(value) {
  const symbol = String(value ?? '').toUpperCase();
  if (!/^[A-Z0-9]+$/.test(symbol)) throw new Error('invalid candidate symbol');
  return symbol;
}
function sideOf(value) {
  const side = String(value ?? '').toUpperCase();
  if (side !== 'BUY' && side !== 'SELL') throw new Error('invalid candidate side');
  return side;
}

function neutralCandidate({ sourceStrategy, sourceSignal, defaults = {} }) {
  if (!sourceSignal || typeof sourceSignal !== 'object') throw new Error('source signal is required');
  const symbol = symbolOf(sourceSignal.symbol);
  const side = sideOf(sourceSignal.side ?? (sourceSignal.direction === 'SHORT' ? 'SELL' : sourceSignal.direction === 'LONG' ? 'BUY' : null));
  const decisionTime = Number(sourceSignal.decisionTime ?? sourceSignal.generatedAt ?? sourceSignal.signalTime);
  const bookTime = Number(sourceSignal.bookTime ?? sourceSignal.decisionReceivedAt ?? sourceSignal.receivedAt ?? decisionTime);
  const forecastTime = Number(sourceSignal.forecastTime ?? sourceSignal.signalTime ?? decisionTime);
  const quantity = Number(sourceSignal.quantity ?? defaults.quantity);
  if (![decisionTime, bookTime, forecastTime, quantity].every(Number.isFinite)) {
    throw new Error('source signal lacks candidate timing or quantity');
  }
  const candidate = {
    experimentId: defaults.experimentId ?? sourceSignal.experimentId ?? null,
    hypothesisId: defaults.hypothesisId ?? sourceSignal.hypothesisId ?? sourceStrategy,
    sourceStrategy,
    symbol,
    side,
    quantity,
    researchNotionalUsdt: sourceSignal.researchNotionalUsdt ?? defaults.researchNotionalUsdt ?? null,
    forecastTime,
    bookTime,
    decisionTime,
    executablePrice: sourceSignal.executablePrice ?? sourceSignal.entryPrice ?? null,
    theoreticalOpen: sourceSignal.theoreticalOpen ?? null,
    stopPrice: sourceSignal.stopPrice ?? null,
    expectedExitPrice: sourceSignal.expectedExitPrice ?? null,
    maxHoldMs: defaults.maxHoldMs ?? sourceSignal.maxHoldMs ?? null,
    regime: sourceSignal.regime ?? null,
    breakoutDistanceBps: sourceSignal.breakoutDistanceBps ?? sourceSignal.distanceToBreakoutBps ?? null,
    cluster: sourceSignal.cluster ?? sourceSignal.clusterId ?? `${sourceStrategy}:${sourceSignal.signalTime ?? decisionTime}`,
    expectedFundingBps: sourceSignal.expectedFundingBps ?? 0,
    fundingStressBps: sourceSignal.fundingStressBps ?? 0
  };
  // Do not copy decision/status/action/edge fields from a strategy envelope.
  return Object.fromEntries(Object.entries(candidate).filter(([, value]) => value != null));
}

export function candidateFromH9Signal(signal, options = {}) {
  return neutralCandidate({ sourceStrategy: 'H9', sourceSignal: signal, defaults: options });
}

export function candidateFromH12Signal(signal, options = {}) {
  return neutralCandidate({ sourceStrategy: 'H12', sourceSignal: signal, defaults: options });
}

export function candidateFromProfitV3Trend(signal, options = {}) {
  return neutralCandidate({ sourceStrategy: 'PROFIT_V3_TREND', sourceSignal: signal, defaults: options });
}
