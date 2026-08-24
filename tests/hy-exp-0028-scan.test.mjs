import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import handler, { runHyExp0028Scan } from '../api/hy-exp-0028-scan.mjs';
import {
  EMAIL_SIGNAL_CUTOVER_CONFIG,
  isEmailSignalCutoverConfigValid
} from '../src/model/email-signal-cutover.mjs';
import {
  buildHyExp0028Candidates
} from '../src/model/hy-exp-0028-email-signal.mjs';
import {
  HY_EXP_0028_PUBLIC_MARKET_ENDPOINTS,
  fetchHyExp0028LiveEntryBar
} from '../src/model/hy-exp-0028-market-data.mjs';
import { HY_EXP_0028_FROZEN_Q75, HY_EXP_0028_SYMBOLS } from '../src/validation/hy-val-0028-001.mjs';

const HOUR = 60 * 60 * 1_000;
const FOUR_HOURS = 4 * HOUR;
const SIGNAL_INDEX = 720;
const NOW = Date.parse('2026-08-24T12:00:00.000Z');
const SIGNAL_TIME = NOW - 11 * HOUR;
const FIXTURE_START = SIGNAL_TIME - (SIGNAL_INDEX + 1) * HOUR;

function releasedConfig() {
  return {
    ...EMAIL_SIGNAL_CUTOVER_CONFIG,
    status: 'CUTOVER_RELEASED',
    releaseState: 'EMAIL_SIGNAL_RELEASED'
  };
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(body); }
  };
}

function signalCloseForDistance(distance) {
  return (1_600 + 105 * distance) / (20 - distance);
}

function makeProductionDataset(distance = 15) {
  const signalClose = signalCloseForDistance(distance);
  const bars1h = Array.from({ length: SIGNAL_INDEX + 1 }, (_, index) => {
    const openTime = FIXTURE_START + index * HOUR;
    if (index === SIGNAL_INDEX) {
      return { openTime, closeBoundary: openTime + HOUR, open: signalClose, high: signalClose, low: signalClose, close: signalClose };
    }
    return { openTime, closeBoundary: openTime + HOUR, open: 85, high: 90, low: 80, close: 85 };
  });
  const bars4h = Array.from({ length: 180 }, (_, index) => {
    const close = index < 120 ? 90 : 110;
    const openTime = FIXTURE_START + index * FOUR_HOURS;
    return { openTime, closeBoundary: openTime + FOUR_HOURS, open: close, high: close + 1, low: close - 1, close, quoteVolume: 1_000 };
  });
  return {
    bars1hBySymbol: Object.fromEntries(HY_EXP_0028_SYMBOLS.map(symbol => [
      symbol, bars1h.map(row => ({ ...row, symbol }))
    ])),
    bars4hBySymbol: Object.fromEntries(HY_EXP_0028_SYMBOLS.map(symbol => [
      symbol, bars4h.map(row => ({ ...row, symbol }))
    ]))
  };
}

function makeEntryBar(symbol, targetOpen, changes = {}) {
  return {
    symbol,
    source: 'CONTRACT_PRICE',
    openTime: targetOpen,
    open: 100,
    receivedAt: targetOpen + 30_000,
    ...changes
  };
}

function runnerFixture({ distance = 15, entryChanges = {} } = {}) {
  const causal = makeProductionDataset(distance);
  const runNow = SIGNAL_TIME + 5 * 60 * 1_000 + 30_000;
  const fetchCausal = async () => causal;
  const fetchEntry = async (symbol, targetOpen) => makeEntryBar(symbol, targetOpen, entryChanges);
  return { causal, runNow, fetchCausal, fetchEntry };
}

function mockResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name] = value; },
    end(value) { this.body = value; }
  };
}

test('cutover release states are canonical pairs and current config remains READY/DRAFT', () => {
  assert.equal(isEmailSignalCutoverConfigValid(), true);
  assert.equal(isEmailSignalCutoverConfigValid({
    ...EMAIL_SIGNAL_CUTOVER_CONFIG,
    releaseState: 'EMAIL_SIGNAL_RELEASED'
  }), false);
  assert.equal(isEmailSignalCutoverConfigValid(releasedConfig()), true);
  assert.equal(EMAIL_SIGNAL_CUTOVER_CONFIG.releaseState, 'EMAIL_SIGNAL_RELEASE_READY');
  assert.equal(EMAIL_SIGNAL_CUTOVER_CONFIG.status, 'DRAFT_CUTOVER_PREPARED');
});

