import { reviewSentSignal, summarizeSentReviews } from '../../src/model/signal-review.mjs';
import { fetchFuturesAggTrades, fetchFuturesKlines } from './market-data.mjs';
import { hasSupabaseConfig, selectRows } from './supabase.mjs';

const OUTBOX_SELECT = 'outbox_id,advisory_id,alert_level,status,sent_at,created_at,body_plain';
const ADVISORY_SELECT = [
  'advisory_id', 'experiment_id', 'symbol', 'advisory_type', 'alert_level',
  'signal_at', 'expires_at', 'entry_reference', 'stop_reference', 'exit_reference', 'holding_period_ms'
].join(',');

function iso(value) {
  return value == null ? null : new Date(value).toISOString();
}

function safeNumber(value) {
  return value == null ? null : Number(value);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function emailPrice(body, labels) {
  if (typeof body !== 'string') return null;
  for (const label of labels) {
    const match = body.match(new RegExp('^' + escapeRegExp(label) + '\\s*[:：]\\s*(.+)$', 'mi'));
    if (!match || match[1].trim().toLowerCase() === 'n/a') continue;
    const parsed = Number(match[1].trim());
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

export function emailReferences(outbox, advisory) {
  const hasEmailBody = typeof outbox?.body_plain === 'string';
  return {
    entryPrice: hasEmailBody
      ? emailPrice(outbox.body_plain, ['入场价', 'Reference entry'])
      : advisory?.entry_reference,
    stopPrice: hasEmailBody
      ? emailPrice(outbox.body_plain, ['止损价', 'Reference stop'])
      : advisory?.stop_reference,
    takeProfitPrice: hasEmailBody
      ? emailPrice(outbox.body_plain, ['止盈价', 'Reference take-profit'])
      : advisory?.exit_reference
  };
}

function publicReview({ outbox, advisory, signal, result }) {
  const reference = signal?.reference ?? {};
  return {
    signalId: advisory?.advisory_id ?? outbox?.advisory_id ?? result.signalId,
    outboxId: outbox?.outbox_id ?? null,
    experimentId: advisory?.experiment_id ?? result.experimentId ?? null,
    sentAt: iso(outbox?.sent_at ?? outbox?.created_at ?? result.entryAt),
    alertLevel: outbox?.alert_level ?? advisory?.alert_level ?? null,
    action: advisory?.advisory_type ?? null,
    symbol: result.symbol ?? advisory?.symbol ?? null,
    side: result.side ?? (advisory?.advisory_type === 'REVIEW_SELL' ? 'SELL' : 'BUY'),
    reference: {
      entryPrice: safeNumber(reference.entryPrice),
      stopPrice: safeNumber(reference.stopPrice),
      takeProfitPrice: safeNumber(reference.takeProfitPrice),
      maximumHoldMs: reference.maximumHoldMs == null ? null : Number(reference.maximumHoldMs)
    },
    status: result.status,
    entryAt: iso(result.entryAt),
    exitAt: iso(result.exitAt),
    exitPrice: result.exitPrice,
    exitReason: result.exitReason,
    pnlBps: result.pnlBps,
    pnlPercent: result.pnlPercent,
    markPrice: result.markPrice,
    markAt: iso(result.markAt),
    markPnlBps: result.markPnlBps,
    checkedAt: iso(result.checkedAt),
    observedUntil: iso(result.observedUntil),
    dataPoints: result.dataPoints,
    dataQuality: result.dataQuality,
    triggerPrecision: result.triggerPrecision,
    reason: result.reason
  };
}

function reviewSignalEnvelope(outbox, advisory) {
  if (!advisory) {
    return {
      signalId: outbox.advisory_id,
      status: 'INVALID',
      reason: 'advisory_not_found'
    };
  }
  return {
    signalId: advisory.advisory_id,
    experimentId: advisory.experiment_id,
    symbol: advisory.symbol,
    action: advisory.advisory_type,
    signalAt: advisory.signal_at,
    expiresAt: advisory.expires_at,
    reference: {
      ...emailReferences(outbox, advisory),
      maximumHoldMs: advisory.holding_period_ms == null ? null : Number(advisory.holding_period_ms)
    }
  };
}

function invalidResult(outbox, advisory, now, reason) {
  const signal = reviewSignalEnvelope(outbox, advisory);
  const result = reviewSentSignal({ signal, sentAt: outbox.sent_at ?? outbox.created_at, now });
  return {
    ...result,
    status: 'INVALID',
    signalId: signal.signalId,
    reason: reason ?? result.reason
  };
}

async function reviewOne({ candidate, candles, now, fetchImpl, tradeCache }) {
  const { signal, outbox, advisory } = candidate;
  let result = reviewSentSignal({
    signal,
    sentAt: outbox.sent_at ?? outbox.created_at,
    candles,
    now
  });
  if (!result.triggerWindow || !['CLOSED', 'DATA_INSUFFICIENT'].includes(result.status)) return result;
  const window = result.triggerWindow;
  const cacheKey = `${signal.symbol}:${window.start}:${window.end}`;
  let trades = tradeCache.get(cacheKey);
  if (!trades) {
    try {
      trades = await fetchFuturesAggTrades(signal.symbol, window.start, window.end, { fetchImpl });
      tradeCache.set(cacheKey, trades);
    } catch (error) {
      return {
        ...result,
        status: 'DATA_INSUFFICIENT',
        dataQuality: 'CANDLE_RANGE',
        reason: error.message === 'market_data_trade_page_limit'
          ? 'aggregate_trade_page_limit'
          : 'aggregate_trade_data_unavailable'
      };
    }
  }
  return reviewSentSignal({
    signal,
    sentAt: outbox.sent_at ?? outbox.created_at,
    candles,
    trades,
    now,
    requireExactTrigger: true
  });
}

/**
 * Read only email-delivered signals and calculate their live paper review.
 * The result is intentionally derived on demand; fixed TP/SL signals may use
 * a declared causal maximum hold, while H12 dynamic-exit emails are rejected
 * by this generic reviewer until a stateful reviewer exists.
 */
export async function readSentReview(
  limit = 100,
  { now = Date.now(), fetchImpl = fetch } = {}
) {
  if (!hasSupabaseConfig()) {
    return {
      configured: false,
      rule: 'ENTRY_FIXED_TP_SL_FIRST_TOUCH_WITH_OPTIONAL_TIME_EXIT',
      marketData: { source: 'BINANCE_USDM_PUBLIC', interval: '1m' },
      reviews: [],
      summary: summarizeSentReviews([])
    };
  }
  const outboxRows = await selectRows('hengyu_email_outbox', {
    select: OUTBOX_SELECT,
    filters: { status: 'eq.SENT', alert_level: 'in.(STRONG,MEDIUM)' },
    order: 'sent_at.desc',
    limit
  });
  const outbox = Array.isArray(outboxRows) ? outboxRows : [];
  if (!outbox.length) {
    return {
      configured: true,
      rule: 'ENTRY_FIXED_TP_SL_FIRST_TOUCH_WITH_OPTIONAL_TIME_EXIT',
      marketData: { source: 'BINANCE_USDM_PUBLIC', interval: '1m' },
      reviews: [],
      summary: summarizeSentReviews([])
    };
  }
  const ids = [...new Set(outbox.map(row => row.advisory_id).filter(Boolean))];
  const advisoryRows = ids.length
    ? await selectRows('hengyu_advisories', {
      select: ADVISORY_SELECT,
      filters: { advisory_id: `in.(${ids.join(',')})` },
      limit: ids.length
    })
    : [];
  const advisories = new Map((Array.isArray(advisoryRows) ? advisoryRows : [])
    .map(row => [row.advisory_id, row]));
  const candidates = outbox.map(row => ({
    outbox: row,
    advisory: advisories.get(row.advisory_id),
    signal: reviewSignalEnvelope(row, advisories.get(row.advisory_id))
  }));
  const results = new Array(candidates.length);
  const validCandidates = [];
  for (const [index, candidate] of candidates.entries()) {
    if (!candidate.advisory) {
      results[index] = invalidResult(candidate.outbox, null, now, 'advisory_not_found');
      continue;
    }
    if (candidate.advisory.experiment_id === 'HY-EXP-0018') {
      results[index] = invalidResult(candidate.outbox, candidate.advisory, now, 'dynamic_exit_requires_stateful_h12_review');
      continue;
    }
    const validation = reviewSentSignal({
      signal: candidate.signal,
      sentAt: candidate.outbox.sent_at ?? candidate.outbox.created_at,
      now
    });
    if (validation.status === 'INVALID') {
      results[index] = validation;
      continue;
    }
    validCandidates.push({ ...candidate, index });
  }

  const bySymbol = new Map();
  for (const candidate of validCandidates) {
    const key = candidate.signal.symbol;
    const sentAt = Date.parse(candidate.outbox.sent_at ?? candidate.outbox.created_at);
    const group = bySymbol.get(key) ?? { start: sentAt, candidates: [] };
    group.start = Math.min(group.start, sentAt);
    group.candidates.push(candidate);
    bySymbol.set(key, group);
  }
  await Promise.all([...bySymbol.entries()].map(async ([symbol, group]) => {
    let candles;
    try {
      candles = await fetchFuturesKlines(symbol, Math.floor(group.start / 60_000) * 60_000, now, { fetchImpl });
    } catch (error) {
      for (const candidate of group.candidates) {
        results[candidate.index] = {
          ...reviewSentSignal({
            signal: candidate.signal,
            sentAt: candidate.outbox.sent_at ?? candidate.outbox.created_at,
            candles: [],
            now
          }),
          status: 'DATA_INSUFFICIENT',
          reason: error.message === 'market_data_request_failed'
            ? 'market_data_request_failed'
            : 'market_data_unavailable'
        };
      }
      return;
    }
    const tradeCache = new Map();
    await Promise.all(group.candidates.map(async candidate => {
      results[candidate.index] = await reviewOne({
        candidate,
        candles,
        now,
        fetchImpl,
        tradeCache
      });
    }));
  }));

  const reviews = candidates.map((candidate, index) => publicReview({
    outbox: candidate.outbox,
    advisory: candidate.advisory,
    signal: candidate.signal,
    result: results[index]
  }));
  return {
    configured: true,
    rule: 'ENTRY_FIXED_TP_SL_FIRST_TOUCH_WITH_OPTIONAL_TIME_EXIT',
    marketData: {
      source: 'BINANCE_USDM_PUBLIC',
      interval: '1m',
      exactTriggerSource: 'aggregate_trades_when_tp_or_sl_candle_is_reached',
      pnlType: 'price_return_before_fees_and_slippage'
    },
    reviews,
    summary: summarizeSentReviews(results)
  };
}
