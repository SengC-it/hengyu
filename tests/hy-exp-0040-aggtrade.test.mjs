import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createGzip } from 'node:zlib';
import { finished } from 'node:stream/promises';
import {
  COSTS_BPS,
  FEATURE_NAMES,
  FIXED_SYMBOLS,
  MODEL_LAMBDAS,
  buildFlowFeatures,
  buildSourceManifest,
  generateAggTradeCandidates,
  parseAggTradeCsvLine,
  readDerivedBuckets,
  validateNativeAggTradeRows
} from '../src/research/hy-exp-0040-aggtrade.mjs';
import {
  applyFrequency,
  fitLogistic,
  profitFactor,
  summarizeMetrics
} from '../src/research/hy-exp-0040-engine.mjs';

test('HY-EXP-0040 freezes the fixed universe, costs, and single model grid', () => {
  assert.deepEqual(FIXED_SYMBOLS, ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'LINKUSDT', 'LTCUSDT']);
  assert.deepEqual(COSTS_BPS, { 18: 18, 27: 27, 36: 36 });
  assert.deepEqual(MODEL_LAMBDAS, [0.01, 0.1, 1, 10]);
  assert.equal(FEATURE_NAMES.length, 40);
});

test('native aggTrade m flag maps to aggressor direction and preserves native fields', () => {
  const sell = parseAggTradeCsvLine('100,100.5,2,90,100,1724630400000,true,true');
  const buy = parseAggTradeCsvLine('101,100.5,3,101,103,1724630400000,false,true');
  assert.equal(sell.isBuyerMaker, true);
  assert.equal(sell.aggressorSide, 'SELL');
  assert.equal(sell.quoteNotional, 201);
  assert.equal(buy.aggressorSide, 'BUY');
  assert.equal(buy.aggregateTradeId, 101);
  assert.equal(buy.timestamp, 1724630400000);
});

test('native ordering rejects duplicate IDs and timestamp reversal', () => {
  const first = parseAggTradeCsvLine('100,1,1,1,1,1000,false,true');
  const duplicate = parseAggTradeCsvLine('100,1,1,2,2,1001,false,true');
  const reversed = parseAggTradeCsvLine('101,1,1,3,3,999,false,true');
  assert.throws(() => validateNativeAggTradeRows([first, duplicate]), /DUPLICATE_OR_OUT_OF_ORDER_ID/);
  assert.throws(() => validateNativeAggTradeRows([first, reversed]), /TIMESTAMP_REVERSED/);
});

test('native parser rejects malformed and non-finite rows', () => {
  assert.throws(() => parseAggTradeCsvLine('1,NaN,1,1,1,1000,false,true'), /NON_FINITE_price/);
  assert.throws(() => parseAggTradeCsvLine('1,1,1,1,1,1000,maybe,true'), /MAKER_FLAG_INVALID/);
  assert.throws(() => parseAggTradeCsvLine('1,1,1,1,0,1000,false,true'), /INVALID_NATIVE_VALUES/);
});

test('derived 1m stream rejects a missing timeline row and never repairs it', async () => {
  const file = path.join(os.tmpdir(), 'hy-exp-0040-test-' + Date.now() + '.ndjson.gz');
  const output = fs.createWriteStream(file);
  const gzip = createGzip();
  gzip.pipe(output);
  gzip.write(JSON.stringify({ openTime: 0, closeTime: 60000, missing: false }) + '\n');
  gzip.write(JSON.stringify({ openTime: 120000, closeTime: 180000, missing: false }) + '\n');
  gzip.end();
  await finished(output);
  await assert.rejects(() => readDerivedBuckets(file), /DERIVED_BUCKET_TIMELINE_GAP/);
  fs.rmSync(file, { force: true });
});

