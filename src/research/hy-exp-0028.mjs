import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildHyExp0024CandidateRows } from './hy-exp-0024.mjs';

export const HY_EXP_0028_EXPERIMENT_ID = 'HY-EXP-0028';
export const HY_EXP_0028_PREREGISTRATION_SHA256 = '4085fad293275ce055a67516d1c8168331f221a91b688f3b093ff2eef11708a3';
export const HY_EXP_0028_FROZEN_Q75 = 10.051547664406323;
export const HY_EXP_0028_HOLDOUT_START = Date.parse('2026-07-01T00:00:00.000Z');
export const HY_EXP_0028_HOLDOUT_END = Date.parse('2026-08-23T00:00:00.000Z');
export const HY_EXP_0028_SYMBOLS = Object.freeze([
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT',
  'XRPUSDT', 'DOGEUSDT', 'LINKUSDT', 'LTCUSDT'
]);
export const HY_EXP_0028_BASE_COST_BPS = 18;
export const HY_EXP_0028_STRESS_COST_BPS = 27;
export const HY_EXP_0028_RESEARCH_EQUITY_USDT = 100_000;
const FIVE_MINUTES = 5 * 60 * 1_000;
const HOUR = 60 * 60 * 1_000;
const FOUR_HOURS = 4 * HOUR;
const MAX_HOLD_BARS = 6;
const DAY = 24 * HOUR;
const Q75_FEATURE_INDEX = 7;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function finite(value) {
  return value != null && Number.isFinite(Number(value));
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function monthKey(time) {
  return new Date(time).toISOString().slice(0, 7);
}

function dayKey(time) {
  return new Date(time).toISOString().slice(0, 10);
}

function directionalReturnBps(side, entryPrice, exitPrice) {
  const sign = side === 'BUY' ? 1 : side === 'SELL' ? -1 : null;
  if (sign == null) throw new Error(`invalid side: ${side}`);
  return sign * (exitPrice - entryPrice) / entryPrice * 10_000;
}

function sampleStandardDeviation(values) {
  if (values.length < 2) return null;
  const center = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1));
}

function profitFactor(rows, field) {
  const positive = rows.filter(row => row[field] > 0).reduce((sum, row) => sum + row[field], 0);
  const negative = rows.filter(row => row[field] < 0).reduce((sum, row) => sum + row[field], 0);
  if (negative < 0) return positive / Math.abs(negative);
  return positive > 0 ? null : null;
}

function maxLossStreak(rows) {
  let maximum = 0;
  let current = 0;
  for (const row of rows) {
    if (row.netPnl < 0) current++;
    else current = 0;
    maximum = Math.max(maximum, current);
  }
  return maximum;
}

