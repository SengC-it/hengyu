import { FIVE_MINUTES, normalizeTimestamp } from './archive.mjs';

const DAY = 24 * 60 * 60 * 1000;

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

export function median(values) {
  if (!values.length) return null;
  const ordered = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

export function robustStats(values) {
  const center = median(values);
  if (center == null) return null;
  const mad = median(values.map(value => Math.abs(value - center)));
  return { center, scale: 1.4826 * mad };
}

export function parseFundingHistoryJson(buffer, symbol) {
  const payload = JSON.parse(buffer.toString('utf8'));
  if (!Array.isArray(payload)) throw new Error(`${symbol}/funding API response is not an array`);
  const seen = new Set();
  const rows = payload.map((item, index) => {
    if (item.symbol !== symbol) throw new Error(`${symbol}/funding API row ${index + 1}: symbol mismatch`);
    const archiveTime = normalizeTimestamp(item.fundingTime);
    const row = {
      symbol,
      archiveTime,
      eventTime: Math.floor(archiveTime / FIVE_MINUTES) * FIVE_MINUTES,
      fundingRate: Number(item.fundingRate),
      markPrice: Number(item.markPrice),
      rateType: item.rateType ?? 'Regular'
    };
    if (![row.archiveTime, row.eventTime, row.fundingRate, row.markPrice].every(Number.isFinite)
      || row.markPrice <= 0) {
      throw new Error(`${symbol}/funding API row ${index + 1}: invalid value`);
    }
    if (row.archiveTime - row.eventTime >= 1000) {
      throw new Error(`${symbol}/funding API row ${index + 1}: timestamp lag exceeds one second`);
    }
    if (seen.has(row.eventTime)) {
      throw new Error(`${symbol}/funding API row ${index + 1}: duplicate normalized event time`);
    }
    seen.add(row.eventTime);
    return row;
  }).sort((left, right) => left.eventTime - right.eventTime);
  return rows;
}

export function buildPairSeries({ baseAsset, usdtBars, usdcBars, fxBars }) {
  const usdcByTime = new Map(usdcBars.map(row => [row.openTime, row]));
  const fxByTime = new Map(fxBars.map(row => [row.openTime, row]));
  const rows = [];
  for (const usdt of usdtBars) {
    const usdc = usdcByTime.get(usdt.openTime);
    const fx = fxByTime.get(usdt.openTime);
    if (!usdc || !fx) continue;
    rows.push({
      baseAsset,
      openTime: usdt.openTime,
      closeTime: usdt.closeTime,
      usdt,
      usdc,
      fx,
      spread: Math.log(usdt.close / (usdc.close * fx.close)),
      usdtQuoteVolume: usdt.quoteVolume,
      usdcQuoteVolumeUsdt: usdc.quoteVolume * fx.close
    });
  }
  for (let index = 1; index < rows.length; index++) {
    if (rows[index].openTime - rows[index - 1].openTime !== FIVE_MINUTES) {
      throw new Error(`${baseAsset}: synchronized pair series is non-contiguous at ${rows[index - 1].openTime}`);
    }
  }
  return rows;
}

export function detectPairEvents(series, options = {}) {
  const robustLookbackBars = options.robustLookbackBars ?? 8640;
  const minimumAbsoluteDeviation = options.minimumAbsoluteDeviation ?? 0.006;
  const minimumAbsoluteRobustZ = options.minimumAbsoluteRobustZ ?? 4;
  const rearmAbsoluteDeviation = options.rearmAbsoluteDeviation ?? 0.003;
  const rearmAbsoluteRobustZ = options.rearmAbsoluteRobustZ ?? 2;
  const liquidityLookbackBars = options.liquidityLookbackBars ?? 288;
  const minimumQuoteVolume = options.minimumQuoteVolume ?? 25_000_000;
  const referenceLegNotional = options.referenceLegNotional ?? 5_000;
  const maximumPriorBarParticipation = options.maximumPriorBarParticipation ?? 0.02;
  const maximumHoldBars = options.maximumHoldBars ?? 288;
  const evaluationStart = options.evaluationStart ?? -Infinity;
  const evaluationEnd = options.evaluationEnd ?? Infinity;
  const prefixUsdtVolume = [0];
  const prefixUsdcVolume = [0];
  for (const row of series) {
    prefixUsdtVolume.push(prefixUsdtVolume.at(-1) + row.usdtQuoteVolume);
    prefixUsdcVolume.push(prefixUsdcVolume.at(-1) + row.usdcQuoteVolumeUsdt);
  }

  const events = [];
  let stats = null;
  let armed = true;
  let blockedUntilIndex = -1;
  for (let index = 0; index < series.length; index++) {
    const row = series[index];
    if (row.openTime % DAY === 0 && index >= robustLookbackBars) {
      stats = robustStats(series.slice(index - robustLookbackBars, index).map(item => item.spread));
    }
    if (!stats || !(stats.scale > 0) || index < liquidityLookbackBars || index < blockedUntilIndex) {
      continue;
    }
    const deviation = row.spread - stats.center;
    const robustZ = deviation / stats.scale;
    if (!armed
      && Math.abs(deviation) < rearmAbsoluteDeviation
      && Math.abs(robustZ) < rearmAbsoluteRobustZ) {
      armed = true;
    }
    const entryIndex = index + 1;
    const maximumExitIndex = entryIndex + maximumHoldBars;
    if (!armed
      || row.closeTime < evaluationStart
      || row.closeTime >= evaluationEnd
      || maximumExitIndex >= series.length
      || Math.abs(deviation) < minimumAbsoluteDeviation
      || Math.abs(robustZ) < minimumAbsoluteRobustZ) {
      continue;
    }
    const volumeStart = index - liquidityLookbackBars;
    const trailingUsdtVolume = prefixUsdtVolume[index] - prefixUsdtVolume[volumeStart];
    const trailingUsdcVolume = prefixUsdcVolume[index] - prefixUsdcVolume[volumeStart];
    const prior = series[index - 1];
    const priorUsdtParticipation = referenceLegNotional / prior.usdtQuoteVolume;
    const priorUsdcParticipation = referenceLegNotional / prior.usdcQuoteVolumeUsdt;
    if (trailingUsdtVolume < minimumQuoteVolume
      || trailingUsdcVolume < minimumQuoteVolume
      || priorUsdtParticipation > maximumPriorBarParticipation
      || priorUsdcParticipation > maximumPriorBarParticipation) {
      continue;
    }

    const deviationSign = Math.sign(deviation);
    let exitIndex = maximumExitIndex;
    let exitReason = 'maximum_hold';
    for (let cursor = entryIndex; cursor < maximumExitIndex; cursor++) {
      if (deviationSign * (series[cursor].spread - stats.center) <= 0) {
        exitIndex = cursor + 1;
        exitReason = 'converged';
        break;
      }
    }
    events.push({
      baseAsset: row.baseAsset,
      signalIndex: index,
      signalTime: row.closeTime,
      entryIndex,
      entryTime: series[entryIndex].openTime,
      exitIndex,
      exitTime: series[exitIndex].openTime,
      exitReason,
      center: stats.center,
      scale: stats.scale,
      entrySpread: row.spread,
      entryDeviation: deviation,
      robustZ,
      direction: deviationSign > 0 ? 'USDT_RICH' : 'USDC_RICH',
      sideUsdt: -deviationSign,
      sideUsdc: deviationSign,
      trailingUsdtVolume,
      trailingUsdcVolume,
      priorUsdtParticipation,
      priorUsdcParticipation
    });
    armed = false;
    blockedUntilIndex = exitIndex;
  }
  return events;
}

function fillPrice(price, side, slippage, isEntry) {
  return price * (1 + (isEntry ? side : -side) * slippage);
}

function fundingCash({
  side,
  quantity,
  entryTime,
  exitTime,
  fundingRows,
  markByTime,
  fxByTime,
  convertFromUsdc
}) {
  let cash = 0;
  for (const funding of fundingRows) {
    if (funding.eventTime < entryTime) continue;
    if (funding.eventTime >= exitTime) break;
    const markPrice = funding.markPrice ?? markByTime.get(funding.eventTime)?.open;
    if (!(markPrice > 0)) throw new Error(`missing mark price at funding time ${funding.eventTime}`);
    const quoteCash = -side * quantity * markPrice * funding.fundingRate;
    if (!convertFromUsdc) {
      cash += quoteCash;
      continue;
    }
    const fx = fxByTime.get(funding.eventTime);
    if (!fx) throw new Error(`missing FX price at funding time ${funding.eventTime}`);
    cash += quoteCash * fx.open;
  }
  return cash;
}

function executeMode({
  event,
  series,
  usdtFunding,
  usdcFunding,
  usdtMarkByTime,
  usdcMarkByTime,
  fxByTime,
  scenario,
  delayedLeg
}) {
  const nominalEntry = series[event.entryIndex];
  const usdtEntryIndex = event.entryIndex + (delayedLeg === 'USDT' ? 1 : 0);
  const usdcEntryIndex = event.entryIndex + (delayedLeg === 'USDC' ? 1 : 0);
  if (usdtEntryIndex > event.exitIndex || usdcEntryIndex > event.exitIndex) {
    throw new Error(`${event.baseAsset}: delayed entry is after exit`);
  }
  const usdtEntry = series[usdtEntryIndex];
  const usdcEntry = series[usdcEntryIndex];
  const exit = series[event.exitIndex];
  const grossNotional = scenario.referenceGrossNotional;
  const quantity = grossNotional
    / (nominalEntry.usdt.open + nominalEntry.usdc.open * nominalEntry.fx.open);
  const usdtEntryFill = fillPrice(
    usdtEntry.usdt.open,
    event.sideUsdt,
    scenario.slippagePerFill,
    true
  );
  const usdtExitFill = fillPrice(
    exit.usdt.open,
    event.sideUsdt,
    scenario.slippagePerFill,
    false
  );
  const usdcEntryFill = fillPrice(
    usdcEntry.usdc.open,
    event.sideUsdc,
    scenario.slippagePerFill,
    true
  );
  const usdcExitFill = fillPrice(
    exit.usdc.open,
    event.sideUsdc,
    scenario.slippagePerFill,
    false
  );
  const usdtRawPriceCash = event.sideUsdt * quantity
    * (exit.usdt.open - usdtEntry.usdt.open);
  const usdcRawPriceCash = event.sideUsdc * quantity
    * (exit.usdc.open - usdcEntry.usdc.open) * exit.fx.open;
  const usdtPriceCash = event.sideUsdt * quantity * (usdtExitFill - usdtEntryFill);
  const usdcPriceCash = event.sideUsdc * quantity * (usdcExitFill - usdcEntryFill)
    * exit.fx.open;
  const usdtFees = scenario.feePerFill * quantity * (usdtEntryFill + usdtExitFill);
  const usdcFees = scenario.feePerFill * quantity * (
    usdcEntryFill * usdcEntry.fx.open + usdcExitFill * exit.fx.open
  );
  const usdtFundingCash = fundingCash({
    side: event.sideUsdt,
    quantity,
    entryTime: usdtEntry.openTime,
    exitTime: exit.openTime,
    fundingRows: usdtFunding,
    markByTime: usdtMarkByTime,
    fxByTime,
    convertFromUsdc: false
  });
  const usdcFundingCash = fundingCash({
    side: event.sideUsdc,
    quantity,
    entryTime: usdcEntry.openTime,
    exitTime: exit.openTime,
    fundingRows: usdcFunding,
    markByTime: usdcMarkByTime,
    fxByTime,
    convertFromUsdc: true
  });
  const usdtLegNetCash = usdtPriceCash - usdtFees + usdtFundingCash;
  const usdcLegNetCash = usdcPriceCash - usdcFees + usdcFundingCash;
  return {
    ...event,
    scenario: scenario.name,
    delayedLeg,
    actualUsdtEntryTime: usdtEntry.openTime,
    actualUsdcEntryTime: usdcEntry.openTime,
    quantity,
    usdtEntryFill,
    usdtExitFill,
    usdcEntryFill,
    usdcExitFill,
    entryFx: nominalEntry.fx.open,
    exitFx: exit.fx.open,
    grossPriceReturnUnits: (usdtRawPriceCash + usdcRawPriceCash) / grossNotional,
    priceReturnAfterSlippage: (usdtPriceCash + usdcPriceCash) / grossNotional,
    fees: (usdtFees + usdcFees) / grossNotional,
    fundingReturn: (usdtFundingCash + usdcFundingCash) / grossNotional,
    usdtLegNet: usdtLegNetCash / grossNotional,
    usdcLegNet: usdcLegNetCash / grossNotional,
    netReturn: (usdtLegNetCash + usdcLegNetCash) / grossNotional
  };
}

export function executePairEvent({
  event,
  series,
  usdtFunding,
  usdcFunding,
  usdtMarkByTime,
  usdcMarkByTime,
  fxByTime,
  scenario
}) {
  const common = {
    event,
    series,
    usdtFunding,
    usdcFunding,
    usdtMarkByTime,
    usdcMarkByTime,
    fxByTime,
    scenario
  };
  if (!scenario.singleLegDelay) return executeMode({ ...common, delayedLeg: null });
  const candidates = [
    executeMode({ ...common, delayedLeg: 'USDT' }),
    executeMode({ ...common, delayedLeg: 'USDC' })
  ];
  return candidates.sort((left, right) => left.netReturn - right.netReturn)[0];
}

function groupNet(trades, key) {
  const output = {};
  for (const trade of trades) {
    const name = key(trade);
    output[name] = (output[name] ?? 0) + trade.netReturn;
  }
  return output;
}

function maximumConcurrency(trades) {
  const boundaries = trades.flatMap(trade => [
    [trade.entryTime, 1],
    [trade.exitTime, -1]
  ]).sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  let current = 0;
  let maximum = 0;
  for (const [, change] of boundaries) {
    current += change;
    maximum = Math.max(maximum, current);
  }
  return maximum;
}

export function summarizePairTrades(trades) {
  const ordered = trades.slice().sort((left, right) =>
    left.exitTime - right.exitTime || left.baseAsset.localeCompare(right.baseAsset));
  const returns = ordered.map(trade => trade.netReturn);
  const wins = returns.filter(value => value > 0);
  const losses = returns.filter(value => value < 0);
  const byBaseAsset = groupNet(ordered, trade => trade.baseAsset);
  const byDirection = groupNet(ordered, trade => trade.direction);
  const byHalfYear = groupNet(ordered, trade => {
    const date = new Date(trade.entryTime);
    return `${date.getUTCFullYear()}-H${date.getUTCMonth() < 6 ? 1 : 2}`;
  });
  const byMonth = groupNet(ordered, trade => new Date(trade.entryTime).toISOString().slice(0, 7));
  const positiveMonths = Object.values(byMonth).filter(value => value > 0);
  const totalPositiveMonths = sum(positiveMonths);
  let cumulative = 0;
  let peak = 0;
  let maxDrawdownReturnUnits = 0;
  for (const value of returns) {
    cumulative += value;
    peak = Math.max(peak, cumulative);
    maxDrawdownReturnUnits = Math.min(maxDrawdownReturnUnits, cumulative - peak);
  }
  return {
    eventPairs: ordered.length,
    wins: wins.length,
    winRate: ordered.length ? wins.length / ordered.length : 0,
    grossPriceReturnUnits: sum(ordered.map(trade => trade.grossPriceReturnUnits)),
    netReturnUnits: sum(returns),
    profitFactor: losses.length ? sum(wins) / Math.abs(sum(losses)) : null,
    profitWithoutBest5Events: sum(returns.slice().sort((a, b) => b - a).slice(5)),
    maxDrawdownReturnUnits,
    totalFees: sum(ordered.map(trade => trade.fees)),
    totalFunding: sum(ordered.map(trade => trade.fundingReturn)),
    usdtLegNet: sum(ordered.map(trade => trade.usdtLegNet)),
    usdcLegNet: sum(ordered.map(trade => trade.usdcLegNet)),
    medianAbsoluteEntryDislocation: median(ordered.map(trade => Math.abs(trade.entryDeviation))) ?? 0,
    averageHoldHours: ordered.length
      ? sum(ordered.map(trade => trade.exitTime - trade.entryTime))
        / ordered.length / (60 * 60 * 1000)
      : 0,
    profitableBaseAssets: Object.values(byBaseAsset).filter(value => value > 0).length,
    profitableHalfYears: Object.values(byHalfYear).filter(value => value > 0).length,
    maxPositiveMonthContributionShare: totalPositiveMonths
      ? Math.max(...positiveMonths) / totalPositiveMonths
      : 1,
    maximumConcurrentEvents: maximumConcurrency(ordered),
    byBaseAsset,
    byDirection,
    byHalfYear,
    byMonth
  };
}

export function developmentScreen(stress, extreme, thresholds) {
  const checks = {
    minimumEvents: stress.eventPairs >= thresholds.minimumEvents,
    stressProfitFactor: stress.profitFactor != null
      && stress.profitFactor >= thresholds.minimumProfitFactor,
    positiveNet: stress.netReturnUnits > 0,
    withoutBest5Events: stress.profitWithoutBest5Events > 0,
    maxDrawdown: stress.maxDrawdownReturnUnits >= thresholds.maximumDrawdown,
    baseAssetBreadth: stress.profitableBaseAssets >= thresholds.minimumProfitableBaseAssets,
    bothSpreadDirections: (stress.byDirection.USDT_RICH ?? 0) > 0
      && (stress.byDirection.USDC_RICH ?? 0) > 0,
    halfYearBreadth: stress.profitableHalfYears >= thresholds.minimumProfitableHalfYears,
    monthConcentration:
      stress.maxPositiveMonthContributionShare <= thresholds.maximumPositiveMonthContributionShare,
    extremeSingleLegDelay: extreme.netReturnUnits > 0,
    medianEntryDislocation:
      stress.medianAbsoluteEntryDislocation >= thresholds.minimumMedianEntryDislocation
  };
  return {
    pass: Object.values(checks).every(Boolean),
    checks,
    failures: Object.entries(checks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name)
  };
}
