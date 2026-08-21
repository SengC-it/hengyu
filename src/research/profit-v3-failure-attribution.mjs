import { atrAt } from './h10-trend.mjs';
import { calculateTradePathMetrics } from '../model/trade-metrics.mjs';

export const FOUR_HOURS = 4 * 60 * 60 * 1_000;

const EXIT_LABELS = Object.freeze({
  ATR_STOP: 'ATR_STOP',
  DYNAMIC_DONCHIAN_EXIT: 'CHANNEL_EXIT',
  TERMINAL_EXIT: 'TERMINAL_EXIT'
});

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function mean(values) {
  return values.length ? sum(values) / values.length : null;
}

function rms(values) {
  return values.length ? Math.sqrt(mean(values.map(value => value ** 2))) : null;
}

function quantile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function groupBy(rows, keyOf) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function profitFactor(rows) {
  const wins = sum(rows.map(row => Math.max(0, finite(row.netPnl) ?? 0)));
  const losses = sum(rows.map(row => Math.min(0, finite(row.netPnl) ?? 0)));
  return losses < 0 ? wins / Math.abs(losses) : wins > 0 ? null : 0;
}

export function summarizeRows(rows) {
  const netPnls = rows.map(row => finite(row.netPnl)).filter(value => value != null);
  const netReturns = rows.map(row => finite(row.netReturnBps)).filter(value => value != null);
  const mfe = rows.map(row => finite(row.mfeBps)).filter(value => value != null);
  const mae = rows.map(row => finite(row.maeBps)).filter(value => value != null);
  const realized = rows.map(row => finite(row.realizedForwardReturnBps)).filter(value => value != null);
  const predicted = rows.map(row => finite(row.predictedEdgeBps)).filter(value => value != null);
  return {
    count: rows.length,
    totalNetPnl: sum(netPnls),
    meanNetPnl: mean(netPnls),
    netProfitFactor: profitFactor(rows),
    positiveCount: netPnls.filter(value => value > 0).length,
    negativeCount: netPnls.filter(value => value < 0).length,
    meanNetReturnBps: mean(netReturns),
    meanMfeBps: mean(mfe),
    meanMaeBps: mean(mae),
    meanPredictedEdgeBps: mean(predicted),
    meanRealizedForwardReturnBps: mean(realized),
    totalFees: sum(rows.map(row => finite(row.fees) ?? 0)),
    totalFundingPnl: sum(rows.map(row => finite(row.fundingPnl) ?? 0))
  };
}

function marksForTrade(trade, bars = []) {
  const entryTime = finite(trade.entryTime);
  const exitTime = finite(trade.exitTime);
  if (entryTime == null || exitTime == null) return [];
  const marks = [];
  for (const bar of bars) {
    const openTime = finite(bar.openTime);
    const closeTime = finite(bar.closeTime ?? (openTime == null ? null : openTime + FOUR_HOURS - 1));
    if (openTime == null || closeTime == null || openTime > exitTime || closeTime < entryTime) continue;
    if (trade.side === 'BUY') {
      marks.push({ time: openTime, price: bar.low });
      marks.push({ time: openTime + 1, price: bar.high });
    } else if (trade.side === 'SELL') {
      marks.push({ time: openTime, price: bar.high });
      marks.push({ time: openTime + 1, price: bar.low });
    }
    marks.push({ time: closeTime, price: bar.close });
  }
  return marks;
}

function signalAtrBps(trade, bars = [], period = 30) {
  const signalTime = finite(trade.signalTime);
  const entryMidPrice = finite(trade.entryMidPrice);
  if (signalTime == null || !(entryMidPrice > 0)) return null;
  const index = bars.findIndex(bar => Number(bar.closeTime) === signalTime || Number(bar.openTime) === signalTime);
  if (index < 0) return null;
  const atr = atrAt(bars, index, period);
  return atr == null ? null : atr / entryMidPrice * 10_000;
}

function breakoutDistanceBps(trade) {
  return finite(trade.edge?.featureSummary?.breakoutDistanceBps);
}

