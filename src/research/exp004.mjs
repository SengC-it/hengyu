import { FIVE_MINUTES } from './archive.mjs';

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleDeviation(values, average) {
  if (values.length < 2) return null;
  return Math.sqrt(Math.max(
    0,
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1)
  ));
}

export function detectMarketShocks(bars, options) {
  const returns = [];
  const events = [];
  let nextEligibleTime = -Infinity;
  for (let index = options.shockWindowBars - 1; index < bars.length; index++) {
    const windowStart = index - options.shockWindowBars + 1;
    const shockReturn = Math.log(bars[index].close / bars[windowStart].open);
    const history = returns.slice(-options.volatilityLookbackBars);
    const average = history.length === options.volatilityLookbackBars ? mean(history) : null;
    const deviation = average == null ? null : sampleDeviation(history, average);
    const zscore = deviation > 0 ? (shockReturn - average) / deviation : null;
    const eventTime = bars[index].closeTime + 1;
    if (eventTime >= options.evaluationStart
      && eventTime < options.evaluationEnd
      && eventTime >= nextEligibleTime
      && Number.isFinite(zscore)
      && shockReturn <= options.maximumReturn
      && zscore <= options.maximumZscore) {
      events.push({
        eventTime,
        shockStartTime: bars[windowStart].openTime,
        shockReturn,
        shockMean: average,
        shockDeviation: deviation,
        shockZscore: zscore
      });
      nextEligibleTime = eventTime + options.cooldownBars * FIVE_MINUTES;
    }
    returns.push(shockReturn);
  }
  return events;
}

export function parseMetricsTime(value) {
  const timestamp = Date.parse(`${value.replace(' ', 'T')}Z`);
  if (!Number.isFinite(timestamp)) throw new Error(`invalid metrics time: ${value}`);
  return timestamp;
}

export function parseMetricsArchiveLines(lines, symbol, options = {}) {
  const maximumLag = options.maximumPublicationLagMs ?? 0;
  const allowNormalizedCollisions = options.allowNormalizedCollisions ?? false;
  const rows = [];
  const seen = new Set();
  for (const [index, line] of lines.entries()) {
    const value = line.split(',');
    if (value.length < 8) throw new Error(`${symbol}/metrics row ${index + 1}: too few fields`);
    const row = {
      symbol: value[1],
      createTime: parseMetricsTime(value[0]),
      openInterest: Number(value[2]),
      openInterestValue: Number(value[3]),
      takerLongShortRatio: Number(value[7])
    };
    if (row.symbol !== symbol) throw new Error(`${symbol}/metrics row ${index + 1}: symbol mismatch`);
    if (![row.openInterest, row.openInterestValue, row.takerLongShortRatio].every(Number.isFinite)
      || row.openInterest < 0
      || row.openInterestValue < 0
      || row.takerLongShortRatio < 0) {
      throw new Error(`${symbol}/metrics row ${index + 1}: invalid value`);
    }
    const publicationLag = row.createTime % FIVE_MINUTES;
    if (publicationLag > maximumLag) {
      throw new Error(`${symbol}/metrics row ${index + 1}: unaligned timestamp`);
    }
    row.publicationLagMs = publicationLag;
    row.createTime -= publicationLag;
    if (seen.has(row.createTime) && !allowNormalizedCollisions) {
      throw new Error(`${symbol}/metrics: duplicate timestamp`);
    }
    seen.add(row.createTime);
    rows.push(row);
  }
  return rows;
}

export function collapseMetricsCollisions(rows) {
  const byTime = new Map();
  for (const row of rows) {
    const existing = byTime.get(row.createTime);
    if (existing) {
      byTime.set(row.createTime, {
        symbol: row.symbol,
        createTime: row.createTime,
        ambiguous: true,
        collisionCount: (existing.collisionCount ?? 1) + 1
      });
    } else {
      byTime.set(row.createTime, row);
    }
  }
  return [...byTime.values()].sort((a, b) => a.createTime - b.createTime);
}

function rollingBeta(symbolBars, btcBars, endExclusive, lookback) {
  const start = endExclusive - lookback;
  if (start < 1) return null;
  const symbolReturns = [];
  const btcReturns = [];
  for (let index = start; index < endExclusive; index++) {
    symbolReturns.push(Math.log(symbolBars[index].close / symbolBars[index - 1].close));
    btcReturns.push(Math.log(btcBars[index].close / btcBars[index - 1].close));
  }
  const xMean = mean(btcReturns);
  const yMean = mean(symbolReturns);
  let covariance = 0;
  let variance = 0;
  for (let index = 0; index < btcReturns.length; index++) {
    covariance += (btcReturns[index] - xMean) * (symbolReturns[index] - yMean);
    variance += (btcReturns[index] - xMean) ** 2;
  }
  return variance > 0 ? covariance / variance : null;
}

