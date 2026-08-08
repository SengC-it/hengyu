const DEFAULT_BASE_URL = 'https://fapi.binance.com';
const CANDLE_INTERVAL_MS = 60_000;
const KLINE_LIMIT = 1_500;
const AGG_TRADE_LIMIT = 1_000;

function symbolOf(value) {
  const symbol = String(value ?? '').toUpperCase();
  if (!/^[A-Z0-9]+$/.test(symbol)) throw new Error('invalid market symbol');
  return symbol;
}

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

function baseUrl() {
  return String(process.env.HENGYU_MARKET_DATA_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
}

async function getJson(path, params, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const url = new URL(`${baseUrl()}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
    if (!response.ok || !Array.isArray(payload)) {
      const error = new Error('market_data_request_failed');
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeKline(row) {
  return {
    openTime: integer('kline open time', row[0]),
    open: finite('kline open', row[1]),
    high: finite('kline high', row[2]),
    low: finite('kline low', row[3]),
    close: finite('kline close', row[4]),
    closeTime: integer('kline close time', row[6])
  };
}

function normalizeAggTrade(row) {
  return {
    id: row.a,
    price: finite('aggregate trade price', row.p),
    quantity: finite('aggregate trade quantity', row.q),
    time: integer('aggregate trade time', row.T)
  };
}

export async function fetchFuturesKlines(
  symbol,
  startTime,
  endTime,
  { fetchImpl = fetch, timeoutMs = 15_000 } = {}
) {
  const safeSymbol = symbolOf(symbol);
  let cursor = integer('kline start time', startTime);
  const end = integer('kline end time', endTime);
  if (cursor > end) return [];
  const rows = [];
  while (cursor <= end) {
    const page = await getJson('/fapi/v1/klines', {
      symbol: safeSymbol,
      interval: '1m',
      startTime: cursor,
      endTime: end,
      limit: KLINE_LIMIT
    }, { fetchImpl, timeoutMs });
    if (!page.length) break;
    const normalized = page.map(normalizeKline);
    rows.push(...normalized);
    const lastOpenTime = normalized.at(-1).openTime;
    const nextCursor = lastOpenTime + CANDLE_INTERVAL_MS;
    if (nextCursor <= cursor) throw new Error('market_data_cursor_stalled');
    cursor = nextCursor;
    if (page.length < KLINE_LIMIT) break;
  }
  return rows.filter(row => row.openTime <= end && row.closeTime >= integer('kline original start time', startTime));
}

export async function fetchFuturesAggTrades(
  symbol,
  startTime,
  endTime,
  { fetchImpl = fetch, timeoutMs = 15_000, maxPages = 20 } = {}
) {
  const safeSymbol = symbolOf(symbol);
  let cursor = integer('aggregate trade start time', startTime);
  const end = integer('aggregate trade end time', endTime);
  if (cursor > end) return [];
  const rows = [];
  for (let pageNumber = 0; cursor <= end; pageNumber += 1) {
    if (pageNumber >= maxPages) throw new Error('market_data_trade_page_limit');
    const page = await getJson('/fapi/v1/aggTrades', {
      symbol: safeSymbol,
      startTime: cursor,
      endTime: end,
      limit: AGG_TRADE_LIMIT
    }, { fetchImpl, timeoutMs });
    if (!page.length) break;
    const normalized = page.map(normalizeAggTrade);
    rows.push(...normalized);
    const lastTime = normalized.at(-1).time;
    const nextCursor = lastTime + 1;
    if (nextCursor <= cursor) throw new Error('market_data_trade_cursor_stalled');
    cursor = nextCursor;
    if (page.length < AGG_TRADE_LIMIT) break;
  }
  return rows.filter(row => row.time >= integer('aggregate original start time', startTime) && row.time <= end);
}
