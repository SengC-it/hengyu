import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  assertContiguous,
  mergeUniqueSeries,
  parseFundingArchive,
  parseKlineArchive,
  FIVE_MINUTES
} from '../src/research/archive.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREREG_PATH = path.join(ROOT, 'registry', 'experiments', 'HY-EXP-0034', 'preregistration.json');
const MANIFEST_PATH = path.join(ROOT, 'artifacts', 'HY-EXP-0034', 'data-manifest.json');
const ARTIFACT_DIR = path.join(ROOT, 'artifacts', 'HY-EXP-0034');
const RESULT_PATH = path.join(ARTIFACT_DIR, 'tournament-result.json');
const EVENTS_PATH = path.join(ARTIFACT_DIR, 'tournament-events.jsonl');
const REPORT_PATH = path.join(ARTIFACT_DIR, 'tournament-report.md');
const config = JSON.parse(fs.readFileSync(PREREG_PATH, 'utf8'));
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
const START = Date.parse(config.dataWindow.start);
const END = Date.parse(config.dataWindow.endExclusive);
const HOUR = 60 * 60 * 1000;
const FOUR_HOURS = 4 * HOUR;
const DAY = 24 * HOUR;
const SYMBOLS = Object.freeze([...config.universe.fixedSymbols]);
const PROFILES = Object.freeze(['P1', 'P2', 'P3']);
const profileConfig = config.executionProfiles;
const hash = buffer => createHash('sha256').update(buffer).digest('hex');
const filePath = item => path.resolve(ROOT, item.path);
const cache = new Map();
const verifiedFiles = new Set();

function parseRecoveredMark(buffer, symbol) {
  const values = JSON.parse(buffer.toString('utf8'));
  if (!Array.isArray(values)) throw new Error(`${symbol}/mark recovery is not an array`);
  return values.map((value, index) => {
    if (!Array.isArray(value) || value.length < 7) throw new Error(`${symbol}/mark recovery row ${index} is malformed`);
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
    for (const field of ['openTime', 'open', 'high', 'low', 'close', 'volume', 'closeTime', 'quoteVolume', 'trades']) {
      if (!Number.isFinite(row[field])) throw new Error(`${symbol}/mark recovery row ${index}: invalid ${field}`);
    }
    if (row.closeTime !== row.openTime + FIVE_MINUTES - 1 || row.open <= 0 || row.high < row.low
      || row.high < Math.max(row.open, row.close) || row.low > Math.min(row.open, row.close)) {
      throw new Error(`${symbol}/mark recovery row ${index}: invalid OHLC/time`);
    }
    return row;
  });
}

function verifyFrozenInputs() {
  if (manifest.experimentId !== 'HY-EXP-0034') throw new Error('wrong data manifest experiment');
  if (manifest.sourceManifestSha256 !== 'c5572595820b6d58c8480edd355320bbf28e7a641350d8eeff791afcb6ff9311') {
    throw new Error('0033 source manifest hash mismatch');
  }
  if (manifest.preregistrationSha256 !== hash(fs.readFileSync(PREREG_PATH))) throw new Error('0034 preregistration hash mismatch');
  if (manifest.preregistrationCommit !== '561989374e370aed824a5c12271b25dbf2ca8a5b') throw new Error('0034 preregistration commit mismatch');
  if (manifest.missingCount !== 0 || manifest.coverageStatus !== 'PASS_FIXED_EIGHT_SOURCE_SUBSET') throw new Error('0034 data coverage is not complete');
  if (manifest.outcomeRead || manifest.pnlComputed || manifest.finalOosRead) throw new Error('0034 manifest is not pre-outcome clean');
  if (manifest.safety?.paperOnly !== true || manifest.safety?.signalOnly !== true
    || manifest.safety?.gmail !== false || manifest.safety?.scheduler !== false
    || manifest.safety?.realEmail !== false || manifest.safety?.automaticTrading !== false
    || manifest.safety?.accountApi !== false || manifest.safety?.orderApi !== false
    || manifest.safety?.finalOosRead !== false) throw new Error('0034 manifest safety boundary changed');
  if (JSON.stringify(manifest.symbols) !== JSON.stringify(SYMBOLS)) throw new Error('0034 symbol universe mismatch');
  for (const item of manifest.files) {
    if (verifiedFiles.has(item.path)) continue;
    const buffer = fs.readFileSync(filePath(item));
    if (hash(buffer) !== item.sha256) throw new Error(`data hash mismatch: ${item.path}`);
    verifiedFiles.add(item.path);
  }
}

function rowsFor(symbol, kind) {
  const key = `${symbol}:${kind}`;
  if (cache.has(key)) return cache.get(key);
  const items = manifest.files
    .filter(row => row.symbol === symbol && row.kind === kind && row.path)
    .sort((left, right) => `${left.period}/${left.cadence}/${left.path}`.localeCompare(`${right.period}/${right.cadence}/${right.path}`));
  if (!items.length) throw new Error(`${symbol}/${kind}: no locked files`);
  const chunks = items.map(item => {
    const buffer = fs.readFileSync(filePath(item));
    if (kind === 'funding' && item.cadence === 'rest') {
      return JSON.parse(buffer.toString('utf8')).map(value => ({
        symbol,
        archiveTime: Number(value.fundingTime),
        eventTime: Math.floor(Number(value.fundingTime) / FIVE_MINUTES) * FIVE_MINUTES,
        fundingIntervalHours: 8,
        fundingRate: Number(value.fundingRate)
      }));
    }
    return kind === 'funding'
      ? parseFundingArchive(buffer, symbol)
      : item.sourceSegment === 'REST_NATIVE_RECOVERY'
        ? parseRecoveredMark(buffer, symbol)
        : parseKlineArchive(buffer, symbol, kind);
  });
  const field = kind === 'funding' ? 'eventTime' : 'openTime';
  const rows = mergeUniqueSeries(chunks, field, `${symbol}/${kind}`)
    .filter(row => row[field] >= START && row[field] < END);
  if (kind !== 'funding') {
    assertContiguous(rows, `${symbol}/${kind}`);
    if (rows[0]?.openTime !== START || rows.at(-1)?.openTime !== END - FIVE_MINUTES) {
      throw new Error(`${symbol}/${kind}: coverage does not exactly span frozen window`);
    }
  }
  cache.set(key, rows);
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
      throw new Error(`${label}: incomplete ${minutesPerBar}m bucket at ${new Date(bucket).toISOString()}`);
    }
    output.push({
      symbol: chunk[0].symbol,
      openTime: bucket,
      closeTime: bucket + width - 1,
      open: chunk[0].open,
      high: Math.max(...chunk.map(row => row.high)),
      low: Math.min(...chunk.map(row => row.low)),
      close: chunk.at(-1).close,
      quoteVolume: chunk.reduce((sum, row) => sum + row.quoteVolume, 0),
      volume: chunk.reduce((sum, row) => sum + row.volume, 0),
      trades: chunk.reduce((sum, row) => sum + row.trades, 0)
    });
  }
  return output;
}

