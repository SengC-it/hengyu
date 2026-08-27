import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  assertContiguous,
  mergeUniqueSeries,
  parseFundingArchive,
  parseKlineArchive,
  FIVE_MINUTES
} from './archive.mjs';

export const HY_EXP_0037 = 'HY-EXP-0037';
export const BASE_MAIN_COMMIT = '2deca14b0a2a5a503183a86d14975fea7ebf8c93';
export const SOURCE_MANIFEST_PATH = 'artifacts/HY-EXP-0034/data-manifest.json';
export const SOURCE_MANIFEST_SHA256 = 'f4e3ebfeb147b051f600e2f7edad8624a45b55322e7dda5a0de7f3c180a7c212';
export const DEVELOPMENT_START = Date.parse('2024-08-26T00:00:00Z');
export const DEVELOPMENT_END = Date.parse('2025-08-26T00:00:00Z');
export const VALIDATION_START = DEVELOPMENT_END;
export const VALIDATION_END = Date.parse('2026-08-26T00:00:00Z');
export const HOUR = 60 * 60 * 1000;
export const FOUR_HOURS = 4 * HOUR;
export const DAY = 24 * HOUR;
export const FIFTEEN_MINUTES = 15 * 60 * 1000;
export const MAX_HOLD_MS = 12 * HOUR;
export const FIXED_SYMBOLS = Object.freeze([
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT',
  'XRPUSDT', 'DOGEUSDT', 'LINKUSDT', 'LTCUSDT'
]);
export const COSTS_BPS = Object.freeze({ 18: 18, 27: 27, 36: 36 });
export const MODEL_LAMBDAS = Object.freeze([0.1, 1, 10]);
export const FEATURE_NAMES = Object.freeze([
  'sideAlignedReturn15m',
  'sideAlignedReturn1h',
  'sideAlignedReturn4h',
  'sideAlignedReturn24h',
  'trendStrength1h',
  'trendStrength4h',
  'emaDistance',
  'emaSlope',
  'atrPercent',
  'realizedVolatility1h',
  'realizedVolatility4h',
  'volumeTurnoverZScore',
  'channelPosition',
  'currentFundingRate',
  'fundingZScore',
  'markContractBasisBps',
  'crossSectional4hMomentumRank',
  'crossSectional24hMomentumRank',
  'btcRegimeReturn',
  'btcRegimeVolatility',
  'sideSign'
]);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CACHE = new Map();

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

