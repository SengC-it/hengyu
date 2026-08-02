import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

function number(name, value, { minimum = -Infinity, exclusiveMinimum = false } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (exclusiveMinimum ? parsed <= minimum : parsed < minimum)) {
    throw new Error(`invalid ${name}`);
  }
  return parsed;
}

function integer(name, value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`invalid ${name}`);
  return parsed;
}

function symbolFromStream(stream) {
  const symbol = String(stream).split('@', 1)[0].toUpperCase();
  if (!/^[A-Z0-9]+$/.test(symbol)) throw new Error('invalid stream symbol');
  return symbol;
}

function checkLevel(level, label) {
  if (!Array.isArray(level) || level.length < 2) throw new Error(`invalid ${label} level`);
  return [
    number(`${label} price`, level[0], { minimum: 0, exclusiveMinimum: true }),
    number(`${label} quantity`, level[1], { minimum: 0 })
  ];
}

function checkBookLevels(levels, label) {
  if (!Array.isArray(levels)) throw new Error(`invalid ${label} levels`);
  return levels.map((level, index) => checkLevel(level, `${label}[${index}]`));
}

function validateEnvelope(record, { symbols, maxFutureSkewMs }) {
  if (!record || typeof record !== 'object') throw new Error('record is not an object');
  const receivedAt = integer('receivedAt', record.receivedAt);
  const stream = String(record.stream ?? '');
  const data = record.data;
  if (!stream || !data || typeof data !== 'object') throw new Error('record envelope is incomplete');
  const streamSymbol = symbolFromStream(stream);
  if (!symbols.has(streamSymbol)) throw new Error('symbol is outside the frozen universe');
  const dataSymbol = String(data.s ?? '').toUpperCase();
  if (dataSymbol && dataSymbol !== streamSymbol) throw new Error('stream/data symbol mismatch');
  const eventTime = integer('event time', data.E ?? data.T ?? data.o?.T ?? data.fundingTime);
  if (eventTime > receivedAt + maxFutureSkewMs) throw new Error('event time is in the future');
  return { receivedAt, stream, streamSymbol, data, eventTime };
}

function validateDepth(data) {
  const U = integer('depth U', data.U);
  const u = integer('depth u', data.u);
  const pu = data.pu == null ? null : integer('depth pu', data.pu);
  if (U > u) throw new Error('depth U exceeds u');
  checkBookLevels(data.b ?? data.bids, 'depth bids');
  checkBookLevels(data.a ?? data.asks, 'depth asks');
  return { U, u, pu };
}

function validateBookTicker(data) {
  integer('book update id', data.u);
  number('bid price', data.b, { minimum: 0, exclusiveMinimum: true });
  number('bid quantity', data.B, { minimum: 0 });
  number('ask price', data.a, { minimum: 0, exclusiveMinimum: true });
  number('ask quantity', data.A, { minimum: 0 });
  if (Number(data.b) >= Number(data.a)) throw new Error('book ticker is crossed or locked');
}

function validateAggTrade(data) {
  integer('aggregate trade id', data.a);
  integer('first trade id', data.f);
  integer('last trade id', data.l);
  number('aggregate trade price', data.p, { minimum: 0, exclusiveMinimum: true });
  number('aggregate trade quantity', data.q, { minimum: 0, exclusiveMinimum: true });
  if (data.f > data.l) throw new Error('aggregate trade id range is reversed');
  if (typeof data.m !== 'boolean') throw new Error('aggregate trade maker flag is invalid');
}

export function normalizeAggTrade(data) {
  validateAggTrade(data);
  return {
    symbol: String(data.s ?? '').toUpperCase(),
    aggregateTradeId: integer('aggregate trade id', data.a),
    price: number('aggregate trade price', data.p, { minimum: 0, exclusiveMinimum: true }),
    quantity: number('aggregate trade quantity', data.q, { minimum: 0, exclusiveMinimum: true }),
    quoteNotional: Number(data.p) * Number(data.q),
    eventTime: integer('aggregate trade time', data.T ?? data.E)
  };
}

