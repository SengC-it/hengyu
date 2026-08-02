const BPS = 10_000;

function requireFinite(name, value, { minimum = -Infinity, exclusiveMinimum = false } = {}) {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
  if (exclusiveMinimum ? value <= minimum : value < minimum) {
    throw new Error(`${name} is below its minimum`);
  }
}

function sideSign(side) {
  if (side === 'BUY') return 1;
  if (side === 'SELL') return -1;
  throw new Error(`unsupported side: ${side}`);
}

function normalizeLevels(levels, side) {
  if (!Array.isArray(levels) || !levels.length) throw new Error(`${side} book is empty`);
  const rows = levels.map((level, index) => {
    if (!Array.isArray(level) || level.length < 2) throw new Error(`${side} level ${index} is invalid`);
    const price = Number(level[0]);
    const quantity = Number(level[1]);
    requireFinite(`${side} price`, price, { minimum: 0, exclusiveMinimum: true });
    requireFinite(`${side} quantity`, quantity, { minimum: 0 });
    return [price, quantity];
  }).filter(([, quantity]) => quantity > 0);
  if (!rows.length) throw new Error(`${side} book has no positive quantity`);
  rows.sort((left, right) => side === 'bid' ? right[0] - left[0] : left[0] - right[0]);
  return rows;
}

function normalizeBook(book) {
  const bids = normalizeLevels(book?.bids, 'bid');
  const asks = normalizeLevels(book?.asks, 'ask');
  if (bids[0][0] >= asks[0][0]) throw new Error('book is crossed or locked');
  const midPrice = (bids[0][0] + asks[0][0]) / 2;
  return { bids, asks, midPrice };
}

export function walkBook({ side, quantity, book }) {
  const sign = sideSign(side);
  requireFinite('quantity', quantity, { minimum: 0, exclusiveMinimum: true });
  const normalized = normalizeBook(book);
  const levels = sign > 0 ? normalized.asks : normalized.bids;
  const visibleQuantity = levels.reduce((total, [, levelQuantity]) => total + levelQuantity, 0);
  let remaining = quantity;
  let quoteNotional = 0;
  let usedLevels = 0;
  let worstPrice = null;
  for (const [price, available] of levels) {
    if (remaining <= 0) break;
    const filled = Math.min(remaining, available);
    if (filled <= 0) continue;
    quoteNotional += filled * price;
    remaining -= filled;
    usedLevels++;
    worstPrice = price;
  }
  if (remaining > Math.max(1e-12, quantity * 1e-12)) {
    return {
      fillable: false,
      requestedQuantity: quantity,
      visibleQuantity,
      unfilledQuantity: remaining,
      midPrice: normalized.midPrice
    };
  }
  const vwap = quoteNotional / quantity;
  const adverseBookCostBps = sign > 0
    ? (vwap / normalized.midPrice - 1) * BPS
    : (1 - vwap / normalized.midPrice) * BPS;
  return {
    fillable: true,
    requestedQuantity: quantity,
    visibleQuantity,
    visibleBookFraction: quantity / visibleQuantity,
    quoteNotional,
    vwap,
    worstPrice,
    usedLevels,
    midPrice: normalized.midPrice,
    adverseBookCostBps: Math.max(0, adverseBookCostBps)
  };
}

export function estimateRoundTripCost({
  side,
  quantity,
  book,
  feeRatePerFill,
  bookStressMultiplier,
  impactBufferBpsPerFill,
  latencyBufferBpsPerFill
}) {
  requireFinite('feeRatePerFill', feeRatePerFill, { minimum: 0 });
  requireFinite('bookStressMultiplier', bookStressMultiplier, { minimum: 1 });
  requireFinite('impactBufferBpsPerFill', impactBufferBpsPerFill, { minimum: 0 });
  requireFinite('latencyBufferBpsPerFill', latencyBufferBpsPerFill, { minimum: 0 });
  const entry = walkBook({ side, quantity, book });
  const exit = walkBook({ side: side === 'BUY' ? 'SELL' : 'BUY', quantity, book });
  if (!entry.fillable || !exit.fillable) {
    return { fillable: false, entry, exit };
  }
  const feeBps = 2 * feeRatePerFill * BPS;
  const observedBookCostBps = entry.adverseBookCostBps + exit.adverseBookCostBps;
  const stressedBookCostBps = observedBookCostBps * bookStressMultiplier;
  const impactBufferBps = 2 * impactBufferBpsPerFill;
  const latencyBufferBps = 2 * latencyBufferBpsPerFill;
  return {
    fillable: true,
    entry,
    exit,
    feeBps,
    observedBookCostBps,
    stressedBookCostBps,
    impactBufferBps,
    latencyBufferBps,
    totalExecutionCostBps:
      feeBps + stressedBookCostBps + impactBufferBps + latencyBufferBps
  };
}

