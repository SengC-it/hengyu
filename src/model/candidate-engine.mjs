import { buildNetEdgeAdvisorySignal } from './net-edge-advisory.mjs';
import { evaluatePortfolioRisk } from './net-edge.mjs';
import { netEdgeAdvisoryPolicy, NET_EDGE_CONFIG } from './policy-config.mjs';

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

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function sideOf(value) {
  const side = String(value ?? '').toUpperCase();
  if (side !== 'BUY' && side !== 'SELL') throw new Error('invalid candidate side');
  return side;
}

function portfolioLimits(policy) {
  const risk = NET_EDGE_CONFIG.risk ?? {};
  return {
    maximumPositions: risk.maximumPositions ?? 5,
    maximumGrossLeverage: risk.maximumGrossLeverage ?? 1,
    maximumNetExposureFraction: risk.maximumNetExposureFraction ?? 0.2,
    maximumBetaExposureFraction: risk.maximumBetaExposureFraction ?? 0.2,
    maximumPortfolioLossFraction: risk.maximumPortfolioLossFraction ?? 0.02,
    maximumSinglePositionFraction: risk.maximumSinglePositionFraction ?? 0.5,
    maximumClusterLossFraction: risk.maximumClusterLossFraction ?? 0.01,
    ...(policy?.portfolioLimits ?? {})
  };
}

function validateCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') throw new Error('candidate is required');
  // A strategy may describe a hypothesis, but it may not smuggle a decision
  // into the shared engine. Only the gates below create an advisory.
  for (const field of ['decision', 'status', 'alertLevel', 'action']) {
    if (Object.prototype.hasOwnProperty.call(candidate, field)) {
      throw new Error(`candidate must not contain ${field}`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(candidate, 'expectedPriceEdgeBps')
    || Object.prototype.hasOwnProperty.call(candidate, 'forecastStandardErrorBps')
    || Object.prototype.hasOwnProperty.call(candidate, 'edgeSource')
    || Object.prototype.hasOwnProperty.call(candidate, 'edgeModelId')) {
    if (!candidate.edge || typeof candidate.edge !== 'object') {
      throw new Error('edge fields must be supplied by Edge Model, not Candidate');
    }
  }
  const symbol = String(candidate.symbol ?? '').toUpperCase();
  if (!/^[A-Z0-9]+$/.test(symbol)) throw new Error('invalid candidate symbol');
  sideOf(candidate.side);
  finite('candidate quantity', candidate.quantity, { minimum: 0, exclusiveMinimum: true });
  integer('candidate decisionTime', candidate.decisionTime);
  integer('candidate forecastTime', candidate.forecastTime);
  integer('candidate bookTime', candidate.bookTime);
  return { ...candidate, symbol, side: sideOf(candidate.side) };
}

function normalizeEdge(candidate, suppliedEdge, now) {
  const edge = suppliedEdge ?? candidate.edge ?? null;
  if (!edge || typeof edge !== 'object') {
    return {
      expectedPriceEdgeBps: null,
      standardErrorBps: null,
      edgeSource: 'UNVERIFIED',
      edgeModelId: null,
      sampleSize: 0,
      validationWindow: { asOf: now, method: 'missing_edge_model' },
      available: false,
      rejectionReason: 'EDGE_MODEL_MISSING'
    };
  }
  const expected = edge.expectedPriceEdgeBps == null ? null : Number(edge.expectedPriceEdgeBps);
  const standardError = edge.standardErrorBps ?? edge.forecastStandardErrorBps;
  const parsedStandardError = standardError == null ? null : Number(standardError);
  const sampleSize = Number(edge.sampleSize ?? 0);
  const available = edge.available === true
    && expected != null
    && Number.isFinite(expected)
    && parsedStandardError != null
    && Number.isFinite(parsedStandardError)
    && parsedStandardError >= 0
    && typeof edge.edgeSource === 'string'
    && edge.edgeSource.length > 0
    && typeof edge.edgeModelId === 'string'
    && edge.edgeModelId.length > 0
    && Number.isSafeInteger(sampleSize)
    && sampleSize > 0;
  return {
    expectedPriceEdgeBps: available ? expected : null,
    standardErrorBps: parsedStandardError != null && Number.isFinite(parsedStandardError)
      ? Math.max(0, parsedStandardError)
      : null,
    edgeSource: available ? edge.edgeSource : 'UNVERIFIED',
    edgeModelId: edge.edgeModelId ?? null,
    sampleSize: Number.isSafeInteger(sampleSize) ? sampleSize : 0,
    validationWindow: edge.validationWindow ?? null,
    available,
    rejectionReason: available ? null : (edge.rejectionReason ?? 'EDGE_UNVERIFIED'),
    featureSummary: edge.featureSummary ?? null
  };
}

function defaultPortfolioContext({ candidate, advisory, policy, openPositions = [] }) {
  const risk = NET_EDGE_CONFIG.risk ?? {};
  const equity = finite(
    'research portfolio equity',
    policy.researchEquityUsdt ?? risk.researchEquityUsdt ?? 100_000,
    { minimum: 0, exclusiveMinimum: true }
  );
  const entryPrice = Number(advisory.reference?.entryPrice);
  const positions = [...openPositions];
  if (entryPrice > 0) {
    const notional = finite(
      'research candidate notional',
      candidate.researchNotionalUsdt ?? candidate.quantity * entryPrice,
      { minimum: 0, exclusiveMinimum: true }
    );
    const stopPrice = candidate.stopPrice == null ? null : Number(candidate.stopPrice);
    const stopDistanceBps = stopPrice == null ? 0 : Math.abs(stopPrice - entryPrice) / entryPrice * 10_000;
    positions.push({
      symbol: candidate.symbol,
      side: candidate.side,
      notional,
      beta: candidate.beta ?? 1,
      lossAtStop: notional * stopDistanceBps / 10_000,
      cluster: candidate.cluster ?? candidate.symbol
    });
  }
  return { equity, positions, limits: portfolioLimits(policy) };
}

/**
 * The only shared decision path in Profit Model V3:
 * Candidate -> Edge Model -> Net Edge Gate -> Portfolio Risk Gate -> Advisory.
 */
export function evaluateCandidate({
  candidate: suppliedCandidate,
  edgeModel = null,
  edge = null,
  book,
  now = Date.now(),
  policy: suppliedPolicy = {},
  portfolio = null,
  openPositions = []
} = {}) {
  const candidate = validateCandidate(suppliedCandidate);
  const policy = netEdgeAdvisoryPolicy({
    experimentId: candidate.experimentId ?? 'HY-EXP-0019',
    ...(suppliedPolicy ?? {})
  });
  const modelEdge = edge ?? (typeof edgeModel === 'function'
    ? edgeModel(candidate)
    : edgeModel && typeof edgeModel.estimate === 'function'
      ? edgeModel.estimate(candidate)
      : null);
  const normalizedEdge = normalizeEdge(candidate, modelEdge, now);
  const gatedCandidate = {
    ...candidate,
    expectedPriceEdgeBps: normalizedEdge.expectedPriceEdgeBps,
    forecastStandardErrorBps: normalizedEdge.standardErrorBps ?? 0,
    expectedFundingBps: Number(candidate.expectedFundingBps ?? 0),
    fundingStressBps: Math.max(0, Number(candidate.fundingStressBps ?? 0)),
    edgeSource: normalizedEdge.edgeSource,
    edgeModelId: normalizedEdge.edgeModelId
  };
  finite('expectedFundingBps', gatedCandidate.expectedFundingBps);
  finite('fundingStressBps', gatedCandidate.fundingStressBps, { minimum: 0 });
  const netEdge = buildNetEdgeAdvisorySignal({
    candidate: gatedCandidate,
    book,
    policy,
    now
  });
  const portfolioContext = portfolio ?? defaultPortfolioContext({
    candidate: gatedCandidate,
    advisory: netEdge,
    policy,
    openPositions
  });
  const portfolioGate = evaluatePortfolioRisk(portfolioContext);
  const portfolioReasons = portfolioGate.reasons.map(reason => `portfolio_${reason}`);
  const reasons = unique([
    ...(normalizedEdge.rejectionReason ? [normalizedEdge.rejectionReason] : []),
    ...(netEdge.reasons ?? []),
    ...portfolioReasons
  ]);
  const allowed = normalizedEdge.available
    && netEdge.decision === 'TRADE'
    && portfolioGate.decision === 'PORTFOLIO_ALLOWED';
  const decision = allowed ? 'ADVISORY' : 'NO_TRADE';
  const advisory = {
    ...netEdge,
    decision,
    gateDecision: netEdge.decision,
    status: decision,
    alertLevel: allowed ? netEdge.alertLevel : 'NONE',
    action: allowed ? netEdge.action : null,
    edge: normalizedEdge,
    rejectionReasons: reasons,
    delivery: {
      ...netEdge.delivery,
      email: allowed ? netEdge.delivery.email : 'NONE'
    },
    paperOnly: true,
    liveOrdersEnabled: false
  };
  return {
    schemaVersion: 1,
    candidate: {
      ...candidate,
      edge: normalizedEdge,
      // These are observations for accounting, never inputs to the decision.
      executablePrice: candidate.executablePrice ?? netEdge.reference?.entryPrice ?? null,
      costs: netEdge.costs ?? null,
      funding: candidate.funding ?? {
        expectedFundingBps: gatedCandidate.expectedFundingBps,
        fundingStressBps: gatedCandidate.fundingStressBps,
        realizedFundingPnlBps: null,
        holdingPeriodMs: null
      },
      maeBps: candidate.maeBps ?? null,
      mfeBps: candidate.mfeBps ?? null,
      markToMarketDrawdownBps: candidate.markToMarketDrawdownBps ?? null
    },
    edge: normalizedEdge,
    netEdge,
    portfolio: portfolioGate,
    decision,
    reasons,
    advisory
  };
}
