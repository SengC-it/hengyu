import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { unzipSingle } from './archive.mjs';

export const HY_EXP_0030 = 'HY-EXP-0030';
export const WINDOW_START = Date.parse('2024-08-26T00:00:00Z');
export const WINDOW_END = Date.parse('2026-08-26T00:00:00Z');
export const FIXED_SYMBOLS = Object.freeze([
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT',
  'XRPUSDT', 'DOGEUSDT', 'LINKUSDT', 'LTCUSDT'
]);
export const HOUR = 60 * 60 * 1000;
export const FOUR_HOURS = 4 * HOUR;
export const FIVE_MINUTES = 5 * 60 * 1000;
export const MONTHLY_ARCHIVE_END = Date.parse('2026-08-01T00:00:00Z');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const CACHE_ROOT = path.join(ROOT, 'data', 'cache', HY_EXP_0030);
export const ARTIFACT_ROOT = path.join(ROOT, 'artifacts', HY_EXP_0030);
const SOURCE_HOST = 'https://data.binance.vision/data/futures/um';
const REST_HOST = 'https://fapi.binance.com';

function mkdirFor(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function iso(value) {
  return new Date(value).toISOString();
}

function monthKeys(start, end) {
  const values = [];
  const cursor = new Date(start);
  cursor.setUTCDate(1);
  while (cursor < end) {
    values.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return values;
}

function archivePlan(symbol, stream, interval) {
  const plans = [];
  const archiveKind = stream === 'mark5m' ? 'markPriceKlines' : stream === 'funding' ? 'fundingRate' : 'klines';
  const intervalName = interval || (stream === 'mark5m' ? '5m' : undefined);
  for (const month of monthKeys(WINDOW_START, MONTHLY_ARCHIVE_END)) {
    const name = stream === 'funding'
      ? `${symbol}-fundingRate-${month}.zip`
      : `${symbol}-${intervalName}-${month}.zip`;
    const url = stream === 'funding'
      ? `${SOURCE_HOST}/monthly/${archiveKind}/${symbol}/${name}`
      : `${SOURCE_HOST}/monthly/${archiveKind}/${symbol}/${intervalName}/${name}`;
    plans.push({ source: 'BINANCE_DATA_ARCHIVE', period: month, url, cachePath: path.join(CACHE_ROOT, 'archives', name) });
  }
  return plans;
}

function restUrl(stream, symbol, interval, startTime, endTime, limit = 1500) {
  if (stream === 'funding') {
    return `${REST_HOST}/fapi/v1/fundingRate?symbol=${symbol}&startTime=${startTime}&endTime=${endTime}&limit=${Math.min(limit, 1000)}`;
  }
  const endpoint = stream === 'mark5m' ? '/fapi/v1/markPriceKlines' : '/fapi/v1/klines';
  return `${REST_HOST}${endpoint}?symbol=${symbol}&interval=${interval}&startTime=${startTime}&endTime=${endTime}&limit=${limit}`;
}

function restPlans(symbol, stream, interval) {
  const plans = [];
  const step = stream === 'funding' ? 30 * 24 * HOUR : interval === '5m' ? 3 * 24 * HOUR : 30 * 24 * HOUR;
  let start = MONTHLY_ARCHIVE_END;
  let index = 0;
  while (start < WINDOW_END) {
    const end = Math.min(WINDOW_END, start + step);
    const name = `${symbol}-${stream}-${interval || 'funding'}-${index}.json`;
    plans.push({
      source: 'BINANCE_PUBLIC_REST',
      period: `${iso(start)}/${iso(end)}`,
      url: restUrl(stream, symbol, interval, start, end - 1),
      cachePath: path.join(CACHE_ROOT, 'rest', name),
      startTime: start,
      endTime: end
    });
    start = end;
    index += 1;
  }
  return plans;
}

async function fetchBytes(plan) {
  mkdirFor(plan.cachePath);
  if (fs.existsSync(plan.cachePath)) {
    const bytes = fs.readFileSync(plan.cachePath);
    if (plan.cachePath.endsWith('.json')) {
      try {
        const cached = JSON.parse(bytes.toString('utf8'));
        if (cached?.status === 'ERROR' || (!Array.isArray(cached) && cached?.data === null)) {
          fs.unlinkSync(plan.cachePath);
        } else {
          return { ...plan, bytes, sha256: sha256(bytes), cached: true };
        }
      } catch {
        fs.unlinkSync(plan.cachePath);
      }
    } else {
      return { ...plan, bytes, sha256: sha256(bytes), cached: true };
    }
  }
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(plan.url);
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0) throw new Error('EMPTY_RESPONSE');
      if (plan.cachePath.endsWith('.json')) {
        const parsed = JSON.parse(bytes.toString('utf8'));
        if (parsed?.status === 'ERROR' || (!Array.isArray(parsed) && parsed?.data === null)) throw new Error('REST_ERROR_RESPONSE');
      }
      fs.writeFileSync(plan.cachePath, bytes);
      return { ...plan, bytes, sha256: sha256(bytes), cached: false };
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 250 * attempt));
    }
  }
  throw new Error(`${plan.url}: ${lastError?.message || 'FETCH_FAILED'}`);
}

async function fetchPlanList(plans, concurrency = 4) {
  const result = [];
  let cursor = 0;
  async function worker() {
    while (cursor < plans.length) {
      const index = cursor++;
      result[index] = await fetchBytes(plans[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, plans.length) }, worker));
  return result;
}

function csvLines(bytes) {
  const text = unzipSingle(bytes).toString('utf8').trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/).filter(Boolean);
  return /^\D/.test(lines[0]) ? lines.slice(1) : lines;
}

function validateOHLC(row, label, requireVolume = true) {
  const fields = ['openTime', 'closeTime', 'open', 'high', 'low', 'close'];
  if (requireVolume) fields.push('quoteVolume', 'trades');
  for (const field of fields) {
    if (!Number.isFinite(row[field])) throw new Error(`${label}:NON_FINITE_${field}`);
  }
  if (row.high < row.low || row.high < Math.max(row.open, row.close) || row.low > Math.min(row.open, row.close)) {
    throw new Error(`${label}:INVALID_OHLC`);
  }
  if (requireVolume && (row.quoteVolume < 0 || row.trades < 0)) throw new Error(`${label}:NEGATIVE_ACTIVITY`);
}

function parseKlineCSV(bytes, symbol, intervalMs, stream) {
  const rows = [];
  for (const [index, line] of csvLines(bytes).entries()) {
    const values = line.split(',');
    if (values.length < 7) throw new Error(`${symbol}/${stream}/row${index + 1}:TOO_FEW_FIELDS`);
    const row = {
      symbol,
      openTime: Number(values[0]),
      open: Number(values[1]),
      high: Number(values[2]),
      low: Number(values[3]),
      close: Number(values[4]),
      volume: Number(values[5]),
      closeTime: Number(values[6]),
      quoteVolume: Number(values[7] ?? 0),
      trades: Number(values[8] ?? 0)
    };
    validateOHLC(row, `${symbol}/${stream}/row${index + 1}`, stream !== 'mark5m');
    if (row.closeTime !== row.openTime + intervalMs - 1) throw new Error(`${symbol}/${stream}/row${index + 1}:BAD_BOUNDARY`);
    if (row.openTime >= WINDOW_START && row.openTime < WINDOW_END) rows.push(row);
  }
  return rows;
}

