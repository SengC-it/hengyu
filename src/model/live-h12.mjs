import { atrAt } from '../research/h10-trend.mjs';
import { broadBearRegimeTimes } from '../research/h12-regime.mjs';

const FOUR_HOURS = 4 * 60 * 60 * 1000;

export const H12_PRODUCTION_POLICY = Object.freeze({
  experimentId: 'HY-EXP-0018',
  hypothesisId: 'H12',
  symbols: Object.freeze(['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT']),
  entryChannelBars: 120,
  exitChannelBars: 60,
  atrBars: 30,
  initialStopAtrMultiple: 2,
  btcFastSmaBars: 60,
  slowSmaBars: 180,
  minimumBreadth: 4,
  alertLevel: 'MEDIUM'
});

function finite(name, value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`invalid ${name}`);
  return parsed;
}

export function normalizeFourHourKlines(symbol, rows) {
  return rows.map((row, index) => {
    if (!Array.isArray(row) || row.length < 7) throw new Error(`${symbol}: invalid 4h kline ${index}`);
    const openTime = Number(row[0]);
    const closeTime = Number(row[6]);
    if (!Number.isSafeInteger(openTime) || !Number.isSafeInteger(closeTime)) throw new Error(`${symbol}: invalid kline time`);
    return {
      symbol,
      openTime,
      closeTime,
      open: finite('open', row[1]),
      high: finite('high', row[2]),
      low: finite('low', row[3]),
      close: finite('close', row[4])
    };
  });
}

export async function fetchLiveH12Series(symbol, { fetchImpl = fetch } = {}) {
  const bases = [
    'https://fapi.binance.com',
    'https://fapi1.binance.com',
    'https://fapi2.binance.com',
    'https://fapi3.binance.com',
    'https://fapi4.binance.com'
  ];
  const failures = [];
  for (const base of bases) {
    const url = new URL('/fapi/v1/klines', base);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', '4h');
    url.searchParams.set('limit', '220');
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) {
        failures.push(`${url.hostname}:${response.status}`);
        continue;
      }
      const text = await response.text();
      try {
        return normalizeFourHourKlines(symbol, JSON.parse(text));
      } catch {
        failures.push(`${url.hostname}:non_json`);
      }
    } catch (error) {
      failures.push(`${url.hostname}:${error.cause?.code ?? error.name}`);
    }
  }
  throw new Error(`${symbol}: Binance futures endpoints unavailable (${failures.join(', ')})`);
}

export function detectLiveH12Signals(seriesBySymbol, {
  now = Date.now(),
  policy = H12_PRODUCTION_POLICY
} = {}) {
  const completedBySymbol = {};
  for (const symbol of policy.symbols) {
    const completed = (seriesBySymbol[symbol] ?? []).filter(row => row.closeTime < now);
    if (completed.length < policy.slowSmaBars) throw new Error(`${symbol}: insufficient completed 4h history`);
    completedBySymbol[symbol] = completed;
  }
  const reference = completedBySymbol.BTCUSDT;
  const signalTime = reference.at(-1).openTime;
  for (const symbol of policy.symbols) {
    const rows = completedBySymbol[symbol];
    if (rows.at(-1).openTime !== signalTime) throw new Error(`${symbol}: latest completed bar is not aligned`);
  }
  const eligibleTimes = broadBearRegimeTimes(completedBySymbol, {
    symbols: policy.symbols,
    fastBars: policy.btcFastSmaBars,
    slowBars: policy.slowSmaBars,
    minimumBreadth: policy.minimumBreadth
  });
  if (!eligibleTimes.has(signalTime)) return [];

  const signals = [];
  for (const symbol of policy.symbols) {
    const completed = completedBySymbol[symbol];
    const index = completed.length - 1;
    const signalBar = completed[index];
    const priorEntry = completed.slice(index - policy.entryChannelBars, index);
    if (priorEntry.length !== policy.entryChannelBars) continue;
    const priorLow = Math.min(...priorEntry.map(row => row.low));
    if (!(signalBar.close < priorLow)) continue;
    const entryBar = (seriesBySymbol[symbol] ?? []).find(row => row.openTime === signalBar.openTime + FOUR_HOURS);
    if (!entryBar || entryBar.openTime > now) continue;
    const atr = atrAt(completed, index, policy.atrBars);
    if (!(atr > 0)) continue;
    const exitWindow = completed.slice(index - policy.exitChannelBars + 1, index + 1);
    signals.push({
      signalId: `H12:${symbol}:SELL:${signalBar.closeTime}`,
      experimentId: policy.experimentId,
      hypothesisId: policy.hypothesisId,
      symbol,
      side: 'SELL',
      signalTime: signalBar.closeTime,
      entryTime: entryBar.openTime,
      entryPrice: entryBar.open,
      stopPrice: entryBar.open + policy.initialStopAtrMultiple * atr,
      initialExitChannelPrice: Math.max(...exitWindow.map(row => row.high)),
      atr,
      signalClose: signalBar.close,
      priorEntryChannelLow: priorLow,
      alertLevel: policy.alertLevel,
      exitRule: `Exit at the next 4h open after a completed close exceeds the prior ${policy.exitChannelBars}-bar high; fixed initial ${policy.initialStopAtrMultiple} ATR stop takes precedence.`
    });
  }
  return signals;
}

export function h12AdvisoryBundle(signal, { generatedAt = Date.now() } = {}) {
  return {
    kind: 'advisory_bundle',
    record: {
      advisory: {
        advisory_id: signal.signalId,
        experiment_id: signal.experimentId,
        symbol: signal.symbol,
        advisory_type: 'REVIEW_SELL',
        alert_level: signal.alertLevel,
        signal_at: new Date(signal.signalTime).toISOString(),
        expires_at: new Date(signal.entryTime + 90 * 24 * 60 * 60 * 1000).toISOString(),
        entry_reference: signal.entryPrice,
        stop_reference: signal.stopPrice,
        exit_reference: null,
        fee_bps: 10,
        slippage_bps: 4,
        status: 'ADVISORY',
        pnl_eligible: false,
        authorization_mode: 'PAPER_ONLY',
        live_orders_enabled: false,
        dedupe_key: `${signal.experimentId}:${signal.symbol}:SELL:${signal.signalTime}`,
        metadata: {
          source: 'vercel-h12-worker',
          modelId: 'HENGYU-H12-PROD-001',
          hypothesisId: 'H12',
          generatedAt: new Date(generatedAt).toISOString(),
          entryTime: new Date(signal.entryTime).toISOString(),
          signalClose: signal.signalClose,
          priorEntryChannelLow: signal.priorEntryChannelLow,
          atr: signal.atr,
          initialExitChannelPrice: signal.initialExitChannelPrice,
          exitRule: signal.exitRule,
          reviewModel: 'DYNAMIC_DONCHIAN_NOT_FIXED_TP_SL',
          reasons: ['H12_BROAD_BEAR_REGIME', 'H12_120_BAR_DOWNSIDE_BREAKOUT']
        }
      },
      email: {
        requested: false,
        disabledReason: 'EMAIL_STRATEGY_NOT_AUTHORIZED',
        manual_only: true,
        order_placement: false,
        account_access: false
      }
    }
  };
}
