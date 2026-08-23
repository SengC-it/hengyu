import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { assertContiguous, mergeUniqueSeries, parseFundingArchive, parseKlineArchive } from './archive.mjs';
import { evaluatePortfolioRisk } from '../model/net-edge.mjs';
import {
  edgeGateFromPrediction,
  fitHyExp0024Ridge,
  HY_EXP_0024_EDGE_MODEL_ID,
  HY_EXP_0024_EDGE_SOURCE,
  HY_EXP_0024_FEATURES,
  HY_EXP_0024_MINIMUM_SAMPLES,
  HY_EXP_0024_PRIMARY_LAMBDA,
  HY_EXP_0024_SENSITIVITY_LAMBDAS,
  predictHyExp0024Ridge,
  summarizeHyExp0024Calibration
} from '../model/hy-exp-0024-edge.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const HY_EXP_0024_EXPERIMENT_ID = 'HY-EXP-0024';
export const HY_EXP_0024_SYMBOLS = Object.freeze([
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT',
  'XRPUSDT', 'DOGEUSDT', 'LINKUSDT', 'LTCUSDT'
]);
export const DEVELOPMENT_START = Date.parse('2024-01-01T00:00:00.000Z');
export const DEVELOPMENT_END = Date.parse('2026-07-01T00:00:00.000Z');
export const HOUR = 60 * 60 * 1_000;
export const FIVE_MINUTES = 5 * 60 * 1_000;
export const FOUR_HOURS = 4 * HOUR;
export const DAY = 24 * HOUR;
export const MAX_HOLD_BARS = 6;
export const PURGE_BARS = 6;
export const EMBARGO_BARS = 6;
export const HISTORICAL_EXECUTION_DELAY_MS = FIVE_MINUTES;
export const HISTORICAL_BASE_COST_BPS = 18;
export const HISTORICAL_STRESS_COST_BPS = 27;
export const CONFIDENCE_Z = 1.645;
export const FUNDING_STRESS_BUFFER_BPS = 1;
export const RESEARCH_EQUITY_USDT = 100_000;

const SOURCE_MANIFEST = path.join(ROOT, 'artifacts', 'HY-EXP-0001', 'data-manifest.json');
const DRAFT = path.join(ROOT, 'artifacts', 'audits', 'HY-EXP-0024-preregistration-draft.json');
const FORMAL_PREREG = path.join(ROOT, 'registry', 'experiments', HY_EXP_0024_EXPERIMENT_ID, 'preregistration.json');

const FOLDS = Object.freeze([
  { id: 'DEV-01', trainStart: '2024-01-01T00:00:00.000Z', trainEndExclusive: '2025-01-01T00:00:00.000Z', validationStart: '2025-01-01T00:00:00.000Z', validationEndExclusive: '2025-04-01T00:00:00.000Z' },
  { id: 'DEV-02', trainStart: '2024-01-01T00:00:00.000Z', trainEndExclusive: '2025-04-01T00:00:00.000Z', validationStart: '2025-04-01T00:00:00.000Z', validationEndExclusive: '2025-07-01T00:00:00.000Z' },
  { id: 'DEV-03', trainStart: '2024-01-01T00:00:00.000Z', trainEndExclusive: '2025-07-01T00:00:00.000Z', validationStart: '2025-07-01T00:00:00.000Z', validationEndExclusive: '2025-10-01T00:00:00.000Z' },
  { id: 'DEV-04', trainStart: '2024-01-01T00:00:00.000Z', trainEndExclusive: '2025-10-01T00:00:00.000Z', validationStart: '2025-10-01T00:00:00.000Z', validationEndExclusive: '2026-01-01T00:00:00.000Z' },
  { id: 'DEV-05', trainStart: '2024-01-01T00:00:00.000Z', trainEndExclusive: '2026-01-01T00:00:00.000Z', validationStart: '2026-01-01T00:00:00.000Z', validationEndExclusive: '2026-04-01T00:00:00.000Z' },
  { id: 'DEV-06', trainStart: '2024-01-01T00:00:00.000Z', trainEndExclusive: '2026-04-01T00:00:00.000Z', validationStart: '2026-04-01T00:00:00.000Z', validationEndExclusive: '2026-07-01T00:00:00.000Z' }
].map(fold => ({
  ...fold,
  trainStartMs: Date.parse(fold.trainStart),
  trainEndMs: Date.parse(fold.trainEndExclusive),
  validationStartMs: Date.parse(fold.validationStart),
  validationEndMs: Date.parse(fold.validationEndExclusive),
  purgeCutoffMs: Date.parse(fold.validationStart) - PURGE_BARS * HOUR,
  embargoEndMs: Date.parse(fold.validationEndExclusive) + EMBARGO_BARS * HOUR
})));

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function finite(value) {
  return value != null && Number.isFinite(Number(value));
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function sideSign(side) {
  if (side === 'BUY') return 1;
  if (side === 'SELL') return -1;
  throw new Error(`invalid side ${side}`);
}

function directionalReturnBps(side, entryPrice, exitPrice) {
  return sideSign(side) * (exitPrice - entryPrice) / entryPrice * 10_000;
}

function sma(rows, index, period) {
  if (index < period - 1) return null;
  return mean(rows.slice(index - period + 1, index + 1).map(row => Number(row.close)));
}

function atr(rows, index, period = 20) {
  if (index < period) return null;
  const ranges = [];
  for (let cursor = index - period + 1; cursor <= index; cursor++) {
    const previousClose = rows[cursor - 1].close;
    ranges.push(Math.max(
      rows[cursor].high - rows[cursor].low,
      Math.abs(rows[cursor].high - previousClose),
      Math.abs(rows[cursor].low - previousClose)
    ));
  }
  return mean(ranges);
}

function aggregateBars(rows, intervalMs, count, label) {
  const output = [];
  for (let offset = 0; offset < rows.length;) {
    const bucket = Math.floor(rows[offset].openTime / intervalMs) * intervalMs;
    const bucketRows = [];
    while (offset < rows.length && Math.floor(rows[offset].openTime / intervalMs) * intervalMs === bucket) {
      bucketRows.push(rows[offset++]);
    }
    if (bucketRows.length !== count
      || bucketRows[0].openTime !== bucket
      || bucketRows.at(-1).openTime !== bucket + intervalMs - FIVE_MINUTES) {
      throw new Error(`${label}: incomplete ${intervalMs / HOUR}h bucket at ${new Date(bucket).toISOString()}`);
    }
    output.push({
      symbol: bucketRows[0].symbol,
      openTime: bucket,
      closeTime: bucket + intervalMs - 1,
      closeBoundary: bucket + intervalMs,
      open: bucketRows[0].open,
      high: Math.max(...bucketRows.map(row => row.high)),
      low: Math.min(...bucketRows.map(row => row.low)),
      close: bucketRows.at(-1).close,
      volume: bucketRows.reduce((sum, row) => sum + row.volume, 0),
      quoteVolume: bucketRows.reduce((sum, row) => sum + row.quoteVolume, 0),
      trades: bucketRows.reduce((sum, row) => sum + row.trades, 0)
    });
  }
  return output;
}

function loadRows(root, manifest, symbol, kind) {
  const files = manifest.files
    .filter(item => item.status === 200 && item.symbol === symbol && item.kind === kind)
    .sort((left, right) => String(left.month).localeCompare(String(right.month)));
  if (!files.length) throw new Error(`${symbol}: missing ${kind} source files`);
  const chunks = files.map(item => {
    const file = path.resolve(root, item.path);
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`source path escapes root: ${item.path}`);
    const buffer = fs.readFileSync(file);
    if (sha256(buffer) !== item.sha256) throw new Error(`source hash mismatch: ${item.path}`);
    return kind === 'kline'
      ? parseKlineArchive(buffer, symbol, 'contract')
      : parseFundingArchive(buffer, symbol);
  });
  return mergeUniqueSeries(chunks, kind === 'kline' ? 'openTime' : 'eventTime', `${symbol}/${kind}`);
}