export function evaluateNetEdge({
  candidate,
  book,
  policy,
  now = Date.now()
}) {
  sideSign(candidate.side);
  for (const [name, value, minimum] of [
    ['expectedPriceEdgeBps', candidate.expectedPriceEdgeBps, -Infinity],
    ['forecastStandardErrorBps', candidate.forecastStandardErrorBps, 0],
    ['expectedFundingBps', candidate.expectedFundingBps, -Infinity],
    ['fundingStressBps', candidate.fundingStressBps, 0],
    ['quantity', candidate.quantity, Number.MIN_VALUE],
    ['forecastTime', candidate.forecastTime, 0],
    ['bookTime', candidate.bookTime, 0]
  ]) requireFinite(name, value, { minimum });
  for (const [name, value, minimum] of [
    ['confidenceZ', policy.confidenceZ, 0],
    ['minimumConservativeNetBps', policy.minimumConservativeNetBps, 0],
    ['minimumGrossToCostRatio', policy.minimumGrossToCostRatio, 1],
    ['maximumForecastAgeMs', policy.maximumForecastAgeMs, 0],
    ['maximumBookAgeMs', policy.maximumBookAgeMs, 0],
    ['maximumVisibleBookFraction', policy.maximumVisibleBookFraction, 0]
  ]) requireFinite(name, value, { minimum });
  if (policy.maximumVisibleBookFraction > 1) {
    throw new Error('maximumVisibleBookFraction must not exceed 1');
  }
  const execution = estimateRoundTripCost({
    side: candidate.side,
    quantity: candidate.quantity,
    book,
    feeRatePerFill: policy.feeRatePerFill,
    bookStressMultiplier: policy.bookStressMultiplier,
    impactBufferBpsPerFill: policy.impactBufferBpsPerFill,
    latencyBufferBpsPerFill: policy.latencyBufferBpsPerFill
  });
  const reasons = [];
  if (candidate.forecastTime > now || candidate.bookTime > now) reasons.push('future_timestamp');
  if (now - candidate.forecastTime > policy.maximumForecastAgeMs) reasons.push('stale_forecast');
  if (now - candidate.bookTime > policy.maximumBookAgeMs) reasons.push('stale_book');
  if (!execution.fillable) reasons.push('insufficient_visible_depth');

  let metrics = null;
  if (execution.fillable) {
    const visibleBookFraction = Math.max(
      execution.entry.visibleBookFraction,
      execution.exit.visibleBookFraction
    );
    if (visibleBookFraction > policy.maximumVisibleBookFraction) {
      reasons.push('visible_depth_participation');
    }
    const uncertaintyPenaltyBps = policy.confidenceZ * candidate.forecastStandardErrorBps;
    const expectedGrossEdgeBps = candidate.expectedPriceEdgeBps + candidate.expectedFundingBps;
    const expectedNetEdgeBps = expectedGrossEdgeBps - execution.totalExecutionCostBps;
    const conservativeNetEdgeBps = expectedNetEdgeBps
      - uncertaintyPenaltyBps
      - candidate.fundingStressBps;
    const grossToCostRatio = execution.totalExecutionCostBps > 0
      ? expectedGrossEdgeBps / execution.totalExecutionCostBps
      : Infinity;
    if (candidate.expectedPriceEdgeBps <= 0) reasons.push('non_positive_price_edge');
    if (grossToCostRatio < policy.minimumGrossToCostRatio) reasons.push('insufficient_cost_coverage');
    if (conservativeNetEdgeBps < policy.minimumConservativeNetBps) {
      reasons.push('insufficient_conservative_net_edge');
    }
    metrics = {
      expectedGrossEdgeBps,
      uncertaintyPenaltyBps,
      expectedNetEdgeBps,
      conservativeNetEdgeBps,
      grossToCostRatio,
      visibleBookFraction,
      execution
    };
  }
  return {
    decision: reasons.length ? 'NO_TRADE' : 'TRADE',
    reasons,
    symbol: candidate.symbol,
    side: candidate.side,
    decisionTime: now,
    metrics
  };
}

function floorToStep(value, step) {
  return Math.floor((value + step * 1e-12) / step) * step;
}

