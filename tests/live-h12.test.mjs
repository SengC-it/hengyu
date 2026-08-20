import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectLiveH12Signals,
  evaluateLiveH12Scan,
  fetchLiveH12Market,
  fetchLiveH12Series,
  h12AdvisoryBundle,
  h12ScanDiagnosticRecord,
  H12_PRODUCTION_POLICY,
  normalizeH12Scheduler
} from '../src/model/live-h12.mjs';

function fallingSeries(symbol, { breakout = false } = {}) {
  const step = 4 * 60 * 60 * 1000;
  return Array.from({ length: 182 }, (_, index) => {
    const base = 300 - index;
    const close = breakout && index === 180 ? base - 2 : base;
    return {
      symbol, openTime: index * step, closeTime: (index + 1) * step - 1,
      open: base + 0.5, high: base + 1, low: base - 1, close
    };
  });
}

function marketBySymbol() {
  return Object.fromEntries(H12_PRODUCTION_POLICY.symbols.map(symbol => [symbol, {
    book: {
      bids: [[100, 1_000], [99.99, 1_000]],
      asks: [[100.01, 1_000], [100.02, 1_000]],
      receivedAt: 181 * 4 * 60 * 60 * 1000
    },
    receivedAt: 181 * 4 * 60 * 60 * 1000,
    funding: { fundingRate: 0, nextFundingTime: 182 * 4 * 60 * 60 * 1000, markPrice: 100 }
  }]));
}

test('live H12 keeps the breakout as a Candidate until an independently verified edge exists', () => {
  const series = Object.fromEntries(H12_PRODUCTION_POLICY.symbols.map(symbol => [
    symbol, fallingSeries(symbol, { breakout: symbol === 'BTCUSDT' })
  ]));
  const evaluated = evaluateLiveH12Scan(series, {
    now: 181 * 4 * 60 * 60 * 1000 + 1,
    marketBySymbol: marketBySymbol(),
    policy: { ...H12_PRODUCTION_POLICY, forecastStandardErrorBps: 1 }
  });
  const candidate = evaluated.diagnostics.symbols.BTCUSDT;
  assert.equal(evaluated.signals.length, 0);
  assert.equal(evaluated.status, 'NO_SIGNAL');
  assert.equal(candidate.status, 'NO_TRADE');
  assert.equal(candidate.candidate.side, 'SELL');
  assert.equal(candidate.entryPrice, undefined);
  assert.equal(candidate.executablePrice, 100);
  assert.notEqual(candidate.executablePrice, candidate.theoreticalOpen);
  assert.equal(candidate.candidate.expectedPriceEdgeBps, null);
  assert.equal(candidate.candidate.edgeSource, 'UNVERIFIED');
  assert.equal(candidate.candidate.edgeModelId, null);
  assert.ok(candidate.reasons.includes('EDGE_UNVERIFIED'));
  assert.ok(candidate.reasons.includes('unverified_price_edge'));
  assert.equal(candidate.netEdge.feeBps, 10);
  assert.equal(candidate.expectedFundingBps, 0);
  assert.ok(candidate.atr > 0);
});

test('H12 marks a delayed breakout MISSED_SIGNAL instead of emitting a tradeable advisory', () => {
  const series = Object.fromEntries(H12_PRODUCTION_POLICY.symbols.map(symbol => [
    symbol, fallingSeries(symbol, { breakout: symbol === 'BTCUSDT' })
  ]));
  const theoreticalOpenAt = 181 * 4 * 60 * 60 * 1000;
  const evaluated = detectLiveH12Signals(series, {
    now: theoreticalOpenAt + 101,
    marketBySymbol: marketBySymbol(),
    policy: {
      ...H12_PRODUCTION_POLICY,
      maxSchedulerDelayMs: 100,
      forecastStandardErrorBps: 1
    }
  });
  assert.equal(evaluated.length, 0);
  const diagnostics = evaluateLiveH12Scan(series, {
    now: theoreticalOpenAt + 101,
    scanStartedAt: theoreticalOpenAt,
    marketBySymbol: marketBySymbol(),
    policy: { ...H12_PRODUCTION_POLICY, maxSchedulerDelayMs: 100, forecastStandardErrorBps: 1 }
  }).diagnostics;
  assert.equal(diagnostics.status, 'MISSED_SIGNAL');
  assert.equal(diagnostics.symbols.BTCUSDT.status, 'MISSED_SIGNAL');
  assert.ok(diagnostics.symbols.BTCUSDT.reasons.includes('SCHEDULER_DELAY_EXCEEDED'));
});