export function loadHyExp0024Dataset({ root = ROOT } = {}) {
  const sourceBuffer = fs.readFileSync(path.join(root, 'artifacts', 'HY-EXP-0001', 'data-manifest.json'));
  const manifest = JSON.parse(sourceBuffer.toString('utf8'));
  if (manifest.experiment_id !== 'HY-EXP-0001' || manifest.missing_files > 0) {
    throw new Error('HY-EXP-0024 requires the complete locked HY-EXP-0001 public source manifest');
  }
  const bars5mBySymbol = {};
  const bars1hBySymbol = {};
  const bars4hBySymbol = {};
  const fundingBySymbol = {};
  const coverage = {};
  for (const symbol of HY_EXP_0024_SYMBOLS) {
    const bars5m = loadRows(root, manifest, symbol, 'kline');
    assertContiguous(bars5m, `${symbol}/5m`);
    const funding = loadRows(root, manifest, symbol, 'funding');
    const bars1h = aggregateBars(bars5m, HOUR, 12, `${symbol}/1h`);
    const bars4h = aggregateBars(bars5m, FOUR_HOURS, 48, `${symbol}/4h`);
    bars5mBySymbol[symbol] = bars5m;
    bars1hBySymbol[symbol] = bars1h;
    bars4hBySymbol[symbol] = bars4h;
    fundingBySymbol[symbol] = funding;
    coverage[symbol] = {
      fiveMinuteBars: bars5m.length,
      oneHourBars: bars1h.length,
      fourHourBars: bars4h.length,
      fundingRows: funding.length,
      firstBar: new Date(bars5m[0].openTime).toISOString(),
      lastBarExclusive: new Date(bars5m.at(-1).openTime + FIVE_MINUTES).toISOString()
    };
  }
  return {
    symbols: [...HY_EXP_0024_SYMBOLS],
    bars5mBySymbol,
    bars1hBySymbol,
    bars4hBySymbol,
    fundingBySymbol,
    coverage,
    sourceExperimentId: manifest.experiment_id,
    sourceManifestSha256: sha256(sourceBuffer),
    sourceManifest: manifest
  };
}

function latestCompletedFourHourIndex(rows, decisionTime) {
  let selected = -1;
  for (let index = 0; index < rows.length; index++) {
    if (rows[index].closeBoundary <= decisionTime) selected = index;
    else break;
  }
  return selected;
}

export function estimateHyExp0024FundingExpectation(rows, side, decisionTime) {
  let latest = null;
  for (const row of rows) {
    if (row.eventTime > decisionTime) break;
    latest = row;
  }
  if (!latest || !finite(latest.fundingRate) || !finite(latest.fundingIntervalHours) || latest.fundingIntervalHours <= 0) {
    return { usable: false, expectedFundingBps: null, nextFundingTime: null };
  }
  const nextFundingTime = latest.eventTime + latest.fundingIntervalHours * HOUR;
  if (nextFundingTime <= decisionTime) return { usable: false, expectedFundingBps: null, nextFundingTime };
  return {
    usable: true,
    latestFundingTime: latest.eventTime,
    latestFundingRate: latest.fundingRate,
    nextFundingTime,
    expectedFundingBps: nextFundingTime <= decisionTime + MAX_HOLD_BARS * HOUR
      ? -sideSign(side) * latest.fundingRate * 10_000
      : 0
  };
}

export function historicalExecutionOpenTime(theoreticalDecisionTime) {
  return Number(theoreticalDecisionTime) + HISTORICAL_EXECUTION_DELAY_MS;
}

export function selectExactHistoricalEntry({ theoreticalDecisionTime, bars }) {
  const requiredOpenTime = historicalExecutionOpenTime(theoreticalDecisionTime);
  const row = (bars ?? []).find(candidate => candidate.openTime === requiredOpenTime);
  return row
    ? { included: true, requiredOpenTime, entryPrice: row.open }
    : { included: false, requiredOpenTime, entryPrice: null };
}

function regimeAt({ bars4hBySymbol, fourHourIndex }) {
  if (fourHourIndex < 0) return null;
  const btc = bars4hBySymbol.BTCUSDT;
  const btcFast = sma(btc, fourHourIndex, 60);
  const btcSlow = sma(btc, fourHourIndex, 180);
  if (btcFast == null || btcSlow == null) return null;
  const breadthRequired = Math.ceil(HY_EXP_0024_SYMBOLS.length * 2 / 3);
  const breadthRows = Object.fromEntries(HY_EXP_0024_SYMBOLS.map(symbol => {
    const rows = bars4hBySymbol[symbol];
    const row = rows[fourHourIndex];
    const slow = sma(rows, fourHourIndex, 180);
    return [symbol, {
      close: row.close,
      slowSma: slow,
      aboveSlowSma: slow != null && row.close > slow,
      belowSlowSma: slow != null && row.close < slow
    }];
  }));
  const breadthAbove = Object.values(breadthRows).filter(row => row.aboveSlowSma).length;
  const breadthBelow = Object.values(breadthRows).filter(row => row.belowSlowSma).length;
  const bull = btcFast > btcSlow && btc[fourHourIndex].close > btcSlow && breadthAbove >= breadthRequired;
  const bear = btcFast < btcSlow && btc[fourHourIndex].close < btcSlow && breadthBelow >= breadthRequired;
  return {
    regime: bull ? 'BULL' : bear ? 'BEAR' : 'SIDEWAYS',
    side: bull ? 'BUY' : bear ? 'SELL' : null,
    btcFastSma: btcFast,
    btcSlowSma: btcSlow,
    breadth: bull ? breadthAbove : bear ? breadthBelow : Math.max(breadthAbove, breadthBelow),
    breadthFraction: (bull ? breadthAbove : bear ? breadthBelow : Math.max(breadthAbove, breadthBelow)) / HY_EXP_0024_SYMBOLS.length,
    breadthAbove,
    breadthBelow,
    breadthRequired,
    fourHourIndex,
    fourHourCloseTime: btc[fourHourIndex].closeBoundary,
    bySymbol: breadthRows
  };
}