export function normalizeFundingRate(data) {
  const symbol = String(data.symbol ?? data.s ?? '').toUpperCase();
  const fundingTime = integer('funding time', data.fundingTime);
  const fundingRate = number('funding rate', data.fundingRate, { minimum: -1 });
  const markPrice = data.markPrice == null
    ? null
    : number('funding mark price', data.markPrice, { minimum: 0, exclusiveMinimum: true });
  return { symbol, fundingTime, fundingRate, markPrice, eventTime: fundingTime };
}

export function normalizeOpenInterest(data) {
  const symbol = String(data.symbol ?? data.s ?? '').toUpperCase();
  if (!/^[A-Z0-9]+$/.test(symbol)) throw new Error('open interest symbol is invalid');
  const openInterest = number('open interest', data.openInterest, { minimum: 0 });
  const eventTime = integer('open interest event time', data.E ?? data.time ?? Date.now());
  return { symbol, openInterest, eventTime };
}

export function normalizeForceOrder(data) {
  if (!data?.o || typeof data.o !== 'object') throw new Error('force order payload is missing order');
  const order = data.o;
  const side = String(order.S ?? '').toUpperCase();
  if (side !== 'BUY' && side !== 'SELL') throw new Error('force order side is invalid');
  const symbol = String(order.s ?? data.s ?? '').toUpperCase();
  const price = number('force order price', order.p, { minimum: 0, exclusiveMinimum: true });
  const quantity = number('force order quantity', order.q, { minimum: 0, exclusiveMinimum: true });
  const eventTime = integer('force order time', order.T ?? data.E);
  const quoteNotional = price * quantity;
  return {
    symbol,
    side,
    price,
    quantity,
    quoteNotional,
    pressure: side === 'SELL' ? -quoteNotional : quoteNotional,
    eventTime,
    orderStatus: order.X ?? null
  };
}

function eventKey(type, data, symbol) {
  if (type === 'depthUpdate') return `${symbol}:depth:${data.u}`;
  if (type === 'bookTicker') return `${symbol}:book:${data.u}`;
  if (type === 'aggTrade') return `${symbol}:agg:${data.a}`;
  if (type === 'forceOrder') {
    const order = data.o ?? {};
    return `${symbol}:force:${order.T}:${order.S}:${order.p}:${order.q}`;
  }
  if (type === 'fundingRate') return `${symbol}:funding:${data.fundingTime}`;
  if (type === 'openInterest') return `${symbol}:openInterest:${data.E ?? data.time}`;
  return `${symbol}:${type}:${data.E ?? data.T}`;
}

function reject(summary, symbol, reason) {
  summary.rejectedRecords++;
  summary.rejectionReasons[reason] = (summary.rejectionReasons[reason] ?? 0) + 1;
  if (symbol) {
    const row = summary.bySymbol[symbol] ??= { accepted: 0, rejected: 0 };
    row.rejected++;
  }
}

function accept(summary, symbol, type) {
  summary.acceptedRecords++;
  summary.byType[type] = (summary.byType[type] ?? 0) + 1;
  const row = summary.bySymbol[symbol] ??= { accepted: 0, rejected: 0 };
  row.accepted++;
}