export function iso(value) {
  return new Date(value).toISOString();
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function finite(value) {
  return Number.isFinite(value);
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function sampleStd(values, average = mean(values)) {
  if (values.length < 2 || average == null) return null;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

function quantile(values, probability) {
  if (!values.length) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function lowerBound(rows, time, field = 'openTime') {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (rows[middle][field] < time) low = middle + 1;
    else high = middle;
  }
  return low;
}

function mapByTime(rows, field = 'openTime') {
  return new Map(rows.map((row, index) => [row[field], index]));
}

function parseRecoveredMark(buffer, symbol) {
  const values = JSON.parse(buffer.toString('utf8'));
  if (!Array.isArray(values)) throw new Error(`${symbol}/mark recovery is not an array`);
  return values.map((value, index) => {
    if (!Array.isArray(value) || value.length < 7) throw new Error(`${symbol}/mark recovery row ${index} malformed`);
    const row = {
      symbol,
      openTime: Number(value[0]),
      open: Number(value[1]),
      high: Number(value[2]),
      low: Number(value[3]),
      close: Number(value[4]),
      volume: Number(value[5] ?? 0),
      closeTime: Number(value[6]),
      quoteVolume: Number(value[7] ?? 0),
      trades: Number(value[8] ?? 0),
      takerBuyVolume: Number(value[9] ?? 0),
      takerBuyQuoteVolume: Number(value[10] ?? 0)
    };
    validateMarketRow(row, `${symbol}/mark-recovery/${index}`, false);
    return row;
  });
}

function validateMarketRow(row, label, requireActivity = true) {
  for (const field of ['openTime', 'closeTime', 'open', 'high', 'low', 'close']) {
    if (!finite(row[field])) throw new Error(`${label}:NON_FINITE_${field}`);
  }
  if (row.open <= 0 || row.high < row.low || row.high < Math.max(row.open, row.close)
    || row.low > Math.min(row.open, row.close)) throw new Error(`${label}:INVALID_OHLC`);
  if (row.closeTime !== row.openTime + FIVE_MINUTES - 1) throw new Error(`${label}:BAD_BOUNDARY`);
  if (requireActivity) {
    for (const field of ['volume', 'quoteVolume', 'trades', 'takerBuyVolume', 'takerBuyQuoteVolume']) {
      if (!finite(row[field]) || row[field] < 0) throw new Error(`${label}:INVALID_${field}`);
    }
  }
}

function readFundingRest(buffer, symbol) {
  const values = JSON.parse(buffer.toString('utf8'));
  if (!Array.isArray(values)) throw new Error(`${symbol}/funding REST is not an array`);
  return values.map((value, index) => {
    const fundingTime = Number(value.fundingTime);
    const fundingRate = Number(value.fundingRate);
    if (!finite(fundingTime) || !finite(fundingRate)) throw new Error(`${symbol}/funding REST row ${index}:NON_FINITE`);
    return {
      symbol,
      archiveTime: fundingTime,
      eventTime: Math.floor(fundingTime / FIVE_MINUTES) * FIVE_MINUTES,
      fundingIntervalHours: 8,
      fundingRate
    };
  });
}

function resolveSourcePath(root, item) {
  const file = path.resolve(root, item.path);
  const relative = path.relative(root, file);
  const dataRoot = path.resolve(root, '..', 'data');
  const dataRelative = path.relative(dataRoot, file);
  const insideProject = !relative.startsWith('..') && !path.isAbsolute(relative);
  const insideLockedData = !dataRelative.startsWith('..') && !path.isAbsolute(dataRelative);
  if (!insideProject && !insideLockedData) throw new Error(`source path escapes allowed roots: ${item.path}`);
  return file;
}

export function loadSourceManifest({ root = ROOT } = {}) {
  const file = path.resolve(root, SOURCE_MANIFEST_PATH);
  if (!fs.existsSync(file)) throw new Error('SOURCE_MANIFEST_MISSING');
  const bytes = fs.readFileSync(file);
  if (sha256(bytes) !== SOURCE_MANIFEST_SHA256) throw new Error('SOURCE_MANIFEST_HASH_MISMATCH');
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (manifest.experimentId !== 'HY-EXP-0034') throw new Error('SOURCE_MANIFEST_EXPERIMENT_MISMATCH');
  if (manifest.missingCount !== 0 || manifest.coverageStatus !== 'PASS_FIXED_EIGHT_SOURCE_SUBSET') {
    throw new Error('SOURCE_MANIFEST_NOT_COMPLETE');
  }
  if (manifest.outcomeRead !== false || manifest.pnlComputed !== false || manifest.finalOosRead !== false) {
    throw new Error('SOURCE_MANIFEST_NOT_PRE_OUTCOME_CLEAN');
  }
  if (JSON.stringify(manifest.symbols) !== JSON.stringify(FIXED_SYMBOLS)) throw new Error('SOURCE_MANIFEST_SYMBOL_MISMATCH');
  return { manifest, file, sha256: SOURCE_MANIFEST_SHA256 };
}

export function verifySourceFiles({ root = ROOT, sourceManifest = loadSourceManifest({ root }) } = {}) {
  const { manifest } = sourceManifest;
  const failures = [];
  for (const item of manifest.files ?? []) {
    if (!item.path || !item.sha256) {
      failures.push({ item: `${item.symbol}/${item.kind}/${item.period}`, reason: 'MISSING_FILE_PROVENANCE' });
      continue;
    }
    const file = resolveSourcePath(root, item);
    if (!fs.existsSync(file)) {
      failures.push({ item: item.path, reason: 'MISSING_FILE' });
      continue;
    }
    const actual = sha256File(file);
    if (actual !== item.sha256) failures.push({ item: item.path, reason: 'HASH_MISMATCH', actual });
  }
  if (failures.length) throw new Error(`SOURCE_FILE_INTEGRITY_FAILED:${JSON.stringify(failures.slice(0, 3))}`);
  return { verifiedFiles: manifest.files.length, status: 'PASS' };
}

export function buildDataManifest({ root = ROOT, sourceManifest = loadSourceManifest({ root }) } = {}) {
  const { manifest, sha256: sourceSha } = sourceManifest;
  const verification = verifySourceFiles({ root, sourceManifest });
  return {
    schemaVersion: 1,
    artifactType: 'HY_EXP_0037_DATA_MANIFEST',
    immutable: true,
    experimentId: HY_EXP_0037,
    sourceExperiment: 'HY-EXP-0034',
    sourceManifestPath: SOURCE_MANIFEST_PATH,
    sourceManifestSha256: sourceSha,
    sourceManifestUnmodified: true,
    generatedAt: new Date().toISOString(),
    window: {
      start: iso(DEVELOPMENT_START),
      endExclusive: iso(VALIDATION_END),
      development: { start: iso(DEVELOPMENT_START), endExclusive: iso(DEVELOPMENT_END) },
      historicalValidation: { start: iso(VALIDATION_START), endExclusive: iso(VALIDATION_END) }
    },
    symbols: FIXED_SYMBOLS,
    requiredStreams: ['contract.5m', 'mark.5m', 'funding'],
    files: manifest.files.map(item => ({ ...item })),
    verifiedFiles: verification.verifiedFiles,
    missingCount: 0,
    coverageStatus: 'FULL_HASH_LOCKED_PUBLIC_COVERAGE',
    outcomeRead: false,
    pnlComputed: false,
    finalOosRead: false,
    developmentAllowed: true,
    safety: {
      publicApisOnly: true,
      privateApi: false,
      accountApi: false,
      orderApi: false,
      paperOnly: true,
      signalOnly: true,
      gmail: false,
      scheduler: false,
      realEmail: false,
      automaticTrading: false,
      finalOosRead: false
    }
  };
}

function loadRows(symbol, kind, { root = ROOT, sourceManifest } = {}) {
  const key = `${root}:${sourceManifest.sha256}:${symbol}:${kind}`;
  if (CACHE.has(key)) return CACHE.get(key);
  const items = sourceManifest.manifest.files
    .filter(item => item.symbol === symbol && item.kind === kind && item.path)
    .sort((left, right) => `${left.period}/${left.cadence}/${left.path}`.localeCompare(`${right.period}/${right.cadence}/${right.path}`));
  if (!items.length) throw new Error(`${symbol}/${kind}:NO_LOCKED_FILES`);
  const chunks = items.map(item => {
    const bytes = fs.readFileSync(resolveSourcePath(root, item));
    if (kind === 'funding' && item.cadence === 'rest') return readFundingRest(bytes, symbol);
    if (kind === 'funding') return parseFundingArchive(bytes, symbol);
    if (item.sourceSegment === 'REST_NATIVE_RECOVERY') return parseRecoveredMark(bytes, symbol);
    return parseKlineArchive(bytes, symbol, kind);
  });
  const field = kind === 'funding' ? 'eventTime' : 'openTime';
  const rows = mergeUniqueSeries(chunks, field, `${symbol}/${kind}`)
    .filter(row => row[field] >= DEVELOPMENT_START && row[field] < VALIDATION_END);
  if (kind !== 'funding') {
    assertContiguous(rows, `${symbol}/${kind}`);
    if (rows[0]?.openTime !== DEVELOPMENT_START || rows.at(-1)?.openTime !== VALIDATION_END - FIVE_MINUTES) {
      throw new Error(`${symbol}/${kind}:INCOMPLETE_WINDOW`);
    }
  }
  CACHE.set(key, rows);
  return rows;
}

function aggregateBars(rows, minutesPerBar, label) {
  const width = minutesPerBar * 60 * 1000;
  const count = minutesPerBar / 5;
  const output = [];
  for (let index = 0; index < rows.length;) {
    const bucket = Math.floor(rows[index].openTime / width) * width;
    const chunk = [];
    while (index < rows.length && Math.floor(rows[index].openTime / width) * width === bucket) chunk.push(rows[index++]);
    if (chunk.length !== count || chunk[0].openTime !== bucket
      || chunk.at(-1).openTime !== bucket + width - FIVE_MINUTES) {
      throw new Error(`${label}:INCOMPLETE_BUCKET:${iso(bucket)}`);
    }
    const row = {
      symbol: chunk[0].symbol,
      openTime: bucket,
      closeTime: bucket + width - 1,
      open: chunk[0].open,
      high: Math.max(...chunk.map(item => item.high)),
      low: Math.min(...chunk.map(item => item.low)),
      close: chunk.at(-1).close,
      volume: chunk.reduce((sum, item) => sum + item.volume, 0),
      quoteVolume: chunk.reduce((sum, item) => sum + item.quoteVolume, 0),
      trades: chunk.reduce((sum, item) => sum + item.trades, 0)
    };
    validateBar(row, label);
    output.push(row);
  }
  return output;
}

function validateBar(row, label) {
  for (const field of ['openTime', 'closeTime', 'open', 'high', 'low', 'close', 'quoteVolume']) {
    if (!finite(row[field])) throw new Error(`${label}:NON_FINITE_${field}`);
  }
  if (row.high < row.low || row.high < Math.max(row.open, row.close)
    || row.low > Math.min(row.open, row.close) || row.quoteVolume < 0) {
    throw new Error(`${label}:INVALID_BAR`);
  }
}

function assertAligned(left, right, label) {
  if (left.length !== right.length || left.some((row, index) => row.openTime !== right[index]?.openTime)) {
    throw new Error(`${label}:MISALIGNED`);
  }
}

export function buildSeries({ root = ROOT, sourceManifest = loadSourceManifest({ root }) } = {}) {
  verifySourceFiles({ root, sourceManifest });
  const series = {};
  for (const symbol of FIXED_SYMBOLS) {
    const contract5 = loadRows(symbol, 'contract', { root, sourceManifest });
    const mark5 = loadRows(symbol, 'mark', { root, sourceManifest });
    const funding = loadRows(symbol, 'funding', { root, sourceManifest });
    const contract15 = aggregateBars(contract5, 15, `${symbol}/contract15m`);
    const contract1 = aggregateBars(contract5, 60, `${symbol}/contract1h`);
    const contract4 = aggregateBars(contract5, 240, `${symbol}/contract4h`);
    const mark1 = aggregateBars(mark5, 60, `${symbol}/mark1h`);
    const mark4 = aggregateBars(mark5, 240, `${symbol}/mark4h`);
    assertAligned(contract5, mark5, `${symbol}/5m`);
    assertAligned(contract1, mark1, `${symbol}/1h`);
    assertAligned(contract4, mark4, `${symbol}/4h`);
    series[symbol] = {
      symbol,
      contract5,
      mark5,
      funding,
      contract15,
      contract1,
      contract4,
      mark1,
      mark4,
      contract5ByTime: mapByTime(contract5),
      contract15ByTime: mapByTime(contract15),
      contract1ByTime: mapByTime(contract1),
      contract4ByTime: mapByTime(contract4),
      mark5ByTime: new Map(mark5.map(row => [row.openTime, row])),
      mark1ByTime: new Map(mark1.map(row => [row.openTime, row])),
      mark4ByTime: new Map(mark4.map(row => [row.openTime, row]))
    };
  }
  const anchor = series.BTCUSDT.contract4.map(row => row.openTime);
  for (const symbol of FIXED_SYMBOLS) {
    if (JSON.stringify(series[symbol].contract4.map(row => row.openTime)) !== JSON.stringify(anchor)) {
      throw new Error(`${symbol}/4h:CROSS_SYMBOL_MISALIGNMENT`);
    }
  }
  return series;
}

function logReturn(rows, index, lookback = 1, field = 'close') {
  if (index < lookback) return null;
  const from = rows[index - lookback][field];
  const to = rows[index][field];
  if (!(from > 0) || !(to > 0)) return null;
  return Math.log(to / from);
}

function emaSeries(rows, period) {
  const output = Array(rows.length).fill(null);
  let value = null;
  const alpha = 2 / (period + 1);
  for (let index = 0; index < rows.length; index += 1) {
    value = value == null ? rows[index].close : alpha * rows[index].close + (1 - alpha) * value;
    output[index] = value;
  }
  return output;
}

function atr(rows, index, period) {
  if (index < period) return null;
  const ranges = [];
  for (let cursor = index - period + 1; cursor <= index; cursor += 1) {
    const previous = rows[cursor - 1].close;
    ranges.push(Math.max(rows[cursor].high - rows[cursor].low,
      Math.abs(rows[cursor].high - previous), Math.abs(rows[cursor].low - previous)));
  }
  return mean(ranges);
}

function returns(rows, index, count) {
  const values = [];
  for (let cursor = Math.max(1, index - count + 1); cursor <= index; cursor += 1) {
    const value = logReturn(rows, cursor);
    if (value == null) return null;
    values.push(value);
  }
  return values;
}

function lastCompletedIndex(rows, decisionTime) {
  const index = lowerBound(rows, decisionTime) - 1;
  return index >= 0 && rows[index].closeTime < decisionTime ? index : -1;
}

function fundingAt(rows, decisionTime) {
  const index = lowerBound(rows, decisionTime, 'eventTime') - 1;
  if (index < 0) return null;
  const current = rows[index];
  const prior = [];
  for (let cursor = index - 1; cursor >= 0 && rows[cursor].eventTime >= current.eventTime - 30 * DAY; cursor -= 1) {
    prior.push(rows[cursor]);
  }
  const priorRates = prior.map(row => row.fundingRate);
  const standardDeviation = sampleStd(priorRates);
  return {
    current,
    zScore: standardDeviation > 0 ? (current.fundingRate - mean(priorRates)) / standardDeviation : 0,
    priorCount: prior.length
  };
}

function regimeAt(series, fourHourTime) {
  if (series.__regimeByTime?.has(fourHourTime)) return series.__regimeByTime.get(fourHourTime);
  const rows = FIXED_SYMBOLS.map(symbol => {
    const symbolRows = series[symbol].contract4;
    const index = series[symbol].contract4ByTime.get(fourHourTime);
    if (index == null || index < 179) return null;
    const close = symbolRows[index].close;
    const slow = mean(symbolRows.slice(index - 179, index + 1).map(row => row.close));
    return { symbol, index, close, slow };
  });
  if (rows.some(row => row == null)) {
    series.__regimeByTime ??= new Map();
    series.__regimeByTime.set(fourHourTime, null);
    return null;
  }
  const btc = rows.find(row => row.symbol === 'BTCUSDT');
  const bullBreadth = rows.filter(row => row.close > row.slow).length / rows.length;
  const bearBreadth = rows.filter(row => row.close < row.slow).length / rows.length;
  const result = btc.close > btc.slow && bullBreadth >= 0.625
    ? { name: 'BULL', breadth: bullBreadth, rows }
    : btc.close < btc.slow && bearBreadth >= 0.625
      ? { name: 'BEAR', breadth: bearBreadth, rows }
      : { name: 'SIDEWAYS', breadth: Math.max(bullBreadth, bearBreadth), rows };
  series.__regimeByTime ??= new Map();
  series.__regimeByTime.set(fourHourTime, result);
  return result;
}

function directionalRank(values, symbol, side) {
  const ordered = values.slice().sort((left, right) => left.value - right.value || left.symbol.localeCompare(right.symbol));
  const index = ordered.findIndex(row => row.symbol === symbol);
  if (index < 0 || ordered.length < 2) return null;
  const rank = index / (ordered.length - 1);
  return side === 'BUY' ? rank : 1 - rank;
}

function crossSectionalRank(series, time, symbol, side, lookback) {
  const values = [];
  for (const candidateSymbol of FIXED_SYMBOLS) {
    const rows = series[candidateSymbol].contract4;
    const index = series[candidateSymbol].contract4ByTime.get(time);
    const value = index == null ? null : logReturn(rows, index, lookback);
    if (value == null) return null;
    values.push({ symbol: candidateSymbol, value });
  }
  return directionalRank(values, symbol, side);
}

function featureSnapshot(candidate, series) {
  const s = series[candidate.symbol];
  const oneIndex = candidate.contract1Index;
  const fourIndex = candidate.contract4Index;
  const fifteenIndex = candidate.contract15Index;
  const sideSign = candidate.side === 'BUY' ? 1 : -1;
  const one = s.contract1[oneIndex];
  const four = s.contract4[fourIndex];
  const previousOne = s.contract1.slice(Math.max(0, oneIndex - 24), oneIndex);
  const channel = s.contract1.slice(oneIndex - 120, oneIndex);
  const oneReturns = returns(s.contract1, oneIndex, 24);
  const fourReturns = returns(s.contract4, fourIndex, 20);
  const atr20 = atr(s.contract1, oneIndex, 20);
  const ema20 = s.ema20 ??= emaSeries(s.contract1, 20);
  const funding = fundingAt(s.funding, candidate.decisionTime);
  const btcRows = series.BTCUSDT.contract4;
  const btcIndex = series.BTCUSDT.contract4ByTime.get(four.openTime);
  const btcReturn = btcIndex == null ? null : logReturn(btcRows, btcIndex, 6);
  const btcReturns = btcIndex == null ? null : returns(btcRows, btcIndex, 20);
  const channelHigh = channel.length ? Math.max(...channel.map(row => row.high)) : null;
  const channelLow = channel.length ? Math.min(...channel.map(row => row.low)) : null;
  const volumePrior = previousOne.map(row => row.quoteVolume);
  const volumeMean = mean(volumePrior);
  const volumeStd = sampleStd(volumePrior, volumeMean);
  const markOne = s.mark1ByTime.get(one.openTime);
  const values = [
    sideSign * (logReturn(s.contract15, fifteenIndex, 1) ?? NaN),
    sideSign * (logReturn(s.contract1, oneIndex, 1) ?? NaN),
    sideSign * (logReturn(s.contract4, fourIndex, 1) ?? NaN),
    sideSign * (logReturn(s.contract15, fifteenIndex, 96) ?? NaN),
    sideSign * (logReturn(s.contract1, oneIndex, 24) ?? NaN),
    sideSign * (logReturn(s.contract4, fourIndex, 30) ?? NaN),
    ema20[oneIndex] > 0 ? sideSign * (one.close - ema20[oneIndex]) / ema20[oneIndex] : null,
    oneIndex >= 4 && ema20[oneIndex - 4] > 0 ? sideSign * (ema20[oneIndex] - ema20[oneIndex - 4]) / ema20[oneIndex - 4] : null,
    atr20 != null && one.close > 0 ? atr20 / one.close : null,
    oneReturns ? sampleStd(oneReturns) * Math.sqrt(24) : null,
    fourReturns ? sampleStd(fourReturns) * Math.sqrt(20) : null,
    volumeStd > 0 ? (one.quoteVolume - volumeMean) / volumeStd : 0,
    channelHigh != null && channelHigh > channelLow
      ? candidate.side === 'BUY' ? (one.close - channelLow) / (channelHigh - channelLow) : (channelHigh - one.close) / (channelHigh - channelLow)
      : null,
    funding?.current.fundingRate ?? null,
    funding?.zScore ?? null,
    markOne && markOne.close > 0 ? 10_000 * (one.close - markOne.close) / markOne.close : null,
    crossSectionalRank(series, four.openTime, candidate.symbol, candidate.side, 1),
    crossSectionalRank(series, four.openTime, candidate.symbol, candidate.side, 6),
    sideSign * (btcReturn ?? NaN),
    btcReturns ? sampleStd(btcReturns) * Math.sqrt(20) : null,
    sideSign
  ];
  if (values.some(value => !finite(value))) return null;
  return { values, atr20, breadth: candidate.regimeBreadth };
}

export function generateCandidates(series) {
  const candidates = [];
  let broadRegimeRows = 0;
  let featureInvalid = 0;
  let sidewaysContext = 0;
  for (const symbol of FIXED_SYMBOLS) {
    const s = series[symbol];
    for (let index = 96; index < s.contract15.length; index += 1) {
      const bar = s.contract15[index];
      const decisionTime = bar.closeTime + 1;
      if (decisionTime < DEVELOPMENT_START || decisionTime >= VALIDATION_END) continue;
      const oneIndex = lastCompletedIndex(s.contract1, decisionTime);
      const fourIndex = lastCompletedIndex(s.contract4, decisionTime);
      if (oneIndex < 120 || fourIndex < 179) continue;
      const regime = regimeAt(series, s.contract4[fourIndex].openTime);
      if (!regime) continue;
      if (regime.name === 'SIDEWAYS') {
        sidewaysContext += 1;
        continue;
      }
      broadRegimeRows += 1;
      const side = regime.name === 'BULL' ? 'BUY' : 'SELL';
      const entryTime = decisionTime;
      if (!s.contract5ByTime.has(entryTime)) throw new Error(`${symbol}:MISSING_EXACT_ENTRY:${iso(entryTime)}`);
      const base = {
        candidateId: `${HY_EXP_0037}:${symbol}:${side}:${decisionTime}`,
        experimentId: HY_EXP_0037,
        symbol,
        side,
        regime: regime.name,
        regimeBreadth: regime.breadth,
        signalTime: bar.openTime,
        decisionTime,
        entryTime,
        contract15Index: index,
        contract1Index: oneIndex,
        contract4Index: fourIndex
      };
      const snapshot = featureSnapshot(base, series);
      if (!snapshot) {
        featureInvalid += 1;
        continue;
      }
      candidates.push({ ...base, features: snapshot.values, atr20: snapshot.atr20 });
    }
  }
  candidates.sort((left, right) => left.decisionTime - right.decisionTime || left.symbol.localeCompare(right.symbol) || left.side.localeCompare(right.side));
  return {
    candidates,
    counts: {
      rawCandidates: candidates.length,
      BUY: candidates.filter(row => row.side === 'BUY').length,
      SELL: candidates.filter(row => row.side === 'SELL').length,
      broadRegimeRows,
      featureInvalid,
      sidewaysContext
    }
  };
}

function simulateCandidate(candidate, series) {
  const s = series[candidate.symbol];
  const entryIndex = s.contract5ByTime.get(candidate.entryTime);
  if (entryIndex == null || !(candidate.atr20 > 0)) return { ...candidate, outcomeStatus: 'INVALID', invalidReason: 'MISSING_ENTRY_OR_ATR' };
  const entry = s.contract5[entryIndex];
  const sideSign = candidate.side === 'BUY' ? 1 : -1;
  const stop = entry.open - sideSign * 1.5 * candidate.atr20;
  const target = entry.open + sideSign * 2.5 * candidate.atr20;
  let exit = null;
  for (let index = entryIndex; index < s.contract5.length && index <= entryIndex + (MAX_HOLD_MS / FIVE_MINUTES); index += 1) {
    const bar = s.contract5[index];
    if (bar.openTime >= VALIDATION_END) break;
    const stopHit = sideSign > 0 ? bar.low <= stop : bar.high >= stop;
    const targetHit = sideSign > 0 ? bar.high >= target : bar.low <= target;
    if (stopHit) {
      exit = { exitTime: bar.openTime, exitPrice: stop, exitReason: 'ATR_STOP' };
      break;
    }
    if (targetHit) {
      exit = { exitTime: bar.openTime, exitPrice: target, exitReason: 'TARGET' };
      break;
    }
    if (bar.openTime === candidate.entryTime + MAX_HOLD_MS) {
      exit = { exitTime: bar.openTime, exitPrice: bar.open, exitReason: 'MAX_HOLD' };
      break;
    }
  }
  if (!exit) return { ...candidate, outcomeStatus: 'INVALID', invalidReason: 'MISSING_FORWARD_BOUNDARY' };
  let fundingBps = 0;
  for (const funding of s.funding) {
    if (funding.eventTime < candidate.entryTime) continue;
    if (funding.eventTime >= exit.exitTime) break;
    const mark = s.mark5ByTime.get(funding.eventTime);
    if (!mark) return { ...candidate, outcomeStatus: 'INVALID', invalidReason: `MISSING_FUNDING_MARK:${funding.eventTime}` };
    fundingBps += -sideSign * mark.open / entry.open * funding.fundingRate * 10_000;
  }
  const priceBps = sideSign * (exit.exitPrice - entry.open) / entry.open * 10_000;
  const grossBps = priceBps + fundingBps;
  const output = {
    candidateId: candidate.candidateId,
    experimentId: HY_EXP_0037,
    symbol: candidate.symbol,
    side: candidate.side,
    regime: candidate.regime,
    signalTime: candidate.signalTime,
    decisionTime: candidate.decisionTime,
    entryTime: candidate.entryTime,
    entryPrice: entry.open,
    exitTime: exit.exitTime,
    exitPrice: exit.exitPrice,
    exitReason: exit.exitReason,
    atr20: candidate.atr20,
    features: candidate.features,
    grossPriceBps: priceBps,
    fundingBps,
    grossReturnBps: grossBps,
    net18Bps: grossBps - COSTS_BPS[18],
    net27Bps: grossBps - COSTS_BPS[27],
    net36Bps: grossBps - COSTS_BPS[36],
    outcomeStatus: 'RESOLVED'
  };
  return output;
}

export function resolveCandidates(candidates, series) {
  const outcomes = candidates.map(candidate => simulateCandidate(candidate, series));
  const resolved = outcomes.filter(row => row.outcomeStatus === 'RESOLVED');
  return { outcomes, resolved, invalid: outcomes.length - resolved.length };
}

function solveLinearSystem(matrix, vector) {
  const n = vector.length;
  const a = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < n; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < n; row += 1) {
      if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
    }
    if (Math.abs(a[pivot][column]) < 1e-12) a[pivot][column] = 1e-12;
    [a[column], a[pivot]] = [a[pivot], a[column]];
    const divisor = a[column][column];
    for (let cell = column; cell <= n; cell += 1) a[column][cell] /= divisor;
    for (let row = 0; row < n; row += 1) {
      if (row === column) continue;
      const factor = a[row][column];
      if (factor === 0) continue;
      for (let cell = column; cell <= n; cell += 1) a[row][cell] -= factor * a[column][cell];
    }
  }
  return a.map(row => row[n]);
}

function prepareScaler(rows) {
  const bounds = FEATURE_NAMES.map((_, index) => {
    const values = rows.map(row => row.features[index]);
    return { low: quantile(values, 0.01), high: quantile(values, 0.99) };
  });
  const means = [];
  const stds = [];
  for (let index = 0; index < FEATURE_NAMES.length; index += 1) {
    const values = rows.map(row => Math.max(bounds[index].low, Math.min(bounds[index].high, row.features[index])));
    const average = mean(values) ?? 0;
    means[index] = average;
    stds[index] = sampleStd(values, average) || 1;
  }
  return {
    bounds,
    means,
    stds,
    transform(features) {
      return features.map((value, index) => {
        const clamped = Math.max(bounds[index].low, Math.min(bounds[index].high, value));
        return (clamped - means[index]) / stds[index];
      });
    }
  };
}

export function fitRidge(training, lambda) {
  if (training.length < 150) return null;
  const scaler = prepareScaler(training);
  const dimension = FEATURE_NAMES.length + 1;
  const matrix = Array.from({ length: dimension }, () => Array(dimension).fill(0));
  const vector = Array(dimension).fill(0);
  for (const row of training) {
    const x = [1, ...scaler.transform(row.features)];
    const y = row.net27Bps;
    for (let left = 0; left < dimension; left += 1) {
      vector[left] += x[left] * y;
      for (let right = 0; right < dimension; right += 1) matrix[left][right] += x[left] * x[right];
    }
  }
  for (let index = 1; index < dimension; index += 1) matrix[index][index] += lambda * training.length;
  const coefficients = solveLinearSystem(matrix, vector);
  return {
    lambda,
    trainingCount: training.length,
    scaler,
    coefficients,
    predict(features) {
      const x = [1, ...scaler.transform(features)];
      return coefficients.reduce((sum, coefficient, index) => sum + coefficient * x[index], 0);
    }
  };
}

function chooseLambda(training) {
  if (training.length < 180) return null;
  const split = Math.max(150, Math.floor(training.length * 0.8));
  const fitRows = training.slice(0, split);
  const validation = training.slice(split);
  let best = null;
  for (const lambda of MODEL_LAMBDAS) {
    const model = fitRidge(fitRows, lambda);
    if (!model) continue;
    const mse = mean(validation.map(row => (model.predict(row.features) - row.net27Bps) ** 2));
    if (best == null || mse < best.mse || (mse === best.mse && lambda < best.lambda)) best = { lambda, mse };
  }
  return best?.lambda ?? 1;
}

function compactPrediction(row, prediction, fold, lambda) {
  return {
    candidateId: row.candidateId,
    symbol: row.symbol,
    side: row.side,
    regime: row.regime,
    decisionTime: row.decisionTime,
    entryTime: row.entryTime,
    exitTime: row.exitTime,
    exitReason: row.exitReason,
    entryPrice: row.entryPrice,
    exitPrice: row.exitPrice,
    grossPriceBps: row.grossPriceBps,
    fundingBps: row.fundingBps,
    grossReturnBps: row.grossReturnBps,
    net18Bps: row.net18Bps,
    net27Bps: row.net27Bps,
    net36Bps: row.net36Bps,
    predictedEdgeBps: prediction,
    fold,
    lambda
  };
}

export function runDevelopmentWalkForward(rows) {
  const resolved = rows.filter(row => row.outcomeStatus === 'RESOLVED'
    && row.decisionTime >= DEVELOPMENT_START && row.decisionTime < DEVELOPMENT_END)
    .sort((left, right) => left.decisionTime - right.decisionTime || left.candidateId.localeCompare(right.candidateId));
  const predictions = [];
  const folds = [];
  let fold = 0;
  for (let validationStart = DEVELOPMENT_START + 180 * DAY + 36 * HOUR;
    validationStart < DEVELOPMENT_END;
    validationStart += 30 * DAY) {
    const validationEnd = Math.min(DEVELOPMENT_END, validationStart + 30 * DAY);
    const trainCutoff = validationStart - 36 * HOUR;
    const purgeCutoff = validationStart - 24 * HOUR;
    const training = resolved.filter(row => row.decisionTime < trainCutoff && row.exitTime < purgeCutoff);
    const validation = resolved.filter(row => row.decisionTime >= validationStart && row.decisionTime < validationEnd);
    if (training.length < 180 || !validation.length) continue;
    const lambda = chooseLambda(training);
    const model = fitRidge(training, lambda);
    if (!model) continue;
    fold += 1;
    for (const row of validation) predictions.push(compactPrediction(row, model.predict(row.features), fold, lambda));
    folds.push({
      fold,
      trainStart: iso(DEVELOPMENT_START),
      trainEnd: iso(trainCutoff),
      purgeHours: 24,
      embargoHours: 12,
      validationStart: iso(validationStart),
      validationEnd: iso(validationEnd),
      trainingRows: training.length,
      validationRows: validation.length,
      lambda
    });
  }
  return { predictions, folds };
}

function sortedForSelection(rows) {
  return rows.slice().sort((left, right) => left.decisionTime - right.decisionTime
    || right.predictedEdgeBps - left.predictedEdgeBps || left.candidateId.localeCompare(right.candidateId));
}

export function applyFrequency(rows, threshold) {
  const selected = [];
  const activeUntil = new Map();
  const daily = new Map();
  for (const row of sortedForSelection(rows)) {
    if (!(row.predictedEdgeBps >= threshold)) continue;
    const date = new Date(row.decisionTime).toISOString().slice(0, 10);
    if ((daily.get(date) ?? 0) >= 2) continue;
    if ((activeUntil.get(row.symbol) ?? -Infinity) > row.decisionTime) continue;
    selected.push(row);
    daily.set(date, (daily.get(date) ?? 0) + 1);
    activeUntil.set(row.symbol, row.exitTime);
  }
  return selected;
}

function simpleProfitFactor(rows, field = 'net27Bps') {
  const gains = rows.filter(row => row[field] > 0).reduce((sum, row) => sum + row[field], 0);
  const losses = Math.abs(rows.filter(row => row[field] < 0).reduce((sum, row) => sum + row[field], 0));
  return losses ? gains / losses : gains > 0 ? Infinity : null;
}

function ratePer30Days(rows, start, end) {
  return rows.length / ((end - start) / DAY) * 30;
}

export function selectDevelopmentConfig(predictions) {
  if (!predictions.length) return { status: 'NO_DEVELOPMENT_CONFIG', reason: 'NO_OOF_PREDICTIONS', candidates: [] };
  const percentiles = [];
  for (let step = 900; step <= 999; step += 1) percentiles.push(step / 10);
  const configs = [];
  for (const percentile of percentiles) {
    const threshold = quantile(predictions.map(row => row.predictedEdgeBps), percentile / 100);
    const accepted = applyFrequency(predictions, threshold);
    const expectancy = mean(accepted.map(row => row.net27Bps));
    const pf = simpleProfitFactor(accepted);
    const rate = ratePer30Days(accepted, DEVELOPMENT_START + 180 * DAY, DEVELOPMENT_END);
    if (accepted.length && rate >= 20 && rate <= 40 && expectancy > 0 && pf >= 1.10) {
      configs.push({ percentile, threshold, accepted, rate, expectancy, pf });
    }
  }
  if (!configs.length) return { status: 'NO_DEVELOPMENT_CONFIG', reason: 'NO_OOF_THRESHOLD_MEETS_RATE_AND_EDGE', candidates: [] };
  configs.sort((left, right) => right.expectancy - left.expectancy || right.pf - left.pf
    || left.threshold - right.threshold || left.percentile - right.percentile);
  const best = configs[0];
  return {
    status: 'DEVELOPMENT_CONFIG_FOUND',
    lambda: modeNumber(predictions.map(row => row.lambda)),
    edgeThresholdBps: best.threshold,
    edgePercentile: best.percentile,
    selectionRatePer30Days: best.rate,
    selectionNet27ExpectancyBps: best.expectancy,
    selectionPF27: best.pf,
    acceptedDevelopmentRows: best.accepted,
    candidateConfigurations: configs.map(item => ({
      percentile: item.percentile,
      threshold: item.threshold,
      ratePer30Days: item.rate,
      net27ExpectancyBps: item.expectancy,
      PF27: item.pf,
      accepted: item.accepted.length
    }))
  };
}

function modeNumber(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0])[0]?.[0] ?? null;
}