function buildContext({ bars1hBySymbol, bars4hBySymbol, index }) {
  const btc1h = bars1hBySymbol.BTCUSDT;
  const signalBar = btc1h[index];
  if (!signalBar) return null;
  const decisionTime = signalBar.openTime + HOUR;
  const fourHourIndex = latestCompletedFourHourIndex(bars4hBySymbol.BTCUSDT, decisionTime);
  const regime = regimeAt({ bars4hBySymbol, fourHourIndex });
  if (!regime) return null;
  const symbols = {};
  for (const symbol of HY_EXP_0024_SYMBOLS) {
    const rows = bars1hBySymbol[symbol];
    const row = rows[index];
    if (!row || row.openTime !== signalBar.openTime) return null;
    const priorEntry = rows.slice(index - 120, index);
    const priorExit = rows.slice(index - 60, index);
    const atr20 = atr(rows, index, 20);
    const sma60 = sma(rows, index, 60);
    const sma180 = sma(rows, index, 180);
    const priorHigh = priorEntry.length === 120 ? Math.max(...priorEntry.map(item => item.high)) : null;
    const priorLow = priorEntry.length === 120 ? Math.min(...priorEntry.map(item => item.low)) : null;
    const priorExitHigh = priorExit.length === 60 ? Math.max(...priorExit.map(item => item.high)) : null;
    const priorExitLow = priorExit.length === 60 ? Math.min(...priorExit.map(item => item.low)) : null;
    const side = regime.side;
    const breakout = side === 'BUY'
      ? priorHigh != null && row.close > priorHigh
      : side === 'SELL'
        ? priorLow != null && row.close < priorLow
        : false;
    const sideMultiplier = side ? sideSign(side) : 1;
    const priorFourHour = bars4hBySymbol[symbol].slice(regime.fourHourIndex - 5, regime.fourHourIndex + 1);
    const priorSixQuoteVolume = priorFourHour.length === 6
      ? priorFourHour.reduce((sum, item) => sum + item.quoteVolume, 0)
      : null;
    const features = breakout && atr20 > 0 && sma60 != null && sma180 != null
      && priorExitLow != null && priorExitHigh != null && priorSixQuoteVolume != null
      ? [
        sideMultiplier * (row.close - (side === 'BUY' ? priorHigh : priorLow)) / atr20,
        sideMultiplier * (row.close - sma60) / atr20,
        sideMultiplier * (sma60 - sma180) / atr20,
        regime.breadthFraction,
        HY_EXP_0024_SYMBOLS.length / 8,
        Math.log1p(priorSixQuoteVolume),
        atr20 / row.close,
        sideMultiplier * (row.close - (side === 'BUY' ? priorExitLow : priorExitHigh)) / atr20
      ]
      : null;
    const reasons = [];
    if (regime.regime === 'SIDEWAYS') reasons.push('REGIME_SIDEWAYS');
    if (priorEntry.length !== 120) reasons.push('INSUFFICIENT_BREAKOUT_HISTORY');
    if (!breakout && regime.side) reasons.push('NO_BREAKOUT');
    if (!(atr20 > 0)) reasons.push('INVALID_ATR20');
    if (features == null && breakout) reasons.push('MISSING_CAUSAL_FEATURE');
    symbols[symbol] = {
      symbol,
      side,
      breakout,
      signalClose: row.close,
      atr20,
      sma60,
      sma180,
      priorEntryHigh: priorHigh,
      priorEntryLow: priorLow,
      priorExitHigh,
      priorExitLow,
      priorSixCompleted4hQuoteVolume: priorSixQuoteVolume,
      features,
      reasons
    };
  }
  return {
    signalTime: decisionTime,
    theoreticalDecisionTime: decisionTime,
    index,
    regime,
    symbols,
    universeSymbols: [...HY_EXP_0024_SYMBOLS]
  };
}

function appendMark(marks, side, row, entryPrice) {
  const values = side === 'BUY'
    ? [row.low, row.high, row.close]
    : [row.high, row.low, row.close];
  values.forEach((price, index) => marks.push({
    time: row.openTime + index,
    price,
    returnBps: directionalReturnBps(side, entryPrice, price)
  }));
}

function exactEntryAndExit({ candidate, bars1h, bars5m, fiveByOpenTime }) {
  const requiredOpenTime = historicalExecutionOpenTime(candidate.theoreticalDecisionTime);
  const entryBar = fiveByOpenTime.get(requiredOpenTime);
  if (!entryBar) return { usable: false, rejection: 'MISSING_EXACT_5M_EXECUTION_PROXY' };
  const entryPrice = entryBar.open;
  const stopPrice = candidate.side === 'BUY'
    ? entryPrice - 2 * candidate.atr20
    : entryPrice + 2 * candidate.atr20;
  if (!(stopPrice > 0)) return { usable: false, rejection: 'INVALID_STOP_PRICE' };
  const evaluationBars = bars1h
    .map((row, index) => ({ row, index }))
    .filter(item => item.row.closeBoundary > requiredOpenTime)
    .slice(0, MAX_HOLD_BARS);
  if (evaluationBars.length < MAX_HOLD_BARS) return { usable: false, rejection: 'INSUFFICIENT_FORWARD_LABEL_BARS' };
  let cursor = requiredOpenTime;
  const marks = [];
  let exit = null;
  for (const { row, index } of evaluationBars) {
    const periodRows = [];
    for (let openTime = cursor; openTime < row.closeBoundary; openTime += FIVE_MINUTES) {
      const five = fiveByOpenTime.get(openTime);
      if (!five) return { usable: false, rejection: 'MISSING_FORWARD_5M_LABEL_BAR' };
      periodRows.push(five);
    }
    for (const five of periodRows) {
      appendMark(marks, candidate.side, five, entryPrice);
      if (candidate.side === 'BUY') {
        if (five.open <= stopPrice) {
          exit = { price: five.open, time: five.openTime, reason: 'ATR_STOP' };
          break;
        }
        if (five.low <= stopPrice) {
          exit = { price: stopPrice, time: five.openTime + 1, reason: 'ATR_STOP' };
          break;
        }
      } else {
        if (five.open >= stopPrice) {
          exit = { price: five.open, time: five.openTime, reason: 'ATR_STOP' };
          break;
        }
        if (five.high >= stopPrice) {
          exit = { price: stopPrice, time: five.openTime + 1, reason: 'ATR_STOP' };
          break;
        }
      }
    }
    if (exit) break;
    const priorChannel = bars1h.slice(index - 60, index);
    if (priorChannel.length !== 60) return { usable: false, rejection: 'MISSING_CHANNEL_HISTORY' };
    const channelLow = Math.min(...priorChannel.map(item => item.low));
    const channelHigh = Math.max(...priorChannel.map(item => item.high));
    const channelTriggered = candidate.side === 'BUY'
      ? row.close <= channelLow
      : row.close >= channelHigh;
    if (channelTriggered) {
      exit = { price: row.close, time: row.closeBoundary, reason: 'DYNAMIC_CHANNEL_EXIT' };
      break;
    }
    cursor = row.closeBoundary;
    if (evaluationBars.at(-1).row.openTime === row.openTime) {
      exit = { price: row.close, time: row.closeBoundary, reason: 'TERMINAL_EXIT' };
    }
  }
  if (!exit) return { usable: false, rejection: 'MISSING_FROZEN_EXIT_LABEL' };
  const realizedFunding = realizedFundingForTrade({
    side: candidate.side,
    entryPrice,
    entryTime: requiredOpenTime,
    exitTime: exit.time,
    rows: candidate.fundingRows,
    bars5m
  });
  const grossPriceReturnBps = directionalReturnBps(candidate.side, entryPrice, exit.price);
  return {
    usable: true,
    entryTime: requiredOpenTime,
    entryPrice,
    stopPrice,
    exitTime: exit.time,
    exitPrice: exit.price,
    exitReason: exit.reason,
    labelEndTime: exit.time,
    grossPriceReturnBps,
    realizedFunding,
    marks,
    historicalExecutionProxy: {
      source: 'Binance USD-M contract-price archived 5m bar',
      requiredOpenTime,
      exact: true,
      notL2: true,
      laterBarRescue: false
    }
  };
}

