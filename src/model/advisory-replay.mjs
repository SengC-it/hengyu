import { walkBook } from './net-edge.mjs';

const BPS = 10_000;

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

function sideSign(side) {
  if (side === 'BUY') return 1;
  if (side === 'SELL') return -1;
  throw new Error(`unsupported side: ${side}`);
}

function marketTime(row) {
  return integer('market time', row?.eventTime ?? row?.timestamp ?? row?.fundingTime ?? row?.E ?? row?.T);
}

function receivedAt(row) {
  return integer('received time', row?.receivedAt ?? marketTime(row));
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

function mid(book) {
  const bid = finite('book bid', book?.bids?.[0]?.[0], { minimum: 0, exclusiveMinimum: true });
  const ask = finite('book ask', book?.asks?.[0]?.[0], { minimum: 0, exclusiveMinimum: true });
  if (bid >= ask) throw new Error('book is crossed or locked');
  return (bid + ask) / 2;
}

function rowsForSymbol(rows, symbol) {
  return (rows ?? []).filter(row => symbolOf(row.symbol) === symbol).sort((left, right) => marketTime(left) - marketTime(right) || receivedAt(left) - receivedAt(right));
}

function markAtOrBefore(rows, symbol, target) {
  let selected = null;
  for (const row of rowsForSymbol(rows, symbol)) {
    if (marketTime(row) > target) break;
    selected = row;
  }
  return selected;
}

function stressPrice(fill, side, multiplier, bufferBps) {
  const adverse = side === 'BUY'
    ? fill.midPrice + Math.max(0, fill.vwap - fill.midPrice) * multiplier
    : fill.midPrice - Math.max(0, fill.midPrice - fill.vwap) * multiplier;
  return side === 'BUY' ? adverse * (1 + bufferBps / BPS) : adverse * (1 - bufferBps / BPS);
}

export const DEFAULT_ADVISORY_REPLAY_POLICY = Object.freeze({
  feeRatePerFill: 0.0005,
  bookStressMultiplier: 2,
  impactBufferBpsPerFill: 1,
  latencyBufferBpsPerFill: 1
});

export function simulateAdvisorySignal({
  signal,
  books,
  markPrices = [],
  fundingRates = [],
  quantity,
  researchNotionalUsdt = 1_000,
  policy: suppliedPolicy = DEFAULT_ADVISORY_REPLAY_POLICY
}) {
  if (!signal || typeof signal !== 'object') throw new Error('signal is required');
  const policy = { ...DEFAULT_ADVISORY_REPLAY_POLICY, ...(suppliedPolicy ?? {}) };
  const symbol = symbolOf(signal.symbol);
  const side = sideOf(signal.side);
  const decisionTime = integer('signal decision time', signal.decisionTime);
  const generatedAt = integer('signal generated time', signal.generatedAt);
  const validUntil = integer('signal valid-until time', signal.validUntil);
  const symbolBooks = rowsForSymbol(books, symbol);
  const entryBook = symbolBooks.find(book => {
    const eventAt = marketTime(book);
    const received = receivedAt(book);
    return eventAt >= decisionTime && received >= generatedAt && received <= validUntil;
  });
  if (!entryBook) return { status: 'REJECTED', reason: 'signal_to_fill_timeout', signalId: signal.signalId };
  const entryQuantity = quantity == null
    ? finite('research notional', researchNotionalUsdt, { minimum: 0, exclusiveMinimum: true }) / mid(entryBook)
    : finite('quantity', quantity, { minimum: 0, exclusiveMinimum: true });
  const entry = walkBook({ side, quantity: entryQuantity, book: entryBook });
  if (!entry.fillable) return { status: 'REJECTED', reason: 'insufficient_entry_depth', signalId: signal.signalId };
  const targetValue = signal.reference?.takeProfitPrice ?? signal.reference?.exitReferencePrice;
  const target = targetValue == null ? null : Number(targetValue);
  const stop = signal.reference?.stopPrice == null ? null : Number(signal.reference.stopPrice);
  let exitBook = null;
  let exitReason = null;
  for (const book of symbolBooks) {
    const time = marketTime(book);
    if (time < marketTime(entryBook)) continue;
    const currentMid = mid(book);
    const stopTriggered = stop != null && (side === 'BUY' ? currentMid <= stop : currentMid >= stop);
    const targetReached = target != null && (side === 'BUY' ? currentMid >= target : currentMid <= target);
    if (stopTriggered && targetReached) {
      return { status: 'REJECTED', reason: 'tp_sl_order_unknown_same_observation', signalId: signal.signalId };
    }
    if (stopTriggered) { exitBook = book; exitReason = 'STOP'; break; }
    if (targetReached) { exitBook = book; exitReason = 'TARGET'; break; }
  }
  if (!exitBook) {
    const markBook = symbolBooks.filter(book => marketTime(book) >= marketTime(entryBook)).at(-1) ?? entryBook;
    const markPrice = mid(markBook);
    const direction = sideSign(side);
    const markGrossPricePnl = direction * entryQuantity * (markPrice - entry.vwap);
    const markFees = (entry.quoteNotional + entryQuantity * markPrice) * policy.feeRatePerFill;
    return {
      status: 'OPEN',
      signalId: signal.signalId,
      experimentId: signal.experimentId,
      hypothesisId: signal.hypothesisId,
      symbol,
      side,
      entryTime: marketTime(entryBook),
      entryReceivedAt: receivedAt(entryBook),
      signalToFillMs: receivedAt(entryBook) - generatedAt,
      holdMs: marketTime(markBook) - marketTime(entryBook),
      exitReason: null,
      entryPrice: entry.vwap,
      markTime: marketTime(markBook),
      markPrice,
      markGrossPricePnl,
      markFees,
      markNetPnl: markGrossPricePnl - markFees,
      accountDataUsed: false,
      humanFeedbackRecorded: false
    };
  }
  if (!exitBook) return { status: 'REJECTED', reason: 'missing_exit_book', signalId: signal.signalId };
  const exitSide = side === 'BUY' ? 'SELL' : 'BUY';
  const exit = walkBook({ side: exitSide, quantity: entryQuantity, book: exitBook });
  if (!exit.fillable) return { status: 'REJECTED', reason: 'insufficient_exit_depth', signalId: signal.signalId };
  const entryTime = marketTime(entryBook);
  const exitTime = marketTime(exitBook);
  let fundingPnl = 0;
  const fundingDetails = [];
  for (const row of rowsForSymbol(fundingRates, symbol)) {
    const time = Number(row.fundingTime ?? row.eventTime ?? row.timestamp);
    if (time < entryTime || time > exitTime) continue;
    const mark = markAtOrBefore(markPrices, symbol, time);
    if (!mark) return { status: 'REJECTED', reason: 'missing_funding_mark', signalId: signal.signalId };
    const rate = finite('funding rate', row.fundingRate ?? row.rate);
    const markPrice = finite('mark price', mark.markPrice ?? mark.price ?? mark.p, { minimum: 0, exclusiveMinimum: true });
    const payment = side === 'BUY' ? -entryQuantity * markPrice * rate : entryQuantity * markPrice * rate;
    fundingPnl += payment;
    fundingDetails.push({ fundingTime: time, rate, markPrice, payment });
  }
  const fees = (entry.quoteNotional + exit.quoteNotional) * policy.feeRatePerFill;
  const direction = sideSign(side);
  const grossPricePnl = direction * entryQuantity * (exit.vwap - entry.vwap);
  const netPnl = grossPricePnl + fundingPnl - fees;
  const bufferBps = policy.impactBufferBpsPerFill + policy.latencyBufferBpsPerFill;
  const stressedEntryPrice = stressPrice(entry, side, policy.bookStressMultiplier, bufferBps);
  const stressedExitPrice = stressPrice(exit, exitSide, policy.bookStressMultiplier, bufferBps);
  const stressedFees = (entryQuantity * stressedEntryPrice + entryQuantity * stressedExitPrice) * policy.feeRatePerFill;
  const stressedGrossPricePnl = direction * entryQuantity * (stressedExitPrice - stressedEntryPrice);
  const stressNetPnl = stressedGrossPricePnl + fundingPnl - stressedFees;
  return {
    status: 'CLOSED',
    signalId: signal.signalId,
    experimentId: signal.experimentId,
    hypothesisId: signal.hypothesisId,
    symbol,
    side,
    entryTime,
    exitTime,
    entryReceivedAt: receivedAt(entryBook),
    exitReceivedAt: receivedAt(exitBook),
    signalToFillMs: receivedAt(entryBook) - generatedAt,
    holdMs: exitTime - entryTime,
    exitReason,
    entryPrice: entry.vwap,
    exitPrice: exit.vwap,
    grossPricePnl,
    fundingPnl,
    fees,
    netPnl,
    stressNetPnl,
    fundingDetails,
    accountDataUsed: false,
    humanFeedbackRecorded: false
  };
}

export function summarizeAdvisoryTrades(trades) {
  const closed = (trades ?? []).filter(trade => trade?.status === 'CLOSED');
  const open = (trades ?? []).filter(trade => trade?.status === 'OPEN');
  const ordered = [...closed].sort((left, right) => left.exitTime - right.exitTime || left.signalId.localeCompare(right.signalId));
  const grossProfit = ordered.filter(row => row.stressNetPnl > 0).reduce((total, row) => total + row.stressNetPnl, 0);
  const grossLoss = ordered.filter(row => row.stressNetPnl < 0).reduce((total, row) => total - row.stressNetPnl, 0);
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const row of ordered) {
    equity += row.stressNetPnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity - peak);
  }
  const clusters = new Map();
  for (const row of ordered) {
    const cluster = String(Math.floor(row.entryTime / (5 * 60_000)));
    clusters.set(cluster, (clusters.get(cluster) ?? 0) + row.stressNetPnl);
  }
  const best5 = [...clusters.values()].sort((left, right) => right - left).slice(0, 5);
  const stressNetPnl = ordered.reduce((total, row) => total + row.stressNetPnl, 0);
  const observed = [...ordered, ...open];
  return {
    closedTrades: ordered.length,
    openTrades: open.length,
    wins: ordered.filter(row => row.stressNetPnl > 0).length,
    losses: ordered.filter(row => row.stressNetPnl < 0).length,
    netPnl: ordered.reduce((total, row) => total + row.netPnl, 0),
    stressNetPnl,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
    maxDrawdown,
    best5ClusterStressNetPnl: best5.reduce((total, value) => total + value, 0),
    afterBest5ClusterStressNetPnl: stressNetPnl - best5.reduce((total, value) => total + value, 0),
    symbols: [...new Set(observed.map(row => row.symbol))].sort(),
    sides: [...new Set(observed.map(row => row.side))].sort()
  };
}