function monthIntervals(start, end) {
  const intervals = [];
  let cursor = start;
  while (cursor < end) {
    const date = new Date(cursor);
    const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    const intervalEnd = Math.min(end, next);
    intervals.push({ start: cursor, end: intervalEnd });
    cursor = intervalEnd;
  }
  return intervals;
}

export function runHistoricalValidation(rows, developmentConfig) {
  if (developmentConfig.status !== 'DEVELOPMENT_CONFIG_FOUND') {
    return { status: 'NOT_RUN_NO_DEVELOPMENT_CONFIG', reason: developmentConfig.reason, predictions: [], accepted: [], folds: [] };
  }
  const resolved = rows.filter(row => row.outcomeStatus === 'RESOLVED').sort((left, right) => left.decisionTime - right.decisionTime);
  const predictions = [];
  const accepted = [];
  const folds = [];
  let fold = 0;
  for (const interval of monthIntervals(VALIDATION_START, VALIDATION_END)) {
    const trainingEnd = interval.start - 36 * HOUR;
    const trainStart = interval.start - 365 * DAY;
    const training = resolved.filter(row => row.decisionTime >= trainStart && row.decisionTime < trainingEnd && row.exitTime < interval.start - 24 * HOUR);
    const validation = resolved.filter(row => row.decisionTime >= interval.start && row.decisionTime < interval.end);
    if (training.length < 180) {
      folds.push({ fold: fold + 1, validationStart: iso(interval.start), validationEnd: iso(interval.end), trainingRows: training.length, status: 'SKIPPED_INSUFFICIENT_TRAINING' });
      continue;
    }
    const model = fitRidge(training, developmentConfig.lambda);
    if (!model) throw new Error('HISTORICAL_MODEL_FIT_FAILED');
    fold += 1;
    const block = validation.map(row => compactPrediction(row, model.predict(row.features), fold, developmentConfig.lambda));
    const selected = applyFrequency(block, developmentConfig.edgeThresholdBps);
    predictions.push(...block);
    accepted.push(...selected);
    folds.push({
      fold,
      validationStart: iso(interval.start),
      validationEnd: iso(interval.end),
      trainingStart: iso(trainStart),
      trainingEnd: iso(trainingEnd),
      trainingRows: training.length,
      validationRows: validation.length,
      acceptedRows: selected.length,
      lambda: developmentConfig.lambda,
      edgeThresholdBps: developmentConfig.edgeThresholdBps
    });
  }
  return { status: 'HISTORICAL_VALIDATION_COMPUTED', predictions, accepted, folds };
}

