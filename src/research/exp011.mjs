import { FIVE_MINUTES } from './archive.mjs';

export const FOUR_HOURS = 4 * 60 * 60 * 1000;

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function mean(values) {
  return values.length ? sum(values) / values.length : null;
}

function sampleStandardDeviation(values, average = mean(values)) {
  if (values.length < 2 || average == null) return null;
  return Math.sqrt(sum(values.map(value => (value - average) ** 2)) / (values.length - 1));
}

function groupNet(rows, key) {
  const output = {};
  for (const row of rows) {
    const name = key(row);
    output[name] = (output[name] ?? 0) + row.netReturn;
  }
  return output;
}

export function aggregateFourHourBars(bars, symbol) {
  const output = [];
  let index = 0;
  while (index < bars.length && bars[index].openTime % FOUR_HOURS !== 0) index++;
  for (; index + 48 <= bars.length; index += 48) {
    const rows = bars.slice(index, index + 48);
    if (rows[0].openTime % FOUR_HOURS !== 0
      || rows.at(-1).closeTime !== rows[0].openTime + FOUR_HOURS - 1) {
      throw new Error(`${symbol}: incomplete UTC-aligned 4h aggregation at ${rows[0].openTime}`);
    }
    output.push({
      symbol,
      openTime: rows[0].openTime,
      closeTime: rows.at(-1).closeTime,
      open: rows[0].open,
      high: Math.max(...rows.map(row => row.high)),
      low: Math.min(...rows.map(row => row.low)),
      close: rows.at(-1).close,
      quoteVolume: sum(rows.map(row => row.quoteVolume))
    });
  }
  return output;
}

function rollingPairState(series, index, lookbackBars) {
  let count = 0;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  for (let cursor = index - lookbackBars; cursor < index; cursor++) {
    const x = Math.log(series[cursor].x.close / series[cursor - 1].x.close);
    const y = Math.log(series[cursor].y.close / series[cursor - 1].y.close);
    count++;
    sumX += x;
    sumY += y;
    sumXX += x * x;
    sumXY += x * y;
  }
  const denominator = sumXX - sumX * sumX / count;
  if (!(denominator > 0)) return null;
  const beta = (sumXY - sumX * sumY / count) / denominator;
  const spreads = series.slice(index - lookbackBars, index)
    .map(row => Math.log(row.y.close) - beta * Math.log(row.x.close));
  const center = mean(spreads);
  const scale = sampleStandardDeviation(spreads, center);
  if (!(scale > 0)) return null;
  const spread = Math.log(series[index].y.close) - beta * Math.log(series[index].x.close);
  return { beta, center, scale, spread, zscore: (spread - center) / scale };
}

function capacityAt(signalBoundary, bars, lookbackBars, symbol) {
  const indexByTime = new Map(bars.map((row, index) => [row.openTime, index]));
  const endIndex = indexByTime.get(signalBoundary - FIVE_MINUTES);
  if (endIndex == null || endIndex - lookbackBars + 1 < 0) {
    throw new Error(`${symbol}: capacity window unavailable at ${signalBoundary}`);
  }
  return Math.min(
    ...bars.slice(endIndex - lookbackBars + 1, endIndex + 1).map(row => row.quoteVolume)
  );
}

