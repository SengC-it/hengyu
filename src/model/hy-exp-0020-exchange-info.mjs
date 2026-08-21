export const HY_EXP_0020_EXCHANGE_INFO_WINDOW = Object.freeze({
  start: '2024-01-01T00:00:00.000Z',
  endExclusive: '2026-07-01T00:00:00.000Z'
});

export const HY_EXP_0020_EXCHANGE_INFO_REQUIRED_FIELDS = Object.freeze([
  'listingAt',
  'status',
  'tickSize',
  'stepSize',
  'minQty',
  'minNotional',
  'contractType',
  'quoteAsset'
]);

const FOUR_HOURS_MS = 4 * 60 * 60 * 1_000;

function finite(name, value, { minimum = -Infinity, exclusiveMinimum = false } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (exclusiveMinimum ? parsed <= minimum : parsed < minimum)) {
    throw new Error(`invalid ${name}`);
  }
  return parsed;
}

function dateMs(name, value) {
  if (typeof value === 'number') return finite(name, value, { minimum: 0 });
  const parsed = Date.parse(String(value ?? ''));
  if (!Number.isFinite(parsed)) throw new Error(`invalid ${name}`);
  return parsed;
}

function iso(value) {
  return new Date(dateMs('timestamp', value)).toISOString();
}

function symbolOf(value) {
  const symbol = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]*$/.test(symbol)) throw new Error('invalid exchangeInfo symbol');
  return symbol;
}

function filter(symbol, filters, type) {
  return (filters ?? []).find(row => row?.filterType === type) ?? null;
}

function numberFromFilter(name, row, field) {
  return row?.[field] == null ? null : finite(name, row[field], { minimum: 0, exclusiveMinimum: true });
}

function normalizeSource(source) {
  const value = source ?? {};
  return {
    kind: String(value.kind ?? 'current_exchange_info'),
    vendor: String(value.vendor ?? 'binance-usdm'),
    datasetId: value.datasetId == null ? null : String(value.datasetId),
    sourceUrl: value.sourceUrl == null ? null : String(value.sourceUrl),
    license: value.license == null ? null : String(value.license),
    pointInTime: value.pointInTime === true
  };
}

/**
 * Normalize a Binance USD-M exchangeInfo response. The default source is marked
 * current_exchange_info on purpose; historical validation rejects it unless the
 * caller supplies an independently provenance-tagged historical snapshot.
 */
export function normalizeBinanceExchangeInfo({ payload, observedAt, receivedAt, source } = {}) {
  const observed = dateMs('observedAt', observedAt);
  const received = dateMs('receivedAt', receivedAt);
  if (received < observed) throw new Error('exchangeInfo receipt precedes observation');
  if (!Array.isArray(payload?.symbols)) throw new Error('exchangeInfo symbols are missing');
  const symbols = payload.symbols.map(row => {
    const symbol = symbolOf(row.symbol);
    const priceFilter = filter(symbol, row.filters, 'PRICE_FILTER');
    const lotSize = filter(symbol, row.filters, 'LOT_SIZE');
    const marketLotSize = filter(symbol, row.filters, 'MARKET_LOT_SIZE');
    const minNotional = filter(symbol, row.filters, 'MIN_NOTIONAL') ?? filter(symbol, row.filters, 'NOTIONAL');
    return {
      symbol,
      listingAt: row.onboardDate == null ? null : dateMs(`${symbol} onboardDate`, row.onboardDate),
      status: row.status == null ? null : String(row.status).toUpperCase(),
      contractType: row.contractType == null ? null : String(row.contractType).toUpperCase(),
      quoteAsset: row.quoteAsset == null ? null : String(row.quoteAsset).toUpperCase(),
      baseAsset: row.baseAsset == null ? null : String(row.baseAsset).toUpperCase(),
      tickSize: numberFromFilter(`${symbol} tickSize`, priceFilter, 'tickSize'),
      stepSize: numberFromFilter(`${symbol} stepSize`, lotSize, 'stepSize'),
      minQty: numberFromFilter(`${symbol} minQty`, marketLotSize ?? lotSize, 'minQty'),
      minNotional: numberFromFilter(`${symbol} minNotional`, minNotional, 'notional')
        ?? numberFromFilter(`${symbol} minNotional`, minNotional, 'minNotional'),
      rawSymbolHash: row.symbol
    };
  });
  return {
    schemaVersion: 1,
    observedAt: new Date(observed).toISOString(),
    receivedAt: new Date(received).toISOString(),
    source: normalizeSource(source),
    symbols
  };
}