export function sizeByStopRisk({
  equity,
  riskFraction,
  stopDistanceBps,
  price,
  quantityStep,
  minimumNotional,
  maximumNotional,
  maximumGrossLeverage
}) {
  requireFinite('equity', equity, { minimum: 0, exclusiveMinimum: true });
  requireFinite('riskFraction', riskFraction, { minimum: 0, exclusiveMinimum: true });
  requireFinite('stopDistanceBps', stopDistanceBps, { minimum: 0, exclusiveMinimum: true });
  requireFinite('price', price, { minimum: 0, exclusiveMinimum: true });
  requireFinite('quantityStep', quantityStep, { minimum: 0, exclusiveMinimum: true });
  requireFinite('minimumNotional', minimumNotional, { minimum: 0 });
  requireFinite('maximumNotional', maximumNotional, { minimum: 0, exclusiveMinimum: true });
  requireFinite('maximumGrossLeverage', maximumGrossLeverage, { minimum: 0, exclusiveMinimum: true });
  const lossBudget = equity * riskFraction;
  const riskNotional = lossBudget / (stopDistanceBps / BPS);
  const leverageCap = equity * maximumGrossLeverage;
  const requestedNotional = Math.min(riskNotional, maximumNotional, leverageCap);
  const quantity = floorToStep(requestedNotional / price, quantityStep);
  const notional = quantity * price;
  const reasons = [];
  if (!(quantity > 0)) reasons.push('quantity_rounds_to_zero');
  if (notional < minimumNotional) reasons.push('below_minimum_notional');
  return {
    decision: reasons.length ? 'NO_TRADE' : 'SIZE_AVAILABLE',
    reasons,
    quantity,
    notional,
    lossAtStop: notional * stopDistanceBps / BPS,
    lossBudget
  };
}

export function evaluatePortfolioRisk({ positions, equity, limits }) {
  requireFinite('equity', equity, { minimum: 0, exclusiveMinimum: true });
  const symbols = new Set();
  let grossNotional = 0;
  let netNotional = 0;
  let betaNotional = 0;
  let lossAtStop = 0;
  const lossByCluster = new Map();
  let largestPosition = 0;
  for (const position of positions) {
    if (symbols.has(position.symbol)) throw new Error(`duplicate symbol: ${position.symbol}`);
    symbols.add(position.symbol);
    const sign = sideSign(position.side);
    requireFinite('position notional', position.notional, { minimum: 0, exclusiveMinimum: true });
    requireFinite('position beta', position.beta);
    requireFinite('position lossAtStop', position.lossAtStop, { minimum: 0 });
    grossNotional += position.notional;
    netNotional += sign * position.notional;
    betaNotional += sign * position.notional * position.beta;
    lossAtStop += position.lossAtStop;
    largestPosition = Math.max(largestPosition, position.notional);
    const cluster = position.cluster ?? position.symbol;
    lossByCluster.set(cluster, (lossByCluster.get(cluster) ?? 0) + position.lossAtStop);
  }
  const metrics = {
    positions: positions.length,
    grossLeverage: grossNotional / equity,
    absoluteNetExposureFraction: Math.abs(netNotional) / equity,
    absoluteBetaExposureFraction: Math.abs(betaNotional) / equity,
    portfolioLossFraction: lossAtStop / equity,
    largestPositionFraction: largestPosition / equity,
    largestClusterLossFraction: Math.max(0, ...lossByCluster.values()) / equity
  };
  const reasons = [];
  if (metrics.positions > limits.maximumPositions) reasons.push('maximum_positions');
  if (metrics.grossLeverage > limits.maximumGrossLeverage) reasons.push('gross_leverage');
  if (metrics.absoluteNetExposureFraction > limits.maximumNetExposureFraction) {
    reasons.push('net_exposure');
  }
  if (metrics.absoluteBetaExposureFraction > limits.maximumBetaExposureFraction) {
    reasons.push('beta_exposure');
  }
  if (metrics.portfolioLossFraction > limits.maximumPortfolioLossFraction) {
    reasons.push('portfolio_stop_loss');
  }
  if (metrics.largestPositionFraction > limits.maximumSinglePositionFraction) {
    reasons.push('single_position');
  }
  if (metrics.largestClusterLossFraction > limits.maximumClusterLossFraction) {
    reasons.push('cluster_stop_loss');
  }
  return {
    decision: reasons.length ? 'NO_TRADE' : 'PORTFOLIO_ALLOWED',
    reasons,
    metrics
  };
}
