import { createHash } from 'node:crypto';
import { evaluateNetEdge } from './net-edge.mjs';
import { netEdgeAdvisoryPolicy } from './policy-config.mjs';

export const DEFAULT_NET_EDGE_ADVISORY_POLICY = Object.freeze(netEdgeAdvisoryPolicy({
  experimentId: 'HY-EXP-0014'
}));

function integer(name, value, { minimum = 0 } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`invalid ${name}`);
  return parsed;
}

function finite(name, value, { minimum = -Infinity, exclusiveMinimum = false } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (exclusiveMinimum ? parsed <= minimum : parsed < minimum)) {
    throw new Error(`invalid ${name}`);
  }
  return parsed;
}

function symbolOf(value) {
  const symbol = String(value ?? '').toUpperCase();
  if (!/^[A-Z0-9]+$/.test(symbol)) throw new Error('invalid symbol');
  return symbol;
}

function sideOf(value) {
  const side = String(value ?? '').toUpperCase();
  if (side !== 'BUY' && side !== 'SELL') throw new Error('invalid side');
  return side;
}

function actionFor(side) {
  return side === 'BUY' ? 'REVIEW_BUY' : 'REVIEW_SELL';
}

function mergePolicy(policy) {
  return { ...DEFAULT_NET_EDGE_ADVISORY_POLICY, ...(policy ?? {}) };
}

function quoteFromExecution(execution, book, side) {
  const entry = execution?.entry;
  const exit = execution?.exit;
  const oppositeLevels = side === 'BUY' ? book?.asks : book?.bids;
  return {
    entryPrice: entry?.vwap ?? null,
    exitReferencePrice: exit?.vwap ?? null,
    oppositeBestPrice: oppositeLevels?.[0]?.[0] == null ? null : Number(oppositeLevels[0][0]),
    bidPrice: book?.bids?.[0]?.[0] == null ? null : Number(book.bids[0][0]),
    askPrice: book?.asks?.[0]?.[0] == null ? null : Number(book.asks[0][0])
  };
}

function alertLevel(result, candidate, policy) {
  const metrics = result.metrics;
  if (!metrics) return 'NONE';
  const hardDataReasons = new Set([
    'future_timestamp',
    'stale_forecast',
    'stale_book',
    'insufficient_visible_depth',
    'visible_depth_participation'
  ]);
  if ((result.reasons ?? []).some(reason => hardDataReasons.has(reason))) return 'NONE';
  if (metrics.conservativeNetEdgeBps >= policy.strongMinConservativeNetBps
    && metrics.grossToCostRatio >= policy.strongMinGrossToCostRatio) return 'STRONG';
  if (metrics.conservativeNetEdgeBps >= policy.mediumMinConservativeNetBps
    && metrics.grossToCostRatio >= policy.mediumMinGrossToCostRatio) return 'MEDIUM';
  if (candidate.expectedPriceEdgeBps > 0 && metrics.conservativeNetEdgeBps > 0) return 'OBSERVE';
  return 'NONE';
}

function signalId({ experimentId, hypothesisId, symbol, side, decisionTime }) {
  const raw = `${experimentId}:${hypothesisId ?? 'UNSPECIFIED'}:${symbol}:${side}:${decisionTime}`;
  return `${experimentId}:${createHash('sha256').update(raw).digest('hex').slice(0, 24)}`;
}

function publicReasons(result) {
  return [...new Set(result.reasons ?? [])];
}

/**
 * Evaluate a research candidate and return a read-only advisory envelope.
 * `candidate.quantity` is an internal fixed research quantity used solely for
 * book walking; it is deliberately never included in the returned envelope.
 */
