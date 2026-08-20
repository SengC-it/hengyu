import { randomUUID } from 'node:crypto';
import { atrAt } from '../research/h10-trend.mjs';
import { broadBearRegimeTimes } from '../research/h12-regime.mjs';
import { estimateFundingCarryBps } from './funding.mjs';
import { buildNetEdgeAdvisorySignal } from './net-edge-advisory.mjs';
import { H12_CONFIG } from './policy-config.mjs';

const BPS = 10_000;
const FOUR_HOURS = 4 * 60 * 60 * 1000;

export const H12_PRODUCTION_POLICY = Object.freeze({
  experimentId: H12_CONFIG.experimentId,
  hypothesisId: H12_CONFIG.hypothesisId,
  symbols: Object.freeze([...H12_CONFIG.symbols]),
  entryChannelBars: H12_CONFIG.entryChannelBars,
  exitChannelBars: H12_CONFIG.exitChannelBars,
  atrBars: H12_CONFIG.atrBars,
  initialStopAtrMultiple: H12_CONFIG.initialStopAtrMultiple,
  btcFastSmaBars: H12_CONFIG.btcFastSmaBars,
  slowSmaBars: H12_CONFIG.slowSmaBars,
  minimumBreadth: H12_CONFIG.minimumBreadthBelowSlowSma,
  maxSchedulerDelayMs: H12_CONFIG.maxSchedulerDelayMs,
  signalValidityMs: H12_CONFIG.signalValidityMs,
  researchExpiryMs: H12_CONFIG.researchExpiryMs,
  maxHoldMs: H12_CONFIG.maxHoldMs,
  researchNotionalUsdt: H12_CONFIG.researchNotionalUsdt,
  researchEquityUsdt: H12_CONFIG.researchEquityUsdt,
  forecastStandardErrorBps: H12_CONFIG.forecastStandardErrorBps,
  fundingIntervalMs: H12_CONFIG.fundingIntervalMs,
  fundingStressBufferBps: H12_CONFIG.fundingStressBufferBps
});

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