export function validateCapturedRecords(records, {
  symbols,
  snapshots = [],
  maxFutureSkewMs = 5_000
}) {
  const frozenSymbols = new Set(symbols.map(symbol => symbol.toUpperCase()));
  if (!frozenSymbols.size) throw new Error('frozen symbol universe is empty');
  const snapshotBySymbol = new Map(snapshots.map(snapshot => [
    String(snapshot.symbol).toUpperCase(), integer('snapshot update id', snapshot.payload?.lastUpdateId)
  ]));
  const depthState = new Map();
  const seen = new Set();
  const summary = {
    status: 'valid',
    totalRecords: 0,
    acceptedRecords: 0,
    rejectedRecords: 0,
    duplicateRecords: 0,
    rejectionReasons: {},
    byType: {},
    bySymbol: {},
    forceOrders: [],
    fundingRates: [],
    preSnapshotDepthRecords: 0,
    depthSymbols: []
  };
  for (const record of records) {
    summary.totalRecords++;
    let envelope;
    try {
      envelope = validateEnvelope(record, { symbols: frozenSymbols, maxFutureSkewMs });
    } catch (error) {
      reject(summary, null, error.message.replaceAll(' ', '_'));
      continue;
    }
    const { data, streamSymbol } = envelope;
    const type = data.e;
    const key = eventKey(type, data, streamSymbol);
    if (seen.has(key)) {
      summary.duplicateRecords++;
      reject(summary, streamSymbol, 'duplicate_record');
      continue;
    }
    seen.add(key);
    try {
      if (type === 'depthUpdate') {
        const { U, u, pu } = validateDepth(data);
        const snapshotId = snapshotBySymbol.get(streamSymbol);
        if (snapshotId == null) throw new Error('missing_depth_snapshot');
        const state = depthState.get(streamSymbol);
        if (!state) {
          if (u < snapshotId) {
            summary.preSnapshotDepthRecords++;
            accept(summary, streamSymbol, type);
            continue;
          }
          if (!(U <= snapshotId && u >= snapshotId)) throw new Error('depth_snapshot_alignment');
          depthState.set(streamSymbol, { lastUpdateId: u });
        } else {
          if (pu == null || pu !== state.lastUpdateId) {
            throw new Error('depth_sequence_gap');
          }
          if (u <= state.lastUpdateId) throw new Error('depth_out_of_order');
          state.lastUpdateId = u;
        }
        accept(summary, streamSymbol, type);
        continue;
      }
      if (type === 'bookTicker') validateBookTicker(data);
      else if (type === 'aggTrade') validateAggTrade(data);
      else if (type === 'forceOrder') {
        const normalized = normalizeForceOrder(data);
        if (normalized.symbol !== streamSymbol) throw new Error('force order symbol mismatch');
        summary.forceOrders.push(normalized);
      } else if (type === 'markPriceUpdate') {
        number('mark price', data.p, { minimum: 0, exclusiveMinimum: true });
        number('index price', data.i, { minimum: 0, exclusiveMinimum: true });
      } else if (type === 'fundingRate') {
        const normalized = normalizeFundingRate(data);
        if (normalized.symbol !== streamSymbol) throw new Error('funding rate symbol mismatch');
        summary.fundingRates.push(normalized);
      } else if (type === 'openInterest') {
        const normalized = normalizeOpenInterest(data);
        if (normalized.symbol !== streamSymbol) throw new Error('open interest symbol mismatch');
      } else {
        throw new Error('unsupported event type');
      }
      accept(summary, streamSymbol, type);
    } catch (error) {
      reject(summary, streamSymbol, error.message.replaceAll(' ', '_'));
    }
  }
  summary.depthSymbols = [...depthState.keys()].sort();
  if (summary.rejectedRecords) summary.status = 'invalid';
  return summary;
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function validateCaptureDirectory(directory, { symbols, maxFutureSkewMs = 5_000 } = {}) {
  const manifestFile = path.join(directory, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const errors = [...(manifest.errors ?? [])];
  const records = [];
  for (const file of manifest.files ?? []) {
    const absolute = path.resolve(directory, path.basename(file.path));
    if (!fs.existsSync(absolute)) {
      errors.push(`missing_file:${file.path}`);
      continue;
    }
    if (sha256File(absolute) !== file.sha256) {
      errors.push(`hash_mismatch:${file.path}`);
      continue;
    }
    const text = fs.readFileSync(absolute, 'utf8').trim();
    if (text) for (const line of text.split(/\r?\n/)) records.push(JSON.parse(line));
  }
  if (manifest.status !== 'complete' || errors.length) {
    return {
      status: 'not_ready',
      runId: manifest.run_id,
      errors,
      data: { totalRecords: records.length }
    };
  }
  const data = validateCapturedRecords(records, {
    symbols: symbols ?? manifest.symbols,
    snapshots: manifest.snapshots,
    maxFutureSkewMs
  });
  return { status: data.status === 'valid' ? 'valid' : 'invalid', runId: manifest.run_id, errors, data };
}