function realizedFundingForTrade({ side, entryPrice, entryTime, exitTime, rows, bars5m }) {
  let fundingPnl = 0;
  const details = [];
  for (const row of rows) {
    if (row.eventTime < entryTime || row.eventTime > exitTime) continue;
    let markPrice = entryPrice;
    for (const bar of bars5m) {
      if (bar.openTime > row.eventTime) break;
      markPrice = bar.close;
    }
    const payment = -sideSign(side) * (markPrice * row.fundingRate);
    fundingPnl += payment;
    details.push({ fundingTime: row.eventTime, fundingRate: row.fundingRate, markPrice, payment });
  }
  const fundingPnlBps = fundingPnl / entryPrice * 10_000;
  return { fundingPnlBps, fundingPnlPerUnit: fundingPnl, events: details };
}

function candidateRows(dataset) {
  const reference = dataset.bars1hBySymbol.BTCUSDT;
  const firstIndex = Math.max(180 * 4, 180, 120, 60, 20);
  const contexts = [];
  const candidates = [];
  let rawCandidateCount = 0;
  const fiveMaps = Object.fromEntries(HY_EXP_0024_SYMBOLS.map(symbol => [
    symbol,
    new Map(dataset.bars5mBySymbol[symbol].map(row => [row.openTime, row]))
  ]));
  for (let index = firstIndex; index < reference.length; index++) {
    const context = buildContext({ bars1hBySymbol: dataset.bars1hBySymbol, bars4hBySymbol: dataset.bars4hBySymbol, index });
    if (!context) continue;
    contexts.push(context);
    for (const symbol of HY_EXP_0024_SYMBOLS) {
      const detail = context.symbols[symbol];
      if (!detail.breakout || !detail.features || !context.regime.side) continue;
      rawCandidateCount++;
      const funding = estimateHyExp0024FundingExpectation(dataset.fundingBySymbol[symbol], detail.side, context.theoreticalDecisionTime);
      const base = {
        id: `${symbol}:${context.theoreticalDecisionTime}`,
        experimentId: HY_EXP_0024_EXPERIMENT_ID,
        symbol,
        side: detail.side,
        regime: context.regime.regime,
        cell: `${context.regime.regime}/${detail.side}/TREND_BREAKOUT`,
        signalTime: context.signalTime,
        decisionTime: context.signalTime,
        theoreticalDecisionTime: context.theoreticalDecisionTime,
        features: detail.features,
        atr20: detail.atr20,
        priorExitLow: detail.priorExitLow,
        priorExitHigh: detail.priorExitHigh,
        regimeBreadthFraction: context.regime.breadthFraction,
        eligibleSymbolCount: HY_EXP_0024_SYMBOLS.length,
        fundingRows: dataset.fundingBySymbol[symbol],
        expectedFunding: funding,
        schedulerDelayMs: 0,
        candidate: true,
        candidateAuthority: 'NONE'
      };
      const label = exactEntryAndExit({
        candidate: base,
        bars1h: dataset.bars1hBySymbol[symbol],
        bars5m: dataset.bars5mBySymbol[symbol],
        fiveByOpenTime: fiveMaps[symbol]
      });
      if (label.usable) candidates.push({ ...base, label });
    }
  }
  return { contexts, candidates, fiveMaps, rawCandidateCount };
}

function rowsForFold(candidates, fold) {
  return candidates.filter(row => row.signalTime >= fold.trainStartMs
    && row.signalTime < fold.trainEndMs
    && row.label.labelEndTime <= fold.purgeCutoffMs
    && row.cell);
}

function validationRows(candidates, fold) {
  return candidates.filter(row => row.signalTime >= fold.validationStartMs
    && row.signalTime < fold.validationEndMs
    && row.label.labelEndTime < DEVELOPMENT_END);
}

