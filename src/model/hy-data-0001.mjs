import crypto from 'node:crypto';

export const HY_DATA_0001_DATASET_ID = 'HY-DATA-0001';
export const HY_DATA_0001_BASE_COMMIT = '31e3e278eb82fb77fc962fdabe866f615b481f83';
export const HY_DATA_0001_INTERVAL_MS = 5 * 60 * 1_000;
export const HY_DATA_0001_MAX_SOURCE_AGE_MS = 10 * 60 * 1_000;
export const HY_DATA_0001_EXPECTED_ROWS_PER_DAY = 8 * 24 * 12;
export const HY_DATA_0001_SYMBOLS = Object.freeze([
  'BTCUSDT',
  'ETHUSDT',
  'BNBUSDT',
  'SOLUSDT',
  'XRPUSDT',
  'DOGEUSDT',
  'LINKUSDT',
  'LTCUSDT'
]);

export const HY_DATA_0001_PUBLIC_BASE = 'https://fapi.binance.com/fapi/v1';
export const HY_DATA_0001_TABLES = Object.freeze({
  activation: 'hengyu_hy_data_0001_activation',
  observations: 'hengyu_hy_data_0001_observations',
  health: 'hengyu_hy_data_0001_health'
});
export const HY_DATA_0001_SAFETY = Object.freeze({
  signalOnly: true,
  paperOnly: true,
  liveOrdersEnabled: false,
  accountApi: false,
  orderApi: false,
  automaticTrading: false,
  pnlComputed: false,
  finalOosRead: false
});

const ENDPOINT_PATHS = Object.freeze({
  premiumIndex: '/premiumIndex',
  openInterest: '/openInterest',
  depth: '/depth',
  fundingRate: '/fundingRate',
  klines: '/klines'
});

export function buildHyData0001Urls(symbol) {
  assertSymbol(symbol);
  const encoded = encodeURIComponent(symbol);
  return {
    premiumIndex: `${HY_DATA_0001_PUBLIC_BASE}${ENDPOINT_PATHS.premiumIndex}?symbol=${encoded}`,
    openInterest: `${HY_DATA_0001_PUBLIC_BASE}${ENDPOINT_PATHS.openInterest}?symbol=${encoded}`,
    depth: `${HY_DATA_0001_PUBLIC_BASE}${ENDPOINT_PATHS.depth}?symbol=${encoded}&limit=5`,
    fundingRate: `${HY_DATA_0001_PUBLIC_BASE}${ENDPOINT_PATHS.fundingRate}?symbol=${encoded}&limit=1`,
    klines: `${HY_DATA_0001_PUBLIC_BASE}${ENDPOINT_PATHS.klines}?symbol=${encoded}&interval=5m&limit=2`
  };
}

export function assertSymbol(symbol) {
  if (!HY_DATA_0001_SYMBOLS.includes(symbol)) {
    const error = new Error(`unsupported_symbol:${symbol}`);
    error.code = 'HY_DATA_0001_UNSUPPORTED_SYMBOL';
    throw error;
  }
  return symbol;
}

export function isPublicHyData0001Endpoint(url) {
  const value = String(url);
  return value.startsWith(`${HY_DATA_0001_PUBLIC_BASE}/`)
    && !/(?:\/order|\/account|\/position|\/listenKey|\/leverage|\/margin)/i.test(value);
}

function timestampMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(parsed)) return parsed;
  const date = Date.parse(String(value));
  return Number.isFinite(date) ? date : null;
}

function iso(value) {
  const parsed = timestampMs(value);
  return parsed === null ? null : new Date(parsed).toISOString();
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finiteInteger(value) {
  const parsed = finiteNumber(value);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}

function responseExchangeTime(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (Array.isArray(payload)) return timestampMs(payload[0]?.time ?? payload[0]?.T);
  return timestampMs(payload.serverTime ?? payload.time ?? payload.E ?? payload.T);
}

export async function fetchJsonCompleted({
  url,
  fetchImpl = globalThis.fetch,
  clock = () => Date.now()
}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch_unavailable');
  if (!isPublicHyData0001Endpoint(url)) {
    const error = new Error('non_public_endpoint_rejected');
    error.code = 'HY_DATA_0001_NON_PUBLIC_ENDPOINT';
    throw error;
  }
  const requestStartedAt = clock();
  const response = await fetchImpl(url);
  const text = await response.text();
  const receivedAt = clock();
  let payload;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    const error = new Error('binance_invalid_json');
    error.code = 'HY_DATA_0001_INVALID_JSON';
    error.requestStartedAt = requestStartedAt;
    error.receivedAt = receivedAt;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(`binance_http_${response.status}`);
    error.code = 'HY_DATA_0001_BINANCE_HTTP_ERROR';
    error.status = response.status;
    error.payload = payload;
    error.requestStartedAt = requestStartedAt;
    error.receivedAt = receivedAt;
    throw error;
  }
  return {
    url,
    payload,
    requestStartedAt,
    receivedAt,
    exchangeObservedAt: responseExchangeTime(payload),
    bodyCompleted: true
  };
}