function monthsFor(rows) {
  return [...new Set(rows.map(row => new Date(row.exitTime).toISOString().slice(0, 7)))].sort();
}

function maxLossStreak(rows, field) {
  let current = 0;
  let maximum = 0;
  for (const row of rows.slice().sort((left, right) => left.exitTime - right.exitTime || left.candidateId.localeCompare(right.candidateId))) {
    current = row[field] < 0 ? current + 1 : 0;
    maximum = Math.max(maximum, current);
  }
  return maximum;
}

export function summarizeRows(rows, field = 'net27Bps') {
  const values = rows.map(row => row[field]).filter(finite);
  const total = values.reduce((sum, value) => sum + value, 0);
  const monthly = {};
  const symbol = {};
  for (const row of rows) {
    const month = new Date(row.exitTime).toISOString().slice(0, 7);
    monthly[month] = (monthly[month] ?? 0) + row[field];
    symbol[row.symbol] = (symbol[row.symbol] ?? 0) + row[field];
  }
  const ordered = values.slice().sort((left, right) => right - left);
  const bestMonthValue = Object.keys(monthly).length ? Math.max(...Object.values(monthly)) : null;
  const bestEvent = values.length ? values[0] : null;
  const absSymbol = Object.values(symbol).reduce((sum, value) => sum + Math.abs(value), 0);
  const largestSymbol = Object.entries(symbol).sort((left, right) => Math.abs(right[1]) - Math.abs(left[1]))[0];
  const positiveMonths = Object.values(monthly).filter(value => value > 0).length;
  const activeMonths = Object.keys(monthly).sort();
  return {
    count: rows.length,
    netPnlBps: total,
    netExpectancyBps: values.length ? total / values.length : null,
    profitFactor: simpleProfitFactor(rows, field),
    positiveRate: values.length ? values.filter(value => value > 0).length / values.length : null,
    activeMonths: activeMonths.length,
    activeMonthKeys: activeMonths,
    positiveMonths,
    positiveMonthShare: activeMonths.length ? positiveMonths / activeMonths.length : null,
    monthlyNetPnlBps: monthly,
    bestMonth: activeMonths.length ? activeMonths.slice().sort((left, right) => monthly[right] - monthly[left])[0] : null,
    bestMonthNetPnlBps: bestMonthValue,
    netPnlWithoutBestMonthBps: bestMonthValue == null ? null : total - bestMonthValue,
    bestEventNetPnlBps: bestEvent,
    netPnlWithoutBestEventBps: bestEvent == null ? null : total - bestEvent,
    netPnlWithoutBest5EventsBps: total - ordered.slice(0, 5).reduce((sum, value) => sum + value, 0),
    maxLossStreak: values.length ? maxLossStreak(rows, field) : null,
    symbolNetPnlBps: symbol,
    largestSymbol: largestSymbol?.[0] ?? null,
    largestSymbolContributionShare: absSymbol ? Math.abs(largestSymbol[1]) / absSymbol : null,
    fundingBps: rows.reduce((sum, row) => sum + row.fundingBps, 0),
    executionCostBps: rows.length * Number(field.slice(3, 5)),
    exitReasons: Object.fromEntries([...new Set(rows.map(row => row.exitReason))].sort().map(reason => [reason, rows.filter(row => row.exitReason === reason).length])),
    directionCounts: rows.reduce((out, row) => ({ ...out, [row.side]: (out[row.side] ?? 0) + 1 }), {})
  };
}