export function attributeTrade({ trade, bars = [], atrPeriod = 30 }) {
  const path = calculateTradePathMetrics({
    side: trade.side,
    entryPrice: trade.entryPrice,
    marks: marksForTrade(trade, bars)
  });
  const reconstructedMfeBps = finite(path.mfeBps) ?? finite(trade.mfeBps);
  const reconstructedMaeBps = finite(path.maeBps) ?? finite(trade.maeBps);
  const reconstructedMtmDrawdownBps = finite(path.markToMarketDrawdownBps)
    ?? finite(trade.markToMarketDrawdownBps);
  const mfeMark = reconstructedMfeBps == null
    ? null
    : path.marks.find(mark => Math.abs(mark.returnBps - reconstructedMfeBps) < 1e-9) ?? null;
  const entryTime = finite(trade.entryTime);
  const timeToMfeMs = mfeMark && entryTime != null ? mfeMark.time - entryTime : null;
  const netReturnBps = finite(trade.netReturnBps);
  const executablePriceReturnBps = finite(trade.executablePriceReturnBps);
  const predictedEdgeBps = finite(trade.edge?.expectedPriceEdgeBps);
  const fundingPnl = finite(trade.fundingPnl) ?? 0;
  const fees = finite(trade.fees) ?? 0;
  const netPnl = finite(trade.netPnl) ?? 0;
  const profitGivebackBps = reconstructedMfeBps == null || netReturnBps == null
    ? null
    : reconstructedMfeBps - netReturnBps;
  return {
    ...trade,
    exitLabel: EXIT_LABELS[trade.exitReason] ?? 'OTHER_EXIT',
    reconstructedMfeBps,
    reconstructedMaeBps,
    reconstructedMtmDrawdownBps,
    timeToMfeMs,
    timeToMfeBars: timeToMfeMs == null ? null : timeToMfeMs / FOUR_HOURS,
    mfeTime: mfeMark ? new Date(mfeMark.time).toISOString() : null,
    profitGivebackBps,
    profitGivebackFraction: profitGivebackBps == null || !(reconstructedMfeBps > 0)
      ? null
      : profitGivebackBps / reconstructedMfeBps,
    predictedEdgeBps,
    realizedForwardReturnBps: executablePriceReturnBps,
    predictionErrorBps: predictedEdgeBps == null || executablePriceReturnBps == null
      ? null
      : executablePriceReturnBps - predictedEdgeBps,
    absolutePredictionErrorBps: predictedEdgeBps == null || executablePriceReturnBps == null
      ? null
      : Math.abs(executablePriceReturnBps - predictedEdgeBps),
    pricePnlAfterExecution: netPnl - fundingPnl + fees,
    signalAtrBps: signalAtrBps(trade, bars, atrPeriod),
    breakoutDistanceBps: breakoutDistanceBps(trade),
    pathMarkCount: path.marks.length
  };
}

function withEdgeDeciles(rows) {
  const ranked = rows
    .filter(row => finite(row.predictedEdgeBps) != null)
    .sort((left, right) => (left.predictedEdgeBps - right.predictedEdgeBps)
      || (left.signalTime - right.signalTime)
      || left.symbol.localeCompare(right.symbol));
  const decileByTrade = new Map();
  ranked.forEach((row, index) => {
    decileByTrade.set(row, Math.min(10, Math.floor(index * 10 / ranked.length) + 1));
  });
  return rows.map(row => ({ ...row, edgeDecile: decileByTrade.get(row) ?? null }));
}

function groupedSummaries(rows, keyOf) {
  return Object.fromEntries([...groupBy(rows, keyOf)]
    .sort(([left], [right]) => String(left).localeCompare(String(right)))
    .map(([key, values]) => [key, summarizeRows(values)]));
}

function groupedCalibration(rows, keyOf) {
  return Object.fromEntries([...groupBy(rows.filter(row => row.predictedEdgeBps != null
    && row.realizedForwardReturnBps != null), keyOf)]
    .sort(([left], [right]) => String(left).localeCompare(String(right)))
    .map(([key, values]) => {
      const errors = values.map(row => row.predictionErrorBps);
      return [key, {
        ...summarizeRows(values),
        meanPredictionErrorBps: mean(errors),
        meanAbsolutePredictionErrorBps: mean(values.map(row => row.absolutePredictionErrorBps)),
        rmsePredictionErrorBps: rms(errors),
        predictedPositiveCount: values.filter(row => row.predictedEdgeBps > 0).length,
        realizedPositiveCount: values.filter(row => row.realizedForwardReturnBps > 0).length
      }];
    }));
}

function addVolatilityBuckets(rows) {
  const values = rows.map(row => row.signalAtrBps).filter(value => value != null);
  const lowHigh = quantile(values, 1 / 3);
  const mediumHigh = quantile(values, 2 / 3);
  return {
    thresholdsBps: { lowHigh, mediumHigh },
    rows: rows.map(row => ({
      ...row,
      volatilityBucket: row.signalAtrBps == null
        ? 'UNKNOWN'
        : row.signalAtrBps <= lowHigh ? 'LOW'
          : row.signalAtrBps <= mediumHigh ? 'MEDIUM' : 'HIGH'
    }))
  };
}

function breakoutBucket(value) {
  if (value == null) return 'UNKNOWN';
  if (value < 25) return '0-25_BPS';
  if (value < 50) return '25-50_BPS';
  if (value < 100) return '50-100_BPS';
  return '100_PLUS_BPS';
}

