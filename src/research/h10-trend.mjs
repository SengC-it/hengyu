const FOUR_HOURS = 4 * 60 * 60 * 1000;

const sum = values => values.reduce((total, value) => total + value, 0);

export function aggregateFourHourBars(bars) {
  const output = [];
  for (let offset = 0; offset < bars.length;) {
    const bucket = Math.floor(bars[offset].openTime / FOUR_HOURS) * FOUR_HOURS;
    const rows = [];
    while (offset < bars.length && Math.floor(bars[offset].openTime / FOUR_HOURS) * FOUR_HOURS === bucket) {
      rows.push(bars[offset++]);
    }
    if (rows.length !== 48 || rows[0].openTime !== bucket || rows.at(-1).openTime !== bucket + FOUR_HOURS - 300_000) {
      throw new Error(`incomplete 4h bucket: ${new Date(bucket).toISOString()} (${rows.length} bars)`);
    }
    output.push({
      symbol: rows[0].symbol,
      openTime: bucket,
      closeTime: bucket + FOUR_HOURS - 1,
      open: rows[0].open,
      high: Math.max(...rows.map(row => row.high)),
      low: Math.min(...rows.map(row => row.low)),
      close: rows.at(-1).close,
      quoteVolume: sum(rows.map(row => row.quoteVolume))
    });
  }
  return output;
}

export function atrAt(bars, index, period) {
  if (index < period) return null;
  const ranges = [];
  for (let cursor = index - period + 1; cursor <= index; cursor++) {
    const previousClose = bars[cursor - 1].close;
    ranges.push(Math.max(
      bars[cursor].high - bars[cursor].low,
      Math.abs(bars[cursor].high - previousClose),
      Math.abs(bars[cursor].low - previousClose)
    ));
  }
  return sum(ranges) / period;
}

export function replayH10Trend(bars, {
  evaluationStart,
  evaluationEnd,
  entryChannelBars = 120,
  exitChannelBars = 60,
  atrBars = 30,
  initialStopAtrMultiple = 2,
  stressCostBpsPerFill = 7,
  allowLong = true,
  allowShort = true,
  entryFilter = null
} = {}) {
  const start = Number(evaluationStart);
  const end = Number(evaluationEnd);
  const cost = stressCostBpsPerFill / 10_000;
  let position = null;
  let pendingEntry = null;
  let pendingExit = false;
  const trades = [];

  for (let index = Math.max(entryChannelBars, atrBars); index < bars.length; index++) {
    const bar = bars[index];
    if (bar.openTime >= end) break;

    if (pendingExit && position) {
      closePosition(position, bar.open, bar.openTime, 'channel', cost, trades);
      position = null;
      pendingExit = false;
    }
    if (pendingEntry && !position && bar.openTime >= start) {
      const side = pendingEntry.side;
      position = {
        symbol: bar.symbol,
        side,
        signalTime: pendingEntry.signalTime,
        entryTime: bar.openTime,
        entryPrice: bar.open,
        stopPrice: side > 0
          ? bar.open - initialStopAtrMultiple * pendingEntry.atr
          : bar.open + initialStopAtrMultiple * pendingEntry.atr
      };
      pendingEntry = null;
    }

    if (position) {
      const stopped = position.side > 0 ? bar.low <= position.stopPrice : bar.high >= position.stopPrice;
      if (stopped) {
        closePosition(position, position.stopPrice, bar.openTime, 'stop', cost, trades);
        position = null;
        pendingExit = false;
        continue;
      }
      const exitWindow = bars.slice(index - exitChannelBars, index);
      const priorHigh = Math.max(...exitWindow.map(row => row.high));
      const priorLow = Math.min(...exitWindow.map(row => row.low));
      if ((position.side > 0 && bar.close < priorLow) || (position.side < 0 && bar.close > priorHigh)) {
        pendingExit = true;
      }
      continue;
    }

    if (bar.openTime < start - FOUR_HOURS || pendingEntry) continue;
    if (entryFilter && !entryFilter({ bar, index, bars })) continue;
    const entryWindow = bars.slice(index - entryChannelBars, index);
    const priorHigh = Math.max(...entryWindow.map(row => row.high));
    const priorLow = Math.min(...entryWindow.map(row => row.low));
    const longSignal = bar.close > priorHigh;
    const shortSignal = bar.close < priorLow;
    const atr = atrAt(bars, index, atrBars);
    if (atr && longSignal !== shortSignal) {
      if (longSignal && allowLong) pendingEntry = { side: 1, signalTime: bar.closeTime, atr };
      if (shortSignal && allowShort) pendingEntry = { side: -1, signalTime: bar.closeTime, atr };
    }
  }

  if (position) {
    const terminal = bars.filter(row => row.openTime < end).at(-1);
    closePosition(position, terminal.close, terminal.closeTime, 'terminal', cost, trades);
  }
  return trades;
}