test('H12 records NO_SIGNAL reasons and Net Edge rejection without emitting an advisory', () => {
  const noBreakoutSeries = Object.fromEntries(H12_PRODUCTION_POLICY.symbols.map(symbol => [
    symbol, fallingSeries(symbol)
  ]));
  const noBreakout = evaluateLiveH12Scan(noBreakoutSeries, {
    now: 181 * 4 * 60 * 60 * 1000 + 1,
    marketBySymbol: marketBySymbol()
  });
  assert.equal(noBreakout.status, 'NO_SIGNAL');
  assert.equal(noBreakout.signals.length, 0);
  assert.ok(noBreakout.diagnostics.symbols.BTCUSDT.reasons.includes('NO_BREAKOUT'));

  const breakoutSeries = Object.fromEntries(H12_PRODUCTION_POLICY.symbols.map(symbol => [
    symbol, fallingSeries(symbol, { breakout: symbol === 'BTCUSDT' })
  ]));
  const rejected = evaluateLiveH12Scan(breakoutSeries, {
    now: 181 * 4 * 60 * 60 * 1000 + 1,
    marketBySymbol: marketBySymbol(),
    policy: { ...H12_PRODUCTION_POLICY, forecastStandardErrorBps: 1_000 }
  });
  assert.equal(rejected.status, 'NO_SIGNAL');
  assert.equal(rejected.signals.length, 0);
  assert.equal(rejected.diagnostics.symbols.BTCUSDT.status, 'NO_TRADE');
  assert.ok(rejected.diagnostics.symbols.BTCUSDT.reasons.includes('insufficient_conservative_net_edge'));
});

test('H12 production bundle remains paper-only and declares dynamic exit', () => {
  const bundle = h12AdvisoryBundle({
    signalId: 'H12:BTCUSDT:SELL:1', experimentId: 'HY-EXP-0018', symbol: 'BTCUSDT', side: 'SELL',
    alertLevel: 'MEDIUM', signalTime: 1, entryTime: 2, decisionTime: 3, expiresAt: 4_000,
     theoreticalOpenAt: 2, theoreticalOpen: 100, executablePrice: 100,
     entryPrice: 100,
     stopPrice: 105, signalClose: 99, priorEntryChannelLow: 100, atr: 2.5,
    initialExitChannelPrice: 110, exitRule: 'dynamic rule',
    edgeSource: 'UNVERIFIED', edgeModelId: null,
    funding: {
      expectedFundingBps: 5, fundingCostBps: -5, fundingProjectionMs: 86_400_000,
      holdingPeriodMs: null, settlementCount: null
    }
  }, { generatedAt: 3 });
  assert.equal(bundle.record.advisory.live_orders_enabled, false);
  assert.equal(bundle.record.advisory.authorization_mode, 'PAPER_ONLY');
  assert.equal(bundle.record.advisory.exit_reference, null);
  assert.equal(bundle.record.advisory.holding_period_ms, null);
  assert.equal(bundle.record.advisory.funding_projection_ms, 86_400_000);
  assert.equal(bundle.record.advisory.edge_source, 'UNVERIFIED');
  assert.equal(bundle.record.advisory.edge_model_id, null);
  assert.equal(bundle.record.advisory.funding_cost_bps, -5);
  assert.equal(bundle.record.advisory.funding_event_count, null);
  assert.equal(bundle.record.advisory.dedupe_key, 'HY-EXP-0018:BTCUSDT:SELL:1');
  assert.equal(bundle.record.advisory.metadata.reviewModel, 'DYNAMIC_DONCHIAN_NOT_FIXED_TP_SL');
  assert.equal(bundle.record.advisory.metadata.source, 'vercel-h12-worker');
  assert.equal(bundle.record.advisory.metadata.funding.holdingPeriodMs, null);
  assert.equal(H12_PRODUCTION_POLICY.maxHoldMs, undefined);
});

