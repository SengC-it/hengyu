import { createHash } from 'node:crypto';
import { buildNetEdgeAdvisorySignal } from './net-edge-advisory.mjs';
import { buildHypothesisCandidate } from './hypotheses.mjs';

function symbolOf(value) {
  const symbol = String(value ?? 'UNKNOWN').toUpperCase();
  return /^[A-Z0-9]+$/.test(symbol) ? symbol : 'UNKNOWN';
}

function integer(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('invalid evaluation time');
  return parsed;
}

function noCandidateSignal({ hypothesisId, symbol, now, reasons, experimentId = 'HY-EXP-0014' }) {
  const safeSymbol = symbolOf(symbol);
  const generatedAt = integer(now);
  const rawId = `${experimentId}:${hypothesisId}:${safeSymbol}:${generatedAt}`;
  return {
    schemaVersion: 1,
    signalId: `${experimentId}:${createHash('sha256').update(rawId).digest('hex').slice(0, 24)}`,
    experimentId,
    hypothesisId,
    modelId: 'HENGYU-NET-EDGE-001',
    evidenceClass: 'F0_PENDING',
    status: 'NO_TRADE',
    decision: 'NO_TRADE',
    alertLevel: 'NONE',
    action: null,
    symbol: safeSymbol,
    side: null,
    decisionTime: generatedAt,
    generatedAt,
    validUntil: generatedAt,
    expiresAt: generatedAt,
    reference: { entryPrice: null, exitReferencePrice: null, oppositeBestPrice: null, stopPrice: null },
    costs: null,
    reasons: [...new Set(reasons)],
    delivery: { web: true, email: 'NONE', dedupeKey: `${rawId}:NONE` },
    manualOnly: {
      requiresHumanConfirmation: true,
      autoExecution: false,
      orderPlacement: false,
      accountAccess: false,
      quantityProvided: false,
      leverageProvided: false,
      accountRiskProvided: false
    },
    warning: 'Research advisory only; no candidate passed the frozen feature conditions.'
  };
}

export function evaluateHypothesisObservation({
  hypothesisId,
  observation,
  book,
  quantity,
  now = Date.now(),
  hypothesisPolicy,
  advisoryPolicy,
  quality = null
}) {
  if (quality && (quality.status === 'NOT_READY' || quality.fresh === false || quality.pnlEligible === false)) {
    return noCandidateSignal({
      hypothesisId: String(hypothesisId).toUpperCase(),
      symbol: observation?.symbol,
      now,
      reasons: quality.reasons?.length ? quality.reasons : ['data_quality_not_ready']
    });
  }
  const generated = buildHypothesisCandidate({
    hypothesisId,
    observation,
    event: observation,
    quantity,
    now,
    policy: hypothesisPolicy
  });
  if (generated.status !== 'CANDIDATE') {
    return noCandidateSignal({
      hypothesisId: String(hypothesisId).toUpperCase(),
      symbol: observation?.symbol,
      now,
      reasons: generated.reasons
    });
  }
  return buildNetEdgeAdvisorySignal({
    candidate: generated.candidate,
    book,
    policy: advisoryPolicy,
    now
  });
}