async function fetchSymbolPayloads({ symbol, fetchImpl, clock }) {
  const urls = buildHyData0001Urls(symbol);
  const entries = await Promise.all(
    Object.entries(urls).map(async ([name, url]) => [
      name,
      await fetchJsonCompleted({ url, fetchImpl, clock })
    ])
  );
  return Object.fromEntries(entries);
}

function addFlag(flags, flag) {
  if (!flags.includes(flag)) flags.push(flag);
}

function readNumber(value, flags, label, { positive = false, nonNegative = false } = {}) {
  const parsed = finiteNumber(value);
  if (parsed === null || (positive && parsed <= 0) || (nonNegative && parsed < 0)) {
    addFlag(flags, `INVALID_NUMERIC:${label}`);
    return null;
  }
  return parsed;
}

function readTimestamp(value, flags, label) {
  const parsed = timestampMs(value);
  if (parsed === null) addFlag(flags, `INVALID_TIMESTAMP:${label}`);
  return parsed;
}

function sourceTimestampRecord(response, extra = {}) {
  return {
    endpoint: response?.url ?? null,
    requestStartedAt: iso(response?.requestStartedAt),
    exchangeEventAt: iso(response?.exchangeObservedAt),
    receivedAt: iso(response?.receivedAt),
    ...extra
  };
}

function normalizeDepth(payload, flags) {
  const normalized = { bids: [], asks: [], lastUpdateId: null };
  if (!payload || typeof payload !== 'object') {
    addFlag(flags, 'MISSING_DEPTH_SNAPSHOT');
    return normalized;
  }
  normalized.lastUpdateId = finiteInteger(payload.lastUpdateId);
  if (normalized.lastUpdateId === null) addFlag(flags, 'INVALID_NUMERIC:depth.lastUpdateId');
  for (const side of ['bids', 'asks']) {
    const levels = Array.isArray(payload[side]) ? payload[side].slice(0, 5) : [];
    if (levels.length === 0) addFlag(flags, `MISSING_DEPTH_LEVELS:${side}`);
    normalized[side] = levels.map((level, index) => {
      if (!Array.isArray(level) || level.length < 2) {
        addFlag(flags, `INVALID_DEPTH_LEVEL:${side}:${index}`);
        return null;
      }
      const price = readNumber(level[0], flags, `depth.${side}.${index}.price`, { positive: true });
      const quantity = readNumber(level[1], flags, `depth.${side}.${index}.quantity`, { nonNegative: true });
      return { price, quantity };
    }).filter(Boolean);
  }
  return normalized;
}

function chooseCompletedBar(payload, requestStartedAt, flags) {
  const candidates = Array.isArray(payload) ? payload : [];
  const completed = candidates
    .map((row, index) => ({ row, index, closeTime: timestampMs(row?.[6]), openTime: timestampMs(row?.[0]) }))
    .filter(item => item.closeTime !== null && item.openTime !== null && item.closeTime < requestStartedAt)
    .sort((left, right) => right.closeTime - left.closeTime);
  const selected = completed[0];
  if (!selected || !Array.isArray(selected.row) || selected.row.length < 11) {
    addFlag(flags, 'MISSING_COMPLETED_5M_BAR');
    return null;
  }
  return {
    raw: selected.row,
    openTime: selected.openTime,
    closeTime: selected.closeTime,
    open: selected.row[1],
    high: selected.row[2],
    low: selected.row[3],
    close: selected.row[4],
    volume: selected.row[5],
    quoteVolume: selected.row[7],
    tradeCount: selected.row[8],
    takerBuyVolume: selected.row[9],
    takerBuyQuoteVolume: selected.row[10]
  };
}