function average(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function normalizeLevels(levels, side, symbol) {
  if (!Array.isArray(levels) || !levels.length) throw new Error(`${symbol}: ${side} depth is empty`);
  const normalized = levels.map((level, index) => {
    if (!Array.isArray(level) || level.length < 2) throw new Error(`${symbol}: invalid ${side} depth ${index}`);
    return [
      finite(`${symbol} ${side} price`, level[0], { minimum: 0, exclusiveMinimum: true }),
      finite(`${symbol} ${side} quantity`, level[1], { minimum: 0, exclusiveMinimum: true })
    ];
  });
  normalized.sort((left, right) => side === 'bid' ? right[0] - left[0] : left[0] - right[0]);
  return normalized;
}

export function normalizeFourHourKlines(symbol, rows) {
  const normalized = rows.map((row, index) => {
    if (!Array.isArray(row) || row.length < 7) throw new Error(`${symbol}: invalid 4h kline ${index}`);
    const openTime = integer(`${symbol} kline open time`, row[0]);
    const closeTime = integer(`${symbol} kline close time`, row[6]);
    const open = finite(`${symbol} open`, row[1], { minimum: 0, exclusiveMinimum: true });
    const high = finite(`${symbol} high`, row[2], { minimum: 0, exclusiveMinimum: true });
    const low = finite(`${symbol} low`, row[3], { minimum: 0, exclusiveMinimum: true });
    const close = finite(`${symbol} close`, row[4], { minimum: 0, exclusiveMinimum: true });
    if (low > high || open < low || open > high || close < low || close > high) {
      throw new Error(`${symbol}: invalid OHLC relationship`);
    }
    if (closeTime < openTime) throw new Error(`${symbol}: invalid kline interval`);
    if (index > 0 && openTime <= Number(rows[index - 1]?.[0])) {
      throw new Error(`${symbol}: kline timestamps are not increasing`);
    }
    return { symbol, openTime, closeTime, open, high, low, close };
  });
  return normalized;
}

export function normalizeH12Depth(symbol, payload, { receivedAt = Date.now() } = {}) {
  const bids = normalizeLevels(payload?.bids, 'bid', symbol);
  const asks = normalizeLevels(payload?.asks, 'ask', symbol);
  if (bids[0][0] >= asks[0][0]) throw new Error(`${symbol}: depth is crossed or locked`);
  return {
    symbol,
    bids,
    asks,
    eventTime: Number.isSafeInteger(Number(payload?.E)) ? Number(payload.E) : receivedAt,
    receivedAt,
    lastUpdateId: Number.isSafeInteger(Number(payload?.lastUpdateId)) ? Number(payload.lastUpdateId) : null
  };
}

export function normalizeH12Funding(symbol, payload, { receivedAt = Date.now() } = {}) {
  const row = Array.isArray(payload) ? payload.at(-1) : payload;
  if (!row || typeof row !== 'object') throw new Error(`${symbol}: funding payload is invalid`);
  const fundingRate = finite(`${symbol} funding rate`, row.lastFundingRate ?? row.fundingRate ?? row.rate);
  const nextFundingTime = integer(`${symbol} next funding time`, row.nextFundingTime ?? receivedAt);
  const fundingTime = Number.isSafeInteger(Number(row.fundingTime)) ? Number(row.fundingTime) : null;
  const markPrice = finite(`${symbol} mark price`, row.markPrice ?? row.mark, { minimum: 0, exclusiveMinimum: true });
  return { symbol, fundingRate, fundingTime, nextFundingTime, markPrice, receivedAt };
}

async function fetchEndpoint(symbol, pathname, search, normalize, { fetchImpl = fetch, label }) {
  const bases = [
    'https://fapi.binance.com',
    'https://fapi1.binance.com',
    'https://fapi2.binance.com',
    'https://fapi3.binance.com',
    'https://fapi4.binance.com'
  ];
  const failures = [];
  for (const base of bases) {
    const url = new URL(pathname, base);
    for (const [key, value] of Object.entries(search)) url.searchParams.set(key, String(value));
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) {
        failures.push(`${url.hostname}:${response.status}`);
        continue;
      }
      const payload = typeof response.json === 'function'
        ? await response.json()
        : JSON.parse(await response.text());
      return normalize(payload, { receivedAt: Date.now() });
    } catch (error) {
      failures.push(`${url.hostname}:${error.cause?.code ?? error.name ?? 'invalid_response'}`);
    }
  }
  throw new Error(`${symbol}: Binance ${label} endpoints unavailable (${failures.join(', ')})`);
}

export function fetchLiveH12Series(symbol, { fetchImpl = fetch } = {}) {
  return fetchEndpoint(
    symbol,
    '/fapi/v1/klines',
    { symbol, interval: '4h', limit: 220 },
    payload => normalizeFourHourKlines(symbol, payload),
    { fetchImpl, label: '4h kline' }
  );
}

export function fetchLiveH12Book(symbol, { fetchImpl = fetch } = {}) {
  return fetchEndpoint(
    symbol,
    '/fapi/v1/depth',
    { symbol, limit: 20 },
    (payload, timing) => normalizeH12Depth(symbol, payload, timing),
    { fetchImpl, label: 'depth' }
  );
}

export function fetchLiveH12Funding(symbol, { fetchImpl = fetch } = {}) {
  return fetchEndpoint(
    symbol,
    '/fapi/v1/premiumIndex',
    { symbol },
    (payload, timing) => normalizeH12Funding(symbol, payload, timing),
    { fetchImpl, label: 'funding' }
  );
}

export async function fetchLiveH12Market(symbol, { fetchImpl = fetch } = {}) {
  const [book, funding] = await Promise.all([
    fetchLiveH12Book(symbol, { fetchImpl }),
    fetchLiveH12Funding(symbol, { fetchImpl })
  ]);
  return { book, funding, receivedAt: Math.max(book.receivedAt, funding.receivedAt) };
}

function latestCompleted(series, now) {
  return series.filter(row => row.closeTime < now);
}

