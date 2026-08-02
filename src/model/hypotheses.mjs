const DEFAULTS = Object.freeze({
  h1: {
    minimumAbsolutePressureBps: 5,
    minimumRecoveryRatio: 0.8,
    eventImpulseMultiplier: 0.25,
    forecastStandardErrorBps: 20,
    fundingStressBps: 1,
    maxHoldMs: 900_000
  },
  h2: {
    minimumAbsoluteFundingBps: 5,
    minimumAbsoluteOiChangeBps: 2,
    fundingEdgeMultiplier: 0.35,
    oiEdgeMultiplier: 0.1,
    forecastStandardErrorBps: 15,
    fundingStressBps: 2,
    maxHoldMs: 3_600_000
  },
  h3: {
    minimumAbsoluteResidualBps: 8,
    residualEdgeMultiplier: 0.25,
    forecastStandardErrorBps: 18,
    fundingStressBps: 1,
    maxHoldMs: 3_600_000
  },
  h5: {
    minimumAbsoluteBtcShockBps: 30,
    minimumAbsoluteResponseGapBps: 8,
    responseGapEdgeMultiplier: 0.25,
    forecastStandardErrorBps: 20,
    fundingStressBps: 1,
    maxHoldMs: 3_600_000
  }
});

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

function symbolOf(value) {
  const symbol = String(value ?? '').toUpperCase();
  if (!/^[A-Z0-9]+$/.test(symbol)) throw new Error('invalid symbol');
  return symbol;
}

function sideFromSign(value) {
  return value > 0 ? 'BUY' : 'SELL';
}

function merge(id, policy) {
  return { ...DEFAULTS[id], ...(policy?.[id] ?? {}) };
}

function base({ hypothesisId, symbol, side, quantity, now, forecastTime, bookTime, expectedPriceEdgeBps, expectedFundingBps = 0, fundingStressBps, forecastStandardErrorBps, stopPrice = null, expectedExitPrice = null, maxHoldMs }) {
  return {
    hypothesisId,
    symbol: symbolOf(symbol),
    side,
    quantity: finite('research quantity', quantity, { minimum: 0, exclusiveMinimum: true }),
    expectedPriceEdgeBps: finite('expected price edge', expectedPriceEdgeBps, { minimum: 0 }),
    forecastStandardErrorBps: finite('forecast standard error', forecastStandardErrorBps, { minimum: 0 }),
    expectedFundingBps: finite('expected funding', expectedFundingBps),
    fundingStressBps: finite('funding stress', fundingStressBps, { minimum: 0 }),
    forecastTime: integer('forecast time', forecastTime ?? now),
    bookTime: integer('book time', bookTime ?? now),
    decisionTime: integer('decision time', now),
    stopPrice,
    expectedExitPrice,
    maxHoldMs: integer('maximum hold', maxHoldMs, { minimum: 1 })
  };
}

function noCandidate(hypothesisId, reasons, context = {}) {
  return {
    hypothesisId,
    status: 'NO_CANDIDATE',
    reasons: [...new Set(reasons)],
    ...context
  };
}

export function buildH1Candidate({ event, quantity, now = Date.now(), policy } = {}) {
  const p = merge('h1', policy);
  if (!event || typeof event !== 'object') throw new Error('H1 event is required');
  const pressureBps = finite('H1 pressureBps', event.pressureBps ?? event.pressure);
  const recoveryRatio = finite('H1 recoveryRatio', event.recoveryRatio, { minimum: 0 });
  const impulseBps = finite('H1 eventImpulseBps', event.eventImpulseBps ?? event.eventImpulse, { minimum: 0 });
  const reasons = [];
  if (Math.abs(pressureBps) < p.minimumAbsolutePressureBps) reasons.push('pressure_below_threshold');
  if (recoveryRatio < p.minimumRecoveryRatio) reasons.push('insufficient_recovery');
  if (!(impulseBps > 0)) reasons.push('missing_event_impulse');
  if (reasons.length) return noCandidate('H1', reasons, { pressureBps, recoveryRatio, impulseBps });
  const side = pressureBps < 0 ? 'BUY' : 'SELL';
  return {
    status: 'CANDIDATE',
    candidate: base({
      hypothesisId: 'H1',
      symbol: event.symbol,
      side,
      quantity,
      now,
      forecastTime: event.forecastTime ?? event.decisionTime ?? now,
      bookTime: event.bookTime ?? event.decisionTime ?? now,
      expectedPriceEdgeBps: impulseBps * p.eventImpulseMultiplier * Math.min(recoveryRatio, 1),
      expectedFundingBps: event.expectedFundingBps ?? 0,
      fundingStressBps: p.fundingStressBps,
      forecastStandardErrorBps: p.forecastStandardErrorBps,
      stopPrice: event.stopPrice ?? null,
      expectedExitPrice: event.expectedExitPrice ?? null,
      maxHoldMs: p.maxHoldMs
    }),
    features: { pressureBps, recoveryRatio, impulseBps }
  };
}

