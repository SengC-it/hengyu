import assert from 'node:assert/strict';
import test from 'node:test';
import {
  auditHistoricalL2Metadata,
  buildHistoricalL2Manifest,
  buildTardisAuthHeaders,
  importTardisCsv,
  importTardisNdjson,
  validateHistoricalL2,
  verifyHistoricalL2Manifest
} from '../src/model/hy-exp-0020-historical-l2.mjs';

const SYMBOL = 'BTCUSDT';
const START = Date.parse('2024-01-01T00:00:00.000Z');

function levels() {
  return {
    bids: Array.from({ length: 1000 }, (_, index) => [1000 - index, 1]),
    asks: Array.from({ length: 1000 }, (_, index) => [2000 + index, 1])
  };
}

function validRecords(overrides = {}) {
  const book = levels();
  return [
    {
      kind: 'snapshot', vendor: 'tardis', symbol: SYMBOL,
      eventTime: START, transactionTime: START, receivedAt: START + 2,
      lastUpdateId: 100, bids: book.bids, asks: book.asks
    },
    {
      kind: 'diff', vendor: 'tardis', symbol: SYMBOL,
      eventTime: START + 100, transactionTime: START + 99, receivedAt: START + 110,
      U: 99, u: 101, pu: null, bids: [[1000, 2]], asks: [],
      ...overrides.first
    },
    {
      kind: 'diff', vendor: 'tardis', symbol: SYMBOL,
      eventTime: START + 200, transactionTime: START + 199, receivedAt: START + 210,
      U: 102, u: 102, pu: 101, bids: [], asks: [[2000, 2]],
      ...overrides.second
    }
  ];
}

function manifest() {
  const content = '{"source":"authorized-sample"}\n';
  return buildHistoricalL2Manifest({
    symbols: [SYMBOL],
    files: [{ path: 'btc.ndjson', content }],
    accessAuthorized: true,
    licenseAccepted: true,
    provenance: {
      vendor: 'tardis',
      datasetId: 'binance-futures-depth-sample-2024-01-01',
      sourceUrl: 'https://api.tardis.dev/v1/data-feeds/binance-futures',
      license: 'authorized-test-fixture',
      credentialSource: 'env:TARDIS_API_KEY',
      acquiredAt: '2026-08-21T00:00:00.000Z'
    }
  });
}

test('historical L2 validator accepts snapshot plus Binance U/u/pu chain with 1000 levels', () => {
  const rawManifest = manifest();
  const result = validateHistoricalL2({
    records: validRecords(),
    symbols: [SYMBOL],
    sample: true,
    manifest: { manifest: rawManifest, fileContents: { 'btc.ndjson': '{"source":"authorized-sample"}\n' } }
  });
  assert.equal(result.status, 'SAMPLE_VALID');
  assert.equal(result.decision, 'STOP');
  assert.equal(result.pnlComputed, false);
  assert.equal(result.snapshots, 1);
  assert.equal(result.diffs, 2);
  assert.equal(result.bySymbol[SYMBOL].lastEventTime, START + 200);
});

test('historical L2 defaults to the frozen full window and short records cannot unlock feasibility', () => {
  const result = validateHistoricalL2({ records: validRecords(), symbols: [SYMBOL] });
  assert.equal(result.status, 'DATA_FAIL');
  assert.equal(result.windowStart, '2024-01-01T00:00:00.000Z');
  assert.equal(result.windowEndExclusive, '2026-07-01T00:00:00.000Z');
  assert.ok(result.errors.includes(`${SYMBOL}:coverage_ends_before_window`));
  assert.equal(result.developmentAllowed, false);
  assert.equal(result.finalOosAllowed, false);
});

test('historical L2 accepts null pu only for the first post-snapshot update and rejects later gaps', () => {
  const result = validateHistoricalL2({
    records: validRecords({ second: { pu: 999 } }),
    symbols: [SYMBOL]
  });
  assert.equal(result.status, 'DATA_FAIL');
  assert.ok(result.errors.includes(`${SYMBOL}:sequence_gap`));
});

test('historical L2 fails on crossed books, missing intervals, duplicate and out-of-order updates', () => {
  const crossed = validateHistoricalL2({
    records: validRecords({ first: { bids: [[2000, 5]] } }),
    symbols: [SYMBOL]
  });
  assert.ok(crossed.errors.includes(`${SYMBOL}:crossed_book`));

  const missingInterval = validateHistoricalL2({
    records: validRecords({ second: { receivedAt: START + 2_000 } }),
    symbols: [SYMBOL]
  });
  assert.ok(missingInterval.errors.includes(`${SYMBOL}:missing_interval`));

  const duplicate = validateHistoricalL2({
    records: [...validRecords(), { ...validRecords()[2] }],
    symbols: [SYMBOL]
  });
  assert.ok(duplicate.errors.includes(`${SYMBOL}:duplicate_update`));

  const outOfOrder = validateHistoricalL2({
    records: validRecords({ second: { u: 100, pu: 101 } }),
    symbols: [SYMBOL]
  });
  assert.ok(outOfOrder.errors.includes(`${SYMBOL}:out_of_order_update`));
});