export function buildNetEdgeAdvisorySignal({
  candidate,
  book,
  policy: suppliedPolicy = DEFAULT_NET_EDGE_ADVISORY_POLICY,
  now = Date.now()
}) {
  if (!candidate || typeof candidate !== 'object') throw new Error('candidate is required');
  const policy = mergePolicy(suppliedPolicy);
  const symbol = symbolOf(candidate.symbol);
  const side = sideOf(candidate.side);
  const decisionTime = integer('decisionTime', candidate.decisionTime ?? now);
  const generatedAt = integer('generatedAt', now);
  if (decisionTime > generatedAt) throw new Error('decisionTime is in the future');
  const result = evaluateNetEdge({
    candidate: { ...candidate, symbol, side },
    book,
    policy,
    now: generatedAt
  });
  const level = alertLevel(result, candidate, policy);
  const validUntil = generatedAt + integer('signalValidityMs', policy.signalValidityMs, { minimum: 1 });
  const researchExpiryMs = integer('researchExpiryMs', policy.researchExpiryMs, { minimum: 1 });
  const candidateHoldMs = candidate.maxHoldMs == null
    ? researchExpiryMs
    : integer('candidate maximum hold', candidate.maxHoldMs, { minimum: 1 });
  const expiresAt = decisionTime + Math.min(researchExpiryMs, candidateHoldMs);
  const execution = result.metrics?.execution ?? null;
  const quote = quoteFromExecution(execution, book, side);
  const takeProfitPrice = candidate.expectedExitPrice ?? null;
  const advisory = {
    schemaVersion: 1,
    signalId: signalId({
      experimentId: policy.experimentId,
      hypothesisId: candidate.hypothesisId,
      symbol,
      side,
      decisionTime
    }),
    experimentId: policy.experimentId,
    hypothesisId: candidate.hypothesisId ?? null,
    modelId: policy.modelId,
    evidenceClass: policy.evidenceClass,
    status: result.decision === 'TRADE' ? 'ADVISORY' : level === 'OBSERVE' ? 'OBSERVE' : 'NO_TRADE',
    decision: result.decision,
    alertLevel: level,
    action: level === 'NONE' ? null : actionFor(side),
    symbol,
    side,
    decisionTime,
    generatedAt,
    validUntil,
    expiresAt,
    reference: {
      entryPrice: quote.entryPrice,
      takeProfitPrice,
      exitReferencePrice: takeProfitPrice,
      oppositeBestPrice: quote.oppositeBestPrice,
      bidPrice: quote.bidPrice,
      askPrice: quote.askPrice,
      stopPrice: candidate.stopPrice ?? null,
      maximumHoldMs: candidate.maxHoldMs ?? researchExpiryMs
    },
      costs: result.metrics ? {
        expectedPriceEdgeBps: finite('expectedPriceEdgeBps', candidate.expectedPriceEdgeBps),
        expectedFundingBps: finite('expectedFundingBps', candidate.expectedFundingBps),
        expectedGrossEdgeBps: result.metrics.expectedGrossEdgeBps,
        feeBps: result.metrics.execution.feeBps,
        spreadBps: result.metrics.execution.spreadBps,
        slippageBps: result.metrics.execution.slippageBps,
        observedBookCostBps: result.metrics.execution.observedBookCostBps,
        stressedBookCostBps: result.metrics.execution.stressedBookCostBps,
        impactBps: result.metrics.execution.impactBufferBps,
        executionCostBps: result.metrics.execution.totalExecutionCostBps,
        expectedNetEdgeBps: result.metrics.expectedNetEdgeBps,
        uncertaintyPenaltyBps: result.metrics.uncertaintyPenaltyBps,
      fundingStressBps: finite('fundingStressBps', candidate.fundingStressBps, { minimum: 0 }),
      conservativeNetEdgeBps: result.metrics.conservativeNetEdgeBps,
      grossToCostRatio: result.metrics.grossToCostRatio,
      visibleBookFraction: result.metrics.visibleBookFraction
    } : null,
    reasons: publicReasons(result),
    delivery: {
      web: true,
      email: level === 'STRONG' || level === 'MEDIUM' ? (level === 'STRONG' ? 'IMMEDIATE' : 'DIGEST_15M') : 'NONE',
      dedupeKey: `${policy.experimentId}:${symbol}:${side}:${decisionTime}:${level}`
    },
    manualOnly: {
      requiresHumanConfirmation: true,
      autoExecution: false,
      orderPlacement: false,
      accountAccess: false,
      quantityProvided: false,
      leverageProvided: false,
      accountRiskProvided: false
    },
    warning: 'Research advisory only; no account sizing, leverage, order instruction, or profitability claim.'
  };
  return advisory;
}

export function buildModelSimulationRecord({ signal, outcome }) {
  if (!signal || typeof signal !== 'object') throw new Error('signal is required');
  if (!outcome || typeof outcome !== 'object') throw new Error('outcome is required');
  const status = String(outcome.status ?? '').toUpperCase();
  if (!['OPEN', 'CLOSED', 'REJECTED'].includes(status)) throw new Error('simulation outcome status is invalid');
  const row = {
    schemaVersion: 1,
    recordType: 'MODEL_SIMULATION',
    signalId: signal.signalId,
    experimentId: signal.experimentId,
    hypothesisId: signal.hypothesisId,
    symbol: signal.symbol,
    side: signal.side,
    alertLevel: signal.alertLevel,
    status: status === 'REJECTED' ? 'INVALID' : status,
    entryTime: outcome.entryTime ?? null,
    exitTime: outcome.exitTime ?? null,
    signalToFillMs: outcome.signalToFillMs ?? null,
    exitReason: outcome.exitReason ?? null,
    markTime: outcome.markTime ?? null,
    markPrice: outcome.markPrice ?? null,
    markNetPnl: outcome.markNetPnl ?? null,
    maeBps: outcome.maeBps ?? null,
    mfeBps: outcome.mfeBps ?? null,
    markToMarketDrawdownBps: outcome.markToMarketDrawdownBps ?? null,
    holdingPeriodMs: outcome.holdingPeriodMs ?? outcome.holdMs ?? null,
    fundingEvents: outcome.fundingEvents ?? 0,
    fundingPnlBps: outcome.fundingPnlBps ?? null,
    fundingCostBps: outcome.fundingCostBps ?? null,
    grossPricePnl: outcome.grossPricePnl ?? null,
    fundingPnl: outcome.fundingPnl ?? null,
    fees: outcome.fees ?? null,
    netPnl: outcome.netPnl ?? null,
    stressNetPnl: outcome.stressNetPnl ?? null,
    rejectionReason: outcome.reason ?? null,
    humanFeedbackRecorded: false,
    accountDataUsed: false
  };
  return row;
}

export function advisoryFreshness(signal, { now = Date.now() } = {}) {
  const current = integer('freshness time', now);
  const generatedAt = integer('generated time', signal?.generatedAt);
  const validUntil = integer('valid-until time', signal?.validUntil);
  if (current < generatedAt) return { status: 'NOT_YET_GENERATED', fresh: false };
  if (current > validUntil) return { status: 'EXPIRED', fresh: false };
  return { status: 'FRESH', fresh: true };
}

export function conservativeEdgeBps(signal) {
  return signal?.costs?.conservativeNetEdgeBps == null
    ? null
    : finite('conservative edge', signal.costs.conservativeNetEdgeBps);
}