export function reconstructPortfolioMtm(rows, series, { costBps = 27, start = VALIDATION_START, end = VALIDATION_END } = {}) {
  if (!rows.length) return {
    status: 'EMPTY_SAMPLE_NOT_EVALUABLE',
    portfolioMtmStatus: 'NOT_RECONSTRUCTED',
    portfolioMtmDrawdownFraction: null,
    portfolioCvar95: null,
    portfolioCvarStatus: 'NOT_EVALUATED',
    equity: [],
    dailyReturns: []
  };
  const markPnl = new Map();
  const cash = new Map();
  const weight = 1 / FIXED_SYMBOLS.length;
  for (const row of rows) {
    const s = series[row.symbol];
    const entryIndex = s.mark5ByTime.has(row.entryTime) ? s.mark5.findIndex(mark => mark.openTime === row.entryTime) : -1;
    const exitIndex = s.mark5ByTime.has(row.exitTime) ? s.mark5.findIndex(mark => mark.openTime === row.exitTime) : -1;
    if (entryIndex < 0 || exitIndex < 0 || exitIndex < entryIndex) throw new Error(`${row.symbol}:PORTFOLIO_MTM_BOUNDARY_MISSING`);
    const sideSign = row.side === 'BUY' ? 1 : -1;
    for (let index = entryIndex; index < exitIndex; index += 1) {
      const mark = s.mark5[index];
      markPnl.set(mark.openTime, (markPnl.get(mark.openTime) ?? 0) + weight * sideSign * (mark.open - row.entryPrice) / row.entryPrice);
    }
    const exitPnl = weight * sideSign * (row.exitPrice - row.entryPrice) / row.entryPrice;
    cash.set(row.entryTime, (cash.get(row.entryTime) ?? 0) - weight * costBps / 10_000);
    cash.set(row.exitTime, (cash.get(row.exitTime) ?? 0) + exitPnl);
    for (const funding of s.funding) {
      if (funding.eventTime < row.entryTime) continue;
      if (funding.eventTime >= row.exitTime) break;
      const mark = s.mark5ByTime.get(funding.eventTime);
      if (!mark) throw new Error(`${row.symbol}:PORTFOLIO_FUNDING_MARK_MISSING`);
      cash.set(funding.eventTime, (cash.get(funding.eventTime) ?? 0)
        - weight * sideSign * mark.open / row.entryPrice * funding.fundingRate);
    }
  }
  const timestamps = [...new Set([...markPnl.keys(), ...cash.keys()])].sort((left, right) => left - right);
  let balance = 0;
  let peak = 0;
  let maxDrawdown = 0;
  const equity = [];
  for (const timestamp of timestamps) {
    balance += cash.get(timestamp) ?? 0;
    const value = balance + (markPnl.get(timestamp) ?? 0);
    peak = Math.max(peak, value);
    maxDrawdown = Math.max(maxDrawdown, peak - value);
    equity.push({ timestamp, value });
  }
  const dailyValues = [];
  let pointer = 0;
  let last = 0;
  for (let day = start; day < end; day += DAY) {
    const next = day + DAY;
    while (pointer < equity.length && equity[pointer].timestamp < next) last = equity[pointer++].value;
    dailyValues.push(last);
  }
  const dailyReturns = dailyValues.map((value, index) => value - (index ? dailyValues[index - 1] : 0));
  const sorted = dailyReturns.slice().sort((left, right) => left - right);
  const tail = sorted.slice(0, Math.max(1, Math.ceil(sorted.length * 0.05)));
  const cvarStatus = dailyReturns.length >= 60 ? 'EVALUABLE' : 'INSUFFICIENT_OBSERVATIONS';
  return {
    status: 'RECONSTRUCTED',
    portfolioMtmStatus: 'RECONSTRUCTED',
    portfolioMtmDrawdownFraction: maxDrawdown,
    portfolioCvar95: cvarStatus === 'EVALUABLE' ? mean(tail) : null,
    portfolioCvarStatus: cvarStatus,
    equity,
    dailyReturns,
    dailyObservationCount: dailyReturns.length,
    portfolioWeight: weight,
    costBps
  };
}

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