function regimeSnapshot(completedBySymbol, policy) {
  const reference = completedBySymbol.BTCUSDT;
  const index = reference.length - 1;
  const btcFastSma = average(reference.slice(index - policy.btcFastSmaBars + 1, index + 1).map(row => row.close));
  const btcSlowSma = average(reference.slice(index - policy.slowSmaBars + 1, index + 1).map(row => row.close));
  const breadthBySymbol = Object.fromEntries(policy.symbols.map(symbol => {
    const rows = completedBySymbol[symbol];
    const slowSma = average(rows.slice(index - policy.slowSmaBars + 1, index + 1).map(row => row.close));
    return [symbol, {
      close: rows[index].close,
      slowSma,
      belowSlowSma: rows[index].close < slowSma,
      distanceToSlowSmaBps: (rows[index].close / slowSma - 1) * BPS
    }];
  }));
  const breadth = Object.values(breadthBySymbol).filter(row => row.belowSlowSma).length;
  return {
    signalTime: reference[index].openTime,
    btcClose: reference[index].close,
    btcFastSma,
    btcSlowSma,
    breadth,
    breadthBySymbol,
    smaPass: btcFastSma < btcSlowSma && reference[index].close < btcSlowSma,
    pass: btcFastSma < btcSlowSma && reference[index].close < btcSlowSma && breadth >= policy.minimumBreadth
  };
}

function h12NetEdgePolicy(policy) {
  return {
    experimentId: policy.experimentId,
    signalValidityMs: policy.signalValidityMs,
    researchExpiryMs: policy.researchExpiryMs,
    researchEquityUsdt: policy.researchEquityUsdt,
    evidenceClass: 'F0_PENDING'
  };
}

function candidateDiagnostic(base, advisory) {
  return {
    ...base,
    status: advisory.status,
    decision: advisory.decision,
    alertLevel: advisory.alertLevel,
    reasons: advisory.reasons,
    netEdge: advisory.costs,
    portfolioReasons: []
  };
}