function findFundingRow(payload, symbol, flags) {
  if (!Array.isArray(payload) || payload.length === 0) {
    addFlag(flags, 'MISSING_FUNDING_ROW');
    return null;
  }
  const row = payload.find(candidate => candidate?.symbol === symbol) ?? payload[0];
  if (row?.symbol !== symbol) addFlag(flags, 'MISSING_SYMBOL:fundingRate');
  return row;
}

function checkPayloadSymbol(payload, symbol, flags, label) {
  if (payload && payload.symbol !== undefined && payload.symbol !== symbol) {
    addFlag(flags, `MISSING_SYMBOL:${label}`);
  }
}

function checkFutureAndActivation(sourceTimes, receivedAt, activationAt, flags) {
  for (const [label, value] of Object.entries(sourceTimes)) {
    const parsed = timestampMs(value);
    if (parsed === null) continue;
    if (parsed > receivedAt) addFlag(flags, `FUTURE_SOURCE_TIMESTAMP:${label}`);
    if (activationAt !== null && parsed < activationAt) addFlag(flags, `PRE_ACTIVATION_SOURCE:${label}`);
  }
}

function checkStale(value, receivedAt, maxAgeMs, flags, label) {
  const parsed = timestampMs(value);
  if (parsed !== null && receivedAt - parsed > maxAgeMs) addFlag(flags, `STALE_DATA:${label}`);
}

