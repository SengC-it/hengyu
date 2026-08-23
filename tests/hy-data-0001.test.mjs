import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  buildHyData0001HealthReport,
  buildHyData0001Urls,
  collectHyData0001Cycle,
  enumerateHyData0001MissingIntervals,
  fetchJsonCompleted,
  HY_DATA_0001_EXPECTED_ROWS_PER_DAY,
  HY_DATA_0001_PUBLIC_BASE,
  HY_DATA_0001_SAFETY,
  HY_DATA_0001_SYMBOLS,
  isPublicHyData0001Endpoint,
  normalizeHyData0001Observation,
  resolveHyData0001SourceCommit,
  toHyData0001ObservationRow,
  verifyHyData0001RequestSignature
} from '../src/model/hy-data-0001.mjs';

const ROOT = path.resolve('.');
const BASE = 2_000_000_100_000;
const ACTIVATION = BASE - 600_000;
const OBSERVATION = BASE - 300_000;

function restResponse(payload, requestStartedAt = BASE, receivedAt = BASE + 100) {
  return { payload, requestStartedAt, receivedAt, url: 'https://fapi.binance.com/fapi/v1/test' };
}

function validPayloads({ barOpenTime = OBSERVATION, barCloseTime = BASE - 1 } = {}) {
  return {
    premiumIndex: restResponse({
      symbol: 'BTCUSDT',
      markPrice: '100',
      indexPrice: '99.9',
      lastFundingRate: '0.0002',
      nextFundingTime: String(BASE + 28_799_900),
      time: BASE
    }),
    openInterest: restResponse({ symbol: 'BTCUSDT', openInterest: '1000', time: BASE }),
    depth: restResponse({
      lastUpdateId: 123,
      bids: [['99.9', '2'], ['99.8', '1']],
      asks: [['100.1', '3'], ['100.2', '1']]
    }),
    fundingRate: restResponse([{ symbol: 'BTCUSDT', fundingRate: '0.0001', fundingTime: BASE }]),
    klines: restResponse([[
      barOpenTime,
      '99',
      '101',
      '98',
      '100',
      '10',
      barCloseTime,
      '1000',
      20,
      '6',
      '600',
      '0'
    ]])
  };
}

function response(payload, bodyDelayMs = 0) {
  return {
    ok: true,
    status: 200,
    async text() {
      if (bodyDelayMs) await new Promise(resolve => setTimeout(resolve, bodyDelayMs));
      return JSON.stringify(payload);
    }
  };
}

test('fixed universe and public endpoints contain no private market APIs', () => {
  assert.deepEqual(HY_DATA_0001_SYMBOLS, [
    'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT',
    'XRPUSDT', 'DOGEUSDT', 'LINKUSDT', 'LTCUSDT'
  ]);
  const urls = buildHyData0001Urls('BTCUSDT');
  for (const url of Object.values(urls)) {
    assert.equal(isPublicHyData0001Endpoint(url), true);
    assert.equal(url.startsWith(HY_DATA_0001_PUBLIC_BASE), true);
    assert.doesNotMatch(url, /\/(?:order|account|position|listenKey|leverage|margin)\b/i);
  }
  assert.equal(HY_DATA_0001_EXPECTED_ROWS_PER_DAY, 2304);
});

test('REST receivedAt is captured after the response body completes', async () => {
  let bodyCompletedAt = 0;
  const result = await fetchJsonCompleted({
    url: `${HY_DATA_0001_PUBLIC_BASE}/openInterest?symbol=BTCUSDT`,
    fetchImpl: async () => response({ symbol: 'BTCUSDT', openInterest: '1', time: BASE }, 25)
  });
  bodyCompletedAt = Date.now();
  assert.equal(result.bodyCompleted, true);
  assert.ok(result.receivedAt >= result.requestStartedAt);
  assert.ok(result.receivedAt <= bodyCompletedAt);
});