function percentileRanks(items, field) {
  const sorted = items.slice().sort((a, b) =>
    a[field] - b[field] || a.symbol.localeCompare(b.symbol));
  const denominator = Math.max(1, sorted.length - 1);
  const ranks = new Map();
  for (let index = 0; index < sorted.length; index++) {
    ranks.set(sorted[index].symbol, index / denominator);
  }
  return ranks;
}

export function buildEventPortfolio({
  event,
  barsBySymbol,
  metricsBySymbol,
  benchmark,
  eligibleSymbols,
  betaLookbackBars,
  liquidityLookbackBars,
  shockWindowBars,
  longCount,
  shortCount,
  minimumValidSymbols
}) {
  const btcBars = barsBySymbol[benchmark];
  const btcIndex = btcBars.findIndex(row => row.openTime === event.eventTime);
  if (btcIndex < shockWindowBars) throw new Error(`missing BTC event boundary ${event.eventTime}`);
  const shockStart = btcIndex - shockWindowBars;
  const candidates = [];
  for (const symbol of eligibleSymbols) {
    const bars = barsBySymbol[symbol];
    const eventIndex = bars.findIndex(row => row.openTime === event.eventTime);
    if (eventIndex !== btcIndex) throw new Error(`${symbol}: event price alignment mismatch`);
    const beta = rollingBeta(bars, btcBars, shockStart, betaLookbackBars);
    if (!Number.isFinite(beta)) continue;
    const liquidityStart = shockStart - liquidityLookbackBars;
    if (liquidityStart < 0) continue;
    let liquidity = 0;
    for (let index = liquidityStart; index < shockStart; index++) {
      liquidity += bars[index].quoteVolume;
    }
    const symbolShock = Math.log(bars[eventIndex - 1].close / bars[shockStart].open);
    const residual = symbolShock - beta * event.shockReturn;
    const metrics = metricsBySymbol[symbol];
    const before = metrics.get(event.eventTime - shockWindowBars * FIVE_MINUTES);
    const after = metrics.get(event.eventTime);
    if (!before || !after) throw new Error(`${symbol}: missing event OI at ${event.eventTime}`);
    if (!(before.openInterest > 0) || !(after.openInterest > 0)) {
      throw new Error(`${symbol}: non-positive required event OI at ${event.eventTime}`);
    }
    const oiChange = Math.log(after.openInterest / before.openInterest);
    candidates.push({ symbol, beta, liquidity, symbolShock, residual, oiChange });
  }
  if (candidates.length < minimumValidSymbols) {
    throw new Error(`only ${candidates.length} valid symbols at ${event.eventTime}`);
  }
  return buildPortfolioFromCandidates({
    event,
    candidates,
    benchmark,
    minimumValidSymbols,
    longCount,
    shortCount
  });
}

export function buildPortfolioFromCandidates({
  event,
  candidates,
  benchmark,
  minimumValidSymbols,
  longCount,
  shortCount
}) {
  if (candidates.length < minimumValidSymbols) {
    throw new Error(`only ${candidates.length} valid symbols at ${event.eventTime}`);
  }
  const liquid = candidates.sort((a, b) =>
    b.liquidity - a.liquidity || a.symbol.localeCompare(b.symbol)).slice(0, minimumValidSymbols);
  const residualRanks = percentileRanks(liquid, 'residual');
  const deleveraging = liquid.map(item => ({ ...item, negativeOiChange: -item.oiChange }));
  const oiRanks = percentileRanks(deleveraging, 'negativeOiChange');
  const scored = liquid.map(item => ({
    ...item,
    score: residualRanks.get(item.symbol) + oiRanks.get(item.symbol)
  })).sort((a, b) => a.score - b.score || a.symbol.localeCompare(b.symbol));
  const shorts = scored.slice(0, shortCount);
  const longs = scored.slice(-longCount);
  const altWeights = [
    ...longs.map(item => ({ ...item, sleeve: 'long', weight: 0.5 / longCount })),
    ...shorts.map(item => ({ ...item, sleeve: 'short', weight: -0.5 / shortCount }))
  ];
  const betaExposure = altWeights.reduce((sum, item) => sum + item.weight * item.beta, 0);
  const rawWeights = [
    ...altWeights,
    { symbol: benchmark, sleeve: 'hedge', weight: -betaExposure, beta: 1 }
  ];
  const gross = rawWeights.reduce((sum, item) => sum + Math.abs(item.weight), 0);
  const legs = rawWeights
    .filter(item => Math.abs(item.weight) > 1e-12)
    .map(item => ({ ...item, weight: item.weight / gross }));
  return {
    ...event,
    candidates: candidates.length,
    liquidSymbols: liquid.map(item => item.symbol),
    longs: longs.map(item => item.symbol),
    shorts: shorts.map(item => item.symbol),
    exAnteBeta: legs.reduce((sum, item) => sum + item.weight * item.beta, 0),
    legs
  };
}