export function normalizeHyData0001Observation({
  symbol,
  payloads,
  collectorActivatedAt,
  observationAt,
  previousObservation = null,
  maxSourceAgeMs = HY_DATA_0001_MAX_SOURCE_AGE_MS
}) {
  assertSymbol(symbol);
  const flags = [];
  const activationAt = timestampMs(collectorActivatedAt);
  const observationBoundary = timestampMs(observationAt);
  if (activationAt === null) addFlag(flags, 'INVALID_ACTIVATION_TIMESTAMP');
  if (observationBoundary === null) addFlag(flags, 'INVALID_OBSERVATION_TIMESTAMP');

  const premium = payloads?.premiumIndex;
  const interest = payloads?.openInterest;
  const depthResponse = payloads?.depth;
  const fundingResponse = payloads?.fundingRate;
  const klinesResponse = payloads?.klines;
  const premiumPayload = premium?.payload;
  const interestPayload = interest?.payload;
  const depthPayload = depthResponse?.payload;
  const fundingRow = findFundingRow(fundingResponse?.payload, symbol, flags);
  const bar = chooseCompletedBar(klinesResponse?.payload, klinesResponse?.requestStartedAt ?? 0, flags);

  checkPayloadSymbol(premiumPayload, symbol, flags, 'premiumIndex');
  checkPayloadSymbol(interestPayload, symbol, flags, 'openInterest');
  checkPayloadSymbol(fundingRow, symbol, flags, 'fundingRate');

  const markPrice = readNumber(premiumPayload?.markPrice, flags, 'markPrice', { positive: true });
  const indexPrice = readNumber(premiumPayload?.indexPrice, flags, 'indexPrice', { positive: true });
  const nextFundingTime = readTimestamp(premiumPayload?.nextFundingTime, flags, 'nextFundingTime');
  const premiumFundingRate = readNumber(premiumPayload?.lastFundingRate, flags, 'lastFundingRate');
  const fundingRate = readNumber(fundingRow?.fundingRate ?? premiumPayload?.lastFundingRate, flags, 'currentFundingRate');
  const fundingTime = readTimestamp(fundingRow?.fundingTime, flags, 'fundingTime');
  const openInterest = readNumber(interestPayload?.openInterest, flags, 'openInterest', { nonNegative: true });

  const depth = normalizeDepth(depthPayload, flags);
  const bestBid = depth.bids[0]?.price ?? null;
  const bestAsk = depth.asks[0]?.price ?? null;
  if (bestBid === null) addFlag(flags, 'MISSING_BEST_BID');
  if (bestAsk === null) addFlag(flags, 'MISSING_BEST_ASK');
  if (bestBid !== null && bestAsk !== null && bestAsk < bestBid) addFlag(flags, 'CROSSED_BOOK');
  const spreadBps = bestBid !== null && bestAsk !== null && bestBid > 0
    ? ((bestAsk - bestBid) / ((bestAsk + bestBid) / 2)) * 10_000
    : null;
  if (spreadBps !== null && spreadBps < 0) addFlag(flags, 'INVALID_NUMERIC:spreadBps');

  let barOpenTime = null;
  let barCloseTime = null;
  let barOpen = null;
  let barHigh = null;
  let barLow = null;
  let barClose = null;
  let barVolume = null;
  let barQuoteVolume = null;
  let barTradeCount = null;
  let barTakerBuyVolume = null;
  let barTakerBuyQuoteVolume = null;
  if (bar) {
    barOpenTime = bar.openTime;
    barCloseTime = bar.closeTime;
    if (barOpenTime % HY_DATA_0001_INTERVAL_MS !== 0
      || barCloseTime !== barOpenTime + HY_DATA_0001_INTERVAL_MS - 1) {
      addFlag(flags, 'INVALID_BAR_BOUNDARY');
    }
    barOpen = readNumber(bar.open, flags, 'barOpen', { positive: true });
    barHigh = readNumber(bar.high, flags, 'barHigh', { positive: true });
    barLow = readNumber(bar.low, flags, 'barLow', { positive: true });
    barClose = readNumber(bar.close, flags, 'barClose', { positive: true });
    barVolume = readNumber(bar.volume, flags, 'barVolume', { nonNegative: true });
    barQuoteVolume = readNumber(bar.quoteVolume, flags, 'barQuoteVolume', { nonNegative: true });
    barTradeCount = finiteInteger(bar.tradeCount);
    if (barTradeCount === null || barTradeCount < 0) addFlag(flags, 'INVALID_NUMERIC:barTradeCount');
    barTakerBuyVolume = readNumber(bar.takerBuyVolume, flags, 'barTakerBuyVolume', { nonNegative: true });
    barTakerBuyQuoteVolume = readNumber(bar.takerBuyQuoteVolume, flags, 'barTakerBuyQuoteVolume', { nonNegative: true });
  }
  const takerBuyRatio = barVolume !== null && barVolume > 0 && barTakerBuyVolume !== null
    ? barTakerBuyVolume / barVolume
    : null;
  if (takerBuyRatio === null) addFlag(flags, 'MISSING_TAKER_BUY_RATIO');
  if (takerBuyRatio !== null && (takerBuyRatio < 0 || takerBuyRatio > 1)) addFlag(flags, 'INVALID_NUMERIC:takerBuyRatio');
  const premiumBasisBps = markPrice !== null && indexPrice !== null && indexPrice > 0
    ? ((markPrice / indexPrice) - 1) * 10_000
    : null;

  const responses = { premiumIndex: premium, openInterest: interest, depth: depthResponse, fundingRate: fundingResponse, klines: klinesResponse };
  for (const [label, response] of Object.entries(responses)) {
    const started = timestampMs(response?.requestStartedAt);
    const received = timestampMs(response?.receivedAt);
    if (started !== null && received !== null && received < started) {
      addFlag(flags, `TIMESTAMP_REVERSAL:${label}`);
    }
  }
  const receivedAt = Math.max(...Object.values(responses).map(response => timestampMs(response?.receivedAt) ?? 0));
  const requestStarted = Math.min(...Object.values(responses).map(response => timestampMs(response?.requestStartedAt) ?? Number.POSITIVE_INFINITY));
  if (!Number.isFinite(receivedAt) || receivedAt <= 0) addFlag(flags, 'MISSING_RECEIVED_TIMESTAMP');
  if (!Number.isFinite(requestStarted)) addFlag(flags, 'MISSING_REQUEST_TIMESTAMP');
  if (receivedAt < requestStarted) addFlag(flags, 'TIMESTAMP_REVERSAL:requestReceived');

  const eventTimes = {
    premiumIndex: timestampMs(premiumPayload?.time),
    openInterest: timestampMs(interestPayload?.time),
    fundingTime,
    barOpenTime,
    barCloseTime
  };
  checkFutureAndActivation(eventTimes, receivedAt, activationAt, flags);
  checkStale(eventTimes.premiumIndex, receivedAt, maxSourceAgeMs, flags, 'premiumIndex');
  checkStale(eventTimes.openInterest, receivedAt, maxSourceAgeMs, flags, 'openInterest');
  checkStale(eventTimes.barCloseTime, receivedAt, maxSourceAgeMs, flags, 'bar');
  if (fundingTime !== null && fundingTime > (timestampMs(fundingResponse?.receivedAt) ?? receivedAt)) {
    addFlag(flags, 'FUTURE_SOURCE_TIMESTAMP:fundingTime');
  }
  if (activationAt !== null && observationBoundary !== null && observationBoundary < activationAt) {
    addFlag(flags, 'PRE_ACTIVATION_OBSERVATION');
  }
  if (activationAt !== null && barOpenTime !== null && barOpenTime < activationAt) {
    addFlag(flags, 'PRE_ACTIVATION_BAR');
  }

  if (previousObservation) {
    const previousAt = timestampMs(previousObservation.observationAt ?? previousObservation.observation_at);
    const previousBar = timestampMs(previousObservation.barOpenTime ?? previousObservation.bar_open_time);
    if (previousAt !== null && observationBoundary !== null && observationBoundary < previousAt) {
      addFlag(flags, 'TIMESTAMP_REVERSAL:observationAt');
    }
    if (previousBar !== null && barOpenTime !== null && barOpenTime <= previousBar) {
      addFlag(flags, 'REPEATED_SOURCE_BAR');
    }
  }

  const sourceTimestamps = {
    premiumIndex: sourceTimestampRecord(premium, { exchangeEventAt: iso(eventTimes.premiumIndex) }),
    openInterest: sourceTimestampRecord(interest, { exchangeEventAt: iso(eventTimes.openInterest) }),
    depth: sourceTimestampRecord(depthResponse),
    fundingRate: sourceTimestampRecord(fundingResponse, {
      exchangeEventAt: iso(fundingTime),
      fundingTime: iso(fundingTime)
    }),
    klines: sourceTimestampRecord(klinesResponse, {
      exchangeEventAt: iso(barCloseTime),
      barOpenTime: iso(barOpenTime),
      barCloseTime: iso(barCloseTime)
    })
  };
  const exchangeEventAt = Object.values(eventTimes)
    .filter(value => value !== null)
    .reduce((latest, value) => Math.max(latest, value), 0) || null;
  const normalized = {
    datasetId: HY_DATA_0001_DATASET_ID,
    symbol,
    collectorActivatedAt: iso(activationAt),
    observationAt: iso(observationBoundary),
    requestStartedAt: iso(requestStarted),
    exchangeEventAt: iso(exchangeEventAt),
    receivedAt: iso(receivedAt),
    scannerDelayMs: observationBoundary !== null && Number.isFinite(receivedAt)
      ? Math.max(0, receivedAt - observationBoundary)
      : null,
    markPrice,
    indexPrice,
    currentFundingRate: fundingRate ?? premiumFundingRate,
    nextFundingTime: iso(nextFundingTime),
    fundingTime: iso(fundingTime),
    openInterest,
    bestBid,
    bestAsk,
    spreadBps,
    depthSnapshot: {
      lastUpdateId: depth.lastUpdateId,
      bids: depth.bids,
      asks: depth.asks
    },
    barOpenTime: iso(barOpenTime),
    barCloseTime: iso(barCloseTime),
    barOpen,
    barHigh,
    barLow,
    barClose,
    barVolume,
    barQuoteVolume,
    barTradeCount,
    barTakerBuyVolume,
    barTakerBuyQuoteVolume,
    takerBuyRatio,
    premiumBasisBps,
    sourceEndpoint: Object.values(ENDPOINT_PATHS).map(path => `${HY_DATA_0001_PUBLIC_BASE}${path}`).join(','),
    sourceType: 'BINANCE_USDM_PUBLIC_REST',
    sourceTimestamps,
    rawValues: Object.fromEntries(Object.entries(responses).map(([name, response]) => [name, response?.payload ?? null])),
    normalizedValues: {
      markPrice,
      indexPrice,
      currentFundingRate: fundingRate ?? premiumFundingRate,
      nextFundingTime: iso(nextFundingTime),
      openInterest,
      bestBid,
      bestAsk,
      spreadBps,
      fundingTime: iso(fundingTime),
      depthSnapshot: {
        lastUpdateId: depth.lastUpdateId,
        bids: depth.bids,
        asks: depth.asks
      },
      barOpenTime: iso(barOpenTime),
      barCloseTime: iso(barCloseTime),
      barOpen,
      barHigh,
      barLow,
      barClose,
      barVolume,
      barQuoteVolume,
      barTradeCount,
      barTakerBuyVolume,
      barTakerBuyQuoteVolume,
      takerBuyRatio,
      premiumBasisBps
    },
    qualityFlags: flags,
    isValid: flags.length === 0,
    idempotencyKey: observationBoundary === null ? null : `${symbol}:${iso(observationBoundary)}`
  };
  return normalized;
}

