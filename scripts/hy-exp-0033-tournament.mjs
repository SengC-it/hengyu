import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  assertContiguous,
  mergeUniqueSeries,
  parseFundingArchive,
  parseKlineArchive
} from '../src/research/archive.mjs';
import { aggregateFourHourBars as aggregateH10, replayH10Trend } from '../src/research/h10-trend.mjs';
import { broadBearRegimeTimes } from '../src/research/h12-regime.mjs';
import {
  buildCarryPortfolio,
  buildRebalanceEvents,
  computeCarryFeatures,
  executeCarryPortfolio
} from '../src/research/exp010.mjs';
import {
  aggregateFourHourBars as aggregateH7,
  detectRelativeValueSignals,
  executeRelativeValueSignal
} from '../src/research/exp011.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREREG_PATH = path.join(ROOT, 'registry', 'experiments', 'HY-EXP-0033', 'preregistration.json');
const MANIFEST_PATH = path.join(ROOT, 'artifacts', 'HY-EXP-0033', 'data-manifest.json');
const ARTIFACT_DIR = path.join(ROOT, 'artifacts', 'HY-EXP-0033');
const RESULT_PATH = path.join(ARTIFACT_DIR, 'tournament-result.json');
const TRADES_PATH = path.join(ARTIFACT_DIR, 'tournament-events.jsonl');
const REPORT_PATH = path.join(ARTIFACT_DIR, 'tournament-report.md');
const config = JSON.parse(fs.readFileSync(PREREG_PATH, 'utf8'));
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
const START = Date.parse(config.dataWindow.start);
const END = Date.parse(config.dataWindow.endExclusive);
const FIVE_MINUTES = 5 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const BASELINE_H12_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'];
const H6_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'XRPUSDT', 'SOLUSDT', 'DOGEUSDT', 'LINKUSDT', 'LTCUSDT', 'ADAUSDT', 'BCHUSDT', 'DOTUSDT', 'AVAXUSDT', 'TRXUSDT', 'ETCUSDT', 'FILUSDT', 'APTUSDT'];
const H7_PAIRS = [
  { pairId: 'BTC_LTC', xSymbol: 'BTCUSDT', ySymbol: 'LTCUSDT' },
  { pairId: 'ETH_ETC', xSymbol: 'ETHUSDT', ySymbol: 'ETCUSDT' },
  { pairId: 'SOL_AVAX', xSymbol: 'SOLUSDT', ySymbol: 'AVAXUSDT' },
  { pairId: 'ADA_DOT', xSymbol: 'ADAUSDT', ySymbol: 'DOTUSDT' }
];
const verifiedFiles = new Set();
const hash = buffer => createHash('sha256').update(buffer).digest('hex');
const rel = file => path.relative(ROOT, file).replaceAll('\\', '/');
const filePath = item => path.resolve(ROOT, item.path);

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
  if (manifest.preregistrationSha256 !== hash(fs.readFileSync(PREREG_PATH))) throw new Error('0033 preregistration hash mismatch');
  if (manifest.missingCount !== 0) throw new Error(`0033 data manifest missing ${manifest.missingCount} files`);
  if (manifest.outcomeRead || manifest.pnlComputed || manifest.finalOosRead) throw new Error('0033 data manifest is not pre-outcome clean');
  for (const item of manifest.files) {
    if (!item.path) throw new Error(`missing manifest path: ${item.symbol}/${item.kind}/${item.period}`);
    if (verifiedFiles.has(item.path)) continue;
    const buffer = fs.readFileSync(filePath(item));
    if (hash(buffer) !== item.sha256) throw new Error(`data hash mismatch: ${item.path}`);
    verifiedFiles.add(item.path);
  }
}