test('current READY runner is a release-gated no-op before market data and email work', async () => {
  let marketCalls = 0;
  let ingestCalls = 0;
  let dispatchCalls = 0;
  const result = await runHyExp0028Scan({
    causalInputFetcher: async () => { marketCalls += 1; return makeProductionDataset(); },
    ingestImpl: async () => { ingestCalls += 1; },
    dispatchImpl: async () => { dispatchCalls += 1; }
  });
  assert.deepEqual(result, {
    ok: true,
    noOp: true,
    reason: 'EMAIL_STRATEGY_NOT_RELEASED',
    marketDataFetched: false,
    candidates: 0,
    advisories: 0,
    outbox: 0,
    smtpDispatched: 0,
    paperOnly: true,
    signalOnly: true
  });
  assert.equal(marketCalls, 0);
  assert.equal(ingestCalls, 0);
  assert.equal(dispatchCalls, 0);
});

test('synthetic RELEASED runner uses frozen candidate, advisory, outbox, and dispatch path', async () => {
  const fixture = runnerFixture();
  const seen = new Set();
  const ingested = [];
  let dispatchCalls = 0;
  const ingest = async ({ advisory }) => {
    const key = `${advisory.symbol}:${advisory.metadata.decisionTime}`;
    const duplicate = seen.has(key);
    seen.add(key);
    ingested.push({ key, duplicate });
    return { duplicate, advisoryId: advisory.advisory_id, email: { queued: !duplicate, duplicate } };
  };
  const result = await runHyExp0028Scan({
    config: releasedConfig(),
    clock: () => fixture.runNow,
    causalInputFetcher: fixture.fetchCausal,
    entryBarFetcher: fixture.fetchEntry,
    ingestImpl: ingest,
    dispatchImpl: async () => { dispatchCalls += 1; return [{ status: 'SENT' }]; }
  });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'ADVISORIES_PROCESSED');
  assert.equal(result.candidates, 8);
  assert.equal(result.advisories, 8);
  assert.equal(result.outbox, 8);
  assert.equal(result.smtpDispatched, 1);
  assert.equal(dispatchCalls, 1);
  assert.equal(ingested.length, 8);
  assert.equal(new Set(ingested.map(row => row.key)).size, 8);
});

test('same symbol and decision invoked twice creates one actionable advisory and outbox row', async () => {
  const fixture = runnerFixture();
  const seen = new Set();
  let actionable = 0;
  const ingest = async ({ advisory }) => {
    const key = `${advisory.symbol}:${advisory.metadata.decisionTime}`;
    if (seen.has(key)) return { duplicate: true, email: { queued: false, duplicate: true } };
    seen.add(key);
    actionable += 1;
    return { duplicate: false, email: { queued: true, duplicate: false } };
  };
  const options = {
    config: releasedConfig(),
    clock: () => fixture.runNow,
    causalInputFetcher: fixture.fetchCausal,
    entryBarFetcher: fixture.fetchEntry,
    ingestImpl: ingest,
    dispatchImpl: async () => []
  };
  const first = await runHyExp0028Scan(options);
  const second = await runHyExp0028Scan(options);
  assert.equal(first.outbox, 8);
  assert.equal(second.outbox, 0);
  assert.equal(actionable, 8);
  assert.equal(seen.size, 8);
});

test('no Rule A candidate or causal gap produces no email', async () => {
  const sideways = runnerFixture({ distance: 0 });
  let entryCalls = 0;
  const noCandidate = await runHyExp0028Scan({
    config: releasedConfig(),
    clock: () => sideways.runNow,
    causalInputFetcher: sideways.fetchCausal,
    entryBarFetcher: async () => { entryCalls += 1; return null; },
    ingestImpl: async () => { throw new Error('must not ingest'); },
    dispatchImpl: async () => { throw new Error('must not dispatch'); }
  });
  assert.equal(noCandidate.reason, 'NO_CANDIDATE');
  assert.equal(entryCalls, 0);

  const gapped = makeProductionDataset();
  gapped.bars1hBySymbol.BTCUSDT.splice(100, 1);
  const gap = await runHyExp0028Scan({
    config: releasedConfig(),
    clock: () => sideways.runNow,
    causalInputFetcher: async () => gapped,
    entryBarFetcher: async () => { throw new Error('must not fetch entry'); },
    ingestImpl: async () => { throw new Error('must not ingest'); }
  });
  assert.equal(gap.reason, 'NO_CANDIDATE');
  assert.match(gap.rejections[0].rejection, /CAUSAL_1H_GAP/);
});

test('stale or later entry observations never become email advisories', async () => {
  for (const entryChanges of [
    { receivedAt: SIGNAL_TIME + 5 * 60 * 1_000 + 90_001 },
    { openTime: SIGNAL_TIME + 15 * 60 * 1_000 },
    { source: 'MARK_PRICE' }
  ]) {
    const fixture = runnerFixture({ entryChanges });
    let ingestCalls = 0;
    const result = await runHyExp0028Scan({
      config: releasedConfig(),
      clock: () => fixture.runNow + 90_001,
      causalInputFetcher: fixture.fetchCausal,
      entryBarFetcher: fixture.fetchEntry,
      ingestImpl: async () => { ingestCalls += 1; },
      dispatchImpl: async () => []
    });
    assert.equal(result.advisories, 0);
    assert.equal(result.outbox, 0);
    assert.equal(ingestCalls, 0);
  }
});