test('Tardis normalized CSV is importable for audit but cannot satisfy U/u/pu or 1000-level gates', () => {
  const csv = [
    'exchange,symbol,timestamp,local_timestamp,is_snapshot,side,price,amount',
    'binance-futures,BTCUSDT,1704067200000000,1704067200001000,true,bid,100,1',
    'binance-futures,BTCUSDT,1704067200000000,1704067200001000,true,ask,101,1'
  ].join('\n');
  const records = importTardisCsv(csv);
  assert.equal(records[0].format, 'tardis-csv-incremental-book-l2');
  assert.equal(records[0].U, null);
  const result = validateHistoricalL2({ records, symbols: [SYMBOL] });
  assert.equal(result.status, 'DATA_FAIL');
  assert.ok(result.errors.includes(`${SYMBOL}:missing_T`));
  assert.ok(result.errors.includes(`${SYMBOL}:insufficient_depth_levels`));
});

test('Tardis native JSONL preserves E/T/local receipt timestamps without inventing sequence fields', () => {
  const book = levels();
  const text = JSON.stringify({
    stream: 'btcusdt@depthSnapshot', generated: true, localTimestamp: (START + 2) * 1000,
    data: { e: 'depthSnapshot', E: START, T: START, s: SYMBOL, lastUpdateId: 100, bids: book.bids, asks: book.asks }
  });
  const records = importTardisNdjson(text);
  assert.equal(records[0].kind, 'snapshot');
  assert.equal(records[0].eventTime, START);
  assert.equal(records[0].transactionTime, START);
  assert.equal(records[0].receivedAt, START + 2);
  assert.equal(records[0].lastUpdateId, 100);
});

test('historical L2 manifest verifies file bytes, provenance and manifest hash', () => {
  const rawManifest = manifest();
  const valid = verifyHistoricalL2Manifest({
    manifest: rawManifest,
    fileContents: new Map([['btc.ndjson', Buffer.from('{"source":"authorized-sample"}\n')]])
  });
  assert.equal(valid.status, 'VALID');
  const tampered = verifyHistoricalL2Manifest({
    manifest: rawManifest,
    fileContents: { 'btc.ndjson': 'tampered\n' }
  });
  assert.equal(tampered.status, 'DATA_FAIL');
  assert.ok(tampered.errors.includes('hash_mismatch:btc.ndjson'));
});

test('historical L2 manifest rejects valid hashes without authorization or license acceptance', () => {
  const unauthorized = buildHistoricalL2Manifest({
    ...manifest(),
    accessAuthorized: false
  });
  const unauthorizedResult = verifyHistoricalL2Manifest({
    manifest: unauthorized,
    fileContents: { 'btc.ndjson': '{"source":"authorized-sample"}\n' }
  });
  assert.equal(unauthorizedResult.status, 'DATA_FAIL');
  assert.equal(unauthorizedResult.decision, 'STOP');
  assert.ok(unauthorizedResult.errors.includes('historical_data_not_authorized'));

  const noLicense = buildHistoricalL2Manifest({
    ...manifest(),
    licenseAccepted: false
  });
  const noLicenseResult = verifyHistoricalL2Manifest({
    manifest: noLicense,
    fileContents: { 'btc.ndjson': '{"source":"authorized-sample"}\n' }
  });
  assert.equal(noLicenseResult.status, 'DATA_FAIL');
  assert.ok(noLicenseResult.errors.includes('historical_license_not_accepted'));

  const tamperedProvenance = manifest();
  tamperedProvenance.provenance.datasetId = 'tampered-dataset';
  const provenanceResult = verifyHistoricalL2Manifest({
    manifest: tamperedProvenance,
    fileContents: { 'btc.ndjson': '{"source":"authorized-sample"}\n' }
  });
  assert.equal(provenanceResult.status, 'DATA_FAIL');
  assert.ok(provenanceResult.errors.includes('manifest_sha256_mismatch'));
});

test('historical L2 metadata audit stays DATA_FAIL without authorized, sequence-complete data', () => {
  const result = auditHistoricalL2Metadata({ metadata: null, requiredSymbols: [SYMBOL] });
  assert.equal(result.status, 'DATA_FAIL');
  assert.equal(result.decision, 'STOP');
  assert.equal(result.pnlComputed, false);
  assert.ok(result.errors.includes('historical_data_not_authorized'));
  const noSequence = auditHistoricalL2Metadata({
    requiredSymbols: [SYMBOL],
    metadata: {
      vendor: 'tardis', authorized: true, dataAvailable: true, licenseAccepted: true,
      format: 'tardis-csv-incremental-book-l2', sequenceFields: false, maxDepthLevels: 1000,
      coverageStart: '2024-01-01T00:00:00.000Z', coverageEndExclusive: '2026-07-01T00:00:00.000Z',
      symbols: [SYMBOL], sourceUrl: 'https://example.invalid', datasetId: 'audit-only'
    }
  });
  assert.equal(noSequence.status, 'DATA_FAIL');
  assert.ok(noSequence.errors.includes('U_u_pu_continuity_not_available'));
});

test('Tardis API key is environment-only and never optional in an authenticated request', () => {
  assert.throws(() => buildTardisAuthHeaders({}), /TARDIS_API_KEY/);
  const headers = buildTardisAuthHeaders({ TARDIS_API_KEY: 'fixture-secret' });
  assert.equal(headers.Authorization, 'Bearer fixture-secret');
});