function buildSeries() {
  const series = {};
  for (const symbol of SYMBOLS) {
    const contract5 = rowsFor(symbol, 'contract');
    const mark5 = rowsFor(symbol, 'mark');
    const funding = rowsFor(symbol, 'funding');
    const contract1 = aggregateBars(contract5, 60, `${symbol}/contract1h`);
    const mark1 = aggregateBars(mark5, 60, `${symbol}/mark1h`);
    const contract4 = aggregateBars(contract5, 240, `${symbol}/contract4h`);
    const mark4 = aggregateBars(mark5, 240, `${symbol}/mark4h`);
    if (contract1.length !== mark1.length || contract4.length !== mark4.length) throw new Error(`${symbol}: contract/mark alignment mismatch`);
    series[symbol] = {
      symbol,
      contract5,
      mark5,
      funding,
      contract1,
      mark1,
      contract4,
      mark4,
      contract5ByTime: new Map(contract5.map((row, index) => [row.openTime, index])),
      contract1ByTime: new Map(contract1.map((row, index) => [row.openTime, index])),
      contract4ByTime: new Map(contract4.map((row, index) => [row.openTime, index])),
      mark5ByTime: new Map(mark5.map(row => [row.openTime, row]))
    };
  }
  const anchor = series.BTCUSDT.contract4.map(row => row.openTime);
  for (const symbol of SYMBOLS) {
    if (JSON.stringify(series[symbol].contract4.map(row => row.openTime)) !== JSON.stringify(anchor)) {
      throw new Error(`${symbol}: 4h cross-symbol alignment mismatch`);
    }
  }
  return series;
}

function mean(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }
function sampleStd(values, average = mean(values)) {
  if (values.length < 2 || average == null) return null;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}
function quantile(values, probability) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * probability)];
}
function lowerIndex(rows, time) {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (rows[mid].openTime < time) low = mid + 1;
    else high = mid;
  }
  return low;
}
function lastCompletedIndex(rows, decisionTime) {
  const index = lowerIndex(rows, decisionTime) - 1;
  return index >= 0 && rows[index].closeTime < decisionTime ? index : -1;
}
function sma(rows, index, period, field = 'close') {
  if (index < period - 1) return null;
  return mean(rows.slice(index - period + 1, index + 1).map(row => row[field]));
}
function emaSeries(rows, period, field = 'close') {
  const output = Array(rows.length).fill(null);
  let value = null;
  const alpha = 2 / (period + 1);
  for (let index = 0; index < rows.length; index++) {
    value = value == null ? rows[index][field] : alpha * rows[index][field] + (1 - alpha) * value;
    output[index] = value;
  }
  return output;
}
function atr(rows, index, period) {
  if (index < period) return null;
  const ranges = [];
  for (let cursor = index - period + 1; cursor <= index; cursor++) {
    const previousClose = rows[cursor - 1].close;
    ranges.push(Math.max(rows[cursor].high - rows[cursor].low,
      Math.abs(rows[cursor].high - previousClose), Math.abs(rows[cursor].low - previousClose)));
  }
  return mean(ranges);
}
function logReturn(rows, index, lookback = 1) {
  if (index < lookback || rows[index - lookback].close <= 0 || rows[index].close <= 0) return null;
  return Math.log(rows[index].close / rows[index - lookback].close);
}
function regimeAt(fourHourRows, decisionTime) {
  const index = lastCompletedIndex(fourHourRows, decisionTime);
  if (index < 199) return null;
  const fast = sma(fourHourRows, index, 50);
  const slow = sma(fourHourRows, index, 200);
  if (fourHourRows[index].close > slow && fast > slow) return 'BUY';
  if (fourHourRows[index].close < slow && fast < slow) return 'SELL';
  return 'NO_TRADE';
}
function olsBeta(x, y) {
  if (x.length !== y.length || x.length < 2) return null;
  const mx = mean(x);
  const my = mean(y);
  let denominator = 0;
  let numerator = 0;
  for (let index = 0; index < x.length; index++) {
    denominator += (x[index] - mx) ** 2;
    numerator += (x[index] - mx) * (y[index] - my);
  }
  return denominator > 0 ? numerator / denominator : null;
}
function candidate(symbol, family, direction, signalTime, decisionTime, atr1h, extra = {}) {
  if (!(atr1h > 0) || !Number.isFinite(atr1h)) return null;
  return {
    candidateId: `${family}:${symbol}:${direction}:${decisionTime}`,
    family,
    symbol,
    direction,
    side: direction === 'BUY' ? 1 : -1,
    signalTime,
    decisionTime,
    atr1h,
    ...extra
  };
}

function generateTrendPullback(series) {
  const output = [];
  for (const symbol of SYMBOLS) {
    const s = series[symbol];
    const ema20 = emaSeries(s.contract1, 20);
    for (let index = 200 * 4; index < s.contract1.length; index++) {
      const bar = s.contract1[index];
      const previous = s.contract1[index - 1];
      const decisionTime = bar.openTime + HOUR;
      const regime = regimeAt(s.contract4, decisionTime);
      const buy = regime === 'BUY' && previous.close <= ema20[index - 1] && previous.low <= ema20[index - 1]
        && bar.close > ema20[index] && bar.close > previous.close;
      const sell = regime === 'SELL' && previous.close >= ema20[index - 1] && previous.high >= ema20[index - 1]
        && bar.close < ema20[index] && bar.close < previous.close;
      if (buy || sell) {
        const row = candidate(symbol, 'A_TREND_PULLBACK', buy ? 'BUY' : 'SELL', decisionTime, decisionTime, atr(s.contract1, index, 30), { regime });
        if (row) output.push(row);
      }
    }
  }
  return output;
}