function parseFundingCSV(bytes, symbol) {
  const rows = [];
  for (const [index, line] of csvLines(bytes).entries()) {
    const values = line.split(',');
    if (values.length < 3) throw new Error(`${symbol}/funding/row${index + 1}:TOO_FEW_FIELDS`);
    const row = {
      symbol,
      fundingTime: Number(values[0]),
      fundingIntervalHours: Number(values[1]),
      fundingRate: Number(values[2])
    };
    if (!Number.isFinite(row.fundingTime) || !Number.isFinite(row.fundingIntervalHours) || !Number.isFinite(row.fundingRate)) {
      throw new Error(`${symbol}/funding/row${index + 1}:NON_FINITE`);
    }
    if (row.fundingIntervalHours <= 0) throw new Error(`${symbol}/funding/row${index + 1}:BAD_INTERVAL`);
    if (row.fundingTime >= WINDOW_START && row.fundingTime < WINDOW_END) rows.push(row);
  }
  return rows;
}

function parseRestKlines(bytes, symbol, intervalMs, stream) {
  const values = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(values)) throw new Error(`${symbol}/${stream}:REST_NOT_ARRAY`);
  return values.map((value, index) => {
    const row = {
      symbol,
      openTime: Number(value[0]),
      open: Number(value[1]),
      high: Number(value[2]),
      low: Number(value[3]),
      close: Number(value[4]),
      volume: Number(value[5]),
      closeTime: Number(value[6]),
      quoteVolume: Number(value[7] ?? 0),
      trades: Number(value[8] ?? 0)
    };
    validateOHLC(row, `${symbol}/${stream}/REST${index + 1}`, stream !== 'mark5m');
    if (row.closeTime !== row.openTime + intervalMs - 1) throw new Error(`${symbol}/${stream}/REST${index + 1}:BAD_BOUNDARY`);
    return row;
  }).filter(row => row.openTime >= WINDOW_START && row.openTime < WINDOW_END);
}

function parseRestFunding(bytes, symbol) {
  const values = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(values)) throw new Error(`${symbol}/funding:REST_NOT_ARRAY`);
  return values.map((value, index) => {
    const row = {
      symbol,
      fundingTime: Number(value.fundingTime),
      fundingIntervalHours: Number(value.fundingIntervalHours ?? 8),
      fundingRate: Number(value.fundingRate)
    };
    if (!Number.isFinite(row.fundingTime) || !Number.isFinite(row.fundingIntervalHours) || !Number.isFinite(row.fundingRate)) {
      throw new Error(`${symbol}/funding/REST${index + 1}:NON_FINITE`);
    }
    return row;
  }).filter(row => row.fundingTime >= WINDOW_START && row.fundingTime < WINDOW_END);
}

function mergeRows(rows, timeField, label, intervalMs = null) {
  const sorted = rows.flat().sort((left, right) => left[timeField] - right[timeField]);
  const result = [];
  for (const row of sorted) {
    const previous = result[result.length - 1];
    if (previous && row[timeField] === previous[timeField]) throw new Error(`${label}:DUPLICATE_${row[timeField]}`);
    if (previous && intervalMs !== null && row[timeField] !== previous[timeField] + intervalMs) {
      throw new Error(`${label}:GAP_${previous[timeField]}_${row[timeField]}`);
    }
    result.push(row);
  }
  return result;
}

async function loadStream(symbol, stream, interval) {
  const intervalMs = interval === '4h' ? FOUR_HOURS : interval === '1h' ? HOUR : FIVE_MINUTES;
  const plans = [...archivePlan(symbol, stream, interval), ...restPlans(symbol, stream, interval)];
  const files = await fetchPlanList(plans);
  const parsed = files.map(file => {
    const rows = stream === 'funding'
      ? (file.source === 'BINANCE_DATA_ARCHIVE' ? parseFundingCSV(file.bytes, symbol) : parseRestFunding(file.bytes, symbol))
      : (file.source === 'BINANCE_DATA_ARCHIVE' ? parseKlineCSV(file.bytes, symbol, intervalMs, stream) : parseRestKlines(file.bytes, symbol, intervalMs, stream));
    return { file: { source: file.source, period: file.period, url: file.url, sha256: file.sha256, cached: file.cached }, rows };
  });
  const rows = stream === 'funding'
    ? mergeRows(parsed.map(item => item.rows), 'fundingTime', `${symbol}/funding`)
    : mergeRows(parsed.map(item => item.rows), 'openTime', `${symbol}/${stream}`, intervalMs);
  return { rows, files: parsed.map(item => item.file) };
}

function expectedRows(start, end, intervalMs) {
  return Math.floor((end - start) / intervalMs);
}

function summarizeCoverage(rows, timeField, intervalMs = null) {
  if (!rows.length) return { count: 0, first: null, last: null, expected: intervalMs ? expectedRows(WINDOW_START, WINDOW_END, intervalMs) : null, missing: [] };
  const missing = [];
  if (intervalMs !== null) {
    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1][timeField];
      const current = rows[index][timeField];
      for (let time = previous + intervalMs; time < current; time += intervalMs) missing.push(iso(time));
    }
  }
  return {
    count: rows.length,
    first: iso(rows[0][timeField]),
    last: iso(rows[rows.length - 1][timeField]),
    expected: intervalMs ? expectedRows(WINDOW_START, WINDOW_END, intervalMs) : null,
    firstCoverage: rows[0][timeField] <= WINDOW_START,
    lastCoverage: intervalMs === null ? rows.at(-1)[timeField] >= WINDOW_END - 12 * HOUR : rows.at(-1)[timeField] >= WINDOW_END - intervalMs,
    missingIntervals: missing.length,
    missingSample: missing.slice(0, 10)
  };
}