function modelPredictions(candidates) {
  const output = [];
  const modelSummaries = [];
  for (const fold of FOLDS) {
    const validation = validationRows(candidates, fold);
    const byCell = {};
    for (const cell of ['BULL/BUY/TREND_BREAKOUT', 'BEAR/SELL/TREND_BREAKOUT']) {
      const training = rowsForFold(candidates.filter(row => row.cell === cell), fold);
      const models = Object.fromEntries(HY_EXP_0024_SENSITIVITY_LAMBDAS.map(lambda => [
        String(lambda), fitHyExp0024Ridge(training.map(row => ({ features: row.features, targetBps: row.label.grossPriceReturnBps })), {
          lambda,
          minimumSamples: HY_EXP_0024_MINIMUM_SAMPLES,
          cell
        })
      ]));
      byCell[cell] = { trainingSampleSize: training.length, models };
    }
    modelSummaries.push({
      id: fold.id,
      trainStart: fold.trainStart,
      trainEndExclusive: fold.trainEndExclusive,
      validationStart: fold.validationStart,
      validationEndExclusive: fold.validationEndExclusive,
      purgeBars: PURGE_BARS,
      embargoBars: EMBARGO_BARS,
      cells: Object.fromEntries(Object.entries(byCell).map(([cell, value]) => [cell, {
        trainingSampleSize: value.trainingSampleSize,
        primaryAvailable: Boolean(value.models[String(HY_EXP_0024_PRIMARY_LAMBDA)]),
        sensitivityAvailable: Object.fromEntries(Object.entries(value.models).map(([lambda, model]) => [lambda, Boolean(model)]))
      }]))
    });
    for (const row of validation) {
      const cellModels = byCell[row.cell];
      const primary = predictHyExp0024Ridge(cellModels?.models[String(HY_EXP_0024_PRIMARY_LAMBDA)] ?? null, row.features, {
        sampleSize: cellModels?.trainingSampleSize ?? 0,
        validationWindow: {
          foldId: fold.id,
          trainStart: fold.trainStart,
          trainEndExclusive: fold.trainEndExclusive,
          validationStart: fold.validationStart,
          validationEndExclusive: fold.validationEndExclusive,
          purgeBars: PURGE_BARS,
          embargoBars: EMBARGO_BARS,
          method: 'expanding_walk_forward_purged'
        }
      });
      const sensitivity = Object.fromEntries(HY_EXP_0024_SENSITIVITY_LAMBDAS.map(lambda => [
        String(lambda), predictHyExp0024Ridge(cellModels?.models[String(lambda)] ?? null, row.features, {
          sampleSize: cellModels?.trainingSampleSize ?? 0,
          validationWindow: primary.validationWindow
        })
      ]));
      output.push({
        ...row,
        foldId: fold.id,
        edge: primary,
        sensitivity
      });
    }
  }
  return { rows: output, modelSummaries };
}

function positionSize(row) {
  const stopDistanceBps = Math.abs(row.label.entryPrice - row.label.stopPrice) / row.label.entryPrice * 10_000;
  if (!(stopDistanceBps > 0)) return null;
  const lossBudget = RESEARCH_EQUITY_USDT * 0.0025;
  const riskNotional = lossBudget / (stopDistanceBps / 10_000);
  const notional = Math.min(riskNotional, RESEARCH_EQUITY_USDT * 0.5);
  return {
    notional,
    quantity: notional / row.label.entryPrice,
    stopDistanceBps,
    lossAtStop: notional * stopDistanceBps / 10_000
  };
}

function activePositionRows(trades, decisionTime) {
  return trades.filter(trade => trade.decisionTime <= decisionTime && trade.exitTime > decisionTime);
}

function portfolioGate(row, size, admitted) {
  const open = activePositionRows(admitted, row.decisionTime).map(trade => ({
    symbol: trade.symbol,
    side: trade.side,
    notional: trade.notional,
    beta: 1,
    lossAtStop: trade.lossAtStop,
    cluster: trade.cluster
  }));
  if (open.some(position => position.symbol === row.symbol)) {
    return { decision: 'NO_TRADE', reasons: ['POSITION_ALREADY_OPEN'], metrics: null };
  }
  return evaluatePortfolioRisk({
    equity: RESEARCH_EQUITY_USDT,
    positions: [...open, {
      symbol: row.symbol,
      side: row.side,
      notional: size.notional,
      beta: 1,
      lossAtStop: size.lossAtStop,
      cluster: row.cluster
    }],
    limits: {
      maximumPositions: 5,
      maximumGrossLeverage: 1,
      maximumNetExposureFraction: 0.2,
      maximumBetaExposureFraction: 0.2,
      maximumPortfolioLossFraction: 0.02,
      maximumSinglePositionFraction: 0.5,
      maximumClusterLossFraction: 0.01
    }
  });
}

function buildTrade(row, size, baseGate, stressGate, portfolio) {
  const fundingPnlBps = row.label.realizedFunding.fundingPnlBps;
  const baseNetReturnBps = row.label.grossPriceReturnBps - HISTORICAL_BASE_COST_BPS + fundingPnlBps;
  const stressNetReturnBps = row.label.grossPriceReturnBps - HISTORICAL_STRESS_COST_BPS + fundingPnlBps;
  return {
    experimentId: HY_EXP_0024_EXPERIMENT_ID,
    phase: 'development',
    id: row.id,
    symbol: row.symbol,
    side: row.side,
    regime: row.regime,
    cell: row.cell,
    signalTime: row.signalTime,
    decisionTime: row.decisionTime,
    theoreticalDecisionTime: row.theoreticalDecisionTime,
    schedulerDelayMs: row.schedulerDelayMs,
    entryTime: row.label.entryTime,
    entryPrice: row.label.entryPrice,
    executablePrice: row.label.entryPrice,
    exitTime: row.label.exitTime,
    exitPrice: row.label.exitPrice,
    exitReason: row.label.exitReason,
    stopPrice: row.label.stopPrice,
    quantity: size.quantity,
    notional: size.notional,
    lossAtStop: size.lossAtStop,
    cluster: `${row.regime}:${row.signalTime}`,
    grossPriceReturnBps: row.label.grossPriceReturnBps,
    expectedPriceEdgeBps: row.edge.expectedPriceEdgeBps,
    standardErrorBps: row.edge.standardErrorBps,
    edgeSource: row.edge.edgeSource,
    edgeModelId: row.edge.edgeModelId,
    edgeSampleSize: row.edge.sampleSize,
    validationWindow: row.edge.validationWindow,
    expectedFundingBps: row.expectedFunding.expectedFundingBps,
    realizedFundingBps: fundingPnlBps,
    realizedFunding: row.label.realizedFunding,
    costs: {
      baseTotalBps: HISTORICAL_BASE_COST_BPS,
      stressTotalBps: HISTORICAL_STRESS_COST_BPS,
      feeBps: 10,
      spreadAndBookProxyBps: 4,
      impactBps: 2,
      latencyBps: 2,
      fundingPnlBps
    },
    netReturnBps: baseNetReturnBps,
    stressNetReturnBps,
    netPnl: size.notional * baseNetReturnBps / 10_000,
    stressNetPnl: size.notional * stressNetReturnBps / 10_000,
    maeBps: Math.min(...row.label.marks.map(mark => mark.returnBps)),
    mfeBps: Math.max(...row.label.marks.map(mark => mark.returnBps)),
    markToMarketDrawdownBps: markDrawdown(row.label.marks),
    marks: row.label.marks,
    edgeGate: baseGate,
    stressEdgeGate: stressGate,
    portfolioGate,
    paperOnly: true,
    liveOrdersEnabled: false
  };
}

function markDrawdown(marks) {
  let peak = -Infinity;
  let drawdown = 0;
  for (const mark of marks) {
    peak = Math.max(peak, mark.returnBps);
    drawdown = Math.max(drawdown, peak - mark.returnBps);
  }
  return drawdown;
}