export function blockBootstrap(rows, { start = VALIDATION_START, end = VALIDATION_END, seed = 370037 } = {}) {
  if (!rows.length) return { status: 'EMPTY_SAMPLE_NOT_EVALUABLE', iterations: 5000, blockLengthDays: 7, seed };
  const dayCount = Math.ceil((end - start) / DAY);
  const byDay = Array.from({ length: dayCount }, () => []);
  for (const row of rows) {
    const index = Math.floor((row.exitTime - start) / DAY);
    if (index >= 0 && index < dayCount) byDay[index].push(row);
  }
  const random = seeded(seed);
  const net27 = [];
  const net36 = [];
  const pf27 = [];
  for (let iteration = 0; iteration < 5000; iteration += 1) {
    const sampled = [];
    for (let cursor = 0; cursor < dayCount;) {
      const blockStart = Math.floor(random() * Math.max(1, dayCount - 7 + 1));
      for (let offset = 0; offset < 7 && cursor < dayCount; offset += 1, cursor += 1) sampled.push(...byDay[blockStart + offset]);
    }
    if (!sampled.length) continue;
    net27.push(mean(sampled.map(row => row.net27Bps)));
    net36.push(mean(sampled.map(row => row.net36Bps)));
    pf27.push(simpleProfitFactor(sampled, 'net27Bps'));
  }
  return {
    status: net27.length ? 'COMPUTED' : 'EMPTY_SAMPLE_NOT_EVALUABLE',
    method: 'CALENDAR_TIME_BLOCK_BOOTSTRAP',
    blockLengthDays: 7,
    iterations: 5000,
    seed,
    confidence: 0.95,
    net27ExpectancyBpsLower95: quantile(net27, 0.025),
    net27ExpectancyBpsMedian: quantile(net27, 0.5),
    net27ExpectancyBpsUpper95: quantile(net27, 0.975),
    net36ExpectancyBpsLower95: quantile(net36, 0.025),
    net36ExpectancyBpsMedian: quantile(net36, 0.5),
    net36ExpectancyBpsUpper95: quantile(net36, 0.975),
    PF27Median: quantile(pf27.filter(finite), 0.5),
    PF27Lower95: quantile(pf27.filter(finite), 0.025)
  };
}

