import { inflateRawSync } from 'node:zlib';

export const FIVE_MINUTES = 5 * 60 * 1000;

export function normalizeTimestamp(value) {
  const number = Number(value);
  return number > 1e14 ? Math.floor(number / 1000) : number;
}

export function unzipSingle(buffer) {
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP end-of-central-directory record is unavailable');
  const entries = buffer.readUInt16LE(eocd + 10);
  if (entries !== 1) throw new Error(`expected one ZIP member, received ${entries}`);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (buffer.readUInt32LE(centralOffset) !== 0x02014b50) throw new Error('invalid ZIP central directory');
  const method = buffer.readUInt16LE(centralOffset + 10);
  const compressedSize = buffer.readUInt32LE(centralOffset + 20);
  const localOffset = buffer.readUInt32LE(centralOffset + 42);
  if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('invalid ZIP local header');
  const fileNameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + fileNameLength + extraLength;
  const payload = buffer.subarray(start, start + compressedSize);
  if (method === 0) return payload;
  if (method === 8) return inflateRawSync(payload);
  throw new Error(`unsupported ZIP compression method ${method}`);
}

function archiveLines(buffer) {
  const lines = unzipSingle(buffer).toString('utf8').trim().split(/\r?\n/).filter(Boolean);
  return lines.length && !/^\d/.test(lines[0]) ? lines.slice(1) : lines;
}

export function parseKlineArchive(buffer, symbol) {
  const byTime = new Map();
  for (const line of archiveLines(buffer)) {
    const value = line.split(',');
    const row = {
      symbol,
      openTime: normalizeTimestamp(value[0]),
      open: Number(value[1]),
      high: Number(value[2]),
      low: Number(value[3]),
      close: Number(value[4]),
      volume: Number(value[5]),
      closeTime: normalizeTimestamp(value[6]),
      quoteVolume: Number(value[7]),
      trades: Number(value[8]),
      takerBuyQuoteVolume: Number(value[10])
    };
    if ([
      row.openTime,
      row.open,
      row.high,
      row.low,
      row.close,
      row.closeTime,
      row.quoteVolume,
      row.takerBuyQuoteVolume
    ].every(Number.isFinite)) byTime.set(row.openTime, row);
  }
  return [...byTime.values()].sort((a, b) => a.openTime - b.openTime);
}

export function parseFundingArchive(buffer) {
  const byTime = new Map();
  for (const line of archiveLines(buffer)) {
    const value = line.split(',');
    const row = {
      fundingTime: normalizeTimestamp(value[0]),
      fundingRate: Number(value[2])
    };
    if (Number.isFinite(row.fundingTime) && Number.isFinite(row.fundingRate)) {
      byTime.set(row.fundingTime, row);
    }
  }
  return [...byTime.values()].sort((a, b) => a.fundingTime - b.fundingTime);
}

function standardDeviation(count, sum, sumSquares) {
  if (count < 2) return null;
  return Math.sqrt(Math.max(0, (sumSquares - sum * sum / count) / (count - 1)));
}

function contiguous(bars, from, to) {
  for (let index = from + 1; index <= to; index++) {
    if (bars[index].openTime - bars[index - 1].openTime !== FIVE_MINUTES) return false;
  }
  return true;
}

