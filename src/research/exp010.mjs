import { FIVE_MINUTES } from './archive.mjs';

const DAY = 24 * 60 * 60 * 1000;

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

export function buildRebalanceEvents({
  btcBars,
  anchorTime,
  evaluationStart,
  evaluationEnd,
  rebalanceDays = 14,
  baseEntryOffsetBars = 2,
  holdBars = 4032,
  maximumEntryDelayBars = 1
}) {
  const indexByTime = new Map(btcBars.map((row, index) => [row.openTime, index]));
  const events = [];
  const step = rebalanceDays * DAY;
  for (let eventTime = anchorTime; eventTime < evaluationEnd; eventTime += step) {
    if (eventTime < evaluationStart) continue;
    const eventIndex = indexByTime.get(eventTime);
    if (eventIndex == null || eventIndex - holdBars - 1 < 0) continue;
    const baseEntryTime = eventTime + baseEntryOffsetBars * FIVE_MINUTES;
    const latestExitTime = baseEntryTime
      + (maximumEntryDelayBars + holdBars) * FIVE_MINUTES;
    if (latestExitTime > evaluationEnd || !indexByTime.has(latestExitTime)) continue;
    const priorClose = btcBars[eventIndex - 1].close;
    const priorStartClose = btcBars[eventIndex - holdBars - 1].close;
    const priorBtcReturn = Math.log(priorClose / priorStartClose);
    events.push({
      eventId: new Date(eventTime).toISOString(),
      eventTime,
      decisionTime: eventTime + FIVE_MINUTES - 1,
      baseEntryTime,
      priorBtcReturn,
      btcTrendRegime: priorBtcReturn >= 0 ? 'UP' : 'DOWN'
    });
  }
  return events;
}

export function computeCarryFeatures({
  symbol,
  bars,
  btcBars,
  fundingRows,
  events,
  fundingLookbackDays = 14,
  minimumFundingEvents = 42,
  betaLookbackBars = 8640,
  capacityLookbackBars = 12
}) {
  const indexByTime = new Map(bars.map((row, index) => [row.openTime, index]));
  const btcIndexByTime = new Map(btcBars.map((row, index) => [row.openTime, index]));
  const fundingLookback = fundingLookbackDays * DAY;
  const features = [];
  for (const event of events) {
    const index = indexByTime.get(event.eventTime);
    const btcIndex = btcIndexByTime.get(event.eventTime);
    if (index == null || btcIndex == null) {
      throw new Error(`${symbol}: event time is unavailable for ${event.eventId}`);
    }
    if (index - betaLookbackBars < 1 || index < capacityLookbackBars) continue;
    const funding = fundingRows.filter(row =>
      row.eventTime > event.eventTime - fundingLookback
      && row.eventTime <= event.eventTime);
    if (funding.length < minimumFundingEvents) continue;

    let count = 0;
    let sumX = 0;
    let sumY = 0;
    let sumXX = 0;
    let sumXY = 0;
    let liquidityQuoteVolume = 0;
    const pairs = [];
    for (let cursor = index - betaLookbackBars; cursor < index; cursor++) {
      const btcCursor = btcIndex - (index - cursor);
      if (bars[cursor].openTime !== btcBars[btcCursor].openTime) {
        throw new Error(`${symbol}: beta window is not synchronized`);
      }
      const x = Math.log(btcBars[btcCursor].close / btcBars[btcCursor - 1].close);
      const y = Math.log(bars[cursor].close / bars[cursor - 1].close);
      pairs.push([x, y]);
      count++;
      sumX += x;
      sumY += y;
      sumXX += x * x;
      sumXY += x * y;
      liquidityQuoteVolume += bars[cursor].quoteVolume;
    }
    const denominator = sumXX - sumX * sumX / count;
    if (!(denominator > 0)) continue;
    const beta = symbol === 'BTCUSDT'
      ? 1
      : (sumXY - sumX * sumY / count) / denominator;
    const alpha = symbol === 'BTCUSDT' ? 0 : sumY / count - beta * sumX / count;
    const residuals = pairs.map(([x, y]) => y - alpha - beta * x);
    const residualVolatility = symbol === 'BTCUSDT'
      ? sampleStandardDeviation(pairs.map(([x]) => x))
      : sampleStandardDeviation(residuals, 0);
    if (!(residualVolatility > 0)) continue;
    features.push({
      eventId: event.eventId,
      symbol,
      beta,
      residualVolatility,
      fundingScore: sum(funding.map(row => row.fundingRate)),
      fundingEvents: funding.length,
      liquidityQuoteVolume,
      capacityQuoteVolume: Math.min(
        ...bars.slice(index - capacityLookbackBars, index).map(row => row.quoteVolume)
      )
    });
  }
  return features;
}

function inverseVolatilityWeights(rows, totalWeight, role) {
  const inverse = rows.map(row => 1 / row.residualVolatility);
  const denominator = sum(inverse);
  return rows.map((row, index) => ({
    ...row,
    role,
    weight: totalWeight * inverse[index] / denominator
  }));
}