export function detectRelativeValueSignals({
  pairId,
  xSymbol,
  ySymbol,
  xFourHourBars,
  yFourHourBars,
  xFiveMinuteBars,
  yFiveMinuteBars,
  evaluationStart,
  evaluationEnd,
  lookbackBars = 540,
  minimumBeta = 0.25,
  maximumBeta = 2.5,
  entryAbsoluteZscore = 3,
  rearmAbsoluteZscore = 1,
  maximumHoldBars = 42,
  baseFillOffsetBars = 1,
  maximumFillDelayBars = 1,
  pairGrossWeight = 0.25,
  referenceAccountNotional = 10_000,
  capacityLookbackBars = 12,
  maximumParticipation = 0.02
}) {
  const yByTime = new Map(yFourHourBars.map(row => [row.openTime, row]));
  const series = xFourHourBars
    .filter(row => yByTime.has(row.openTime))
    .map(row => ({ openTime: row.openTime, closeTime: row.closeTime, x: row, y: yByTime.get(row.openTime) }));
  const xFiveByTime = new Map(xFiveMinuteBars.map(row => [row.openTime, row]));
  const yFiveByTime = new Map(yFiveMinuteBars.map(row => [row.openTime, row]));
  const signals = [];
  const skipped = {};
  let armed = true;
  let blockedUntilIndex = -1;

  for (let index = lookbackBars + 1; index < series.length; index++) {
    if (index <= blockedUntilIndex) continue;
    const state = rollingPairState(series, index, lookbackBars);
    if (!state || state.beta < minimumBeta || state.beta > maximumBeta) continue;
    if (!armed && Math.abs(state.zscore) <= rearmAbsoluteZscore) armed = true;
    const row = series[index];
    if (!armed
      || row.closeTime < evaluationStart
      || row.closeTime >= evaluationEnd
      || Math.abs(state.zscore) < entryAbsoluteZscore) {
      continue;
    }
    armed = false;
    const signalBoundary = row.openTime + FOUR_HOURS;
    const baseEntryTime = signalBoundary + baseFillOffsetBars * FIVE_MINUTES;
    const directionSign = Math.sign(state.zscore);
    const yWeight = -directionSign * pairGrossWeight / (1 + state.beta);
    const xWeight = directionSign * state.beta * pairGrossWeight / (1 + state.beta);
    const xCapacityQuoteVolume = capacityAt(
      signalBoundary, xFiveMinuteBars, capacityLookbackBars, xSymbol
    );
    const yCapacityQuoteVolume = capacityAt(
      signalBoundary, yFiveMinuteBars, capacityLookbackBars, ySymbol
    );
    const capacityFailure = referenceAccountNotional * Math.abs(xWeight)
      > maximumParticipation * xCapacityQuoteVolume
      || referenceAccountNotional * Math.abs(yWeight)
        > maximumParticipation * yCapacityQuoteVolume;
    if (capacityFailure) {
      skipped.reference_capacity = (skipped.reference_capacity ?? 0) + 1;
      continue;
    }

    let exitObservationIndex = index + maximumHoldBars;
    let baseExitTime = baseEntryTime + maximumHoldBars * FOUR_HOURS;
    let exitReason = 'maximum_hold';
    for (let cursor = index + 1; cursor <= index + maximumHoldBars && cursor < series.length; cursor++) {
      const spread = Math.log(series[cursor].y.close)
        - state.beta * Math.log(series[cursor].x.close);
      if (directionSign * (spread - state.center) <= 0) {
        exitObservationIndex = cursor;
        baseExitTime = series[cursor].openTime
          + FOUR_HOURS
          + baseFillOffsetBars * FIVE_MINUTES;
        exitReason = 'center_cross';
        break;
      }
    }
    const latestEntryTime = baseEntryTime + maximumFillDelayBars * FIVE_MINUTES;
    const latestExitTime = baseExitTime + maximumFillDelayBars * FIVE_MINUTES;
    if (latestExitTime > evaluationEnd
      || !xFiveByTime.has(latestEntryTime)
      || !yFiveByTime.has(latestEntryTime)
      || !xFiveByTime.has(latestExitTime)
      || !yFiveByTime.has(latestExitTime)) {
      skipped.insufficient_execution_path = (skipped.insufficient_execution_path ?? 0) + 1;
      continue;
    }
    signals.push({
      eventId: `${pairId}:${new Date(row.closeTime).toISOString()}`,
      pairId,
      xSymbol,
      ySymbol,
      signalTime: row.closeTime,
      decisionTime: row.closeTime,
      baseEntryTime,
      baseExitTime,
      exitReason,
      entrySpread: state.spread,
      frozenCenter: state.center,
      frozenScale: state.scale,
      beta: state.beta,
      entryZscore: state.zscore,
      direction: directionSign > 0 ? 'Y_RICH' : 'Y_CHEAP',
      xCapacityQuoteVolume,
      yCapacityQuoteVolume,
      legs: [
        { symbol: xSymbol, role: 'X_HEDGE', weight: xWeight },
        { symbol: ySymbol, role: 'Y_RESIDUAL', weight: yWeight }
      ]
    });
    blockedUntilIndex = exitObservationIndex;
  }
  return { signals, skipped };
}

