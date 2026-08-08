import { DEFAULT_H9_POLICY } from './h9-events.mjs';
import { estimateRoundTripCost } from './net-edge.mjs';

const BPS = 10_000;

function finite(name, value, { minimum = -Infinity, exclusiveMinimum = false } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (exclusiveMinimum ? parsed <= minimum : parsed < minimum)) {
    throw new Error(`invalid ${name}`);
  }
  return parsed;
}

function integer(name, value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`invalid ${name}`);
  return parsed;
}

function symbolOf(value) {
  const symbol = String(value ?? '').toUpperCase();
  if (!/^[A-Z0-9]+$/.test(symbol)) throw new Error('invalid symbol');
  return symbol;
}

function sideOf(value) {
  const side = String(value ?? '').toUpperCase();
  if (side !== 'BUY' && side !== 'SELL') throw new Error('invalid advisory side');
  return side;
}

function topOppositeQuote(book, side) {
  const levels = side === 'BUY' ? book?.asks : book?.bids;
  if (!Array.isArray(levels) || !levels.length) throw new Error('decision book has no opposite quote');
  const level = levels[0];
  if (!Array.isArray(level) || level.length < 2) throw new Error('decision quote is invalid');
  return {
    price: finite('decision quote price', level[0], { minimum: 0, exclusiveMinimum: true }),
    quantity: finite('decision quote quantity', level[1], { minimum: 0, exclusiveMinimum: true })
  };
}

function mergePolicy(policy) {
  return { ...DEFAULT_H9_POLICY, ...(policy ?? {}) };
}

/**
 * Convert a causal H9 event into a manual-review reminder.
 *
 * This function deliberately does not produce an order payload or a position
 * size for a user account. The fixed notional is used only to make the
 * research cost estimate comparable with the preregistered replay.
 */
export function buildH9AdvisorySignal({
  event,
  policy: suppliedPolicy = DEFAULT_H9_POLICY,
  generatedAt = null
}) {
  if (!event || typeof event !== 'object') throw new Error('event is required');
  const policy = mergePolicy(suppliedPolicy);
  const symbol = symbolOf(event.symbol);
  const side = sideOf(event.side);
  const decisionTime = integer('decision time', event.decisionTime);
  const decisionReceivedAt = integer(
    'decision received time',
    event.decisionReceivedAt ?? decisionTime
  );
  const decisionMid = finite('decision mid', event.decisionMid, { minimum: 0, exclusiveMinimum: true });
  const stopPrice = finite('stop price', event.stopPrice, { minimum: 0, exclusiveMinimum: true });
  const pressure = finite('pressure', event.pressure);
  const threshold = finite('pressure threshold', event.threshold, { minimum: 0 });
  const recoveryRatio = finite('recovery ratio', event.recoveryRatio, { minimum: 0 });
  const eventImpulse = finite('event impulse', event.eventImpulse, { minimum: 0 });
  const quote = topOppositeQuote(event.decisionBook, side);
  const takeProfitPrice = event.takeProfitPrice
    ?? event.targetPrice
    ?? event.expectedExitPrice
    ?? event.exitReferencePrice
    ?? null;
  const fixedNotional = finite('fixed research notional', policy.fixedNotionalPerEvent, {
    minimum: 0,
    exclusiveMinimum: true
  });
  const quantity = fixedNotional / decisionMid;
  const execution = estimateRoundTripCost({
    side,
    quantity,
    book: event.decisionBook,
    feeRatePerFill: policy.feeRatePerFill,
    bookStressMultiplier: policy.bookStressMultiplier,
    impactBufferBpsPerFill: policy.impactBufferBpsPerFill,
    latencyBufferBpsPerFill: policy.latencyBufferBpsPerFill
  });
  const alertLevel = String(event.alertLevel ?? policy.alertLevel ?? 'NONE').toUpperCase();
  if (!['STRONG', 'MEDIUM', 'OBSERVE', 'NONE'].includes(alertLevel)) {
    throw new Error('invalid H9 alert level');
  }
  const email = alertLevel === 'STRONG'
    ? 'IMMEDIATE'
    : alertLevel === 'MEDIUM' ? 'DIGEST_15M' : 'NONE';

  return {
    schemaVersion: 1,
    signalId: `H9:${event.eventId ?? `${symbol}:${decisionTime}:${side}`}`,
    experimentId: 'HY-EXP-0013',
    hypothesisId: 'H9',
    evidenceClass: 'F0_PENDING',
    status: 'ADVISORY',
    alertLevel,
    action: side === 'BUY' ? 'REVIEW_BUY' : 'REVIEW_SELL',
    symbol,
    side,
    signalTime: decisionTime,
    receivedAt: decisionReceivedAt,
    generatedAt: generatedAt == null ? decisionReceivedAt : integer('generated time', generatedAt),
    validUntil: decisionReceivedAt + integer('maximum signal-to-fill time', policy.maxSignalToFillMs),
    expiresAt: decisionTime + integer('maximum holding time', policy.maxHoldMs),
    reference: {
      decisionMid,
      oppositeBestPrice: quote.price,
      oppositeBestQuantity: quote.quantity,
      entryPrice: quote.price,
      stopPrice,
      takeProfitPrice,
      stopDistanceBps: Math.abs(stopPrice - decisionMid) / decisionMid * BPS,
      eventImpulseBps: eventImpulse / decisionMid * BPS
    },
    trigger: {
      pressure,
      threshold,
      recoveryRatio,
      eventImpulse,
      clusterId: event.clusterId ?? null
    },
    researchExecution: {
      fixedNotionalUsdt: fixedNotional,
      fillableAtDecisionBook: execution.fillable,
      roundTripCostBps: execution.fillable ? execution.totalExecutionCostBps : null,
      observedBookCostBps: execution.fillable ? execution.observedBookCostBps : null,
      stressedBookCostBps: execution.fillable ? execution.stressedBookCostBps : null
    },
    delivery: {
      web: true,
      email,
      dedupeKey: `HY-EXP-0013:${symbol}:${side}:${decisionTime}:${alertLevel}`
    },
    manualOnly: {
      requiresHumanConfirmation: true,
      autoExecution: false,
      orderPlacement: false,
      accountAccess: false
    },
    warning: 'Research advisory only; this signal does not assert positive expectancy or authorize a trade.'
  };
}

export function advisoryFreshness(signal, { now = Date.now() } = {}) {
  const current = integer('freshness time', now);
  const receivedAt = integer('signal received time', signal?.receivedAt);
  const validUntil = integer('signal valid-until time', signal?.validUntil);
  if (current < receivedAt) return { status: 'NOT_YET_RECEIVED', fresh: false };
  if (current > validUntil) return { status: 'EXPIRED', fresh: false };
  return { status: 'FRESH', fresh: true };
}