export function evaluateLiveH12Scan(seriesBySymbol, {
  marketBySymbol = {},
  now = Date.now(),
  policy = H12_PRODUCTION_POLICY
} = {}) {
  const completedBySymbol = {};
  for (const symbol of policy.symbols) {
    const completed = latestCompleted(seriesBySymbol[symbol] ?? [], now);
    if (completed.length < policy.slowSmaBars) throw new Error(`${symbol}: insufficient completed 4h history`);
    completedBySymbol[symbol] = completed;
  }
  const reference = completedBySymbol.BTCUSDT;
  const signalTime = reference.at(-1).openTime;
  for (const symbol of policy.symbols) {
    const rows = completedBySymbol[symbol];
    if (rows.at(-1).openTime !== signalTime) throw new Error(`${symbol}: latest completed bar is not aligned`);
  }
  const regime = regimeSnapshot(completedBySymbol, policy);
  const eligibleTimes = broadBearRegimeTimes(completedBySymbol, {
    symbols: policy.symbols,
    fastBars: policy.btcFastSmaBars,
    slowBars: policy.slowSmaBars,
    minimumBreadth: policy.minimumBreadth
  });
  const theoreticalOpenAt = signalTime + FOUR_HOURS;
  const schedulerDelayMs = Math.max(0, now - theoreticalOpenAt);
  const symbols = {};
  const signals = [];
  const missedSignals = [];
  const baseReasons = [];
  if (!regime.pass || !eligibleTimes.has(signalTime)) baseReasons.push('REGIME_FAILED');

  for (const symbol of policy.symbols) {
    const completed = completedBySymbol[symbol];
    const index = completed.length - 1;
    const signalBar = completed[index];
    const priorEntry = completed.slice(index - policy.entryChannelBars, index);
    const priorLow = priorEntry.length ? Math.min(...priorEntry.map(row => row.low)) : null;
    const theoreticalBar = (seriesBySymbol[symbol] ?? []).find(row => row.openTime === theoreticalOpenAt);
    const distanceToBreakoutBps = priorLow == null ? null : (priorLow - signalBar.close) / signalBar.close * BPS;
    const base = {
      symbol,
      signalTime,
      theoreticalOpenAt,
      theoreticalOpen: theoreticalBar?.open ?? null,
      executablePrice: null,
      schedulerDelayMs,
      breakoutPass: priorLow != null && signalBar.close < priorLow,
      priorEntryChannelLow: priorLow,
      distanceToBreakoutBps
    };
    if (!regime.pass || !eligibleTimes.has(signalTime)) {
      symbols[symbol] = { ...base, status: 'NO_SIGNAL', reasons: ['REGIME_FAILED'] };
      continue;
    }
    if (priorEntry.length !== policy.entryChannelBars) {
      symbols[symbol] = { ...base, status: 'NO_SIGNAL', reasons: ['INSUFFICIENT_BREAKOUT_HISTORY'] };
      continue;
    }
    if (!(signalBar.close < priorLow)) {
      symbols[symbol] = { ...base, status: 'NO_SIGNAL', reasons: ['NO_BREAKOUT'] };
      continue;
    }
    if (schedulerDelayMs > policy.maxSchedulerDelayMs) {
      const missed = { ...base, status: 'MISSED_SIGNAL', reasons: ['SCHEDULER_DELAY_EXCEEDED'] };
      symbols[symbol] = missed;
      missedSignals.push(missed);
      continue;
    }
    const market = marketBySymbol[symbol];
    const book = market?.book ?? market;
    const funding = market?.funding;
    const bookTime = book?.receivedAt ?? market?.receivedAt ?? now;
    const executablePrice = Number(book?.bids?.[0]?.[0]);
    const marketBase = { ...base, executablePrice: Number.isFinite(executablePrice) ? executablePrice : null };
    if (!book?.bids?.length || !book?.asks?.length) {
      symbols[symbol] = { ...marketBase, status: 'NO_SIGNAL', reasons: ['MISSING_EXECUTABLE_DEPTH'] };
      continue;
    }
    if (!funding || !Number.isFinite(Number(funding.fundingRate))) {
      symbols[symbol] = { ...marketBase, status: 'NO_SIGNAL', reasons: ['MISSING_FUNDING_RATE'] };
      continue;
    }
    const atr = atrAt(completed, index, policy.atrBars);
    if (!(atr > 0)) {
      symbols[symbol] = { ...marketBase, status: 'NO_SIGNAL', reasons: ['INVALID_ATR'] };
      continue;
    }
    const entryPrice = executablePrice;
    const expectedFundingBps = estimateFundingCarryBps({
      side: 'SELL',
      fundingRate: funding.fundingRate,
      holdingPeriodMs: policy.maxHoldMs,
      fundingIntervalMs: policy.fundingIntervalMs
    });
    const candidate = {
      hypothesisId: policy.hypothesisId,
      symbol,
      side: 'SELL',
      quantity: policy.researchNotionalUsdt / entryPrice,
      researchNotionalUsdt: policy.researchNotionalUsdt,
      expectedPriceEdgeBps: Math.max(0, distanceToBreakoutBps),
      forecastStandardErrorBps: policy.forecastStandardErrorBps,
      expectedFundingBps,
      fundingStressBps: Math.abs(expectedFundingBps) + policy.fundingStressBufferBps,
      forecastTime: now,
      bookTime,
      decisionTime: now,
      stopPrice: entryPrice + policy.initialStopAtrMultiple * atr,
      expectedExitPrice: null,
      maxHoldMs: policy.maxHoldMs,
      cluster: `H12:${signalTime}`
    };
    const advisory = buildNetEdgeAdvisorySignal({
      candidate,
      book,
      now,
      policy: h12NetEdgePolicy(policy)
    });
    const diagnostic = candidateDiagnostic({
      ...marketBase,
      fundingRate: funding.fundingRate,
      expectedFundingBps,
      fundingHoldingPeriodMs: policy.maxHoldMs,
      bookAgeMs: Math.max(0, now - bookTime),
      atr
    }, advisory);
    symbols[symbol] = diagnostic;
    if (advisory.status !== 'NO_TRADE') {
      signals.push({
        ...advisory,
        experimentId: policy.experimentId,
        hypothesisId: policy.hypothesisId,
        signalTime: signalBar.closeTime,
        decisionTime: now,
        generatedAt: now,
        validUntil: now + policy.signalValidityMs,
        expiresAt: now + Math.min(policy.researchExpiryMs, policy.maxHoldMs),
        entryPrice: advisory.reference.entryPrice,
        stopPrice: advisory.reference.stopPrice,
        schedulerDelayMs,
        bookAgeMs: Math.max(0, now - bookTime),
        theoreticalOpenAt,
        theoreticalOpen: theoreticalBar?.open ?? null,
        executablePrice: advisory.reference.entryPrice,
        signalClose: signalBar.close,
        priorEntryChannelLow: priorLow,
        atr,
        initialExitChannelPrice: Math.max(...completed.slice(index - policy.exitChannelBars, index).map(row => row.high)),
        exitRule: `Stateful dynamic exit: next 4h close above prior ${policy.exitChannelBars}-bar high or initial ${policy.initialStopAtrMultiple} ATR stop, with maximum hold ${policy.maxHoldMs}ms.`,
        funding: {
          rate: funding.fundingRate,
          fundingTime: funding.fundingTime,
          nextFundingTime: funding.nextFundingTime,
          expectedFundingBps,
          fundingCostBps: -expectedFundingBps,
          holdingPeriodMs: policy.maxHoldMs,
          settlementCount: Math.ceil(policy.maxHoldMs / policy.fundingIntervalMs)
        }
      });
    }
  }
  const status = signals.length ? 'SIGNAL' : missedSignals.length ? 'MISSED_SIGNAL' : 'NO_SIGNAL';
  return {
    status,
    signals,
    diagnostics: {
      schemaVersion: 2,
      strategyId: 'H12',
      experimentId: policy.experimentId,
      observedAt: new Date(now).toISOString(),
      decisionTime: new Date(now).toISOString(),
      signalTime,
      theoreticalOpenAt,
      schedulerDelayMs,
      status,
      reasons: [...new Set(baseReasons.concat(missedSignals.length ? ['SCHEDULER_DELAY_EXCEEDED'] : []))],
      regime,
      symbols,
      candidateCount: Object.values(symbols).filter(row => ['ADVISORY', 'OBSERVE', 'NO_TRADE'].includes(row.status)).length,
      signalCount: signals.length,
      missedCount: missedSignals.length,
      authorizationMode: 'PAPER_ONLY',
      liveOrdersEnabled: false
    }
  };
}

