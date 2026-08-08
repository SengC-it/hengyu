import { DEFAULT_H9_POLICY, median, nearestRankQuantile } from './h9-events.mjs';

const BPS = 10_000;

export const DEFAULT_LIVE_H9_POLICY = Object.freeze({
  ...DEFAULT_H9_POLICY,
  takeProfitImpulseMultiplier: 1,
  alertLevel: 'MEDIUM',
  bookRetentionMs: 5 * 60_000
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

function sideSign(side) {
  if (side === 'BUY') return 1;
  if (side === 'SELL') return -1;
  throw new Error('invalid side');
}

function policyOf(suppliedPolicy) {
  const policy = { ...DEFAULT_LIVE_H9_POLICY, ...(suppliedPolicy ?? {}) };
  policy.takeProfitImpulseMultiplier = finite(
    'takeProfitImpulseMultiplier',
    policy.takeProfitImpulseMultiplier,
    { minimum: 0, exclusiveMinimum: true }
  );
  policy.bookRetentionMs = integer('bookRetentionMs', policy.bookRetentionMs, { minimum: 1 });
  const alertLevel = String(policy.alertLevel).toUpperCase();
  if (!['STRONG', 'MEDIUM', 'OBSERVE', 'NONE'].includes(alertLevel)) {
    throw new Error('invalid live H9 alert level');
  }
  policy.alertLevel = alertLevel;
  return policy;
}

function eventTimeOf(row) {
  return integer('event time', row?.eventTime ?? row?.timestamp ?? row?.T);
}

function receivedAtOf(row, eventTime = eventTimeOf(row)) {
  return integer('received time', row?.receivedAt ?? eventTime);
}

function normalizeLevels(levels, label) {
  if (!Array.isArray(levels) || !levels.length) throw new Error(`${label} is empty`);
  return levels.map((level, index) => {
    if (!Array.isArray(level) || level.length < 2) throw new Error(`${label}[${index}] is invalid`);
    return [
      finite(`${label} price`, level[0], { minimum: 0, exclusiveMinimum: true }),
      finite(`${label} quantity`, level[1], { minimum: 0 })
    ];
  }).filter(([, quantity]) => quantity > 0);
}

function normalizeBook(book) {
  const bids = normalizeLevels(book?.bids, 'bids')
    .sort((left, right) => right[0] - left[0]);
  const asks = normalizeLevels(book?.asks, 'asks')
    .sort((left, right) => left[0] - right[0]);
  if (!bids.length || !asks.length || bids[0][0] >= asks[0][0]) {
    throw new Error('book is crossed or empty');
  }
  const midPrice = (bids[0][0] + asks[0][0]) / 2;
  return { ...book, bids, asks, midPrice };
}

function depthWithinBps(book, policy) {
  const normalized = normalizeBook(book);
  const distance = normalized.midPrice * policy.depthBps / BPS;
  const bidLimit = normalized.midPrice - distance;
  const askLimit = normalized.midPrice + distance;
  const epsilon = normalized.midPrice * 1e-12;
  const bidLevels = normalized.bids.slice(0, policy.depthLevels).filter(([price]) => price + epsilon >= bidLimit);
  const askLevels = normalized.asks.slice(0, policy.depthLevels).filter(([price]) => price - epsilon <= askLimit);
  const bidDepthQuoteNotional = bidLevels.reduce((total, [price, quantity]) => total + price * quantity, 0);
  const askDepthQuoteNotional = askLevels.reduce((total, [price, quantity]) => total + price * quantity, 0);
  return {
    ...normalized,
    depthQuoteNotional: bidDepthQuoteNotional + askDepthQuoteNotional,
    bidDepthQuoteNotional,
    askDepthQuoteNotional
  };
}

function stateFor(symbol, persisted, policy, now) {
  const boundary = Math.floor(now / policy.windowMs) * policy.windowMs;
  const row = persisted?.symbols?.[symbol] ?? {};
  return {
    symbol,
    warmupStartedAt: row.warmupStartedAt == null ? null : integer('warmupStartedAt', row.warmupStartedAt),
    lastClosedWindowEnd: row.lastClosedWindowEnd == null
      ? boundary
      : integer('lastClosedWindowEnd', row.lastClosedWindowEnd),
    lastAcceptedWindowEnd: row.lastAcceptedWindowEnd == null
      ? null
      : integer('lastAcceptedWindowEnd', row.lastAcceptedWindowEnd),
    pressureWindows: Array.isArray(row.pressureWindows) ? row.pressureWindows : [],
    trades: [],
    forceOrders: [],
    books: [],
    pending: [],
    rejected: 0,
    rejectionReasons: {},
    accepted: 0,
    lastDataAt: null
  };
}

function publicPressureRow(state, windowEnd) {
  const policy = state.policy;
  const windowStart = windowEnd - policy.windowMs;
  const forceInWindow = state.forceOrders.filter(row => {
    const time = eventTimeOf(row);
    return time >= windowStart && time < windowEnd && receivedAtOf(row) <= windowEnd;
  });
  const tradesInLookback = state.trades.filter(row => {
    const time = eventTimeOf(row);
    return time >= windowEnd - policy.tradeLookbackMs
      && time < windowEnd
      && receivedAtOf(row) <= windowEnd;
  });
  const lateForceOrders = state.forceOrders.filter(row => {
    const time = eventTimeOf(row);
    return time >= windowStart && time < windowEnd && receivedAtOf(row) > windowEnd;
  }).length;
  const lateTrades = state.trades.filter(row => {
    const time = eventTimeOf(row);
    return time >= windowEnd - policy.tradeLookbackMs
      && time < windowEnd
      && receivedAtOf(row) > windowEnd;
  }).length;
  const signedForceNotional = forceInWindow.reduce(
    (total, row) => total + finite('force pressure', row.pressure ?? row.quoteNotional), 0
  );
  const tradedQuoteNotional = tradesInLookback.reduce(
    (total, row) => total + finite('trade quote notional', row.quoteNotional, { minimum: 0 }), 0
  );
  const pressure = tradedQuoteNotional > 0 ? signedForceNotional / tradedQuoteNotional : null;
  const warmupBoundary = state.warmupStartedAt == null
    ? null
    : state.warmupStartedAt + policy.warmupMs;
  const warmupComplete = warmupBoundary != null && windowEnd >= warmupBoundary;
  const thresholdHistory = state.pressureWindows
    .filter(row => row.windowEnd < windowEnd
      && row.windowEnd >= windowEnd - policy.pressureThresholdLookbackMs)
    .map(row => row.absolutePressure)
    .filter(value => Number.isFinite(value));
  const threshold = warmupComplete
    ? nearestRankQuantile(thresholdHistory, policy.pressureQuantile)
    : null;
  return {
    symbol: state.symbol,
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
  };
}

function reject(state, reason) {
  state.rejected++;
  state.rejectionReasons[reason] = (state.rejectionReasons[reason] ?? 0) + 1;
  return { symbol: state.symbol, reason };
}

function bookAtOrAfter(books, target, maxDelay) {
  return [...books]
    .sort((left, right) => receivedAtOf(left) - receivedAtOf(right))
    .find(book => {
      const time = eventTimeOf(book);
      const receivedAt = receivedAtOf(book);
      return time >= target && receivedAt >= target && receivedAt <= target + maxDelay;
    }) ?? null;
}

function evaluatePending(state, now) {
  const events = [];
  const remaining = [];
  for (const pending of state.pending) {
    const target = pending.window.windowEnd + state.policy.recoveryDelayMs;
    if (now < target) {
      remaining.push(pending);
      continue;
    }
    const recoveryBook = bookAtOrAfter(
      state.books,
      target,
      state.policy.recoveryObservationMaxDelayMs
    );
    if (!recoveryBook) {
      if (now <= target + state.policy.recoveryObservationMaxDelayMs) remaining.push(pending);
      else reject(state, 'missing_recovery_book');
      continue;
    }
    const preMedianDepth = median(pending.preBooks.map(book => depthWithinBps(book, state.policy).depthQuoteNotional));
    const preMedianMid = median(pending.preBooks.map(book => normalizeBook(book).midPrice));
    if (!(preMedianDepth > 0) || !(preMedianMid > 0)) {
      reject(state, 'non_positive_pre_event_depth');
      continue;
    }
    const eventMids = pending.eventBooks.map(book => normalizeBook(book).midPrice);
    const pressure = pending.window.pressure;
    const eventExtremeMid = pressure < 0 ? Math.min(...eventMids) : Math.max(...eventMids);
    const eventImpulse = pressure < 0
      ? preMedianMid - eventExtremeMid
      : eventExtremeMid - preMedianMid;
    if (!(eventImpulse > 0)) {
      reject(state, 'non_positive_event_impulse');
      continue;
    }
    const recoveryDepth = depthWithinBps(recoveryBook, state.policy).depthQuoteNotional;
    const recoveryRatio = recoveryDepth / preMedianDepth;
    if (recoveryRatio < state.policy.recoveryDepthRatio) {
      reject(state, 'insufficient_recovery_depth');
      continue;
    }
    const recoveryMids = state.books
      .filter(book => {
        const time = eventTimeOf(book);
        return time >= pending.window.windowEnd && time <= eventTimeOf(recoveryBook);
      })
      .map(book => normalizeBook(book).midPrice);
    if (recoveryMids.some(mid => pressure < 0 ? mid < eventExtremeMid : mid > eventExtremeMid)) {
      reject(state, 'new_event_direction_extreme');
      continue;
    }
    const side = pressure < 0 ? 'BUY' : 'SELL';
    const decisionMid = normalizeBook(recoveryBook).midPrice;
    const stopPrice = side === 'BUY'
      ? decisionMid - state.policy.stopImpulseFraction * eventImpulse
      : decisionMid + state.policy.stopImpulseFraction * eventImpulse;
    const entryPrice = side === 'BUY'
      ? normalizeBook(recoveryBook).asks[0][0]
      : normalizeBook(recoveryBook).bids[0][0];
    const takeProfitPrice = side === 'BUY'
      ? entryPrice + state.policy.takeProfitImpulseMultiplier * eventImpulse
      : entryPrice - state.policy.takeProfitImpulseMultiplier * eventImpulse;
    if (!(takeProfitPrice > 0) || !(stopPrice > 0)) {
      reject(state, 'invalid_reference_levels');
      continue;
    }
    const event = {
      eventId: `${state.symbol}:${pending.window.windowEnd}:${side}`,
      symbol: state.symbol,
      side,
      liquidationDirection: pressure < 0 ? 'SELL' : 'BUY',
      windowStart: pending.window.windowStart,
      windowEnd: pending.window.windowEnd,
      pressure,
      absolutePressure: Math.abs(pressure),
      threshold: pending.window.threshold,
      preEventMedianDepth: preMedianDepth,
      recoveryDepth,
      recoveryRatio,
      preEventMedianMid: preMedianMid,
      eventExtremeMid,
      eventImpulse,
      recoveryTime: eventTimeOf(recoveryBook),
      decisionTime: eventTimeOf(recoveryBook),
      decisionReceivedAt: receivedAtOf(recoveryBook),
      decisionMid,
      stopPrice,
      takeProfitPrice,
      expectedExitPrice: takeProfitPrice,
      alertLevel: state.policy.alertLevel,
      clusterId: String(Math.floor(pending.window.windowEnd / state.policy.clusterMs)),
      decisionBook: recoveryBook,
      targetRule: 'ENTRY_PLUS_EVENT_IMPULSE_MULTIPLIER'
    };
    state.lastAcceptedWindowEnd = pending.window.windowEnd;
    state.accepted++;
    events.push(event);
  }
  state.pending = remaining;
  return events;
}

function purge(state, now) {
  const tradeCutoff = now - state.policy.tradeLookbackMs - state.policy.windowMs;
  const bookCutoff = now - state.policy.bookRetentionMs;
  const forceCutoff = now - state.policy.windowMs * 2;
  state.trades = state.trades.filter(row => eventTimeOf(row) >= tradeCutoff);
  state.forceOrders = state.forceOrders.filter(row => eventTimeOf(row) >= forceCutoff);
  state.books = state.books.filter(row => eventTimeOf(row) >= bookCutoff);
}

export class LiveH9Scanner {
  constructor({ symbols, policy, state = null, now = Date.now() } = {}) {
    const list = [...new Set((symbols ?? []).map(symbolOf))].sort();
    if (!list.length) throw new Error('symbols must not be empty');
    this.policy = policyOf(policy);
    this.symbols = list;
    this.states = new Map(list.map(symbol => [
      symbol,
      { ...stateFor(symbol, state, this.policy, now), policy: this.policy }
    ]));
    this.lastTickAt = now;
    this.lastDataAt = null;
  }

  stateFor(symbol) {
    const normalized = symbolOf(symbol);
    const state = this.states.get(normalized);
    if (!state) throw new Error(`symbol is outside the live worker universe: ${normalized}`);
    return state;
  }

  touch(state, time) {
    if (state.warmupStartedAt == null) {
      state.warmupStartedAt = Math.floor(time / this.policy.windowMs) * this.policy.windowMs;
    }
    state.lastDataAt = Math.max(state.lastDataAt ?? 0, time);
    this.lastDataAt = Math.max(this.lastDataAt ?? 0, time);
  }

  recordTrade(row) {
    const state = this.stateFor(row?.symbol);
    const eventTime = eventTimeOf(row);
    const receivedAt = receivedAtOf(row, eventTime);
    const quoteNotional = finite('trade quote notional', row.quoteNotional, { minimum: 0 });
    this.touch(state, eventTime);
    state.trades.push({ ...row, eventTime, receivedAt, quoteNotional });
  }

  recordForceOrder(row) {
    const state = this.stateFor(row?.symbol);
    const eventTime = eventTimeOf(row);
    const receivedAt = receivedAtOf(row, eventTime);
    const pressure = finite('force pressure', row.pressure ?? row.quoteNotional);
    this.touch(state, eventTime);
    state.forceOrders.push({ ...row, eventTime, receivedAt, pressure });
  }

  recordBook(row) {
    const symbol = symbolOf(row?.symbol);
    const state = this.stateFor(symbol);
    const eventTime = eventTimeOf(row);
    const receivedAt = receivedAtOf(row, eventTime);
    const book = normalizeBook({ ...row, symbol, eventTime, receivedAt });
    this.touch(state, eventTime);
    state.books.push(book);
  }

  closeWindow(state, windowEnd) {
    const window = publicPressureRow(state, windowEnd);
    state.pressureWindows.push(window);
    const historyCutoff = windowEnd - state.policy.pressureThresholdLookbackMs - state.policy.windowMs;
    state.pressureWindows = state.pressureWindows.filter(row => row.windowEnd >= historyCutoff);
    if (!window.warmupComplete || window.pressure == null || window.threshold == null) return;
    if (!(window.threshold > 0) || Math.abs(window.pressure) < window.threshold) return;
    if (state.lastAcceptedWindowEnd != null
      && window.windowEnd - state.lastAcceptedWindowEnd < state.policy.cooldownMs) {
      reject(state, 'cooldown');
      return;
    }
    const preBooks = state.books.filter(book => {
      const time = eventTimeOf(book);
      return time >= window.windowStart - state.policy.preEventDepthWindowMs
        && time < window.windowStart
        && receivedAtOf(book) <= window.windowEnd;
    });
    const eventBooks = state.books.filter(book => {
      const time = eventTimeOf(book);
      return time >= window.windowStart
        && time < window.windowEnd
        && receivedAtOf(book) <= window.windowEnd;
    });
    if (!preBooks.length || !eventBooks.length) {
      reject(state, 'missing_pre_or_event_book');
      return;
    }
    state.pending.push({ window, preBooks, eventBooks });
  }

  tick(now = Date.now()) {
    const current = integer('tick time', now);
    const events = [];
    for (const state of this.states.values()) {
      purge(state, current);
      const boundary = Math.floor(current / this.policy.windowMs) * this.policy.windowMs;
      if (boundary - state.lastClosedWindowEnd > this.policy.windowMs * 2) {
        state.lastClosedWindowEnd = boundary - this.policy.windowMs;
      }
      while (state.lastClosedWindowEnd + this.policy.windowMs <= boundary) {
        state.lastClosedWindowEnd += this.policy.windowMs;
        this.closeWindow(state, state.lastClosedWindowEnd);
      }
      events.push(...evaluatePending(state, current));
    }
    this.lastTickAt = current;
    return events;
  }

  snapshot() {
    const symbols = {};
    for (const [symbol, state] of this.states.entries()) {
      symbols[symbol] = {
        warmupStartedAt: state.warmupStartedAt,
        lastClosedWindowEnd: state.lastClosedWindowEnd,
        lastAcceptedWindowEnd: state.lastAcceptedWindowEnd,
        pressureWindows: state.pressureWindows
      };
    }
    return {
      schemaVersion: 1,
      savedAt: Date.now(),
      symbols
    };
  }

  status() {
    const rows = [...this.states.values()];
    return {
      symbols: this.symbols,
      lastDataAt: this.lastDataAt,
      acceptedSignals: rows.reduce((total, row) => total + row.accepted, 0),
      rejectedWindows: rows.reduce((total, row) => total + row.rejected, 0),
      rejectionReasons: Object.fromEntries(rows.map(row => [row.symbol, row.rejectionReasons])),
      warmup: Object.fromEntries(rows.map(row => [row.symbol, {
        startedAt: row.warmupStartedAt,
        complete: row.warmupStartedAt != null
          && (row.lastClosedWindowEnd >= row.warmupStartedAt + this.policy.warmupMs),
        pressureWindows: row.pressureWindows.length
      }]))
    };
  }
}

export function liveH9Policy(overrides = {}) {
  return policyOf(overrides);
}