export async function collectHyData0001Cycle({
  fetchImpl = globalThis.fetch,
  clock = () => Date.now(),
  collectorActivatedAt,
  previousBySymbol = new Map(),
  symbols = HY_DATA_0001_SYMBOLS,
  maxSourceAgeMs = HY_DATA_0001_MAX_SOURCE_AGE_MS
} = {}) {
  const cycleStartedAt = clock();
  const activationAt = timestampMs(collectorActivatedAt) ?? cycleStartedAt;
  const observationAt = Math.floor(cycleStartedAt / HY_DATA_0001_INTERVAL_MS) * HY_DATA_0001_INTERVAL_MS;
  const observations = [];
  const failures = [];
  await Promise.all(symbols.map(async symbol => {
    try {
      assertSymbol(symbol);
      const payloads = await fetchSymbolPayloads({ symbol, fetchImpl, clock });
      const previous = previousBySymbol instanceof Map
        ? previousBySymbol.get(symbol)
        : previousBySymbol?.[symbol];
      observations.push(normalizeHyData0001Observation({
        symbol,
        payloads,
        collectorActivatedAt: activationAt,
        observationAt,
        previousObservation: previous,
        maxSourceAgeMs
      }));
    } catch (error) {
      failures.push({
        symbol,
        reason: error.code ?? error.message ?? 'collection_failed'
      });
    }
  }));
  observations.sort((left, right) => left.symbol.localeCompare(right.symbol));
  const health = buildHyData0001HealthReport({
    observations,
    failures,
    cycleStartedAt,
    cycleFinishedAt: clock(),
    expectedSymbolCount: symbols.length
  });
  return { observations, failures, health, cycleStartedAt, activationAt };
}