function generateCompressionExpansion(series) {
  const output = [];
  for (const symbol of SYMBOLS) {
    const s = series[symbol];
    const bandwidth = Array(s.contract1.length).fill(null);
    const ema20 = emaSeries(s.contract1, 20);
    for (let index = 19; index < s.contract1.length; index++) {
      const values = s.contract1.slice(index - 19, index + 1).map(row => row.close);
      const center = mean(values);
      const deviation = sampleStd(values, center);
      bandwidth[index] = center > 0 ? (4 * deviation) / center : null;
    }
    for (let index = 200 * 4; index < s.contract1.length; index++) {
      const bar = s.contract1[index];
      const decisionTime = bar.openTime + HOUR;
      const regime = regimeAt(s.contract4, decisionTime);
      if (!regime || regime === 'NO_TRADE' || bandwidth[index] == null) continue;
      const prior = bandwidth.filter((value, cursor) => cursor < index && value != null
        && s.contract1[cursor].openTime >= bar.openTime - 30 * DAY);
      if (prior.length < 30 || bandwidth[index] > quantile(prior, 0.2)) continue;
      const previous = s.contract1.slice(index - 24, index);
      const buy = regime === 'BUY' && bar.close > Math.max(...previous.map(row => row.high));
      const sell = regime === 'SELL' && bar.close < Math.min(...previous.map(row => row.low));
      if (buy || sell) {
        const row = candidate(symbol, 'B_VOLATILITY_COMPRESSION_EXPANSION', buy ? 'BUY' : 'SELL', decisionTime, decisionTime, atr(s.contract1, index, 30), {
          regime, bandwidth: bandwidth[index], compressionObservations: prior.length
        });
        if (row) output.push(row);
      }
    }
  }
  return output;
}

function latestFundingStats(rows, decisionTime) {
  const available = rows.filter(row => row.eventTime < decisionTime && row.eventTime >= decisionTime - 30 * DAY);
  if (available.length < 46) return null;
  const current = available.at(-1);
  const prior = available.slice(0, -1).map(row => row.fundingRate);
  const deviation = sampleStd(prior);
  if (!(deviation > 0)) return null;
  return { current, zscore: (current.fundingRate - mean(prior)) / deviation, count: available.length };
}

function generateFundingCrowding(series) {
  const output = [];
  for (const symbol of SYMBOLS) {
    const s = series[symbol];
    const markEma50 = emaSeries(s.mark1, 50);
    const markEma20 = emaSeries(s.mark1, 20);
    for (let index = 50; index < s.contract1.length; index++) {
      const bar = s.contract1[index];
      const previousMark = s.mark1[index - 1];
      const currentMark = s.mark1[index];
      const decisionTime = bar.openTime + HOUR;
      const funding = latestFundingStats(s.funding, decisionTime);
      if (!funding || index < 31) continue;
      const priorAtr = atr(s.mark1, index - 1, 30);
      const priorEma = markEma50[index - 1];
      if (!(priorAtr > 0) || !(priorEma > 0)) continue;
      const basisBps = 10_000 * (bar.close - currentMark.close) / currentMark.close;
      const extension = Math.abs(previousMark.close - priorEma) / priorAtr;
      const long = funding.zscore <= -2.5 && basisBps <= -20 && previousMark.close < priorEma
        && extension >= 2 && previousMark.close <= markEma20[index - 1] && currentMark.close > markEma20[index];
      const short = funding.zscore >= 2.5 && basisBps >= 20 && previousMark.close > priorEma
        && extension >= 2 && previousMark.close >= markEma20[index - 1] && currentMark.close < markEma20[index];
      if (long || short) {
        const row = candidate(symbol, 'C_FUNDING_BASIS_CROWDING_REVERSAL', long ? 'BUY' : 'SELL', decisionTime, decisionTime, atr(s.contract1, index, 30), {
          fundingZscore: funding.zscore, basisBps, extensionAtr: extension
        });
        if (row) output.push(row);
      }
    }
  }
  return output;
}

function generateCrossSectional(series) {
  const output = [];
  const btc = series.BTCUSDT.contract4;
  const btcReturns = btc.map((_, index) => logReturn(btc, index));
  const others = SYMBOLS.filter(symbol => symbol !== 'BTCUSDT');
  for (let index = 43; index < btc.length; index++) {
    const decisionTime = btc[index].openTime + FOUR_HOURS;
    const regime = regimeAt(btc, decisionTime);
    if (regime !== 'BUY' && regime !== 'SELL') continue;
    const values = [];
    for (const symbol of others) {
      const bars = series[symbol].contract4;
      const returns = bars.map((_, cursor) => logReturn(bars, cursor));
      const beta = olsBeta(returns.slice(index - 42, index), btcReturns.slice(index - 42, index));
      const symbolReturn = logReturn(bars, index, 42);
      const btcReturn = logReturn(btc, index, 42);
      if (beta == null || symbolReturn == null || btcReturn == null) continue;
      values.push({ symbol, residual: symbolReturn - beta * btcReturn, beta });
    }
    const selected = values.sort((left, right) => right.residual - left.residual || left.symbol.localeCompare(right.symbol));
    const chosen = regime === 'BUY'
      ? selected.filter(row => row.residual > 0).slice(0, 2)
      : selected.sort((left, right) => left.residual - right.residual || left.symbol.localeCompare(right.symbol)).filter(row => row.residual < 0).slice(0, 2);
    for (const row of chosen) {
      const s = series[row.symbol];
      const oneHourIndex = s.contract1ByTime.get(decisionTime - HOUR);
      const item = candidate(row.symbol, 'D_CROSS_SECTIONAL_RELATIVE_STRENGTH', regime, decisionTime, decisionTime,
        oneHourIndex == null ? null : atr(s.contract1, oneHourIndex, 30), {
          regime, residualReturn: row.residual, beta: row.beta, rank: selected.findIndex(value => value.symbol === row.symbol) + 1
        });
      if (item) output.push(item);
    }
  }
  return output;
}