test('normalization keeps raw and normalized causal derivatives fields', () => {
  const observation = normalizeHyData0001Observation({
    symbol: 'BTCUSDT',
    payloads: validPayloads(),
    collectorActivatedAt: ACTIVATION,
    observationAt: OBSERVATION
  });
  assert.equal(observation.isValid, true);
  assert.equal(observation.symbol, 'BTCUSDT');
  assert.equal(observation.markPrice, 100);
  assert.equal(observation.indexPrice, 99.9);
  assert.equal(observation.currentFundingRate, 0.0002);
  assert.equal(observation.lastSettledFundingRate, 0.0001);
  assert.equal(observation.lastSettledFundingTime, new Date(BASE).toISOString());
  assert.equal(observation.openInterest, 1000);
  assert.equal(observation.bestBid, 99.9);
  assert.equal(observation.bestAsk, 100.1);
  assert.equal(observation.barTradeCount, 20);
  assert.equal(observation.takerBuyRatio, 0.6);
  assert.ok(observation.premiumBasisBps > 0);
  assert.equal(observation.rawValues.klines[0][0], OBSERVATION);
  assert.equal(observation.sourceTimestamps.klines.barCloseTime, new Date(BASE - 1).toISOString());
  assert.equal(observation.receivedAt, new Date(BASE + 100).toISOString());
});

test('idempotency key is symbol plus five-minute observation timestamp', () => {
  const first = normalizeHyData0001Observation({
    symbol: 'BTCUSDT', payloads: validPayloads(), collectorActivatedAt: ACTIVATION, observationAt: OBSERVATION
  });
  const second = normalizeHyData0001Observation({
    symbol: 'BTCUSDT', payloads: validPayloads(), collectorActivatedAt: ACTIVATION, observationAt: OBSERVATION
  });
  const firstRow = toHyData0001ObservationRow(first);
  const secondRow = toHyData0001ObservationRow(second);
  assert.equal(firstRow.idempotency_key, secondRow.idempotency_key);
  assert.equal(firstRow.idempotency_key, `BTCUSDT:${new Date(OBSERVATION).toISOString()}`);
});

test('pre-activation observations and bars are invalid, with no historical backfill', () => {
  const observation = normalizeHyData0001Observation({
    symbol: 'BTCUSDT',
    payloads: validPayloads({ barOpenTime: ACTIVATION - 300_000, barCloseTime: ACTIVATION - 1 }),
    collectorActivatedAt: ACTIVATION,
    observationAt: ACTIVATION - 300_000
  });
  assert.equal(observation.isValid, false);
  assert.ok(observation.qualityFlags.includes('PRE_ACTIVATION_OBSERVATION'));
  assert.ok(observation.qualityFlags.includes('PRE_ACTIVATION_BAR'));
  assert.equal(observation.barOpen, 99);
});

test('a pre-activation settled funding event does not invalidate a live post-activation observation', () => {
  const payloads = validPayloads();
  payloads.fundingRate.payload[0].fundingTime = ACTIVATION - 1;
  const observation = normalizeHyData0001Observation({
    symbol: 'BTCUSDT', payloads, collectorActivatedAt: ACTIVATION, observationAt: OBSERVATION
  });
  assert.equal(observation.isValid, true);
  assert.equal(observation.lastSettledFundingTime, new Date(ACTIVATION - 1).toISOString());
  assert.equal(observation.currentFundingRate, 0.0002);
});

test('pre-activation request and receipt remain invalid even when the observation boundary is current', () => {
  const payloads = validPayloads();
  for (const payload of Object.values(payloads)) {
    payload.requestStartedAt = ACTIVATION - 1;
    payload.receivedAt = ACTIVATION + 1;
  }
  const observation = normalizeHyData0001Observation({
    symbol: 'BTCUSDT', payloads, collectorActivatedAt: ACTIVATION, observationAt: OBSERVATION
  });
  assert.equal(observation.isValid, false);
  assert.ok(observation.qualityFlags.includes('PRE_ACTIVATION_REQUEST'));
});

test('missing completed bar is flagged instead of being forward-filled', () => {
  const payloads = validPayloads();
  payloads.klines = restResponse([[
    BASE - 10,
    '99', '101', '98', '100', '10', BASE + 1_000, '1000', 20, '6', '600', '0'
  ]]);
  const observation = normalizeHyData0001Observation({
    symbol: 'BTCUSDT', payloads, collectorActivatedAt: ACTIVATION, observationAt: OBSERVATION,
    previousObservation: { observationAt: OBSERVATION - 300_000, barOpenTime: OBSERVATION - 300_000 }
  });
  assert.equal(observation.isValid, false);
  assert.ok(observation.qualityFlags.includes('MISSING_COMPLETED_5M_BAR'));
  assert.equal(observation.barClose, null);
});