export function buildHyData0001HealthReport({
  observations,
  failures = [],
  cycleStartedAt,
  cycleFinishedAt,
  expectedSymbolCount = HY_DATA_0001_SYMBOLS.length
}) {
  const rows = Array.isArray(observations) ? observations : [];
  const covered = [...new Set(rows.map(row => row.symbol))].sort();
  const staleObservations = rows.filter(row => row.qualityFlags.some(flag => flag.startsWith('STALE_DATA'))).length;
  const missingIntervals = failures.map(failure => ({
    symbol: failure.symbol,
    observationAt: iso(cycleStartedAt),
    reason: failure.reason
  }));
  const delays = rows.map(row => row.scannerDelayMs).filter(value => Number.isFinite(value));
  const validRows = rows.filter(row => row.isValid);
  const lastSuccessful = validRows
    .map(row => timestampMs(row.receivedAt))
    .filter(value => value !== null)
    .sort((left, right) => right - left)[0] ?? null;
  return {
    datasetId: HY_DATA_0001_DATASET_ID,
    reportedAt: iso(cycleFinishedAt ?? Date.now()),
    collectorActivatedAt: iso(rows[0]?.collectorActivatedAt ?? cycleStartedAt),
    rowsCollected: rows.length,
    symbolsCovered: covered,
    expectedObservationCount: expectedSymbolCount,
    actualObservationCount: rows.length,
    validObservationCount: validRows.length,
    missingIntervals,
    staleObservations,
    maximumCollectionDelayMs: delays.length ? Math.max(...delays) : null,
    lastSuccessfulTimestamp: iso(lastSuccessful),
    status: rows.length === expectedSymbolCount && validRows.length === rows.length && failures.length === 0
      ? 'HEALTHY'
      : 'DEGRADED',
    pnlComputed: false,
    finalOosRead: false,
    signalsEmitted: false,
    tradingAlertsEmitted: false
  };
}

