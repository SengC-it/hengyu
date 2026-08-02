import { FIVE_MINUTES } from './archive.mjs';

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

export function detectBtcShocks(bars, options = {}) {
  const shockWindowBars = options.shockWindowBars ?? 3;
  const volatilityLookbackBars = options.volatilityLookbackBars ?? 8640;
  const minimumAbsoluteReturn = options.minimumAbsoluteReturn ?? 0.015;
  const minimumAbsoluteZscore = options.minimumAbsoluteZscore ?? 4;
  const cooldownBars = options.cooldownBars ?? 288;
  const holdBars = options.holdBars ?? 12;
  const maximumEntryDelayBars = options.maximumEntryDelayBars ?? 1;
  const capacityLookbackBars = options.capacityLookbackBars ?? 12;
  const evaluationStart = options.evaluationStart ?? -Infinity;
  const evaluationEnd = options.evaluationEnd ?? Infinity;
  const queue = [];
  let queueSum = 0;
  let queueSquares = 0;
  let nextEligibleIndex = 0;
  const events = [];

  for (let index = shockWindowBars - 1; index < bars.length; index++) {
    const startIndex = index - shockWindowBars + 1;
    const shockReturn = Math.log(bars[index].close / bars[startIndex].open);
    const average = queue.length ? queueSum / queue.length : null;
    const variance = queue.length > 1
      ? (queueSquares - queueSum * queueSum / queue.length) / (queue.length - 1)
      : null;
    const volatility = variance != null ? Math.sqrt(Math.max(0, variance)) : null;
    const zscore = volatility > 0 ? (shockReturn - average) / volatility : null;
    const reactionIndex = index + 1;
    const baseEntryIndex = index + 2;
    const latestExitIndex = baseEntryIndex + maximumEntryDelayBars + holdBars;
    const hasPath = latestExitIndex < bars.length;
    const inEvaluation = bars[index].closeTime >= evaluationStart
      && bars[index].closeTime < evaluationEnd;
    if (queue.length === volatilityLookbackBars
      && hasPath
      && inEvaluation
      && index >= nextEligibleIndex
      && Math.abs(shockReturn) >= minimumAbsoluteReturn
      && zscore != null
      && Math.abs(zscore) >= minimumAbsoluteZscore) {
      const capacityStart = reactionIndex - capacityLookbackBars + 1;
      if (capacityStart < 0) throw new Error('BTC capacity window is unavailable');
      events.push({
        eventId: new Date(bars[index].closeTime).toISOString(),
        shockStartIndex: startIndex,
        shockEndIndex: index,
        shockStartTime: bars[startIndex].openTime,
        shockEndTime: bars[index].closeTime,
        reactionIndex,
        reactionTime: bars[reactionIndex].openTime,
        decisionTime: bars[reactionIndex].closeTime,
        baseEntryIndex,
        baseEntryTime: bars[baseEntryIndex].openTime,
        shockReturn,
        shockVolatility: volatility,
        shockZscore: zscore,
        shockDirection: shockReturn > 0 ? 'UP' : 'DOWN',
        btcReactionReturn: Math.log(
          bars[reactionIndex].close / bars[reactionIndex].open
        ),
        btcCapacityQuoteVolume: Math.min(
          ...bars.slice(capacityStart, reactionIndex + 1).map(row => row.quoteVolume)
        )
      });
      nextEligibleIndex = index + cooldownBars;
    }
    queue.push(shockReturn);
    queueSum += shockReturn;
    queueSquares += shockReturn * shockReturn;
    if (queue.length > volatilityLookbackBars) {
      const removed = queue.shift();
      queueSum -= removed;
      queueSquares -= removed * removed;
    }
  }
  return events;
}