export function detectLiveH12Signals(seriesBySymbol, options = {}) {
  return evaluateLiveH12Scan(seriesBySymbol, options).signals;
}

export function h12ScanDiagnosticRecord(diagnostics, { serviceName = 'vercel-h12-worker' } = {}) {
  return {
    scan_key: `H12:${diagnostics.signalTime}:${diagnostics.status}`,
    service_name: serviceName,
    strategy_id: diagnostics.strategyId,
    experiment_id: diagnostics.experimentId,
    observed_at: diagnostics.observedAt,
    decision_at: diagnostics.decisionTime,
    signal_time: new Date(diagnostics.signalTime).toISOString(),
    theoretical_open_at: new Date(diagnostics.theoreticalOpenAt).toISOString(),
    scheduler_delay_ms: diagnostics.schedulerDelayMs,
    status: diagnostics.status,
    regime_pass: diagnostics.regime.pass,
    breadth: diagnostics.regime.breadth,
    btc_fast_sma: diagnostics.regime.btcFastSma,
    btc_slow_sma: diagnostics.regime.btcSlowSma,
    candidate_count: diagnostics.candidateCount,
    signal_count: diagnostics.signalCount,
    missed_count: diagnostics.missedCount,
    reasons: diagnostics.reasons,
    regime: diagnostics.regime,
    symbols: diagnostics.symbols,
    details: { schemaVersion: diagnostics.schemaVersion },
    authorization_mode: 'PAPER_ONLY',
    live_orders_enabled: false
  };
}

