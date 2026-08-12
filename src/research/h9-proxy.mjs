const FIVE_MINUTES = 300_000;
const DAY = 86_400_000;

function insertionIndex(sorted, value) {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sorted[middle] < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

export function replayH9Proxy(bars, {
  evaluationStart,
  evaluationEnd,
  warmupDays = 30,
  thresholdProbability = 0.995,
  cooldownMinutes = 30,
  stopImpulseMultiplier = 0.75,
  holdMinutes = 15,
  stressCostBpsPerFill = 7
} = {}) {
  const start = Number(evaluationStart);
  const end = Number(evaluationEnd);
  const warmupBars = warmupDays * DAY / FIVE_MINUTES;
  const cooldownMs = cooldownMinutes * 60_000;
  const holdBars = holdMinutes / 5;
  const pressureRows = [];
  const sortedPressures = [];
  let lastEventTime = -Infinity;
  let openUntil = -Infinity;
  const trades = [];

  for (let index = 6; index < bars.length - holdBars - 2; index++) {
    const bar = bars[index];
    const trailing = bars.slice(index - 6, index);
    const denominator = sum(trailing.map(row => row.quoteVolume));
    const signedFlow = 2 * bar.takerBuyQuoteVolume - bar.quoteVolume;
    const pressure = denominator > 0 ? signedFlow / denominator : null;
    const cutoff = bar.openTime - warmupDays * DAY;
    while (pressureRows.length && pressureRows[0].time < cutoff) {
      const removed = pressureRows.shift().absolutePressure;
      sortedPressures.splice(insertionIndex(sortedPressures, removed), 1);
    }
    const threshold = sortedPressures.length >= warmupBars * 0.95
      ? sortedPressures[Math.max(0, Math.ceil(thresholdProbability * sortedPressures.length) - 1)]
      : null;
    if (pressure != null) {
      const absolutePressure = Math.abs(pressure);
      pressureRows.push({ time: bar.openTime, absolutePressure });
      sortedPressures.splice(insertionIndex(sortedPressures, absolutePressure), 0, absolutePressure);
    }
    if (bar.openTime < start || bar.openTime >= end || threshold == null) continue;
    if (Math.abs(pressure) < threshold || bar.openTime - lastEventTime < cooldownMs || bar.openTime < openUntil) continue;

    const recovery = bars[index + 1];
    const negativePressure = pressure < 0;
    const recovered = negativePressure
      ? recovery.low >= bar.low && recovery.close > bar.close
      : recovery.high <= bar.high && recovery.close < bar.close;
    if (!recovered) continue;
    const entryBar = bars[index + 2];
    const side = negativePressure ? 1 : -1;
    const impulse = Math.max(bar.high - bar.low, bar.close * 0.0001);
    const entryPrice = entryBar.open;
    const stopPrice = side > 0
      ? entryPrice - stopImpulseMultiplier * impulse
      : entryPrice + stopImpulseMultiplier * impulse;
    let exitPrice = bars[index + 2 + holdBars].open;
    let exitTime = bars[index + 2 + holdBars].openTime;
    let exitReason = 'time';
    for (let cursor = index + 2; cursor < index + 2 + holdBars; cursor++) {
      const observed = bars[cursor];
      const stopped = side > 0 ? observed.low <= stopPrice : observed.high >= stopPrice;
      if (stopped) {
        exitPrice = stopPrice;
        exitTime = observed.openTime;
        exitReason = 'stop';
        break;
      }
    }
    const grossReturn = side * (exitPrice - entryPrice) / entryPrice;
    const netReturn = grossReturn - 2 * stressCostBpsPerFill / 10_000;
    trades.push({
      symbol: bar.symbol,
      eventTime: bar.openTime,
      entryTime: entryBar.openTime,
      exitTime,
      side: side > 0 ? 'BUY' : 'SELL',
      pressure,
      threshold,
      entryPrice,
      exitPrice,
      stopPrice,
      exitReason,
      grossReturn,
      netReturn
    });
    lastEventTime = bar.openTime;
    openUntil = exitTime;
  }
  return trades;
}

export function summarizeH9Proxy(trades) {
  const ordered = trades.slice().sort((a, b) => a.exitTime - b.exitTime || a.symbol.localeCompare(b.symbol));
  const grossWins = ordered.filter(row => row.grossReturn > 0);
  const grossLosses = ordered.filter(row => row.grossReturn < 0);
  const wins = ordered.filter(row => row.netReturn > 0);
  const losses = ordered.filter(row => row.netReturn < 0);
  let equity = 0;
  let peak = 0;
  let maximumDrawdown = 0;
  const byMonth = {};
  const byDirection = {};
  const bySymbol = {};
  for (const row of ordered) {
    equity += row.netReturn;
    peak = Math.max(peak, equity);
    maximumDrawdown = Math.min(maximumDrawdown, equity - peak);
    const month = new Date(row.eventTime).toISOString().slice(0, 7);
    byMonth[month] = (byMonth[month] ?? 0) + row.netReturn;
    byDirection[row.side] = (byDirection[row.side] ?? 0) + row.netReturn;
    bySymbol[row.symbol] = (bySymbol[row.symbol] ?? 0) + row.netReturn;
  }
  const grossProfit = sum(wins.map(row => row.netReturn));
  const grossLoss = -sum(losses.map(row => row.netReturn));
  const priceGrossProfit = sum(grossWins.map(row => row.grossReturn));
  const priceGrossLoss = -sum(grossLosses.map(row => row.grossReturn));
  return {
    trades: ordered.length,
    wins: wins.length,
    losses: losses.length,
    winRate: ordered.length ? wins.length / ordered.length : null,
    grossPriceWinRate: ordered.length ? grossWins.length / ordered.length : null,
    grossPriceReturnUnits: sum(ordered.map(row => row.grossReturn)),
    grossPriceProfitFactor: priceGrossLoss > 0 ? priceGrossProfit / priceGrossLoss : null,
    netReturnUnits: sum(ordered.map(row => row.netReturn)),
    averageNetReturnBps: ordered.length ? sum(ordered.map(row => row.netReturn)) / ordered.length * 10_000 : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    maximumDrawdownReturnUnits: maximumDrawdown,
    profitWithoutBest5Trades: sum(ordered.map(row => row.netReturn).sort((a, b) => b - a).slice(5)),
    positiveMonths: Object.values(byMonth).filter(value => value > 0).length,
    observedMonths: Object.keys(byMonth).length,
    profitableSymbols: Object.values(bySymbol).filter(value => value > 0).length,
    byMonth,
    byDirection,
    bySymbol
  };
}

export function continuationDecision(summary, thresholds) {
  const checks = {
    minimumTrades: summary.trades >= thresholds.minimum_closed_trades,
    profitFactor: summary.profitFactor != null && summary.profitFactor >= thresholds.minimum_profit_factor,
    positiveNet: summary.netReturnUnits > 0,
    maximumDrawdown: summary.maximumDrawdownReturnUnits >= thresholds.maximum_drawdown_return_units,
    withoutBest5: summary.profitWithoutBest5Trades > 0,
    positiveMonthShare: summary.observedMonths > 0
      && summary.positiveMonths / summary.observedMonths >= thresholds.minimum_positive_month_share,
    bothDirections: ['BUY', 'SELL'].every(side => (summary.byDirection[side] ?? -Infinity) >= 0),
    symbolBreadth: summary.profitableSymbols >= thresholds.minimum_profitable_symbols
  };
  const failures = Object.entries(checks).filter(([, value]) => !value).map(([key]) => key);
  return { continueExactH9Collection: failures.length === 0, checks, failures };
}
