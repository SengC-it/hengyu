import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseFundingArchive, parseKlineArchive } from '../src/research/archive.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW_ROOT = path.join(ROOT, 'data', 'raw', 'HY-EXP-0001');
const OUTPUT_ROOT = path.join(ROOT, 'artifacts', 'audits');
const DEVELOPMENT_START = Date.parse('2024-01-01T00:00:00.000Z');
const DEVELOPMENT_END = Date.parse('2025-07-01T00:00:00.000Z');
const FIVE_MINUTES = 5 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const FOUR_HOURS = 4 * HOUR;
const BPS = 10_000;
const CURRENT_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'];
const AVAILABLE_SYMBOLS = ['BNBUSDT', 'BTCUSDT', 'DOGEUSDT', 'ETHUSDT', 'LINKUSDT', 'LTCUSDT', 'SOLUSDT', 'XRPUSDT'];
const SOURCE_MONTH_START = '2023-12';
const SOURCE_MONTH_END_EXCLUSIVE = '2025-07';
const PROXY_TOTAL_COST_BPS = 18;
const FUNDING_STRESS_BPS = 1;

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function monthKey(time) {
  return new Date(time).toISOString().slice(0, 7);
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function sma(rows, index, lookback) {
  if (index + 1 < lookback) return null;
  return mean(rows.slice(index - lookback + 1, index + 1).map(row => row.close));
}

function trueRange(rows, index) {
  const row = rows[index];
  const previous = rows[index - 1];
  if (!row) return null;
  return Math.max(row.high - row.low, previous ? Math.abs(row.high - previous.close) : 0, previous ? Math.abs(row.low - previous.close) : 0);
}

function atr(rows, index, lookback) {
  if (index + 1 < lookback) return null;
  return mean(rows.slice(index - lookback + 1, index + 1).map((_, offset) => trueRange(rows, index - lookback + 1 + offset)));
}

function listInputFiles(symbol, kind) {
  const directory = path.join(RAW_ROOT, symbol, kind);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter(name => name.endsWith('.zip'))
    .filter(name => {
      const match = name.match(/(\d{4}-\d{2})(?:-\d{2})?\.zip$/);
      const month = match?.[1];
      return month && month >= SOURCE_MONTH_START && month < SOURCE_MONTH_END_EXCLUSIVE;
    })
    .sort()
    .map(name => path.join(directory, name));
}

function loadBars(symbol) {
  const rowsByTime = new Map();
  for (const file of listInputFiles(symbol, 'kline')) {
    for (const row of parseKlineArchive(fs.readFileSync(file), symbol, 'contract')) {
      if (!rowsByTime.has(row.openTime)) rowsByTime.set(row.openTime, row);
    }
  }
  return [...rowsByTime.values()].sort((left, right) => left.openTime - right.openTime);
}

function loadFunding(symbol) {
  const rowsByTime = new Map();
  for (const file of listInputFiles(symbol, 'funding')) {
    for (const row of parseFundingArchive(fs.readFileSync(file), symbol)) {
      if (!rowsByTime.has(row.eventTime)) rowsByTime.set(row.eventTime, row);
    }
  }
  return [...rowsByTime.values()].sort((left, right) => left.eventTime - right.eventTime);
}

function aggregate(rows, intervalMs) {
  const expectedRows = intervalMs / FIVE_MINUTES;
  const buckets = new Map();
  for (const row of rows) {
    const openTime = Math.floor(row.openTime / intervalMs) * intervalMs;
    const bucket = buckets.get(openTime) ?? [];
    bucket.push(row);
    buckets.set(openTime, bucket);
  }
  const output = [];
  for (const [openTime, bucket] of buckets) {
    bucket.sort((left, right) => left.openTime - right.openTime);
    if (bucket.length !== expectedRows) continue;
    if (bucket.some((row, index) => index > 0 && row.openTime !== bucket[index - 1].openTime + FIVE_MINUTES)) continue;
    const first = bucket[0];
    const last = bucket.at(-1);
    output.push({
      symbol: first.symbol,
      openTime,
      closeTime: last.closeTime,
      open: first.open,
      high: Math.max(...bucket.map(row => row.high)),
      low: Math.min(...bucket.map(row => row.low)),
      close: last.close,
      volume: bucket.reduce((sum, row) => sum + row.volume, 0),
      quoteVolume: bucket.reduce((sum, row) => sum + row.quoteVolume, 0),
      trades: bucket.reduce((sum, row) => sum + row.trades, 0)
    });
  }
  return output.sort((left, right) => left.openTime - right.openTime);
}

function commonTimes(seriesBySymbol, symbols) {
  const sets = symbols.map(symbol => new Set(seriesBySymbol[symbol].map(row => row.openTime)));
  return [...sets[0]].filter(time => sets.every(set => set.has(time))).sort((left, right) => left - right);
}

function regimeAt({ barsBySymbol, indexesBySymbol, time, symbols, fastBars = 60, slowBars = 180, breadthFraction = 0.5 }) {
  const btcIndex = indexesBySymbol.BTCUSDT?.get(time);
  const btc = barsBySymbol.BTCUSDT;
  const fast = btcIndex == null ? null : sma(btc, btcIndex, fastBars);
  const slow = btcIndex == null ? null : sma(btc, btcIndex, slowBars);
  if (btcIndex == null || fast == null || slow == null || symbols.length === 0) {
    return { regime: 'INSUFFICIENT_HISTORY', fast, slow, breadthAbove: 0, breadthBelow: 0, completedCloseTime: null, breadthBySymbol: [] };
  }
  const snapshots = symbols.flatMap(symbol => {
    const rows = barsBySymbol[symbol];
    const index = indexesBySymbol[symbol]?.get(time);
    if (!rows || index == null) return [];
    const value = sma(rows, index, slowBars);
    if (value == null) return [];
    return [{ symbol, close: rows[index].close, slowSma: value, aboveSlow: rows[index].close > value, belowSlow: rows[index].close < value }];
  });
  if (snapshots.length !== symbols.length) {
    return { regime: 'INSUFFICIENT_HISTORY', fast, slow, breadthAbove: 0, breadthBelow: 0, completedCloseTime: null, breadthBySymbol: snapshots };
  }
  const breadthAbove = snapshots.filter(row => row.aboveSlow).length;
  const breadthBelow = snapshots.filter(row => row.belowSlow).length;
  const requiredBreadth = Math.ceil(symbols.length * breadthFraction);
  const bull = fast > slow && btc[btcIndex].close > slow && breadthAbove >= requiredBreadth;
  const bear = fast < slow && btc[btcIndex].close < slow && breadthBelow >= requiredBreadth;
  return {
    regime: bull ? 'BULL' : bear ? 'BEAR' : 'SIDEWAYS',
    fast,
    slow,
    breadthAbove,
    breadthBelow,
    requiredBreadth,
    completedCloseTime: btc[btcIndex].closeTime,
    breadthBySymbol: snapshots
  };
}

function fixedSixDirectionalRegime({ barsBySymbol, index, regime }) {
  const symbols = CURRENT_SYMBOLS;
  const btc = barsBySymbol.BTCUSDT;
  const fast = sma(btc, index, 60);
  const slow = sma(btc, index, 180);
  if (fast == null || slow == null) return { pass: false, trendPass: false, breadthPass: false, fast, slow, breadth: 0, regime };
  const bullish = regime === 'BULL';
  const breadth = symbols.filter(symbol => {
    const rows = barsBySymbol[symbol];
    const value = sma(rows, index, 180);
    return bullish ? rows[index].close > value : rows[index].close < value;
  }).length;
  const trendPass = bullish
    ? fast > slow && btc[index].close > slow
    : fast < slow && btc[index].close < slow;
  return { pass: trendPass && breadth >= 4, trendPass, breadthPass: breadth >= 4, fast, slow, breadth, regime };
}

function currentH12Regime({ barsBySymbol, index }) {
  return fixedSixDirectionalRegime({ barsBySymbol, index, regime: 'BEAR' });
}

function rollingQuoteVolume(rows, index, lookback = 6) {
  if (index < lookback) return null;
  return rows.slice(index - lookback, index).reduce((sum, row) => sum + row.quoteVolume, 0);
}

function buildDynamicUniverse({ barsBySymbol, indexesBySymbol, time, symbols = AVAILABLE_SYMBOLS }) {
  const btcIndex = indexesBySymbol.BTCUSDT?.get(time);
  const observedAt = btcIndex == null ? null : barsBySymbol.BTCUSDT[btcIndex].closeTime;
  const rows = symbols
    .map(symbol => {
      const series = barsBySymbol[symbol];
      const index = indexesBySymbol[symbol]?.get(time);
      const listingProxy = series?.[0]?.openTime ?? null;
      const quoteVolume = index == null ? null : rollingQuoteVolume(series, index);
      const listingAgeMs = listingProxy == null || observedAt == null ? null : observedAt - listingProxy;
      return {
        symbol,
        listingAgeMs,
        quoteVolumeUsdt: quoteVolume,
        depthSource: 'OHLCV_PROXY_NOT_ORDERBOOK',
        eligible: listingAgeMs != null && listingAgeMs >= 30 * 24 * HOUR && quoteVolume != null && quoteVolume >= 1_000_000
      };
    })
    .filter(row => row.eligible)
    .sort((left, right) => right.quoteVolumeUsdt - left.quoteVolumeUsdt || left.symbol.localeCompare(right.symbol))
    .slice(0, 20);
  return {
    snapshotTime: time,
    completedCloseTime: observedAt,
    symbols: rows.map(row => row.symbol),
    rows,
    maxSymbols: 20,
    observedSymbolCoverage: symbols.length,
    top20CapacityNotDemonstrated: symbols.length < 20
  };
}

function buildPITSnapshots({ barsBySymbol, indexesBySymbol, times4h }) {
  return new Map(times4h.map(time => {
    const universe = buildDynamicUniverse({ barsBySymbol, indexesBySymbol, time });
    const regime = regimeAt({ barsBySymbol, indexesBySymbol, time, symbols: universe.symbols });
    return [time, { ...universe, regime }];
  }));
}

function selectCompletedFourHourSnapshot(snapshots, decisionTime) {
  const values = snapshots instanceof Map ? [...snapshots.values()] : snapshots;
  return values
    .filter(snapshot => snapshot.completedCloseTime != null && snapshot.completedCloseTime <= decisionTime)
    .sort((left, right) => right.completedCloseTime - left.completedCloseTime)[0] ?? null;
}

function candidateRow({ family, symbol, side, regime, time, index, series, horizonBars, fundingBySymbol }) {
  const entryIndex = index + 1;
  const exitIndex = entryIndex + horizonBars - 1;
  const entry = series[entryIndex];
  const exit = series[exitIndex];
  const hasForwardOutcome = Boolean(entry && exit);
  const gross = hasForwardOutcome
    ? side === 'BUY'
      ? (exit.close / entry.open - 1) * BPS
      : (1 - exit.close / entry.open) * BPS
    : null;
  const funding = hasForwardOutcome
    ? fundingBySymbol[symbol]
      .filter(row => row.eventTime > entry.openTime && row.eventTime <= exit.closeTime)
      .reduce((sum, row) => sum + (side === 'BUY' ? -1 : 1) * row.fundingRate * BPS, 0)
    : null;
  return {
    family,
    symbol,
    side,
    regime,
    signalTime: time,
    month: monthKey(time),
    entryTime: entry?.openTime ?? null,
    exitTime: exit?.closeTime ?? null,
    hasForwardOutcome,
    grossForwardReturnBps: gross,
    fundingBps: funding,
    proxyNetReturnBps: hasForwardOutcome ? gross + funding - PROXY_TOTAL_COST_BPS : null
  };
}

function summarizeRows(rows) {
  const outcomeRows = rows.filter(row => row.hasForwardOutcome && Number.isFinite(row.proxyNetReturnBps));
  const net = outcomeRows.map(row => row.proxyNetReturnBps).sort((left, right) => left - right);
  const positive = net.filter(value => value > 0);
  const negative = net.filter(value => value < 0);
  const positiveSum = positive.reduce((sum, value) => sum + value, 0);
  const negativeSum = negative.reduce((sum, value) => sum + value, 0);
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const value of outcomeRows.slice().sort((left, right) => left.exitTime - right.exitTime).map(row => row.proxyNetReturnBps)) {
    cumulative += value;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.min(maxDrawdown, cumulative - peak);
  }
  const tailCount = net.length ? Math.max(1, Math.ceil(net.length * 0.05)) : 0;
  const topFive = positive.slice().sort((left, right) => right - left).slice(0, 5).reduce((sum, value) => sum + value, 0);
  const byMonth = {};
  for (const row of outcomeRows) byMonth[row.month] = (byMonth[row.month] ?? 0) + row.proxyNetReturnBps;
  return {
    observationCount: rows.length,
    outcomeCount: outcomeRows.length,
    outcomeCoverage: rows.length ? outcomeRows.length / rows.length : null,
    meanNetReturnBps: mean(net),
    cumulativeEqualNotionalNetReturnBps: net.reduce((sum, value) => sum + value, 0),
    netProfitFactor: negativeSum < 0 ? positiveSum / Math.abs(negativeSum) : positiveSum > 0 ? Infinity : null,
    positiveMonths: Object.values(byMonth).filter(value => value > 0).length,
    observedMonths: Object.keys(byMonth).length,
    positiveMonthShare: Object.keys(byMonth).length ? Object.values(byMonth).filter(value => value > 0).length / Object.keys(byMonth).length : null,
    maxCumulativeDrawdownBps: maxDrawdown,
    cvar95Bps: tailCount ? mean(net.slice(0, tailCount)) : null,
    best5Concentration: positiveSum > 0 ? topFive / positiveSum : null,
    symbolBreadth: new Set(rows.map(row => row.symbol)).size,
    regimeBreadth: new Set(rows.map(row => row.regime)).size,
    byMonth,
    byFamily: Object.fromEntries([...new Set(rows.map(row => row.family))].sort().map(family => [family, rows.filter(row => row.family === family).length]))
  };
}

