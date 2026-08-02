import { walkBook } from './net-edge.mjs';

const BPS = 10_000;
const HOUR_MS = 60 * 60 * 1000;

export const DEFAULT_H9_POLICY = Object.freeze({
  windowMs: 60_000,
  tradeLookbackMs: 30 * 60_000,
  warmupMs: 30 * 24 * HOUR_MS,
  pressureThresholdLookbackMs: 30 * 24 * HOUR_MS,
  pressureQuantile: 0.995,
  cooldownMs: 30 * 60_000,
  recoveryDelayMs: 5_000,
  recoveryObservationMaxDelayMs: 2_000,
  preEventDepthWindowMs: 60_000,
  depthBps: 10,
  depthLevels: 5,
  recoveryDepthRatio: 0.8,
  maxSignalToFillMs: 2_000,
  maxHoldMs: 15 * 60_000,
  stopImpulseFraction: 0.75,
  clusterMs: 5 * 60_000,
  fixedNotionalPerEvent: 1_000,
  feeRatePerFill: 0.0005,
  bookStressMultiplier: 2,
  impactBufferBpsPerFill: 1,
  latencyBufferBpsPerFill: 1
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

function sideSign(side) {
  if (side === 'BUY') return 1;
  if (side === 'SELL') return -1;
  throw new Error(`unsupported side: ${side}`);
}

function symbolOf(value) {
  const symbol = String(value ?? '').toUpperCase();
  if (!/^[A-Z0-9]+$/.test(symbol)) throw new Error('invalid symbol');
  return symbol;
}

function marketTime(row) {
  const value = row?.eventTime ?? row?.timestamp ?? row?.fundingTime ?? row?.T;
  return integer('event time', value);
}

function receiveTime(row) {
  return integer('received time', row?.receivedAt ?? marketTime(row));
}

function availableAt(row) {
  return receiveTime(row);
}

function normalizeLevels(levels, label) {
  if (!Array.isArray(levels) || !levels.length) throw new Error(`${label} is empty`);
  const rows = levels.map((level, index) => {
    if (!Array.isArray(level) || level.length < 2) throw new Error(`${label}[${index}] is invalid`);
    return [
      finite(`${label} price`, level[0], { minimum: 0, exclusiveMinimum: true }),
      finite(`${label} quantity`, level[1], { minimum: 0 })
    ];
  }).filter(([, quantity]) => quantity > 0);
  if (!rows.length) throw new Error(`${label} has no positive quantity`);
  rows.sort((left, right) => label === 'bids' ? right[0] - left[0] : left[0] - right[0]);
  return rows;
}

function normalizeBook(book) {
  const bids = normalizeLevels(book?.bids, 'bids');
  const asks = normalizeLevels(book?.asks, 'asks');
  if (bids[0][0] >= asks[0][0]) throw new Error('book is crossed or locked');
  const midPrice = (bids[0][0] + asks[0][0]) / 2;
  return { ...book, bids, asks, midPrice };
}

function sortByMarketTime(rows) {
  return [...rows].sort((left, right) => {
    const timeDelta = marketTime(left) - marketTime(right);
    if (timeDelta) return timeDelta;
    return receiveTime(left) - receiveTime(right);
  });
}

export function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function nearestRankQuantile(values, quantile) {
  const q = finite('quantile', quantile, { minimum: 0 });
  if (q > 1) throw new Error('quantile must not exceed 1');
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return sorted[rank - 1];
}

export function makeWindowEnds({ startTime, endTime, windowMs = DEFAULT_H9_POLICY.windowMs }) {
  const start = integer('startTime', startTime);
  const end = integer('endTime', endTime);
  const width = integer('windowMs', windowMs, { minimum: 1 });
  if (end <= start) throw new Error('endTime must be after startTime');
  const output = [];
  for (let windowEnd = Math.ceil(start / width) * width; windowEnd <= end; windowEnd += width) {
    output.push(windowEnd);
  }
  return output;
}

function rowsForSymbol(rows, symbol) {
  return sortByMarketTime(rows.filter(row => symbolOf(row.symbol) === symbol));
}

export function buildPressureWindows({
  symbols,
  forceOrders,
  trades,
  windowEnds,
  startTime,
  endTime,
  warmupUntil,
  policy = DEFAULT_H9_POLICY
}) {
  const frozenSymbols = [...new Set((symbols ?? []).map(symbolOf))].sort();
  if (!frozenSymbols.length) throw new Error('symbols must not be empty');
  const ends = windowEnds
    ? windowEnds.map(value => integer('window end', value)).sort((left, right) => left - right)
    : makeWindowEnds({ startTime, endTime, windowMs: policy.windowMs });
  const warmupBoundary = warmupUntil == null
    ? (startTime == null ? null : integer('warmupUntil', startTime) + policy.warmupMs)
    : integer('warmupUntil', warmupUntil);
  const result = [];
  for (const symbol of frozenSymbols) {
    const force = rowsForSymbol(forceOrders ?? [], symbol);
    const trade = rowsForSymbol(trades ?? [], symbol);
    const history = [];
    for (const windowEnd of ends) {
      const windowStart = windowEnd - policy.windowMs;
      const forceOrdersInWindow = force.filter(row => {
        const time = marketTime(row);
        return time >= windowStart && time < windowEnd && availableAt(row) <= windowEnd;
      });
      const tradesInLookback = trade.filter(row => {
        const time = marketTime(row);
        return time >= windowEnd - policy.tradeLookbackMs
          && time < windowEnd
          && availableAt(row) <= windowEnd;
      });
      const lateForceOrders = force.filter(row => {
        const time = marketTime(row);
        return time >= windowStart && time < windowEnd && availableAt(row) > windowEnd;
      }).length;
      const lateTrades = trade.filter(row => {
        const time = marketTime(row);
        return time >= windowEnd - policy.tradeLookbackMs
          && time < windowEnd
          && availableAt(row) > windowEnd;
      }).length;
      const signedForceNotional = forceOrdersInWindow.reduce(
        (total, row) => total + finite('force pressure', row.pressure ?? row.quoteNotional), 0
      );
      const tradedQuoteNotional = tradesInLookback.reduce(
        (total, row) => total + finite('trade quote notional', row.quoteNotional, { minimum: 0 }), 0
      );
      const pressure = tradedQuoteNotional > 0 ? signedForceNotional / tradedQuoteNotional : null;
      const warmupComplete = warmupBoundary == null || windowEnd >= warmupBoundary;
      const thresholdHistory = history
        .filter(row => row.windowEnd >= windowEnd - policy.pressureThresholdLookbackMs)
        .map(row => row.absolutePressure);
      const threshold = warmupComplete
        ? nearestRankQuantile(thresholdHistory, policy.pressureQuantile)
        : null;
      result.push({
        symbol,
        windowStart,
        windowEnd,
        signedForceNotional,
        tradedQuoteNotional,
        lateForceOrders,
        lateTrades,
        pressure,
        absolutePressure: pressure == null ? null : Math.abs(pressure),
        threshold,
        warmupComplete
      });
      if (pressure != null && Number.isFinite(pressure)) {
        history.push({ windowEnd, absolutePressure: Math.abs(pressure) });
      }
    }
  }
  return result.sort((left, right) => left.windowEnd - right.windowEnd || left.symbol.localeCompare(right.symbol));
}

function depthWithinBps(book, { depthBps, depthLevels }) {
  const normalized = normalizeBook(book);
  const distance = normalized.midPrice * depthBps / BPS;
  const bidLimit = normalized.midPrice - distance;
  const askLimit = normalized.midPrice + distance;
  const bidLevels = normalized.bids.slice(0, depthLevels).filter(([price]) => price >= bidLimit);
  const askLevels = normalized.asks.slice(0, depthLevels).filter(([price]) => price <= askLimit);
  const bidQuoteNotional = bidLevels.reduce((total, [price, quantity]) => total + price * quantity, 0);
  const askQuoteNotional = askLevels.reduce((total, [price, quantity]) => total + price * quantity, 0);
  return {
    ...normalized,
    depthQuoteNotional: bidQuoteNotional + askQuoteNotional,
    bidDepthQuoteNotional: bidQuoteNotional,
    askDepthQuoteNotional: askQuoteNotional
  };
}

function bookRows(books, symbol) {
  return rowsForSymbol(books ?? [], symbol).map(normalizeBook);
}

function firstBookAtOrAfter(books, target, maxDelay) {
  return [...books]
    .sort((left, right) => receiveTime(left) - receiveTime(right))
    .find(book => {
      const time = marketTime(book);
      const received = receiveTime(book);
      return time >= target
        && received >= target
        && (maxDelay == null || received <= target + maxDelay);
    }) ?? null;
}

function rejectEvent(rejected, window, reason) {
  rejected.push({
    symbol: window.symbol,
    windowStart: window.windowStart,
    windowEnd: window.windowEnd,
    reason
  });
}

export function detectH9Events({ pressureWindows, books, policy = DEFAULT_H9_POLICY }) {
  const rejected = [];
  const events = [];
  const lastAcceptedBySymbol = new Map();
  const groupedBooks = new Map();
  for (const symbol of [...new Set((pressureWindows ?? []).map(row => symbolOf(row.symbol)))]) {
    groupedBooks.set(symbol, bookRows(books, symbol));
  }
  const orderedWindows = [...(pressureWindows ?? [])].sort(
    (left, right) => left.windowEnd - right.windowEnd || left.symbol.localeCompare(right.symbol)
  );
  for (const window of orderedWindows) {
    const symbol = symbolOf(window.symbol);
    const pressure = window.pressure;
    const threshold = window.threshold;
    if (!window.warmupComplete || pressure == null || threshold == null) continue;
    if (!(threshold > 0) || Math.abs(pressure) < threshold) continue;
    const lastAccepted = lastAcceptedBySymbol.get(symbol);
    if (lastAccepted != null && window.windowEnd - lastAccepted < policy.cooldownMs) {
      rejectEvent(rejected, window, 'cooldown');
      continue;
    }
    const symbolBooks = groupedBooks.get(symbol) ?? [];
    const preBooks = symbolBooks.filter(book => {
      const time = marketTime(book);
      return time >= window.windowStart - policy.preEventDepthWindowMs && time < window.windowStart;
    });
    const eventBooks = symbolBooks.filter(book => {
      const time = marketTime(book);
      return time >= window.windowStart && time < window.windowEnd;
    });
    if (!preBooks.length || !eventBooks.length) {
      rejectEvent(rejected, window, 'missing_pre_or_event_book');
      continue;
    }
    const preDepth = preBooks.map(book => depthWithinBps(book, policy).depthQuoteNotional);
    const preMedianDepth = median(preDepth);
    const preMedianMid = median(preBooks.map(book => book.midPrice));
    if (!(preMedianDepth > 0) || !(preMedianMid > 0)) {
      rejectEvent(rejected, window, 'non_positive_pre_event_depth');
      continue;
    }
    const eventMids = eventBooks.map(book => book.midPrice);
    const eventExtremeMid = pressure < 0 ? Math.min(...eventMids) : Math.max(...eventMids);
    const eventImpulse = pressure < 0
      ? preMedianMid - eventExtremeMid
      : eventExtremeMid - preMedianMid;
    if (!(eventImpulse > 0)) {
      rejectEvent(rejected, window, 'non_positive_event_impulse');
      continue;
    }
    const recoveryTarget = window.windowEnd + policy.recoveryDelayMs;
    const recoveryBook = firstBookAtOrAfter(
      symbolBooks,
      recoveryTarget,
      policy.recoveryObservationMaxDelayMs
    );
    if (!recoveryBook) {
      rejectEvent(rejected, window, 'missing_recovery_book');
      continue;
    }
    const recoveryDepth = depthWithinBps(recoveryBook, policy).depthQuoteNotional;
    const recoveryRatio = recoveryDepth / preMedianDepth;
    if (recoveryRatio < policy.recoveryDepthRatio) {
      rejectEvent(rejected, window, 'insufficient_recovery_depth');
      continue;
    }
    const recoveryMids = symbolBooks
      .filter(book => {
        const time = marketTime(book);
        return time >= window.windowEnd && time <= marketTime(recoveryBook);
      })
      .map(book => book.midPrice);
    if (recoveryMids.some(mid => pressure < 0 ? mid < eventExtremeMid : mid > eventExtremeMid)) {
      rejectEvent(rejected, window, 'new_event_direction_extreme');
      continue;
    }
    const side = pressure < 0 ? 'BUY' : 'SELL';
    const decisionMid = recoveryBook.midPrice;
    const stopPrice = side === 'BUY'
      ? decisionMid - policy.stopImpulseFraction * eventImpulse
      : decisionMid + policy.stopImpulseFraction * eventImpulse;
    const event = {
      eventId: `${symbol}:${window.windowEnd}:${side}`,
      symbol,
      side,
      liquidationDirection: pressure < 0 ? 'SELL' : 'BUY',
      windowStart: window.windowStart,
      windowEnd: window.windowEnd,
      pressure,
      absolutePressure: Math.abs(pressure),
      threshold,
      preEventMedianDepth: preMedianDepth,
      recoveryDepth,
      recoveryRatio,
      preEventMedianMid: preMedianMid,
      eventExtremeMid,
      eventImpulse,
      recoveryTime: marketTime(recoveryBook),
      decisionTime: marketTime(recoveryBook),
      decisionReceivedAt: receiveTime(recoveryBook),
      decisionMid,
      stopPrice,
      clusterId: String(Math.floor(window.windowEnd / policy.clusterMs)),
      decisionBook: recoveryBook
    };
    events.push(event);
    lastAcceptedBySymbol.set(symbol, window.windowEnd);
  }
  return { events, rejected };
}

function adversePrice(price, side, bps) {
  return side === 'BUY' ? price * (1 + bps / BPS) : price * (1 - bps / BPS);
}

function stressedFillPrice(fill, side, policy) {
  const bookCostPrice = side === 'BUY'
    ? fill.midPrice + Math.max(0, fill.vwap - fill.midPrice) * policy.bookStressMultiplier
    : fill.midPrice - Math.max(0, fill.midPrice - fill.vwap) * policy.bookStressMultiplier;
  const buffers = policy.impactBufferBpsPerFill + policy.latencyBufferBpsPerFill;
  return adversePrice(bookCostPrice, side, buffers);
}

function findMarkAtOrBefore(markPrices, symbol, target) {
  let selected = null;
  for (const mark of sortByMarketTime(markPrices.filter(row => symbolOf(row.symbol) === symbol))) {
    const time = marketTime(mark);
    if (time > target) break;
    selected = mark;
  }
  return selected;
}

function fundingRows(fundingRates, symbol, start, end) {
  return sortByMarketTime((fundingRates ?? []).filter(row => {
    const rowSymbol = symbolOf(row.symbol);
    const time = row.fundingTime ?? row.eventTime ?? row.timestamp;
    return rowSymbol === symbol && Number(time) >= start && Number(time) <= end;
  }));
}

function fundingRateValue(row) {
  return finite('funding rate', row.fundingRate ?? row.rate);
}

export function replayH9Event({
  event,
  books,
  markPrices = [],
  fundingRates = [],
  quantity,
  policy = DEFAULT_H9_POLICY
}) {
  const symbol = symbolOf(event?.symbol);
  const side = event?.side;
  sideSign(side);
  const requestedQuantity = finite('quantity', quantity, { minimum: 0, exclusiveMinimum: true });
  const symbolBooks = bookRows(books, symbol);
  const decisionTime = integer('decisionTime', event.decisionTime);
  const decisionReceivedAt = integer('decisionReceivedAt', event.decisionReceivedAt ?? decisionTime);
  const entryBook = symbolBooks.find(book => {
    const eventAt = marketTime(book);
    const receivedAt = receiveTime(book);
    return eventAt >= decisionTime
      && receivedAt >= decisionReceivedAt
      && receivedAt <= decisionReceivedAt + policy.maxSignalToFillMs;
  });
  if (!entryBook) return { status: 'REJECTED', reason: 'signal_to_fill_timeout', eventId: event.eventId };
  const entrySide = side;
  const exitSide = side === 'BUY' ? 'SELL' : 'BUY';
  const entry = walkBook({ side: entrySide, quantity: requestedQuantity, book: entryBook });
  if (!entry.fillable) return { status: 'REJECTED', reason: 'insufficient_entry_depth', eventId: event.eventId };
  const entryMarketTime = marketTime(entryBook);
  const entryReceivedAt = receiveTime(entryBook);
  const holdDeadline = entryMarketTime + policy.maxHoldMs;
  let exitBook = null;
  let exitReason = null;
  for (const book of symbolBooks) {
    const time = marketTime(book);
    if (time < entryMarketTime || time > holdDeadline) continue;
    const stopTriggered = side === 'BUY'
      ? book.midPrice <= event.stopPrice
      : book.midPrice >= event.stopPrice;
    if (stopTriggered) {
      exitBook = book;
      exitReason = 'STOP';
      break;
    }
  }
  if (!exitBook) {
    exitBook = symbolBooks.find(book => marketTime(book) >= holdDeadline) ?? null;
    exitReason = 'TIME';
  }
  if (!exitBook) return { status: 'REJECTED', reason: 'missing_exit_book', eventId: event.eventId };
  const exit = walkBook({ side: exitSide, quantity: requestedQuantity, book: exitBook });
  if (!exit.fillable) return { status: 'REJECTED', reason: 'insufficient_exit_depth', eventId: event.eventId };
  const exitMarketTime = marketTime(exitBook);
  const funding = fundingRows(fundingRates, symbol, entryMarketTime, exitMarketTime);
  let fundingPnl = 0;
  const fundingDetails = [];
  for (const row of funding) {
    const fundingTime = integer('funding time', row.fundingTime ?? row.eventTime ?? row.timestamp);
    const mark = findMarkAtOrBefore(markPrices, symbol, fundingTime);
    if (!mark) {
      return { status: 'REJECTED', reason: 'missing_funding_mark', eventId: event.eventId };
    }
    const rate = fundingRateValue(row);
    const markPrice = finite('mark price', mark.markPrice ?? mark.price ?? mark.p, { minimum: 0, exclusiveMinimum: true });
    const payment = side === 'BUY'
      ? -requestedQuantity * markPrice * rate
      : requestedQuantity * markPrice * rate;
    fundingPnl += payment;
    fundingDetails.push({ fundingTime, rate, markPrice, payment });
  }
  const entryNotional = entry.quoteNotional;
  const exitNotional = exit.quoteNotional;
  const fees = (entryNotional + exitNotional) * policy.feeRatePerFill;
  const direction = sideSign(side);
  const grossPricePnl = direction * requestedQuantity * (exit.vwap - entry.vwap);
  const netPnl = grossPricePnl + fundingPnl - fees;
  const stressedEntryPrice = stressedFillPrice(entry, entrySide, policy);
  const stressedExitPrice = stressedFillPrice(exit, exitSide, policy);
  const stressedEntryNotional = requestedQuantity * stressedEntryPrice;
  const stressedExitNotional = requestedQuantity * stressedExitPrice;
  const stressedFees = (stressedEntryNotional + stressedExitNotional) * policy.feeRatePerFill;
  const stressedGrossPricePnl = direction * requestedQuantity * (stressedExitPrice - stressedEntryPrice);
  const stressNetPnl = stressedGrossPricePnl + fundingPnl - stressedFees;
  const observedBookCostBps = entry.adverseBookCostBps + exit.adverseBookCostBps;
  const stressedBookCostBps = observedBookCostBps * policy.bookStressMultiplier
    + 2 * (policy.impactBufferBpsPerFill + policy.latencyBufferBpsPerFill);
  return {
    status: 'CLOSED',
    eventId: event.eventId,
    symbol,
    side,
    quantity: requestedQuantity,
    entryTime: entryMarketTime,
    exitTime: exitMarketTime,
    entryReceivedAt,
    exitReceivedAt: receiveTime(exitBook),
    clusterId: event.clusterId ?? null,
    signalToFillMs: entryReceivedAt - decisionReceivedAt,
    holdMs: exitMarketTime - entryMarketTime,
    exitReason,
    entryPrice: entry.vwap,
    exitPrice: exit.vwap,
    entryMid: entry.midPrice,
    exitMid: exit.midPrice,
    grossPricePnl,
    fundingPnl,
    fees,
    netPnl,
    stressNetPnl,
    observedBookCostBps,
    stressedBookCostBps,
    fundingDetails
  };
}

export function summarizeH9Trades(trades) {
  const closed = (trades ?? []).filter(trade => trade?.status === 'CLOSED');
  const grossProfit = closed.filter(trade => trade.stressNetPnl > 0).reduce((total, trade) => total + trade.stressNetPnl, 0);
  const grossLoss = closed.filter(trade => trade.stressNetPnl < 0).reduce((total, trade) => total - trade.stressNetPnl, 0);
  const stressNet = closed.reduce((total, trade) => total + trade.stressNetPnl, 0);
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const trade of [...closed].sort((left, right) => left.exitTime - right.exitTime)) {
    equity += trade.stressNetPnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.min(maxDrawdown, equity - peak);
  }
  const clusters = new Map();
  for (const trade of closed) {
    const cluster = trade.clusterId ?? String(Math.floor(trade.exitTime / DEFAULT_H9_POLICY.clusterMs));
    clusters.set(cluster, (clusters.get(cluster) ?? 0) + trade.stressNetPnl);
  }
  const bestClusters = [...clusters.values()].sort((left, right) => right - left).slice(0, 5);
  const afterBest5 = stressNet - bestClusters.reduce((total, value) => total + value, 0);
  return {
    closedTrades: closed.length,
    wins: closed.filter(trade => trade.stressNetPnl > 0).length,
    losses: closed.filter(trade => trade.stressNetPnl < 0).length,
    netPnl: closed.reduce((total, trade) => total + trade.netPnl, 0),
    stressNetPnl: stressNet,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
    maxDrawdown,
    best5ClusterStressNetPnl: bestClusters.reduce((total, value) => total + value, 0),
    afterBest5ClusterStressNetPnl: afterBest5,
    clusterCount: clusters.size
  };
}