export function evaluatePromotionGates(rows, developmentConfig, risk, bootstrap) {
  const net18 = summarizeRows(rows, 'net18Bps');
  const net27 = summarizeRows(rows, 'net27Bps');
  const net36 = summarizeRows(rows, 'net36Bps');
  const activeDays = new Set(rows.map(row => new Date(row.decisionTime).toISOString().slice(0, 10))).size;
  const validationDays = Math.round((VALIDATION_END - VALIDATION_START) / DAY);
  const checks = {
    validationSignals: rows.length >= 240 && rows.length <= 480,
    averageSignalsPer30Days: rows.length / validationDays * 30 >= 20 && rows.length / validationDays * 30 <= 40,
    activeMonths: net27.activeMonths >= 10,
    symbolBreadth: Object.keys(net27.symbolNetPnlBps).length >= 6,
    net27Expectancy: net27.netExpectancyBps >= 5,
    PF27: net27.profitFactor >= 1.2,
    totalNet27Pnl: net27.netPnlBps > 0,
    net36Expectancy: net36.netExpectancyBps > 0,
    portfolioMtm: risk.portfolioMtmStatus === 'RECONSTRUCTED' && risk.portfolioMtmDrawdownFraction <= 0.1,
    portfolioCvar: risk.portfolioCvarStatus === 'EVALUABLE',
    maxLossStreak: net27.maxLossStreak <= 8,
    positiveMonths: net27.positiveMonths >= 7,
    withoutBestEvent: net27.netPnlWithoutBestEventBps > 0,
    withoutBest5Events: net27.netPnlWithoutBest5EventsBps > 0,
    withoutBestMonth: net27.netPnlWithoutBestMonthBps > 0,
    largestSymbolContribution: net27.largestSymbolContributionShare <= 0.4,
    bootstrapNet27Lower95: bootstrap.status === 'COMPUTED' && bootstrap.net27ExpectancyBpsLower95 > 0
  };
  return {
    pass: Object.values(checks).every(Boolean),
    checks,
    failures: Object.entries(checks).filter(([, value]) => !value).map(([name]) => name),
    activeDays,
    net18,
    net27,
    net36,
    developmentConfig
  };
}