function executeLeg({ leg, entryTime, exitTime, data, feePerFill, slippagePerFill }) {
  const side = Math.sign(leg.weight);
  const entry = data.contractByTime.get(entryTime);
  const exit = data.contractByTime.get(exitTime);
  if (!entry || !exit) throw new Error(`${leg.symbol}: missing execution bar`);
  const quantity = Math.abs(leg.weight) / entry.open;
  const entryFill = entry.open * (1 + side * slippagePerFill);
  const exitFill = exit.open * (1 - side * slippagePerFill);
  const grossPriceReturn = side * quantity * (exit.open - entry.open);
  const priceReturnAfterSlippage = side * quantity * (exitFill - entryFill);
  const fees = feePerFill * quantity * (entryFill + exitFill);
  let fundingReturn = 0;
  let fundingEvents = 0;
  for (const funding of data.funding) {
    if (funding.eventTime < entryTime) continue;
    if (funding.eventTime >= exitTime) break;
    const mark = data.markByTime.get(funding.eventTime);
    if (!mark) throw new Error(`${leg.symbol}: missing funding mark ${funding.eventTime}`);
    fundingReturn += -side * quantity * mark.open * funding.fundingRate;
    fundingEvents++;
  }
  return {
    ...leg,
    side,
    quantity,
    entryPrice: entry.open,
    exitPrice: exit.open,
    entryFill,
    exitFill,
    grossPriceReturn,
    priceReturnAfterSlippage,
    fees,
    fundingEvents,
    fundingReturn,
    netReturn: priceReturnAfterSlippage - fees + fundingReturn
  };
}

export function executeRelativeValueSignal(signal, dataBySymbol, scenario) {
  const entryTime = signal.baseEntryTime + scenario.fillDelayBars * FIVE_MINUTES;
  const exitTime = signal.baseExitTime + scenario.fillDelayBars * FIVE_MINUTES;
  const legs = signal.legs.map(leg => executeLeg({
    leg,
    entryTime,
    exitTime,
    data: dataBySymbol[leg.symbol],
    feePerFill: scenario.feePerFill,
    slippagePerFill: scenario.slippagePerFill
  }));
  return {
    eventId: signal.eventId,
    scenario: scenario.name,
    pairId: signal.pairId,
    signalTime: signal.signalTime,
    decisionTime: signal.decisionTime,
    entryTime,
    exitTime,
    exitReason: signal.exitReason,
    beta: signal.beta,
    entryZscore: signal.entryZscore,
    direction: signal.direction,
    legs,
    grossPriceReturn: sum(legs.map(row => row.grossPriceReturn)),
    priceReturnAfterSlippage: sum(legs.map(row => row.priceReturnAfterSlippage)),
    fees: sum(legs.map(row => row.fees)),
    fundingReturn: sum(legs.map(row => row.fundingReturn)),
    netReturn: sum(legs.map(row => row.netReturn))
  };
}

