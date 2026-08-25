import { HY_EXP_0028_SYMBOLS } from '../validation/hy-exp-0028-frozen-constants.mjs';

const PUBLIC_BASE_URL = 'https://fapi.binance.com';
const KLINES_PATH = '/fapi/v1/klines';
const HOUR = 60 * 60 * 1_000;
const FOUR_HOURS = 4 * HOUR;
const FIVE_MINUTES = 5 * 60 * 1_000;
const ONE_HOUR_REQUIRED = 721;
const FOUR_HOUR_REQUIRED = 180;

export const HY_EXP_0028_PUBLIC_MARKET_ENDPOINTS = Object.freeze([
  `${PUBLIC_BASE_URL}${KLINES_PATH}`
]);

function finite(name, value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`invalid ${name}`);
  return parsed;
}

function integer(name, value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`invalid ${name}`);
  return parsed;
}

function publicKlineUrl(symbol, interval, params = {}) {
  if (!HY_EXP_0028_SYMBOLS.includes(symbol)) throw new Error('symbol_not_frozen');
  if (!['1h', '4h', '5m'].includes(interval)) throw new Error('interval_not_allowed');
  const url = new URL(KLINES_PATH, PUBLIC_BASE_URL);
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('interval', interval);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url;
}

async function fetchJson(url, { fetchImpl = fetch, clock = Date.now } = {}) {
  const requestStartedAt = clock();
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  const body = await response.text();
  const receivedAt = clock();
  if (!response.ok) throw new Error(`binance_public_${response.status}`);
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error('binance_public_non_json');
  }
  return { data, requestStartedAt, receivedAt };
}

function normalizeKline(symbol, interval, row, provenance) {
  if (!Array.isArray(row) || row.length < 8) throw new Error(`${symbol}: invalid ${interval} kline`);
  const openTime = integer('openTime', row[0]);
  const closeTime = integer('closeTime', row[6]);
  const intervalMs = interval === '1h' ? HOUR : interval === '4h' ? FOUR_HOURS : FIVE_MINUTES;
  if (closeTime !== openTime + intervalMs - 1) throw new Error(`${symbol}: invalid ${interval} close boundary`);
  return {
    symbol,
    source: 'CONTRACT_PRICE',
    interval,
    openTime,
    closeTime,
    closeBoundary: closeTime + 1,
    open: finite('open', row[1]),
    high: finite('high', row[2]),
    low: finite('low', row[3]),
    close: finite('close', row[4]),
    volume: finite('volume', row[5]),
    quoteVolume: finite('quoteVolume', row[7]),
    tradeCount: Number.isFinite(Number(row[8])) ? Number(row[8]) : null,
    requestStartedAt: provenance.requestStartedAt,
    receivedAt: provenance.receivedAt
  };
}

function completedRows(symbol, interval, rows, asOf, required) {
  const normalized = rows.map(row => normalizeKline(symbol, interval, row, {
    requestStartedAt: null,
    receivedAt: null
  }));
  const completed = normalized.filter(row => row.closeBoundary <= asOf);
  if (completed.length < required) throw new Error(`${symbol}: insufficient completed ${interval} history`);
  return completed.slice(-required);
}

async function fetchCompletedSeries(symbol, interval, {
  asOf,
  fetchImpl = fetch,
  clock = Date.now,
  required
} = {}) {
  const limit = interval === '1h' ? 760 : 190;
  const result = await fetchJson(publicKlineUrl(symbol, interval, { limit }), { fetchImpl, clock });
  const rows = result.data.map(row => normalizeKline(symbol, interval, row, result));
  const completed = rows.filter(row => row.closeBoundary <= asOf);
  if (completed.length < required) throw new Error(`${symbol}: insufficient completed ${interval} history`);
  return completed.slice(-required);
}

export async function fetchHyExp0028CausalInputs({
  asOf = Date.now(),
  fetchImpl = fetch,
  clock = Date.now
} = {}) {
  const captured = await Promise.all(HY_EXP_0028_SYMBOLS.map(async symbol => {
    const [bars1h, bars4h] = await Promise.all([
      fetchCompletedSeries(symbol, '1h', {
        asOf,
        fetchImpl,
        clock,
        required: ONE_HOUR_REQUIRED
      }),
      fetchCompletedSeries(symbol, '4h', {
        asOf,
        fetchImpl,
        clock,
        required: FOUR_HOUR_REQUIRED
      })
    ]);
    return [symbol, { bars1h, bars4h }];
  }));
  return {
    bars1hBySymbol: Object.fromEntries(captured.map(([symbol, rows]) => [symbol, rows.bars1h])),
    bars4hBySymbol: Object.fromEntries(captured.map(([symbol, rows]) => [symbol, rows.bars4h])),
    source: 'BINANCE_FAPI_PUBLIC_CONTRACT_PRICE_KLINES',
    asOf
  };
}

function defaultSleep(delayMs) {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

export async function fetchHyExp0028LiveEntryBar(symbol, targetOpenTime, {
  fetchImpl = fetch,
  clock = Date.now,
  sleepImpl = defaultSleep,
  maxDelayMs = 90_000,
  retryDelayMs = 1_000,
  maxAttempts = 90,
  deadlineAt = null
} = {}) {
  const targetOpen = integer('targetOpenTime', targetOpenTime);
  const targetClose = targetOpen + FIVE_MINUTES - 1;
  const frozenDeadline = targetOpen + Math.min(Number(maxDelayMs), 90_000);
  const requestedDeadline = deadlineAt == null ? null : Number(deadlineAt);
  const deadline = Number.isFinite(requestedDeadline)
    ? Math.min(requestedDeadline, frozenDeadline)
    : frozenDeadline;
  for (let attempt = 0; attempt < maxAttempts && clock() <= deadline; attempt += 1) {
    const result = await fetchJson(publicKlineUrl(symbol, '5m', {
      startTime: targetOpen,
      endTime: targetClose,
      limit: 1
    }), { fetchImpl, clock });
    const row = Array.isArray(result.data)
      ? result.data.find(item => Number(item?.[0]) === targetOpen)
      : null;
    if (row) {
      return normalizeKline(symbol, '5m', row, result);
    }
    const remaining = deadline - clock();
    if (remaining <= 0) break;
    await sleepImpl(Math.min(retryDelayMs, remaining));
  }
  return null;
}

export const HY_EXP_0028_MARKET_DATA_LIMITS = Object.freeze({
  oneHourCompletedBars: ONE_HOUR_REQUIRED,
  fourHourCompletedBars: FOUR_HOUR_REQUIRED,
  liveEntryMaxDelayMs: 90_000
});