export function buildDevelopmentReport({ candidates, outcomes, walkForward, developmentConfig }) {
  const resolved = outcomes.filter(row => row.outcomeStatus === 'RESOLVED');
  const selected = developmentConfig.acceptedDevelopmentRows ?? [];
  return {
    schemaVersion: 1,
    artifactType: 'HY_EXP_0037_DEVELOPMENT_REPORT',
    immutable: true,
    experimentId: HY_EXP_0037,
    window: { start: iso(DEVELOPMENT_START), endExclusive: iso(DEVELOPMENT_END), calendarDays: 365 },
    sourceBoundary: { outcomeRead: true, pnlComputed: true, finalOosRead: false },
    counts: {
      rawCandidates: candidates.length,
      BUY: candidates.filter(row => row.side === 'BUY').length,
      SELL: candidates.filter(row => row.side === 'SELL').length,
      labeledCandidates: resolved.filter(row => row.decisionTime < DEVELOPMENT_END).length,
      invalidCandidates: outcomes.filter(row => row.outcomeStatus !== 'RESOLVED' && row.decisionTime < DEVELOPMENT_END).length,
      oofPredictions: walkForward.predictions.length,
      acceptedOofSignals: selected.length
    },
    model: {
      name: 'RIDGE_EXPECTED_RETURN_MODEL',
      lambdaGrid: MODEL_LAMBDAS,
      selectedLambda: developmentConfig.lambda ?? null,
      selectedEdgeThresholdBps: developmentConfig.edgeThresholdBps ?? null,
      selectedEdgePercentile: developmentConfig.edgePercentile ?? null
    },
    walkForward: { method: 'EXPANDING_PURGED_WALK_FORWARD', folds: walkForward.folds, randomSplit: false, oofOnly: true },
    selection: {
      status: developmentConfig.status,
      reason: developmentConfig.reason ?? null,
      ratePer30Days: developmentConfig.selectionRatePer30Days ?? null,
      net27ExpectancyBps: developmentConfig.selectionNet27ExpectancyBps ?? null,
      PF27: developmentConfig.selectionPF27 ?? null,
      configurations: developmentConfig.candidateConfigurations ?? []
    },
    outcomeBreakdown: {
      net18: summarizeRows(selected, 'net18Bps'),
      net27: summarizeRows(selected, 'net27Bps'),
      net36: summarizeRows(selected, 'net36Bps')
    },
    status: developmentConfig.status === 'DEVELOPMENT_CONFIG_FOUND' ? 'DEVELOPMENT_CONFIG_FOUND' : 'NO_DEVELOPMENT_CONFIG',
    promotionEligible: false,
    safety: { paperOnly: true, signalOnly: true, gmail: false, scheduler: false, realEmail: false, automaticTrading: false, accountApi: false, orderApi: false, finalOosRead: false }
  };
}

export function buildHistoricalValidationReport({ history, series, developmentConfig }) {
  const accepted = history.accepted ?? [];
  const risk = reconstructPortfolioMtm(accepted, series);
  const bootstrap = blockBootstrap(accepted);
  const gates = evaluatePromotionGates(accepted, developmentConfig, risk, bootstrap);
  const result = {
    schemaVersion: 1,
    artifactType: 'HY_EXP_0037_HISTORICAL_VALIDATION',
    immutable: true,
    experimentId: HY_EXP_0037,
    window: {
      start: iso(VALIDATION_START),
      endExclusive: iso(VALIDATION_END),
      calendarDays: 365,
      validationType: 'REGISTERED_HISTORICAL_VALIDATION_NOT_FINAL_OOS',
      finalOosRead: false
    },
    sourceBoundary: { outcomeRead: true, pnlComputed: true, finalOosRead: false, previouslyObservedDisclosure: true },
    status: history.status,
    reason: history.reason ?? null,
    counts: { predictions: history.predictions.length, accepted: accepted.length, folds: history.folds.length },
    developmentConfig: {
      status: developmentConfig.status,
      lambda: developmentConfig.lambda ?? null,
      edgeThresholdBps: developmentConfig.edgeThresholdBps ?? null
    },
    metrics: { net18: gates.net18, net27: gates.net27, net36: gates.net36 },
    portfolioRisk: risk,
    bootstrap,
    gates: gates.checks,
    gateFailures: gates.failures,
    result: gates.pass ? 'HISTORICAL_VALIDATION_PASS' : 'NO_PROFITABLE_EMAIL_STRATEGY_FOUND',
    emailPreparationEligible: gates.pass,
    futureValidation: { experimentId: 'HY-FWD-0037-001', prepared: gates.pass, activated: false, minimumDays: 30, minimumSignals: 20 },
    safety: { paperOnly: true, signalOnly: true, gmail: false, scheduler: false, realEmail: false, automaticTrading: false, accountApi: false, orderApi: false, finalOosRead: false },
    folds: history.folds
  };
  return { result, risk, bootstrap, gates };
}

export function buildFrozenModelSpec({ developmentConfig, preregistrationSha256 }) {
  return {
    schemaVersion: 1,
    artifactType: 'HY_EXP_0037_FROZEN_MODEL_SPEC',
    immutable: true,
    experimentId: HY_EXP_0037,
    preregistrationSha256,
    model: 'RIDGE_EXPECTED_RETURN_MODEL',
    featureNames: FEATURE_NAMES,
    lambdaGrid: MODEL_LAMBDAS,
    selectedLambda: developmentConfig.lambda ?? null,
    selectedEdgeThresholdBps: developmentConfig.edgeThresholdBps ?? null,
    status: developmentConfig.status,
    noPostOutcomeTuning: true,
    safety: { paperOnly: true, signalOnly: true, gmail: false, scheduler: false, realEmail: false, automaticTrading: false, accountApi: false, orderApi: false, finalOosRead: false }
  };
}

export function buildEmailPreparation({ validation, codeCommit, preregistrationSha256, dataManifestSha256 }) {
  if (validation.emailPreparationEligible !== true) return null;
  return {
    schemaVersion: 1,
    artifactType: 'HY_EXP_0037_PAPER_EMAIL_PREPARATION',
    immutable: true,
    experimentId: HY_EXP_0037,
    codeCommit,
    preregistrationSha256,
    dataManifestSha256,
    EMAIL_PREPARED: true,
    EMAIL_ACTIVATED: false,
    fields: ['symbol', 'BUY/SELL', 'decisionTime', 'referencePriceAtDecision', 'entryExpiry', 'stop', 'target', 'validUntil', 'strategyFamily', 'confidence', 'net27ExpectedEdge'],
    noQuantity: true,
    noLeverage: true,
    noOrderInstruction: true,
    gmailSendEnabled: false,
    schedulerActivated: false,
    realEmailSent: false,
    paperOnly: true,
    signalOnly: true,
    autoTrading: false,
    accountApi: false,
    orderApi: false,
    finalOosRead: false
  };
}

export function buildCompletionBundle({ codeCommit, preregistrationSha256, dataManifestSha256, artifactEntries, finalResult, emailPreparation = null }) {
  const artifacts = artifactEntries.slice();
  return {
    schemaVersion: 1,
    artifactType: 'HY_EXP_0037_COMPLETION_BUNDLE',
    immutable: true,
    experiment_id: HY_EXP_0037,
    code_commit: codeCommit,
    preregistration_sha256: preregistrationSha256,
    data_manifest_sha256: dataManifestSha256,
    outcomeRead: true,
    pnlComputed: true,
    finalOosRead: false,
    finalResult,
    artifacts,
    emailPreparation: emailPreparation ? 'artifacts/HY-EXP-0037/email-preparation.json' : null,
    safety: { paperOnly: true, signalOnly: true, gmail: false, scheduler: false, realEmail: false, automaticTrading: false, accountApi: false, orderApi: false, finalOosRead: false, productionDeploy: false }
  };
}

export { ROOT };