export function buildCarryPortfolio({
  event,
  candidates,
  benchmarkFeature,
  benchmark = 'BTCUSDT',
  eligibleSymbols = 12,
  minimumValidSymbols = 12,
  longCount = 3,
  shortCount = 3,
  minimumProjectedFundingReturn = 0.0024,
  referenceGrossNotional = 10_000,
  maximumParticipation = 0.02,
  maximumBetaExposure = 1e-10,
  holdBars = 4032
}) {
  if (!benchmarkFeature || candidates.length < minimumValidSymbols) {
    return { status: 'skipped', eventId: event.eventId, reason: 'insufficient_valid_symbols' };
  }
  const liquid = candidates.slice()
    .sort((left, right) =>
      right.liquidityQuoteVolume - left.liquidityQuoteVolume
      || left.symbol.localeCompare(right.symbol))
    .slice(0, eligibleSymbols);
  if (liquid.length < minimumValidSymbols) {
    return { status: 'skipped', eventId: event.eventId, reason: 'insufficient_liquid_symbols' };
  }
  const ranked = liquid.slice().sort((left, right) =>
    left.fundingScore - right.fundingScore || left.symbol.localeCompare(right.symbol));
  const longRows = ranked.slice(0, longCount);
  const shortRows = ranked.slice(-shortCount);
  const altRows = [
    ...inverseVolatilityWeights(longRows, 0.5, 'LONG_LOW'),
    ...inverseVolatilityWeights(shortRows, -0.5, 'SHORT_HIGH')
  ];
  const altBetaExposure = sum(altRows.map(row => row.weight * row.beta));
  const rawRows = [
    ...altRows,
    {
      ...benchmarkFeature,
      symbol: benchmark,
      role: 'BTC_HEDGE',
      weight: -altBetaExposure,
      beta: 1
    }
  ].filter(row => Math.abs(row.weight) > 1e-15);
  const gross = sum(rawRows.map(row => Math.abs(row.weight)));
  const legs = rawRows.map(row => ({ ...row, weight: row.weight / gross }));
  const betaExposure = sum(legs.map(row => row.weight * row.beta));
  if (Math.abs(betaExposure) > maximumBetaExposure) {
    throw new Error(`${event.eventId}: beta hedge tolerance exceeded`);
  }
  const projectedFundingReturn = sum(legs.map(row => -row.weight * row.fundingScore));
  if (projectedFundingReturn < minimumProjectedFundingReturn) {
    return { status: 'skipped', eventId: event.eventId, reason: 'insufficient_projected_carry' };
  }
  const capacityFailure = legs.some(row =>
    referenceGrossNotional * Math.abs(row.weight)
      > maximumParticipation * row.capacityQuoteVolume);
  if (capacityFailure) {
    return { status: 'skipped', eventId: event.eventId, reason: 'reference_capacity' };
  }
  return {
    status: 'trade',
    eventId: event.eventId,
    eventTime: event.eventTime,
    decisionTime: event.decisionTime,
    baseEntryTime: event.baseEntryTime,
    priorBtcReturn: event.priorBtcReturn,
    btcTrendRegime: event.btcTrendRegime,
    projectedFundingReturn,
    longMeanFundingScore: mean(longRows.map(row => row.fundingScore)),
    shortMeanFundingScore: mean(shortRows.map(row => row.fundingScore)),
    betaExposure,
    holdBars,
    legs
  };
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
  const slippageCost = grossPriceReturn - priceReturnAfterSlippage;
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
    symbol: leg.symbol,
    role: leg.role,
    side,
    weight: leg.weight,
    beta: leg.beta,
    fundingScore: leg.fundingScore,
    fundingEventsInScore: leg.fundingEvents,
    entryPrice: entry.open,
    exitPrice: exit.open,
    entryFill,
    exitFill,
    grossPriceReturn,
    priceReturnAfterSlippage,
    slippageCost,
    fees,
    fundingEventsDuringHold: fundingEvents,
    fundingReturn,
    netReturn: priceReturnAfterSlippage - fees + fundingReturn
  };
}

export function executeCarryPortfolio(portfolio, dataBySymbol, scenario) {
  const entryTime = portfolio.baseEntryTime + scenario.entryDelayBars * FIVE_MINUTES;
  const exitTime = entryTime + portfolio.holdBars * FIVE_MINUTES;
  const legs = portfolio.legs.map(leg => executeLeg({
    leg,
    entryTime,
    exitTime,
    data: dataBySymbol[leg.symbol],
    feePerFill: scenario.feePerFill,
    slippagePerFill: scenario.slippagePerFill
  }));
  return {
    eventId: portfolio.eventId,
    scenario: scenario.name,
    eventTime: portfolio.eventTime,
    decisionTime: portfolio.decisionTime,
    entryTime,
    exitTime,
    priorBtcReturn: portfolio.priorBtcReturn,
    btcTrendRegime: portfolio.btcTrendRegime,
    projectedFundingReturn: portfolio.projectedFundingReturn,
    longMeanFundingScore: portfolio.longMeanFundingScore,
    shortMeanFundingScore: portfolio.shortMeanFundingScore,
    betaExposure: portfolio.betaExposure,
    legs,
    grossPriceReturn: sum(legs.map(leg => leg.grossPriceReturn)),
    priceReturnAfterSlippage: sum(legs.map(leg => leg.priceReturnAfterSlippage)),
    slippageCost: sum(legs.map(leg => leg.slippageCost)),
    fees: sum(legs.map(leg => leg.fees)),
    fundingReturn: sum(legs.map(leg => leg.fundingReturn)),
    netReturn: sum(legs.map(leg => leg.netReturn))
  };
}