function admitAdvisories(rows) {
  const admitted = [];
  const diagnostics = [];
  for (const row of rows.sort((left, right) => left.decisionTime - right.decisionTime || left.symbol.localeCompare(right.symbol))) {
    const reasons = [];
    const size = row.edge.available ? positionSize(row) : null;
    if (!size) reasons.push('SIZE_UNAVAILABLE');
    if (!row.expectedFunding.usable) reasons.push('MISSING_OR_INVALID_FUNDING_SCHEDULE');
    const baseGate = edgeGateFromPrediction(row.edge, row.expectedFunding.expectedFundingBps ?? 0, Math.abs(row.expectedFunding.expectedFundingBps ?? 0) + FUNDING_STRESS_BUFFER_BPS);
    const stressGate = edgeGateFromPrediction(row.edge, row.expectedFunding.expectedFundingBps ?? 0, Math.abs(row.expectedFunding.expectedFundingBps ?? 0) + FUNDING_STRESS_BUFFER_BPS, {
      executionCostBps: HISTORICAL_BASE_COST_BPS,
      stressMultiplier: 1.5
    });
    if (baseGate.decision !== 'TRADE') reasons.push(...baseGate.reasons);
    let portfolio = null;
    if (!reasons.length) {
      portfolio = portfolioGate(row, size, admitted);
      if (portfolio.decision !== 'PORTFOLIO_ALLOWED') reasons.push(...portfolio.reasons.map(reason => `PORTFOLIO_${reason}`));
    }
    if (!reasons.length) {
      const trade = buildTrade(row, size, baseGate, stressGate, portfolio);
      admitted.push(trade);
      diagnostics.push({ id: row.id, status: 'ADVISORY', reasons: [], edge: row.edge, baseGate, stressGate, portfolio });
    } else {
      diagnostics.push({ id: row.id, status: 'NO_SIGNAL', reasons: [...new Set(reasons)], edge: row.edge, baseGate, stressGate, portfolio });
    }
  }
  return { admitted, diagnostics };
}

function monthKeys(start, endExclusive) {
  const output = [];
  const cursor = new Date(start);
  cursor.setUTCDate(1);
  const end = new Date(endExclusive);
  while (cursor < end) {
    output.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return output;
}

function contributionAt(trade, time) {
  if (time < trade.entryTime) return 0;
  if (time >= trade.exitTime) return trade.netPnl;
  let mark = { returnBps: 0 };
  for (const candidate of trade.marks) {
    if (candidate.time > time) break;
    mark = candidate;
  }
  const funding = trade.realizedFunding.details
    .filter(row => row.fundingTime <= time)
    .reduce((sum, row) => sum + row.payment / trade.entryPrice * trade.notional, 0);
  return trade.notional * mark.returnBps / 10_000 - trade.notional * 9 / 10_000 + funding;
}

function markToMarketMetrics(trades) {
  const times = new Set([DEVELOPMENT_START, DEVELOPMENT_END - 1]);
  for (const trade of trades) {
    times.add(trade.entryTime);
    times.add(trade.exitTime);
    for (const mark of trade.marks) times.add(mark.time);
    for (const funding of trade.realizedFunding.details) times.add(funding.fundingTime);
  }
  const curve = [...times].sort((a, b) => a - b).map(time => ({
    time,
    equity: RESEARCH_EQUITY_USDT + trades.reduce((sum, trade) => sum + contributionAt(trade, time), 0)
  }));
  let peak = RESEARCH_EQUITY_USDT;
  let maxDrawdown = 0;
  for (const row of curve) {
    peak = Math.max(peak, row.equity);
    maxDrawdown = Math.max(maxDrawdown, 1 - row.equity / peak);
  }
  const daily = new Map();
  for (const row of curve) daily.set(new Date(row.time).toISOString().slice(0, 10), row.equity);
  const dailyEquity = [...daily.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, equity]) => equity);
  const dailyReturns = dailyEquity.slice(1).map((equity, index) => equity / dailyEquity[index] - 1).sort((a, b) => a - b);
  const tailCount = dailyReturns.length ? Math.max(1, Math.ceil(dailyReturns.length * 0.05)) : 0;
  const cvarLoss = tailCount ? -mean(dailyReturns.slice(0, tailCount)) : null;
  return {
    maxMtmDrawdown: maxDrawdown,
    maxMtmDrawdownBps: maxDrawdown * 10_000,
    cvar95LossFraction: cvarLoss,
    cvar95LossBps: cvarLoss == null ? null : cvarLoss * 10_000,
    curvePoints: curve.length,
    dailyObservations: dailyReturns.length
  };
}

