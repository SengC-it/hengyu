const BPS = 10_000;

export const SENT_REVIEW_STATUSES = Object.freeze([
  'CLOSED',
  'HOLDING',
  'DATA_INSUFFICIENT',
  'INVALID'
]);

function finite(name, value, { minimum = -Infinity, exclusiveMinimum = false } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (exclusiveMinimum ? parsed <= minimum : parsed < minimum)) {
    throw new Error(`invalid ${name}`);
  }
  return parsed;
}

function timestamp(name, value) {
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`invalid ${name}`);
  return parsed;
}

function symbolOf(value) {
  const symbol = String(value ?? '').toUpperCase();
  if (!/^[A-Z0-9]+$/.test(symbol)) throw new Error('invalid symbol');
  return symbol;
}

function sideOf(value) {
  const side = String(value ?? '').toUpperCase();
  if (side === 'BUY' || side === 'REVIEW_BUY' || side === 'LONG') return 'BUY';
  if (side === 'SELL' || side === 'REVIEW_SELL' || side === 'SHORT') return 'SELL';
  throw new Error('invalid side');
}

function referenceValue(signal, names) {
  const reference = signal?.reference ?? signal ?? {};
  for (const name of names) {
    if (reference[name] !== undefined && reference[name] !== null && reference[name] !== '') {
      return reference[name];
    }
  }
  return null;
}

function sideFromSignal(signal) {
  return sideOf(signal?.side ?? signal?.action ?? signal?.advisory_type ?? signal?.advisoryType);
}

function signalEntryTime(signal, sentAt) {
  const value = sentAt ?? signal?.sentAt ?? signal?.sent_at
    ?? signal?.generatedAt ?? signal?.signal_at ?? signal?.signalAt ?? signal?.decisionTime;
  return timestamp('sent time', value);
}

function normalizeSignal(signal, sentAt) {
  if (!signal || typeof signal !== 'object') throw new Error('signal is required');
  const side = sideFromSignal(signal);
  const entryPrice = finite('entry price', referenceValue(signal, ['entryPrice', 'entry_reference', 'entryReference']), {
    minimum: 0,
    exclusiveMinimum: true
  });
  const stopPrice = finite('stop price', referenceValue(signal, ['stopPrice', 'stop_reference', 'stopReference']), {
    minimum: 0,
    exclusiveMinimum: true
  });
  const takeProfitPrice = finite('take-profit price', referenceValue(signal, [
    'takeProfitPrice', 'take_profit', 'takeProfit', 'exitReferencePrice', 'exit_reference', 'exitPrice', 'targetPrice'
  ]), { minimum: 0, exclusiveMinimum: true });
  const entryAt = signalEntryTime(signal, sentAt);
  const levelsValid = side === 'BUY'
    ? stopPrice < entryPrice && entryPrice < takeProfitPrice
    : takeProfitPrice < entryPrice && entryPrice < stopPrice;
  if (!levelsValid) throw new Error('price levels are not directional');
  return {
    signalId: signal.signalId ?? signal.advisory_id ?? null,
    experimentId: signal.experimentId ?? signal.experiment_id ?? null,
    symbol: symbolOf(signal.symbol),
    side,
    entryAt,
    entryPrice,
    stopPrice,
    takeProfitPrice
  };
}

function normalizeCandle(row) {
  if (Array.isArray(row)) {
    return {
      openTime: timestamp('candle open time', row[0]),
      open: finite('candle open', row[1], { minimum: 0, exclusiveMinimum: true }),
      high: finite('candle high', row[2], { minimum: 0, exclusiveMinimum: true }),
      low: finite('candle low', row[3], { minimum: 0, exclusiveMinimum: true }),
      close: finite('candle close', row[4], { minimum: 0, exclusiveMinimum: true }),
      closeTime: timestamp('candle close time', row[6] ?? row[0])
    };
  }
  const openTime = timestamp('candle open time', row?.openTime ?? row?.timestamp ?? row?.time ?? row?.t);
  const closeTime = timestamp('candle close time', row?.closeTime ?? row?.endTime ?? row?.T ?? openTime);
  const high = finite('candle high', row?.high ?? row?.h, { minimum: 0, exclusiveMinimum: true });
  const low = finite('candle low', row?.low ?? row?.l, { minimum: 0, exclusiveMinimum: true });
  if (low > high) throw new Error('candle low exceeds high');
  return {
    openTime,
    closeTime,
    open: finite('candle open', row?.open ?? row?.o, { minimum: 0, exclusiveMinimum: true }),
    high,
    low,
    close: finite('candle close', row?.close ?? row?.c, { minimum: 0, exclusiveMinimum: true })
  };
}

