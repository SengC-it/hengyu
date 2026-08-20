const BPS = 10_000;
export const DEFAULT_FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1_000;

function finite(name, value, { minimum = -Infinity, exclusiveMinimum = false } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (exclusiveMinimum ? parsed <= minimum : parsed < minimum)) {
    throw new Error(`invalid ${name}`);
  }
  return parsed;
}

function integer(name, value, { minimum = 0 } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`invalid ${name}`);
  return parsed;
}

function sideSign(side) {
  if (side === 'BUY') return 1;
  if (side === 'SELL') return -1;
  throw new Error(`unsupported side: ${side}`);
}

function fundingRate(row) {
  return finite('funding rate', row?.fundingRate ?? row?.lastFundingRate ?? row?.rate);
}

function fundingTime(row) {
  return integer('funding time', row?.fundingTime ?? row?.eventTime ?? row?.timestamp ?? row?.time);
}

/**
 * Estimate the return contribution of the currently published funding rate.
 * This is a research estimate only; settled rows are used for realized replay.
 */
export function estimateFundingCarryBps({
  side,
  fundingRate: rate,
  holdingPeriodMs,
  fundingIntervalMs = DEFAULT_FUNDING_INTERVAL_MS,
  settlementCount = null
}) {
  const intervals = settlementCount == null
    ? Math.max(0, Math.ceil(integer('holding period', holdingPeriodMs) / integer('funding interval', fundingIntervalMs, { minimum: 1 })))
    : integer('settlement count', settlementCount);
  return -sideSign(side) * finite('funding rate', rate) * intervals * BPS;
}

/**
 * Calculate realized funding payments and the holding-period accounting fields
 * used by paper replays. Positive fundingPnl is favorable to the position.
 */
export function calculateFundingStats({
  side,
  quantity,
  entryPrice,
  fundingRates = [],
  markPrices = [],
  entryTime,
  exitTime
}) {
  const signed = sideSign(side);
  const positionQuantity = finite('funding quantity', quantity, { minimum: 0, exclusiveMinimum: true });
  const initialNotional = positionQuantity * finite('funding entry price', entryPrice, { minimum: 0, exclusiveMinimum: true });
  const start = integer('funding entry time', entryTime);
  const end = integer('funding exit time', exitTime, { minimum: start });
  const marks = [...(markPrices ?? [])]
    .map(row => ({
      time: integer('mark time', row?.fundingTime ?? row?.eventTime ?? row?.timestamp ?? row?.time),
      price: finite('mark price', row?.markPrice ?? row?.price ?? row?.p, { minimum: 0, exclusiveMinimum: true })
    }))
    .sort((left, right) => left.time - right.time);
  const markAtOrBefore = time => {
    let selected = null;
    for (const mark of marks) {
      if (mark.time > time) break;
      selected = mark;
    }
    return selected;
  };
  let fundingPnl = 0;
  const details = [];
  for (const row of [...(fundingRates ?? [])].sort((left, right) => fundingTime(left) - fundingTime(right))) {
    const time = fundingTime(row);
    if (time < start || time > end) continue;
    const mark = markAtOrBefore(time) ?? {
      time,
      price: finite('funding row mark price', row?.markPrice ?? row?.mark ?? entryPrice, { minimum: 0, exclusiveMinimum: true })
    };
    const rate = fundingRate(row);
    const payment = -signed * positionQuantity * mark.price * rate;
    fundingPnl += payment;
    details.push({ fundingTime: time, rate, markPrice: mark.price, payment });
  }
  const fundingPnlBps = fundingPnl / initialNotional * BPS;
  return {
    holdingPeriodMs: end - start,
    fundingEvents: details.length,
    fundingPnl,
    fundingPnlBps,
    fundingCostBps: -fundingPnlBps,
    details
  };
}