test('H12 sets decisionTime after delayed market fetches and never rejects normal data as future', async () => {
  const step = 4 * 60 * 60 * 1000;
  const scanStartedAt = Date.now();
  const baseTime = scanStartedAt - 181 * step - 1;
  const rowsFor = symbol => fallingSeries(symbol, { breakout: symbol === 'BTCUSDT' })
    .map(row => [
      row.openTime + baseTime,
      row.open,
      row.high,
      Math.min(row.low, row.close),
      row.close,
      '1',
      row.closeTime + baseTime
    ]);
  const fetchImpl = async url => {
    await new Promise(resolve => setTimeout(resolve, url.pathname.endsWith('/klines') ? 5 : 10));
    return {
      ok: true,
      status: 200,
      async json() {
        if (url.pathname.endsWith('/klines')) return rowsFor(url.searchParams.get('symbol'));
        if (url.pathname.endsWith('/depth')) {
          return { bids: [['100', '1000']], asks: [['100.01', '1000']], E: Date.now() };
        }
        return { lastFundingRate: '0', nextFundingTime: Date.now() + 8 * 60 * 60 * 1000, markPrice: '100' };
      }
    };
  };
  const pairs = await Promise.all(H12_PRODUCTION_POLICY.symbols.map(async symbol => ({
    symbol,
    series: await fetchLiveH12Series(symbol, { fetchImpl }),
    market: await fetchLiveH12Market(symbol, { fetchImpl })
  })));
  const decisionTime = Date.now();
  const marketBySymbolResult = Object.fromEntries(pairs.map(row => [row.symbol, row.market]));
  for (const market of Object.values(marketBySymbolResult)) {
    assert.ok(market.book.receivedAt <= decisionTime);
    assert.ok(market.funding.receivedAt <= decisionTime);
  }
  const evaluated = evaluateLiveH12Scan(
    Object.fromEntries(pairs.map(row => [row.symbol, row.series])),
    {
      marketBySymbol: marketBySymbolResult,
      now: decisionTime,
      scanStartedAt,
      schedulerSource: 'github-actions-h12-5m',
      schedulerAttempt: 2,
      policy: { ...H12_PRODUCTION_POLICY, forecastStandardErrorBps: 1 }
    }
  );
  assert.equal(Date.parse(evaluated.diagnostics.scanStartedAt), scanStartedAt);
  assert.equal(Date.parse(evaluated.diagnostics.decisionTime), decisionTime);
  assert.ok(decisionTime >= scanStartedAt);
  assert.equal(evaluated.diagnostics.schedulerSource, 'github-actions-h12-5m');
  assert.equal(evaluated.diagnostics.schedulerAttempt, 2);
  assert.ok(!evaluated.diagnostics.reasons.includes('future_timestamp'));
  assert.ok(!Object.values(evaluated.diagnostics.symbols).some(row => row.reasons?.includes('future_timestamp')));
  const record = h12ScanDiagnosticRecord(evaluated.diagnostics, { serviceName: 'github-actions-h12-worker' });
  assert.equal(record.scan_started_at, evaluated.diagnostics.scanStartedAt);
  assert.equal(record.scheduler_source, 'github-actions-h12-5m');
  assert.equal(record.scheduler_attempt, 2);
  assert.match(record.scan_key, /H12:HY-EXP-0018:/);
});

test('H12 scheduler source and attempt are validated for idempotent retries', () => {
  assert.equal(H12_PRODUCTION_POLICY.maxSchedulerDelayMs, 900_000);
  assert.deepEqual(normalizeH12Scheduler({ source: 'github-actions-h12-5m', attempt: '3' }), {
    source: 'github-actions-h12-5m', attempt: 3
  });
  assert.throws(() => normalizeH12Scheduler({ source: 'github actions', attempt: 1 }), /invalid scheduler source/);
  assert.throws(() => normalizeH12Scheduler({ source: 'direct', attempt: 0 }), /invalid scheduler attempt/);
});

test('live H12 falls back to the next official Binance futures endpoint', async () => {
  const calls = [];
  const rows = [[0, '100', '102', '98', '101', '1', 14_399_999]];
  const fetchImpl = async url => {
    calls.push(url.hostname);
    if (calls.length === 1) return { ok: false, status: 451, text: async () => '' };
    return { ok: true, status: 200, text: async () => JSON.stringify(rows) };
  };
  const series = await fetchLiveH12Series('BTCUSDT', { fetchImpl });
  assert.deepEqual(calls, ['fapi.binance.com', 'fapi1.binance.com']);
  assert.equal(series[0].symbol, 'BTCUSDT');
  assert.equal(series[0].close, 101);
});