function normalizeTrade(row) {
  return {
    time: timestamp('trade time', row?.time ?? row?.tradeTime ?? row?.T ?? row?.timestamp),
    price: finite('trade price', row?.price ?? row?.p, { minimum: 0, exclusiveMinimum: true }),
    id: row?.id ?? row?.aggId ?? row?.a ?? 0
  };
}

function triggerForPrice(side, price, stopPrice, takeProfitPrice) {
  if (side === 'BUY') {
    if (price <= stopPrice) return 'SL';
    if (price >= takeProfitPrice) return 'TP';
  } else {
    if (price >= stopPrice) return 'SL';
    if (price <= takeProfitPrice) return 'TP';
  }
  return null;
}

function candleHits(side, candle, stopPrice, takeProfitPrice) {
  const hits = [];
  if (side === 'BUY') {
    if (candle.low <= stopPrice) hits.push('SL');
    if (candle.high >= takeProfitPrice) hits.push('TP');
  } else {
    if (candle.high >= stopPrice) hits.push('SL');
    if (candle.low <= takeProfitPrice) hits.push('TP');
  }
  return hits;
}

function returnBps(side, entryPrice, exitPrice) {
  const direction = side === 'BUY' ? 1 : -1;
  return direction * (exitPrice - entryPrice) / entryPrice * BPS;
}

function markFor(side, entryPrice, price) {
  return price == null ? null : returnBps(side, entryPrice, price);
}

function baseReview(input, normalized, status, { candles = [], now, reason = null, latest = null } = {}) {
  const latestPrice = latest?.close ?? null;
  return {
    status,
    signalId: normalized.signalId,
    experimentId: normalized.experimentId,
    symbol: normalized.symbol,
    side: normalized.side,
    entryAt: normalized.entryAt,
    entryPrice: normalized.entryPrice,
    stopPrice: normalized.stopPrice,
    takeProfitPrice: normalized.takeProfitPrice,
    exitAt: null,
    exitPrice: null,
    exitReason: null,
    pnlBps: null,
    pnlPercent: null,
    markPrice: latestPrice,
    markAt: latest?.closeTime ?? latest?.openTime ?? null,
    markPnlBps: markFor(normalized.side, normalized.entryPrice, latestPrice),
    checkedAt: now,
    observedUntil: latest?.closeTime ?? latest?.openTime ?? null,
    dataPoints: candles.length,
    dataQuality: candles.length ? 'CANDLE_RANGE' : 'NO_MARKET_DATA',
    triggerPrecision: null,
    triggerWindow: null,
    reason
  };
}

function withClosedReview(review, { exitAt, exitPrice, exitReason, triggerPrecision, triggerWindow }) {
  const pnlBps = returnBps(review.side, review.entryPrice, exitPrice);
  return {
    ...review,
    status: 'CLOSED',
    exitAt,
    exitPrice,
    exitReason,
    pnlBps,
    pnlPercent: pnlBps / 100,
    markPrice: null,
    markAt: null,
    markPnlBps: null,
    dataQuality: triggerPrecision === 'TRADE' ? 'EXACT_TRADE' : 'CANDLE_RANGE',
    triggerPrecision,
    triggerWindow,
    reason: null
  };
}

/**
 * Review one email-delivered signal using only the three prices in that
 * signal. A missing TP/SL or missing market evidence is never turned into a
 * win, loss, or time-based close.
 */
