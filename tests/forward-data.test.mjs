import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeForceOrder, validateCapturedRecords } from '../src/model/forward-data.mjs';

const symbols = ['BTCUSDT'];
const receivedAt = 1_000_000;

function record(stream, data, offset = 0) {
  return { receivedAt: receivedAt + offset, stream, data };
}

function depth(U, u, pu, offset = 0) {
  return record('btcusdt@depth@100ms', {
    e: 'depthUpdate', E: receivedAt + offset, s: 'BTCUSDT', U, u, pu,
    b: [['99', '2']], a: [['101', '3']]
  }, offset);
}

test('validates an aligned local depth sequence and normalizes force pressure', () => {
  const result = validateCapturedRecords([
    depth(99, 101, null),
    depth(102, 103, 101),
    record('btcusdt@forceOrder', {
      e: 'forceOrder', E: receivedAt + 3, s: 'BTCUSDT',
      o: { s: 'BTCUSDT', S: 'SELL', p: '100', q: '2', T: receivedAt + 3, X: 'FILLED' }
    }, 3),
    record('btcusdt@fundingRate', {
      e: 'fundingRate', s: 'BTCUSDT', fundingTime: receivedAt + 4,
      fundingRate: '0.0001', markPrice: '100'
    }, 4),
    record('btcusdt@openInterest', {
      e: 'openInterest', E: receivedAt + 5, s: 'BTCUSDT', openInterest: '12.5'
    }, 5)
  ], {
    symbols,
    snapshots: [{ symbol: 'BTCUSDT', payload: { lastUpdateId: 100 } }]
  });
  assert.equal(result.status, 'valid');
  assert.equal(result.acceptedRecords, 5);
  assert.equal(result.depthSymbols[0], 'BTCUSDT');
  assert.equal(result.forceOrders[0].pressure, -200);
  assert.equal(result.fundingRates[0].fundingRate, 0.0001);
  assert.equal(normalizeForceOrder({
    E: receivedAt, o: { s: 'BTCUSDT', S: 'BUY', p: '100', q: '2', T: receivedAt }
  }).pressure, 200);
});

test('discards depth updates received before the REST snapshot boundary', () => {
  const result = validateCapturedRecords([
    depth(1, 5, null),
    depth(99, 101, null)
  ], {
    symbols,
    snapshots: [{ symbol: 'BTCUSDT', payload: { lastUpdateId: 100 } }]
  });
  assert.equal(result.status, 'valid');
  assert.equal(result.preSnapshotDepthRecords, 1);
  assert.equal(result.depthSymbols[0], 'BTCUSDT');
});

test('rejects sequence gaps before any event can enter PnL', () => {
  const result = validateCapturedRecords([
    depth(99, 101, null),
    depth(105, 106, 104)
  ], {
    symbols,
    snapshots: [{ symbol: 'BTCUSDT', payload: { lastUpdateId: 100 } }]
  });
  assert.equal(result.status, 'invalid');
  assert.equal(result.acceptedRecords, 1);
  assert.equal(result.rejectionReasons.depth_sequence_gap, 1);
});

test('accepts non-contiguous update ranges when the pu chain is intact', () => {
  const result = validateCapturedRecords([
    depth(99, 101, null),
    depth(120, 140, 101)
  ], {
    symbols,
    snapshots: [{ symbol: 'BTCUSDT', payload: { lastUpdateId: 100 } }]
  });
  assert.equal(result.status, 'valid');
  assert.equal(result.acceptedRecords, 2);
});

test('rejects duplicate, stale-future and malformed records', () => {
  const result = validateCapturedRecords([
    record('btcusdt@bookTicker', {
      e: 'bookTicker', E: receivedAt, s: 'BTCUSDT', u: 10,
      b: '99', B: '1', a: '101', A: '1'
    }),
    record('btcusdt@bookTicker', {
      e: 'bookTicker', E: receivedAt, s: 'BTCUSDT', u: 10,
      b: '99', B: '1', a: '101', A: '1'
    }),
    record('btcusdt@aggTrade', {
      e: 'aggTrade', E: receivedAt + 10_000, s: 'BTCUSDT', a: 1, f: 1, l: 1,
      p: '100', q: '1', m: false
    }),
    record('btcusdt@forceOrder', {
      e: 'forceOrder', E: receivedAt, s: 'BTCUSDT', o: { s: 'BTCUSDT', S: 'HOLD', p: '100', q: '1', T: receivedAt }
    })
  ], { symbols, maxFutureSkewMs: 1000 });
  assert.equal(result.status, 'invalid');
  assert.equal(result.duplicateRecords, 1);
  assert.equal(result.rejectionReasons.duplicate_record, 1);
  assert.equal(result.rejectionReasons.event_time_is_in_the_future, 1);
  assert.equal(result.rejectionReasons.force_order_side_is_invalid, 1);
});