export function computeReactionFeatures({
  symbol,
  bars,
  btcBars,
  events,
  betaLookbackBars = 8640,
  capacityLookbackBars = 12
}) {
  const symbolIndexByTime = new Map(bars.map((row, index) => [row.openTime, index]));
  const btcIndexByTime = new Map(btcBars.map((row, index) => [row.openTime, index]));
  const features = [];
  for (const event of events) {
    const symbolStartIndex = symbolIndexByTime.get(event.shockStartTime);
    const symbolReactionIndex = symbolIndexByTime.get(event.reactionTime);
    const btcStartIndex = btcIndexByTime.get(event.shockStartTime);
    if (symbolStartIndex == null || symbolReactionIndex == null || btcStartIndex == null) {
      throw new Error(`${symbol}: event time is unavailable for ${event.eventId}`);
    }
    const firstReturnIndex = symbolStartIndex - betaLookbackBars;
    if (firstReturnIndex < 1 || symbolReactionIndex < capacityLookbackBars - 1) {
      continue;
    }
    let count = 0;
    let sumX = 0;
    let sumY = 0;
    let sumXX = 0;
    let sumXY = 0;
    const pairs = [];
    let liquidity = 0;
    for (let offset = -betaLookbackBars; offset < 0; offset++) {
      const symbolIndex = symbolStartIndex + offset;
      const btcIndex = btcStartIndex + offset;
      if (bars[symbolIndex].openTime !== btcBars[btcIndex].openTime) {
        throw new Error(`${symbol}: beta window is not synchronized`);
      }
      const x = Math.log(btcBars[btcIndex].close / btcBars[btcIndex - 1].close);
      const y = Math.log(bars[symbolIndex].close / bars[symbolIndex - 1].close);
      pairs.push([x, y]);
      count++;
      sumX += x;
      sumY += y;
      sumXX += x * x;
      sumXY += x * y;
      liquidity += bars[symbolIndex].quoteVolume;
    }
    const denominator = sumXX - sumX * sumX / count;
    if (!(denominator > 0)) continue;
    const beta = (sumXY - sumX * sumY / count) / denominator;
    const alpha = sumY / count - beta * sumX / count;
    const residuals = pairs.map(([x, y]) => y - alpha - beta * x);
    const residualVolatility = sampleStandardDeviation(residuals, 0);
    if (!(residualVolatility > 0)) continue;
    const reactionReturn = Math.log(
      bars[symbolReactionIndex].close / bars[symbolReactionIndex].open
    );
    const reactionResidual = reactionReturn
      - alpha
      - beta * event.btcReactionReturn;
    const capacityStart = symbolReactionIndex - capacityLookbackBars + 1;
    features.push({
      eventId: event.eventId,
      symbol,
      beta,
      alpha,
      residualVolatility,
      reactionReturn,
      reactionResidual,
      reactionScore: reactionResidual / residualVolatility,
      liquidityQuoteVolume: liquidity,
      capacityQuoteVolume: Math.min(
        ...bars.slice(capacityStart, symbolReactionIndex + 1).map(row => row.quoteVolume)
      )
    });
  }
  return features;
}

function normalizeInverseVolatility(rows, totalWeight) {
  const inverse = rows.map(row => 1 / row.residualVolatility);
  const denominator = sum(inverse);
  return rows.map((row, index) => ({
    ...row,
    weight: totalWeight * inverse[index] / denominator
  }));
}

