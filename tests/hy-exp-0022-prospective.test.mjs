import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  HY_EXP_0022_CAPTURE_START,
  HY_EXP_0022_CAPTURE_ROOTS,
  HY_EXP_0022_ENDPOINTS,
  HY_EXP_0022_FINAL_OOS_END_EXCLUSIVE,
  HY_EXP_0022_FINAL_OOS_START,
  HY_EXP_0022_ORDER_ENDPOINTS,
  HY_EXP_0022_ACCOUNT_ENDPOINTS,
  HY_EXP_0022_PREREGISTRATION_COMMIT,
  HY_EXP_0022_PREREGISTRATION_SHA256,
  HY_EXP_0022_REQUIRED_STREAMS,
  HY_EXP_0022_WINDOWS,
  assertHyExp0022CaptureRoot,
  assertHyExp0022DevelopmentDecisionTime,
  assertHyExp0022FinalOosOperation,
  assertHyExp0022InputRoot,
  assertHyExp0022NoHistoricalBackfill,
  assertHyExp0022PaperOnly,
  assertHyExp0022ProspectiveWarmup,
  calculatePriorSixBarQuoteVolume,
  earliestHyExp0022CandidateTime,
  normalizeHyExp0022ContractKline,
  reconcileHyExp0022BarSources,
  validateHyExp0022CaptureRecord
} from '../src/model/hy-exp-0022-prospective.mjs';

const preregPath = path.resolve('registry/experiments/HY-EXP-0022/preregistration.json');
const closurePath = path.resolve('artifacts/HY-EXP-0021/closure.json');
const fourHours = 4 * 60 * 60 * 1_000;
const captureMs = Date.parse(HY_EXP_0022_CAPTURE_START);

function errorCode(callback) {
  try {
    callback();
  } catch (error) {
    return error.code;
  }
  return null;
}

function completedBar(index, quoteVolume = String(index + 1)) {
  const openTime = captureMs + index * fourHours;
  return {
    openTime,
    closeTime: openTime + fourHours - 1,
    open: '100',
    high: '110',
    low: '90',
    close: '105',
    volume: '1',
    quoteVolume,
    tradeCount: 10,
    finalClosed: true,
    sourceExchangeTimestamp: new Date(openTime + fourHours - 1).toISOString(),
    receivedAt: new Date(openTime + fourHours).toISOString(),
    source: 'BINANCE_USDM_CONTRACT_PRICE_4H'
  };
}

function rawRestBar(openTime = captureMs) {
  return [
    openTime,
    '100',
    '110',
    '90',
    '105',
    '1',
    openTime + fourHours - 1,
    '123.4500',
    10
  ];
}

function rawWebsocketBar(openTime = captureMs) {
  return {
    e: 'kline',
    E: openTime + fourHours - 1,
    k: {
      t: openTime,
      T: openTime + fourHours - 1,
      s: 'BTCUSDT',
      i: '4h',
      o: '100.000',
      h: '110',
      l: '90',
      c: '105',
      v: '1',
      q: '123.45',
      n: 10,
      x: true
    }
  };
}

test('0022 preregistration hash is the Commit 1 file hash', () => {
  const bytes = fs.readFileSync(preregPath);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const specification = JSON.parse(bytes.toString('utf8'));
  assert.equal(hash, HY_EXP_0022_PREREGISTRATION_SHA256);
  assert.equal(specification.status, 'PREREGISTERED_PENDING_ACCEPTANCE');
  assert.equal(specification.experiment_id, 'HY-EXP-0022');
  assert.equal(specification.commit_protocol.required_order[0], 'COMMIT_1_ONLY_REGISTRY_EXPERIMENTS_HY_EXP_0022_PREREGISTRATION_JSON');
  assert.equal(HY_EXP_0022_PREREGISTRATION_COMMIT, '792f9ef4630d724e77fa4df13847ff421bd3e521');
});

test('0021 is closed before data, OOS, Development and PnL', () => {
  const closure = JSON.parse(fs.readFileSync(closurePath, 'utf8'));
  assert.equal(closure.status, 'PREREGISTRATION_INCOMPLETE_PRE_DATA');
  assert.equal(closure.reason, 'MISSING_PROSPECTIVE_BAR_SOURCE_AND_INCOMPLETE_TIME_FIREWALL');
  assert.equal(closure.developmentRun, false);
  assert.equal(closure.oosRead, false);
  assert.equal(closure.eligibleRawDataConsumed, false);
  assert.equal(closure.pnlComputed, false);
  assert.equal(closure.paperOnly, true);
  assert.equal(closure.productionDeployed, false);
});