export function buildH2Candidate({ observation, quantity, now = Date.now(), policy } = {}) {
  const p = merge('h2', policy);
  if (!observation || typeof observation !== 'object') throw new Error('H2 observation is required');
  const fundingBps = finite('H2 fundingBps', observation.fundingBps);
  const oiChangeBps = finite('H2 oiChangeBps', observation.oiChangeBps);
  const reasons = [];
  if (Math.abs(fundingBps) < p.minimumAbsoluteFundingBps) reasons.push('funding_below_threshold');
  if (Math.abs(oiChangeBps) < p.minimumAbsoluteOiChangeBps) reasons.push('oi_change_below_threshold');
  const crowdedLong = fundingBps > 0 && oiChangeBps > 0;
  const crowdedShort = fundingBps < 0 && oiChangeBps < 0;
  if (!crowdedLong && !crowdedShort) reasons.push('funding_oi_not_crowded');
  if (reasons.length) return noCandidate('H2', reasons, { fundingBps, oiChangeBps });
  const side = crowdedLong ? 'SELL' : 'BUY';
  const edge = Math.abs(fundingBps) * p.fundingEdgeMultiplier + Math.abs(oiChangeBps) * p.oiEdgeMultiplier;
  return {
    status: 'CANDIDATE',
    candidate: base({
      hypothesisId: 'H2',
      symbol: observation.symbol,
      side,
      quantity,
      now,
      forecastTime: observation.forecastTime ?? now,
      bookTime: observation.bookTime ?? now,
      expectedPriceEdgeBps: edge,
      expectedFundingBps: observation.expectedFundingBps ?? 0,
      fundingStressBps: p.fundingStressBps,
      forecastStandardErrorBps: p.forecastStandardErrorBps,
      stopPrice: observation.stopPrice ?? null,
      expectedExitPrice: observation.expectedExitPrice ?? null,
      maxHoldMs: p.maxHoldMs
    }),
    features: { fundingBps, oiChangeBps, crowdedLong, crowdedShort }
  };
}

export function buildH3Candidate({ observation, quantity, now = Date.now(), policy } = {}) {
  const p = merge('h3', policy);
  if (!observation || typeof observation !== 'object') throw new Error('H3 observation is required');
  const assetReturnBps = finite('H3 asset return', observation.assetReturnBps);
  const marketReturnBps = finite('H3 market return', observation.marketReturnBps);
  const beta = finite('H3 beta', observation.beta);
  const residualBps = assetReturnBps - beta * marketReturnBps;
  if (Math.abs(residualBps) < p.minimumAbsoluteResidualBps) {
    return noCandidate('H3', ['residual_below_threshold'], { residualBps, beta });
  }
  const side = sideFromSign(-residualBps);
  return {
    status: 'CANDIDATE',
    candidate: base({
      hypothesisId: 'H3',
      symbol: observation.symbol,
      side,
      quantity,
      now,
      forecastTime: observation.forecastTime ?? now,
      bookTime: observation.bookTime ?? now,
      expectedPriceEdgeBps: Math.abs(residualBps) * p.residualEdgeMultiplier,
      expectedFundingBps: observation.expectedFundingBps ?? 0,
      fundingStressBps: p.fundingStressBps,
      forecastStandardErrorBps: p.forecastStandardErrorBps,
      stopPrice: observation.stopPrice ?? null,
      expectedExitPrice: observation.expectedExitPrice ?? null,
      maxHoldMs: p.maxHoldMs
    }),
    features: { assetReturnBps, marketReturnBps, beta, residualBps }
  };
}

export function buildH5Candidate({ observation, quantity, now = Date.now(), policy } = {}) {
  const p = merge('h5', policy);
  if (!observation || typeof observation !== 'object') throw new Error('H5 observation is required');
  const btcShockBps = finite('H5 BTC shock', observation.btcShockBps);
  const symbolReturnBps = finite('H5 symbol return', observation.symbolReturnBps);
  const beta = finite('H5 beta', observation.beta);
  const expectedResponseBps = beta * btcShockBps;
  const responseGapBps = expectedResponseBps - symbolReturnBps;
  const reasons = [];
  if (Math.abs(btcShockBps) < p.minimumAbsoluteBtcShockBps) reasons.push('btc_shock_below_threshold');
  if (Math.abs(responseGapBps) < p.minimumAbsoluteResponseGapBps) reasons.push('response_gap_below_threshold');
  if (reasons.length) return noCandidate('H5', reasons, { btcShockBps, responseGapBps, beta });
  const side = sideFromSign(responseGapBps);
  return {
    status: 'CANDIDATE',
    candidate: base({
      hypothesisId: 'H5',
      symbol: observation.symbol,
      side,
      quantity,
      now,
      forecastTime: observation.forecastTime ?? now,
      bookTime: observation.bookTime ?? now,
      expectedPriceEdgeBps: Math.abs(responseGapBps) * p.responseGapEdgeMultiplier,
      expectedFundingBps: observation.expectedFundingBps ?? 0,
      fundingStressBps: p.fundingStressBps,
      forecastStandardErrorBps: p.forecastStandardErrorBps,
      stopPrice: observation.stopPrice ?? null,
      expectedExitPrice: observation.expectedExitPrice ?? null,
      maxHoldMs: p.maxHoldMs
    }),
    features: { btcShockBps, symbolReturnBps, beta, expectedResponseBps, responseGapBps }
  };
}

export function buildHypothesisCandidate({ hypothesisId, ...options }) {
  const id = String(hypothesisId ?? '').toUpperCase();
  if (id === 'H1') return buildH1Candidate(options);
  if (id === 'H2') return buildH2Candidate(options);
  if (id === 'H3') return buildH3Candidate(options);
  if (id === 'H5') return buildH5Candidate(options);
  throw new Error(`unsupported hypothesis: ${hypothesisId}`);
}

