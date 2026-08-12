function finite(name, value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`invalid ${name}`);
  return parsed;
}

function timestamp(name, value) {
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`invalid ${name}`);
  return parsed;
}

function sum(rows, selector) {
  return rows.reduce((total, row) => total + selector(row), 0);
}

function monthOf(time) {
  return new Date(time).toISOString().slice(0, 7);
}

function maximumDrawdown(returns) {
  let equity = 0;
  let peak = 0;
  let drawdown = 0;
  for (const value of returns) {
    equity += value;
    peak = Math.max(peak, equity);
    drawdown = Math.min(drawdown, equity - peak);
  }
  return drawdown;
}

function maximumLossStreak(returns) {
  let current = 0;
  let maximum = 0;
  for (const value of returns) {
    current = value < 0 ? current + 1 : 0;
    maximum = Math.max(maximum, current);
  }
  return maximum;
}

export function summarizePerformance(rows, {
  scenario = null,
  periodStart,
  periodEnd,
  returnField = 'netReturn'
} = {}) {
  const start = timestamp('period start', periodStart);
  const end = timestamp('period end', periodEnd);
  if (end <= start) throw new Error('period end must follow period start');

  const selected = (rows ?? [])
    .filter(row => scenario == null || row?.scenario === scenario)
    .map(row => ({
      row,
      eventTime: timestamp('event time', row?.eventTime ?? row?.eventId),
      netReturn: finite(returnField, row?.[returnField])
    }))
    .filter(item => item.eventTime >= start && item.eventTime < end)
    .sort((left, right) => left.eventTime - right.eventTime);

  const returns = selected.map(item => item.netReturn);
  const wins = returns.filter(value => value > 0);
  const losses = returns.filter(value => value < 0);
  const grossProfit = sum(wins, value => value);
  const grossLoss = -sum(losses, value => value);
  const monthlyMap = new Map();
  for (const item of selected) {
    const month = monthOf(item.eventTime);
    monthlyMap.set(month, (monthlyMap.get(month) ?? 0) + item.netReturn);
  }
  const monthly = [...monthlyMap.entries()].map(([month, netReturnUnits]) => ({ month, netReturnUnits }));
  const averageWin = wins.length ? grossProfit / wins.length : null;
  const averageLoss = losses.length ? -grossLoss / losses.length : null;
  const payoffRatio = averageWin != null && averageLoss != null
    ? averageWin / Math.abs(averageLoss)
    : null;
  const breakevenWinRate = payoffRatio == null ? null : 1 / (1 + payoffRatio);
  const sortedBestFirst = returns.slice().sort((left, right) => right - left);

  return {
    period: {
      start: new Date(start).toISOString(),
      endExclusive: new Date(end).toISOString()
    },
    scenario,
    trades: returns.length,
    wins: wins.length,
    losses: losses.length,
    winRate: returns.length ? wins.length / returns.length : null,
    grossProfitReturnUnits: grossProfit,
    grossLossReturnUnits: grossLoss,
    netReturnUnits: sum(returns, value => value),
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : null),
    averageWinReturnUnits: averageWin,
    averageLossReturnUnits: averageLoss,
    payoffRatio,
    breakevenWinRate,
    expectancyReturnUnits: returns.length ? sum(returns, value => value) / returns.length : null,
    maximumDrawdownReturnUnits: maximumDrawdown(returns),
    maximumConsecutiveLosses: maximumLossStreak(returns),
    profitWithoutBest5Trades: sum(sortedBestFirst.slice(5), value => value),
    positiveMonths: monthly.filter(row => row.netReturnUnits > 0).length,
    negativeMonths: monthly.filter(row => row.netReturnUnits < 0).length,
    observedMonths: monthly.length,
    monthly
  };
}

export function evaluatePromotion(summary, {
  minimumTrades,
  minimumProfitFactor,
  requirePositiveNet = true,
  requirePositiveWithoutBest5 = true,
  maximumDrawdownReturnUnits
} = {}) {
  const checks = {
    minimumTrades: summary.trades >= finite('minimum trades', minimumTrades),
    profitFactor: summary.profitFactor != null
      && summary.profitFactor >= finite('minimum profit factor', minimumProfitFactor),
    positiveNet: !requirePositiveNet || summary.netReturnUnits > 0,
    positiveWithoutBest5: !requirePositiveWithoutBest5 || summary.profitWithoutBest5Trades > 0,
    maximumDrawdown: summary.maximumDrawdownReturnUnits
      >= finite('maximum drawdown return units', maximumDrawdownReturnUnits)
  };
  const failures = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  return {
    status: failures.length ? 'ELIMINATED' : 'ELIGIBLE_FOR_NEXT_STAGE',
    newSignalsAllowed: false,
    checks,
    failures,
    reason: failures.length
      ? 'The exact specification failed frozen evidence gates and must not be reused or tuned in place.'
      : 'Passing permits only the next research stage; it never authorizes live orders.'
  };
}

export function lossContainmentComparison(summary, { referenceNotionalUsdt } = {}) {
  const notional = finite('reference notional', referenceNotionalUsdt);
  if (notional <= 0) throw new Error('reference notional must be positive');
  const beforePnlUsdt = summary.netReturnUnits * notional;
  return {
    basis: 'DISABLE_FAILED_EXACT_SPECIFICATION',
    before: {
      trades: summary.trades,
      netReturnUnits: summary.netReturnUnits,
      pnlUsdt: beforePnlUsdt
    },
    after: {
      trades: 0,
      netReturnUnits: 0,
      pnlUsdt: 0
    },
    historicalLossExposureRemovedUsdt: Math.max(0, -beforePnlUsdt),
    warning: 'The gate is decided after the completed audit window. The after case is current loss containment through NO_TRADE, not retroactive avoided loss or evidence of a profitable replacement strategy.'
  };
}