export function detectSignals(bars, options = {}) {
  const evaluationStart = options.evaluationStart ?? -Infinity;
  const evaluationEnd = options.evaluationEnd ?? Infinity;
  const returnBars = options.returnBars ?? 3;
  const volatilityLookback = options.volatilityLookback ?? 4032;
  const minimumAbsoluteReturn = options.minimumAbsoluteReturn ?? 0.006;
  const volatilityMultiple = options.volatilityMultiple ?? 4;
  const volumeLookback = options.volumeLookback ?? 288;
  const minimumVolumeMultiple = options.minimumVolumeMultiple ?? 3;
  const minimumImbalance = options.minimumImbalance ?? 0.25;
  const minimumWick = options.minimumWick ?? 0.25;
  const holdBars = options.holdBars ?? 12;
  const returnQueue = [];
  const volumeQueue = [];
  let returnSum = 0;
  let returnSquares = 0;
  let volumeSum = 0;
  let nextEligibleIndex = 0;
  const signals = [];

  for (let index = returnBars - 1; index < bars.length; index++) {
    const bar = bars[index];
    const windowStart = index - returnBars + 1;
    const shockReturn = Math.log(bar.close / bars[windowStart].open);
    const volatility = standardDeviation(returnQueue.length, returnSum, returnSquares);
    const averageVolume = volumeQueue.length ? volumeSum / volumeQueue.length : null;
    const range = bar.high - bar.low;
    const imbalance = bar.quoteVolume > 0
      ? 2 * bar.takerBuyQuoteVolume / bar.quoteVolume - 1
      : null;
    const shockSign = Math.sign(shockReturn);
    const directionalWick = range > 0
      ? (shockSign > 0
          ? bar.high - Math.max(bar.open, bar.close)
          : Math.min(bar.open, bar.close) - bar.low) / range
      : 0;
    const entryIndex = index + 1;
    const exitIndex = entryIndex + holdBars;
    const hasWarmup = returnQueue.length === volatilityLookback && volumeQueue.length === volumeLookback;
    const hasPath = exitIndex < bars.length && contiguous(bars, windowStart, exitIndex);
    const inEvaluation = bar.closeTime >= evaluationStart && bar.closeTime < evaluationEnd;
    const threshold = volatility == null
      ? Infinity
      : Math.max(minimumAbsoluteReturn, volatilityMultiple * volatility);
    const matches = hasWarmup
      && hasPath
      && inEvaluation
      && index >= nextEligibleIndex
      && Math.abs(shockReturn) >= threshold
      && averageVolume > 0
      && bar.quoteVolume >= minimumVolumeMultiple * averageVolume
      && Number.isFinite(imbalance)
      && shockSign * imbalance >= minimumImbalance
      && directionalWick >= minimumWick;
    if (matches) {
      signals.push({
        symbol: bar.symbol,
        side: -shockSign,
        signalTime: bar.closeTime,
        entryTime: bars[entryIndex].openTime,
        exitTime: bars[exitIndex].openTime,
        entryPrice: bars[entryIndex].open,
        exitPrice: bars[exitIndex].open,
        shockReturn,
        shockVolatility: volatility,
        shockZ: shockReturn / volatility,
        quoteVolumeMultiple: bar.quoteVolume / averageVolume,
        takerImbalance: imbalance,
        directionalWick
      });
      nextEligibleIndex = exitIndex;
    }

    if (Number.isFinite(shockReturn)) {
      returnQueue.push(shockReturn);
      returnSum += shockReturn;
      returnSquares += shockReturn * shockReturn;
      if (returnQueue.length > volatilityLookback) {
        const removed = returnQueue.shift();
        returnSum -= removed;
        returnSquares -= removed * removed;
      }
    }
    if (Number.isFinite(bar.quoteVolume) && bar.quoteVolume >= 0) {
      volumeQueue.push(bar.quoteVolume);
      volumeSum += bar.quoteVolume;
      if (volumeQueue.length > volumeLookback) volumeSum -= volumeQueue.shift();
    }
  }
  return signals;
}

function fundingReturn(signal, fundingRows) {
  let total = 0;
  for (const row of fundingRows) {
    if (row.fundingTime <= signal.entryTime) continue;
    if (row.fundingTime >= signal.exitTime) break;
    total += -signal.side * row.fundingRate;
  }
  return total;
}

