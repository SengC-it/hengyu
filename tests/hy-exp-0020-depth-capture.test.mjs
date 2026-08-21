import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCaptureFileEntry,
  buildHyExp0020CaptureManifest,
  hashCaptureBytes,
  validateHyExp0020Capture
} from '../src/model/hy-exp-0020-depth-capture.mjs';

const SYMBOL = 'BTCUSDT';
const SNAPSHOT = {
  symbol: SYMBOL,
  receivedAt: 1_000,
  payload: {
    lastUpdateId: 10,
    bids: [['100', '1'], ['99', '2']],
    asks: [['101', '1'], ['102', '2']]
  }
};

function coverage(overrides = {}) {
  return {
    [SYMBOL]: {
      depthSnapshots: 1,
      depthUpdates: 2,
      sequenceGaps: 0,
      missingIntervals: 0,
      maxDepthLevel: 1000,
      ...overrides
    }
  };
}

function records() {
  return [
    {
      receivedAt: 1_000,
      stream: 'btcusdt@depth@100ms',
      data: {
        e: 'depthUpdate', E: 1_000, T: 999, s: SYMBOL, U: 9, u: 11, pu: null,
        b: [['100', '2']], a: [['101', '3']]
      }
    },
    {
      receivedAt: 1_100,
      stream: 'btcusdt@depth@100ms',
      data: {
        e: 'depthUpdate', E: 1_100, T: 1_099, s: SYMBOL, U: 12, u: 12, pu: 11,
        b: [['100', '1.5']], a: [['102', '0']]
      }
    }
  ];
}

test('HY-EXP-0020 capture validates snapshot/diff sequence and reconstructs raw L2', () => {
  const result = validateHyExp0020Capture({
    records: records(),
    snapshots: [SNAPSHOT],
    symbols: [SYMBOL],
    coverage: coverage()
  });
  assert.equal(result.status, 'VALID');
  assert.equal(result.pnlEligible, false);
  assert.equal(result.reconstructedRows.length, 2);
  assert.deepEqual(result.reconstructedRows[1].bids[0], [100, 1.5]);
});

test('HY-EXP-0020 capture fails closed on a sequence gap or incomplete coverage', () => {
  const result = validateHyExp0020Capture({
    records: [records()[0], { ...records()[1], data: { ...records()[1].data, U: 14, u: 14, pu: 13 } }],
    snapshots: [SNAPSHOT],
    symbols: [SYMBOL],
    coverage: coverage({ sequenceGaps: 1 })
  });
  assert.equal(result.status, 'DATA_FAIL');
  assert.ok(result.errors.includes('BTCUSDT:sequence_gap'));
  assert.equal(result.pnlEligible, false);
});

test('HY-EXP-0020 manifest hashes raw files and never treats bookTicker as depth', () => {
  const raw = JSON.stringify({ e: 'depthUpdate', U: 9, u: 11, pu: null });
  const file = buildCaptureFileEntry({ path: 'raw/btcusdt-depth.ndjson', content: raw });
  assert.equal(file.sha256, hashCaptureBytes(raw));
  const manifest = buildHyExp0020CaptureManifest({
    runId: 'phase-a-test',
    windowStart: '2026-09-01T00:00:00.000Z',
    windowEndExclusive: '2027-03-01T00:00:00.000Z',
    symbols: [SYMBOL],
    startedAt: '2026-08-21T00:00:00.000Z',
    finishedAt: '2026-08-21T00:00:01.000Z',
    files: [file],
    snapshots: [SNAPSHOT],
    coverage: coverage()
  });
  assert.equal(manifest.status, 'complete');
  assert.equal(manifest.bookTickerIsNotDepth, true);
  assert.equal(manifest.ohlcvProxyAllowed, false);
  assert.equal(manifest.files[0].sha256, file.sha256);
});