test('stale, crossed, timestamp-reversed and invalid numeric data fail closed', () => {
  const payloads = validPayloads();
  payloads.openInterest.payload.time = BASE - 700_000;
  payloads.depth.payload.bids[0][0] = '101';
  payloads.depth.payload.asks[0][0] = '100';
  payloads.premiumIndex.payload.markPrice = 'not-a-number';
  const observation = normalizeHyData0001Observation({
    symbol: 'BTCUSDT', payloads, collectorActivatedAt: ACTIVATION, observationAt: OBSERVATION
  });
  assert.equal(observation.isValid, false);
  assert.ok(observation.qualityFlags.some(flag => flag.startsWith('STALE_DATA:openInterest')));
  assert.ok(observation.qualityFlags.includes('CROSSED_BOOK'));
  assert.ok(observation.qualityFlags.includes('INVALID_NUMERIC:markPrice'));
});

test('empty funding and future funding timestamps fail closed', () => {
  const empty = validPayloads();
  empty.fundingRate.payload = [];
  const emptyObservation = normalizeHyData0001Observation({
    symbol: 'BTCUSDT', payloads: empty, collectorActivatedAt: ACTIVATION, observationAt: OBSERVATION
  });
  assert.ok(emptyObservation.qualityFlags.includes('MISSING_FUNDING_ROW'));
  assert.equal(emptyObservation.isValid, false);

  const future = validPayloads();
  future.fundingRate.payload[0].fundingTime = BASE + 1_000;
  const futureObservation = normalizeHyData0001Observation({
    symbol: 'BTCUSDT', payloads: future, collectorActivatedAt: ACTIVATION, observationAt: OBSERVATION
  });
  assert.ok(futureObservation.qualityFlags.includes('FUTURE_SOURCE_TIMESTAMP:lastSettledFundingTime'));
  assert.equal(futureObservation.isValid, false);
});

test('cycle does not forward-fill missing symbols and health exposes the gap', async () => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(String(url));
    if (String(url).includes('fundingRate')) return response([{ symbol: 'BTCUSDT', fundingRate: '0.0001', fundingTime: BASE }]);
    if (String(url).includes('premiumIndex')) return response({ symbol: 'BTCUSDT', markPrice: '100', indexPrice: '99.9', lastFundingRate: '0.0001', nextFundingTime: String(BASE + 1_000), time: BASE });
    if (String(url).includes('openInterest')) return response({ symbol: 'BTCUSDT', openInterest: '1', time: BASE });
    if (String(url).includes('depth')) return response({ lastUpdateId: 1, bids: [['99', '1']], asks: [['100', '1']] });
    if (String(url).includes('klines')) return response([[OBSERVATION, '99', '101', '98', '100', '1', BASE - 1, '100', 1, '0.5', '50', '0']]);
    throw new Error('unexpected_url');
  };
  const result = await collectHyData0001Cycle({
    fetchImpl,
    clock: () => BASE,
    collectorActivatedAt: ACTIVATION,
    symbols: ['BTCUSDT', 'ETHUSDT']
  });
  assert.equal(calls.length, 10);
  assert.equal(result.observations.length, 2);
  assert.equal(result.failures.length, 0);
  assert.equal(result.observations.find(row => row.symbol === 'ETHUSDT').isValid, false);
  assert.ok(result.observations.find(row => row.symbol === 'ETHUSDT').qualityFlags.includes('MISSING_SYMBOL:premiumIndex'));
  assert.equal(result.health.actualObservationCount, 2);
  assert.deepEqual(result.health.missingIntervals, []);
});

test('health report exposes row count, coverage, delay and stale counts', () => {
  const health = buildHyData0001HealthReport({
    observations: [{
      symbol: 'BTCUSDT', isValid: false, qualityFlags: ['STALE_DATA:bar'], scannerDelayMs: 123,
      receivedAt: new Date(BASE).toISOString(), collectorActivatedAt: new Date(ACTIVATION).toISOString()
    }],
    failures: [{ symbol: 'ETHUSDT', reason: 'missing_interval' }],
    cycleStartedAt: BASE,
    cycleFinishedAt: BASE + 1,
    expectedSymbolCount: 2
  });
  assert.equal(health.rowsCollected, 1);
  assert.deepEqual(health.symbolsCovered, ['BTCUSDT']);
  assert.equal(health.expectedObservationCount, 2);
  assert.equal(health.actualObservationCount, 1);
  assert.equal(health.staleObservations, 1);
  assert.equal(health.maximumCollectionDelayMs, 123);
  assert.equal(health.status, 'DEGRADED');
  assert.equal(health.signalsEmitted, false);
});