function summarizeTrades(trades, diagnostics, candidateStats, calibration, sensitivity) {
  const candidates = candidateStats.predictionRows;
  const ordered = [...trades].sort((a, b) => a.exitTime - b.exitTime || a.symbol.localeCompare(b.symbol));
  const positive = ordered.filter(row => row.netPnl > 0);
  const negative = ordered.filter(row => row.netPnl < 0);
  const positivePnl = positive.reduce((sum, row) => sum + row.netPnl, 0);
  const negativePnl = negative.reduce((sum, row) => sum + row.netPnl, 0);
  const netPnl = ordered.reduce((sum, row) => sum + row.netPnl, 0);
  const stressPnl = ordered.reduce((sum, row) => sum + row.stressNetPnl, 0);
  const months = monthKeys(DEVELOPMENT_START, DEVELOPMENT_END);
  const monthly = Object.fromEntries(months.map(month => [month, 0]));
  const stressMonthly = Object.fromEntries(months.map(month => [month, 0]));
  for (const trade of ordered) {
    const month = new Date(trade.exitTime).toISOString().slice(0, 7);
    if (month in monthly) {
      monthly[month] += trade.netPnl;
      stressMonthly[month] += trade.stressNetPnl;
    }
  }
  let lossStreak = 0;
  let currentLossStreak = 0;
  for (const trade of ordered) {
    if (trade.netPnl < 0) currentLossStreak++;
    else currentLossStreak = 0;
    lossStreak = Math.max(lossStreak, currentLossStreak);
  }
  const mtm = markToMarketMetrics(ordered);
  const cellRows = Object.fromEntries(['BULL/BUY/TREND_BREAKOUT', 'BEAR/SELL/TREND_BREAKOUT'].map(cell => {
    const rows = ordered.filter(row => row.cell === cell);
    return [cell, {
      advisories: rows.length,
      symbols: [...new Set(rows.map(row => row.symbol))].sort(),
      months: [...new Set(rows.map(row => new Date(row.exitTime).toISOString().slice(0, 7)))].sort(),
      netPnl: rows.reduce((sum, row) => sum + row.netPnl, 0)
    }];
  }));
  const fullDays = (DEVELOPMENT_END - DEVELOPMENT_START) / DAY;
  const bySymbol = Object.fromEntries(HY_EXP_0024_SYMBOLS.map(symbol => [
    symbol,
    ordered.filter(row => row.symbol === symbol).reduce((sum, row) => sum + row.netPnl, 0)
  ]));
  const bestFive = positive.slice().sort((a, b) => b.netPnl - a.netPnl).slice(0, 5).reduce((sum, row) => sum + row.netPnl, 0);
  const reasonCounts = {};
  for (const item of diagnostics) for (const reason of item.reasons ?? []) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
  const baseExpectancy = ordered.length ? ordered.reduce((sum, row) => sum + row.netReturnBps, 0) / ordered.length : null;
  const stressExpectancy = ordered.length ? ordered.reduce((sum, row) => sum + row.stressNetReturnBps, 0) / ordered.length : null;
  const basePF = negativePnl < 0 ? positivePnl / Math.abs(negativePnl) : positivePnl > 0 ? Infinity : null;
  const stressPositive = ordered.filter(row => row.stressNetPnl > 0).reduce((sum, row) => sum + row.stressNetPnl, 0);
  const stressNegative = ordered.filter(row => row.stressNetPnl < 0).reduce((sum, row) => sum + row.stressNetPnl, 0);
  return {
    candidateCount: candidateStats.rawCandidateCount,
    labeledCandidateCount: candidates.length,
    edgeAvailableCount: candidates.filter(row => row.edge?.available).length,
    advisoryCount: ordered.length,
    tradeCount: ordered.length,
    usableAdvisoriesPer30CalendarDays: ordered.length * 30 / fullDays,
    netExpectancyBps: baseExpectancy,
    netProfitFactor: basePF,
    netReturn: netPnl / RESEARCH_EQUITY_USDT,
    netReturnBps: netPnl / RESEARCH_EQUITY_USDT * 10_000,
    positiveMonths: months.filter(month => monthly[month] > 0).length,
    observedMonths: months.length,
    positiveMonthShare: months.length ? months.filter(month => monthly[month] > 0).length / months.length : null,
    monthlyNetPnl: monthly,
    best5Concentration: positivePnl > 0 ? bestFive / positivePnl : null,
    maxLossStreak: lossStreak,
    maxMtmDrawdown: mtm.maxMtmDrawdown,
    maxMtmDrawdownBps: mtm.maxMtmDrawdownBps,
    cvar95LossFraction: mtm.cvar95LossFraction,
    cvar95LossBps: mtm.cvar95LossBps,
    fundingPnl: ordered.reduce((sum, row) => sum + row.realizedFunding.fundingPnlPerUnit * row.notional / row.entryPrice, 0),
    feeBpsPerRoundTrip: 10,
    executionCostBps: HISTORICAL_BASE_COST_BPS,
    stress: {
      netExpectancyBps: stressExpectancy,
      netProfitFactor: stressNegative < 0 ? stressPositive / Math.abs(stressNegative) : stressPositive > 0 ? Infinity : null,
      netReturn: stressPnl / RESEARCH_EQUITY_USDT,
      positiveMonths: months.filter(month => stressMonthly[month] > 0).length,
      executionCostBps: HISTORICAL_STRESS_COST_BPS,
      noReoptimization: true
    },
    bullBuyAdvisoryCount: ordered.filter(row => row.cell === 'BULL/BUY/TREND_BREAKOUT').length,
    bearSellAdvisoryCount: ordered.filter(row => row.cell === 'BEAR/SELL/TREND_BREAKOUT').length,
    cellBreadth: cellRows,
    symbolBreadth: {
      traded: Object.values(bySymbol).filter(value => value !== 0).length,
      available: HY_EXP_0024_SYMBOLS.length,
      bySymbol
    },
    regimeBreadth: {
      bullBuy: cellRows['BULL/BUY/TREND_BREAKOUT'],
      bearSell: cellRows['BEAR/SELL/TREND_BREAKOUT']
    },
    calibration,
    lambdaSensitivity: sensitivity,
    rejectionReasons: reasonCounts,
    marks: mtm,
    paperOnly: true,
    liveOrdersEnabled: false
  };
}

function fastTrackGates(metrics) {
  const checks = {
    netProfitFactorGreaterThan1_10: metrics.netProfitFactor != null && metrics.netProfitFactor > 1.1,
    netExpectancyPositive: metrics.netExpectancyBps != null && metrics.netExpectancyBps > 0,
    usableAdvisoriesPer30AtLeast10: metrics.usableAdvisoriesPer30CalendarDays >= 10,
    maxMtmDrawdownAtMost15Percent: metrics.maxMtmDrawdown <= 0.15
  };
  return { checks, pass: Object.values(checks).every(Boolean) };
}

function fullDevelopmentGates(metrics) {
  const checks = {
    advisoryCountMin220: metrics.advisoryCount >= 220,
    frequencyMin12Per30: metrics.usableAdvisoriesPer30CalendarDays >= 12,
    bullBuyMin72: metrics.bullBuyAdvisoryCount >= 72,
    bearSellMin72: metrics.bearSellAdvisoryCount >= 72,
    bullSymbolsMin6: metrics.cellBreadth['BULL/BUY/TREND_BREAKOUT'].symbols.length >= 6,
    bearSymbolsMin6: metrics.cellBreadth['BEAR/SELL/TREND_BREAKOUT'].symbols.length >= 6,
    baseExpectancyMin8: metrics.netExpectancyBps >= 8,
    basePfMin1_2: metrics.netProfitFactor >= 1.2,
    positiveMonthShareMin0_6: metrics.positiveMonthShare >= 0.6,
    maxDrawdownMax0_12: metrics.maxMtmDrawdown <= 0.12,
    cvarMax0_05: metrics.cvar95LossFraction != null && metrics.cvar95LossFraction <= 0.05,
    lossStreakMax8: metrics.maxLossStreak <= 8,
    stressExpectancyMin3: metrics.stress.netExpectancyBps >= 3,
    stressPfMin1_05: metrics.stress.netProfitFactor >= 1.05
  };
  return { checks, pass: Object.values(checks).every(Boolean) };
}

