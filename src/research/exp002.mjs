import { FIVE_MINUTES } from './archive.mjs';
import { summarizeTrades } from './exp001.mjs';

function sampleStandardDeviation(values, mean) {
  if (values.length < 2) return null;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0)
    / (values.length - 1);
  return Math.sqrt(Math.max(0, variance));
}

export function detectFundingUnwindSignals({
  symbol,
  contractBars,
  premiumBars,
  fundingRows,
  evaluationStart,
  evaluationEnd,
  historyEvents,
  minimumAbsolutePremium,
  minimumAbsoluteZscore,
  entryDelayBars,
  holdBars
}) {
  const contractByTime = new Map(contractBars.map(row => [row.openTime, row]));
  const premiumByTime = new Map(premiumBars.map(row => [row.openTime, row]));
  const priorPremiums = [];
  const signals = [];
  let nextEligibleEntry = -Infinity;
  for (const funding of fundingRows) {
    const premium = premiumByTime.get(funding.eventTime - FIVE_MINUTES);
    if (!premium && funding.eventTime < evaluationStart) continue;
    if (!premium) throw new Error(`${symbol}: missing pre-event premium bar at ${funding.eventTime}`);
    const current = premium.close;
    const history = priorPremiums.slice(-historyEvents);
    const mean = history.length
      ? history.reduce((sum, value) => sum + value, 0) / history.length
      : null;
    const deviation = mean == null ? null : sampleStandardDeviation(history, mean);
    const zscore = deviation > 0 ? (current - mean) / deviation : null;
    const entryTime = funding.eventTime + entryDelayBars * FIVE_MINUTES;
    const exitTime = entryTime + holdBars * FIVE_MINUTES;
    const inEvaluation = funding.eventTime >= evaluationStart && funding.eventTime < evaluationEnd;
    const matches = inEvaluation
      && history.length === historyEvents
      && Number.isFinite(zscore)
      && Math.abs(current) >= minimumAbsolutePremium
      && Math.abs(zscore) >= minimumAbsoluteZscore
      && entryTime >= nextEligibleEntry;
    if (matches) {
      const entry = contractByTime.get(entryTime);
      const exit = contractByTime.get(exitTime);
      if (!entry || !exit) throw new Error(`${symbol}: missing entry or exit bar at ${funding.eventTime}`);
      const side = current > 0 ? -1 : 1;
      signals.push({
        symbol,
        side,
        eventTime: funding.eventTime,
        signalTime: funding.eventTime - 1,
        entryTime,
        exitTime,
        entryPrice: entry.open,
        exitPrice: exit.open,
        premium: current,
        premiumMean: mean,
        premiumDeviation: deviation,
        premiumZscore: zscore,
        signalFundingRate: funding.fundingRate,
        signalFundingIntervalHours: funding.fundingIntervalHours
      });
      nextEligibleEntry = exitTime;
    }
    priorPremiums.push(current);
  }
  return signals;
}

function fundingPnl(signal, fundingRows, markByTime, quantity) {
  let total = 0;
  let events = 0;
  for (const row of fundingRows) {
    if (row.eventTime < signal.entryTime) continue;
    if (row.eventTime >= signal.exitTime) break;
    const mark = markByTime.get(row.eventTime);
    if (!mark) throw new Error(`${signal.symbol}: missing mark bar at funding ${row.eventTime}`);
    total += -signal.side * quantity * mark.open * row.fundingRate;
    events++;
  }
  return { total, events };
}

export function applyExecution(signal, fundingRows, markBars, scenario) {
  const quantity = 1 / signal.entryPrice;
  const entryFill = signal.entryPrice * (1 + signal.side * scenario.slippagePerSide);
  const exitFill = signal.exitPrice * (1 - signal.side * scenario.slippagePerSide);
  const grossPriceReturn = signal.side * quantity * (signal.exitPrice - signal.entryPrice);
  const pricePnlAfterSlippage = signal.side * quantity * (exitFill - entryFill);
  const fees = scenario.feePerSide * quantity * (entryFill + exitFill);
  const markByTime = new Map(markBars.map(row => [row.openTime, row]));
  const funding = fundingPnl(signal, fundingRows, markByTime, quantity);
  return {
    ...signal,
    scenario: scenario.name,
    quantity,
    entryFill,
    exitFill,
    grossPriceReturn,
    priceReturnAfterSlippage: pricePnlAfterSlippage,
    fees,
    fundingEventsDuringHold: funding.events,
    fundingReturn: funding.total,
    netReturn: pricePnlAfterSlippage - fees + funding.total
  };
}

function groupEventClusters(trades) {
  const clusters = new Map();
  for (const trade of trades) {
    clusters.set(trade.eventTime, (clusters.get(trade.eventTime) ?? 0) + trade.netReturn);
  }
  return [...clusters.values()];
}

export function summarizeFundingTrades(trades) {
  const summary = summarizeTrades(trades);
  const clusters = groupEventClusters(trades);
  const withoutBest5Clusters = clusters.sort((a, b) => b - a).slice(5)
    .reduce((sum, value) => sum + value, 0);
  return {
    ...summary,
    eventClusters: clusters.length,
    profitWithoutBest5EventClusters: withoutBest5Clusters
  };
}

export function developmentScreen(summary, thresholds) {
  const checks = {
    minimumTrades: summary.trades >= thresholds.minimumTrades,
    stressProfitFactor: summary.profitFactor != null
      && summary.profitFactor >= thresholds.minimumProfitFactor,
    positiveNet: summary.netReturnUnits > 0,
    withoutBest5Trades: summary.profitWithoutBest5 > 0,
    withoutBest5EventClusters: summary.profitWithoutBest5EventClusters > 0,
    symbolBreadth: summary.profitableSymbols >= thresholds.minimumProfitableSymbols,
    bothDirections: (summary.byDirection.long ?? 0) > 0 && (summary.byDirection.short ?? 0) > 0,
    halfYearBreadth: summary.profitableHalfYears >= thresholds.minimumProfitableHalfYears,
    monthConcentration: summary.maxPositiveMonthContributionShare
      <= thresholds.maximumPositiveMonthContributionShare
  };
  return {
    pass: Object.values(checks).every(Boolean),
    checks,
    failures: Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name)
  };
}