export function computeSymbolEventFeatures({
  symbol,
  symbolBars,
  btcBars,
  metrics,
  events,
  betaLookbackBars,
  liquidityLookbackBars,
  shockWindowBars,
  invalidOiPolicy = 'fail'
}) {
  const indexByTime = new Map(symbolBars.map((row, index) => [row.openTime, index]));
  const btcIndexByTime = new Map(btcBars.map((row, index) => [row.openTime, index]));
  const output = [];
  for (const event of events) {
    const eventIndex = indexByTime.get(event.eventTime);
    const btcIndex = btcIndexByTime.get(event.eventTime);
    if (eventIndex == null || btcIndex == null || eventIndex !== btcIndex) {
      throw new Error(`${symbol}: event price alignment mismatch`);
    }
    const shockStart = eventIndex - shockWindowBars;
    const beta = rollingBeta(symbolBars, btcBars, shockStart, betaLookbackBars);
    const liquidityStart = shockStart - liquidityLookbackBars;
    if (!Number.isFinite(beta) || liquidityStart < 0) continue;
    let liquidity = 0;
    for (let index = liquidityStart; index < shockStart; index++) {
      liquidity += symbolBars[index].quoteVolume;
    }
    const symbolShock = Math.log(symbolBars[eventIndex - 1].close / symbolBars[shockStart].open);
    const before = metrics.get(event.eventTime - shockWindowBars * FIVE_MINUTES);
    const after = metrics.get(event.eventTime);
    if (!before || !after || before.ambiguous || after.ambiguous
      || !(before.openInterest > 0) || !(after.openInterest > 0)) {
      if (invalidOiPolicy === 'exclude_symbol_for_event') continue;
      throw new Error(`${symbol}: invalid required event OI at ${event.eventTime}`);
    }
    const oiChange = Math.log(after.openInterest / before.openInterest);
    output.push({
      eventTime: event.eventTime,
      symbol,
      beta,
      liquidity,
      symbolShock,
      residual: symbolShock - beta * event.shockReturn,
      oiChange
    });
  }
  return output;
}

function fundingPnl(leg, entryTime, exitTime, fundingRows, markByTime, quantity) {
  let total = 0;
  for (const row of fundingRows) {
    if (row.eventTime < entryTime) continue;
    if (row.eventTime >= exitTime) break;
    const mark = markByTime.get(row.eventTime);
    if (!mark) throw new Error(`${leg.symbol}: missing funding mark at ${row.eventTime}`);
    total += -Math.sign(leg.weight) * quantity * mark.open * row.fundingRate;
  }
  return total;
}

export function executePortfolio(portfolio, dataBySymbol, scenario, holdBars) {
  const entryTime = portfolio.eventTime + FIVE_MINUTES;
  const exitTime = entryTime + holdBars * FIVE_MINUTES;
  const legs = portfolio.legs.map(leg => {
    const data = dataBySymbol[leg.symbol];
    const byTime = data.contractByTime
      ?? new Map(data.contract.map(row => [row.openTime, row]));
    const entryPrice = byTime.get(entryTime)?.open;
    const exitPrice = byTime.get(exitTime)?.open;
    if (!(entryPrice > 0) || !(exitPrice > 0)) {
      throw new Error(`${leg.symbol}: missing execution price at ${portfolio.eventTime}`);
    }
    const side = Math.sign(leg.weight);
    const notional = Math.abs(leg.weight);
    const quantity = notional / entryPrice;
    const entryFill = entryPrice * (1 + side * scenario.slippagePerSide);
    const exitFill = exitPrice * (1 - side * scenario.slippagePerSide);
    const grossReturn = side * quantity * (exitPrice - entryPrice);
    const priceAfterSlippage = side * quantity * (exitFill - entryFill);
    const fees = scenario.feePerSide * quantity * (entryFill + exitFill);
    const markByTime = data.markByTime
      ?? new Map(data.mark.map(row => [row.openTime, row]));
    const fundingReturn = fundingPnl(
      leg,
      entryTime,
      exitTime,
      data.funding,
      markByTime,
      quantity
    );
    return {
      ...leg,
      side,
      notional,
      entryTime,
      exitTime,
      entryPrice,
      exitPrice,
      entryFill,
      exitFill,
      grossReturn,
      priceAfterSlippage,
      fees,
      fundingReturn,
      netReturn: priceAfterSlippage - fees + fundingReturn
    };
  });
  const sum = field => legs.reduce((total, leg) => total + leg[field], 0);
  return {
    eventTime: portfolio.eventTime,
    shockReturn: portfolio.shockReturn,
    shockZscore: portfolio.shockZscore,
    exAnteBeta: portfolio.exAnteBeta,
    scenario: scenario.name,
    entryTime,
    exitTime,
    longs: portfolio.longs,
    shorts: portfolio.shorts,
    grossReturn: sum('grossReturn'),
    fees: sum('fees'),
    fundingReturn: sum('fundingReturn'),
    netReturn: sum('netReturn'),
    longSleeveNet: legs.filter(leg => leg.sleeve === 'long')
      .reduce((total, leg) => total + leg.netReturn, 0),
    shortSleeveNet: legs.filter(leg => leg.sleeve === 'short')
      .reduce((total, leg) => total + leg.netReturn, 0),
    hedgeNet: legs.filter(leg => leg.sleeve === 'hedge')
      .reduce((total, leg) => total + leg.netReturn, 0),
    legs
  };
}