export function h12AdvisoryBundle(signal, { generatedAt = Date.now() } = {}) {
  const costs = signal.costs ?? {};
  const funding = signal.funding ?? {};
  const decisionTime = signal.decisionTime ?? signal.entryTime ?? generatedAt;
  const signalTime = signal.signalTime ?? decisionTime;
  const theoreticalOpenAt = signal.theoreticalOpenAt ?? signal.entryTime ?? decisionTime;
  const expiresAt = signal.expiresAt ?? decisionTime + H12_CONFIG.researchExpiryMs;
  return {
    kind: 'advisory_bundle',
    record: {
      advisory: {
        advisory_id: randomUUID(),
        experiment_id: signal.experimentId,
        symbol: signal.symbol,
        advisory_type: signal.action,
        alert_level: signal.alertLevel,
        signal_at: new Date(signalTime).toISOString(),
        decision_at: new Date(decisionTime).toISOString(),
        expires_at: new Date(expiresAt).toISOString(),
        scheduler_delay_ms: signal.schedulerDelayMs,
        theoretical_open: signal.theoreticalOpen,
        executable_price: signal.executablePrice ?? signal.reference?.entryPrice,
        reference_bid: signal.reference?.bidPrice ?? null,
        reference_ask: signal.reference?.askPrice ?? null,
        entry_reference: signal.reference?.entryPrice,
        stop_reference: signal.reference?.stopPrice,
        exit_reference: null,
        gross_edge_bps: costs.expectedGrossEdgeBps ?? null,
        funding_edge_bps: costs.expectedFundingBps ?? funding.expectedFundingBps ?? null,
        holding_period_ms: funding.holdingPeriodMs ?? signal.reference?.maximumHoldMs ?? null,
        funding_cost_bps: funding.fundingCostBps ?? null,
        funding_event_count: funding.settlementCount ?? null,
        fee_bps: costs.feeBps ?? 0,
        spread_bps: costs.spreadBps ?? 0,
        slippage_bps: costs.slippageBps ?? 0,
        impact_bps: costs.impactBps ?? 0,
        latency_buffer_bps: costs.latencyBufferBps ?? 0,
        uncertainty_bps: costs.uncertaintyPenaltyBps ?? 0,
        conservative_net_edge_bps: costs.conservativeNetEdgeBps ?? null,
        status: 'ACTIVE',
        pnl_eligible: false,
        authorization_mode: 'PAPER_ONLY',
        live_orders_enabled: false,
        dedupe_key: `${signal.experimentId}:${signal.symbol}:${signal.side}:${signalTime}`,
        metadata: {
          source: 'vercel-h12-worker',
          modelId: 'HENGYU-NET-EDGE-001',
          hypothesisId: signal.hypothesisId,
          generatedAt: new Date(generatedAt).toISOString(),
          signalTime: new Date(signalTime).toISOString(),
          decisionTime: new Date(decisionTime).toISOString(),
          theoreticalOpenAt: new Date(theoreticalOpenAt).toISOString(),
          theoreticalOpen: signal.theoreticalOpen,
          executablePrice: signal.executablePrice,
          schedulerDelayMs: signal.schedulerDelayMs,
          bookAgeMs: signal.bookAgeMs,
          signalClose: signal.signalClose,
          priorEntryChannelLow: signal.priorEntryChannelLow,
          atr: signal.atr,
          initialExitChannelPrice: signal.initialExitChannelPrice,
          exitRule: signal.exitRule,
          reviewModel: 'DYNAMIC_DONCHIAN_NOT_FIXED_TP_SL',
          statefulExit: true,
          historicalValidation: { experimentId: 'HY-EXP-0018', pass: false },
          funding: {
            ...funding,
            holdingPeriodMs: funding.holdingPeriodMs ?? signal.reference?.maximumHoldMs ?? null
          },
          reasons: signal.reasons
        }
      },
      email: {
        requested: ['STRONG', 'MEDIUM'].includes(signal.alertLevel),
        manual_only: true,
        order_placement: false,
        account_access: false
      }
    }
  };
}