function generateResidualMeanReversion(series) {
  const output = [];
  const btc = series.BTCUSDT.mark1;
  const btcReturns = btc.map((_, index) => logReturn(btc, index));
  const btc4 = series.BTCUSDT.mark4;
  const btc4Returns = btc4.map((_, index) => logReturn(btc4, index));
  const fourIndexFor = time => lastCompletedIndex(btc4, time);
  for (const symbol of SYMBOLS.filter(value => value !== 'BTCUSDT')) {
    const bars = series[symbol].mark1;
    const returns = bars.map((_, index) => logReturn(bars, index));
    const residual = Array(bars.length).fill(null);
    for (let index = 721; index < bars.length; index++) {
      const beta = olsBeta(returns.slice(index - 720, index), btcReturns.slice(index - 720, index));
      if (beta != null && returns[index] != null && btcReturns[index] != null) residual[index] = returns[index] - beta * btcReturns[index];
    }
    for (let index = 721 + 120; index < bars.length; index++) {
      const priorResidual = residual.slice(index - 120, index).filter(value => value != null);
      if (priorResidual.length < 120 || residual[index] == null) continue;
      const scale = sampleStd(priorResidual);
      if (!(scale > 0)) continue;
      const zscore = (residual[index] - mean(priorResidual)) / scale;
      const decisionTime = bars[index].openTime + HOUR;
      const fourIndex = fourIndexFor(decisionTime);
      if (fourIndex < 20) continue;
      const current20 = logReturn(btc4, fourIndex, 20);
      const prior20 = btc4Returns.slice(fourIndex - 20, fourIndex).filter(value => value != null);
      const volatility = sampleStd(prior20);
      if (current20 == null || !(volatility > 0) || Math.abs(current20) >= 2 * volatility) continue;
      const s = series[symbol];
      const direction = zscore >= 3 ? 'SELL' : zscore <= -3 ? 'BUY' : null;
      if (!direction) continue;
      const contractIndex = s.contract1ByTime.get(bars[index].openTime);
      const item = candidate(symbol, 'E_BTC_RESIDUAL_MEAN_REVERSION', direction, decisionTime, decisionTime,
        contractIndex == null ? null : atr(s.contract1, contractIndex, 30), { zscore, betaResidual: residual[index] });
      if (item) output.push(item);
    }
  }
  return output;
}

function fundingReturn(row, s) {
  const markByTime = s.mark5ByTime;
  let value = 0;
  for (const item of s.funding) {
    if (item.eventTime < row.entryTime) continue;
    if (item.eventTime >= row.exitTime) break;
    const mark = markByTime.get(item.eventTime);
    if (!mark) throw new Error(`${row.symbol}: missing mark at funding ${item.eventTime}`);
    value += -row.side * mark.open / row.entryPrice * item.fundingRate;
  }
  return value;
}

function simulateCandidates(candidates, profileName, rangeStart, rangeEnd, series) {
  const profile = profileConfig[profileName];
  const ordered = candidates
    .filter(row => row.decisionTime >= rangeStart && row.decisionTime < rangeEnd
      && row.decisionTime < END - profile.maxHoldHours * HOUR)
    .sort((left, right) => left.decisionTime - right.decisionTime || left.symbol.localeCompare(right.symbol) || left.candidateId.localeCompare(right.candidateId));
  const activeUntil = new Map();
  const output = [];
  for (const item of ordered) {
    const s = series[item.symbol];
    const entryIndex = s.contract5ByTime.get(item.decisionTime);
    if (entryIndex == null || activeUntil.get(item.symbol) > item.decisionTime) continue;
    const entryBar = s.contract5[entryIndex];
    const entryPrice = entryBar.open;
    const stopPrice = item.side > 0 ? entryPrice - profile.stopAtr1h * item.atr1h : entryPrice + profile.stopAtr1h * item.atr1h;
    const targetPrice = item.side > 0 ? entryPrice + profile.targetAtr1h * item.atr1h : entryPrice - profile.targetAtr1h * item.atr1h;
    const timeExit = item.decisionTime + profile.maxHoldHours * HOUR;
    const timeExitIndex = s.contract5ByTime.get(timeExit);
    if (timeExitIndex == null) continue;
    let exitPrice = null;
    let exitTime = null;
    let exitReason = null;
    for (let index = entryIndex; index < timeExitIndex; index++) {
      const bar = s.contract5[index];
      const stopHit = item.side > 0 ? bar.low <= stopPrice : bar.high >= stopPrice;
      const targetHit = item.side > 0 ? bar.high >= targetPrice : bar.low <= targetPrice;
      if (stopHit || targetHit) {
        const nextBar = s.contract5[index + 1];
        if (!nextBar) break;
        exitPrice = stopHit ? stopPrice : targetPrice;
        exitTime = nextBar.openTime;
        exitReason = stopHit ? 'ATR_STOP' : 'TARGET';
        break;
      }
    }
    if (exitPrice == null) {
      const timeBar = s.contract5[timeExitIndex];
      exitPrice = timeBar.open;
      exitTime = timeBar.openTime;
      exitReason = 'MAX_HOLD';
    }
    const priceReturn = item.side * (exitPrice - entryPrice) / entryPrice;
    const result = {
      candidateId: item.candidateId,
      family: item.family,
      symbol: item.symbol,
      direction: item.direction,
      side: item.side,
      signalTime: item.signalTime,
      entryTime: item.decisionTime,
      exitTime,
      entryPrice,
      exitPrice,
      atr1h: item.atr1h,
      exitReason,
      grossPriceReturnFraction: priceReturn,
      fundingReturnFraction: 0,
      profile: profileName,
      featureSnapshot: { ...item }
    };
    result.fundingReturnFraction = fundingReturn(result, s);
    activeUntil.set(item.symbol, exitTime);
    output.push(result);
  }
  return output;
}

function add(map, key, value) { map.set(key, (map.get(key) ?? 0) + value); }

function withCosts(rows) {
  return rows.map(row => {
    const gross = row.grossPriceReturnFraction + row.fundingReturnFraction;
    return {
      ...row,
      grossReturnFraction: gross,
      net18: gross - 2 * 18 / 10_000,
      net27: gross - 2 * 27 / 10_000,
      net36: gross - 2 * 36 / 10_000
    };
  });
}