function positionSize(row) {
  const stopDistanceBps = Math.abs(row.label.entryPrice - row.label.stopPrice) / row.label.entryPrice * 10_000;
  if (!(stopDistanceBps > 0)) return null;
  const lossBudget = HY_EXP_0028_RESEARCH_EQUITY_USDT * 0.0025;
  const riskNotional = lossBudget / (stopDistanceBps / 10_000);
  const notional = Math.min(riskNotional, HY_EXP_0028_RESEARCH_EQUITY_USDT * 0.5);
  return {
    notional,
    quantity: notional / row.label.entryPrice,
    stopDistanceBps,
    lossAtStop: notional * stopDistanceBps / 10_000
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

function contributionAt(trade, time) {
  if (time < trade.entryTime) return 0;
  if (time >= trade.exitTime) return trade.netPnl;
  let mark = { returnBps: 0 };
  for (const candidate of trade.marks) {
    if (candidate.time > time) break;
    mark = candidate;
  }
  const funding = trade.realizedFunding.events
    .filter(row => row.fundingTime <= time)
    .reduce((sum, row) => sum + row.payment / trade.entryPrice * trade.notional, 0);
  return trade.notional * mark.returnBps / 10_000
    - trade.notional * (HY_EXP_0028_BASE_COST_BPS / 2) / 10_000
    + funding;
}

function markToMarketMetrics(trades) {
  const times = new Set([HY_EXP_0028_HOLDOUT_START, HY_EXP_0028_HOLDOUT_END - 1]);
  for (const trade of trades) {
    times.add(trade.entryTime);
    times.add(trade.exitTime);
    for (const mark of trade.marks) times.add(mark.time);
    for (const funding of trade.realizedFunding.events) times.add(funding.fundingTime);
  }
  const curve = [...times].sort((left, right) => left - right).map(time => ({
    time,
    equity: HY_EXP_0028_RESEARCH_EQUITY_USDT
      + trades.reduce((sum, trade) => sum + contributionAt(trade, time), 0)
  }));
  let peak = HY_EXP_0028_RESEARCH_EQUITY_USDT;
  let maxDrawdown = 0;
  for (const row of curve) {
    peak = Math.max(peak, row.equity);
    maxDrawdown = Math.max(maxDrawdown, 1 - row.equity / peak);
  }
  const daily = new Map();
  for (const row of curve) daily.set(dayKey(row.time), row.equity);
  const dailyEquity = [...daily.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, equity]) => equity);
  const dailyReturns = dailyEquity.slice(1)
    .map((equity, index) => equity / dailyEquity[index] - 1)
    .sort((left, right) => left - right);
  const tailCount = dailyReturns.length ? Math.max(1, Math.ceil(dailyReturns.length * 0.05)) : 0;
  const cvarLoss = tailCount ? -mean(dailyReturns.slice(0, tailCount)) : null;
  return {
    maxMtmDrawdown: maxDrawdown,
    maxMtmDrawdownBps: maxDrawdown * 10_000,
    cvar95LossFraction: cvarLoss,
    cvar95LossBps: cvarLoss == null ? null : cvarLoss * 10_000,
    curvePoints: curve.length,
    dailyObservations: dailyReturns.length,
    riskMetricStatus: 'EVALUABLE'
  };
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

function normalizeKlineRow(symbol, row) {
  if (!Array.isArray(row) || row.length < 9) throw new Error(`${symbol}: malformed kline row`);
  const normalized = {
    symbol,
    openTime: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closeTime: Number(row[6]),
    quoteVolume: Number(row[7]),
    trades: Number(row[8])
  };
  if (Object.values(normalized).some(value => typeof value === 'number' && !Number.isFinite(value))) {
    throw new Error(`${symbol}: non-finite kline value`);
  }
  if (normalized.closeTime !== normalized.openTime + FIVE_MINUTES - 1) throw new Error(`${symbol}: invalid 5m closeTime`);
  if (normalized.high < Math.max(normalized.open, normalized.close)
    || normalized.low > Math.min(normalized.open, normalized.close)
    || normalized.high < normalized.low) throw new Error(`${symbol}: impossible kline OHLC`);
  return normalized;
}

function readNdjson(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

function assertContiguous(rows, symbol) {
  for (let index = 1; index < rows.length; index++) {
    if (rows[index].openTime !== rows[index - 1].openTime + FIVE_MINUTES) {
      throw new Error(`${symbol}: missing or duplicate 5m interval at ${rows[index].openTime}`);
    }
  }
}

function loadRawDataset({ root, manifest }) {
  if (manifest.experimentId !== HY_EXP_0028_EXPERIMENT_ID
    || manifest.status !== 'DATA_LOCKED'
    || manifest.immutable !== true
    || manifest.windowStart !== new Date(HY_EXP_0028_HOLDOUT_START).toISOString()
    || manifest.windowEndExclusive !== new Date(HY_EXP_0028_HOLDOUT_END).toISOString()) {
    throw new Error('HY-EXP-0028 holdout manifest is not locked to the frozen window');
  }
  const bars5mBySymbol = {};
  const fundingBySymbol = {};
  for (const symbol of HY_EXP_0028_SYMBOLS) {
    const klineEntry = manifest.files.find(file => file.kind === 'contract-price-5m' && file.symbol === symbol);
    const fundingEntry = manifest.files.find(file => file.kind === 'funding' && file.symbol === symbol);
    if (!klineEntry || !fundingEntry) throw new Error(`${symbol}: required holdout file missing from manifest`);
    const klineFile = path.resolve(root, klineEntry.path);
    const fundingFile = path.resolve(root, fundingEntry.path);
    if (sha256(fs.readFileSync(klineFile)) !== klineEntry.sha256) throw new Error(`${symbol}: kline hash mismatch`);
    if (sha256(fs.readFileSync(fundingFile)) !== fundingEntry.sha256) throw new Error(`${symbol}: funding hash mismatch`);
    const klineRows = [];
    for (const batch of readNdjson(klineFile)) {
      if (batch.experimentId !== HY_EXP_0028_EXPERIMENT_ID || batch.symbol !== symbol || batch.interval !== '5m') {
        throw new Error(`${symbol}: kline provenance mismatch`);
      }
      for (const row of batch.rows ?? []) klineRows.push(normalizeKlineRow(symbol, row));
    }
    klineRows.sort((left, right) => left.openTime - right.openTime);
    if (!klineRows.length) throw new Error(`${symbol}: empty kline series`);
    if (klineRows[0].openTime > HY_EXP_0028_HOLDOUT_START - 32 * DAY
      || klineRows.at(-1).openTime + FIVE_MINUTES < HY_EXP_0028_HOLDOUT_END) {
      throw new Error(`${symbol}: warmup or holdout coverage is incomplete`);
    }
    assertContiguous(klineRows, symbol);
    bars5mBySymbol[symbol] = klineRows;
    const fundingRows = [];
    for (const batch of readNdjson(fundingFile)) {
      if (batch.experimentId !== HY_EXP_0028_EXPERIMENT_ID || batch.symbol !== symbol) {
        throw new Error(`${symbol}: funding provenance mismatch`);
      }
      for (const row of batch.rows ?? []) {
        const fundingTime = Number(row.fundingTime);
        const fundingRate = Number(row.fundingRate);
        if (!Number.isFinite(fundingTime) || !Number.isFinite(fundingRate)) throw new Error(`${symbol}: malformed funding row`);
        fundingRows.push({
          symbol,
          eventTime: fundingTime,
          fundingIntervalHours: Number(row.fundingIntervalHours ?? 8),
          fundingRate
        });
      }
    }
    fundingRows.sort((left, right) => left.eventTime - right.eventTime);
    fundingBySymbol[symbol] = fundingRows;
  }
  return {
    symbols: [...HY_EXP_0028_SYMBOLS],
    bars5mBySymbol,
    bars1hBySymbol: Object.fromEntries(HY_EXP_0028_SYMBOLS.map(symbol => [symbol, aggregateBars(bars5mBySymbol[symbol], HOUR, 12, `${symbol}/1h`)])),
    bars4hBySymbol: Object.fromEntries(HY_EXP_0028_SYMBOLS.map(symbol => [symbol, aggregateBars(bars5mBySymbol[symbol], FOUR_HOURS, 48, `${symbol}/4h`)])),
    fundingBySymbol,
    sourceExperimentId: HY_EXP_0028_EXPERIMENT_ID,
    sourceManifestSha256: manifest.manifestSha256
  };
}

function buildTrade(row) {
  const size = positionSize(row);
  if (!size) throw new Error(`${row.id}: invalid holdout stop position size`);
  const realizedFundingBps = row.label.realizedFunding.fundingPnlBps;
  const net18Bps = row.label.grossPriceReturnBps - HY_EXP_0028_BASE_COST_BPS + realizedFundingBps;
  const net27Bps = row.label.grossPriceReturnBps - HY_EXP_0028_STRESS_COST_BPS + realizedFundingBps;
  return {
    experimentId: HY_EXP_0028_EXPERIMENT_ID,
    phase: 'fresh_holdout',
    status: 'PAPER_HOLDOUT_ADVISORY',
    id: row.id,
    symbol: row.symbol,
    side: 'BUY',
    regime: 'BULL',
    rule: 'RULE_A_CHANNEL_DISTANCE_Q75',
    signalTime: row.signalTime,
    decisionTime: row.decisionTime,
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
    channelDistance: row.features[Q75_FEATURE_INDEX],
    frozenQ75: HY_EXP_0028_FROZEN_Q75,
    grossPriceReturnBps: row.label.grossPriceReturnBps,
    realizedFundingBps,
    realizedFunding: row.label.realizedFunding,
    net18Bps,
    net27Bps,
    netPnl: size.notional * net18Bps / 10_000,
    stressNetPnl: size.notional * net27Bps / 10_000,
    maeBps: Math.min(...row.label.marks.map(mark => mark.returnBps)),
    mfeBps: Math.max(...row.label.marks.map(mark => mark.returnBps)),
    markToMarketDrawdownBps: markDrawdown(row.label.marks),
    marks: row.label.marks,
    costs: {
      baseTotalBps: HY_EXP_0028_BASE_COST_BPS,
      stressTotalBps: HY_EXP_0028_STRESS_COST_BPS,
      fundingSeparate: true
    },
    historicalExecutionProxy: row.label.historicalExecutionProxy,
    paperOnly: true,
    signalOnly: true,
    liveOrdersEnabled: false,
    accountApi: false,
    orderApi: false
  };
}

function summarize({ candidates, trades, manifestSha256, coverage }) {
  const ordered = [...trades].sort((left, right) => left.exitTime - right.exitTime || left.symbol.localeCompare(right.symbol));
  const days = (HY_EXP_0028_HOLDOUT_END - HY_EXP_0028_HOLDOUT_START) / DAY;
  const net18Returns = ordered.map(row => row.net18Bps);
  const net27Returns = ordered.map(row => row.net27Bps);
  const bySymbol = Object.fromEntries(HY_EXP_0028_SYMBOLS.map(symbol => [symbol, ordered.filter(row => row.symbol === symbol).length]));
  const positivePnl = ordered.filter(row => row.netPnl > 0).reduce((sum, row) => sum + row.netPnl, 0);
  const bestTrade = ordered.filter(row => row.netPnl > 0).sort((left, right) => right.netPnl - left.netPnl)[0] ?? null;
  const bestTradePositivePnlShare = positivePnl > 0 && bestTrade ? bestTrade.netPnl / positivePnl : null;
  const risk = ordered.length
    ? markToMarketMetrics(ordered)
    : {
      maxMtmDrawdown: null,
      maxMtmDrawdownBps: null,
      cvar95LossFraction: null,
      cvar95LossBps: null,
      curvePoints: 0,
      dailyObservations: 0,
      riskMetricStatus: 'EMPTY_SAMPLE_NOT_EVALUABLE'
    };
  const checks = {
    advisoryCountAtLeast8: ordered.length >= 8,
    net18ExpectancyGreaterThan0: mean(net18Returns) != null && mean(net18Returns) > 0,
    net18ProfitFactorGreaterThan1_10: profitFactor(ordered, 'netPnl') != null && profitFactor(ordered, 'netPnl') > 1.1,
    net27ExpectancyGreaterThan0: mean(net27Returns) != null && mean(net27Returns) > 0,
    net27ProfitFactorGreaterThan1_00: profitFactor(ordered, 'stressNetPnl') != null && profitFactor(ordered, 'stressNetPnl') > 1.0,
    distinctSymbolsAtLeast4: Object.values(bySymbol).filter(value => value > 0).length >= 4,
    largestSingleSymbolShareAtMost0_40: ordered.length > 0 && Math.max(...Object.values(bySymbol)) / ordered.length <= 0.4,
    maxMtmDrawdownAtMost15Percent: risk.maxMtmDrawdown != null && risk.maxMtmDrawdown <= 0.15,
    maxLossStreakAtMost6: maxLossStreak(ordered) <= 6,
    bestTradePositivePnlShareAtMost0_50: bestTradePositivePnlShare != null && bestTradePositivePnlShare <= 0.5
  };
  return {
    holdoutWindow: {
      start: new Date(HY_EXP_0028_HOLDOUT_START).toISOString(),
      endExclusive: new Date(HY_EXP_0028_HOLDOUT_END).toISOString(),
      exactDays: days
    },
    dataManifestSha256: manifestSha256,
    coverage,
    candidateCount: candidates.length,
    advisoryCount: ordered.length,
    signalsPer30Days: ordered.length * 30 / days,
    grossExpectancyBps: candidates.length ? mean(candidates.map(row => row.label.grossPriceReturnBps)) : null,
    net18ExpectancyBps: mean(net18Returns),
    net18ProfitFactor: profitFactor(ordered, 'netPnl'),
    net27ExpectancyBps: mean(net27Returns),
    net27ProfitFactor: profitFactor(ordered, 'stressNetPnl'),
    netPnl: ordered.reduce((sum, row) => sum + row.netPnl, 0),
    stressNetPnl: ordered.reduce((sum, row) => sum + row.stressNetPnl, 0),
    fundingPnl: ordered.reduce((sum, row) => sum + row.realizedFundingBps * row.notional / 10_000, 0),
    distinctSymbols: Object.values(bySymbol).filter(value => value > 0).length,
    bySymbol,
    largestSingleSymbolShare: ordered.length ? Math.max(...Object.values(bySymbol)) / ordered.length : null,
    maxMtmDrawdown: risk.maxMtmDrawdown,
    maxMtmDrawdownBps: risk.maxMtmDrawdownBps,
    cvar95LossFraction: risk.cvar95LossFraction,
    cvar95LossBps: risk.cvar95LossBps,
    maxLossStreak: maxLossStreak(ordered),
    bestTrade: bestTrade ? { id: bestTrade.id, symbol: bestTrade.symbol, netPnl: bestTrade.netPnl } : null,
    bestTradePositivePnlShare,
    risk,
    gates: { checks, pass: Object.values(checks).every(Boolean) },
    noRuleB: true,
    noSemVeto: true,
    postOutcomeFiltering: false,
    paperOnly: true,
    signalOnly: true,
    liveOrdersEnabled: false,
    accountApi: false,
    orderApi: false
  };
}

function validatePrerequisites({ root, manifest }) {
  const preregPath = path.join(root, 'registry', 'experiments', HY_EXP_0028_EXPERIMENT_ID, 'preregistration.json');
  const preregBuffer = fs.readFileSync(preregPath);
  if (sha256(preregBuffer) !== HY_EXP_0028_PREREGISTRATION_SHA256) throw new Error('HY-EXP-0028 preregistration hash mismatch');
  const prereg = JSON.parse(preregBuffer);
  if (prereg.status !== 'PREREGISTERED' || prereg.experimentId !== HY_EXP_0028_EXPERIMENT_ID) throw new Error('HY-EXP-0028 preregistration is invalid');
  if (prereg.frozenRule.filter.frozenQ75 !== HY_EXP_0028_FROZEN_Q75
    || prereg.frozenRule.filter.ruleBAllowed !== false
    || prereg.frozenRule.filter.q75TuningAllowed !== false) throw new Error('HY-EXP-0028 frozen Rule A drifted');
  if (prereg.holdout.start !== new Date(HY_EXP_0028_HOLDOUT_START).toISOString()
    || prereg.holdout.endExclusive !== new Date(HY_EXP_0028_HOLDOUT_END).toISOString()) throw new Error('HY-EXP-0028 holdout window drifted');
  const manifestBody = { ...manifest };
  delete manifestBody.manifestSha256;
  if (sha256(Buffer.from(canonicalJson(manifestBody))) !== manifest.manifestSha256) throw new Error('HY-EXP-0028 manifest hash mismatch');
  return { preregistrationSha256: sha256(preregBuffer) };
}

export function runHyExp0028Holdout({ root = process.cwd(), manifestPath = 'artifacts/HY-EXP-0028/holdout-data-manifest.json' } = {}) {
  const absoluteManifest = path.resolve(root, manifestPath);
  const manifest = JSON.parse(fs.readFileSync(absoluteManifest, 'utf8'));
  const { preregistrationSha256 } = validatePrerequisites({ root, manifest });
  const dataset = loadRawDataset({ root, manifest });
  const source = buildHyExp0024CandidateRows({ dataset });
  const candidates = source.candidates.filter(row => row.cell === 'BULL/BUY/TREND_BREAKOUT'
    && row.signalTime >= HY_EXP_0028_HOLDOUT_START
    && row.signalTime < HY_EXP_0028_HOLDOUT_END
    && row.label?.labelEndTime < HY_EXP_0028_HOLDOUT_END
    && row.features?.[Q75_FEATURE_INDEX] >= HY_EXP_0028_FROZEN_Q75);
  const ids = new Set();
  for (const row of candidates) {
    if (ids.has(row.id)) throw new Error(`duplicate holdout advisory candidate: ${row.id}`);
    ids.add(row.id);
  }
  const trades = candidates.map(buildTrade);
  const coverage = Object.fromEntries(HY_EXP_0028_SYMBOLS.map(symbol => [symbol, {
    fiveMinuteBars: dataset.bars5mBySymbol[symbol].length,
    oneHourBars: dataset.bars1hBySymbol[symbol].length,
    fourHourBars: dataset.bars4hBySymbol[symbol].length,
    fundingRows: dataset.fundingBySymbol[symbol].length,
    firstBar: new Date(dataset.bars5mBySymbol[symbol][0].openTime).toISOString(),
    lastBarExclusive: new Date(dataset.bars5mBySymbol[symbol].at(-1).openTime + FIVE_MINUTES).toISOString()
  }]));
  const metrics = summarize({ candidates, trades, manifestSha256: manifest.manifestSha256, coverage });
  return {
    experimentId: HY_EXP_0028_EXPERIMENT_ID,
    status: metrics.gates.pass ? 'HOLDOUT_PASS' : 'HOLDOUT_FAILED',
    evidenceClass: 'D1_FRESH_HOLDOUT',
    baseCommit: '6fe8c045d09d028cab0cfa48d338183e6fe73bf1',
    preregistrationSha256,
    frozenQ75: HY_EXP_0028_FROZEN_Q75,
    holdout: {
      start: new Date(HY_EXP_0028_HOLDOUT_START).toISOString(),
      endExclusive: new Date(HY_EXP_0028_HOLDOUT_END).toISOString(),
      sourceExperimentId: HY_EXP_0028_EXPERIMENT_ID,
      noDevelopmentOutcomeReuse: true,
      noFinalOosRead: true
    },
    holdoutPnlComputed: true,
    finalOosRead: false,
    finalOosPnlComputed: false,
    holdoutPass: metrics.gates.pass,
    experimentalReleaseReady: metrics.gates.pass,
    deploymentPrepared: false,
    metrics,
    trades,
    diagnostics: trades.map(trade => ({
      id: trade.id,
      status: 'ADVISORY',
      matchedRule: 'A',
      postOutcomeFilter: false,
      outcome: {
        net18Bps: trade.net18Bps,
        net27Bps: trade.net27Bps,
        exitReason: trade.exitReason
      }
    })),
    livePath: {
      implemented: false,
      deployed: false,
      allowedOnlyIfHoldoutPass: true,
      reason: metrics.gates.pass ? 'requires explicit human deployment approval; no deployment performed' : 'holdout gates failed; no live path prepared'
    },
    safety: {
      signalOnly: true,
      paperOnly: true,
      liveOrdersEnabled: false,
      accountApi: false,
      orderApi: false,
      noAutomaticTrade: true
    }
  };
}

export { canonicalJson, loadRawDataset, sha256 };