export function buildFourHourDecisionTimes({
  windowStart = HY_EXP_0020_EXCHANGE_INFO_WINDOW.start,
  windowEndExclusive = HY_EXP_0020_EXCHANGE_INFO_WINDOW.endExclusive,
  stepMs = FOUR_HOURS_MS
} = {}) {
  const start = dateMs('windowStart', windowStart);
  const end = dateMs('windowEndExclusive', windowEndExclusive);
  if (end <= start || !Number.isSafeInteger(stepMs) || stepMs <= 0) throw new Error('invalid exchangeInfo time window');
  const times = [];
  for (let time = start; time < end; time += stepMs) times.push(time);
  return times;
}

function snapshotRows(snapshot) {
  if (!Array.isArray(snapshot?.symbols)) return new Map();
  return new Map(snapshot.symbols.map(row => [symbolOf(row.symbol), row]));
}

function sourceErrors(snapshot) {
  const source = snapshot?.source ?? {};
  const errors = [];
  if (!['historical', 'point_in_time', 'tardis_historical'].includes(source.kind)) {
    errors.push('current_exchangeInfo_not_allowed_for_history');
  }
  if (source.pointInTime !== true) errors.push('point_in_time_provenance_missing');
  for (const field of ['datasetId', 'sourceUrl', 'license']) {
    if (!String(source[field] ?? '').trim()) errors.push(`historical_exchangeInfo_${field}_missing`);
  }
  return errors;
}

function rowErrors(row, symbol, decisionTime) {
  const errors = [];
  for (const field of HY_EXP_0020_EXCHANGE_INFO_REQUIRED_FIELDS) {
    if (row?.[field] == null || row[field] === '') errors.push(`${symbol}:missing_${field}`);
  }
  if (row?.status !== 'TRADING') errors.push(`${symbol}:status_not_TRADING`);
  if (row?.contractType !== 'PERPETUAL') errors.push(`${symbol}:contract_not_PERPETUAL`);
  if (!['USDT', 'USDC'].includes(row?.quoteAsset)) errors.push(`${symbol}:unsupported_quote_asset`);
  if (row?.listingAt != null && dateMs(`${symbol} listingAt`, row.listingAt) > decisionTime) {
    errors.push(`${symbol}:listed_after_decision`);
  }
  for (const field of ['tickSize', 'stepSize', 'minQty', 'minNotional']) {
    if (row?.[field] != null) {
      try {
        finite(`${symbol} ${field}`, row[field], { minimum: 0, exclusiveMinimum: true });
      } catch {
        errors.push(`${symbol}:invalid_${field}`);
      }
    }
  }
  return errors;
}

/**
 * Validate historical exchange rules at every requested decision time. The
 * latest snapshot at or before a decision is used only when it is explicitly
 * historical and not stale beyond maxSnapshotAgeMs. No current exchangeInfo
 * fallback is possible in this function.
 */
