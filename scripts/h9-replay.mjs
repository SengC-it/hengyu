import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_H9_POLICY,
  buildPressureWindows,
  detectH9Events,
  makeWindowEnds,
  replayH9Event,
  summarizeH9Trades
} from '../src/model/h9-events.mjs';
import {
  normalizeAggTrade,
  normalizeForceOrder,
  normalizeFundingRate,
  validateCaptureDirectory
} from '../src/model/forward-data.mjs';
import { buildLocalBookSnapshots } from '../src/model/local-book.mjs';
import { buildH9AdvisorySignal } from '../src/model/advisory-signal.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPLAY_BOOK_LEVEL_LIMIT = 100;

function flag(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}

function readManifestRecords(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  const records = [];
  for (const file of manifest.files ?? []) {
    const absolute = path.resolve(directory, path.basename(file.path));
    const text = fs.readFileSync(absolute, 'utf8').trim();
    if (text) for (const line of text.split(/\r?\n/)) records.push(JSON.parse(line));
  }
  return { manifest, records };
}

function eventTime(record) {
  return Number(record.data?.E ?? record.data?.T ?? record.data?.o?.T ?? record.data?.fundingTime);
}

function timeBounds(records) {
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const record of records) {
    const time = eventTime(record);
    if (!Number.isFinite(time)) continue;
    minimum = Math.min(minimum, time);
    maximum = Math.max(maximum, time);
  }
  return {
    minimum: Number.isFinite(minimum) ? minimum : null,
    maximum: Number.isFinite(maximum) ? maximum : null
  };
}

function normalizeRecords(records) {
  const forceOrders = [];
  const trades = [];
  const markPrices = [];
  const fundingRates = [];
  for (const record of records) {
    const type = record.data?.e;
    if (type === 'forceOrder') forceOrders.push({ ...normalizeForceOrder(record.data), receivedAt: record.receivedAt });
    else if (type === 'aggTrade') trades.push({ ...normalizeAggTrade(record.data), receivedAt: record.receivedAt });
    else if (type === 'markPriceUpdate') {
      markPrices.push({
        symbol: String(record.data.s).toUpperCase(),
        eventTime: Number(record.data.E),
        markPrice: Number(record.data.p)
      });
    } else if (type === 'fundingRate') fundingRates.push(normalizeFundingRate(record.data));
  }
  return { forceOrders, trades, markPrices, fundingRates };
}

function main() {
  const input = flag('capture');
  if (!input) throw new Error('usage: node scripts/h9-replay.mjs --capture <directory>');
  const directory = path.resolve(ROOT, input);
  const quality = validateCaptureDirectory(directory);
  if (quality.status !== 'valid') {
    console.log(JSON.stringify({ experiment_id: 'HY-EXP-0013', status: quality.status, quality }, null, 2));
    process.exitCode = 1;
    return;
  }
  const { manifest, records } = readManifestRecords(directory);
  const symbols = manifest.symbols.map(symbol => symbol.toUpperCase());
  const forwardBoundaryExclusive = Date.parse('2026-07-30T16:00:00.000Z');
  const boundaryViolations = records.filter(record => {
    const time = eventTime(record);
    return Number.isFinite(time) && time <= forwardBoundaryExclusive;
  }).length;
  if (boundaryViolations) {
    console.log(JSON.stringify({
      experiment_id: 'HY-EXP-0013',
      status: 'boundary_violation',
      forwardBoundaryExclusiveUtc: new Date(forwardBoundaryExclusive).toISOString(),
      boundaryViolations
    }, null, 2));
    process.exitCode = 1;
    return;
  }
  const timestamps = timeBounds(records);
  if (timestamps.minimum == null) throw new Error('capture has no timestamped records');
  const manifestStartTime = Date.parse(manifest.started_at);
  const startTime = Number.isFinite(manifestStartTime)
    ? manifestStartTime
    : timestamps.minimum;
  const endTime = timestamps.maximum;
  const policy = DEFAULT_H9_POLICY;
  const normalized = normalizeRecords(records);
  const books = buildLocalBookSnapshots({
    records,
    snapshots: manifest.snapshots,
    symbols,
    // Keep reconstruction causal while bounding memory. H9 only measures the
    // top five levels and trades a fixed 1,000 USDT notional; deeper levels
    // are retained conservatively as unavailable liquidity for oversized fills.
    maxLevelsPerSide: REPLAY_BOOK_LEVEL_LIMIT
  });
  const pressureWindows = buildPressureWindows({
    symbols,
    forceOrders: normalized.forceOrders,
    trades: normalized.trades,
    windowEnds: makeWindowEnds({ startTime, endTime, windowMs: policy.windowMs }),
    warmupUntil: startTime + policy.warmupMs,
    policy
  });
  const detected = detectH9Events({ pressureWindows, books, policy });
  const advisorySignals = detected.events.map(event => buildH9AdvisorySignal({ event, policy }));
  const closed = [];
  const rejected = [];
  for (const event of detected.events) {
    const replay = replayH9Event({
      event,
      books,
      markPrices: normalized.markPrices,
      fundingRates: normalized.fundingRates,
      quantity: policy.fixedNotionalPerEvent / event.decisionMid,
      policy
    });
    if (replay.status === 'CLOSED') closed.push(replay);
    else rejected.push(replay);
  }
  const summary = summarizeH9Trades(closed);
  const status = endTime - startTime >= policy.warmupMs ? 'evaluated' : 'insufficient_warmup';
  console.log(JSON.stringify({
    experiment_id: 'HY-EXP-0013',
    status,
    forwardBoundaryExclusiveUtc: new Date(forwardBoundaryExclusive).toISOString(),
    capture: { runId: manifest.run_id, startTime, endTime, spanDays: (endTime - startTime) / 86_400_000 },
    quality,
    counts: {
      rawRecords: records.length,
      localBooks: books.length,
      pressureWindows: pressureWindows.length,
      lateForceOrders: pressureWindows.reduce((total, row) => total + row.lateForceOrders, 0),
      lateTrades: pressureWindows.reduce((total, row) => total + row.lateTrades, 0),
      detectedEvents: detected.events.length,
      advisorySignals: advisorySignals.length,
      eventRejections: detected.rejected.length,
      closedTrades: closed.length,
      replayRejections: rejected.length
    },
    sizing: { fixedNotionalPerEventUsdt: policy.fixedNotionalPerEvent },
    reconstruction: {
      maxLevelsPerSide: REPLAY_BOOK_LEVEL_LIMIT,
      deeperLiquidityTreatment: 'conservative_reject'
    },
    signalMode: {
      mode: 'SIGNAL_ONLY',
      humanConfirmationRequired: true,
      autoExecution: false,
      orderPlacement: false
    },
    advisorySignals,
    summary,
    eventRejections: detected.rejected,
    replayRejections: rejected
  }, null, 2));
  if (status !== 'evaluated') process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