test('only completed contract-price 4h bars are accepted and mark price is rejected', () => {
  const receivedAt = captureMs + fourHours;
  const websocket = normalizeHyExp0022ContractKline({
    raw: rawWebsocketBar(),
    receivedAt,
    captureStart: HY_EXP_0022_CAPTURE_START
  });
  const rest = normalizeHyExp0022ContractKline({
    raw: rawRestBar(),
    receivedAt,
    sourceTimestamp: captureMs + fourHours - 1,
    captureStart: HY_EXP_0022_CAPTURE_START
  });
  assert.equal(websocket.quoteVolume, '123.45');
  assert.equal(reconcileHyExp0022BarSources({ websocketBar: websocket, restBar: rest }).status, 'ACCEPTED');
  assert.equal(errorCode(() => normalizeHyExp0022ContractKline({
    raw: rawRestBar(),
    source: 'markPriceKlines',
    receivedAt,
    captureStart: HY_EXP_0022_CAPTURE_START
  })), 'MARK_PRICE_KLINE_FORBIDDEN');
  assert.equal(errorCode(() => normalizeHyExp0022ContractKline({
    raw: { ...rawWebsocketBar(), k: { ...rawWebsocketBar().k, x: false } },
    receivedAt,
    captureStart: HY_EXP_0022_CAPTURE_START
  })), 'INCOMPLETE_4H_BAR');
});

test('bar reconciliation never accepts a single source or a conflicting confirmation', () => {
  const receivedAt = captureMs + fourHours;
  const websocket = normalizeHyExp0022ContractKline({ raw: rawWebsocketBar(), receivedAt });
  const rest = normalizeHyExp0022ContractKline({ raw: rawRestBar(), receivedAt, sourceTimestamp: captureMs + fourHours - 1 });
  assert.equal(reconcileHyExp0022BarSources({ websocketBar: websocket }).eligible, false);
  assert.equal(errorCode(() => reconcileHyExp0022BarSources({
    websocketBar: websocket,
    restBar: { ...rest, quoteVolume: '999' }
  })), 'BAR_SOURCE_CONFLICT');
});

test('pre-capture bars and historical REST backfill are rejected', () => {
  const preCapture = captureMs - fourHours;
  assert.equal(errorCode(() => validateHyExp0022CaptureRecord({
    mode: 'DEVELOPMENT_CAPTURE',
    sourceTimestamp: preCapture + fourHours - 1,
    receivedAt: captureMs,
    windows: HY_EXP_0022_WINDOWS
  })), 'PRE_CAPTURE_DATA');
  assert.equal(errorCode(() => assertHyExp0022NoHistoricalBackfill({
    timestamp: preCapture,
    captureStart: HY_EXP_0022_CAPTURE_START
  })), 'HISTORICAL_BACKFILL_FORBIDDEN');
});

test('180 prospective completed bars are required before a candidate', () => {
  const bars = Array.from({ length: 180 }, (_, index) => completedBar(index));
  const decisionTime = captureMs + 180 * fourHours;
  assert.equal(errorCode(() => assertHyExp0022ProspectiveWarmup({
    bars: bars.slice(0, 179),
    decisionTime,
    captureStart: HY_EXP_0022_CAPTURE_START
  })), 'INSUFFICIENT_PROSPECTIVE_WARMUP');
  const result = assertHyExp0022ProspectiveWarmup({
    bars,
    decisionTime,
    captureStart: HY_EXP_0022_CAPTURE_START
  });
  assert.equal(result.completedBars, 180);
  assert.equal(result.historicalBackfillUsed, false);
  assert.equal(earliestHyExp0022CandidateTime(), '2026-09-21T04:00:00.000Z');
});

test('volume6 uses six completed 4h bars and cannot use a 24h ticker', () => {
  const decisionOpenTime = captureMs + 6 * fourHours;
  const bars = Array.from({ length: 6 }, (_, index) => completedBar(index, String((index + 1) * 10)));
  const result = calculatePriorSixBarQuoteVolume({
    bars,
    decisionOpenTime,
    ticker: { quoteVolume: '999999999' }
  });
  assert.equal(result.quoteVolumeUsdt, 210);
  assert.equal(result.tickerUsed, false);
  assert.equal(errorCode(() => calculatePriorSixBarQuoteVolume({
    bars: [],
    decisionOpenTime,
    ticker: { quoteVolume: '999999999' }
  })), 'INSUFFICIENT_COMPLETED_BARS_FOR_VOLUME6');
});