export function toHyData0001ObservationRow(observation) {
  return {
    dataset_id: observation.datasetId,
    collector_activated_at: observation.collectorActivatedAt,
    observation_at: observation.observationAt,
    symbol: observation.symbol,
    idempotency_key: observation.idempotencyKey,
    source_endpoint: observation.sourceEndpoint,
    source_type: observation.sourceType,
    request_started_at: observation.requestStartedAt,
    exchange_event_at: observation.exchangeEventAt,
    received_at: observation.receivedAt,
    scanner_delay_ms: observation.scannerDelayMs,
    mark_price: observation.markPrice,
    index_price: observation.indexPrice,
    current_funding_rate: observation.currentFundingRate,
    next_funding_time: observation.nextFundingTime,
    funding_time: observation.fundingTime,
    open_interest: observation.openInterest,
    best_bid: observation.bestBid,
    best_ask: observation.bestAsk,
    spread_bps: observation.spreadBps,
    depth_snapshot: observation.depthSnapshot,
    bar_open_time: observation.barOpenTime,
    bar_close_time: observation.barCloseTime,
    bar_open: observation.barOpen,
    bar_high: observation.barHigh,
    bar_low: observation.barLow,
    bar_close: observation.barClose,
    bar_volume: observation.barVolume,
    bar_quote_volume: observation.barQuoteVolume,
    bar_trade_count: observation.barTradeCount,
    bar_taker_buy_volume: observation.barTakerBuyVolume,
    bar_taker_buy_quote_volume: observation.barTakerBuyQuoteVolume,
    taker_buy_ratio: observation.takerBuyRatio,
    premium_basis_bps: observation.premiumBasisBps,
    source_timestamps: observation.sourceTimestamps,
    raw_values: observation.rawValues,
    normalized_values: observation.normalizedValues,
    quality_flags: observation.qualityFlags,
    is_valid: observation.isValid,
    signal_only: true,
    authorization_mode: 'PAPER_ONLY',
    live_orders_enabled: false,
    account_api: false,
    order_api: false,
    automatic_trading: false
  };
}

export function toHyData0001HealthRow(health) {
  return {
    dataset_id: health.datasetId,
    collector_activated_at: health.collectorActivatedAt,
    reported_at: health.reportedAt,
    rows_collected: health.rowsCollected,
    symbols_covered: health.symbolsCovered,
    expected_observation_count: health.expectedObservationCount,
    actual_observation_count: health.actualObservationCount,
    valid_observation_count: health.validObservationCount,
    missing_intervals: health.missingIntervals,
    stale_observations: health.staleObservations,
    maximum_collection_delay_ms: health.maximumCollectionDelayMs,
    last_successful_timestamp: health.lastSuccessfulTimestamp,
    status: health.status,
    details: {
      pnlComputed: false,
      finalOosRead: false,
      signalsEmitted: false,
      tradingAlertsEmitted: false
    },
    signal_only: true,
    authorization_mode: 'PAPER_ONLY',
    live_orders_enabled: false,
    account_api: false,
    order_api: false,
    automatic_trading: false
  };
}

export function createHyData0001RequestSignature({ body, timestamp, secret }) {
  if (!secret) throw new Error('hy_data_0001_ingest_secret_required');
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

export function verifyHyData0001RequestSignature({ body, timestamp, signature, secret, now = Date.now(), maxAgeMs = 300_000 }) {
  if (!secret) return { ok: false, status: 503, reason: 'ingest_secret_not_configured' };
  const numericTimestamp = Number(timestamp);
  const timestampMsValue = numericTimestamp < 1_000_000_000_000 ? numericTimestamp * 1_000 : numericTimestamp;
  if (!Number.isFinite(timestampMsValue) || Math.abs(now - timestampMsValue) > maxAgeMs) {
    return { ok: false, status: 401, reason: 'stale_signature' };
  }
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature)) {
    return { ok: false, status: 401, reason: 'invalid_signature' };
  }
  const expected = createHyData0001RequestSignature({ body, timestamp, secret });
  const valid = crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  return valid ? { ok: true } : { ok: false, status: 401, reason: 'invalid_signature' };
}

export function activationTimestampFromEnvironment({ env = process.env, now = Date.now() } = {}) {
  const raw = env.HENGYU_HY_DATA_0001_ACTIVATED_AT;
  if (raw === undefined || raw === '') return null;
  const value = timestampMs(raw);
  if (value === null) throw new Error('invalid_hy_data_0001_activation_timestamp');
  if (value > now) throw new Error('future_hy_data_0001_activation_timestamp');
  return value;
}