function rowsFor(symbol, kind) {
  const items = manifest.files
    .filter(row => row.symbol === symbol && row.kind === kind && row.path)
    .sort((left, right) => `${left.period}/${left.cadence}`.localeCompare(`${right.period}/${right.cadence}`));
  const chunks = items.map(item => {
    const buffer = fs.readFileSync(filePath(item));
    if (kind === 'funding' && item.cadence === 'rest') {
      const values = JSON.parse(buffer.toString('utf8'));
      return values.map(value => ({
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
  return rows;
}

function lowerBound(rows, time, field = 'openTime') {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (rows[mid][field] < time) low = mid + 1;
    else high = mid;
  }
  return low;
}

function markMapForFunding(markRows, fundingRows) {
  const times = new Set(fundingRows.map(row => row.eventTime));
  return new Map(markRows.filter(row => times.has(row.openTime)).map(row => [row.openTime, row]));
}

function fundingReturnForLeg(leg, entryTime, exitTime, fundingRows, markRows) {
  const markByTime = new Map(markRows.map(row => [row.openTime, row]));
  let value = 0;
  for (const row of fundingRows) {
    if (row.eventTime < entryTime) continue;
    if (row.eventTime >= exitTime) break;
    const mark = markByTime.get(row.eventTime);
    if (!mark) throw new Error(`${leg.symbol}: missing funding mark ${row.eventTime}`);
    value += -leg.side * Math.abs(leg.weight) * mark.open / leg.entryPrice * row.fundingRate;
  }
  return value;
}

function h12Positions() {
  const fourHourBySymbol = {};
  for (const symbol of BASELINE_H12_SYMBOLS) fourHourBySymbol[symbol] = aggregateH10(rowsFor(symbol, 'contract'));
  const eligible = broadBearRegimeTimes(fourHourBySymbol, {
    symbols: BASELINE_H12_SYMBOLS,
    fastBars: 60,
    slowBars: 180,
    minimumBreadth: 4
  });
  const output = [];
  for (const symbol of BASELINE_H12_SYMBOLS) {
    const trades = replayH10Trend(fourHourBySymbol[symbol], {
      evaluationStart: START,
      evaluationEnd: END,
      entryChannelBars: 120,
      exitChannelBars: 60,
      atrBars: 30,
      initialStopAtrMultiple: 2,
      stressCostBpsPerFill: 0,
      allowLong: false,
      allowShort: true,
      entryFilter: ({ bar }) => eligible.has(bar.openTime)
    });
    const fundingRows = rowsFor(symbol, 'funding');
    const markRows = rowsFor(symbol, 'mark');
    for (const trade of trades) {
      const leg = {
        symbol,
        role: 'H12_SHORT',
        side: -1,
        weight: 1 / BASELINE_H12_SYMBOLS.length,
        entryPrice: trade.entryPrice,
        exitPrice: trade.exitPrice
      };
      const fundingReturn = fundingReturnForLeg(leg, trade.entryTime, trade.exitTime, fundingRows, markRows);
      output.push({
        eventId: `H12:${symbol}:${trade.signalTime}`,
        family: 'H12_BROAD_BEAR_SHORT',
        familyType: 'H12',
        concentrationKey: symbol,
        direction: 'SELL',
        entryTime: trade.entryTime,
        exitTime: trade.exitTime,
        signalTime: trade.signalTime,
        exitReason: trade.exitReason,
        grossPriceReturnFraction: trade.grossReturn * leg.weight,
        fundingReturnFraction: fundingReturn,
        legs: [leg]
      });
    }
  }
  return { positions: output, regimeBars: eligible.size };
}

function h6Positions() {
  const btcBars = rowsFor('BTCUSDT', 'contract');
  const events = buildRebalanceEvents({
    btcBars,
    anchorTime: START,
    evaluationStart: START,
    evaluationEnd: END,
    rebalanceDays: 14,
    baseEntryOffsetBars: 2,
    holdBars: 4032,
    maximumEntryDelayBars: 0
  });
  const featuresByEvent = new Map(events.map(event => [event.eventId, []]));
  const benchmarkByEvent = new Map();
  for (const symbol of H6_SYMBOLS) {
    const bars = symbol === 'BTCUSDT' ? btcBars : rowsFor(symbol, 'contract');
    const features = computeCarryFeatures({
      symbol,
      bars,
      btcBars,
      fundingRows: rowsFor(symbol, 'funding'),
      events,
      fundingLookbackDays: 14,
      minimumFundingEvents: 42,
      betaLookbackBars: 8640,
      capacityLookbackBars: 12
    });
    for (const feature of features) {
      if (symbol === 'BTCUSDT') benchmarkByEvent.set(feature.eventId, feature);
      else featuresByEvent.get(feature.eventId).push(feature);
    }
  }
  const portfolios = events.map(event => buildCarryPortfolio({
    event,
    candidates: featuresByEvent.get(event.eventId),
    benchmarkFeature: benchmarkByEvent.get(event.eventId),
    benchmark: 'BTCUSDT',
    eligibleSymbols: 12,
    minimumValidSymbols: 12,
    longCount: 3,
    shortCount: 3,
    minimumProjectedFundingReturn: 0.0024,
    referenceGrossNotional: 10_000,
    maximumParticipation: 0.02,
    maximumBetaExposure: 1e-10,
    holdBars: 4032
  })).filter(row => row.status === 'trade');
  const usedSymbols = new Set(portfolios.flatMap(row => row.legs.map(leg => leg.symbol)));
  const dataBySymbol = {};
  const executionTimes = new Set(portfolios.flatMap(row => [row.baseEntryTime, row.baseEntryTime + 4032 * FIVE_MINUTES]));
  for (const symbol of usedSymbols) {
    const contract = rowsFor(symbol, 'contract');
    const funding = rowsFor(symbol, 'funding');
    const mark = rowsFor(symbol, 'mark');
    dataBySymbol[symbol] = {
      contractByTime: new Map(contract.filter(row => executionTimes.has(row.openTime)).map(row => [row.openTime, row])),
      funding,
      markByTime: markMapForFunding(mark, funding)
    };
  }
  const positions = portfolios.map(portfolio => {
    const executed = executeCarryPortfolio(portfolio, dataBySymbol, {
      name: 'unified_raw', entryDelayBars: 0, feePerFill: 0, slippagePerFill: 0
    });
    return {
      eventId: `H6:${executed.eventId}`,
      family: 'H6_BETA_NEUTRAL_FUNDING_CARRY',
      familyType: 'H6',
      concentrationKey: 'H6_PORTFOLIO',
      direction: 'LONG_SHORT',
      entryTime: executed.entryTime,
      exitTime: executed.exitTime,
      grossPriceReturnFraction: executed.grossPriceReturn,
      fundingReturnFraction: executed.fundingReturn,
      legs: executed.legs
    };
  });
  return { positions, scheduledEvents: events.length, candidatePortfolios: portfolios.length };
}

function h7Positions() {
  const signals = [];
  const skipped = {};
  for (const pair of H7_PAIRS) {
    const xFive = rowsFor(pair.xSymbol, 'contract');
    const yFive = rowsFor(pair.ySymbol, 'contract');
    const detected = detectRelativeValueSignals({
      pairId: pair.pairId,
      xSymbol: pair.xSymbol,
      ySymbol: pair.ySymbol,
      xFourHourBars: aggregateH7(xFive, pair.xSymbol),
      yFourHourBars: aggregateH7(yFive, pair.ySymbol),
      xFiveMinuteBars: xFive,
      yFiveMinuteBars: yFive,
      evaluationStart: START,
      evaluationEnd: END,
      lookbackBars: 540,
      minimumBeta: 0.25,
      maximumBeta: 2.5,
      entryAbsoluteZscore: 3,
      rearmAbsoluteZscore: 1,
      maximumHoldBars: 42,
      baseFillOffsetBars: 1,
      maximumFillDelayBars: 0,
      pairGrossWeight: 0.25,
      referenceAccountNotional: 10_000,
      capacityLookbackBars: 12,
      maximumParticipation: 0.02
    });
    signals.push(...detected.signals);
    skipped[pair.pairId] = detected.skipped;
  }
  const symbols = [...new Set(H7_PAIRS.flatMap(pair => [pair.xSymbol, pair.ySymbol]))];
  const executionTimes = new Set(signals.flatMap(row => [row.baseEntryTime, row.baseExitTime]));
  const dataBySymbol = {};
  for (const symbol of symbols) {
    const contract = rowsFor(symbol, 'contract');
    const funding = rowsFor(symbol, 'funding');
    const mark = rowsFor(symbol, 'mark');
    dataBySymbol[symbol] = {
      contractByTime: new Map(contract.filter(row => executionTimes.has(row.openTime)).map(row => [row.openTime, row])),
      funding,
      markByTime: markMapForFunding(mark, funding)
    };
  }
  const positions = signals.map(signal => {
    const executed = executeRelativeValueSignal(signal, dataBySymbol, {
      name: 'unified_raw', fillDelayBars: 0, feePerFill: 0, slippagePerFill: 0
    });
    return {
      eventId: `H7:${executed.eventId}`,
      family: 'H7_CROSS_ASSET_RELATIVE_VALUE',
      familyType: 'H7',
      concentrationKey: executed.pairId,
      direction: executed.direction,
      entryTime: executed.entryTime,
      exitTime: executed.exitTime,
      grossPriceReturnFraction: executed.grossPriceReturn,
      fundingReturnFraction: executed.fundingReturn,
      legs: executed.legs
    };
  });
  return { positions, signals: signals.length, skipped };
}

function costFraction(row, costBps) {
  return costBps / 10_000 * row.legs.reduce((total, leg) => total + Math.abs(leg.weight), 0);
}

function withCosts(positions) {
  return positions.map(row => {
    const gross = row.grossPriceReturnFraction + row.fundingReturnFraction;
    return {
      ...row,
      grossReturnFraction: gross,
      net18: gross - costFraction(row, 18),
      net27: gross - costFraction(row, 27),
      net36: gross - costFraction(row, 36)
    };
  });
}

function groupByMonth(rows, costKey) {
  const output = {};
  for (const row of rows) {
    const month = new Date(row.exitTime).toISOString().slice(0, 7);
    output[month] = (output[month] ?? 0) + row[costKey];
  }
  return output;
}

function maxLossStreak(values) {
  let current = 0;
  let maximum = 0;
  for (const value of values) {
    if (value < 0) maximum = Math.max(maximum, ++current);
    else current = 0;
  }
  return maximum;
}

function quantile(values, p) {
  if (!values.length) return null;
  const ordered = values.slice().sort((a, b) => a - b);
  return ordered[Math.floor((ordered.length - 1) * p)];
}

function summarize(rows, costKey) {
  const values = rows.map(row => row[costKey]);
  const grossValues = rows.map(row => row.grossReturnFraction);
  const wins = values.filter(value => value > 0);
  const losses = values.filter(value => value < 0);
  const months = groupByMonth(rows, costKey);
  const activeMonths = Object.keys(months).sort();
  const positiveMonths = Object.values(months).filter(value => value > 0);
  const exposure = {};
  for (const row of rows) {
    const keys = row.familyType === 'H6'
      ? row.legs.map(leg => leg.symbol)
      : [row.concentrationKey];
    for (const key of keys) exposure[key] = (exposure[key] ?? 0) + 1;
  }
  const totalExposure = Object.values(exposure).reduce((total, value) => total + value, 0);
  const best = values.length ? Math.max(...values) : null;
  const bestFive = values.slice().sort((a, b) => b - a).slice(0, 5).reduce((a, b) => a + b, 0);
  const withoutBestFive = values.reduce((a, b) => a + b, 0) - bestFive;
  return {
    eventCount: rows.length,
    activeDays: new Set(rows.map(row => new Date(row.entryTime).toISOString().slice(0, 10))).size,
    activeMonths: activeMonths.length,
    grossExpectancyBps: grossValues.length ? grossValues.reduce((a, b) => a + b, 0) / grossValues.length * 10_000 : null,
    netExpectancyBps: values.length ? values.reduce((a, b) => a + b, 0) / values.length * 10_000 : null,
    netPnl: values.reduce((a, b) => a + b, 0),
    profitFactor: losses.length ? wins.reduce((a, b) => a + b, 0) / Math.abs(losses.reduce((a, b) => a + b, 0)) : null,
    maxLossStreak: maxLossStreak(rows.slice().sort((a, b) => a.exitTime - b.exitTime).map(row => row[costKey])),
    netPnlWithoutBestTradeOrEvent: best == null ? null : values.reduce((a, b) => a + b, 0) - best,
    netPnlWithoutBest5Events: withoutBestFive,
    bestMonth: activeMonths.length ? activeMonths.slice().sort((a, b) => months[b] - months[a])[0] : null,
    bestMonthNetPnl: activeMonths.length ? Math.max(...Object.values(months)) : null,
    netPnlWithoutBestMonth: activeMonths.length ? values.reduce((a, b) => a + b, 0) - Math.max(...Object.values(months)) : null,
    positiveMonthShare: activeMonths.length ? positiveMonths.length / activeMonths.length : null,
    monthlyNetPnl: months,
    largestSymbolOrPair: totalExposure ? Object.entries(exposure).sort((a, b) => b[1] - a[1])[0][0] : null,
    largestSymbolOrPairShare: totalExposure ? Math.max(...Object.values(exposure)) / totalExposure : null,
    exposureCounts: exposure,
    fundingPnl: rows.reduce((total, row) => total + row.fundingReturnFraction, 0),
    executionCosts: rows.reduce((total, row) => total + costFraction(row, Number(costKey.slice(3))), 0),
    byDirection: rows.reduce((out, row) => {
      out[row.direction] = (out[row.direction] ?? 0) + row[costKey];
      return out;
    }, {})
  };
}

function add(map, key, value) {
  map.set(key, (map.get(key) ?? 0) + value);
}

function reconstructPortfolioMtm(rows, costBps) {
  if (!rows.length) return { status: 'NOT_RECONSTRUCTED', reason: 'EMPTY_SAMPLE', portfolioMtmDrawdownFraction: null, portfolioCvar95: null, portfolioCvarStatus: 'NOT_EVALUABLE' };
  const markPnl = new Map();
  const cash = new Map();
  const symbols = [...new Set(rows.flatMap(row => row.legs.map(leg => leg.symbol)))];
  const rowLegsBySymbol = Object.fromEntries(symbols.map(symbol => [symbol, []]));
  for (const row of rows) for (const leg of row.legs) rowLegsBySymbol[leg.symbol].push({ row, leg });
  for (const symbol of symbols) {
    const markRows = rowsFor(symbol, 'mark');
    const fundingRows = rowsFor(symbol, 'funding');
    for (const { row, leg } of rowLegsBySymbol[symbol]) {
      const entryTime = row.entryTime;
      const exitTime = row.exitTime;
      const weight = Math.abs(leg.weight);
      const startIndex = lowerBound(markRows, entryTime);
      const endIndex = lowerBound(markRows, exitTime);
      if (markRows[startIndex]?.openTime !== entryTime || markRows[endIndex]?.openTime !== exitTime) {
        throw new Error(`${symbol}: mark series missing exact portfolio boundary`);
      }
      for (let index = startIndex; index < endIndex; index++) {
        const mark = markRows[index];
        add(markPnl, mark.openTime, leg.side * weight * (mark.open - leg.entryPrice) / leg.entryPrice);
      }
      const totalCost = costBps / 10_000 * weight;
      add(cash, entryTime, -totalCost / 2);
      add(cash, exitTime, -totalCost / 2);
      add(cash, exitTime, leg.side * weight * (leg.exitPrice - leg.entryPrice) / leg.entryPrice);
      const fundingMarkByTime = new Map(markRows.filter(mark => fundingRows.some(funding => funding.eventTime === mark.openTime)).map(mark => [mark.openTime, mark]));
      for (const funding of fundingRows) {
        if (funding.eventTime < entryTime) continue;
        if (funding.eventTime >= exitTime) break;
        const mark = fundingMarkByTime.get(funding.eventTime);
        if (!mark) throw new Error(`${symbol}: missing mark at funding time ${funding.eventTime}`);
        add(cash, funding.eventTime, -leg.side * weight * mark.open / leg.entryPrice * funding.fundingRate);
      }
    }
  }
  const times = [...new Set([...markPnl.keys(), ...cash.keys()])].sort((a, b) => a - b);
  let cumulativeCash = 0;
  let peak = 0;
  let maxDrawdown = 0;
  const equity = [];
  for (const time of times) {
    cumulativeCash += cash.get(time) ?? 0;
    const value = cumulativeCash + (markPnl.get(time) ?? 0);
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
  const orderedReturns = dailyReturns.slice().sort((a, b) => a - b);
  const tail = orderedReturns.slice(0, Math.max(1, Math.ceil(orderedReturns.length * 0.05)));
  return {
    status: 'RECONSTRUCTED',
    equityPoints: equity.length,
    dailyObservationCount: dailyReturns.length,
    dailyReturns,
    portfolioMtmDrawdownFraction: maxDrawdown,
    portfolioMtmStatus: 'RECONSTRUCTED',
    portfolioCvar95: -tail.reduce((a, b) => a + b, 0) / tail.length,
    portfolioCvarStatus: dailyReturns.length >= 60 ? 'EVALUABLE' : 'CVAR_NOT_EVALUABLE'
  };
}

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function bootstrap(rows, risk) {
  if (!rows.length) return { status: 'EMPTY_SAMPLE_NOT_EVALUABLE' };
  const dayCount = Math.floor((END - START) / DAY);
  const dayRows = Array.from({ length: dayCount }, () => []);
  for (const row of rows) {
    const index = Math.floor((row.entryTime - START) / DAY);
    if (index >= 0 && index < dayCount) dayRows[index].push(row);
  }
  const random = seeded(320032);
  const net27 = [];
  const net36 = [];
  const pf27 = [];
  const drawdowns = [];
  for (let iteration = 0; iteration < 5000; iteration++) {
    const sampledRows = [];
    const sampledReturns = [];
    for (let cursor = 0; cursor < dayCount;) {
      const start = Math.floor(random() * (dayCount - 7 + 1));
      for (let offset = 0; offset < 7 && cursor < dayCount; offset++, cursor++) {
        sampledRows.push(...dayRows[start + offset]);
        sampledReturns.push(risk.dailyReturns[start + offset]);
      }
    }
    const a = sampledRows.map(row => row.net27);
    const b = sampledRows.map(row => row.net36);
    if (a.length) {
      net27.push(a.reduce((x, y) => x + y, 0) / a.length * 10_000);
      net36.push(b.reduce((x, y) => x + y, 0) / b.length * 10_000);
      const wins = a.filter(value => value > 0).reduce((x, y) => x + y, 0);
      const losses = a.filter(value => value < 0).reduce((x, y) => x + y, 0);
      pf27.push(losses < 0 ? wins / Math.abs(losses) : null);
    }
    let equity = 0;
    let peak = 0;
    let dd = 0;
    for (const value of sampledReturns) {
      equity += value;
      peak = Math.max(peak, equity);
      dd = Math.max(dd, peak - equity);
    }
    drawdowns.push(dd);
  }
  return {
    status: 'COMPUTED',
    method: 'CALENDAR_TIME_BLOCK_BOOTSTRAP',
    blockLengthDays: 7,
    iterations: 5000,
    seed: 320032,
    net27ExpectancyBpsLower95: quantile(net27, 0.025),
    net27ExpectancyBpsMedian: quantile(net27, 0.5),
    net36ExpectancyBpsLower95: quantile(net36, 0.025),
    PF27Median: quantile(pf27.filter(value => value != null), 0.5),
    PF27Lower95: quantile(pf27.filter(value => value != null), 0.025),
    portfolioMtmDrawdownUpper95: quantile(drawdowns, 0.975)
  };
}

function familyGates(summary, risk, boot) {
  const checks = {
    eventCount: summary.eventCount >= 30,
    activeMonths: summary.activeMonths >= 12,
    net18: summary.net18ExpectancyBps > 0,
    PF18: summary.byCost?.net18?.profitFactor >= 1.3,
    net27: summary.byCost?.net27?.netExpectancyBps > 0,
    PF27: summary.byCost?.net27?.profitFactor >= 1.2,
    net36: summary.byCost?.net36?.netExpectancyBps > 0,
    PF36: summary.byCost?.net36?.profitFactor >= 1.05,
    portfolioMtmDD: risk.portfolioMtmStatus === 'RECONSTRUCTED' && risk.portfolioMtmDrawdownFraction <= 0.08,
    portfolioCvar: risk.portfolioCvarStatus === 'EVALUABLE',
    maxLossStreak: summary.byCost?.net27?.maxLossStreak <= 6,
    withoutBestEvent: summary.byCost?.net27?.netPnlWithoutBestTradeOrEvent > 0,
    withoutBest5: summary.byCost?.net27?.netPnlWithoutBest5Events > 0,
    withoutBestMonth: summary.byCost?.net27?.netPnlWithoutBestMonth > 0,
    positiveMonthShare: summary.byCost?.net27?.positiveMonthShare >= 0.6,
    concentration: summary.largestSymbolOrPairShare <= 0.3,
    bootstrapNet27Lower: boot.status === 'COMPUTED' && boot.net27ExpectancyBpsLower95 > 0
  };
  return { pass: Object.values(checks).every(Boolean), checks, failures: Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name) };
}

function familyReport(name, positions, extras = {}) {
  const rows = withCosts(positions);
  const byCost = {
    net18: summarize(rows, 'net18'),
    net27: summarize(rows, 'net27'),
    net36: summarize(rows, 'net36')
  };
  const primary = byCost.net18;
  const risk = reconstructPortfolioMtm(rows, 27);
  const boot = bootstrap(rows, risk);
  const summary = {
    family: name,
    eventCount: rows.length,
    activeDays: primary.activeDays,
    activeMonths: primary.activeMonths,
    grossExpectancyBps: primary.grossExpectancyBps,
    net18ExpectancyBps: byCost.net18.netExpectancyBps,
    net27ExpectancyBps: byCost.net27.netExpectancyBps,
    net36ExpectancyBps: byCost.net36.netExpectancyBps,
    PF18: byCost.net18.profitFactor,
    PF27: byCost.net27.profitFactor,
    PF36: byCost.net36.profitFactor,
    netPnl18: byCost.net18.netPnl,
    netPnl27: byCost.net27.netPnl,
    netPnl36: byCost.net36.netPnl,
    fundingPnl: primary.fundingPnl,
    executionCosts: { base18: byCost.net18.executionCosts, stress27: byCost.net27.executionCosts, severe36: byCost.net36.executionCosts },
    maxLossStreak: byCost.net27.maxLossStreak,
    largestSymbolOrPairShare: primary.largestSymbolOrPairShare,
    largestSymbolOrPair: primary.largestSymbolOrPair,
    positiveMonthShare: byCost.net27.positiveMonthShare,
    byCost,
    risk,
    bootstrap: boot,
    ...extras
  };
  const gates = familyGates(summary, risk, boot);
  return { positions: rows, summary, gates };
}

function main() {
  verifyFrozenInputs();
  const h12 = h12Positions();
  const h6 = h6Positions();
  const h7 = h7Positions();
  const families = {
    H12_BROAD_BEAR_SHORT: familyReport('H12_BROAD_BEAR_SHORT', h12.positions, { regimeBars: h12.regimeBars }),
    H6_BETA_NEUTRAL_FUNDING_CARRY: familyReport('H6_BETA_NEUTRAL_FUNDING_CARRY', h6.positions, { scheduledEvents: h6.scheduledEvents, candidatePortfolios: h6.candidatePortfolios }),
    H7_CROSS_ASSET_RELATIVE_VALUE: familyReport('H7_CROSS_ASSET_RELATIVE_VALUE', h7.positions, { detectedSignals: h7.signals, skipped: h7.skipped })
  };
  const passers = Object.values(families).filter(row => row.gates.pass).map(row => row.summary.family);
  let winner = null;
  if (passers.length === 1) winner = passers[0];
  else if (passers.length > 1) {
    winner = passers.slice().sort((left, right) => {
      const a = families[left].summary.bootstrap.net27ExpectancyBpsLower95;
      const b = families[right].summary.bootstrap.net27ExpectancyBpsLower95;
      if (b !== a && Math.abs(b - a) >= 2) return b - a;
      return families[left].summary.risk.portfolioMtmDrawdownFraction - families[right].summary.risk.portfolioMtmDrawdownFraction;
    })[0];
  }
  const codeCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const result = {
    schemaVersion: 1,
    artifactType: 'HY_EXP_0033_STRATEGY_FAMILY_TOURNAMENT_RESULT',
    experimentId: 'HY-EXP-0033',
    generatedAt: new Date().toISOString(),
    codeCommit,
    preregistrationSha256: hash(fs.readFileSync(PREREG_PATH)),
    dataManifestSha256: hash(fs.readFileSync(MANIFEST_PATH)),
    window: config.dataWindow,
    outcomeRead: true,
    pnlComputed: true,
    finalOosRead: false,
    modelClass: 'RULE_BASED_FAMILY_TOURNAMENT_NO_ML',
    families,
    familyPassers: passers,
    winner: winner ?? 'NO_ROBUST_STRATEGY_FOUND',
    winnerRuleApplied: true,
    hyVal0033: { prepared: Boolean(winner), activated: false, experimentId: winner ? 'HY-VAL-0033-001' : null },
    reservedIds: { 'HY-EXP-0031': 'UNUSED_RESERVED_ID' },
    safety: { paperOnly: true, signalOnly: true, gmail: false, scheduler: false, realEmail: false, autoTrading: false, accountApi: false, orderApi: false, finalOosRead: false, productionDeploy: false }
  };
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const allRows = Object.values(families).flatMap(family => family.positions);
  fs.writeFileSync(TRADES_PATH, `${allRows.map(JSON.stringify).join('\n')}\n`);
  fs.writeFileSync(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`);
  const lines = [`# HY-EXP-0033 Recovered-Data Strategy Family Tournament`, '', `Winner: **${result.winner}**`, '', '| Family | Events | Net18 bps | PF18 | Net27 bps | PF27 | Net36 bps | PF36 | MTM DD | CVaR | Gate |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|'];
  for (const family of Object.values(families)) {
    const s = family.summary;
    lines.push(`| ${s.family} | ${s.eventCount} | ${s.net18ExpectancyBps?.toFixed(4) ?? 'null'} | ${s.PF18?.toFixed(3) ?? 'null'} | ${s.net27ExpectancyBps?.toFixed(4) ?? 'null'} | ${s.PF27?.toFixed(3) ?? 'null'} | ${s.net36ExpectancyBps?.toFixed(4) ?? 'null'} | ${s.PF36?.toFixed(3) ?? 'null'} | ${s.risk.portfolioMtmDrawdownFraction?.toFixed(6) ?? 'null'} | ${s.risk.portfolioCvar95?.toFixed(6) ?? 'null'} | ${family.gates.pass ? 'PASS' : 'FAIL'} |`);
    lines.push(``, `- ${s.family} failures: ${family.gates.failures.join(', ') || 'none'}`, `- Bootstrap net27 lower 95%: ${s.bootstrap.net27ExpectancyBpsLower95 ?? 'null'}`, ``);
  }
  lines.push('All results are development evidence only; no final OOS was read and no release/trading authorization is implied.');
  fs.writeFileSync(REPORT_PATH, `${lines.join('\n')}\n`);
  console.log(JSON.stringify({ codeCommit, winner: result.winner, familyPassers: passers, families: Object.fromEntries(Object.entries(families).map(([name, row]) => [name, { eventCount: row.summary.eventCount, gates: row.gates, net18: row.summary.net18ExpectancyBps, net27: row.summary.net27ExpectancyBps, net36: row.summary.net36ExpectancyBps, pf18: row.summary.PF18, pf27: row.summary.PF27, pf36: row.summary.PF36, mtmDD: row.summary.risk.portfolioMtmDrawdownFraction, cvar: row.summary.risk.portfolioCvar95 }])) }, null, 2));
}

main();