function grouped(trades, key) {
  const output = {};
  for (const trade of trades) {
    const name = key(trade);
    output[name] = (output[name] ?? 0) + trade.netReturn;
  }
  return output;
}

export function summarizePortfolios(trades, altSymbols) {
  const ordered = trades.slice().sort((a, b) => a.eventTime - b.eventTime);
  const wins = ordered.filter(trade => trade.netReturn > 0);
  const losses = ordered.filter(trade => trade.netReturn < 0);
  const net = ordered.reduce((sum, trade) => sum + trade.netReturn, 0);
  let cumulative = 0;
  let peak = 0;
  let drawdown = 0;
  for (const trade of ordered) {
    cumulative += trade.netReturn;
    peak = Math.max(peak, cumulative);
    drawdown = Math.min(drawdown, cumulative - peak);
  }
  const altPnl = Object.fromEntries(altSymbols.map(symbol => [symbol, 0]));
  for (const trade of ordered) {
    for (const leg of trade.legs) {
      if (leg.sleeve !== 'hedge') altPnl[leg.symbol] += leg.netReturn;
    }
  }
  const byMonth = grouped(ordered, trade => new Date(trade.eventTime).toISOString().slice(0, 7));
  const positiveMonths = Object.values(byMonth).filter(value => value > 0);
  const positiveTotal = positiveMonths.reduce((sum, value) => sum + value, 0);
  const byHalfYear = grouped(ordered, trade => {
    const date = new Date(trade.eventTime);
    return `${date.getUTCFullYear()}-H${date.getUTCMonth() < 6 ? 1 : 2}`;
  });
  return {
    eventPortfolios: ordered.length,
    wins: wins.length,
    winRate: ordered.length ? wins.length / ordered.length : 0,
    grossReturnUnits: ordered.reduce((sum, trade) => sum + trade.grossReturn, 0),
    netReturnUnits: net,
    profitFactor: losses.length
      ? wins.reduce((sum, trade) => sum + trade.netReturn, 0)
        / Math.abs(losses.reduce((sum, trade) => sum + trade.netReturn, 0))
      : null,
    profitWithoutBest5Events: ordered.map(trade => trade.netReturn)
      .sort((a, b) => b - a).slice(5).reduce((sum, value) => sum + value, 0),
    maxDrawdownReturnUnits: drawdown,
    totalFees: ordered.reduce((sum, trade) => sum + trade.fees, 0),
    totalFunding: ordered.reduce((sum, trade) => sum + trade.fundingReturn, 0),
    longSleeveNet: ordered.reduce((sum, trade) => sum + trade.longSleeveNet, 0),
    shortSleeveNet: ordered.reduce((sum, trade) => sum + trade.shortSleeveNet, 0),
    hedgeNet: ordered.reduce((sum, trade) => sum + trade.hedgeNet, 0),
    profitableAltSymbols: Object.values(altPnl).filter(value => value > 0).length,
    profitableHalfYears: Object.values(byHalfYear).filter(value => value > 0).length,
    maxPositiveMonthContributionShare: positiveTotal
      ? Math.max(...positiveMonths) / positiveTotal
      : 1,
    altPnl,
    byHalfYear,
    byMonth
  };
}

export function developmentScreen(summary, thresholds) {
  const checks = {
    minimumEvents: summary.eventPortfolios >= thresholds.minimumEvents,
    stressProfitFactor: summary.profitFactor != null
      && summary.profitFactor >= thresholds.minimumProfitFactor,
    positiveNet: summary.netReturnUnits > 0,
    withoutBest5Events: summary.profitWithoutBest5Events > 0,
    maxDrawdown: summary.maxDrawdownReturnUnits >= thresholds.maximumDrawdown,
    symbolBreadth: summary.profitableAltSymbols >= thresholds.minimumProfitableSymbols,
    bothSleeves: summary.longSleeveNet > 0 && summary.shortSleeveNet > 0,
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