function groupedCounts(rows) {
  const count = field => Object.fromEntries([...new Set(rows.map(row => row[field]))].sort().map(value => [value, rows.filter(row => row[field] === value).length]));
  return {
    total: rows.length,
    bySymbol: count('symbol'),
    byMonth: count('month'),
    byRegime: count('regime'),
    bySide: count('side'),
    byFamily: count('family')
  };
}

function candidateSlotKey(row) {
  return `${row.symbol}|${row.signalTime}|${row.side}`;
}

function familyOverlapStats(rows) {
  const bySlot = new Map();
  for (const row of rows) {
    const families = bySlot.get(candidateSlotKey(row)) ?? new Set();
    families.add(row.family);
    bySlot.set(candidateSlotKey(row), families);
  }
  const sizes = [...bySlot.values()].map(families => families.size);
  const pairwise = (left, right) => [...bySlot.values()].filter(families => families.has(left) && families.has(right)).length;
  return {
    uniqueCandidateSlots: bySlot.size,
    familyOverlapSlots: sizes.filter(size => size > 1).length,
    oneFamily: sizes.filter(size => size === 1).length,
    twoFamilies: sizes.filter(size => size === 2).length,
    threeFamilies: sizes.filter(size => size >= 3).length,
    pairwise: {
      TREND_BREAKOUT_PLUS_PULLBACK: pairwise('TREND_BREAKOUT', 'PULLBACK_CONTINUATION'),
      TREND_BREAKOUT_PLUS_VOL_EXPANSION: pairwise('TREND_BREAKOUT', 'VOLATILITY_EXPANSION'),
      PULLBACK_PLUS_VOL_EXPANSION: pairwise('PULLBACK_CONTINUATION', 'VOLATILITY_EXPANSION')
    }
  };
}