function buildCalibration(rows) {
  const eligible = rows.filter(row => row.predictedEdgeBps != null && row.realizedForwardReturnBps != null);
  const errors = eligible.map(row => row.predictionErrorBps);
  return {
    definition: {
      predicted: 'edge.expectedPriceEdgeBps',
      realizedForwardReturn: 'executablePriceReturnBps before fee and funding',
      predictionError: 'realizedForwardReturnBps - predictedEdgeBps'
    },
    count: eligible.length,
    meanPredictedEdgeBps: mean(eligible.map(row => row.predictedEdgeBps)),
    meanRealizedForwardReturnBps: mean(eligible.map(row => row.realizedForwardReturnBps)),
    meanPredictionErrorBps: mean(errors),
    meanAbsolutePredictionErrorBps: mean(eligible.map(row => row.absolutePredictionErrorBps)),
    rmsePredictionErrorBps: rms(errors),
    predictedPositiveCount: eligible.filter(row => row.predictedEdgeBps > 0).length,
    realizedPositiveCount: eligible.filter(row => row.realizedForwardReturnBps > 0).length,
    byEdgeDecile: groupedCalibration(eligible, row => `D${row.edgeDecile}`)
  };
}

function buildBearCandidateAttribution({ scans, oosTrades }) {
  const candidates = [];
  for (const scan of scans) {
    if (scan.phase !== 'oos' || scan.regime?.regime !== 'BEAR') continue;
    for (const [symbol, row] of Object.entries(scan.symbols ?? {})) {
      if (row.breakout !== true) continue;
      candidates.push({
        signalTime: scan.signalTime,
        symbol,
        status: row.status ?? 'UNKNOWN',
        reasons: row.reasons ?? [],
        expectedPriceEdgeBps: finite(row.edge?.expectedPriceEdgeBps),
        conservativeNetEdgeBps: finite(row.netEdge?.conservativeNetEdgeBps),
        breakoutDistanceBps: finite(row.breakoutDistanceBps),
        side: row.side ?? null
      });
    }
  }
  const statusCounts = {};
  const reasonCounts = {};
  const symbolCounts = {};
  for (const candidate of candidates) {
    statusCounts[candidate.status] = (statusCounts[candidate.status] ?? 0) + 1;
    symbolCounts[candidate.symbol] = (symbolCounts[candidate.symbol] ?? 0) + 1;
    for (const reason of candidate.reasons) reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
  }
  const finalTrades = oosTrades.filter(trade => trade.regime === 'BEAR' && trade.side === 'SELL');
  const topRejections = Object.entries(reasonCounts)
    .sort(([, left], [, right]) => right - left)
    .map(([reason, count]) => ({ reason, count }));
  return {
    candidateCount: candidates.length,
    finalTradeCount: finalTrades.length,
    statusCounts,
    rejectionReasons: topRejections,
    candidateCountBySymbol: symbolCounts,
    finalTradeSymbols: [...new Set(finalTrades.map(trade => trade.symbol))].sort(),
    conclusion: finalTrades.length === 0
      ? 'Bear candidates did not become final trades; candidate rows were rejected by the frozen edge/cost/portfolio gates. This is an attribution of the frozen run, not a proposal to relax gates.'
      : 'Bear candidates produced final trades in the frozen run.'
  };
}

function selectedMetrics(metrics) {
  return {
    tradeCount: metrics?.tradeCount ?? null,
    candidateCount: metrics?.candidateCount ?? null,
    netProfitFactor: metrics?.netProfitFactor ?? null,
    netReturn: metrics?.netReturn ?? null,
    netReturnBps: metrics?.netReturnBps ?? null,
    markToMarketDrawdown: metrics?.markToMarketDrawdown ?? null,
    markToMarketDrawdownBps: metrics?.markToMarketDrawdownBps ?? null,
    cvar95Bps: metrics?.cvar95Bps ?? null,
    positiveMonths: metrics?.positiveMonths ?? null,
    observedMonths: metrics?.observedMonths ?? null,
    positiveMonthShare: metrics?.positiveMonthShare ?? null,
    symbolBreadth: metrics?.symbolBreadth ?? null,
    regimeBreadth: metrics?.regimeBreadth ?? null,
    fundingPnl: metrics?.fundingPnl ?? null,
    totalFees: metrics?.totalFees ?? null,
    paperOnly: metrics?.paperOnly ?? null,
    liveOrdersEnabled: metrics?.liveOrdersEnabled ?? null
  };
}