function reconstructPortfolioMtm(rows, series, costBps = 27) {
  if (!rows.length) {
    return {
      status: 'NOT_RECONSTRUCTED',
      portfolioMtmStatus: 'NOT_RECONSTRUCTED',
      portfolioMtmDrawdownFraction: null,
      equityPoints: 0,
      dailyObservationCount: 0,
      dailyReturns: [],
      portfolioCvar95: null,
      portfolioCvarStatus: 'NOT_EVALUABLE'
    };
  }
  const markPnl = new Map();
  const cash = new Map();
  const bySymbol = Object.fromEntries(SYMBOLS.map(symbol => [symbol, []]));
  for (const row of rows) bySymbol[row.symbol].push(row);
  for (const symbol of SYMBOLS) {
    const s = series[symbol];
    const entries = new Map();
    const exits = new Map();
    for (const row of bySymbol[symbol]) {
      if (!entries.has(row.entryTime)) entries.set(row.entryTime, []);
      entries.get(row.entryTime).push(row);
      if (!exits.has(row.exitTime)) exits.set(row.exitTime, []);
      exits.get(row.exitTime).push(row);
      add(cash, row.entryTime, -costBps / 10_000);
      add(cash, row.exitTime, row.side * (row.exitPrice - row.entryPrice) / row.entryPrice - costBps / 10_000);
      for (const funding of s.funding) {
        if (funding.eventTime < row.entryTime) continue;
        if (funding.eventTime >= row.exitTime) break;
        const mark = s.mark5ByTime.get(funding.eventTime);
        if (!mark) throw new Error(`${symbol}: portfolio MTM missing funding mark ${funding.eventTime}`);
        add(cash, funding.eventTime, -row.side * mark.open / row.entryPrice * funding.fundingRate);
      }
    }
    let coefficient = 0;
    let constant = 0;
    const active = new Set();
    for (const mark of s.mark5) {
      const time = mark.openTime;
      for (const row of exits.get(time) ?? []) {
        coefficient -= row.side / row.entryPrice;
        constant += row.side;
        active.delete(row.candidateId);
      }
      for (const row of entries.get(time) ?? []) {
        coefficient += row.side / row.entryPrice;
        constant -= row.side;
        active.add(row.candidateId);
      }
      if (time >= START && time < END) add(markPnl, time, mark.open * coefficient + constant);
    }
  }
  const times = [...new Set([...markPnl.keys(), ...cash.keys()])].sort((a, b) => a - b);
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  const equity = [];
  for (const time of times) {
    cumulative += cash.get(time) ?? 0;
    const value = cumulative + (markPnl.get(time) ?? 0);
    peak = Math.max(peak, value);
    maxDrawdown = Math.max(maxDrawdown, peak - value);
    equity.push({ time, value });
  }
  const dailyEquity = [];
  let pointer = 0;
  let last = 0;
  for (let day = START; day < END; day += DAY) {
    const dayEnd = day + DAY - 1;
    while (pointer < equity.length && equity[pointer].time <= dayEnd) last = equity[pointer++].value;
    dailyEquity.push(last);
  }
  const dailyReturns = dailyEquity.map((value, index) => value - (index ? dailyEquity[index - 1] : 0));
  const tail = dailyReturns.slice().sort((a, b) => a - b).slice(0, Math.max(1, Math.ceil(dailyReturns.length * 0.05)));
  return {
    status: 'RECONSTRUCTED',
    portfolioMtmStatus: 'RECONSTRUCTED',
    portfolioMtmDrawdownFraction: maxDrawdown,
    equityPoints: equity.length,
    dailyObservationCount: dailyReturns.length,
    dailyReturns,
    portfolioCvar95: -mean(tail),
    portfolioCvarStatus: dailyReturns.length >= 60 ? 'EVALUABLE' : 'NOT_EVALUABLE'
  };
}

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function dayStats(rows, costKey) {
  const days = Array.from({ length: Math.floor((END - START) / DAY) }, () => ({ sum: 0, count: 0, positive: 0, negative: 0 }));
  for (const row of rows) {
    const index = Math.floor((row.entryTime - START) / DAY);
    if (index < 0 || index >= days.length) continue;
    const value = row[costKey];
    days[index].sum += value;
    days[index].count++;
    if (value > 0) days[index].positive += value;
    if (value < 0) days[index].negative += value;
  }
  return days;
}

function bootstrapRows(rows, risk, seed = 340034) {
  if (!rows.length || risk.portfolioMtmStatus !== 'RECONSTRUCTED') return { status: 'NOT_EVALUABLE' };
  const days27 = dayStats(rows, 'net27');
  const days36 = dayStats(rows, 'net36');
  const random = seeded(seed);
  const net27 = [];
  const net36 = [];
  const pf27 = [];
  const drawdowns = [];
  const dayCount = days27.length;
  for (let iteration = 0; iteration < 5000; iteration++) {
    let total27 = 0;
    let total36 = 0;
    let totalCount = 0;
    let positive = 0;
    let negative = 0;
    let equity = 0;
    let peak = 0;
    let drawdown = 0;
    for (let cursor = 0; cursor < dayCount;) {
      const start = Math.floor(random() * (dayCount - 7 + 1));
      for (let offset = 0; offset < 7 && cursor < dayCount; offset++, cursor++) {
        const index = start + offset;
        total27 += days27[index].sum;
        total36 += days36[index].sum;
        totalCount += days27[index].count;
        positive += days27[index].positive;
        negative += days27[index].negative;
        equity += risk.dailyReturns[index];
        peak = Math.max(peak, equity);
        drawdown = Math.max(drawdown, peak - equity);
      }
    }
    if (totalCount) {
      net27.push(total27 / totalCount * 10_000);
      net36.push(total36 / totalCount * 10_000);
      pf27.push(negative < 0 ? positive / Math.abs(negative) : null);
    }
    drawdowns.push(drawdown);
  }
  const pValue = net27.length ? (net27.filter(value => value <= 0).length + 1) / (net27.length + 1) : null;
  return {
    status: 'COMPUTED',
    method: 'CALENDAR_TIME_BLOCK_BOOTSTRAP',
    blockLengthDays: 7,
    iterations: 5000,
    seed,
    net27ExpectancyBpsLower95: quantile(net27, 0.025),
    net27ExpectancyBpsMedian: quantile(net27, 0.5),
    net27ExpectancyBpsUpper95: quantile(net27, 0.975),
    net36ExpectancyBpsLower95: quantile(net36, 0.025),
    net36ExpectancyBpsMedian: quantile(net36, 0.5),
    net36ExpectancyBpsUpper95: quantile(net36, 0.975),
    PF27Median: quantile(pf27.filter(value => value != null), 0.5),
    PF27Lower95: quantile(pf27.filter(value => value != null), 0.025),
    portfolioMtmDrawdownUpper95: quantile(drawdowns, 0.975),
    rawOneSidedPValueNet27: pValue
  };
}

function profileLowerBound(rows, profileIndex, foldIndex) {
  if (!rows.length) return null;
  const days = dayStats(rows, 'net27');
  const random = seeded(340034 + profileIndex * 1009 + foldIndex * 100003);
  const values = [];
  for (let iteration = 0; iteration < 5000; iteration++) {
    let total = 0;
    let count = 0;
    for (let cursor = 0; cursor < days.length;) {
      const start = Math.floor(random() * (days.length - 7 + 1));
      for (let offset = 0; offset < 7 && cursor < days.length; offset++, cursor++) {
        total += days[start + offset].sum;
        count += days[start + offset].count;
      }
    }
    if (count) values.push(total / count * 10_000);
  }
  return quantile(values, 0.025);
}

