const BPS = 10_000;

function finite(name, value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`invalid ${name}`);
  return parsed;
}

function sideSign(side) {
  if (side === 'BUY') return 1;
  if (side === 'SELL') return -1;
  throw new Error(`unsupported side: ${side}`);
}

export function directionalReturnBps(side, entryPrice, markPrice) {
  const entry = finite('entry price', entryPrice);
  const mark = finite('mark price', markPrice);
  if (!(entry > 0) || !(mark > 0)) throw new Error('prices must be positive');
  return sideSign(side) * (mark - entry) / entry * BPS;
}

/** Calculate adverse excursion, favorable excursion and path drawdown. */
export function calculateTradePathMetrics({ side, entryPrice, marks = [] }) {
  const path = marks
    .map(row => ({
      time: Number(row.time ?? row.eventTime ?? row.timestamp),
      price: Number(row.price ?? row.markPrice ?? row.close)
    }))
    .filter(row => Number.isFinite(row.time) && Number.isFinite(row.price) && row.price > 0)
    .sort((left, right) => left.time - right.time);
  const returns = path.map(row => ({ ...row, returnBps: directionalReturnBps(side, entryPrice, row.price) }));
  if (!returns.length) {
    return { maeBps: null, mfeBps: null, markToMarketDrawdownBps: null, marks: [] };
  }
  let peak = -Infinity;
  let maxDrawdown = 0;
  for (const row of returns) {
    peak = Math.max(peak, row.returnBps);
    maxDrawdown = Math.max(maxDrawdown, peak - row.returnBps);
  }
  return {
    maeBps: Math.min(...returns.map(row => row.returnBps)),
    mfeBps: Math.max(...returns.map(row => row.returnBps)),
    markToMarketDrawdownBps: maxDrawdown,
    marks: returns
  };
}
