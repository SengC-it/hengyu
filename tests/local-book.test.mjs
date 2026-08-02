import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLocalBookSnapshots } from '../src/model/local-book.mjs';

test('local book reconstruction applies aligned deltas causally', () => {
  const records = [
    {
      receivedAt: 1_000,
      stream: 'btcusdt@depth@100ms',
      data: {
        e: 'depthUpdate', E: 1_000, s: 'BTCUSDT', U: 9, u: 11,
        b: [['100', '2'], ['99', '0']], a: [['101', '3']]
      }
    },
    {
      receivedAt: 1_100,
      stream: 'btcusdt@depth@100ms',
      data: {
        e: 'depthUpdate', E: 1_100, s: 'BTCUSDT', U: 12, u: 12, pu: 11,
        b: [['100', '1.5']], a: [['102', '0']]
      }
    }
  ];
  const result = buildLocalBookSnapshots({
    symbols: ['BTCUSDT'],
    records,
    snapshots: [{
      symbol: 'BTCUSDT',
      payload: {
        lastUpdateId: 10,
        bids: [['100', '1'], ['99', '2']],
        asks: [['101', '1'], ['102', '2']]
      }
    }]
  });
  assert.equal(result.length, 2);
  assert.deepEqual(result[0].bids[0], [100, 2]);
  assert.deepEqual(result[0].asks[0], [101, 3]);
  assert.deepEqual(result[1].bids[0], [100, 1.5]);
  assert.equal(result[1].asks.some(([price]) => price === 102), false);
});

test('local reconstruction never fills a sequence gap', () => {
  assert.throws(() => buildLocalBookSnapshots({
    symbols: ['BTCUSDT'],
    records: [{
      receivedAt: 1_000,
      stream: 'btcusdt@depth@100ms',
      data: {
        e: 'depthUpdate', E: 1_000, s: 'BTCUSDT', U: 9, u: 11,
        b: [['100', '2']], a: [['101', '3']]
      }
    }, {
      receivedAt: 1_100,
      stream: 'btcusdt@depth@100ms',
      data: {
        e: 'depthUpdate', E: 1_100, s: 'BTCUSDT', U: 14, u: 14, pu: 12,
        b: [['100', '1']], a: [['101', '3']]
      }
    }],
    snapshots: [{
      symbol: 'BTCUSDT',
      payload: { lastUpdateId: 10, bids: [['100', '1']], asks: [['101', '1']] }
    }]
  }), /captured data is not valid/);
});

test('local reconstruction can bound retained levels without changing the top of book', () => {
  const result = buildLocalBookSnapshots({
    symbols: ['BTCUSDT'],
    maxLevelsPerSide: 1,
    records: [{
      receivedAt: 1_000,
      stream: 'btcusdt@depth@100ms',
      data: {
        e: 'depthUpdate', E: 1_000, s: 'BTCUSDT', U: 9, u: 11,
        b: [['100', '2']], a: [['101', '3']]
      }
    }],
    snapshots: [{
      symbol: 'BTCUSDT',
      payload: {
        lastUpdateId: 10,
        bids: [['100', '1'], ['99', '2']],
        asks: [['101', '1'], ['102', '2']]
      }
    }]
  });
  assert.equal(result[0].bids.length, 1);
  assert.equal(result[0].asks.length, 1);
  assert.deepEqual(result[0].bids[0], [100, 2]);
  assert.deepEqual(result[0].asks[0], [101, 3]);
});