function walkForward(candidates, series, familyIndex) {
  const folds = [];
  const oof = [];
  let foldIndex = 0;
  const firstTrainEnd = START + 180 * DAY;
  while (firstTrainEnd + foldIndex * 30 * DAY + 48 * HOUR + 36 * HOUR + 30 * DAY <= END) {
    const trainEnd = firstTrainEnd + foldIndex * 30 * DAY;
    const validationStart = trainEnd + 48 * HOUR + 36 * HOUR;
    const validationEnd = validationStart + 30 * DAY;
    const selection = {};
    const validation = {};
    for (let profileIndex = 0; profileIndex < PROFILES.length; profileIndex++) {
      const profile = PROFILES[profileIndex];
      const trainRows = withCosts(simulateCandidates(candidates, profile, START, trainEnd, series));
      selection[profile] = profileLowerBound(trainRows, familyIndex * 3 + profileIndex, foldIndex);
      validation[profile] = trainRows.length;
    }
    const eligible = PROFILES.filter(profile => selection[profile] != null && selection[profile] > 0);
    const selectedProfile = eligible.length
      ? eligible.slice().sort((left, right) => selection[right] - selection[left] || PROFILES.indexOf(left) - PROFILES.indexOf(right))[0]
      : 'NO_TRADE';
    const validationRows = selectedProfile === 'NO_TRADE'
      ? []
      : withCosts(simulateCandidates(candidates, selectedProfile, validationStart, validationEnd, series));
    oof.push(...validationRows);
    folds.push({
      fold: foldIndex,
      trainStart: new Date(START).toISOString(),
      trainEnd: new Date(trainEnd).toISOString(),
      purgeHours: 48,
      embargoHours: 36,
      validationStart: new Date(validationStart).toISOString(),
      validationEnd: new Date(validationEnd).toISOString(),
      trainingProfileLower95Net27Bps: selection,
      trainingCandidateCounts: validation,
      selectedProfile,
      validationEvents: validationRows.length
    });
    foldIndex++;
  }
  return { folds, oof };
}