function buildFourHourBreakoutRows({ barsBySymbol, fundingBySymbol, times, indexesBySymbol, snapshots, family = 'PROPOSED_4H_BREAKOUT' }) {
  const rows = [];
  for (const time of times) {
    const snapshot = snapshots.get(time);
    if (!snapshot || !['BULL', 'BEAR'].includes(snapshot.regime.regime)) continue;
    for (const symbol of snapshot.symbols) {
      const series = barsBySymbol[symbol];
      const index = indexesBySymbol[symbol]?.get(time);
      if (!series || index == null || index < 120) continue;
      const prior = series.slice(index - 120, index);
      const side = snapshot.regime.regime === 'BULL' ? 'BUY' : 'SELL';
      const pass = side === 'BUY'
        ? series[index].close > Math.max(...prior.map(row => row.high))
        : series[index].close < Math.min(...prior.map(row => row.low));
      if (!pass) continue;
      rows.push(candidateRow({ family, symbol, side, regime: snapshot.regime.regime, time, index, series, horizonBars: 6, fundingBySymbol }));
    }
  }
  return rows;
}

function buildProposedCandidates({ barsBySymbol, fundingBySymbol, times, indexesBySymbol, snapshots }) {
  const rows = [];
  let regimeEligibleSymbolSlots = 0;
  for (const time of times) {
    const snapshot = selectCompletedFourHourSnapshot(snapshots, barsBySymbol.BTCUSDT[indexesBySymbol.BTCUSDT.get(time)]?.closeTime ?? time);
    if (!snapshot || !['BULL', 'BEAR'].includes(snapshot.regime.regime)) continue;
    for (const symbol of snapshot.symbols) {
      const series = barsBySymbol[symbol];
      const index = indexesBySymbol[symbol].get(time);
      if (index == null || index < 120) continue;
      regimeEligibleSymbolSlots++;
      const side = snapshot.regime.regime === 'BULL' ? 'BUY' : 'SELL';
      const prior = series.slice(index - 120, index);
      const priorHigh = Math.max(...prior.map(row => row.high));
      const priorLow = Math.min(...prior.map(row => row.low));
      const fast = sma(series, index, 20);
      const slow = sma(series, index, 60);
      const currentAtr = atr(series, index, 20);
      const previousClose = series[index - 1]?.close;
      const pullback = side === 'BUY'
        ? fast != null && slow != null && series[index].close > slow && series[index].low <= fast && series[index].close > fast
        : fast != null && slow != null && series[index].close < slow && series[index].high >= fast && series[index].close < fast;
      const expansion = currentAtr != null && currentAtr > 0 && (series[index].high - series[index].low) / currentAtr >= 2
        && previousClose != null && (side === 'BUY' ? series[index].close > previousClose : series[index].close < previousClose);
      const breakout = side === 'BUY' ? series[index].close > priorHigh : series[index].close < priorLow;
      for (const [family, pass] of [['TREND_BREAKOUT', breakout], ['PULLBACK_CONTINUATION', pullback], ['VOLATILITY_EXPANSION', expansion]]) {
        if (!pass) continue;
        rows.push(candidateRow({ family, symbol, side, regime: snapshot.regime.regime, time, index, series, horizonBars: 6, fundingBySymbol }));
      }
    }
  }
  return { rows, regimeEligibleSymbolSlots };
}