function mapByTime(rows, field = 'openTime') {
  return new Map(rows.map(row => [row[field], row]));
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function std(values) {
  if (values.length < 2) return null;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

function slope(values) {
  if (values.length < 2) return null;
  const xMean = (values.length - 1) / 2;
  const yMean = mean(values);
  let numerator = 0;
  let denominator = 0;
  values.forEach((value, index) => {
    numerator += (index - xMean) * (value - yMean);
    denominator += (index - xMean) ** 2;
  });
  return denominator ? numerator / denominator : null;
}

function previousRows(rows, index, count) {
  return rows.slice(Math.max(0, index - count), index);
}

function fourHourReference(oneHourOpenTime) {
  return Math.floor(oneHourOpenTime / FOUR_HOURS) * FOUR_HOURS - FOUR_HOURS;
}

function buildRegimeAt(fourHourMaps, timestamp) {
  const closes = [];
  for (const symbol of FIXED_SYMBOLS) {
    const map = fourHourMaps[symbol];
    const index = map.indexByTime.get(timestamp);
    if (index === undefined || index < 180) return null;
    const row = map.rows[index];
    const sma = (map.prefix[index] - map.prefix[index - 180]) / 180;
    closes.push({ symbol, close: row.close, sma });
  }
  const btc = closes.find(item => item.symbol === 'BTCUSDT');
  const bullBreadth = closes.filter(item => item.close > item.sma).length / closes.length;
  const bearBreadth = closes.filter(item => item.close < item.sma).length / closes.length;
  if (btc.close > btc.sma && bullBreadth >= 0.625) return { regime: 'BULL', breadth: bullBreadth, closes };
  if (btc.close < btc.sma && bearBreadth >= 0.625) return { regime: 'BEAR', breadth: bearBreadth, closes };
  return { regime: 'SIDEWAYS', breadth: Math.max(bullBreadth, bearBreadth), closes };
}

function buildFeatureSnapshot(candidate, series, regime) {
  const symbolRows = series[candidate.symbol].oneHour;
  const index = symbolRows.findIndex(row => row.openTime === candidate.signalOpenTime);
  const prior = previousRows(symbolRows, index, 180);
  const prior24 = prior.slice(-24);
  const prior6 = prior.slice(-6);
  const prior30 = series[candidate.symbol].fourHour.filter(row => row.openTime < candidate.fourHourOpenTime).slice(-30);
  const channel = prior.slice(-120);
  const sideSign = candidate.side === 'BUY' ? 1 : -1;
  const close = candidate.signalClose;
  const btcRows = series.BTCUSDT.oneHour;
  const btcIndex = btcRows.findIndex(row => row.openTime === candidate.signalOpenTime);
  const btcPrior24 = previousRows(btcRows, btcIndex, 25).slice(-25);
  const symbolReturn = prior.length >= 24 ? close / prior.at(-24).close - 1 : null;
  const btcReturn = btcPrior24.length >= 24 ? btcPrior24.at(-1).close / btcPrior24[0].close - 1 : null;
  const atrRows = prior.slice(-21);
  const trueRanges = atrRows.slice(1).map((row, i) => {
    const previous = atrRows[i].close;
    return Math.max(row.high - row.low, Math.abs(row.high - previous), Math.abs(row.low - previous));
  });
  const atr = mean(trueRanges);
  const high24 = Math.max(...prior24.map(row => row.high));
  const low24 = Math.min(...prior24.map(row => row.low));
  const previousChannel = channel.length ? (candidate.side === 'BUY' ? Math.max(...channel.map(row => row.high)) : Math.min(...channel.map(row => row.low))) : null;
  const breakoutPersistence = prior.slice(-3).reduce((count, row, offset) => {
    const end = symbolRows.findIndex(item => item.openTime === row.openTime);
    const historical = previousRows(symbolRows, end, 120);
    if (historical.length < 120) return count;
    const boundary = candidate.side === 'BUY' ? Math.max(...historical.map(item => item.high)) : Math.min(...historical.map(item => item.low));
    return count + (candidate.side === 'BUY' ? row.close > boundary : row.close < boundary ? 1 : 0);
  }, 0);
  const fundingRows = series[candidate.symbol].funding.filter(row => row.fundingTime <= candidate.decisionTime);
  const latestFunding = fundingRows.at(-1)?.fundingRate ?? null;
  const previousFunding = fundingRows.at(-2)?.fundingRate ?? latestFunding;
  const logReturns = prior24.slice(1).map((row, i) => Math.log(row.close / prior24[i].close));
  const shortReturns = prior6.length >= 6 ? prior6.at(-1).close / prior6[0].close - 1 : null;
  const volShort = std(logReturns.slice(-6));
  const volLong = std(logReturns);
  const values = [
    previousChannel === null ? null : sideSign * (close - previousChannel) / close * 10000,
    atr === null ? null : atr / close * 100,
    volLong === null ? null : volLong * Math.sqrt(24) * 100,
    slope(prior24.map(row => Math.log(row.close))) * sideSign * 10000,
    slope(prior30.map(row => Math.log(row.close))) * sideSign * 10000,
    btcReturn === null ? null : Math.sign(symbolReturn || 0) === Math.sign(btcReturn) ? 1 : -1,
    symbolReturn === null || btcReturn === null ? null : sideSign * (symbolReturn - btcReturn) * 10000,
    prior24.length ? close === null ? null : symbolRows[index].quoteVolume / mean(prior24.map(row => row.quoteVolume)) - 1 : null,
    latestFunding,
    latestFunding === null ? null : latestFunding - previousFunding,
    sideSign * (candidate.side === 'BUY' ? (close - low24) / close : (high24 - close) / close) * 10000,
    breakoutPersistence,
    shortReturns === null ? null : sideSign * shortReturns * 10000,
    regime.breadth,
    regime.breadth,
    Math.log1p(prior24.reduce((sum, row) => sum + row.quoteVolume, 0)),
    Math.log1p(prior24.reduce((sum, row) => sum + row.trades, 0)),
    volShort === null || volLong === null || volLong === 0 ? null : volShort / volLong - 1,
    Math.sin(2 * Math.PI * (new Date(candidate.decisionTime).getUTCHours() / 24)),
    Math.cos(2 * Math.PI * (new Date(candidate.decisionTime).getUTCHours() / 24)),
    sideSign
  ];
  if (values.some(value => !Number.isFinite(value))) return null;
  return values;
}

export function buildCandidates(series) {
  const fourHourMaps = Object.fromEntries(FIXED_SYMBOLS.map(symbol => {
    const rows = series[symbol].fourHour;
    const map = new Map(rows.map(row => [row.openTime, row]));
    map.rows = rows;
    map.indexByTime = new Map(rows.map((row, index) => [row.openTime, index]));
    map.prefix = [0];
    for (const row of rows) map.prefix.push(map.prefix.at(-1) + row.close);
    return [symbol, map];
  }));
  const candidates = [];
  const contextsByTime = new Map();
  const rejection = { missingRegime: 0, insufficientHistory: 0, featureInvalid: 0 };
  for (const symbol of FIXED_SYMBOLS) {
    const rows = series[symbol].oneHour;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (row.openTime < WINDOW_START || row.openTime >= WINDOW_END) continue;
      const prior120 = previousRows(rows, index, 120);
      const reference = fourHourReference(row.openTime);
      const regime = buildRegimeAt(fourHourMaps, reference);
      if (!regime) { rejection.missingRegime += 1; continue; }
      const decisionTime = row.closeTime + 1;
      const base = {
        experimentId: HY_EXP_0030,
        symbol,
        signalOpenTime: row.openTime,
        decisionTime,
        fourHourOpenTime: reference,
        signalClose: row.close,
        regime: regime.regime,
        breadth: regime.breadth
      };
      const side = regime.regime === 'BULL' && row.close > Math.max(...prior120.map(item => item.high))
        ? 'BUY'
        : regime.regime === 'BEAR' && row.close < Math.min(...prior120.map(item => item.low))
          ? 'SELL'
          : null;
      if (!side) {
        const contextKey = `${row.openTime}:${regime.regime}`;
        const context = contextsByTime.get(contextKey) || {
          experimentId: HY_EXP_0030,
          signalOpenTime: row.openTime,
          decisionTime,
          fourHourOpenTime: reference,
          regime: regime.regime,
          breadth: regime.breadth,
          side: 'NO_TRADE',
          contextStatus: 'NO_TRADE',
          noTradeReason: regime.regime === 'SIDEWAYS' ? 'SIDEWAYS_REGIME' : 'NO_BREAKOUT',
          symbols: []
        };
        context.symbols.push(symbol);
        contextsByTime.set(contextKey, context);
        continue;
      }
      const candidate = { ...base, side, entryOpenTime: decisionTime + FIVE_MINUTES };
      candidate.features = buildFeatureSnapshot(candidate, series, regime);
      if (!candidate.features) { rejection.featureInvalid += 1; continue; }
      candidates.push(candidate);
    }
  }
  candidates.sort((left, right) => left.decisionTime - right.decisionTime || left.symbol.localeCompare(right.symbol));
  return {
    candidates,
    counts: {
      raw: candidates.length,
      BUY: candidates.filter(candidate => candidate.side === 'BUY').length,
      SELL: candidates.filter(candidate => candidate.side === 'SELL').length,
      SIDEWAYS_CONTEXT: contextsByTime.size
    },
    rejection,
    contexts: [...contextsByTime.values()].map(context => ({
      ...context,
      symbols: [...context.symbols].sort()
    }))
  };
}

function writeJson(filePath, value) {
  mkdirFor(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function loadCoreData({ include5m = false } = {}) {
  const series = {};
  const manifest = [];
  const errors = [];
  for (const symbol of FIXED_SYMBOLS) {
    series[symbol] = {};
    for (const [stream, interval] of [['oneHour', '1h'], ['fourHour', '4h'], ['funding', null]]) {
      try {
        const loaded = await loadStream(symbol, stream === 'funding' ? 'funding' : 'contract', interval);
        series[symbol][stream] = loaded.rows;
        manifest.push(...loaded.files.map(file => ({ symbol, stream, ...file })));
      } catch (error) {
        errors.push({ symbol, stream, error: error.message });
        series[symbol][stream] = [];
      }
    }
    if (include5m) {
      for (const [stream, interval] of [['contract5m', '5m'], ['mark5m', '5m']]) {
        try {
          const loaded = await loadStream(symbol, stream === 'mark5m' ? 'mark5m' : 'contract', interval);
          series[symbol][stream] = loaded.rows;
          manifest.push(...loaded.files.map(file => ({ symbol, stream, ...file })));
        } catch (error) {
          errors.push({ symbol, stream, error: error.message });
          series[symbol][stream] = [];
        }
      }
    }
  }
  return { series, manifest, errors };
}

function auditSymbol(symbol, series, include5m, executionCoverage = {}) {
  const streams = {
    contract1h: summarizeCoverage(series.oneHour, 'openTime', HOUR),
    contract4h: summarizeCoverage(series.fourHour, 'openTime', FOUR_HOURS),
    funding: summarizeCoverage(series.funding, 'fundingTime')
  };
  if (include5m) {
    streams.contract5m = executionCoverage.contract5m;
    streams.mark5m = executionCoverage.mark5m;
  }
  return { symbol, streams };
}

export async function runAudit() {
  const core = await loadCoreData({ include5m: false });
  const candidate = core.errors.length ? { candidates: [], counts: { raw: 0, BUY: 0, SELL: 0 }, rejection: {} } : buildCandidates(core.series);
  const preliminaryCoverage = FIXED_SYMBOLS.map(symbol => auditSymbol(symbol, core.series[symbol], false));
  const coverageDays = Math.min(...FIXED_SYMBOLS.map(symbol => {
    const first = core.series[symbol].oneHour[0]?.openTime ?? WINDOW_START;
    const last = core.series[symbol].oneHour.at(-1)?.closeTime ?? first;
    return Math.floor((last - first) / 86400000);
  }));
  const preliminaryGatePass = core.errors.length === 0
    && preliminaryCoverage.every(item => Object.values(item.streams).every(stream => stream.count > 0 && stream.firstCoverage && stream.lastCoverage && stream.missingIntervals === 0))
    && coverageDays >= 365
    && candidate.counts.raw >= 300
    && candidate.counts.BUY >= 100
    && candidate.counts.SELL >= 100;
  const executionCoverage = {};
  if (preliminaryGatePass) {
    for (const symbol of FIXED_SYMBOLS) {
      executionCoverage[symbol] = {};
      for (const [stream, interval] of [['contract5m', '5m'], ['mark5m', '5m']]) {
        try {
          const loaded = await loadStream(symbol, stream === 'mark5m' ? 'mark5m' : 'contract', interval);
          executionCoverage[symbol][stream] = summarizeCoverage(loaded.rows, 'openTime', FIVE_MINUTES);
          core.manifest.push(...loaded.files.map(file => ({ symbol, stream, ...file })));
        } catch (error) {
          executionCoverage[symbol][stream] = { count: 0, first: null, last: null, expected: expectedRows(WINDOW_START, WINDOW_END, FIVE_MINUTES), firstCoverage: false, lastCoverage: false, missingIntervals: null, missingSample: [] };
          core.errors.push({ symbol, stream, error: error.message });
        }
      }
    }
  }
  const include5m = preliminaryGatePass;
  const symbolCoverage = FIXED_SYMBOLS.map(symbol => auditSymbol(symbol, core.series[symbol], include5m, executionCoverage[symbol]));
  const coreCoverageOk = core.errors.length === 0 && symbolCoverage.every(item => Object.values(item.streams).every(stream => stream.count > 0 && stream.firstCoverage && stream.lastCoverage && stream.missingIntervals === 0));
  const gate = {
    calendarCoverageDays: coverageDays,
    calendarCoveragePass: coverageDays >= 365,
    rawCandidates: candidate.counts.raw,
    rawCandidatesPass: candidate.counts.raw >= 300,
    BUYCandidates: candidate.counts.BUY,
    BUYCandidatesPass: candidate.counts.BUY >= 100,
    SELLCandidates: candidate.counts.SELL,
    SELLCandidatesPass: candidate.counts.SELL >= 100,
    coreStreamsPass: coreCoverageOk,
    pass: coverageDays >= 365 && candidate.counts.raw >= 300 && candidate.counts.BUY >= 100 && candidate.counts.SELL >= 100 && coreCoverageOk
  };
  const artifact = {
    schemaVersion: 1,
    artifactType: 'HY_EXP_0030_DATA_AVAILABILITY_AUDIT',
    immutable: true,
    experimentId: HY_EXP_0030,
    preregistrationPath: 'registry/experiments/HY-EXP-0030/preregistration.json',
    window: { start: iso(WINDOW_START), endExclusive: iso(WINDOW_END), calendarDaysTarget: 730 },
    outcomeRead: false,
    pnlComputed: false,
    finalOosRead: false,
    historicalSources: {
      archive: SOURCE_HOST,
      rest: REST_HOST,
      privateApiUsed: false,
      orderApiUsed: false,
      accountApiUsed: false,
      openInterestHistoricalUsed: false,
      historicalL2Used: false,
      ohlcvDepthProxyUsed: false
    },
    cohorts: {
      FIXED_8_BASELINE: {
        symbols: FIXED_SYMBOLS,
        membershipStatus: 'FROZEN_BASELINE_WITH_ARCHIVE_PRESENCE',
        survivorshipSelection: false,
        coverage: symbolCoverage
      },
      PIT_EXPANDED: {
        status: 'EXPANDED_UNIVERSE_NOT_EVALUABLE',
        reason: 'No complete historical contract metadata archive was used; current exchangeInfo was not used as a backfill.',
        maximumSymbols: 50
      }
    },
    candidateCounts: candidate.counts,
    candidateRejections: candidate.rejection,
    gate,
    status: gate.pass ? 'DATA_AVAILABLE_AUDIT_PASS' : 'DATASET_INSUFFICIENT',
    developmentAllowed: gate.pass,
    reason: gate.pass ? null : 'One or more frozen pre-outcome data gates failed; outcome/model evaluation is forbidden.'
  };
  writeJson(path.join(ARTIFACT_ROOT, 'data-availability-audit.json'), artifact);
  writeJson(path.join(ARTIFACT_ROOT, 'candidate-timestamps.json'), candidate.candidates.map(({ features, ...row }) => row));
  writeJson(path.join(ARTIFACT_ROOT, 'sideways-context.json'), candidate.contexts);
  writeJson(path.join(ARTIFACT_ROOT, 'data-manifest.json'), {
    schemaVersion: 1,
    experimentId: HY_EXP_0030,
    window: { start: iso(WINDOW_START), endExclusive: iso(WINDOW_END) },
    generatedAt: new Date().toISOString(),
    files: core.manifest,
    loadErrors: core.errors,
    rawFilesAreLocalCacheOnly: true,
    outcomeRead: false,
    pnlComputed: false,
    finalOosRead: false
  });
  return { artifact, core, candidate };
}

function atr20At(candidate, series) {
  const rows = series[candidate.symbol].oneHour;
  const index = rows.findIndex(row => row.openTime === candidate.signalOpenTime);
  const history = rows.slice(Math.max(0, index - 20), index + 1);
  if (history.length < 21) return null;
  const ranges = history.slice(1).map((row, offset) => {
    const previousClose = history[offset].close;
    return Math.max(row.high - row.low, Math.abs(row.high - previousClose), Math.abs(row.low - previousClose));
  });
  return mean(ranges);
}

function fundingPnlToTime(candidate, entryTime, exitTime, quantity, series, sideSign) {
  return series[candidate.symbol].funding
    .filter(row => row.fundingTime > entryTime && row.fundingTime <= exitTime)
    .reduce((sum, row) => sum - sideSign * quantity * row.fundingRate * candidate.entryPrice, 0);
}

function resolveCandidate(candidate, series, entryRows) {
  const entryBar = entryRows.get(candidate.entryOpenTime);
  if (!entryBar) return { ...candidate, outcomeStatus: 'INVALID_CANDIDATE', invalidReason: 'MISSING_EXACT_5M_ENTRY' };
  const sideSign = candidate.side === 'BUY' ? 1 : -1;
  const atr = atr20At(candidate, series);
  if (!Number.isFinite(atr) || atr <= 0) return { ...candidate, outcomeStatus: 'INVALID_CANDIDATE', invalidReason: 'MISSING_ATR20' };
  const entryPrice = entryBar.open;
  const stopPrice = entryPrice - sideSign * 2 * atr;
  const riskPerUnit = Math.abs(entryPrice - stopPrice);
  const notional = Math.min(5000, 250 * entryPrice / riskPerUnit);
  const quantity = notional / entryPrice;
  const rows = series[candidate.symbol].oneHour;
  const signalIndex = rows.findIndex(row => row.openTime === candidate.signalOpenTime);
  if (signalIndex < 0) return { ...candidate, outcomeStatus: 'INVALID_CANDIDATE', invalidReason: 'MISSING_SIGNAL_BAR' };
  let exitBar = null;
  let exitPrice = null;
  let exitReason = null;
  for (let offset = 1; offset <= 6; offset += 1) {
    const row = rows[signalIndex + offset];
    if (!row) return { ...candidate, outcomeStatus: 'INVALID_CANDIDATE', invalidReason: 'INCOMPLETE_FORWARD_1H' };
    const stopHit = sideSign === 1 ? row.low <= stopPrice : row.high >= stopPrice;
    const prior60 = rows.slice(Math.max(0, signalIndex + offset - 60), signalIndex + offset);
    if (prior60.length < 60) return { ...candidate, outcomeStatus: 'INVALID_CANDIDATE', invalidReason: 'INCOMPLETE_EXIT_CHANNEL' };
    const dynamicLevel = sideSign === 1 ? Math.min(...prior60.map(item => item.low)) : Math.max(...prior60.map(item => item.high));
    const dynamicHit = sideSign === 1 ? row.close <= dynamicLevel : row.close >= dynamicLevel;
    if (stopHit) {
      exitBar = row;
      exitPrice = stopPrice;
      exitReason = 'ATR_STOP';
      break;
    }
    if (dynamicHit) {
      exitBar = row;
      exitPrice = row.close;
      exitReason = 'CHANNEL_EXIT';
      break;
    }
    if (offset === 6) {
      exitBar = row;
      exitPrice = row.close;
      exitReason = 'TERMINAL_EXIT';
    }
  }
  if (!exitBar) return { ...candidate, outcomeStatus: 'INVALID_CANDIDATE', invalidReason: 'NO_FORWARD_EXIT' };
  const exitTime = exitBar.closeTime + 1;
  const grossReturnBps = sideSign * (exitPrice - entryPrice) / entryPrice * 10000;
  const fundingPnl = fundingPnlToTime({ ...candidate, entryPrice }, candidate.entryOpenTime, exitTime, quantity, series, sideSign);
  const fundingBps = fundingPnl / notional * 10000;
  const costs = Object.fromEntries([['18', 18], ['27', 27], ['36', 36]].map(([key, bps]) => {
    const executionCost = (entryPrice * quantity + exitPrice * quantity) * bps / 10000;
    return [key, sideSign * (exitPrice - entryPrice) * quantity + fundingPnl - executionCost];
  }));
  return {
    ...candidate,
    outcomeStatus: 'RESOLVED',
    entryOpenTime: candidate.entryOpenTime,
    entryTime: candidate.entryOpenTime,
    entryPrice,
    exitTime,
    exitPrice,
    exitReason,
    atr20: atr,
    stopPrice,
    notional,
    quantity,
    grossReturnBps,
    fundingPnl,
    fundingBps,
    grossPnl: sideSign * (exitPrice - entryPrice) * quantity,
    netPnl: costs['18'],
    netPnl18: costs['18'],
    netPnl27: costs['27'],
    netPnl36: costs['36'],
    netReturn18Bps: costs['18'] / notional * 10000,
    netReturn27Bps: costs['27'] / notional * 10000,
    netReturn36Bps: costs['36'] / notional * 10000
  };
}

export async function resolveOutcomes(series, candidates, manifest = []) {
  const results = [];
  for (const symbol of FIXED_SYMBOLS) {
    const targetCandidates = candidates.filter(candidate => candidate.symbol === symbol);
    if (!targetCandidates.length) continue;
    const loaded = await loadStream(symbol, 'contract', '5m');
    manifest.push(...loaded.files.map(file => ({ symbol, stream: 'contract5m', ...file })));
    const entryRows = new Map(loaded.rows.map(row => [row.openTime, row]));
    for (const candidate of targetCandidates) results.push(resolveCandidate(candidate, series, entryRows));
  }
  return results.sort((left, right) => left.decisionTime - right.decisionTime || left.symbol.localeCompare(right.symbol));
}

function standardize(training, features) {
  const means = features[0].map((_, index) => mean(training.map(row => row.features[index])));
  const scales = features[0].map((_, index) => std(training.map(row => row.features[index])) || 1);
  return {
    means,
    scales,
    transform(rows) { return rows.map(row => row.map((value, index) => (value - means[index]) / scales[index])); }
  };
}

function sigmoid(value) {
  if (value >= 0) {
    const z = Math.exp(-value);
    return 1 / (1 + z);
  }
  const z = Math.exp(value);
  return z / (1 + z);
}

function fitRidgeLogistic(training) {
  const features = training.map(row => row.features);
  const y = training.map(row => row.netPnl18 > 0 ? 1 : 0);
  const scaler = standardize(training, features);
  const x = scaler.transform(features);
  const weights = Array(x[0].length).fill(0);
  let intercept = 0;
  for (let iteration = 0; iteration < 800; iteration += 1) {
    let interceptGradient = 0;
    const gradient = Array(weights.length).fill(0);
    for (let rowIndex = 0; rowIndex < x.length; rowIndex += 1) {
      const probability = sigmoid(intercept + x[rowIndex].reduce((sum, value, index) => sum + value * weights[index], 0));
      const error = probability - y[rowIndex];
      interceptGradient += error;
      x[rowIndex].forEach((value, index) => { gradient[index] += error * value; });
    }
    intercept -= 0.05 * interceptGradient / x.length;
    weights.forEach((value, index) => { weights[index] -= 0.05 * (gradient[index] / x.length + value); });
  }
  const positive = training.filter(row => row.netPnl18 > 0);
  const negative = training.filter(row => row.netPnl18 <= 0);
  const conditional = {
    positive18: mean(positive.map(row => row.netReturn18Bps)) ?? 0,
    negative18: mean(negative.map(row => row.netReturn18Bps)) ?? 0,
    positive27: mean(positive.map(row => row.netReturn27Bps)) ?? 0,
    negative27: mean(negative.map(row => row.netReturn27Bps)) ?? 0,
    positive36: mean(positive.map(row => row.netReturn36Bps)) ?? 0,
    negative36: mean(negative.map(row => row.netReturn36Bps)) ?? 0
  };
  const trainExpected = training.map(row => {
    const p = sigmoid(intercept + scaler.transform([row.features])[0].reduce((sum, value, index) => sum + value * weights[index], 0));
    return p * conditional.positive18 + (1 - p) * conditional.negative18;
  });
  const residualSe = std(training.map((row, index) => row.netReturn18Bps - trainExpected[index])) ?? 0;
  return {
    predict(row) {
      const transformed = scaler.transform([row.features])[0];
      const pPositive = sigmoid(intercept + transformed.reduce((sum, value, index) => sum + value * weights[index], 0));
      const expected18 = pPositive * conditional.positive18 + (1 - pPositive) * conditional.negative18;
      const expected27 = pPositive * conditional.positive27 + (1 - pPositive) * conditional.negative27;
      const expected36 = pPositive * conditional.positive36 + (1 - pPositive) * conditional.negative36;
      return {
        pPositive,
        expectedNet18Bps: expected18,
        expectedNet27Bps: expected27,
        expectedNet36Bps: expected36,
        conservativeNet18Bps: expected18 - 1.96 * residualSe,
        conservativeNet27Bps: expected27 - 1.96 * residualSe,
        conservativeNet36Bps: expected36 - 1.96 * residualSe,
        trainingResidualSeBps: residualSe
      };
    },
    trainingCount: training.length,
    conditional
  };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
}

function bestMedianSplit(training, residual, indexes) {
  let best = null;
  for (let feature = 0; feature < training[0].features.length; feature += 1) {
    const threshold = median(indexes.map(index => training[index].features[feature]));
    if (!Number.isFinite(threshold)) continue;
    const left = indexes.filter(index => training[index].features[feature] <= threshold);
    const right = indexes.filter(index => training[index].features[feature] > threshold);
    if (left.length < 20 || right.length < 20) continue;
    const leftMean = mean(left.map(index => residual[index])) || 0;
    const rightMean = mean(right.map(index => residual[index])) || 0;
    const error = left.reduce((sum, index) => sum + (residual[index] - leftMean) ** 2, 0)
      + right.reduce((sum, index) => sum + (residual[index] - rightMean) ** 2, 0);
    if (!best || error < best.error) best = { feature, threshold, left, right, leftMean, rightMean, error };
  }
  return best;
}

function fitShallowGbt(training) {
  const base = mean(training.map(row => row.netReturn18Bps)) || 0;
  const current = Array(training.length).fill(base);
  const trees = [];
  const allIndexes = training.map((_, index) => index);
  for (let iteration = 0; iteration < 50; iteration += 1) {
    const residual = training.map((row, index) => row.netReturn18Bps - current[index]);
    const root = bestMedianSplit(training, residual, allIndexes);
    if (!root) break;
    const leftChild = bestMedianSplit(training, residual, root.left);
    const rightChild = bestMedianSplit(training, residual, root.right);
    const tree = { rootFeature: root.feature, rootThreshold: root.threshold, leftChild, rightChild };
    const predictTree = row => {
      const child = row.features[root.feature] <= root.threshold ? leftChild : rightChild;
      if (!child) return row.features[root.feature] <= root.threshold ? root.leftMean : root.rightMean;
      const side = row.features[root.feature] <= root.threshold ? 'left' : 'right';
      return row.features[child.feature] <= child.threshold ? child.leftMean : child.rightMean;
    };
    trees.push({ tree, predictTree });
    current.forEach((value, index) => { current[index] = value + 0.05 * predictTree(training[index]); });
  }
  return {
    name: 'SHALLOW_GBT',
    estimators: 50,
    maxDepth: 2,
    learningRate: 0.05,
    minSamplesLeaf: 20,
    randomSeed: 300030,
    predict(row) {
      return base + trees.reduce((sum, item) => sum + 0.05 * item.predictTree(row), 0);
    },
    fittedTrees: trees.length
  };
}

function gradePrediction(prediction) {
  if (prediction.pPositive >= 0.65 && prediction.conservativeNet36Bps > 0) return 'A+';
  if (prediction.pPositive >= 0.55 && prediction.conservativeNet27Bps > 0) return 'A';
  if (prediction.conservativeNet18Bps > 0) return 'B';
  return 'REJECT';
}

export function runWalkForward(outcomes) {
  const resolved = outcomes.filter(row => row.outcomeStatus === 'RESOLVED');
  if (!resolved.length) return { predictions: [], accepted: [], status: 'NOT_READY', reason: 'NO_RESOLVED_OUTCOMES' };
  const firstTime = resolved[0].decisionTime;
  const lastTime = resolved.at(-1).decisionTime;
  const predictions = [];
  for (let validationStart = firstTime + 180 * 86400000; validationStart < lastTime; validationStart += 30 * 86400000) {
    const validationEnd = validationStart + 30 * 86400000;
    const trainingEnd = validationStart - 48 * HOUR;
    const training = resolved.filter(row => row.decisionTime < trainingEnd);
    const validation = resolved.filter(row => row.decisionTime >= validationStart && row.decisionTime < validationEnd && row.decisionTime >= validationStart + 24 * HOUR);
    if (training.length < 150 || !validation.length) continue;
    const model = fitRidgeLogistic(training);
    const gbt = fitShallowGbt(training);
    for (const row of validation) {
      const prediction = model.predict(row);
      predictions.push({
        ...row,
        prediction,
        scorecardScore: row.features.slice(0, 18).filter(value => value > 0).length,
        gbtExpectedNet18Bps: gbt.predict(row),
        grade: gradePrediction(prediction),
        validationBlockStart: iso(validationStart),
        trainingCount: training.length,
        gbtFittedTrees: gbt.fittedTrees
      });
    }
  }
  const accepted = predictions.filter(row => row.grade === 'A+' || row.grade === 'A');
  return {
    predictions,
    accepted,
    status: predictions.length >= 150 && accepted.length >= 60 ? 'OOF_READY' : 'NOT_READY',
    reason: predictions.length >= 150 && accepted.length >= 60 ? null : 'OOF_OR_ACCEPTED_GATE_FAILED'
  };
}

function netMetrics(rows, field) {
  const values = rows.map(row => row[field]);
  if (!values.length) return { count: 0, expectancyBps: null, profitFactor: null, positiveRate: null };
  const gains = values.filter(value => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(values.filter(value => value < 0).reduce((sum, value) => sum + value, 0));
  return {
    count: values.length,
    expectancyBps: mean(values),
    profitFactor: losses ? gains / losses : gains > 0 ? Infinity : null,
    positiveRate: values.filter(value => value > 0).length / values.length
  };
}

function lossStreak(rows, field) {
  let current = 0;
  let maximum = 0;
  for (const row of [...rows].sort((a, b) => a.exitTime - b.exitTime)) {
    current = row[field] < 0 ? current + 1 : 0;
    maximum = Math.max(maximum, current);
  }
  return maximum;
}

function robustness(rows, field) {
  const total = rows.reduce((sum, row) => sum + row[field], 0);
  const bestTrade = rows.length ? Math.max(...rows.map(row => row[field])) : null;
  const monthTotals = new Map();
  for (const row of rows) {
    const month = new Date(row.exitTime).toISOString().slice(0, 7);
    monthTotals.set(month, (monthTotals.get(month) || 0) + row[field]);
  }
  const bestMonthValue = monthTotals.size ? Math.max(...monthTotals.values()) : null;
  return {
    netPnl: total,
    bestTradeNetPnl: bestTrade,
    netPnlWithoutBestTrade: bestTrade === null ? null : total - bestTrade,
    activeMonths: monthTotals.size,
    bestMonthNetPnl: bestMonthValue,
    netPnlWithoutBestMonth: bestMonthValue === null ? null : total - bestMonthValue,
    monthlyNetPnl: Object.fromEntries([...monthTotals.entries()].sort())
  };
}

function countPositiveStreak(rows, field) {
  return lossStreak(rows, field);
}

async function buildPortfolioMetrics(accepted, series, manifest) {
  if (!accepted.length) return {
    status: 'EMPTY_SAMPLE_NOT_EVALUABLE',
    equity: [],
    portfolioMtmDrawdownFraction: null,
    portfolioMtmStatus: 'EMPTY_SAMPLE_NOT_EVALUABLE',
    portfolioCvar95: null,
    portfolioCvarStatus: 'EMPTY_SAMPLE_NOT_EVALUABLE',
    maxLossStreak: null
  };
  const equityMarks = new Map();
  for (const symbol of FIXED_SYMBOLS) {
    const trades = accepted.filter(row => row.symbol === symbol);
    if (!trades.length) continue;
    const loaded = await loadStream(symbol, 'mark5m', '5m');
    manifest.push(...loaded.files.map(file => ({ symbol, stream: 'mark5m', ...file })));
    const windows = loaded.rows.filter(mark => trades.some(trade => mark.openTime >= trade.entryTime && mark.openTime <= trade.exitTime));
    equityMarks.set(symbol, windows);
  }
  const timestamps = [...new Set([...equityMarks.values()].flat().map(row => row.openTime))].sort((a, b) => a - b);
  const equity = timestamps.map(timestamp => {
    let value = 100000;
    for (const trade of accepted) {
      const mark = equityMarks.get(trade.symbol)?.find(row => row.openTime === timestamp);
      if (timestamp < trade.entryTime) continue;
      if (timestamp >= trade.exitTime) {
        value += trade.netPnl18;
      } else if (mark) {
        value += trade.side === 'BUY'
          ? (mark.close - trade.entryPrice) * trade.quantity
          : (trade.entryPrice - mark.close) * trade.quantity;
      }
    }
    return { timestamp, equity: value };
  });
  let peak = 100000;
  let maxDrawdown = 0;
  for (const point of equity) {
    peak = Math.max(peak, point.equity);
    maxDrawdown = Math.max(maxDrawdown, peak ? (peak - point.equity) / peak : 0);
  }
  const daily = [];
  for (let day = WINDOW_START; day < WINDOW_END; day += 86400000) {
    const latest = equity.filter(point => point.timestamp < day + 86400000).at(-1)?.equity ?? 100000;
    daily.push(latest);
  }
  const returns = daily.slice(1).map((value, index) => value / daily[index] - 1).filter(Number.isFinite).sort((a, b) => a - b);
  const tailStart = Math.max(0, Math.floor(returns.length * 0.05));
  const cvar = returns.length < 60 ? null : mean(returns.slice(0, Math.max(1, tailStart)));
  return {
    status: returns.length < 60 ? 'INSUFFICIENT_OBSERVATIONS' : 'RECONSTRUCTED',
    equity,
    dailyObservations: returns.length,
    portfolioMtmDrawdownFraction: maxDrawdown,
    portfolioMtmStatus: 'RECONSTRUCTED',
    portfolioCvar95: cvar,
    portfolioCvarStatus: returns.length < 60 ? 'INSUFFICIENT_OBSERVATIONS' : 'RECONSTRUCTED'
  };
}

function deterministicRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function bootstrap(rows, field) {
  if (!rows.length) return { status: 'EMPTY_SAMPLE_NOT_EVALUABLE' };
  const byDay = new Map();
  for (const row of rows) {
    const day = Math.floor(row.exitTime / 86400000);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(row[field]);
  }
  const days = [...byDay.keys()].sort((a, b) => a - b);
  if (days.length < 2) return { status: 'INSUFFICIENT_BLOCKS' };
  const random = deterministicRandom(300030);
  const values = [];
  for (let iteration = 0; iteration < 5000; iteration += 1) {
    const sampled = [];
    while (sampled.length < days.length) {
      const start = days[Math.floor(random() * days.length)];
      for (let offset = 0; offset < 7 && sampled.length < days.length; offset += 1) {
        sampled.push(...(byDay.get(start + offset) || []));
      }
    }
    values.push(mean(sampled));
  }
  values.sort((a, b) => a - b);
  return {
    status: 'COMPUTED',
    iterations: 5000,
    blockDays: 7,
    seed: 300030,
    confidence: 0.95,
    lower: values[Math.floor(values.length * 0.025)],
    upper: values[Math.floor(values.length * 0.975)]
  };
}

function calibration(predictions) {
  if (!predictions.length) return { status: 'EMPTY_SAMPLE_NOT_EVALUABLE' };
  const buckets = Array.from({ length: 5 }, (_, index) => ({ bucket: index, count: 0, predicted: 0, realized: 0 }));
  let brier = 0;
  for (const row of predictions) {
    const p = row.prediction.pPositive;
    const y = row.netPnl18 > 0 ? 1 : 0;
    brier += (p - y) ** 2;
    const bucket = buckets[Math.min(4, Math.floor(p * 5))];
    bucket.count += 1;
    bucket.predicted += p;
    bucket.realized += y;
  }
  const ranked = [...predictions].sort((a, b) => a.prediction.pPositive - b.prediction.pPositive);
  const ranks = new Map(ranked.map((row, index) => [row.signalOpenTime + row.symbol, index + 1]));
  const outcomeRanks = [...predictions].sort((a, b) => a.netPnl18 - b.netPnl18);
  const outcomeRank = new Map(outcomeRanks.map((row, index) => [row.signalOpenTime + row.symbol, index + 1]));
  const n = predictions.length;
  const rankDiff = predictions.reduce((sum, row) => sum + (ranks.get(row.signalOpenTime + row.symbol) - outcomeRank.get(row.signalOpenTime + row.symbol)) ** 2, 0);
  return {
    status: 'COMPUTED_OOF_ONLY',
    brierScore: brier / n,
    buckets: buckets.map(bucket => ({ ...bucket, predicted: bucket.count ? bucket.predicted / bucket.count : null, realized: bucket.count ? bucket.realized / bucket.count : null })),
    spearman: n > 1 ? 1 - 6 * rankDiff / (n * (n ** 2 - 1)) : null
  };
}

function aggregateModelComparison(rows) {
  const all = {
    NO_FILTER: rows,
    RULE_SCORECARD: rows.filter(row => row.scorecardScore >= 10),
    SHALLOW_GBT: rows.filter(row => row.gbtExpectedNet18Bps > 0)
  };
  return Object.fromEntries(Object.entries(all).map(([name, values]) => [name, {
    diagnosticOnly: name !== 'NO_FILTER',
    sample: values.length,
    net18: netMetrics(values, 'netReturn18Bps'),
    net27: netMetrics(values, 'netReturn27Bps'),
    net36: netMetrics(values, 'netReturn36Bps')
  }]));
}

export async function runDevelopment() {
  const audit = await runAudit();
  if (!audit.artifact.gate.pass) return { status: 'DATASET_INSUFFICIENT', audit: audit.artifact };
  const core = await loadCoreData({ include5m: false });
  const candidate = buildCandidates(core.series);
  writeJson(path.join(ARTIFACT_ROOT, 'candidate-feature-snapshot.json'), candidate.candidates);
  writeJson(path.join(ARTIFACT_ROOT, 'sideways-context.json'), candidate.contexts);
  const manifest = [...core.manifest];
  const outcomes = await resolveOutcomes(core.series, candidate.candidates, manifest);
  const outcomeRows = outcomes.filter(row => row.outcomeStatus === 'RESOLVED');
  const walkForward = runWalkForward(outcomeRows);
  const accepted = walkForward.accepted;
  const portfolio = await buildPortfolioMetrics(accepted, core.series, manifest);
  const manifestKeys = new Set(manifest.map(file => `${file.symbol}:${file.stream}:${file.period}:${file.url}`));
  for (const file of audit.core.manifest.filter(item => item.stream === 'mark5m')) {
    const key = `${file.symbol}:${file.stream}:${file.period}:${file.url}`;
    if (!manifestKeys.has(key)) {
      manifest.push(file);
      manifestKeys.add(key);
    }
  }
  const primaryMetrics = Object.fromEntries([['18', 'netReturn18Bps'], ['27', 'netReturn27Bps'], ['36', 'netReturn36Bps']].map(([key, field]) => [key, netMetrics(accepted, field)]));
  const robustnessMetrics = robustness(accepted, 'netPnl18');
  const buy = accepted.filter(row => row.side === 'BUY');
  const sell = accepted.filter(row => row.side === 'SELL');
  const result = {
    schemaVersion: 1,
    artifactType: 'HY_EXP_0030_DEVELOPMENT_RESULT',
    immutable: true,
    experimentId: HY_EXP_0030,
    preregistration: { path: 'registry/experiments/HY-EXP-0030/preregistration.json', status: 'PREREGISTERED' },
    window: { start: iso(WINDOW_START), endExclusive: iso(WINDOW_END), calendarDays: 729 },
    sourceBoundary: { outcomeRead: true, pnlComputed: true, finalOosRead: false, finalOosExperimentCreated: false },
    counts: {
      rawCandidates: candidate.counts.raw,
      labeledCandidates: outcomeRows.length,
      invalidCandidates: outcomes.length - outcomeRows.length,
      oofPredictions: walkForward.predictions.length,
      accepted: accepted.length,
      grades: Object.fromEntries(['A+', 'A', 'B', 'REJECT'].map(grade => [grade, walkForward.predictions.filter(row => row.grade === grade).length]))
    },
    primaryModel: {
      name: 'RIDGE_LOGISTIC_CONDITIONAL_RETURN_EDGE',
      status: walkForward.status,
      metrics: primaryMetrics,
      robustness: robustnessMetrics,
      lossStreak: lossStreak(accepted, 'netPnl18'),
      BUY: { accepted: buy.length, net27ExpectancyBps: netMetrics(buy, 'netReturn27Bps').expectancyBps },
      SELL: { accepted: sell.length, net27ExpectancyBps: netMetrics(sell, 'netReturn27Bps').expectancyBps }
    },
    outcomeBreakdown: {
      gross: netMetrics(walkForward.predictions, 'grossReturnBps'),
      net18: netMetrics(walkForward.predictions, 'netReturn18Bps'),
      net27: netMetrics(walkForward.predictions, 'netReturn27Bps'),
      net36: netMetrics(walkForward.predictions, 'netReturn36Bps'),
      fundingPnl: walkForward.predictions.reduce((sum, row) => sum + row.fundingPnl, 0),
      exitReasons: Object.fromEntries([...new Set(walkForward.predictions.map(row => row.exitReason))].sort().map(reason => [reason, walkForward.predictions.filter(row => row.exitReason === reason).length]))
    },
    portfolioRisk: portfolio,
    bootstrap: bootstrap(accepted, 'netReturn27Bps'),
    calibration: calibration(walkForward.predictions),
    modelComparison: aggregateModelComparison(walkForward.predictions),
    symbolBreadth: {
      distinctSymbols: new Set(accepted.map(row => row.symbol)).size,
      largestSymbolShare: accepted.length ? Math.max(...FIXED_SYMBOLS.map(symbol => accepted.filter(row => row.symbol === symbol).length)) / accepted.length : null,
      bySymbol: Object.fromEntries(FIXED_SYMBOLS.map(symbol => [symbol, accepted.filter(row => row.symbol === symbol).length]))
    },
    activeMonths: [...new Set(accepted.map(row => new Date(row.exitTime).toISOString().slice(0, 7)))].sort(),
    gates: {
      dataset: audit.artifact.gate,
      promotion: {
        calendarCoverage: 729 >= 365,
        oofPredictions: walkForward.predictions.length >= 150,
        accepted: accepted.length >= 60,
        net18Expectancy: primaryMetrics['18'].expectancyBps >= 8,
        PF18: primaryMetrics['18'].profitFactor >= 1.25,
        net27Expectancy: primaryMetrics['27'].expectancyBps >= 2,
        PF27: primaryMetrics['27'].profitFactor >= 1.1,
        net36Expectancy: primaryMetrics['36'].expectancyBps > 0,
        portfolioMtm: portfolio.portfolioMtmDrawdownFraction !== null && portfolio.portfolioMtmDrawdownFraction <= 0.08,
        portfolioCvar: portfolio.portfolioCvarStatus === 'RECONSTRUCTED',
        lossStreak: lossStreak(accepted, 'netPnl18') <= 6,
        withoutBestTrade: robustnessMetrics.netPnlWithoutBestTrade > 0,
        withoutBestMonth: robustnessMetrics.netPnlWithoutBestMonth > 0,
        symbols: new Set(accepted.map(row => row.symbol)).size >= 6,
        symbolConcentration: accepted.length ? Math.max(...FIXED_SYMBOLS.map(symbol => accepted.filter(row => row.symbol === symbol).length)) / accepted.length <= 0.3 : false,
        buyAccepted: buy.length >= 20,
        sellAccepted: sell.length >= 20,
        buyNet27: netMetrics(buy, 'netReturn27Bps').expectancyBps > 0,
        sellNet27: netMetrics(sell, 'netReturn27Bps').expectancyBps > 0,
        activeMonths: new Set(accepted.map(row => new Date(row.exitTime).toISOString().slice(0, 7))).size >= 6,
        bootstrapNet27: bootstrap(accepted, 'netReturn27Bps').lower > 0
      }
    },
    status: 'NOT_READY'
  };
  const gates = Object.values(result.gates.promotion);
  result.status = gates.every(Boolean) ? 'DEVELOPMENT_PASS' : result.bootstrap.lower <= 0 ? 'EDGE_UNCERTAIN' : 'NOT_READY';
  result.promotionEligible = result.status === 'DEVELOPMENT_PASS';
  writeJson(path.join(ARTIFACT_ROOT, 'development-result.json'), result);
  writeJson(path.join(ARTIFACT_ROOT, 'oof-predictions.json'), walkForward.predictions);
  fs.writeFileSync(path.join(ARTIFACT_ROOT, 'trades.jsonl'), `${outcomes.filter(row => row.outcomeStatus === 'RESOLVED').map(row => JSON.stringify(row)).join('\n')}\n`);
  writeJson(path.join(ARTIFACT_ROOT, 'data-manifest.json'), {
    schemaVersion: 1,
    experimentId: HY_EXP_0030,
    window: { start: iso(WINDOW_START), endExclusive: iso(WINDOW_END) },
    generatedAt: new Date().toISOString(),
    files: manifest,
    loadErrors: core.errors,
    rawFilesAreLocalCacheOnly: true,
    outcomeRead: true,
    pnlComputed: true,
    finalOosRead: false
  });
  return { status: result.status, audit: audit.artifact, result };
}

export { ROOT, sha256, iso, writeJson, loadStream, summarizeCoverage, mapByTime, netMetrics, robustness, lossStreak };