export function applyExecution(signal, fundingRows, scenario) {
  const fee = scenario.feePerSide;
  const slippage = scenario.slippagePerSide;
  const entryFill = signal.entryPrice * (1 + signal.side * slippage);
  const exitFill = signal.exitPrice * (1 - signal.side * slippage);
  const priceReturn = signal.side * (exitFill / entryFill - 1);
  const funding = fundingReturn(signal, fundingRows);
  return {
    ...signal,
    scenario: scenario.name,
    entryFill,
    exitFill,
    grossPriceReturn: signal.side * (signal.exitPrice / signal.entryPrice - 1),
    priceReturnAfterSlippage: priceReturn,
    fees: 2 * fee,
    fundingReturn: funding,
    netReturn: priceReturn - 2 * fee + funding
  };
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function groupNet(trades, key) {
  const output = {};
  for (const trade of trades) {
    const name = key(trade);
    output[name] = (output[name] ?? 0) + trade.netReturn;
  }
  return output;
}

export function summarizeTrades(trades) {
  const ordered = trades.slice().sort((a, b) => a.exitTime - b.exitTime || a.symbol.localeCompare(b.symbol));
  const wins = ordered.filter(trade => trade.netReturn > 0);
  const losses = ordered.filter(trade => trade.netReturn < 0);
  const returns = ordered.map(trade => trade.netReturn);
  const mean = returns.length ? sum(returns) / returns.length : 0;
  const variance = returns.length > 1
    ? sum(returns.map(value => (value - mean) ** 2)) / (returns.length - 1)
    : 0;
  let cumulative = 0;
  let peak = 0;
  let maxDrawdownUnits = 0;
  for (const value of returns) {
    cumulative += value;
    peak = Math.max(peak, cumulative);
    maxDrawdownUnits = Math.min(maxDrawdownUnits, cumulative - peak);
  }
  const bySymbol = groupNet(ordered, trade => trade.symbol);
  const byDirection = groupNet(ordered, trade => trade.side === 1 ? 'long' : 'short');
  const byHalfYear = groupNet(ordered, trade => {
    const date = new Date(trade.entryTime);
    return `${date.getUTCFullYear()}-H${date.getUTCMonth() < 6 ? 1 : 2}`;
  });
  const byMonth = groupNet(ordered, trade => new Date(trade.entryTime).toISOString().slice(0, 7));
  const positiveMonths = Object.values(byMonth).filter(value => value > 0);
  const totalPositiveMonths = sum(positiveMonths);
  const withoutBest5 = returns.slice().sort((a, b) => b - a).slice(5);
  return {
    trades: ordered.length,
    wins: wins.length,
    winRate: ordered.length ? wins.length / ordered.length : 0,
    grossPriceReturnUnits: sum(ordered.map(trade => trade.grossPriceReturn)),
    netReturnUnits: sum(returns),
    averageNetReturn: mean,
    medianNetReturn: median(returns),
    naiveTStatistic: ordered.length && variance > 0 ? mean / Math.sqrt(variance / ordered.length) : null,
    profitFactor: losses.length
      ? sum(wins.map(trade => trade.netReturn)) / Math.abs(sum(losses.map(trade => trade.netReturn))
        )
      : null,
    profitWithoutBest5: sum(withoutBest5),
    maxDrawdownReturnUnits: maxDrawdownUnits,
    totalFees: sum(ordered.map(trade => trade.fees)),
    totalFunding: sum(ordered.map(trade => trade.fundingReturn)),
    profitableSymbols: Object.values(bySymbol).filter(value => value > 0).length,
    profitableHalfYears: Object.values(byHalfYear).filter(value => value > 0).length,
    maxPositiveMonthContributionShare: totalPositiveMonths
      ? Math.max(...positiveMonths) / totalPositiveMonths
      : 1,
    bySymbol,
    byDirection,
    byHalfYear,
    byMonth
  };
}

export function developmentScreen(summary, thresholds) {
  const checks = {
    minimumTrades: summary.trades >= thresholds.minimumTrades,
    stressProfitFactor: summary.profitFactor != null
      && summary.profitFactor >= thresholds.minimumProfitFactor,
    positiveNet: summary.netReturnUnits > 0,
    withoutBest5: summary.profitWithoutBest5 > 0,
    symbolBreadth: summary.profitableSymbols >= thresholds.minimumProfitableSymbols,
    bothDirections: (summary.byDirection.long ?? 0) > 0 && (summary.byDirection.short ?? 0) > 0,
    halfYearBreadth: summary.profitableHalfYears >= thresholds.minimumProfitableHalfYears
  };
  return {
    pass: Object.values(checks).every(Boolean),
    checks,
    failures: Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name)
  };
}