function monthMap(rows, costKey) {
  const output = {};
  for (const row of rows) {
    const key = new Date(row.exitTime).toISOString().slice(0, 7);
    output[key] = (output[key] ?? 0) + row[costKey];
  }
  return output;
}
function maxLossStreak(rows, costKey) {
  let current = 0;
  let maximum = 0;
  for (const row of rows.slice().sort((a, b) => a.exitTime - b.exitTime)) {
    if (row[costKey] < 0) maximum = Math.max(maximum, ++current);
    else current = 0;
  }
  return maximum;
}
function summarize(rows, costKey) {
  const values = rows.map(row => row[costKey]);
  const gross = rows.map(row => row.grossReturnFraction);
  const wins = values.filter(value => value > 0);
  const losses = values.filter(value => value < 0);
  const months = monthMap(rows, costKey);
  const activeMonths = Object.keys(months).sort();
  const best = values.length ? Math.max(...values) : null;
  const bestFive = values.slice().sort((a, b) => b - a).slice(0, 5).reduce((sum, value) => sum + value, 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  const symbolPnl = {};
  for (const row of rows) symbolPnl[row.symbol] = (symbolPnl[row.symbol] ?? 0) + row[costKey];
  const absolutePnl = Object.values(symbolPnl).reduce((sum, value) => sum + Math.abs(value), 0);
  const largest = Object.entries(symbolPnl).sort((left, right) => Math.abs(right[1]) - Math.abs(left[1]))[0];
  return {
    signalCount: rows.length,
    activeDays: new Set(rows.map(row => new Date(row.entryTime).toISOString().slice(0, 10))).size,
    activeMonths: activeMonths.length,
    grossExpectancyBps: gross.length ? mean(gross) * 10_000 : null,
    netExpectancyBps: values.length ? mean(values) * 10_000 : null,
    netPnl: total,
    profitFactor: losses.length ? wins.reduce((sum, value) => sum + value, 0) / Math.abs(losses.reduce((sum, value) => sum + value, 0)) : null,
    maxLossStreak: maxLossStreak(rows, costKey),
    netPnlWithoutBestSignal: best == null ? null : total - best,
    netPnlWithoutBest5Signals: total - bestFive,
    bestMonth: activeMonths.length ? activeMonths.slice().sort((left, right) => months[right] - months[left])[0] : null,
    bestMonthNetPnl: activeMonths.length ? Math.max(...Object.values(months)) : null,
    netPnlWithoutBestMonth: activeMonths.length ? total - Math.max(...Object.values(months)) : null,
    positiveMonthShare: activeMonths.length ? Object.values(months).filter(value => value > 0).length / activeMonths.length : null,
    monthlyNetPnl: months,
    symbolPnl,
    largestSymbol: largest?.[0] ?? null,
    largestSymbolContributionShare: absolutePnl ? Math.abs(largest[1]) / absolutePnl : null,
    fundingPnl: rows.reduce((sum, row) => sum + row.fundingReturnFraction, 0),
    executionCostPnl: rows.length * (2 * Number(costKey.slice(3)) / 10_000),
    directionCounts: rows.reduce((out, row) => ({ ...out, [row.direction]: (out[row.direction] ?? 0) + 1 }), {})
  };
}
function normalCdf(value) {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const polynomial = (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return 0.5 * (1 + sign * (1 - polynomial * Math.exp(-x * x)));
}
function dsr(risk) {
  const values = risk.dailyReturns.filter(Number.isFinite);
  const average = mean(values);
  const deviation = sampleStd(values, average);
  if (!(deviation > 0) || values.length < 2) return { status: 'NOT_EVALUABLE', probability: null };
  const centered = values.map(value => value - average);
  const skew = mean(centered.map(value => value ** 3)) / deviation ** 3;
  const kurtosis = mean(centered.map(value => value ** 4)) / deviation ** 4;
  const dailySharpe = average / deviation;
  const annualizedSharpe = dailySharpe * Math.sqrt(365);
  const effectiveObservations = values.length;
  const expectedMaximumSharpe = Math.sqrt(2 * Math.log(15)) * Math.sqrt(365 / effectiveObservations);
  const standardErrorSharpe = Math.sqrt(Math.max(1e-12, (1 - skew * dailySharpe + ((kurtosis - 1) / 4) * dailySharpe ** 2) / effectiveObservations)) * Math.sqrt(365);
  const probability = normalCdf((annualizedSharpe - expectedMaximumSharpe) / standardErrorSharpe);
  return { status: 'COMPUTED', probability, observedAnnualizedSharpe: annualizedSharpe, expectedMaximumSharpe, standardErrorSharpe, skewness: skew, excessKurtosis: kurtosis - 3, effectiveObservations };
}

function familyGates(summary, risk, bootstrap, dsrResult, holmAdjustedPValue) {
  const checks = {
    oofSignals: summary.signalCount >= 100,
    activeMonths: summary.activeMonths >= 12,
    distinctSymbols: Object.keys(summary.byCost.net27.symbolPnl).length >= 6,
    net18: summary.byCost.net18.netExpectancyBps >= 10,
    PF18: summary.byCost.net18.profitFactor >= 1.3,
    net27: summary.byCost.net27.netExpectancyBps >= 4,
    PF27: summary.byCost.net27.profitFactor >= 1.2,
    net36: summary.byCost.net36.netExpectancyBps > 0,
    PF36: summary.byCost.net36.profitFactor >= 1.1,
    portfolioMtmDD: risk.portfolioMtmStatus === 'RECONSTRUCTED' && risk.portfolioMtmDrawdownFraction <= 0.08,
    portfolioCvar: risk.portfolioCvarStatus === 'EVALUABLE',
    maxLossStreak: summary.byCost.net27.maxLossStreak <= 6,
    withoutBestSignal: summary.byCost.net27.netPnlWithoutBestSignal > 0,
    withoutBest5: summary.byCost.net27.netPnlWithoutBest5Signals > 0,
    withoutBestMonth: summary.byCost.net27.netPnlWithoutBestMonth > 0,
    positiveMonthShare: summary.byCost.net27.positiveMonthShare >= 0.6,
    largestSymbolContribution: summary.byCost.net27.largestSymbolContributionShare <= 0.3,
    bootstrapNet27Lower: bootstrap.status === 'COMPUTED' && bootstrap.net27ExpectancyBpsLower95 > 0,
    dsrProbability: dsrResult.status === 'COMPUTED' && dsrResult.probability >= 0.95,
    holmAdjustedP: Number.isFinite(holmAdjustedPValue) && holmAdjustedPValue < 0.05
  };
  return { pass: Object.values(checks).every(Boolean), checks, failures: Object.entries(checks).filter(([, value]) => !value).map(([name]) => name), holmAdjustedPValue };
}

function familyReport(name, candidates, walk, series) {
  const rows = walk.oof;
  const byCost = {
    net18: summarize(rows, 'net18'),
    net27: summarize(rows, 'net27'),
    net36: summarize(rows, 'net36')
  };
  const risk = reconstructPortfolioMtm(rows, series, 27);
  const bootstrap = bootstrapRows(rows, risk, 340034);
  const dsrResult = dsr(risk);
  const summary = {
    family: name,
    candidateCount: candidates.length,
    signalCount: rows.length,
    activeMonths: byCost.net27.activeMonths,
    distinctSymbols: Object.keys(byCost.net27.symbolPnl).length,
    directionCounts: byCost.net27.directionCounts,
    net18ExpectancyBps: byCost.net18.netExpectancyBps,
    net27ExpectancyBps: byCost.net27.netExpectancyBps,
    net36ExpectancyBps: byCost.net36.netExpectancyBps,
    PF18: byCost.net18.profitFactor,
    PF27: byCost.net27.profitFactor,
    PF36: byCost.net36.profitFactor,
    netPnl18: byCost.net18.netPnl,
    netPnl27: byCost.net27.netPnl,
    netPnl36: byCost.net36.netPnl,
    portfolioMtmDrawdownFraction: risk.portfolioMtmDrawdownFraction,
    portfolioCvar95: risk.portfolioCvar95,
    maxLossStreak: byCost.net27.maxLossStreak,
    netPnlWithoutBestSignal: byCost.net27.netPnlWithoutBestSignal,
    netPnlWithoutBest5Signals: byCost.net27.netPnlWithoutBest5Signals,
    netPnlWithoutBestMonth: byCost.net27.netPnlWithoutBestMonth,
    positiveMonthShare: byCost.net27.positiveMonthShare,
    largestSymbolContributionShare: byCost.net27.largestSymbolContributionShare,
    fundingPnl: byCost.net27.fundingPnl,
    executionCostPnl: { net18: byCost.net18.executionCostPnl, net27: byCost.net27.executionCostPnl, net36: byCost.net36.executionCostPnl },
    byDirection: Object.fromEntries(['BUY', 'SELL'].map(direction => [direction, {
      signalCount: rows.filter(row => row.direction === direction).length,
      net18: summarize(rows.filter(row => row.direction === direction), 'net18'),
      net27: summarize(rows.filter(row => row.direction === direction), 'net27'),
      net36: summarize(rows.filter(row => row.direction === direction), 'net36')
    }])),
    byCost,
    risk,
    bootstrap,
    dsr: dsrResult,
    profileChoicesByFold: walk.folds,
    practicality: {
      signalsPer30Days: rows.length ? rows.length / ((END - START) / DAY) * 30 : 0,
      medianHoldingHours: rows.length ? quantile(rows.map(row => (row.exitTime - row.entryTime) / HOUR), 0.5) : null,
      entryExpirySensitivity: 'EXACT_NEXT_5M_OPEN_ONLY',
      stopHitRate: rows.length ? rows.filter(row => row.exitReason === 'ATR_STOP').length / rows.length : null,
      targetHitRate: rows.length ? rows.filter(row => row.exitReason === 'TARGET').length / rows.length : null,
      timeExitRate: rows.length ? rows.filter(row => row.exitReason === 'MAX_HOLD').length / rows.length : null
    }
  };
  return { candidates, positions: rows, summary, gates: familyGates(summary, risk, bootstrap, dsrResult, null) };
}

function applyHolm(families) {
  const ordered = Object.entries(families)
    .map(([name, family]) => ({ name, p: family.summary.bootstrap.rawOneSidedPValueNet27 }))
    .sort((left, right) => (left.p ?? Infinity) - (right.p ?? Infinity));
  let running = 0;
  for (let index = 0; index < ordered.length; index++) {
    const item = ordered[index];
    const adjusted = item.p == null ? null : Math.min(1, (ordered.length - index) * item.p);
    if (adjusted != null) running = Math.max(running, adjusted);
    families[item.name].summary.holm = { rawPValueNet27: item.p, adjustedPValueNet27: adjusted == null ? null : running, rank: index + 1 };
    families[item.name].gates = familyGates(families[item.name].summary, families[item.name].summary.risk, families[item.name].summary.bootstrap, families[item.name].summary.dsr, adjusted == null ? null : running);
  }
  return ordered;
}

function main() {
  verifyFrozenInputs();
  const series = buildSeries();
  const generators = [
    ['A_TREND_PULLBACK', generateTrendPullback],
    ['B_VOLATILITY_COMPRESSION_EXPANSION', generateCompressionExpansion],
    ['C_FUNDING_BASIS_CROWDING_REVERSAL', generateFundingCrowding],
    ['D_CROSS_SECTIONAL_RELATIVE_STRENGTH', generateCrossSectional],
    ['E_BTC_RESIDUAL_MEAN_REVERSION', generateResidualMeanReversion]
  ];
  const families = {};
  for (let index = 0; index < generators.length; index++) {
    const [name, generator] = generators[index];
    const candidates = generator(series).sort((left, right) => left.decisionTime - right.decisionTime || left.symbol.localeCompare(right.symbol));
    const walk = walkForward(candidates, series, index);
    families[name] = familyReport(name, candidates, walk, series);
  }
  applyHolm(families);
  const passers = Object.values(families).filter(family => family.gates.pass).map(family => family.summary.family);
  let winner = null;
  if (passers.length === 1) winner = passers[0];
  if (passers.length > 1) {
    winner = passers.slice().sort((left, right) => {
      const lowerDifference = families[right].summary.bootstrap.net27ExpectancyBpsLower95 - families[left].summary.bootstrap.net27ExpectancyBpsLower95;
      if (Math.abs(lowerDifference) >= 2) return lowerDifference;
      return families[left].summary.risk.portfolioMtmDrawdownFraction - families[right].summary.risk.portfolioMtmDrawdownFraction;
    })[0];
  }
  const codeCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const result = {
    schemaVersion: 1,
    artifactType: 'HY_EXP_0034_ACTIONABLE_ALPHA_DISCOVERY_RESULT',
    experimentId: 'HY-EXP-0034',
    generatedAt: new Date().toISOString(),
    codeCommit,
    preregistrationSha256: hash(fs.readFileSync(PREREG_PATH)),
    dataManifestSha256: hash(fs.readFileSync(MANIFEST_PATH)),
    window: config.dataWindow,
    outcomeRead: true,
    pnlComputed: true,
    finalOosRead: false,
    fixedSpecifications: { families: 5, executionProfiles: 3, totalSpecifications: 15, profiles: PROFILES, seed: 340034 },
    families,
    familyPassers: passers,
    winner: winner ?? 'NO_ACTIONABLE_ALPHA_FOUND',
    conclusion: winner ? 'ACTIONABLE_ALPHA_CANDIDATE_FOUND' : 'PUBLIC_OHLCV_MARK_FUNDING_ALPHA_EXHAUSTED',
    winnerRuleApplied: true,
    hyVal0034: { prepared: Boolean(winner), activated: false, experimentId: winner ? 'HY-VAL-0034-001' : null },
    reservedIds: { 'HY-EXP-0035': 'DO_NOT_CREATE_UNLESS_SEPARATE_FUTURE_USER_AUTHORIZATION', 'HY-EXP-0031': 'UNUSED_RESERVED_ID' },
    safety: { paperOnly: true, signalOnly: true, gmail: false, scheduler: false, realEmail: false, autoTrading: false, accountApi: false, orderApi: false, finalOosRead: false, productionDeploy: false }
  };
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const allRows = Object.values(families).flatMap(family => family.positions);
  fs.writeFileSync(EVENTS_PATH, `${allRows.map(JSON.stringify).join('\n')}${allRows.length ? '\n' : ''}`);
  fs.writeFileSync(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`);
  const lines = [
    '# HY-EXP-0034 Actionable Alpha Discovery',
    '',
    `Winner: **${result.winner}**`,
    `Conclusion: **${result.conclusion}**`,
    '',
    '| Family | Candidates | OOF signals | Months | Symbols | Net18 bps | PF18 | Net27 bps | PF27 | Net36 bps | PF36 | MTM DD | CVaR95 | DSR | Holm p | Gate |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|'
  ];
  for (const family of Object.values(families)) {
    const s = family.summary;
    lines.push(`| ${s.family} | ${s.candidateCount} | ${s.signalCount} | ${s.activeMonths} | ${s.distinctSymbols} | ${s.net18ExpectancyBps?.toFixed(4) ?? 'null'} | ${s.PF18?.toFixed(3) ?? 'null'} | ${s.net27ExpectancyBps?.toFixed(4) ?? 'null'} | ${s.PF27?.toFixed(3) ?? 'null'} | ${s.net36ExpectancyBps?.toFixed(4) ?? 'null'} | ${s.PF36?.toFixed(3) ?? 'null'} | ${s.portfolioMtmDrawdownFraction?.toFixed(6) ?? 'null'} | ${s.portfolioCvar95?.toFixed(6) ?? 'null'} | ${s.dsr.probability?.toFixed(4) ?? 'null'} | ${s.holm?.adjustedPValueNet27?.toExponential(3) ?? 'null'} | ${family.gates.pass ? 'PASS' : 'FAIL'} |`);
    lines.push('', `- failures: ${family.gates.failures.join(', ') || 'none'}`, `- bootstrap net27 95% CI: [${family.bootstrap?.net27ExpectancyBpsLower95 ?? 'null'}, ${family.bootstrap?.net27ExpectancyBpsUpper95 ?? 'null'}]`, '');
  }
  lines.push('All outcomes are development-only. Final OOS was not read; no release, email, scheduler, account, order or trading authorization is implied.');
  fs.writeFileSync(REPORT_PATH, `${lines.join('\n')}\n`);
  console.log(JSON.stringify({
    codeCommit,
    winner: result.winner,
    conclusion: result.conclusion,
    familyPassers: passers,
    families: Object.fromEntries(Object.entries(families).map(([name, family]) => [name, {
        candidates: family.summary.candidateCount,
        oofSignals: family.summary.signalCount,
        activeMonths: family.summary.activeMonths,
        distinctSymbols: family.summary.distinctSymbols,
        net18: family.summary.net18ExpectancyBps,
        PF18: family.summary.PF18,
        net27: family.summary.net27ExpectancyBps,
        PF27: family.summary.PF27,
        net36: family.summary.net36ExpectancyBps,
        PF36: family.summary.PF36,
        mtmDD: family.summary.portfolioMtmDrawdownFraction,
        cvar95: family.summary.portfolioCvar95,
        dsr: family.summary.dsr.probability,
        holm: family.summary.holm?.adjustedPValueNet27,
        gates: family.gates
      }]))
  }, null, 2));
}

main();
