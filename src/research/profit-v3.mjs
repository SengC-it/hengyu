import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  assertContiguous,
  mergeUniqueSeries,
  parseFundingArchive,
  parseKlineArchive
} from './archive.mjs';
import { aggregateFourHourBars, atrAt } from './h10-trend.mjs';
import {
  buildUniverseSnapshot,
  DEFAULT_UNIVERSE_POLICY,
  eligibleSymbols
} from '../model/universe.mjs';
import {
  calculateFundingStats,
  estimateFundingCarryBps
} from '../model/funding.mjs';
import {
  calculateTradePathMetrics,
  directionalReturnBps
} from '../model/trade-metrics.mjs';
import { walkBook } from '../model/net-edge.mjs';
import { NET_EDGE_CONFIG, netEdgeAdvisoryPolicy } from '../model/policy-config.mjs';
import { evaluateCandidate } from '../model/candidate-engine.mjs';
import {
  estimateProfitV3Edge,
  PROFIT_V3_EDGE_MODEL_ID,
  PROFIT_V3_EDGE_SOURCE
} from '../model/profit-v3-edge.mjs';

const BPS = 10_000;
const FOUR_HOURS = 4 * 60 * 60 * 1_000;
const DAY = 24 * 60 * 60 * 1_000;
const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const PROFIT_V3_EXPERIMENT_ID = 'HY-EXP-0019';
export const DEFAULT_PROFIT_V3_CONFIG = Object.freeze({
  experimentId: PROFIT_V3_EXPERIMENT_ID,
  sourceExperimentId: 'HY-EXP-0001',
  evaluationStart: Date.parse('2024-01-01T00:00:00.000Z'),
  developmentEnd: Date.parse('2025-07-01T00:00:00.000Z'),
  evaluationEnd: Date.parse('2026-07-01T00:00:00.000Z'),
  barIntervalMs: FOUR_HOURS,
  entryChannelBars: 120,
  exitChannelBars: 60,
  atrBars: 30,
  initialStopAtrMultiple: 2,
  volumeLookbackBars: 6,
  depthProxyFraction: 0.01,
  btcFastSmaBars: 60,
  slowSmaBars: 180,
  regimeBreadthFraction: 0.5,
  edgeHorizonBars: 6,
  edgePurgeBars: 6,
  minimumEdgeSamples: 30,
  researchNotionalUsdt: 1_000,
  researchEquityUsdt: 100_000,
  fundingStressBufferBps: 1,
  syntheticSpreadBps: 2,
  paperOnly: true,
  depthSource: 'OHLCV_PROXY_NOT_ORDERBOOK'
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

function sideSign(side) {
  if (side === 'BUY') return 1;
  if (side === 'SELL') return -1;
  throw new Error(`invalid side: ${side}`);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function average(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function monthKey(time) {
  return new Date(time).toISOString().slice(0, 7);
}

function closeTimeOf(bar) {
  return integer('bar closeTime', bar.closeTime ?? bar.openTime + FOUR_HOURS - 1);
}

function sourceFilePath(root, item) {
  const file = path.resolve(root, item.path);
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`source path escapes root: ${item.path}`);
  return file;
}

function loadSourceRows({ root, manifest, symbol, kind }) {
  const items = manifest.files
    .filter(item => item.status === 200 && item.symbol === symbol && item.kind === kind)
    .sort((left, right) => String(left.month).localeCompare(String(right.month)));
  if (!items.length) throw new Error(`${symbol}: no ${kind} archives in source manifest`);
  const chunks = items.map(item => {
    const file = sourceFilePath(root, item);
    const buffer = fs.readFileSync(file);
    if (sha256(buffer) !== item.sha256) throw new Error(`source data hash mismatch: ${item.path}`);
    return kind === 'kline'
      ? parseKlineArchive(buffer, symbol, 'contract')
      : parseFundingArchive(buffer, symbol);
  });
  return mergeUniqueSeries(chunks, kind === 'kline' ? 'openTime' : 'eventTime', `${symbol}/${kind}`);
}

/** Load the frozen source manifest and verify every input before replay. */
export function loadProfitV3Dataset({
  root = MODULE_ROOT,
  sourceManifestPath = path.join(root, 'artifacts', 'HY-EXP-0001', 'data-manifest.json')
} = {}) {
  const manifestBuffer = fs.readFileSync(sourceManifestPath);
  const manifest = JSON.parse(manifestBuffer.toString('utf8'));
  if (manifest.experiment_id !== DEFAULT_PROFIT_V3_CONFIG.sourceExperimentId) {
    throw new Error(`unexpected source experiment: ${manifest.experiment_id}`);
  }
  if (manifest.missing_files > 0) throw new Error(`source manifest has ${manifest.missing_files} missing files`);
  const symbols = [...new Set(manifest.files.filter(item => item.status === 200).map(item => item.symbol))].sort();
  const barsBySymbol = {};
  const fundingBySymbol = {};
  const coverage = {};
  for (const symbol of symbols) {
    const fiveMinute = loadSourceRows({ root, manifest, symbol, kind: 'kline' });
    assertContiguous(fiveMinute, `${symbol}/kline`);
    const bars = aggregateFourHourBars(fiveMinute);
    const funding = loadSourceRows({ root, manifest, symbol, kind: 'funding' });
    barsBySymbol[symbol] = bars;
    fundingBySymbol[symbol] = funding;
    coverage[symbol] = {
      fiveMinuteBars: fiveMinute.length,
      fourHourBars: bars.length,
      fundingRows: funding.length,
      firstBar: bars[0]?.openTime ?? null,
      lastBar: bars.at(-1)?.openTime ?? null
    };
  }
  return {
    sourceManifest: manifest,
    sourceManifestSha256: sha256(manifestBuffer),
    symbols,
    barsBySymbol,
    fundingBySymbol,
    coverage
  };
}

/** Create a compact lock that records the exact source files used by V3. */
export function buildProfitV3DataManifest({
  root = MODULE_ROOT,
  sourceManifestPath = path.join(root, 'artifacts', 'HY-EXP-0001', 'data-manifest.json'),
  preregistrationSha256 = null
} = {}) {
  const sourceBuffer = fs.readFileSync(sourceManifestPath);
  const source = JSON.parse(sourceBuffer.toString('utf8'));
  const files = source.files.filter(item => item.status === 200).map(item => ({
    kind: item.kind,
    symbol: item.symbol,
    month: item.month,
    path: item.path,
    sha256: item.sha256,
    bytes: item.bytes
  }));
  return {
    experiment_id: PROFIT_V3_EXPERIMENT_ID,
    generated_at: new Date().toISOString(),
    source_experiment_id: source.experiment_id,
    source_manifest_sha256: sha256(sourceBuffer),
    preregistration_sha256: preregistrationSha256,
    source: 'Binance official public archive via locked HY-EXP-0001 manifest',
    point_in_time_universe: true,
    depth_source: DEFAULT_PROFIT_V3_CONFIG.depthSource,
    files
  };
}

function alignedSeries(barsBySymbol, symbols) {
  const reference = barsBySymbol.BTCUSDT ?? barsBySymbol[symbols[0]];
  if (!reference) throw new Error('BTCUSDT or reference series is unavailable');
  const maps = Object.fromEntries(symbols.map(symbol => [
    symbol,
    new Map((barsBySymbol[symbol] ?? []).map(row => [row.openTime, row]))
  ]));
  const times = reference
    .map(row => row.openTime)
    .filter(time => symbols.every(symbol => maps[symbol].has(time)));
  if (times.length < 1) throw new Error('no aligned 4h timestamps');
  const aligned = Object.fromEntries(symbols.map(symbol => [
    symbol,
    times.map(time => maps[symbol].get(time))
  ]));
  return { barsBySymbol: aligned, timestamps: times };
}

function rollingQuoteVolume(rows, index, lookback) {
  const start = Math.max(0, index - lookback + 1);
  return rows.slice(start, index + 1).reduce((total, row) => total + Number(row.quoteVolume ?? 0), 0);
}

function sma(rows, index, period) {
  if (index < period - 1) return null;
  return average(rows.slice(index - period + 1, index + 1).map(row => Number(row.close)));
}

/**
 * The historical source has no order-book archive. This creates a deliberately
 * labelled, conservative depth proxy from completed quote volume. It is used
 * for research accounting only and makes the result ineligible for promotion.
 */
export function buildResearchBook({
  midPrice,
  quoteDepthUsdt,
  receivedAt,
  spreadBps = DEFAULT_PROFIT_V3_CONFIG.syntheticSpreadBps
}) {
  const mid = finite('research book midPrice', midPrice, { minimum: 0, exclusiveMinimum: true });
  const depth = finite('research book quoteDepthUsdt', quoteDepthUsdt, { minimum: 0, exclusiveMinimum: true });
  const at = integer('research book receivedAt', receivedAt);
  const spread = finite('research book spreadBps', spreadBps, { minimum: 0 });
  const halfSpread = mid * spread / BPS / 2;
  const bid = mid - halfSpread;
  const ask = mid + halfSpread;
  const bidFar = mid * (1 - 0.0008);
  const askFar = mid * (1 + 0.0008);
  const halfDepth = depth / 2;
  return {
    eventTime: at,
    receivedAt: at,
    depthSource: DEFAULT_PROFIT_V3_CONFIG.depthSource,
    bids: [[bid, halfDepth / bid], [bidFar, halfDepth / bidFar]],
    asks: [[ask, halfDepth / ask], [askFar, halfDepth / askFar]]
  };
}

function syntheticDepthForSymbol({ row, bars, index, config }) {
  const quoteVolume = rollingQuoteVolume(bars, index, config.volumeLookbackBars);
  return Math.max(0, quoteVolume * config.depthProxyFraction);
}

function buildUniverseAt({ barsBySymbol, symbols, index, config, universePolicy }) {
  const observedAt = closeTimeOf(barsBySymbol.BTCUSDT[index]);
  const exchangeInfo = symbols.map(symbol => ({
    symbol,
    baseAsset: symbol.replace(/USDT$/, ''),
    quoteAsset: 'USDT',
    contractType: 'PERPETUAL',
    status: 'TRADING',
    onboardDate: barsBySymbol[symbol][0].openTime,
    asOf: observedAt
  }));
  const tickers = symbols.map(symbol => ({
    symbol,
    quoteVolume: rollingQuoteVolume(barsBySymbol[symbol], index, config.volumeLookbackBars),
    asOf: observedAt
  }));
  const depths = symbols.map(symbol => {
    const row = barsBySymbol[symbol][index];
    const depth = syntheticDepthForSymbol({ row, bars: barsBySymbol[symbol], index, config });
    return buildResearchBook({
      midPrice: row.close,
      quoteDepthUsdt: Math.max(depth, 1),
      receivedAt: observedAt,
      spreadBps: config.syntheticSpreadBps
    });
  }).map((book, position) => ({ ...book, symbol: symbols[position] }));
  const snapshot = buildUniverseSnapshot({
    observedAt,
    exchangeInfo,
    tickers,
    depths,
    policy: { ...DEFAULT_UNIVERSE_POLICY, ...(universePolicy ?? {}) }
  });
  return {
    ...snapshot,
    depthSource: config.depthSource,
    sourceRule: 'completed OHLCV quote volume only; no future rows or order book snapshots'
  };
}

function regimeAt({ barsBySymbol, index, universe, config }) {
  const reference = barsBySymbol.BTCUSDT;
  const btcFastSma = sma(reference, index, config.btcFastSmaBars);
  const btcSlowSma = sma(reference, index, config.slowSmaBars);
  if (btcFastSma == null || btcSlowSma == null || !universe.symbols.includes('BTCUSDT')) {
    return {
      regime: 'SIDEWAYS',
      bull: false,
      bear: false,
      breadth: 0,
      minimumBreadth: null,
      btcFastSma,
      btcSlowSma,
      btcClose: reference[index].close,
      reason: 'REGIME_WARMUP_OR_REFERENCE_UNAVAILABLE',
      bySymbol: {}
    };
  }
  const minimumBreadth = Math.max(1, Math.ceil(universe.symbols.length * config.regimeBreadthFraction));
  const bySymbol = Object.fromEntries(universe.symbols.map(symbol => {
    const rows = barsBySymbol[symbol];
    const slow = sma(rows, index, config.slowSmaBars);
    const close = rows[index].close;
    return [symbol, {
      close,
      slowSma: slow,
      aboveSlowSma: slow != null && close > slow,
      belowSlowSma: slow != null && close < slow,
      distanceToSlowSmaBps: slow ? (close / slow - 1) * BPS : null
    }];
  }));
  const breadthAbove = Object.values(bySymbol).filter(row => row.aboveSlowSma).length;
  const breadthBelow = Object.values(bySymbol).filter(row => row.belowSlowSma).length;
  const bull = btcFastSma > btcSlowSma
    && reference[index].close > btcSlowSma
    && breadthAbove >= minimumBreadth;
  const bear = btcFastSma < btcSlowSma
    && reference[index].close < btcSlowSma
    && breadthBelow >= minimumBreadth;
  return {
    regime: bull ? 'BULL' : bear ? 'BEAR' : 'SIDEWAYS',
    bull,
    bear,
    breadth: bull ? breadthAbove : bear ? breadthBelow : Math.max(breadthAbove, breadthBelow),
    breadthAbove,
    breadthBelow,
    minimumBreadth,
    btcFastSma,
    btcSlowSma,
    btcClose: reference[index].close,
    reason: bull ? 'BULL_TREND_CONFIRMED' : bear ? 'BEAR_TREND_CONFIRMED' : 'REGIME_SIDEWAYS',
    bySymbol
  };
}

function buildDecisionContext({ barsBySymbol, symbols, index, config, universePolicy }) {
  const referenceBar = barsBySymbol.BTCUSDT[index];
  const universe = buildUniverseAt({ barsBySymbol, symbols, index, config, universePolicy });
  const regime = regimeAt({ barsBySymbol, index, universe, config });
  const included = new Set(eligibleSymbols(universe));
  const symbolDiagnostics = {};
  for (const symbol of symbols) {
    const rows = barsBySymbol[symbol];
    const row = rows[index];
    const priorEntry = rows.slice(index - config.entryChannelBars, index);
    const priorExit = rows.slice(index - config.exitChannelBars, index);
    const priorHigh = priorEntry.length ? Math.max(...priorEntry.map(item => item.high)) : null;
    const priorLow = priorEntry.length ? Math.min(...priorEntry.map(item => item.low)) : null;
    const atr = atrAt(rows, index, config.atrBars);
    const side = regime.regime === 'BULL' ? 'BUY' : regime.regime === 'BEAR' ? 'SELL' : null;
    const breakout = side === 'BUY'
      ? priorHigh != null && row.close > priorHigh
      : side === 'SELL'
        ? priorLow != null && row.close < priorLow
        : false;
    const breakoutDistanceBps = side === 'BUY' && priorHigh != null
      ? (row.close - priorHigh) / row.close * BPS
      : side === 'SELL' && priorLow != null
        ? (priorLow - row.close) / row.close * BPS
        : null;
    const universeRow = universe.included.find(item => item.symbol === symbol) ?? null;
    const reasons = [];
    if (!included.has(symbol)) reasons.push('UNIVERSE_EXCLUDED');
    if (!['BULL', 'BEAR'].includes(regime.regime)) reasons.push('REGIME_SIDEWAYS');
    if (priorEntry.length !== config.entryChannelBars) reasons.push('INSUFFICIENT_BREAKOUT_HISTORY');
    if (!breakout && priorEntry.length === config.entryChannelBars && ['BULL', 'BEAR'].includes(regime.regime)) {
      reasons.push('NO_BREAKOUT');
    }
    if (!(atr > 0)) reasons.push('INVALID_ATR');
    symbolDiagnostics[symbol] = {
      symbol,
      signalClose: row.close,
      priorEntryHigh: priorHigh,
      priorEntryLow: priorLow,
      priorExitHigh: priorExit.length ? Math.max(...priorExit.map(item => item.high)) : null,
      priorExitLow: priorExit.length ? Math.min(...priorExit.map(item => item.low)) : null,
      atr,
      side,
      breakout,
      breakoutDistanceBps,
      quoteVolumeUsdt: universeRow?.quoteVolumeUsdt ?? null,
      minSideDepthUsdt: universeRow?.minSideDepthUsdt ?? null,
      universeTier: universeRow?.tier ?? null,
      reasons
    };
  }
  return {
    index,
    signalTime: closeTimeOf(referenceBar),
    openTime: referenceBar.openTime,
    universe,
    regime,
    symbolDiagnostics
  };
}

function candidateObservation(context, symbol, rows, config) {
  const detail = context.symbolDiagnostics[symbol];
  if (!detail?.breakout || !['BULL', 'BEAR'].includes(context.regime.regime)) return null;
  const index = context.index;
  const entry = rows[index + 1];
  const target = rows[index + config.edgeHorizonBars];
  if (!entry || !target) return null;
  const side = detail.side;
  const entryMid = finite('edge entry mid', entry.open, { minimum: 0, exclusiveMinimum: true });
  return {
    symbol,
    side,
    regime: context.regime.regime,
    signalTime: context.signalTime,
    labelEndTime: closeTimeOf(target),
    forwardReturnBps: directionalReturnBps(side, entryMid, target.close),
    breakoutDistanceBps: detail.breakoutDistanceBps,
    featureSummary: {
      breakoutDistanceBps: detail.breakoutDistanceBps,
      quoteVolumeUsdt: detail.quoteVolumeUsdt,
      depthProxyUsdt: detail.minSideDepthUsdt
    }
  };
}

function latestFunding(rows, time) {
  let latest = null;
  for (const row of rows ?? []) {
    if (row.eventTime > time) break;
    latest = row;
  }
  return latest;
}

function buildCandidateForContext({
  context,
  symbol,
  barsBySymbol,
  fundingBySymbol,
  observations,
  phase,
  config
}) {
  const detail = context.symbolDiagnostics[symbol];
  if (!detail?.breakout) return { candidate: null, rejection: 'NO_BREAKOUT' };
  const rows = barsBySymbol[symbol];
  const signalBar = rows[context.index];
  const funding = latestFunding(fundingBySymbol[symbol], context.signalTime);
  if (!funding) return { candidate: null, rejection: 'MISSING_FUNDING_HISTORY' };
  const depth = detail.minSideDepthUsdt;
  if (!(depth > 0)) return { candidate: null, rejection: 'MISSING_DEPTH_PROXY' };
  const decisionBook = buildResearchBook({
    midPrice: signalBar.close,
    quoteDepthUsdt: depth,
    receivedAt: context.signalTime,
    spreadBps: config.syntheticSpreadBps
  });
  const side = detail.side;
  const quantity = config.researchNotionalUsdt / signalBar.close;
  const preview = walkBook({ side, quantity, book: decisionBook });
  if (!preview.fillable) return { candidate: null, rejection: 'INSUFFICIENT_DEPTH_PROXY' };
  const expectedFundingBps = estimateFundingCarryBps({
    side,
    fundingRate: funding.fundingRate,
    holdingPeriodMs: config.edgeHorizonBars * config.barIntervalMs,
    fundingIntervalMs: 8 * 60 * 60 * 1_000
  });
  const candidate = {
    experimentId: config.experimentId,
    hypothesisId: 'P3-SYMMETRIC-TREND-BREAKOUT',
    sourceStrategy: 'PROFIT_V3_TREND',
    symbol,
    side,
    regime: context.regime.regime,
    signalTime: context.signalTime,
    decisionTime: context.signalTime,
    forecastTime: context.signalTime,
    bookTime: context.signalTime,
    quantity,
    researchNotionalUsdt: config.researchNotionalUsdt,
    executablePrice: preview.vwap,
    breakoutDistanceBps: detail.breakoutDistanceBps,
    stopPrice: side === 'BUY'
      ? signalBar.close - config.initialStopAtrMultiple * detail.atr
      : signalBar.close + config.initialStopAtrMultiple * detail.atr,
    expectedFundingBps,
    fundingStressBps: Math.abs(expectedFundingBps) + config.fundingStressBufferBps,
    funding: {
      latestKnownFundingRate: funding.fundingRate,
      latestKnownFundingTime: funding.eventTime,
      expectedFundingBps,
      fundingCostBps: -expectedFundingBps,
      holdingPeriodMs: config.edgeHorizonBars * config.barIntervalMs
    },
    cluster: `PROFIT_V3:${context.regime.regime}:${context.signalTime}`
  };
  const trainEnd = phase === 'oos' ? config.developmentEnd : context.signalTime;
  const edge = estimateProfitV3Edge({
    candidate,
    observations,
    asOf: context.signalTime,
    trainStart: config.evaluationStart,
    trainEnd,
    horizonBars: config.edgeHorizonBars,
    barIntervalMs: config.barIntervalMs,
    purgeBars: config.edgePurgeBars,
    minimumSamples: config.minimumEdgeSamples,
    edgeModelId: PROFIT_V3_EDGE_MODEL_ID,
    edgeSource: PROFIT_V3_EDGE_SOURCE,
    validationWindow: {
      trainStart: config.evaluationStart,
      trainEnd,
      asOf: context.signalTime,
      method: 'expanding_walk_forward_purged',
      trainingScope: phase === 'oos' ? 'development_only_frozen' : 'causal_prior_labels_only'
    }
  });
  return { candidate, edge, book: decisionBook, funding };
}

function researchExecutionBook({ midPrice, depthUsdt, receivedAt, config }) {
  return buildResearchBook({
    midPrice,
    quoteDepthUsdt: Math.max(depthUsdt, 1),
    receivedAt,
    spreadBps: config.syntheticSpreadBps
  });
}

function appendPositionMarks(position, bar) {
  const base = bar.openTime;
  if (position.side === 'BUY') {
    position.marks.push({ time: base, price: bar.low });
    position.marks.push({ time: base + 1, price: bar.high });
  } else {
    position.marks.push({ time: base, price: bar.high });
    position.marks.push({ time: base + 1, price: bar.low });
  }
  position.marks.push({ time: closeTimeOf(bar), price: bar.close });
}

function appendReason(counts, reason) {
  if (!reason) return;
  counts[reason] = (counts[reason] ?? 0) + 1;
}

function openPortfolioRows(positions) {
  return [...positions.values()].map(position => ({
    symbol: position.symbol,
    side: position.side,
    notional: position.quantity * position.entryFillPrice,
    beta: 1,
    lossAtStop: Math.abs(position.stopPrice - position.entryFillPrice) * position.quantity,
    cluster: position.cluster
  }));
}

function closeResearchPosition({ position, bar, exitMidPrice, exitTime, exitReason, fundingRows, markRows, config }) {
  const exitBook = researchExecutionBook({
    midPrice: exitMidPrice,
    depthUsdt: position.depthUsdt,
    receivedAt: exitTime,
    config
  });
  const exitSide = position.side === 'BUY' ? 'SELL' : 'BUY';
  const exit = walkBook({ side: exitSide, quantity: position.quantity, book: exitBook });
  if (!exit.fillable) throw new Error(`exit depth proxy cannot fill ${position.symbol}`);
  const exitFee = exit.quoteNotional * NET_EDGE_CONFIG.execution.feeRatePerFill;
  const funding = calculateFundingStats({
    side: position.side,
    quantity: position.quantity,
    entryPrice: position.entryFillPrice,
    fundingRates: fundingRows,
    markPrices: markRows.map(row => ({ time: row.closeTime, price: row.close })),
    entryTime: position.entryTime,
    exitTime
  });
  const metrics = calculateTradePathMetrics({
    side: position.side,
    entryPrice: position.entryFillPrice,
    marks: position.marks
  });
  const pricePnl = sideSign(position.side) * position.quantity * (exit.vwap - position.entryFillPrice);
  const fees = position.entryFee + exitFee;
  const netPnl = pricePnl - fees + funding.fundingPnl;
  const entryNotional = position.quantity * position.entryFillPrice;
  const rawPriceReturnBps = directionalReturnBps(position.side, position.entryMidPrice, exitMidPrice);
  const executablePriceReturnBps = pricePnl / entryNotional * BPS;
  const feeBps = fees / entryNotional * BPS;
  return {
    experimentId: PROFIT_V3_EXPERIMENT_ID,
    phase: position.phase,
    symbol: position.symbol,
    side: position.side,
    regime: position.regime,
    signalTime: position.signalTime,
    entryTime: position.entryTime,
    exitTime,
    entryMidPrice: position.entryMidPrice,
    entryPrice: position.entryFillPrice,
    exitMidPrice,
    exitPrice: exit.vwap,
    executablePrice: position.executablePrice,
    theoreticalOpen: position.theoreticalOpen,
    quantity: position.quantity,
    notional: entryNotional,
    exitReason,
    grossPriceReturnBps: rawPriceReturnBps,
    executablePriceReturnBps,
    feeBps,
    fees,
    spreadBps: position.entryBook ? ((position.entryBook.asks[0][0] - position.entryBook.bids[0][0]) / position.entryMidPrice * BPS) : null,
    slippageBps: executablePriceReturnBps - rawPriceReturnBps,
    fundingPnl: funding.fundingPnl,
    fundingPnlBps: funding.fundingPnlBps,
    fundingCostBps: funding.fundingCostBps,
    fundingEvents: funding.fundingEvents,
    holdingPeriodMs: funding.holdingPeriodMs,
    netPnl,
    netReturnBps: netPnl / entryNotional * BPS,
    maeBps: metrics.maeBps,
    mfeBps: metrics.mfeBps,
    markToMarketDrawdownBps: metrics.markToMarketDrawdownBps,
    edge: position.edge,
    costs: position.costs
  };
}

function metricSummary({ trades, equityCurve, scans, candidateCount, config, start, end }) {
  const ordered = trades.slice().sort((left, right) => left.exitTime - right.exitTime || left.symbol.localeCompare(right.symbol));
  const positive = ordered.filter(row => row.netPnl > 0);
  const negative = ordered.filter(row => row.netPnl < 0);
  const positivePnl = positive.reduce((total, row) => total + row.netPnl, 0);
  const negativePnl = negative.reduce((total, row) => total + row.netPnl, 0);
  const netPnl = ordered.reduce((total, row) => total + row.netPnl, 0);
  const equity = config.researchEquityUsdt;
  const curve = equityCurve.slice().sort((left, right) => left.time - right.time);
  let peak = equity;
  let maxDrawdown = 0;
  for (const row of curve) {
    peak = Math.max(peak, row.equity);
    maxDrawdown = Math.min(maxDrawdown, row.equity / peak - 1);
  }
  const returns = ordered.map(row => row.netReturnBps).sort((left, right) => left - right);
  const tailCount = returns.length ? Math.max(1, Math.ceil(returns.length * 0.05)) : 0;
  const cvar95Bps = tailCount ? average(returns.slice(0, tailCount)) : null;
  const months = [];
  const cursor = new Date(start);
  const last = new Date(end - 1);
  while (cursor <= last) {
    months.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  const monthlyNetPnl = Object.fromEntries(months.map(month => [month, 0]));
  for (const row of ordered) {
    const key = monthKey(row.exitTime);
    if (key in monthlyNetPnl) monthlyNetPnl[key] += row.netPnl;
  }
  const positiveMonths = months.filter(month => monthlyNetPnl[month] > 0).length;
  const topFivePnl = positive.slice().sort((left, right) => right.netPnl - left.netPnl).slice(0, 5)
    .reduce((total, row) => total + row.netPnl, 0);
  const bySymbol = {};
  const byRegime = {};
  const availableSymbols = new Set(scans.flatMap(scan => scan.universeSymbols ?? []));
  const observedRegimes = new Set(scans.map(scan => scan.regime?.regime).filter(Boolean));
  let fundingPnl = 0;
  let totalFees = 0;
  for (const row of ordered) {
    bySymbol[row.symbol] = (bySymbol[row.symbol] ?? 0) + row.netPnl;
    byRegime[row.regime] = (byRegime[row.regime] ?? 0) + row.netPnl;
    fundingPnl += row.fundingPnl;
    totalFees += row.fees;
  }
  const rejectionReasons = {};
  for (const scan of scans) for (const reason of scan.reasons ?? []) appendReason(rejectionReasons, reason);
  return {
    tradeCount: ordered.length,
    candidateCount,
    netProfitFactor: negativePnl < 0 ? positivePnl / Math.abs(negativePnl) : positivePnl > 0 ? Infinity : null,
    netReturn: netPnl / equity,
    netReturnBps: netPnl / equity * BPS,
    markToMarketDrawdown: maxDrawdown,
    markToMarketDrawdownBps: maxDrawdown * BPS,
    cvar95Bps,
    cvar95Fraction: cvar95Bps == null ? null : cvar95Bps / BPS,
    positiveMonths,
    observedMonths: months.length,
    positiveMonthShare: months.length ? positiveMonths / months.length : null,
    monthlyNetPnl,
    best5Concentration: positivePnl > 0 ? topFivePnl / positivePnl : null,
    symbolBreadth: {
      traded: Object.keys(bySymbol).length,
      available: availableSymbols.size,
      availableSymbols: [...availableSymbols].sort(),
      pnlBySymbol: bySymbol
    },
    regimeBreadth: {
      traded: Object.keys(byRegime).length,
      available: observedRegimes.size,
      availableRegimes: [...observedRegimes].sort(),
      pnlByRegime: byRegime
    },
    fundingPnl,
    totalFees,
    supplementaryWinRate: ordered.length ? positive.length / ordered.length : null,
    maeBps: ordered.length ? average(ordered.map(row => row.maeBps).filter(Number.isFinite)) : null,
    mfeBps: ordered.length ? average(ordered.map(row => row.mfeBps).filter(Number.isFinite)) : null,
    rejectionReasons,
    scanCount: scans.length,
    noSignalScanCount: scans.filter(scan => scan.status === 'NO_SIGNAL').length,
    advisoryScanCount: scans.filter(scan => scan.status === 'ADVISORY').length,
    paperOnly: true,
    liveOrdersEnabled: false
  };
}

function simulatePhase({
  phase,
  start,
  end,
  barsBySymbol,
  fundingBySymbol,
  symbols,
  contexts,
  observations,
  config,
  universePolicy
}) {
  const reference = barsBySymbol.BTCUSDT;
  const positions = new Map();
  const pendingEntries = [];
  const trades = [];
  const scans = [];
  const equityCurve = [];
  const rejectionCounts = {};
  let realizedPnl = 0;
  let candidateCount = 0;
  const firstIndex = reference.findIndex(row => row.openTime >= start);
  const lastIndex = reference.reduce((last, row, index) => row.openTime < end ? index : last, -1);
  if (firstIndex < 0 || lastIndex < firstIndex) {
    return { phase, trades, scans, equityCurve, metrics: metricSummary({ trades, equityCurve, scans, candidateCount, config, start, end }) };
  }
  const closeOne = (position, bar, exitMidPrice, exitTime, exitReason) => {
    const trade = closeResearchPosition({
      position,
      bar,
      exitMidPrice,
      exitTime,
      exitReason,
      fundingRows: fundingBySymbol[position.symbol],
      markRows: barsBySymbol[position.symbol],
      config
    });
    realizedPnl += trade.netPnl;
    trades.push(trade);
    positions.delete(position.symbol);
    return trade;
  };
  for (let index = firstIndex; index <= lastIndex; index++) {
    const bar = reference[index];
    const time = bar.openTime;
    // Advisory decisions are made on the completed prior bar and filled from
    // this bar's executable proxy. The fill never uses this bar to form edge.
    for (let cursor = pendingEntries.length - 1; cursor >= 0; cursor--) {
      const pending = pendingEntries[cursor];
      if (pending.entryIndex !== index) continue;
      pendingEntries.splice(cursor, 1);
      if (positions.has(pending.candidate.symbol)) {
        appendReason(rejectionCounts, 'POSITION_ALREADY_OPEN');
        continue;
      }
      const detail = pending.context.symbolDiagnostics[pending.candidate.symbol];
      const entryBook = researchExecutionBook({
        midPrice: barsBySymbol[pending.candidate.symbol][index].open,
        depthUsdt: detail.minSideDepthUsdt,
        receivedAt: time,
        config
      });
      const entry = walkBook({ side: pending.candidate.side, quantity: pending.candidate.quantity, book: entryBook });
      if (!entry.fillable) {
        appendReason(rejectionCounts, 'ENTRY_DEPTH_NOT_FILLABLE');
        pending.scan.reasons.push('ENTRY_DEPTH_NOT_FILLABLE');
        continue;
      }
      const entryFee = entry.quoteNotional * NET_EDGE_CONFIG.execution.feeRatePerFill;
      const position = {
        phase,
        symbol: pending.candidate.symbol,
        side: pending.candidate.side,
        regime: pending.candidate.regime,
        signalTime: pending.candidate.signalTime,
        entryTime: time,
        entryMidPrice: barsBySymbol[pending.candidate.symbol][index].open,
        entryFillPrice: entry.vwap,
        executablePrice: pending.candidate.executablePrice,
        theoreticalOpen: barsBySymbol[pending.candidate.symbol][index].open,
        quantity: pending.candidate.quantity,
        entryFee,
        depthUsdt: detail.minSideDepthUsdt,
        stopPrice: pending.candidate.stopPrice,
        exitChannelLow: detail.priorExitLow,
        exitChannelHigh: detail.priorExitHigh,
        cluster: pending.candidate.cluster,
        edge: pending.evaluation.edge,
        costs: pending.evaluation.netEdge.costs,
        entryBook,
        marks: []
      };
      positions.set(position.symbol, position);
    }

    // All positions are marked with intrabar extremes before exit decisions.
    for (const position of [...positions.values()]) {
      const symbolBar = barsBySymbol[position.symbol][index];
      appendPositionMarks(position, symbolBar);
      const stopHit = position.side === 'BUY'
        ? symbolBar.low <= position.stopPrice
        : symbolBar.high >= position.stopPrice;
      if (stopHit) {
        closeOne(position, symbolBar, position.stopPrice, symbolBar.openTime + 1, 'ATR_STOP');
        continue;
      }
      const channelExit = position.side === 'BUY'
        ? position.exitChannelLow != null && symbolBar.close < position.exitChannelLow
        : position.exitChannelHigh != null && symbolBar.close > position.exitChannelHigh;
      if (channelExit) closeOne(position, symbolBar, symbolBar.close, closeTimeOf(symbolBar), 'DYNAMIC_DONCHIAN_EXIT');
    }

    let equity = config.researchEquityUsdt + realizedPnl;
    for (const position of positions.values()) {
      const mark = barsBySymbol[position.symbol][index].close;
      equity += sideSign(position.side) * position.quantity * (mark - position.entryFillPrice) - position.entryFee;
    }
    equityCurve.push({ time: closeTimeOf(bar), equity });

    const signalTime = closeTimeOf(bar);
    const context = contexts.get(signalTime);
    if (!context || signalTime < start || signalTime >= end || index + 1 > lastIndex) continue;
    const scan = {
      phase,
      signalTime: context.signalTime,
      decisionTime: context.signalTime,
      universeVersion: context.universe.universeVersion,
      universeSymbols: context.universe.symbols,
      depthSource: context.universe.depthSource,
      regime: context.regime,
      symbols: {},
      status: 'NO_SIGNAL',
      reasons: []
    };
    if (context.regime.regime === 'SIDEWAYS') scan.reasons.push('REGIME_SIDEWAYS');
    for (const symbol of symbols) {
      const detail = context.symbolDiagnostics[symbol];
      const row = { ...detail };
      if (detail.reasons.length) {
        row.status = 'NO_SIGNAL';
        row.reasons = [...detail.reasons];
        for (const reason of row.reasons) {
          scan.reasons.push(`${symbol}:${reason}`);
          appendReason(rejectionCounts, reason);
        }
        scan.symbols[symbol] = row;
        continue;
      }
      if (positions.has(symbol)) {
        row.status = 'NO_SIGNAL';
        row.reasons = ['POSITION_ALREADY_OPEN'];
        scan.reasons.push(`${symbol}:POSITION_ALREADY_OPEN`);
        appendReason(rejectionCounts, 'POSITION_ALREADY_OPEN');
        scan.symbols[symbol] = row;
        continue;
      }
      const built = buildCandidateForContext({
        context,
        symbol,
        barsBySymbol,
        fundingBySymbol,
        observations,
        phase,
        config
      });
      if (!built.candidate) {
        row.status = 'NO_SIGNAL';
        row.reasons = [built.rejection];
        scan.reasons.push(`${symbol}:${built.rejection}`);
        appendReason(rejectionCounts, built.rejection);
        scan.symbols[symbol] = row;
        continue;
      }
      candidateCount++;
      const evaluation = evaluateCandidate({
        candidate: built.candidate,
        edge: built.edge,
        book: built.book,
        now: context.signalTime,
        policy: netEdgeAdvisoryPolicy({
          experimentId: config.experimentId,
          evidenceClass: 'D0_DEVELOPMENT_ONLY',
          researchEquityUsdt: config.researchEquityUsdt
        }),
        openPositions: openPortfolioRows(positions)
      });
      row.status = evaluation.decision;
      row.edge = evaluation.edge;
      row.netEdge = evaluation.netEdge.costs;
      row.reasons = evaluation.reasons;
      row.executablePrice = evaluation.netEdge.reference?.entryPrice ?? built.candidate.executablePrice;
      row.entryTheoreticalOpen = barsBySymbol[symbol][index + 1]?.open ?? null;
      for (const reason of evaluation.reasons) {
        scan.reasons.push(`${symbol}:${reason}`);
        appendReason(rejectionCounts, reason);
      }
      if (evaluation.decision === 'ADVISORY') {
        scan.status = 'ADVISORY';
        pendingEntries.push({
          entryIndex: index + 1,
          candidate: built.candidate,
          evaluation,
          context,
          scan
        });
      }
      scan.symbols[symbol] = row;
    }
    scan.reasons = unique(scan.reasons);
    if (scan.status !== 'ADVISORY') scan.status = 'NO_SIGNAL';
    if (!scan.reasons.length) scan.reasons.push('NO_ELIGIBLE_CANDIDATE');
    scans.push(scan);
  }

  const terminalBar = reference[lastIndex];
  for (const position of [...positions.values()]) {
    const symbolBar = barsBySymbol[position.symbol][lastIndex];
    if (symbolBar.openTime !== terminalBar.openTime) throw new Error('unaligned terminal bar');
    closeOne(position, symbolBar, symbolBar.close, closeTimeOf(symbolBar), 'TERMINAL_EXIT');
  }
  equityCurve.push({ time: closeTimeOf(terminalBar), equity: config.researchEquityUsdt + realizedPnl });
  const metrics = metricSummary({
    trades,
    equityCurve,
    scans,
    candidateCount,
    config,
    start,
    end
  });
  return {
    phase,
    start,
    end,
    trades,
    scans,
    equityCurve,
    rejectionCounts,
    metrics
  };
}

export function runProfitV3Backtest({
  dataset,
  config: suppliedConfig = {},
  universePolicy = null
} = {}) {
  if (!dataset?.barsBySymbol || !dataset?.symbols?.length) throw new Error('dataset is required');
  const config = { ...DEFAULT_PROFIT_V3_CONFIG, ...(suppliedConfig ?? {}) };
  const symbols = [...dataset.symbols].sort();
  const aligned = alignedSeries(dataset.barsBySymbol, symbols);
  const barsBySymbol = aligned.barsBySymbol;
  const reference = barsBySymbol.BTCUSDT;
  const warmupBars = Math.max(config.slowSmaBars, config.entryChannelBars, config.atrBars, config.volumeLookbackBars) + 1;
  const contexts = new Map();
  for (let index = warmupBars; index < reference.length - 1; index++) {
    const time = closeTimeOf(reference[index]);
    contexts.set(time, buildDecisionContext({ barsBySymbol, symbols, index, config, universePolicy }));
  }
  const observations = [];
  for (const context of contexts.values()) {
    for (const symbol of symbols) {
      const observation = candidateObservation(context, symbol, barsBySymbol[symbol], config);
      if (observation) observations.push(observation);
    }
  }
  observations.sort((left, right) => left.signalTime - right.signalTime || left.symbol.localeCompare(right.symbol));
  const development = simulatePhase({
    phase: 'development',
    start: config.evaluationStart,
    end: config.developmentEnd,
    barsBySymbol,
    fundingBySymbol: dataset.fundingBySymbol,
    symbols,
    contexts,
    observations,
    config,
    universePolicy
  });
  const oos = simulatePhase({
    phase: 'oos',
    start: config.developmentEnd,
    end: config.evaluationEnd,
    barsBySymbol,
    fundingBySymbol: dataset.fundingBySymbol,
    symbols,
    contexts,
    observations,
    config,
    universePolicy
  });
  const allScans = [...development.scans, ...oos.scans];
  const allTrades = [...development.trades, ...oos.trades];
  return {
    experimentId: config.experimentId,
    status: 'RESEARCH_ONLY_NOT_PROMOTED',
    evidenceClass: 'D0_DEVELOPMENT_ONLY',
    authorization: 'PAPER_ONLY',
    liveOrdersEnabled: false,
    sourceExperimentId: config.sourceExperimentId,
    sourceManifestSha256: dataset.sourceManifestSha256 ?? null,
    model: {
      architecture: 'Candidate -> Edge Model -> Net Edge Gate -> Portfolio Risk Gate -> Advisory',
      candidateDecisionAuthority: 'NONE',
      edgeModelId: PROFIT_V3_EDGE_MODEL_ID,
      edgeSource: PROFIT_V3_EDGE_SOURCE,
      edgeFeatureRule: 'breakoutDistanceBps is a feature summary and never expectedPriceEdgeBps',
      regimeRule: 'BULL -> LONG breakout; BEAR -> SHORT breakout; SIDEWAYS -> NO_TRADE',
      universeRule: 'point-in-time rolling quote-volume plus depth proxy; no fixed six-symbol universe',
      validation: 'expanding walk-forward with purged forward labels; development frozen before OOS'
    },
    parameters: config,
    validation: {
      development: {
        start: new Date(config.evaluationStart).toISOString(),
        endExclusive: new Date(config.developmentEnd).toISOString(),
        trainingScope: 'causal prior labels within development window'
      },
      oos: {
        start: new Date(config.developmentEnd).toISOString(),
        endExclusive: new Date(config.evaluationEnd).toISOString(),
        trainingScope: 'development_only_frozen',
        noOosLabelsUsedForEdge: true
      },
      purgeBars: config.edgePurgeBars,
      horizonBars: config.edgeHorizonBars,
      noLookaheadRule: 'candidate features and PIT universe use rows completed at or before decisionTime'
    },
    coverage: dataset.coverage,
    sourceSymbols: symbols,
    observations: {
      count: observations.length,
      bySide: Object.fromEntries(['BUY', 'SELL'].map(side => [side, observations.filter(row => row.side === side).length])),
      byRegime: Object.fromEntries(['BULL', 'BEAR'].map(regime => [regime, observations.filter(row => row.regime === regime).length]))
    },
    development: development.metrics,
    oos: oos.metrics,
    diagnostics: {
      scanCount: allScans.length,
      noSignalReasons: allScans.reduce((all, scan) => {
        for (const reason of scan.reasons ?? []) all[reason] = (all[reason] ?? 0) + 1;
        return all;
      }, {}),
      dynamicUniverse: {
        sourceSymbols: symbols.length,
        observedSnapshots: new Set(allScans.map(scan => scan.universeVersion)).size,
        depthSource: config.depthSource,
        fixedUniverse: false
      }
    },
    promotionEligible: false,
    promotionBlockers: [
      'Historical order-book depth is unavailable; OHLCV depth proxy is research-only.',
      'Evidence class is D0_DEVELOPMENT_ONLY and this branch has no forward paper validation.',
      'PAPER_ONLY: no order placement capability is enabled.'
    ],
    artifacts: {
      tradeCount: allTrades.length,
      scanCount: allScans.length
    },
    trades: allTrades,
    scans: allScans
  };
}

export function summarizeProfitV3(result) {
  return {
    experimentId: result.experimentId,
    status: result.status,
    development: result.development,
    oos: result.oos,
    promotionEligible: result.promotionEligible,
    promotionBlockers: result.promotionBlockers
  };

}

export { DAY, FOUR_HOURS };
