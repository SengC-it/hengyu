import { createHash } from 'node:crypto';

const DAY_MS = 86_400_000;

const DEFAULT_EXCLUDED_BASE_ASSETS = new Set([
  'USDT', 'USDC', 'BUSD', 'DAI', 'FDUSD', 'TUSD', 'USDP', 'USDE', 'USD1'
]);

export const DEFAULT_UNIVERSE_POLICY = Object.freeze({
  minListingAgeMs: 30 * DAY_MS,
  allowedQuoteAssets: ['USDT', 'USDC'],
  minTierAQuoteVolumeUsdt: 10_000_000,
  minTierBQuoteVolumeUsdt: 1_000_000,
  minTierADepthUsdt: 500_000,
  minTierBDepthUsdt: 100_000,
  depthBps: 10,
  maxDepthAgeMs: 5_000,
  maxSymbols: 200,
  excludedBaseAssets: [...DEFAULT_EXCLUDED_BASE_ASSETS]
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

function upper(value) {
  return String(value ?? '').trim().toUpperCase();
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sourceTime(row, observedAt, label) {
  const value = row?.asOf ?? row?.observedAt ?? row?.eventTime ?? row?.closeTime ?? observedAt;
  const time = integer(`${label} source time`, value);
  if (time > observedAt) throw new Error(`${label} contains future data`);
  return time;
}

function excludedBaseAsset(baseAsset, policy) {
  const base = upper(baseAsset);
  const excluded = new Set((policy.excludedBaseAssets ?? []).map(upper));
  return excluded.has(base) || /(?:UP|DOWN|BULL|BEAR|[123]L|[123]S)$/.test(base);
}

function normalizeExchangeInfoRow(row, observedAt) {
  if (!row || typeof row !== 'object') throw new Error('exchange info row is invalid');
  const symbol = symbolOf(row.symbol);
  const baseAsset = upper(row.baseAsset);
  const quoteAsset = upper(row.quoteAsset ?? row.marginAsset);
  const contractType = upper(row.contractType);
  const status = upper(row.status);
  const onboardDate = integer(`${symbol} onboardDate`, row.onboardDate ?? 0);
  sourceTime(row, observedAt, `${symbol} exchange info`);
  return {
    symbol,
    baseAsset,
    quoteAsset,
    contractType,
    status,
    onboardDate,
    deliveryDate: row.deliveryDate == null ? null : integer(`${symbol} deliveryDate`, row.deliveryDate)
  };
}

function normalizeTickerRow(row, observedAt) {
  if (!row || typeof row !== 'object') throw new Error('ticker row is invalid');
  const symbol = symbolOf(row.symbol ?? row.s);
  const quoteVolumeUsdt = finite(`${symbol} quoteVolume`, row.quoteVolume ?? row.q, { minimum: 0 });
  const asOf = sourceTime(row, observedAt, `${symbol} ticker`);
  return { symbol, quoteVolumeUsdt, asOf };
}

function levelPrice(level, label) {
  if (!Array.isArray(level) || level.length < 2) throw new Error(`invalid ${label} level`);
  return {
    price: finite(`${label} price`, level[0], { minimum: 0, exclusiveMinimum: true }),
    quantity: finite(`${label} quantity`, level[1], { minimum: 0 })
  };
}

export function depthQuoteWithinBps(book, { depthBps = DEFAULT_UNIVERSE_POLICY.depthBps } = {}) {
  const firstBid = Number(book?.bids?.[0]?.[0]);
  const firstAsk = Number(book?.asks?.[0]?.[0]);
  const midPrice = finite('depth mid price', book?.midPrice ?? ((firstBid + firstAsk) / 2), {
    minimum: 0,
    exclusiveMinimum: true
  });
  const distance = midPrice * finite('depthBps', depthBps, { minimum: 0 }) / 10_000;
  const bids = (book?.bids ?? []).map((level, index) => levelPrice(level, `bid[${index}]`));
  const asks = (book?.asks ?? []).map((level, index) => levelPrice(level, `ask[${index}]`));
  const bidDepthUsdt = bids
    .filter(level => level.price >= midPrice - distance)
    .reduce((total, level) => total + level.price * level.quantity, 0);
  const askDepthUsdt = asks
    .filter(level => level.price <= midPrice + distance)
    .reduce((total, level) => total + level.price * level.quantity, 0);
  return {
    midPrice,
    bidDepthUsdt,
    askDepthUsdt,
    minSideDepthUsdt: Math.min(bidDepthUsdt, askDepthUsdt),
    totalDepthUsdt: bidDepthUsdt + askDepthUsdt
  };
}

function normalizeDepthRow(row, observedAt, policy) {
  if (!row || typeof row !== 'object') throw new Error('depth row is invalid');
  const symbol = symbolOf(row.symbol ?? row.s);
  const asOf = sourceTime(row, observedAt, `${symbol} depth`);
  const metrics = depthQuoteWithinBps(row, policy);
  return { symbol, asOf, ...metrics };
}

function exclusion(symbol, reasons, extra = {}) {
  return { symbol, eligible: false, tier: null, reasons: [...new Set(reasons)], ...extra };
}

export function buildUniverseSnapshot({
  exchangeInfo,
  tickers,
  depths,
  observedAt = Date.now(),
  policy: suppliedPolicy = DEFAULT_UNIVERSE_POLICY
}) {
  const at = integer('observedAt', observedAt);
  const policy = {
    ...DEFAULT_UNIVERSE_POLICY,
    ...(suppliedPolicy ?? {}),
    allowedQuoteAssets: (suppliedPolicy?.allowedQuoteAssets ?? DEFAULT_UNIVERSE_POLICY.allowedQuoteAssets).map(upper),
    excludedBaseAssets: (suppliedPolicy?.excludedBaseAssets ?? DEFAULT_UNIVERSE_POLICY.excludedBaseAssets).map(upper)
  };
  if (!Array.isArray(exchangeInfo)) throw new Error('exchangeInfo must be an array');
  if (!Array.isArray(tickers)) throw new Error('tickers must be an array');
  if (!Array.isArray(depths)) throw new Error('depths must be an array');
  const tickerBySymbol = new Map(tickers.map(row => {
    const normalized = normalizeTickerRow(row, at);
    return [normalized.symbol, normalized];
  }));
  const depthBySymbol = new Map(depths.map(row => {
    const normalized = normalizeDepthRow(row, at, policy);
    return [normalized.symbol, normalized];
  }));
  const rows = [];
  for (const raw of exchangeInfo) {
    const info = normalizeExchangeInfoRow(raw, at);
    const reasons = [];
    if (info.contractType !== 'PERPETUAL') reasons.push('not_perpetual');
    if (!policy.allowedQuoteAssets.includes(info.quoteAsset)) reasons.push('unsupported_quote_asset');
    if (info.status !== 'TRADING') reasons.push('not_trading');
    if (excludedBaseAsset(info.baseAsset, policy)) reasons.push('excluded_base_asset');
    if (info.onboardDate > at - policy.minListingAgeMs) reasons.push('listing_age_under_30d');
    const ticker = tickerBySymbol.get(info.symbol);
    const depth = depthBySymbol.get(info.symbol);
    if (!ticker) reasons.push('missing_ticker');
    if (!depth) reasons.push('missing_depth');
    if (depth && at - depth.asOf > policy.maxDepthAgeMs) reasons.push('stale_depth');
    if (reasons.length) {
      rows.push(exclusion(info.symbol, reasons, { ...info }));
      continue;
    }
    const volume = ticker.quoteVolumeUsdt;
    const minDepth = depth.minSideDepthUsdt;
    let tier = null;
    if (volume >= policy.minTierAQuoteVolumeUsdt && minDepth >= policy.minTierADepthUsdt) tier = 'A';
    else if (volume >= policy.minTierBQuoteVolumeUsdt && minDepth >= policy.minTierBDepthUsdt) tier = 'B';
    if (!tier) {
      rows.push(exclusion(info.symbol, ['liquidity_below_tier_b'], {
        ...info,
        quoteVolumeUsdt: volume,
        minSideDepthUsdt: minDepth,
        depthAsOf: depth.asOf
      }));
      continue;
    }
    rows.push({
      ...info,
      symbol: info.symbol,
      eligible: true,
      tier,
      reasons: [],
      quoteVolumeUsdt: volume,
      minSideDepthUsdt: minDepth,
      bidDepthUsdt: depth.bidDepthUsdt,
      askDepthUsdt: depth.askDepthUsdt,
      depthAsOf: depth.asOf,
      tickerAsOf: ticker.asOf
    });
  }
  const eligible = rows
    .filter(row => row.eligible)
    .sort((left, right) => (left.tier === right.tier ? right.quoteVolumeUsdt - left.quoteVolumeUsdt : left.tier.localeCompare(right.tier)) || left.symbol.localeCompare(right.symbol));
  const capped = eligible.slice(0, policy.maxSymbols);
  const cappedSymbols = new Set(capped.map(row => row.symbol));
  for (const row of eligible.slice(policy.maxSymbols)) {
    rows.find(candidate => candidate.symbol === row.symbol).eligible = false;
    rows.find(candidate => candidate.symbol === row.symbol).tier = null;
    rows.find(candidate => candidate.symbol === row.symbol).reasons = ['universe_cap'];
  }
  const included = rows.filter(row => cappedSymbols.has(row.symbol)).sort((left, right) => left.symbol.localeCompare(right.symbol));
  const excluded = rows.filter(row => !cappedSymbols.has(row.symbol)).sort((left, right) => left.symbol.localeCompare(right.symbol));
  const payload = {
    observedAt: at,
    policy,
    symbols: included.map(row => row.symbol),
    included,
    excluded
  };
  const universeVersion = createHash('sha256').update(canonicalJson(payload)).digest('hex');
  return {
    schemaVersion: 1,
    universeVersion,
    observedAt: at,
    policy,
    symbols: included.map(row => row.symbol),
    included,
    excluded,
    counts: {
      exchangeInfo: exchangeInfo.length,
      eligibleBeforeCap: eligible.length,
      included: included.length,
      excluded: excluded.length,
      tierA: included.filter(row => row.tier === 'A').length,
      tierB: included.filter(row => row.tier === 'B').length
    },
    pointInTime: true,
    futureDataUsed: false
  };
}

export function eligibleSymbols(snapshot) {
  if (!snapshot?.pointInTime || snapshot.futureDataUsed) throw new Error('universe snapshot is not point-in-time safe');
  return [...new Set((snapshot.included ?? []).filter(row => row.eligible).map(row => symbolOf(row.symbol)))].sort();
}

export function summarizeUniverse(snapshot) {
  const symbols = eligibleSymbols(snapshot);
  return {
    universeVersion: snapshot.universeVersion,
    observedAt: snapshot.observedAt,
    symbols,
    counts: { ...snapshot.counts },
    tiers: Object.fromEntries(['A', 'B'].map(tier => [tier, symbols.filter(symbol => snapshot.included.find(row => row.symbol === symbol)?.tier === tier)])),
    pointInTime: true
  };
}