export function summarizeRelativeValueTrades(trades, pairIds) {
  const ordered = trades.slice().sort((left, right) =>
    left.exitTime - right.exitTime || left.eventId.localeCompare(right.eventId));
  const returns = ordered.map(row => row.netReturn);
  const wins = returns.filter(value => value > 0);
  const losses = returns.filter(value => value < 0);
  let cumulative = 0;
  let peak = 0;
  let maxDrawdownReturnUnits = 0;
  for (const value of returns) {
    cumulative += value;
    peak = Math.max(peak, cumulative);
    maxDrawdownReturnUnits = Math.min(maxDrawdownReturnUnits, cumulative - peak);
  }
  const byPair = Object.fromEntries(pairIds.map(pair => [pair, 0]));
  for (const trade of ordered) byPair[trade.pairId] += trade.netReturn;
  const byDirection = groupNet(ordered, row => row.direction);
  const byHalfYear = groupNet(ordered, row => {
    const date = new Date(row.entryTime);
    return `${date.getUTCFullYear()}-H${date.getUTCMonth() < 6 ? 1 : 2}`;
  });
  const byMonth = groupNet(ordered, row => new Date(row.entryTime).toISOString().slice(0, 7));
  const byEntryDay = groupNet(ordered, row => new Date(row.entryTime).toISOString().slice(0, 10));
  const positiveMonths = Object.values(byMonth).filter(value => value > 0);
  const positivePairs = Object.values(byPair).filter(value => value > 0);
  const eventDayReturns = Object.values(byEntryDay);
  return {
    pairTrades: ordered.length,
    entryDayClusters: eventDayReturns.length,
    wins: wins.length,
    winRate: ordered.length ? wins.length / ordered.length : 0,
    grossPriceReturnUnits: sum(ordered.map(row => row.grossPriceReturn)),
    netReturnUnits: sum(returns),
    profitFactor: losses.length ? sum(wins) / Math.abs(sum(losses)) : null,
    profitWithoutBest5Trades: sum(returns.slice().sort((a, b) => b - a).slice(5)),
    profitWithoutBest5EntryDays:
      sum(eventDayReturns.slice().sort((a, b) => b - a).slice(5)),
    maxDrawdownReturnUnits,
    totalFees: sum(ordered.map(row => row.fees)),
    totalFunding: sum(ordered.map(row => row.fundingReturn)),
    profitablePairs: positivePairs.length,
    profitableHalfYears: Object.values(byHalfYear).filter(value => value > 0).length,
    maxPositiveMonthContributionShare: positiveMonths.length
      ? Math.max(...positiveMonths) / sum(positiveMonths)
      : 1,
    maxPositivePairContributionShare: positivePairs.length
      ? Math.max(...positivePairs) / sum(positivePairs)
      : 1,
    medianAbsoluteEntryZscore: ordered.length
      ? ordered.map(row => Math.abs(row.entryZscore)).sort((a, b) => a - b)[Math.floor(ordered.length / 2)]
      : null,
    byPair,
    byDirection,
    byHalfYear,
    byMonth,
    byEntryDay
  };
}

export function developmentScreen(stress, extreme, delay5m, thresholds) {
  const checks = {
    minimumTrades: stress.pairTrades >= thresholds.minimumTrades,
    stressProfitFactor: stress.profitFactor != null
      && stress.profitFactor >= thresholds.minimumStressProfitFactor,
    positiveNet: stress.netReturnUnits > 0,
    withoutBest5Trades: stress.profitWithoutBest5Trades > 0,
    withoutBest5EntryDays: stress.profitWithoutBest5EntryDays > 0,
    maxDrawdown: stress.maxDrawdownReturnUnits >= thresholds.maximumDrawdown,
    pairBreadth: stress.profitablePairs >= thresholds.minimumProfitablePairs,
    bothDirections: (stress.byDirection.Y_RICH ?? 0) > 0
      && (stress.byDirection.Y_CHEAP ?? 0) > 0,
    halfYearBreadth: stress.profitableHalfYears >= thresholds.minimumProfitableHalfYears,
    monthConcentration:
      stress.maxPositiveMonthContributionShare <= thresholds.maximumMonthContributionShare,
    pairConcentration:
      stress.maxPositivePairContributionShare <= thresholds.maximumPairContributionShare,
    extremePositive: extreme.netReturnUnits > 0,
    delay5mPositive: delay5m.netReturnUnits > 0,
    delay5mProfitFactor: delay5m.profitFactor != null
      && delay5m.profitFactor >= thresholds.minimumDelayProfitFactor
  };
  return {
    pass: Object.values(checks).every(Boolean),
    checks,
    failures: Object.entries(checks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name)
  };
}