export function buildFailureAttribution({
  result,
  trades,
  scans,
  barsBySymbol,
  sourceHashes = {},
  sourceCommit = null,
  generatedAt = new Date().toISOString(),
  atrPeriod = 30
}) {
  const oosTrades = trades.filter(trade => trade.phase === 'oos');
  if (result?.experimentId !== 'HY-EXP-0019') throw new Error('failure attribution requires HY-EXP-0019');
  if (result?.oos?.tradeCount !== oosTrades.length) {
    throw new Error(`OOS trade count mismatch: result=${result?.oos?.tradeCount} rows=${oosTrades.length}`);
  }
  const attributed = withEdgeDeciles(oosTrades.map(trade => attributeTrade({
    trade,
    bars: barsBySymbol?.[trade.symbol] ?? [],
    atrPeriod
  })));
  const volatility = addVolatilityBuckets(attributed);
  const rows = volatility.rows.map(row => ({
    ...row,
    breakoutBucket: breakoutBucket(row.breakoutDistanceBps)
  }));
  const calibration = buildCalibration(rows);
  const costRows = rows.map(row => ({
    ...row,
    pricePnlAfterExecution: row.pricePnlAfterExecution,
    fundingPnl: finite(row.fundingPnl) ?? 0,
    fees: finite(row.fees) ?? 0
  }));
  return {
    reportVersion: '1.0.0',
    experimentId: 'HY-EXP-0019',
    status: 'FAILURE_ATTRIBUTION_ONLY',
    generatedAt,
    sourceCommit,
    sourceHashes,
    immutability: {
      doesNotModifyResult: true,
      doesNotModifyTrades: true,
      originalOosMetrics: selectedMetrics(result.oos),
      originalDevelopmentMetrics: selectedMetrics(result.development)
    },
    oosWindow: {
      start: '2025-07-01T00:00:00.000Z',
      endExclusive: '2026-07-01T00:00:00.000Z',
      reuseClassification: 'DEVELOPMENT_INFORMATION_ONLY_FOR_FUTURE_EXPERIMENTS'
    },
    tradeAttribution: {
      count: rows.length,
      fields: {
        timeToMfe: 'first reconstructed 4H OHLC path mark reaching MFE; time from entryTime',
        profitGiveback: 'reconstructedMfeBps - final netReturnBps; includes fees and funding',
        realizedForwardReturn: 'executablePriceReturnBps before fee and funding',
        pricePnlAfterExecution: 'netPnl - fundingPnl + fees'
      },
      rows
    },
    exitDistribution: groupedSummaries(rows, row => row.exitLabel),
    calibration,
    byEdgeDecile: groupedSummaries(rows, row => `D${row.edgeDecile ?? 'UNKNOWN'}`),
    bySymbol: groupedSummaries(rows, row => row.symbol),
    byVolatility: {
      thresholdsBps: volatility.thresholdsBps,
      groups: groupedSummaries(rows, row => row.volatilityBucket)
    },
    byBreakoutDistance: groupedSummaries(rows, row => row.breakoutBucket),
    bearCandidateAttribution: buildBearCandidateAttribution({ scans, oosTrades }),
    costLossDecomposition: {
      definition: {
        pricePnlAfterExecution: 'executable price movement before fees/funding',
        fees: 'entry plus exit research execution fees; positive values are losses',
        fundingPnl: 'realized holding-period funding PnL; negative values are losses',
        netPnl: 'pricePnlAfterExecution - fees + fundingPnl'
      },
      tradeCount: costRows.length,
      pricePnlAfterExecution: sum(costRows.map(row => row.pricePnlAfterExecution)),
      fees: sum(costRows.map(row => row.fees)),
      fundingPnl: sum(costRows.map(row => row.fundingPnl)),
      netPnl: sum(costRows.map(row => row.netPnl)),
      grossPriceReturnBps: sum(costRows.map(row => finite(row.grossPriceReturnBps) ?? 0)),
      executablePriceReturnBps: sum(costRows.map(row => finite(row.executablePriceReturnBps) ?? 0)),
      slippageBps: sum(costRows.map(row => finite(row.slippageBps) ?? 0)),
      fundingEventCount: sum(costRows.map(row => Number(row.fundingEvents) || 0))
    },
    counterfactualExits: {
      status: 'EXPLORATORY_ONLY_NOT_OOS_RESULT',
      computed: false,
      includedInOosMetrics: false,
      promotionEligible: false,
      note: 'No alternate exit is used to repair, relabel or promote HY-EXP-0019.'
    },
    failureSummary: [
      'development_screen_failed',
      'oos_net_profit_factor_zero',
      'oos_net_return_negative',
      'oos_positive_months_zero',
      'regime_breadth_insufficient',
      'historical_depth_is_ohlcv_proxy'
    ],
    paperOnly: true,
    liveOrdersEnabled: false
  };
}