function buildFixedSixBreakoutRows({ barsBySymbol, fundingBySymbol, bars4h, indexes4h, times4h, regime }) {
  const rows = [];
  for (const time of times4h) {
    const index = indexes4h.BTCUSDT.get(time);
    if (index == null || index < 180) continue;
    const regimeState = fixedSixDirectionalRegime({ barsBySymbol: bars4h, index, regime });
    if (!regimeState.pass) continue;
    const side = regime === 'BULL' ? 'BUY' : 'SELL';
    for (const symbol of CURRENT_SYMBOLS) {
      const symbolIndex = indexes4h[symbol].get(time);
      if (symbolIndex == null || symbolIndex < 120) continue;
      const series = bars4h[symbol];
      const prior = series.slice(symbolIndex - 120, symbolIndex);
      const pass = side === 'BUY'
        ? series[symbolIndex].close > Math.max(...prior.map(row => row.high))
        : series[symbolIndex].close < Math.min(...prior.map(row => row.low));
      if (!pass) continue;
      rows.push(candidateRow({ family: regime === 'BEAR' ? 'H12_4H_DONCHIAN_SELL' : 'FIXED6_4H_DONCHIAN_BUY', symbol, side, regime, time, index: symbolIndex, series, horizonBars: 6, fundingBySymbol }));
    }
  }
  return rows;
}

function summarizeCandidateSet(rows) {
  const overlap = familyOverlapStats(rows);
  return {
    candidateFamilyObservations: rows.length,
    ...overlap,
    by: groupedCounts(rows)
  };
}