export function summarizeCarryPortfolios(portfolios, altSymbols) {
  const ordered = portfolios.slice().sort((left, right) =>
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
  const altPnl = Object.fromEntries(altSymbols.map(symbol => [symbol, 0]));
  let longSleeveNet = 0;
  let shortSleeveNet = 0;
  let hedgeNet = 0;
  for (const portfolio of ordered) {
    for (const leg of portfolio.legs) {
      if (leg.role === 'BTC_HEDGE') hedgeNet += leg.netReturn;
      else {
        altPnl[leg.symbol] += leg.netReturn;
        if (leg.role === 'LONG_LOW') longSleeveNet += leg.netReturn;
        else shortSleeveNet += leg.netReturn;
      }
    }
  }
  const byBtcTrendRegime = groupNet(ordered, row => row.btcTrendRegime);
  const byHalfYear = groupNet(ordered, row => {
    const date = new Date(row.entryTime);
    return `${date.getUTCFullYear()}-H${date.getUTCMonth() < 6 ? 1 : 2}`;
  });
  const byMonth = groupNet(ordered, row => new Date(row.entryTime).toISOString().slice(0, 7));
  const positiveMonths = Object.values(byMonth).filter(value => value > 0);
  const totalPositiveMonths = sum(positiveMonths);
  const totalFunding = sum(ordered.map(row => row.fundingReturn));
  const totalFees = sum(ordered.map(row => row.fees));
  const totalSlippageCost = sum(ordered.map(row => row.slippageCost));
  return {
    eventPortfolios: ordered.length,
    wins: wins.length,
    winRate: ordered.length ? wins.length / ordered.length : 0,
    projectedFundingReturnUnits: sum(ordered.map(row => row.projectedFundingReturn)),
    grossPriceReturnUnits: sum(ordered.map(row => row.grossPriceReturn)),
    priceReturnAfterSlippageUnits: sum(ordered.map(row => row.priceReturnAfterSlippage)),
    netReturnUnits: sum(returns),
    profitFactor: losses.length ? sum(wins) / Math.abs(sum(losses)) : null,
    profitWithoutBest5Events: sum(returns.slice().sort((a, b) => b - a).slice(5)),
    maxDrawdownReturnUnits,
    totalFees,
    totalSlippageCost,
    totalFunding,
    fundingAfterExecutionCosts: totalFunding - totalFees - totalSlippageCost,
    longSleeveNet,
    shortSleeveNet,
    hedgeNet,
    profitableAltSymbols: Object.values(altPnl).filter(value => value > 0).length,
    profitableHalfYears: Object.values(byHalfYear).filter(value => value > 0).length,
    maxPositiveMonthContributionShare: totalPositiveMonths
      ? Math.max(...positiveMonths) / totalPositiveMonths
      : 1,
    maxAbsoluteBetaExposure: ordered.length
      ? Math.max(...ordered.map(row => Math.abs(row.betaExposure)))
      : 0,
    altPnl,
    byBtcTrendRegime,
    byHalfYear,
    byMonth
  };
}

export function developmentScreen(stress, extreme, delay5m, thresholds) {
  const checks = {
    minimumEvents: stress.eventPortfolios >= thresholds.minimumEvents,
    stressProfitFactor: stress.profitFactor != null
      && stress.profitFactor >= thresholds.minimumStressProfitFactor,
    positiveNet: stress.netReturnUnits > 0,
    withoutBest5Events: stress.profitWithoutBest5Events > 0,
    maxDrawdown: stress.maxDrawdownReturnUnits >= thresholds.maximumDrawdown,
    symbolBreadth: stress.profitableAltSymbols >= thresholds.minimumProfitableAltSymbols,
    bothAltSleeves: stress.longSleeveNet > 0 && stress.shortSleeveNet > 0,
    bothBtcTrendRegimes: (stress.byBtcTrendRegime.UP ?? 0) > 0
      && (stress.byBtcTrendRegime.DOWN ?? 0) > 0,
    actualFundingPositive: stress.totalFunding > 0,
    fundingAfterExecutionCosts: stress.fundingAfterExecutionCosts > 0,
    halfYearBreadth: stress.profitableHalfYears >= thresholds.minimumProfitableHalfYears,
    monthConcentration:
      stress.maxPositiveMonthContributionShare <= thresholds.maximumMonthContributionShare,
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