export function validateHistoricalExchangeInfo({
  snapshots,
  symbols,
  decisionTimes,
  windowStart = null,
  windowEndExclusive = null,
  maxSnapshotAgeMs = FOUR_HOURS_MS
} = {}) {
  const frozenSymbols = [...new Set((symbols ?? []).map(symbolOf))].sort();
  if (!frozenSymbols.length) throw new Error('exchangeInfo symbols must not be empty');
  const times = decisionTimes?.length
    ? decisionTimes.map(value => dateMs('decisionTime', value))
    : buildFourHourDecisionTimes({ windowStart, windowEndExclusive });
  const normalizedSnapshots = (snapshots ?? []).map(snapshot => ({
    ...snapshot,
    observedMs: dateMs('snapshot observedAt', snapshot.observedAt),
    receivedMs: dateMs('snapshot receivedAt', snapshot.receivedAt)
  })).sort((left, right) => left.observedMs - right.observedMs);
  const errors = [];
  if (!normalizedSnapshots.length) errors.push('historical_exchangeInfo_snapshots_missing');
  for (const [index, snapshot] of normalizedSnapshots.entries()) {
    if (snapshot.receivedMs < snapshot.observedMs) errors.push(`snapshot_${index}:receipt_precedes_observation`);
    errors.push(...sourceErrors(snapshot).map(reason => `snapshot_${index}:${reason}`));
  }
  const checked = [];
  for (const decisionTime of times) {
    for (const symbol of frozenSymbols) {
      const candidate = [...normalizedSnapshots].reverse().find(snapshot => snapshot.observedMs <= decisionTime);
      if (!candidate) {
        errors.push(`${symbol}:${new Date(decisionTime).toISOString()}:no_prior_snapshot`);
        continue;
      }
      const age = decisionTime - candidate.observedMs;
      if (age > maxSnapshotAgeMs) {
        errors.push(`${symbol}:${new Date(decisionTime).toISOString()}:snapshot_stale`);
        continue;
      }
      const row = snapshotRows(candidate).get(symbol);
      if (!row) {
        errors.push(`${symbol}:${new Date(decisionTime).toISOString()}:missing_symbol`);
        continue;
      }
      const rowValidation = rowErrors(row, symbol, decisionTime);
      errors.push(...rowValidation.map(reason => `${new Date(decisionTime).toISOString()}:${reason}`));
      checked.push({ symbol, decisionTime: new Date(decisionTime).toISOString(), snapshotObservedAt: candidate.observedAt });
    }
  }
  if (windowStart && windowEndExclusive) {
    const start = dateMs('windowStart', windowStart);
    const end = dateMs('windowEndExclusive', windowEndExclusive);
    if (end <= start) errors.push('invalid_exchangeInfo_window');
    if (normalizedSnapshots[0]?.observedMs > start) errors.push('historical_exchangeInfo_coverage_starts_late');
    if (normalizedSnapshots.at(-1)?.observedMs < end - maxSnapshotAgeMs) {
      errors.push('historical_exchangeInfo_coverage_ends_early');
    }
  }
  return {
    status: errors.length ? 'DATA_FAIL' : 'DATA_FEASIBLE',
    decision: errors.length ? 'STOP' : 'CONTINUE',
    errors,
    checked,
    fallbackUsed: false,
    pnlComputed: false
  };
}

export function auditHistoricalExchangeInfoMetadata({ metadata, requiredSymbols = [] } = {}) {
  const value = metadata ?? {};
  const errors = [];
  if (value.authorized !== true) errors.push('historical_exchangeInfo_not_authorized');
  if (value.dataAvailable !== true) errors.push('historical_exchangeInfo_not_available');
  if (value.pointInTime !== true) errors.push('point_in_time_exchangeInfo_missing');
  if (value.currentExchangeInfoFallback === true) errors.push('current_exchangeInfo_fallback_forbidden');
  const symbols = new Set((value.symbols ?? []).map(symbol => String(symbol).toUpperCase()));
  for (const required of requiredSymbols.map(symbolOf)) {
    if (!symbols.has(required)) errors.push(`${required}:historical_exchangeInfo_coverage_missing`);
  }
  for (const field of HY_EXP_0020_EXCHANGE_INFO_REQUIRED_FIELDS) {
    if (!value.fields?.includes(field)) errors.push(`historical_exchangeInfo_field_missing:${field}`);
  }
  return {
    status: errors.length ? 'DATA_FAIL' : 'DATA_FEASIBLE',
    decision: errors.length ? 'STOP' : 'CONTINUE',
    errors,
    fallbackUsed: false,
    pnlComputed: false
  };
}