function buildAudit() {
  const bars5m = Object.fromEntries(AVAILABLE_SYMBOLS.map(symbol => [symbol, loadBars(symbol)]));
  const fundingBySymbol = Object.fromEntries(AVAILABLE_SYMBOLS.map(symbol => [symbol, loadFunding(symbol)]));
  const bars4h = Object.fromEntries(AVAILABLE_SYMBOLS.map(symbol => [symbol, aggregate(bars5m[symbol], FOUR_HOURS)]));
  const bars1h = Object.fromEntries(AVAILABLE_SYMBOLS.map(symbol => [symbol, aggregate(bars5m[symbol], HOUR)]));
  const times4h = commonTimes(bars4h, AVAILABLE_SYMBOLS).filter(time => time >= DEVELOPMENT_START && time < DEVELOPMENT_END);
  const times1h = commonTimes(bars1h, AVAILABLE_SYMBOLS).filter(time => time >= DEVELOPMENT_START && time < DEVELOPMENT_END);
  const indexes4h = Object.fromEntries(AVAILABLE_SYMBOLS.map(symbol => [symbol, new Map(bars4h[symbol].map((row, index) => [row.openTime, index]))]));
  const indexes1h = Object.fromEntries(AVAILABLE_SYMBOLS.map(symbol => [symbol, new Map(bars1h[symbol].map((row, index) => [row.openTime, index]))]));
  const dynamicSnapshots = buildPITSnapshots({ barsBySymbol: bars4h, indexesBySymbol: indexes4h, times4h });

  let currentScanCount = 0;
  let currentRegimePassScans = 0;
  let currentTrendPassScans = 0;
  let currentBreadthRejectedScans = 0;
  let currentInsufficientHistoryScans = 0;
  for (const time of times4h) {
    const index = indexes4h.BTCUSDT.get(time);
    if (index == null || index < 180) { currentInsufficientHistoryScans++; continue; }
    currentScanCount++;
    const currentRegime = currentH12Regime({ barsBySymbol: bars4h, index });
    if (currentRegime.trendPass) currentTrendPassScans++;
    if (currentRegime.trendPass && !currentRegime.breadthPass) currentBreadthRejectedScans++;
    if (currentRegime.pass) currentRegimePassScans++;
  }

  const currentRows = buildFixedSixBreakoutRows({ barsBySymbol: bars4h, fundingBySymbol, bars4h, indexes4h, times4h, regime: 'BEAR' });
  const fixedSixBullRows = buildFixedSixBreakoutRows({ barsBySymbol: bars4h, fundingBySymbol, bars4h, indexes4h, times4h, regime: 'BULL' });
  const fixedSixBidirectionalRows = [...currentRows, ...fixedSixBullRows];
  const observedUniverse4hRows = buildFourHourBreakoutRows({
    barsBySymbol: bars4h,
    fundingBySymbol,
    times: times4h,
    indexesBySymbol: indexes4h,
    snapshots: dynamicSnapshots
  });
  const dynamicAdditionalCandidates = observedUniverse4hRows.filter(row => !CURRENT_SYMBOLS.includes(row.symbol)).length;

  const proposedTimes1h = times1h.filter(time => time >= DEVELOPMENT_START + 180 * FOUR_HOURS);
  const proposedResult = buildProposedCandidates({
    barsBySymbol: bars1h,
    fundingBySymbol,
    times: proposedTimes1h,
    indexesBySymbol: indexes1h,
    snapshots: dynamicSnapshots
  });
  const proposedRows = proposedResult.rows;
  const trendRows = proposedRows.filter(row => row.family === 'TREND_BREAKOUT');
  const allFamilyStats = summarizeCandidateSet(proposedRows);
  const trendStats = summarizeCandidateSet(trendRows);
  const directionStats = summarizeCandidateSet(fixedSixBidirectionalRows);
  const dynamic4hStats = summarizeCandidateSet(observedUniverse4hRows);
  const currentStats = summarizeCandidateSet(currentRows);
  const observedUniverseIncrementalCount = observedUniverse4hRows.length - fixedSixBidirectionalRows.length;

  const currentFunnel = {
    unit: 'completed 4h scan-symbol slot; historical audit uses HY-EXP-0019 development window only',
    barsScanned: currentScanCount * CURRENT_SYMBOLS.length,
    scanCount: currentScanCount,
    insufficientHistoryScans: currentInsufficientHistoryScans,
    regimeTrendEligibleScans: currentTrendPassScans,
    regimePassScans: currentRegimePassScans,
    breadthRejectedScans: currentBreadthRejectedScans,
    breakoutCandidates: currentRows.length,
    proxyExecutableCandidates: currentRows.length,
    strictHistoricalExecutableCandidates: 0,
    edgeEligible: 0,
    netEdgePass: 0,
    portfolioRiskPass: 0,
    gmailAdvisories: 0,
    fixedSixSymbolCandidates: currentRows.length,
    sellOnlyBullBuyCandidatesExcluded: fixedSixBullRows.length,
    fourHourOnlyCandidateCount: currentRows.length,
    schedulerDelay: { status: 'NOT_OBSERVABLE_FROM_ARCHIVED_DATA', thresholdMs: 900000 },
    missingMarketData: { status: 'HISTORICAL_L2_UNAVAILABLE', strictExecutableCount: 0 },
    edgeGate: { status: 'STRUCTURALLY_UNVERIFIED_IN_LIVE_H12', rejection: 'EDGE_UNVERIFIED', forceNoTrade: true },
    riskGate: { status: 'NOT_REACHED_FOR_LIVE_H12_UNVERIFIED_EDGE', count: 0 },
    directionOnlyComparison: {
      bearSellCandidates: currentRows.length,
      bullBuyCandidates: fixedSixBullRows.length,
      bidirectionalTotal: fixedSixBidirectionalRows.length,
      sellOnlyImpact: fixedSixBullRows.length,
      universe: 'fixed six',
      timeframe: '4h',
      breakoutSemantics: 'same Donchian-120 semantics'
    },
    by: groupedCounts(currentRows)
  };
  const proposedFunnel = {
    unit: 'completed 1h candidate-family observation; regime and universe are the latest completed 4h PIT snapshots',
    barsScanned: proposedTimes1h.length * AVAILABLE_SYMBOLS.length,
    scanCount: proposedTimes1h.length,
    dynamicUniverseMaxSymbols: 20,
    observedUniverseSymbols: AVAILABLE_SYMBOLS.length,
    universeApplication: {
      applied: true,
      snapshotCount: dynamicSnapshots.size,
      snapshotsWithEligibleSymbols: [...dynamicSnapshots.values()].filter(snapshot => snapshot.symbols.length > 0).length,
      observedUniverseCoverage: AVAILABLE_SYMBOLS.length,
      top20CapacityNotDemonstrated: AVAILABLE_SYMBOLS.length < 20,
      membershipFrozenUntilNextCompleted4hBoundary: true,
      depthSource: 'OHLCV_PROXY_NOT_ORDERBOOK'
    },
    regimeEligibleSymbolSlots: proposedResult.regimeEligibleSymbolSlots,
    candidateFamilyObservations: proposedRows.length,
    uniqueCandidateSlots: allFamilyStats.uniqueCandidateSlots,
    familyOverlapSlots: allFamilyStats.familyOverlapSlots,
    oneFamily: allFamilyStats.oneFamily,
    twoFamilies: allFamilyStats.twoFamilies,
    threeFamilies: allFamilyStats.threeFamilies,
    pairwiseFamilyOverlaps: allFamilyStats.pairwise,
    proxyExecutableCandidates: proposedRows.length,
    strictHistoricalExecutableCandidates: 0,
    edgeEligible: 0,
    netEdgePass: 0,
    portfolioRiskPass: 0,
    gmailAdvisories: 0,
    by: groupedCounts(proposedRows)
  };

  const controlledComparisons = {
    baseline: {
      label: 'BASELINE',
      universe: 'fixed six',
      directions: ['SELL'],
      timeframe: '4h',
      family: 'H12_4H_DONCHIAN_SELL',
      candidateCount: currentRows.length,
      uniqueCandidateSlots: currentRows.length,
      incrementalCandidateCount: null
    },
    bidirectional: {
      label: '+ BIDIRECTIONAL',
      universe: 'fixed six',
      directions: ['BUY', 'SELL'],
      timeframe: '4h',
      family: 'same 4h Donchian semantics',
      bearSellCandidates: currentRows.length,
      bullBuyCandidates: fixedSixBullRows.length,
      bidirectionalTotal: fixedSixBidirectionalRows.length,
      incrementalCandidateCount: fixedSixBullRows.length,
      uniqueCandidateSlots: directionStats.uniqueCandidateSlots
    },
    observedUniverse: {
      label: '+ OBSERVED_UNIVERSE',
      universe: 'causal eligible observed symbols, frozen per completed 4h snapshot',
      directions: ['BUY', 'SELL'],
      timeframe: '4h',
      family: 'PROPOSED_4H_BREAKOUT',
      candidateCount: observedUniverse4hRows.length,
      uniqueCandidateSlots: dynamic4hStats.uniqueCandidateSlots,
      incrementalCandidateCount: observedUniverseIncrementalCount,
      observedUniverseCoverage: AVAILABLE_SYMBOLS.length,
      top20CapacityNotDemonstrated: AVAILABLE_SYMBOLS.length < 20
    },
    oneHourBreakout: {
      label: '+ 1H TIMEFRAME',
      universe: 'same causal observed-universe snapshots',
      directions: ['BUY', 'SELL'],
      timeframe: '1h',
      family: 'TREND_BREAKOUT only',
      candidateFamilyObservations: trendRows.length,
      uniqueCandidateSlots: trendStats.uniqueCandidateSlots,
      incrementalCandidateCount: trendStats.uniqueCandidateSlots - dynamic4hStats.uniqueCandidateSlots
    },
    additionalFamilies: {
      label: '+ ADDITIONAL FAMILIES',
      universe: 'same causal observed-universe snapshots',
      directions: ['BUY', 'SELL'],
      timeframe: '1h',
      family: 'TREND_BREAKOUT + PULLBACK_CONTINUATION + VOLATILITY_EXPANSION',
      candidateFamilyObservations: proposedRows.length,
      uniqueCandidateSlots: allFamilyStats.uniqueCandidateSlots,
      incrementalFamilyObservations: proposedRows.length - trendRows.length,
      incrementalUniqueCandidateSlots: allFamilyStats.uniqueCandidateSlots - trendStats.uniqueCandidateSlots
    },
    note: 'Order-dependent counts only; they are not causal profitability claims and are not independent trades.'
  };

  const proxyRows = [...currentRows, ...fixedSixBullRows, ...observedUniverse4hRows, ...proposedRows];
  const familyRows = Object.fromEntries([...new Set(proxyRows.map(row => row.family))].sort().map(family => [family, proxyRows.filter(row => row.family === family)]));
  const proxyComparison = Object.fromEntries(Object.entries(familyRows).map(([family, rows]) => [family, {
    evidenceClass: 'DESCRIPTIVE_ONLY_NOT_PNL_NOT_OOS_NOT_PROMOTION_ELIGIBLE',
    depthSource: 'OHLCV_PROXY_NOT_ORDERBOOK',
    overlapWarning: 'candidate-family observations may share symbol/time/side slots and are not portfolio returns',
    costModel: { roundTripCostBps: PROXY_TOTAL_COST_BPS, fundingIncluded: true, fundingStressBufferBps: FUNDING_STRESS_BPS },
    summary: summarizeRows(rows)
  }]));
  const pareto = Object.entries({ H12_CURRENT: currentRows, FIXED6_BULL_BUY: fixedSixBullRows, OBSERVED_UNIVERSE_4H: observedUniverse4hRows, ...familyRows }).map(([name, rows]) => {
    const summary = summarizeRows(rows);
    return {
      name,
      candidateFamilyObservations: rows.length,
      uniqueCandidateSlots: familyOverlapStats(rows).uniqueCandidateSlots,
      meanNetReturnBps: mean(rows.map(row => row.proxyNetReturnBps)),
      netProfitFactor: summary.netProfitFactor,
      maxCumulativeDrawdownBps: summary.maxCumulativeDrawdownBps,
      positiveMonths: summary.positiveMonths,
      symbolBreadth: new Set(rows.map(row => row.symbol)).size,
      regimeBreadth: new Set(rows.map(row => row.regime)).size,
      edgeEligible: 0,
      promotionEligible: false,
      evidenceClass: 'DESCRIPTIVE_ONLY_NOT_PNL_NOT_OOS'
    };
  });
  const sourceManifest = path.join(ROOT, 'artifacts', 'HY-EXP-0019', 'data-manifest.json');
  const audit = {
    schemaVersion: 2,
    experimentId: 'HY-EXP-0024',
    status: 'AUDIT_ONLY_NOT_PREREGISTERED',
    evidenceClass: 'D0_DESCRIPTIVE_DEVELOPMENT_INFORMATION',
    generatedAt: new Date().toISOString(),
    authorization: 'PAPER_ONLY',
    liveOrdersEnabled: false,
    pnlComputed: false,
    promotionEligible: false,
    auditWindow: {
      start: new Date(DEVELOPMENT_START).toISOString(),
      endExclusive: new Date(DEVELOPMENT_END).toISOString(),
      classification: 'HY-EXP-0019_DEVELOPMENT_INFORMATION_ONLY',
      prohibitedWindowReuse: '2025-07-01T00:00:00.000Z to 2026-07-01T00:00:00.000Z is not used as independent OOS'
    },
    sources: {
      sourceExperiment: 'HY-EXP-0001 locked archive as referenced by HY-EXP-0019',
      sourceManifestSha256: sha256(sourceManifest),
      symbolsLoaded: AVAILABLE_SYMBOLS,
      barSource: 'Binance official contract 5m archives aggregated to causal 1h/4h bars',
      fundingSource: 'Binance official funding archives',
      depthSource: 'OHLCV_PROXY_NOT_ORDERBOOK'
    },
    liveH12StructuralAudit: {
      expectedPriceEdgeBps: null,
      edgeSource: 'UNVERIFIED',
      sampleSize: 0,
      available: false,
      forceUnverifiedEdgeNoTrade: true,
      otherwiseValidCandidateCanBecomeGmailAdvisory: false,
      proof: 'live-h12 evaluates the shared gate with a null edge and then forceUnverifiedEdgeNoTrade; no gate bypass is introduced'
    },
    currentH12Funnel: currentFunnel,
    proposedExpansionFunnel: proposedFunnel,
    controlledComparisons,
    historicalCandidateCounts: {
      currentH12: currentRows.length,
      bearSellCandidates: currentRows.length,
      bullBuyCandidates: fixedSixBullRows.length,
      fixedSixBidirectional4h: fixedSixBidirectionalRows.length,
      observedUniverseBidirectional4h: observedUniverse4hRows.length,
      observedUniverse1hTrendBreakoutFamilyObservations: trendRows.length,
      observedUniverse1hTrendBreakoutUniqueCandidateSlots: trendStats.uniqueCandidateSlots,
      observedUniverse1hAllFamilyObservations: proposedRows.length,
      observedUniverse1hAllFamilyUniqueCandidateSlots: allFamilyStats.uniqueCandidateSlots,
      observedUniverse1hFamilyOverlapSlots: allFamilyStats.familyOverlapSlots,
      observedUniverse1hFamilyOverlap: allFamilyStats,
      fixedSixSymbolCandidates: currentRows.length,
      dynamicAdditionalSymbolBreakouts: dynamicAdditionalCandidates,
      note: 'Counts are causal candidate observations in the development-information window, not approved signals or trades; family observations are not independent opportunities.'
    },
    scarcityCauses: [
      { cause: 'EDGE_UNVERIFIED', impact: 'structural_zero_live_advisories', evidence: 'live H12 edge is null/UNVERIFIED/sampleSize 0 and forceUnverifiedEdgeNoTrade remains active' },
      { cause: 'SELL_ONLY', impact: fixedSixBullRows.length, evidence: 'fixed-six, same 4h Donchian semantics, BULL/BUY candidates only; no universe or timeframe expansion mixed into this count' },
      { cause: 'FIXED_SIX_SYMBOL_UNIVERSE', impact: observedUniverseIncrementalCount, evidence: 'controlled fixed-six bidirectional versus causal eligible observed-universe 4h comparison; only eight symbols are available and top-20 capacity is not demonstrated' },
      { cause: '4H_ONLY_TIMING', impact: controlledComparisons.oneHourBreakout.incrementalCandidateCount, evidence: 'controlled 1h TREND_BREAKOUT-only comparison; order-dependent candidate count, no profitability claim' },
      { cause: 'ADDITIONAL_FAMILY_OVERLAP', impact: allFamilyStats.familyOverlapSlots, evidence: 'family observations are deduplicated into unique symbol/time/side slots before signal-count interpretation' },
      { cause: 'BEAR_BREADTH_4_OF_6', impact: currentBreadthRejectedScans, evidence: 'trend-qualified scans rejected by current fixed-six breadth threshold' },
      { cause: 'SCHEDULER_DELAY', impact: null, evidence: 'not measurable from archived data; live diagnostic telemetry is required' },
      { cause: 'HISTORICAL_EXECUTABLE_DEPTH', impact: currentRows.length + proposedRows.length, evidence: 'no historical L2; strict executable candidate count is zero, proxy count is reported separately' },
      { cause: 'NET_EDGE_AND_PORTFOLIO_GATES', impact: 'not_reached_for_unverified_live_h12', evidence: 'edge eligibility is zero before those gates' }
    ],
    proxyProfitabilityComparison: proxyComparison,
    paretoTable: pareto,
    noPromotionDecision: {
      result: 'NOT_EVALUATED_FOR_PROMOTION',
      reason: 'No validated candidate-level edge, no historical L2, and no independent OOS. Descriptive forward outcomes cannot promote HY-EXP-0024.',
      betterNetProfitabilityAndUsableSignalCount: false,
      proxyProfitabilityIsNotPortfolioPerformance: true
    },
    dataLimitations: [
      'Historical order-book depth is unavailable; every executable and cost result here is an OHLCV proxy.',
      'Only eight symbols are present in the locked source; 20-30 symbol dynamic-universe coverage is not demonstrated.',
      'The dynamic observed universe is applied at each completed 4h snapshot using prior-six quoteVolume and a listing-age proxy; it is not promotion-grade PIT exchangeInfo.',
      '1h bars are aggregated from 5m archives, not native prospective 1h records.',
      'Historical PIT exchangeInfo is not re-created; listing age and contract filters are not promotion-grade.',
      'Scheduler delay, live market missingness and Gmail delivery cannot be inferred from the archived dataset.',
      'Proxy forward outcomes are candidate-level descriptive information, not a new result.json/trades.jsonl/PnL artifact.',
      'Overlapping candidate-family observations must not be interpreted as portfolio returns or portfolio drawdown.'
    ]
  };
  return { audit, proposedRows, proxyComparison };
}