export function buildReactionPortfolio({
  event,
  candidates,
  benchmark = 'BTCUSDT',
  eligibleSymbols = 12,
  minimumValidSymbols = 12,
  longCount = 3,
  shortCount = 3,
  maximumLongMeanScore = -0.75,
  minimumShortMeanScore = 0.75,
  minimumMeanScoreSpread = 2,
  referenceGrossNotional = 10_000,
  maximumParticipation = 0.02,
  maximumBetaExposure = 1e-10,
  holdBars = 12
}) {
  if (candidates.length < minimumValidSymbols) {
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
    left.reactionScore - right.reactionScore || left.symbol.localeCompare(right.symbol));
  const longRows = ranked.slice(0, longCount);
  const shortRows = ranked.slice(-shortCount);
  const longMeanScore = mean(longRows.map(row => row.reactionScore));
  const shortMeanScore = mean(shortRows.map(row => row.reactionScore));
  if (longMeanScore > maximumLongMeanScore
    || shortMeanScore < minimumShortMeanScore
    || shortMeanScore - longMeanScore < minimumMeanScoreSpread) {
    return { status: 'skipped', eventId: event.eventId, reason: 'insufficient_reaction_dispersion' };
  }
  const weightedLongs = normalizeInverseVolatility(longRows, 0.5);
  const weightedShorts = normalizeInverseVolatility(shortRows, -0.5);
  const altRows = [...weightedLongs, ...weightedShorts];
  const altBetaExposure = sum(altRows.map(row => row.weight * row.beta));
  const rawRows = [
    ...altRows,
    {
      symbol: benchmark,
      weight: -altBetaExposure,
      beta: 1,
      reactionScore: null,
      capacityQuoteVolume: event.btcCapacityQuoteVolume
    }
  ];
  const gross = sum(rawRows.map(row => Math.abs(row.weight)));
  const legs = rawRows.map(row => ({ ...row, weight: row.weight / gross }));
  const betaExposure = sum(legs.map(row => row.weight * row.beta));
  if (Math.abs(betaExposure) > maximumBetaExposure) {
    throw new Error(`${event.eventId}: beta hedge tolerance exceeded`);
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
    shockEndTime: event.shockEndTime,
    decisionTime: event.decisionTime,
    baseEntryTime: event.baseEntryTime,
    shockReturn: event.shockReturn,
    shockZscore: event.shockZscore,
    shockDirection: event.shockDirection,
    btcReactionReturn: event.btcReactionReturn,
    longMeanScore,
    shortMeanScore,
    meanScoreSpread: shortMeanScore - longMeanScore,
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
  const fees = feePerFill * quantity * (entryFill + exitFill);
  let fundingReturn = 0;
  for (const funding of data.funding) {
    if (funding.eventTime < entryTime) continue;
    if (funding.eventTime >= exitTime) break;
    const mark = data.markByTime.get(funding.eventTime);
    if (!mark) throw new Error(`${leg.symbol}: missing funding mark ${funding.eventTime}`);
    fundingReturn += -side * quantity * mark.open * funding.fundingRate;
  }
  return {
    symbol: leg.symbol,
    side,
    weight: leg.weight,
    beta: leg.beta,
    reactionScore: leg.reactionScore,
    entryPrice: entry.open,
    exitPrice: exit.open,
    entryFill,
    exitFill,
    grossPriceReturn,
    priceReturnAfterSlippage,
    fees,
    fundingReturn,
    netReturn: priceReturnAfterSlippage - fees + fundingReturn
  };
}

export function executeReactionPortfolio(portfolio, dataBySymbol, scenario) {
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
    shockEndTime: portfolio.shockEndTime,
    decisionTime: portfolio.decisionTime,
    entryTime,
    exitTime,
    shockReturn: portfolio.shockReturn,
    shockZscore: portfolio.shockZscore,
    shockDirection: portfolio.shockDirection,
    btcReactionReturn: portfolio.btcReactionReturn,
    longMeanScore: portfolio.longMeanScore,
    shortMeanScore: portfolio.shortMeanScore,
    meanScoreSpread: portfolio.meanScoreSpread,
    betaExposure: portfolio.betaExposure,
    legs,
    grossPriceReturn: sum(legs.map(leg => leg.grossPriceReturn)),
    fees: sum(legs.map(leg => leg.fees)),
    fundingReturn: sum(legs.map(leg => leg.fundingReturn)),
    netReturn: sum(legs.map(leg => leg.netReturn))
  };
}

export function summarizeReactionPortfolios(portfolios, altSymbols) {
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
      if (leg.symbol === 'BTCUSDT') hedgeNet += leg.netReturn;
      else {
        altPnl[leg.symbol] += leg.netReturn;
        if (leg.side > 0) longSleeveNet += leg.netReturn;
        else shortSleeveNet += leg.netReturn;
      }
    }
  }
  const byShockDirection = groupNet(ordered, row => row.shockDirection);
  const byHalfYear = groupNet(ordered, row => {
    const date = new Date(row.entryTime);
    return `${date.getUTCFullYear()}-H${date.getUTCMonth() < 6 ? 1 : 2}`;
  });
  const byMonth = groupNet(ordered, row => new Date(row.entryTime).toISOString().slice(0, 7));
  const positiveMonths = Object.values(byMonth).filter(value => value > 0);
  const totalPositiveMonths = sum(positiveMonths);
  return {
    eventPortfolios: ordered.length,
    wins: wins.length,
    winRate: ordered.length ? wins.length / ordered.length : 0,
    grossPriceReturnUnits: sum(ordered.map(row => row.grossPriceReturn)),
    netReturnUnits: sum(returns),
    profitFactor: losses.length ? sum(wins) / Math.abs(sum(losses)) : null,
    profitWithoutBest5Events: sum(returns.slice().sort((a, b) => b - a).slice(5)),
    maxDrawdownReturnUnits,
    totalFees: sum(ordered.map(row => row.fees)),
    totalFunding: sum(ordered.map(row => row.fundingReturn)),
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
    byShockDirection,
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
    bothShockDirections: (stress.byShockDirection.UP ?? 0) > 0
      && (stress.byShockDirection.DOWN ?? 0) > 0,
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