test('causal flow features require complete prior windows and do not use future buckets', () => {
  const buckets = [];
  for (let index = 0; index < 1500; index += 1) {
    buckets.push({
      openTime: index * 60000,
      closeTime: (index + 1) * 60000,
      missing: false,
      buyNotional: 10,
      sellNotional: 8,
      buyQty: 1,
      sellQty: 1,
      buyTradeCount: 2,
      sellTradeCount: 2,
      totalNotional: 18,
      totalTrades: 4,
      signedNotional: 2,
      CVD: (index + 1) * 2,
      largeBuyNotional: 0,
      largeSellNotional: 0
    });
  }
  const series = {};
  for (const symbol of FIXED_SYMBOLS) {
    const one = [];
    const four = [];
    const mark = [];
    const funding = [];
    for (let index = 0; index < 220; index += 1) {
      const openTime = index * 60 * 60 * 1000;
      one.push({ openTime, closeTime: openTime + 3600000 - 1, open: 100, high: 101, low: 99, close: 100 });
    }
    for (let index = 0; index < 2200; index += 1) {
      const openTime = index * 5 * 60 * 1000;
      four.push({ openTime, closeTime: openTime + 5 * 60 * 1000 - 1, open: 100, high: 101, low: 99, close: 100 });
    }
    for (const row of one) mark.push({ ...row, close: 99 });
    for (let index = 0; index < 1000; index += 1) funding.push({ eventTime: index * 8 * 3600000, fundingRate: 0 });
    series[symbol] = {
      contract1: one,
      contract4: four,
      contract5: one.flatMap(row => Array.from({ length: 12 }, (_, offset) => ({
        openTime: row.openTime + offset * 300000,
        closeTime: row.openTime + (offset + 1) * 300000 - 1,
        open: 100, high: 101, low: 99, close: 100
      }))),
      contract15: one.flatMap(row => Array.from({ length: 4 }, (_, offset) => ({
        openTime: row.openTime + offset * 900000,
        closeTime: row.openTime + (offset + 1) * 900000 - 1,
        open: 100, high: 101, low: 99, close: 100
      }))),
      contract4ByTime: new Map(four.map((row, index) => [row.openTime, index])),
      mark1ByTime: new Map(one.map(row => [row.openTime, { ...row, close: 99 }])),
      mark5ByTime: new Map(),
      funding
    };
  }
  const noFuture = buildFlowFeatures({
    buckets,
    bucketIndex: 1499,
    series,
    symbol: 'BTCUSDT',
    decisionTime: 1500 * 60000,
    side: 'BUY'
  });
  assert.ok(noFuture);
  assert.equal(noFuture.values.length, FEATURE_NAMES.length);
  const incomplete = buckets.slice();
  incomplete[1490] = { ...incomplete[1490], missing: true };
  assert.equal(buildFlowFeatures({
    buckets: incomplete,
    bucketIndex: 1499,
    series,
    symbol: 'BTCUSDT',
    decisionTime: 1500 * 60000,
    side: 'BUY'
  }), null);
});

test('logistic model is deterministic and uses training-only payoff statistics', () => {
  const rows = Array.from({ length: 220 }, (_, index) => ({
    features: FEATURE_NAMES.map((_, feature) => (index % 2 ? 1 : -1) * (feature + 1) / FEATURE_NAMES.length),
    net27Bps: index % 2 ? 20 : -10
  }));
  const model = fitLogistic(rows, 0.1);
  assert.ok(model);
  assert.equal(model.trainingRows, 220);
  assert.equal(model.meanPositiveNet27, 20);
  assert.equal(model.meanNegativeNet27, -10);
  assert.ok(Number.isFinite(model.predictEdge(rows[0].features).predictedEdgeBps));
});

test('frequency selection keeps only the higher side at the same symbol and decision', () => {
  const base = { symbol: 'BTCUSDT', decisionTime: 1, exitTime: 2, net18Bps: 1, net27Bps: 1, net36Bps: 1 };
  const selected = applyFrequency([
    { ...base, side: 'BUY', candidateId: 'b', predictedEdgeBps: 10 },
    { ...base, side: 'SELL', candidateId: 's', predictedEdgeBps: 11 }
  ], 0);
  assert.deepEqual(selected.map(row => row.candidateId), ['s']);
});

test('metrics expose all three explicitly charged cost bases', () => {
  const rows = [
    { symbol: 'BTCUSDT', side: 'BUY', exitTime: Date.parse('2025-01-01'), exitReason: 'TARGET', grossReturnBps: 40, fundingBps: 0, net18Bps: 22, net27Bps: 13, net36Bps: 4 },
    { symbol: 'ETHUSDT', side: 'SELL', exitTime: Date.parse('2025-02-01'), exitReason: 'ATR_STOP', grossReturnBps: -10, fundingBps: 0, net18Bps: -28, net27Bps: -37, net36Bps: -46 }
  ];
  assert.equal(summarizeMetrics(rows, 18).netPnlBps, -6);
  assert.equal(summarizeMetrics(rows, 27).netPnlBps, -24);
  assert.equal(summarizeMetrics(rows, 36).netPnlBps, -42);
  assert.equal(profitFactor(rows, 'net27Bps'), 13 / 37);
});

test('source metadata does not claim archive checksum verification before bytes are acquired', () => {
  const manifest = buildSourceManifest({
    preregistrationSha256: 'a'.repeat(64),
    files: [{
      symbol: 'BTCUSDT',
      cadence: 'monthly',
      period: '2024-08',
      url: 'https://data.binance.vision/example.zip',
      bytes: 10,
      sha256: 'b'.repeat(64)
    }]
  });
  assert.equal(manifest.files[0].checksumAvailable, true);
  assert.equal(manifest.files[0].checksumVerified, false);
  assert.equal(manifest.outcomeRead, false);
  assert.equal(manifest.pnlComputed, false);
});