function buildModelDesign() {
  return {
    schemaVersion: 1,
    experimentId: 'HY-EXP-0024',
    status: 'DESIGN_ONLY_PENDING_PREREGISTRATION',
    authorization: 'PAPER_ONLY',
    liveOrdersEnabled: false,
    developmentAllowed: false,
    pnlComputed: false,
    promotionEligible: false,
    promotion: 'FORBIDDEN_UNTIL_SEPARATE_PREREGISTRATION_AND_OOS',
    objective: 'Increase usable high-quality signal count while preserving net expectancy after conservative costs; trade count alone is not an objective.',
    baseline: 'Current H12 remains HY-EXP-0018 SELL_ONLY 4h and is not modified.',
    candidateEngine: ['Candidate', 'Edge Model', 'Net Edge Gate', 'Portfolio Risk Gate', 'Advisory'],
    universe: {
      maxSymbols: 20,
      sensitivityOnlyMaxSymbols: [20, 30],
      allowedQuoteAssets: ['USDT', 'USDC'],
      stableBaseExclusion: true,
      minimumListingAgeDays: 30,
      liquidityRule: 'previous six completed 4h quoteVolume sum; deterministic descending rank; missing data excludes symbol',
      depthRule: 'historical depth unavailable means OHLCV depth proxy is research-only and cannot promote',
      pointInTimeRule: 'only metadata and quote volume known at decisionTime may affect membership'
    },
    regime: {
      timeframe: '4h',
      fastSmaBars: 60,
      slowSmaBars: 180,
      breadthFraction: 0.5,
      bull: 'BTC fast SMA > slow SMA AND BTC close > slow SMA AND at least ceil(50% of eligible universe) closes above own slow SMA',
      bear: 'BTC fast SMA < slow SMA AND BTC close < slow SMA AND at least ceil(50% of eligible universe) closes below own slow SMA',
      sideways: 'otherwise; NO_TRADE'
    },
    entry: {
      timeframe: '1h',
      completedBarsOnly: true,
      families: {
        TREND_BREAKOUT: 'close beyond prior 120 completed 1h high/low; direction must match 4h regime',
        PULLBACK_CONTINUATION: 'trend close beyond 60-bar SMA, intrabar touch of 20-bar SMA, close recovers on regime side',
        VOLATILITY_EXPANSION: 'true range / ATR20 >= 2.0 and close direction matches 4h regime'
      },
      familyIsolation: 'Each family is evaluated and attributed independently; no pooled signal count or blind mixing.'
    },
    edgeModel: {
      modelId: 'HENGYU-EDGE-HY-EXP-0024-RIDGE-001',
      edgeSource: 'HENGYU-HY-EXP-0024-PURGED-RIDGE-FORWARD',
      target: 'CURRENT AUDIT DESIGN MISMATCH: directional executable forward return after six 1h bars is not the same label as the current unbounded stop/channel exit',
      horizonBars: 6,
      features: [
        'trend strength: (close - SMA60) / ATR20',
        'distance to fast/slow SMA in bps',
        '4h breadth fraction',
        'breakout or pullback distance in ATR units',
        'ATR20 normalized volatility',
        'quoteVolume / prior-six-bar median quoteVolume',
        'recent 6-bar momentum',
        'BTC regime one-hot',
        'funding rate and absolute funding rate',
        'symbol liquidity rank and log quoteVolume'
      ],
      transforms: 'fit winsorization at train 1st/99th percentiles and z-score mean/std on train only; apply frozen transform to validation/OOS',
      training: 'separate ridge regression for each candidate family x regime x side; intercept included; lambda=1.0 frozen; no pooled BUY/BULL mean',
      sensitivityGrid: { lambda: [0.1, 1, 10], selection: 'report stability only; lambda=1.0 remains the preregistered primary model' },
      minimumSamples: 100,
      unavailableRule: 'below minimum samples or missing causal feature => available=false, expectedPriceEdgeBps=null, edgeSource=UNVERIFIED',
      uncertainty: 'residual standard error with finite-sample correction; conservative edge = prediction - 1.645*standardErrorBps',
      calibration: ['MAE', 'RMSE', 'decile predicted-vs-realized mean', 'decile calibration slope/intercept', 'Spearman rank correlation'],
      validation: 'expanding walk-forward; purge=6 bars; embargo=6 bars; development and final untouched OOS are separate; no OOS reads before development PASS'
    },
    edgeExitAlignment: {
      status: 'REVIEW_REQUIRED_NOT_ACCEPTED_FOR_PREREGISTRATION_AS_IS',
      currentMismatch: {
        edgeTarget: 'six completed 1h directional forward-return bars',
        currentTradeExit: '2 ATR20 stop or prior-60 completed-1h channel exit with no maximum holding period',
        consequence: 'a six-hour prediction is not the realized advisory return when the channel exit occurs later and funding continues'
      },
      recommendedArchitecture: 'B_EXACT_EXECUTION_LABEL_WITH_FROZEN_EVALUATION_CAP',
      proposedArchitecture: {
        label: 'net realized return from the exact frozen stop/channel execution policy',
        stop: '2.0 ATR20 from executable entry',
        dynamicChannel: 'prior-60 completed 1h channel adverse close',
        evaluationCapBars: 6,
        terminalRule: 'if neither stop nor channel exit occurs by the sixth completed 1h bar, use a terminal exit at that bar close; this cap is fixed for alignment, not tuned from outcomes',
        holdingPeriod: 'actual entry-to-stop/channel/terminal exit interval',
        funding: 'include every realized funding event whose fundingTime falls within that same actual holding interval; missing required funding fails closed',
        target: 'net executable return after fee, conservative slippage/impact, funding and latency proxy for the exact labeled exit',
        noHorizonTuning: true
      },
      reviewerDecisionRequired: true,
      notRunInThisCorrection: true
    },
    costs: {
      source: 'config/net-edge-model.json',
      feeBpsRoundTrip: 10,
      spreadAndStressedBookProxyBps: 4,
      impactBpsRoundTrip: 2,
      latencyBpsRoundTrip: 2,
      totalProxyBps: 18,
      funding: 'realized funding events known at decision/holding time; missing event fails closed',
      rule: 'conservative executable edge must exceed costs + funding stress + uncertainty + minimum net hurdle'
    },
    exits: {
      stop: '2.0 ATR20 from executable entry',
      dynamicChannel: 'exit on completed 1h close through prior 60 completed 1h channel in adverse direction',
      profitProtection: 'none in primary model; any trailing/profit-protection variant is a separate family/experiment',
      maxHold: 'none in primary model; research expiry is not a holding-period exit',
      alignmentStatus: 'current exit is not aligned with the six-bar edge target; see edgeExitAlignment; no Edge Model training is authorized by this audit correction',
      boundary: 'open positions at evaluation boundary are censored/held out, never force-labeled as profitable'
    },
    riskAndDelivery: {
      sizing: 'existing stop-risk sizing and exchange step/min-notional validation',
      limits: 'existing config/net-edge-model.json portfolio limits',
      advisory: 'only Edge -> Net Edge -> Portfolio Risk PASS may create PAPER_ONLY Advisory',
      gmail: 'reuse existing Gmail; strong immediate, medium existing 15m digest semantics, observe web/Supabase only',
      orderApi: false,
      accountApi: false
    },
    promotionGates: [
      'validated edge available for every promoted candidate family/regime/side',
      'minimum sample and calibration gates pass',
      'net PF > 1 after fees/slippage/funding in development and untouched OOS',
      'positive months, MTM drawdown, CVaR95, loss streak, symbol breadth and regime breadth gates pass',
      'cost stress and parameter stability pass without manual rescue',
      'if development fails: STOP; do not read or optimize against final OOS'
    ],
    status: 'not_preregistered_not_promoted'
  };
}