test('target live entry admission is independent of future 5m high/low/close', async () => {
  const fixture = runnerFixture({ entryChanges: {
    high: Number.MAX_VALUE,
    low: 0.01,
    close: Number.MAX_VALUE,
    finalClosed: false
  } });
  let ingestCalls = 0;
  const result = await runHyExp0028Scan({
    config: releasedConfig(),
    clock: () => fixture.runNow,
    causalInputFetcher: fixture.fetchCausal,
    entryBarFetcher: fixture.fetchEntry,
    ingestImpl: async () => { ingestCalls += 1; return { email: { queued: true } }; },
    dispatchImpl: async () => []
  });
  assert.equal(result.advisories, 8);
  assert.equal(ingestCalls, 8);
});

test('runner authentication rejects missing and wrong internal credentials before scanning', async () => {
  for (const headers of [{}, { authorization: 'Bearer wrong' }]) {
    const res = mockResponse();
    let runCalls = 0;
    await handler({ method: 'GET', headers }, res, {
      authorizeImpl: async () => false,
      runImpl: async () => { runCalls += 1; return { ok: true }; }
    });
    assert.equal(res.statusCode, 401);
    assert.match(res.body, /unauthorized/);
    assert.equal(runCalls, 0);
  }
});

test('bounded entry fetch uses only exact public contract-price 5m REST target and never rescues later bars', async () => {
  const target = Date.parse('2026-08-24T12:05:00.000Z');
  const urls = [];
  const entry = await fetchHyExp0028LiveEntryBar('BTCUSDT', target, {
    clock: () => target + 30_000,
    fetchImpl: async url => {
      urls.push(String(url));
      return response(200, [[target, '100', '101', '99', '100', '1', target + 5 * 60_000 - 1, '1000', 1]]);
    },
    sleepImpl: async () => {}
  });
  assert.equal(entry.openTime, target);
  assert.equal(entry.source, 'CONTRACT_PRICE');
  assert.equal(urls.length, 1);
  assert.match(urls[0], /fapi\.binance\.com\/fapi\/v1\/klines/);
  assert.match(urls[0], /interval=5m/);
  assert.match(urls[0], /startTime=1787573100000/);
  assert.match(urls[0], /limit=1/);
  assert.deepEqual(HY_EXP_0028_PUBLIC_MARKET_ENDPOINTS, ['https://fapi.binance.com/fapi/v1/klines']);
  assert.doesNotMatch(JSON.stringify(HY_EXP_0028_PUBLIC_MARKET_ENDPOINTS), /account|order|position|private|fapi\/v2/);
});

test('prepared scheduler is separate, inactive, and has no HY-EXP-0028 migration applied', () => {
  const scheduler = JSON.parse(fs.readFileSync('config/hy-exp-0028-scheduler.json', 'utf8'));
  assert.equal(scheduler.schedule, '5 * * * *');
  assert.equal(scheduler.activated, false);
  assert.equal(scheduler.applied, false);
  assert.equal(scheduler.supabaseMigrationApplied, false);
  assert.equal(scheduler.separateFrom, 'HY-DATA-0001 job #35');
  assert.equal(scheduler.endpoint, '/api/hy-exp-0028-scan');
  assert.equal(fs.readdirSync('supabase/migrations').some(name => name.includes('hy_exp_0028')), false);
  const dataWorkflow = fs.readFileSync('.github/workflows/hy-data-0001-collector.yml', 'utf8');
  assert.match(dataWorkflow, /hy-data-0001/);
  assert.doesNotMatch(dataWorkflow, /hy-exp-0028-scan/);
});

test('runner is paper-only and never exposes order, account, or automatic trading controls', () => {
  assert.equal(EMAIL_SIGNAL_CUTOVER_CONFIG.safety.signal_only, true);
  assert.equal(EMAIL_SIGNAL_CUTOVER_CONFIG.safety.authorization_mode, 'PAPER_ONLY');
  assert.equal(EMAIL_SIGNAL_CUTOVER_CONFIG.safety.live_orders_enabled, false);
  assert.equal(EMAIL_SIGNAL_CUTOVER_CONFIG.safety.account_api, false);
  assert.equal(EMAIL_SIGNAL_CUTOVER_CONFIG.safety.order_api, false);
  assert.equal(EMAIL_SIGNAL_CUTOVER_CONFIG.safety.automatic_trading, false);
  assert.equal(HY_EXP_0028_FROZEN_Q75 > 0, true);
});