test('mode-aware firewall rejects OOS timestamps in Development and boundary violations', () => {
  const finalStart = Date.parse(HY_EXP_0022_FINAL_OOS_START);
  const finalEnd = Date.parse(HY_EXP_0022_FINAL_OOS_END_EXCLUSIVE);
  assert.equal(errorCode(() => validateHyExp0022CaptureRecord({
    mode: 'DEVELOPMENT_CAPTURE',
    sourceTimestamp: finalStart,
    receivedAt: finalStart,
    windows: HY_EXP_0022_WINDOWS
  })), 'DEVELOPMENT_WINDOW_VIOLATION');
  assert.equal(errorCode(() => validateHyExp0022CaptureRecord({
    mode: 'FINAL_OOS_CAPTURE',
    sourceTimestamp: finalStart - 1,
    receivedAt: finalStart,
    windows: HY_EXP_0022_WINDOWS
  })), 'OOS_BEFORE_FINAL_START');
  assert.equal(errorCode(() => validateHyExp0022CaptureRecord({
    mode: 'FINAL_OOS_CAPTURE',
    sourceTimestamp: finalEnd,
    receivedAt: finalEnd,
    windows: HY_EXP_0022_WINDOWS
  })), 'OOS_AFTER_FINAL_END');
  assert.equal(errorCode(() => assertHyExp0022DevelopmentDecisionTime({
    decisionTime: finalStart,
    windows: HY_EXP_0022_WINDOWS
  })), 'DEVELOPMENT_WINDOW_VIOLATION');
});

test('OOS unknown operations are rejected before and after Development PASS', () => {
  assert.deepEqual(assertHyExp0022FinalOosOperation({ operation: 'write' }), {
    allowed: true,
    operation: 'write',
    mode: 'RAW_CAPTURE_ONLY'
  });
  assert.equal(errorCode(() => assertHyExp0022FinalOosOperation({ operation: 'read_manifest' })), 'HY_EXP_0022_FINAL_OOS_LOCKED');
  assert.deepEqual(assertHyExp0022FinalOosOperation({
    operation: 'read_manifest',
    developmentStatus: 'PASS',
    developmentAllowed: true
  }), {
    allowed: true,
    operation: 'read_manifest',
    mode: 'POST_DEVELOPMENT_READ'
  });
  assert.equal(errorCode(() => assertHyExp0022FinalOosOperation({
    operation: 'unknown_operation',
    developmentStatus: 'PASS',
    developmentAllowed: true
  })), 'HY_EXP_0022_OOS_OPERATION_UNKNOWN');
  assert.equal(errorCode(() => assertHyExp0022FinalOosOperation({
    operation: 'delete',
    developmentStatus: 'PASS',
    developmentAllowed: true
  })), 'HY_EXP_0022_OOS_OPERATION_UNKNOWN');
});

test('canonical root containment rejects lookalike and cross-experiment paths', () => {
  const projectRoot = process.cwd();
  assertHyExp0022CaptureRoot({
    projectRoot,
    mode: 'DEVELOPMENT_CAPTURE',
    outputRoot: path.join(HY_EXP_0022_CAPTURE_ROOTS.development, 'BTCUSDT')
  });
  assert.equal(errorCode(() => assertHyExp0022CaptureRoot({
    projectRoot,
    mode: 'DEVELOPMENT_CAPTURE',
    outputRoot: path.join('data', 'raw', 'prospective-development', 'HY-EXP-0022-lookalike')
  })), 'HY_EXP_0022_NAMESPACE_MISMATCH');
  assert.equal(errorCode(() => assertHyExp0022InputRoot({
    projectRoot,
    mode: 'DEVELOPMENT_CAPTURE',
    experimentId: 'HY-EXP-0022',
    inputPath: path.join('tmp', 'HY-EXP-0022')
  })), 'HY_EXP_0022_FOREIGN_INPUT');
  assert.equal(errorCode(() => assertHyExp0022InputRoot({
    projectRoot,
    mode: 'DEVELOPMENT_CAPTURE',
    experimentId: 'HY-EXP-0021',
    inputPath: HY_EXP_0022_CAPTURE_ROOTS.development
  })), 'HY_EXP_0022_FOREIGN_INPUT');
});

test('capture metadata remains PAPER_ONLY with no order or account endpoints', () => {
  assertHyExp0022PaperOnly({
    authorization: 'PAPER_ONLY',
    liveOrdersEnabled: false,
    accountApiEnabled: false,
    orderApiEnabled: false,
    orderEndpoints: [],
    accountEndpoints: [],
    pnlComputed: false,
    developmentAllowed: false
  });
  assert.deepEqual(HY_EXP_0022_ORDER_ENDPOINTS, []);
  assert.deepEqual(HY_EXP_0022_ACCOUNT_ENDPOINTS, []);
  assert.equal(HY_EXP_0022_ENDPOINTS.order, null);
  assert.equal(HY_EXP_0022_ENDPOINTS.account, null);
  assert.ok(HY_EXP_0022_REQUIRED_STREAMS.includes('kline.4h'));
  assert.equal(HY_EXP_0022_FINAL_OOS_START, '2027-03-01T00:00:00.000Z');
  assert.equal(HY_EXP_0022_FINAL_OOS_END_EXCLUSIVE, '2027-09-01T00:00:00.000Z');
});