function closePosition(position, exitPrice, exitTime, exitReason, costPerFill, trades) {
  const grossReturn = position.side * (exitPrice - position.entryPrice) / position.entryPrice;
  trades.push({
    symbol: position.symbol,
    side: position.side > 0 ? 'BUY' : 'SELL',
    signalTime: position.signalTime,
    entryTime: position.entryTime,
    exitTime,
    entryPrice: position.entryPrice,
    exitPrice,
    stopPrice: position.stopPrice,
    exitReason,
    grossReturn,
    netReturn: grossReturn - 2 * costPerFill
  });
}

export function summarizeH10Trend(trades, { allocationFraction = 1 / 6, monthKeys = [] } = {}) {
  const ordered = trades.slice().sort((a, b) => a.exitTime - b.exitTime || a.symbol.localeCompare(b.symbol));
  const wins = ordered.filter(row => row.netReturn > 0);
  const losses = ordered.filter(row => row.netReturn < 0);
  const grossWins = ordered.filter(row => row.grossReturn > 0);
  const grossLosses = ordered.filter(row => row.grossReturn < 0);
  let equity = 0;
  let peak = 0;
  let maximumDrawdown = 0;
  const byMonth = Object.fromEntries(monthKeys.map(month => [month, 0]));
  const byDirection = {};
  const bySymbol = {};
  for (const row of ordered) {
    const contribution = row.netReturn * allocationFraction;
    equity += contribution;
    peak = Math.max(peak, equity);
    maximumDrawdown = Math.min(maximumDrawdown, equity - peak);
    const month = new Date(row.exitTime).toISOString().slice(0, 7);
    byMonth[month] = (byMonth[month] ?? 0) + contribution;
    byDirection[row.side] = (byDirection[row.side] ?? 0) + contribution;
    bySymbol[row.symbol] = (bySymbol[row.symbol] ?? 0) + contribution;
  }
  const profit = sum(wins.map(row => row.netReturn));
  const loss = -sum(losses.map(row => row.netReturn));
  const grossProfit = sum(grossWins.map(row => row.grossReturn));
  const grossLoss = -sum(grossLosses.map(row => row.grossReturn));
  const bestRemoved = ordered.map(row => row.netReturn * allocationFraction).sort((a, b) => b - a).slice(5);
  return {
    trades: ordered.length,
    wins: wins.length,
    losses: losses.length,
    winRate: ordered.length ? wins.length / ordered.length : null,
    grossPriceWinRate: ordered.length ? grossWins.length / ordered.length : null,
    grossPriceProfitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    netReturnFraction: equity,
    averageNetReturnBpsPerTrade: ordered.length ? sum(ordered.map(row => row.netReturn)) / ordered.length * 10_000 : null,
    profitFactor: loss > 0 ? profit / loss : null,
    maximumClosedEquityDrawdownFraction: maximumDrawdown,
    profitWithoutBest5Trades: sum(bestRemoved),
    positiveMonths: Object.values(byMonth).filter(value => value > 0).length,
    observedMonths: Object.keys(byMonth).length,
    profitableSymbols: Object.values(bySymbol).filter(value => value > 0).length,
    byMonth,
    byDirection,
    bySymbol,
    exitReasons: ordered.reduce((result, row) => ({ ...result, [row.exitReason]: (result[row.exitReason] ?? 0) + 1 }), {})
  };
}

export function promotionDecision(summary, thresholds) {
  const checks = {
    minimumTrades: summary.trades >= thresholds.minimum_closed_trades,
    profitFactor: summary.profitFactor != null && summary.profitFactor >= thresholds.minimum_profit_factor,
    positiveNet: summary.netReturnFraction > 0,
    maximumDrawdown: summary.maximumClosedEquityDrawdownFraction >= thresholds.maximum_closed_equity_drawdown_fraction,
    withoutBest5: summary.profitWithoutBest5Trades > 0,
    positiveMonthShare: summary.observedMonths > 0 && summary.positiveMonths / summary.observedMonths >= thresholds.minimum_positive_month_share,
    bothDirections: ['BUY', 'SELL'].every(side => (summary.byDirection[side] ?? -Infinity) >= 0),
    symbolBreadth: summary.profitableSymbols >= thresholds.minimum_profitable_symbols
  };
  const failures = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  return { pass: failures.length === 0, checks, failures };
}