test('health enumerates skipped UTC five-minute boundaries without forward-fill', () => {
  const previousObservationAt = OBSERVATION - (2 * 300_000);
  const currentObservationAt = OBSERVATION;
  assert.deepEqual(
    enumerateHyData0001MissingIntervals({ previousObservationAt, currentObservationAt }),
    [new Date(OBSERVATION - 300_000).toISOString()]
  );
  const health = buildHyData0001HealthReport({
    observations: [{
      symbol: 'BTCUSDT', observationAt: new Date(currentObservationAt).toISOString(), isValid: true,
      qualityFlags: [], scannerDelayMs: 25, receivedAt: new Date(BASE).toISOString(),
      collectorActivatedAt: new Date(ACTIVATION).toISOString()
    }],
    previousBySymbol: new Map([['BTCUSDT', {
      symbol: 'BTCUSDT', observation_at: new Date(previousObservationAt).toISOString(), is_valid: true
    }]]),
    observationAt: currentObservationAt,
    cycleStartedAt: currentObservationAt,
    cycleFinishedAt: currentObservationAt + 1,
    expectedSymbolCount: 1
  });
  assert.deepEqual(health.missingIntervals, [{
    symbol: 'BTCUSDT',
    observationAt: new Date(OBSERVATION - 300_000).toISOString(),
    reason: 'skipped_observation_boundary'
  }]);
});

test('collector provenance is explicit and never silently defaults to the old base commit', () => {
  assert.throws(
    () => resolveHyData0001SourceCommit({ env: {} }),
    error => error.code === 'HY_DATA_0001_SOURCE_COMMIT_UNAVAILABLE'
  );
  assert.equal(
    resolveHyData0001SourceCommit({ env: { VERCEL_GIT_COMMIT_SHA: 'abcdef1234567' } }),
    'abcdef1234567'
  );
  assert.equal(
    resolveHyData0001SourceCommit({ env: { HY_DATA_0001_SOURCE_COMMIT: '1234567890abcdef' } }),
    '1234567890abcdef'
  );
});

test('HY-DATA-0001 request signatures are bounded and do not authorize trading', () => {
  const body = '{"schedulerSource":"test"}';
  const timestamp = Math.floor(BASE / 1_000);
  const signature = crypto.createHmac('sha256', 'test-secret').update(`${timestamp}.${body}`).digest('hex');
  assert.deepEqual(
    verifyHyData0001RequestSignature({ body, timestamp, signature, secret: 'test-secret', now: BASE }),
    { ok: true }
  );
  assert.equal(HY_DATA_0001_SAFETY.paperOnly, true);
  assert.equal(HY_DATA_0001_SAFETY.liveOrdersEnabled, false);
  assert.equal(HY_DATA_0001_SAFETY.accountApi, false);
  assert.equal(HY_DATA_0001_SAFETY.orderApi, false);
  assert.equal(HY_DATA_0001_SAFETY.automaticTrading, false);
  assert.equal(HY_DATA_0001_SAFETY.pnlComputed, false);
  assert.equal(HY_DATA_0001_SAFETY.finalOosRead, false);
});

test('contract, migration, workflow and API remain data-only and isolated', () => {
  const contract = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/hy-data-0001-contract.json'), 'utf8'));
  const migration = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20260823140000_hy_data_0001_prospective.sql'), 'utf8');
  const correctionMigration = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20260823160000_hy_data_0001_funding_boundary.sql'), 'utf8');
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/hy-data-0001-collector.yml'), 'utf8');
  const api = fs.readFileSync(path.join(ROOT, 'api/hy-data-0001-collect.mjs'), 'utf8');
  assert.equal(contract.datasetId, 'HY-DATA-0001');
  assert.equal(contract.prospectiveBoundary.historicalBackfill, 'FORBIDDEN');
  assert.equal(contract.prospectiveBoundary.forwardFill, 'FORBIDDEN');
  assert.match(migration, /enable row level security/);
  assert.match(migration, /unique \(symbol, observation_at\)/);
  assert.match(migration, /hengyu_hy_data_0001_observations/);
  assert.match(`${migration}\n${correctionMigration}`, /last_settled_funding_rate/);
  assert.match(`${migration}\n${correctionMigration}`, /last_settled_funding_time/);
  assert.match(`${migration}\n${correctionMigration}`, /source_commit/);
  assert.match(workflow, /cron: "\*\/5 \* \* \* \*"/);
  assert.doesNotMatch(api, /fapi\/v1\/(?:order|account|position)/i);
  assert.doesNotMatch(api, /dispatchPendingEmails|sendGmail/i);
  assert.equal(contract.screenPreparation.execution, 'FORBIDDEN_IN_DATA_COLLECTION_STAGE');
});
