import { validateCapturedRecords } from './forward-data.mjs';

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

function symbolOf(value) {
  const symbol = String(value ?? '').toUpperCase();
  if (!/^[A-Z0-9]+$/.test(symbol)) throw new Error('invalid symbol');
  return symbol;
}

function snapshotLevels(levels, label) {
  if (!Array.isArray(levels)) throw new Error(`${label} is missing`);
  const map = new Map();
  for (const row of levels) {
    if (!Array.isArray(row) || row.length < 2) throw new Error(`invalid ${label} level`);
    const price = number(`${label} price`, row[0], { minimum: 0, exclusiveMinimum: true });
    const quantity = number(`${label} quantity`, row[1], { minimum: 0 });
    if (quantity > 0) map.set(price, quantity);
  }
  return map;
}

function applyDelta(map, levels, label) {
  if (!Array.isArray(levels)) throw new Error(`${label} delta is missing`);
  for (const row of levels) {
    if (!Array.isArray(row) || row.length < 2) throw new Error(`invalid ${label} delta`);
    const price = number(`${label} price`, row[0], { minimum: 0, exclusiveMinimum: true });
    const quantity = number(`${label} quantity`, row[1], { minimum: 0 });
    if (quantity === 0) map.delete(price);
    else map.set(price, quantity);
  }
}

function orderedLevels(map, side, maxLevelsPerSide = null) {
  const ordered = [...map.entries()]
    .sort((left, right) => side === 'bid' ? right[0] - left[0] : left[0] - right[0])
    .map(([price, quantity]) => [price, quantity]);
  return maxLevelsPerSide == null ? ordered : ordered.slice(0, maxLevelsPerSide);
}

function eventTime(record) {
  return integer('event time', record.data?.E ?? record.data?.T);
}

export function buildLocalBookSnapshots({ records, snapshots, symbols, maxLevelsPerSide = null }) {
  const frozenSymbols = [...new Set((symbols ?? []).map(symbolOf))].sort();
  if (!frozenSymbols.length) throw new Error('symbols must not be empty');
  if (maxLevelsPerSide != null && (!Number.isSafeInteger(maxLevelsPerSide) || maxLevelsPerSide < 1)) {
    throw new Error('maxLevelsPerSide must be a positive integer');
  }
  const quality = validateCapturedRecords(records, { symbols: frozenSymbols, snapshots });
  if (quality.status !== 'valid') throw new Error('captured data is not valid for local book reconstruction');
  const snapshotBySymbol = new Map((snapshots ?? []).map(snapshot => [
    symbolOf(snapshot.symbol), snapshot
  ]));
  const recordsBySymbol = new Map(frozenSymbols.map(symbol => [symbol, []]));
  for (const [index, record] of records.entries()) {
    if (record?.data?.e !== 'depthUpdate') continue;
    const symbol = symbolOf(record.data.s ?? String(record.stream).split('@', 1)[0]);
    if (!recordsBySymbol.has(symbol)) continue;
    recordsBySymbol.get(symbol).push({ record, index });
  }
  const output = [];
  for (const symbol of frozenSymbols) {
    const snapshot = snapshotBySymbol.get(symbol);
    if (!snapshot?.payload) throw new Error(`missing depth snapshot for ${symbol}`);
    const payload = snapshot.payload;
    const bids = snapshotLevels(payload.bids ?? payload.b, `${symbol} bids`);
    const asks = snapshotLevels(payload.asks ?? payload.a, `${symbol} asks`);
    const snapshotId = integer('snapshot update id', payload.lastUpdateId);
    let lastUpdateId = snapshotId;
    let aligned = false;
    const rows = recordsBySymbol.get(symbol).sort((left, right) => {
      const receivedDelta = Number(left.record.receivedAt) - Number(right.record.receivedAt);
      return receivedDelta || left.index - right.index;
    });
    for (const { record } of rows) {
      const data = record.data;
      const U = integer('depth U', data.U);
      const u = integer('depth u', data.u);
      if (!aligned) {
        if (u < snapshotId) continue;
        if (!(U <= snapshotId && u >= snapshotId)) throw new Error(`depth snapshot alignment failed for ${symbol}`);
        aligned = true;
      } else if (data.pu !== lastUpdateId) {
        throw new Error(`depth sequence gap for ${symbol}`);
      }
      applyDelta(bids, data.b ?? data.bids, `${symbol} bids`);
      applyDelta(asks, data.a ?? data.asks, `${symbol} asks`);
      lastUpdateId = u;
      const orderedBids = orderedLevels(bids, 'bid', maxLevelsPerSide);
      const orderedAsks = orderedLevels(asks, 'ask', maxLevelsPerSide);
      if (!orderedBids.length || !orderedAsks.length || orderedBids[0][0] >= orderedAsks[0][0]) {
        throw new Error(`crossed local book for ${symbol}`);
      }
      output.push({
        symbol,
        eventTime: eventTime(record),
        receivedAt: integer('received time', record.receivedAt),
        updateId: lastUpdateId,
        bids: orderedBids,
        asks: orderedAsks
      });
    }
    if (!aligned) throw new Error(`no aligned depth event for ${symbol}`);
  }
  return output.sort((left, right) => left.receivedAt - right.receivedAt || left.symbol.localeCompare(right.symbol));
}