export function reviewSentSignal({
  signal,
  sentAt = null,
  candles = [],
  trades = null,
  now = Date.now(),
  requireExactTrigger = false
} = {}) {
  let normalized;
  try {
    normalized = normalizeSignal(signal, sentAt);
  } catch (error) {
    const raw = signal ?? {};
    return {
      status: 'INVALID',
      signalId: raw.signalId ?? raw.advisory_id ?? null,
      symbol: raw.symbol ?? null,
      side: raw.side ?? raw.action ?? raw.advisory_type ?? null,
      entryPrice: null,
      stopPrice: null,
      takeProfitPrice: null,
      pnlBps: null,
      pnlPercent: null,
      reason: error.message
    };
  }
  const checkedAt = timestamp('review time', now);
  const normalizedCandles = (candles ?? [])
    .map(normalizeCandle)
    .filter(row => row.closeTime >= normalized.entryAt && row.openTime <= checkedAt)
    .sort((left, right) => left.openTime - right.openTime || left.closeTime - right.closeTime);
  const normalizedTrades = trades == null
    ? null
    : trades.map(normalizeTrade).sort((left, right) => {
      if (left.time !== right.time) return left.time - right.time;
      const leftId = Number(left.id);
      const rightId = Number(right.id);
      if (Number.isFinite(leftId) && Number.isFinite(rightId)) return leftId - rightId;
      return String(left.id).localeCompare(String(right.id));
    });
  const latest = normalizedCandles.at(-1) ?? null;
  const review = baseReview(null, normalized, normalizedCandles.length ? 'HOLDING' : 'DATA_INSUFFICIENT', {
    candles: normalizedCandles,
    now: checkedAt,
    latest,
    reason: normalizedCandles.length ? null : 'market_data_missing'
  });
  if (!normalizedCandles.length) return review;

  for (const candle of normalizedCandles) {
    const hits = candleHits(normalized.side, candle, normalized.stopPrice, normalized.takeProfitPrice);
    if (!hits.length) continue;
    const triggerWindow = {
      start: Math.max(normalized.entryAt, candle.openTime),
      end: Math.min(checkedAt, candle.closeTime)
    };
    const candleTrades = normalizedTrades?.filter(row => row.time >= triggerWindow.start && row.time <= triggerWindow.end) ?? null;
    if (candleTrades?.length) {
      for (const trade of candleTrades) {
        const exitReason = triggerForPrice(normalized.side, trade.price, normalized.stopPrice, normalized.takeProfitPrice);
        if (exitReason) {
          return withClosedReview(review, {
            exitAt: trade.time,
            exitPrice: exitReason === 'TP' ? normalized.takeProfitPrice : normalized.stopPrice,
            exitReason,
            triggerPrecision: 'TRADE',
            triggerWindow
          });
        }
      }
    }
    if (requireExactTrigger || hits.length > 1 || candle.openTime < normalized.entryAt) {
      return {
        ...review,
        status: 'DATA_INSUFFICIENT',
        dataQuality: 'CANDLE_RANGE',
        triggerWindow,
        reason: hits.length > 1 ? 'tp_sl_order_unknown_in_same_candle' : 'trigger_trade_data_missing'
      };
    }
    return withClosedReview(review, {
      exitAt: candle.openTime,
      exitPrice: hits[0] === 'TP' ? normalized.takeProfitPrice : normalized.stopPrice,
      exitReason: hits[0],
      triggerPrecision: 'CANDLE',
      triggerWindow
    });
  }
  return review;
}

export function summarizeSentReviews(reviews) {
  const rows = (reviews ?? []).filter(Boolean);
  const closed = rows.filter(row => row.status === 'CLOSED');
  const holding = rows.filter(row => row.status === 'HOLDING');
  const dataInsufficient = rows.filter(row => row.status === 'DATA_INSUFFICIENT');
  const invalid = rows.filter(row => row.status === 'INVALID');
  const wins = closed.filter(row => row.pnlBps > 0);
  const losses = closed.filter(row => row.pnlBps < 0);
  const grossProfitBps = wins.reduce((total, row) => total + row.pnlBps, 0);
  const grossLossBps = losses.reduce((total, row) => total - row.pnlBps, 0);
  const realizedPnlBps = closed.reduce((total, row) => total + row.pnlBps, 0);
  return {
    totalSignals: rows.length,
    closedSignals: closed.length,
    holdingSignals: holding.length,
    dataInsufficientSignals: dataInsufficient.length,
    invalidSignals: invalid.length,
    wins: wins.length,
    losses: losses.length,
    winRatePercent: closed.length ? wins.length / closed.length * 100 : null,
    realizedPnlBps,
    realizedPnlPercent: realizedPnlBps / 100,
    profitFactor: grossLossBps > 0 ? grossProfitBps / grossLossBps : (grossProfitBps > 0 ? Infinity : null),
    openMarkPnlBps: holding.reduce((total, row) => total + (row.markPnlBps ?? 0), 0),
    rule: 'ENTRY_FIXED_TP_SL_FIRST_TOUCH_NO_TIME_EXIT'
  };
}