function writeOutputs() {
  const { audit } = buildAudit();
  const design = buildModelDesign();
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  const auditPath = path.join(OUTPUT_ROOT, 'HY-EXP-0024-signal-funnel.json');
  const designPath = path.join(OUTPUT_ROOT, 'HY-EXP-0024-model-design.json');
  fs.writeFileSync(auditPath, `${JSON.stringify(audit, null, 2)}\n`);
  fs.writeFileSync(designPath, `${JSON.stringify(design, null, 2)}\n`);
  const report = [
    '# HY-EXP-0024 signal funnel audit and practical model design',
    '',
    `Status: ${audit.status}; no promotion, no live orders, and no new OOS.`,
    '',
    `Audit window: ${audit.auditWindow.start} to ${audit.auditWindow.endExclusive} (0019 development information only).`,
    '',
    '## Structural H12 finding',
    '',
    `Live H12 edge fields are null/UNVERIFIED/sampleSize=0; forceUnverifiedEdgeNoTrade=${audit.liveH12StructuralAudit.forceUnverifiedEdgeNoTrade}. Otherwise-valid historical breakout candidates therefore cannot become Gmail advisories through the live path.`,
    '',
    '## Funnel',
    '',
    `- Current H12 theoretical 4h breakout candidates: ${audit.currentH12Funnel.breakoutCandidates}`,
    `- Current H12 strict historical executable candidates: ${audit.currentH12Funnel.strictHistoricalExecutableCandidates}`,
    `- Current H12 edge/net-edge/risk/Gmail pass: ${audit.currentH12Funnel.edgeEligible}/${audit.currentH12Funnel.netEdgePass}/${audit.currentH12Funnel.portfolioRiskPass}/${audit.currentH12Funnel.gmailAdvisories}`,
    `- Proposed 1h family observations: ${audit.proposedExpansionFunnel.candidateFamilyObservations}; unique candidate slots: ${audit.proposedExpansionFunnel.uniqueCandidateSlots}; family overlap slots: ${audit.proposedExpansionFunnel.familyOverlapSlots}; edge/net-edge/risk/Gmail pass remains 0 until a separately validated edge model exists.`,
    `- Controlled counts: baseline=${audit.controlledComparisons.baseline.candidateCount}; +bidirectional=${audit.controlledComparisons.bidirectional.bidirectionalTotal}; +observed-universe=${audit.controlledComparisons.observedUniverse.candidateCount}; 1h breakout unique=${audit.controlledComparisons.oneHourBreakout.uniqueCandidateSlots}; all-family observations=${audit.controlledComparisons.additionalFamilies.candidateFamilyObservations}; all-family unique=${audit.controlledComparisons.additionalFamilies.uniqueCandidateSlots}.`,
    `- Direction attribution: bear/SELL=${audit.currentH12Funnel.directionOnlyComparison.bearSellCandidates}; bull/BUY=${audit.currentH12Funnel.directionOnlyComparison.bullBuyCandidates}; bidirectional=${audit.currentH12Funnel.directionOnlyComparison.bidirectionalTotal}; SELL_ONLY impact is bull/BUY only under fixed-six 4h semantics.`,
    `- Edge/exit alignment: ${design.edgeExitAlignment.status}; recommended resolution=${design.edgeExitAlignment.recommendedArchitecture}; no Edge Model training or horizon tuning was run.`,
    '',
    '## Cost/profitability interpretation',
    '',
    'The JSON reports candidate-level descriptive forward outcomes using an 18 bps round-trip OHLCV execution proxy plus archived funding. These are DESCRIPTIVE_ONLY, NOT_PNL, NOT_OOS, and NOT_PROMOTION_ELIGIBLE. Overlapping family observations are not portfolio returns or portfolio drawdown; no validated candidate-level edge is available.',
    '',
    '## Decision',
    '',
    'FAIL / NOT PROMOTED: the audit establishes a structural zero-advisory edge blocker and does not demonstrate a promotion-grade improvement in net profitability plus usable signal count.',
    '',
    'See the JSON artifacts for symbol/month/regime/direction/family breakdowns, Pareto diagnostics, exact proposed model, gates and limitations.'
  ].join('\n');
  fs.writeFileSync(path.join(OUTPUT_ROOT, 'HY-EXP-0024-audit.md'), `${report}\n`);
  console.log(JSON.stringify({
    audit: path.relative(ROOT, auditPath).replaceAll('\\', '/'),
    design: path.relative(ROOT, designPath).replaceAll('\\', '/'),
    currentH12Candidates: audit.currentH12Funnel.breakoutCandidates,
    proposedCandidates: audit.proposedExpansionFunnel.candidateFamilyObservations,
    currentGmailAdvisories: audit.currentH12Funnel.gmailAdvisories,
    promotion: audit.noPromotionDecision,
    proxyComparison: audit.proxyProfitabilityComparison
  }, null, 2));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.argv[2] !== 'run') throw new Error('usage: node scripts/hy-exp-0024-audit.mjs run');
  writeOutputs();
}

export {
  buildAudit,
  buildDynamicUniverse,
  buildModelDesign,
  familyOverlapStats,
  selectCompletedFourHourSnapshot,
  summarizeCandidateSet
};