export function runHyExp0024Development({ dataset = loadHyExp0024Dataset() } = {}) {
  const draftBuffer = fs.readFileSync(DRAFT);
  const formal = JSON.parse(fs.readFileSync(FORMAL_PREREG, 'utf8'));
  if (formal.status !== 'PREREGISTERED') throw new Error('HY-EXP-0024 is not formally preregistered');
  if (String(formal.frozenSpecification.sourceSha256).toLowerCase() !== sha256(draftBuffer)) throw new Error('frozen HY-EXP-0024 draft hash mismatch');
  const { contexts, candidates, rawCandidateCount } = candidateRows(dataset);
  const { rows: predictions, modelSummaries } = modelPredictions(candidates);
  const calibrationRows = predictions
    .filter(row => row.edge.available)
    .map(row => ({
      cell: row.cell,
      predictedBps: row.edge.expectedPriceEdgeBps,
      realizedBps: row.label.grossPriceReturnBps,
      signalTime: row.signalTime
    }));
  const calibration = summarizeHyExp0024Calibration(calibrationRows);
  const { admitted, diagnostics } = admitAdvisories(predictions);
  const sensitivity = Object.fromEntries(HY_EXP_0024_SENSITIVITY_LAMBDAS.map(lambda => {
    const rows = predictions.filter(row => row.sensitivity[String(lambda)]?.available);
    const gated = rows.map(row => ({
      ...row,
      edge: row.sensitivity[String(lambda)]
    }));
    const result = admitAdvisories(gated).admitted;
    const positive = result.filter(row => row.netPnl > 0).reduce((sum, row) => sum + row.netPnl, 0);
    const negative = result.filter(row => row.netPnl < 0).reduce((sum, row) => sum + row.netPnl, 0);
    return [String(lambda), {
      edgeAvailable: rows.length,
      advisoryCount: result.length,
      netExpectancyBps: result.length ? mean(result.map(row => row.netReturnBps)) : null,
      netProfitFactor: negative < 0 ? positive / Math.abs(negative) : positive > 0 ? Infinity : null,
      primaryLambda: lambda === HY_EXP_0024_PRIMARY_LAMBDA,
      selectionAfterOutcomes: false
    }];
  }));
  const metrics = summarizeTrades(admitted, diagnostics, {
    rawCandidateCount,
    predictionRows: predictions
  }, calibration, sensitivity);
  const fastGates = fastTrackGates(metrics);
  const developmentGates = fullDevelopmentGates(metrics);
  return {
    experimentId: HY_EXP_0024_EXPERIMENT_ID,
    status: fastGates.pass ? 'EXPERIMENTAL_SIGNAL_ONLY_REVIEW_REQUIRED' : 'EXPERIMENTAL_RELEASE_BLOCKED',
    evidenceClass: 'D0_DEVELOPMENT_ONLY',
    authorization: 'PAPER_ONLY',
    signalOnly: true,
    liveOrdersEnabled: false,
    accountApi: false,
    orderApi: false,
    development: {
      start: new Date(DEVELOPMENT_START).toISOString(),
      endExclusive: new Date(DEVELOPMENT_END).toISOString(),
      sourceManifestSha256: dataset.sourceManifestSha256,
      preregistrationSha256: sha256(fs.readFileSync(FORMAL_PREREG)),
      frozenDraftSha256: sha256(draftBuffer),
      contexts: contexts.length,
      candidates: rawCandidateCount,
      labeledCandidates: candidates.length,
      predictions: predictions.length,
      modelSummaries,
      metrics,
      fastTrackGates: fastGates,
      fullDevelopmentGates: developmentGates,
      experimentalReleaseReady: fastGates.pass,
      finalOosRead: false,
      finalOosEvaluation: 'LOCKED_UNTIL_SEPARATE_DEVELOPMENT_PASS_AND_FINAL_WINDOW_COMPLETION',
      noParameterRescue: true
    },
    model: {
      modelId: HY_EXP_0024_EDGE_MODEL_ID,
      edgeSource: HY_EXP_0024_EDGE_SOURCE,
      netEdgeModelId: 'HENGYU-NET-EDGE-001',
      developmentNetEdgeMode: 'HISTORICAL_DEVELOPMENT_NET_EDGE_PROXY_18_BPS',
      prospectiveNetEdgeMode: 'HENGYU-NET-EDGE-001_WITH_REAL_CAUSAL_BOOK',
      architecture: 'Candidate -> Edge Model -> Net Edge Gate -> Portfolio Risk Gate -> Advisory',
      candidateDecisionAuthority: 'NONE',
      primaryLambda: HY_EXP_0024_PRIMARY_LAMBDA,
      sensitivityLambdas: [...HY_EXP_0024_SENSITIVITY_LAMBDAS],
      minimumSamplesPerCell: HY_EXP_0024_MINIMUM_SAMPLES,
      cells: ['BULL/BUY/TREND_BREAKOUT', 'BEAR/SELL/TREND_BREAKOUT'],
      features: [...HY_EXP_0024_FEATURES],
      target: 'GROSS_DIRECTIONAL_PRICE_RETURN_BPS_BEFORE_COSTS_AND_FUNDING',
      noPooledMean: true,
      purgeBars: PURGE_BARS,
      embargoBars: EMBARGO_BARS,
      calibrationPopulation: 'OOF Edge-available primary candidates before Net Edge and Portfolio Risk filtering'
    },
    oos: {
      read: false,
      computed: false,
      status: 'SEALED',
      reason: 'Development result is not a final-OOS result and no final-OOS data was read.'
    },
    trades: admitted,
    diagnostics,
    promotionEligible: false,
    experimentalReleaseReady: fastGates.pass,
    deploymentPrepared: false,
    blockers: fastGates.pass
      ? ['Experimental signal-only release requires separate human deployment approval; no deployment performed.']
      : ['Fast-track Development gate failed; stop; do not deploy or read Final OOS.']
  };
}

export function buildHyExp0024Manifest({ root = ROOT } = {}) {
  const sourceBuffer = fs.readFileSync(path.join(root, 'artifacts', 'HY-EXP-0001', 'data-manifest.json'));
  const preregBuffer = fs.readFileSync(path.join(root, 'registry', 'experiments', HY_EXP_0024_EXPERIMENT_ID, 'preregistration.json'));
  const draftBuffer = fs.readFileSync(path.join(root, 'artifacts', 'audits', 'HY-EXP-0024-preregistration-draft.json'));
  return {
    experimentId: HY_EXP_0024_EXPERIMENT_ID,
    evidenceClass: 'D0_DEVELOPMENT_ONLY',
    sourceExperimentId: 'HY-EXP-0001',
    sourceManifestSha256: sha256(sourceBuffer),
    preregistrationSha256: sha256(preregBuffer),
    frozenDraftSha256: sha256(draftBuffer),
    developmentStart: new Date(DEVELOPMENT_START).toISOString(),
    developmentEndExclusive: new Date(DEVELOPMENT_END).toISOString(),
    finalOosRead: false,
    developmentPnlComputed: true,
    finalOosPnlComputed: false,
    paperOnly: true,
    liveOrdersEnabled: false,
    sourceRule: 'Binance official public contract klines and funding from locked HY-EXP-0001 manifest; no historical L2 or current metadata backfill.'
  };
}

export { FOLDS };
