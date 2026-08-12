import { summarizeH10Trend } from './h10-trend.mjs';

export function summarizeH11(trades, { allocationFraction = 1 / 6, monthKeys = [], midpoint } = {}) {
  const summary = summarizeH10Trend(trades, { allocationFraction, monthKeys });
  const split = Number(midpoint);
  const byHalfPeriod = {
    first: trades.filter(row => row.exitTime < split).reduce((total, row) => total + row.netReturn * allocationFraction, 0),
    second: trades.filter(row => row.exitTime >= split).reduce((total, row) => total + row.netReturn * allocationFraction, 0)
  };
  return { ...summary, byHalfPeriod };
}

export function h11PromotionDecision(summary, thresholds) {
  const checks = {
    minimumTrades: summary.trades >= thresholds.minimum_closed_trades,
    profitFactor: summary.profitFactor != null && summary.profitFactor >= thresholds.minimum_profit_factor,
    positiveNet: summary.netReturnFraction > 0,
    maximumDrawdown: summary.maximumClosedEquityDrawdownFraction >= thresholds.maximum_closed_equity_drawdown_fraction,
    withoutBest5: summary.profitWithoutBest5Trades > 0,
    positiveMonthShare: summary.observedMonths > 0 && summary.positiveMonths / summary.observedMonths >= thresholds.minimum_positive_month_share,
    symbolBreadth: summary.profitableSymbols >= thresholds.minimum_profitable_symbols,
    bothHalfPeriods: Object.values(summary.byHalfPeriod).every(value => value > 0)
  };
  const failures = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  return { pass: failures.length === 0, checks, failures };
}
