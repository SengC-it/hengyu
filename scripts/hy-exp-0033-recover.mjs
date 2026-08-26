import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  assertContiguous,
  mergeUniqueSeries,
  normalizeTimestamp,
  parseFundingArchive,
  parseKlineArchive,
  FIVE_MINUTES
} from '../src/research/archive.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREREG_PATH = path.join(ROOT, 'registry', 'experiments', 'HY-EXP-0033', 'preregistration.json');
const SOURCE_MANIFEST_PATH = path.join(ROOT, 'artifacts', 'HY-EXP-0032', 'data-manifest.json');
const ARTIFACT_DIR = path.join(ROOT, 'artifacts', 'HY-EXP-0033');
const MANIFEST_PATH = path.join(ARTIFACT_DIR, 'data-manifest.json');
const AUDIT_PATH = path.join(ARTIFACT_DIR, 'data-recovery-audit.json');
const RAW_ROOT = path.resolve(ROOT, '..', 'data', 'raw', 'HY-EXP-0033');
const SOURCE_RAW_ROOT = path.resolve(ROOT, '..', 'data', 'raw');
const START = Date.parse('2024-08-26T00:00:00Z');
const END = Date.parse('2026-08-26T00:00:00Z');
const RECOVERY_START = Date.parse('2026-06-29T00:00:00Z');
const RECOVERY_END = Date.parse('2026-06-30T00:00:00Z');
const FIVE_MINUTES_MS = FIVE_MINUTES;
const EXPECTED_ROWS = (END - START) / FIVE_MINUTES_MS;
const REST_BASE = 'https://fapi.binance.com/fapi/v1/markPriceKlines';
const EXPECTED_PREREG_HASH = '295dbeb112f1b46583cbd2ca94e2c7f2d826e82827c16e869b6c96bed327c2fa';
const SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'XRPUSDT', 'SOLUSDT', 'DOGEUSDT', 'LINKUSDT', 'LTCUSDT',
  'ADAUSDT', 'BCHUSDT', 'DOTUSDT', 'AVAXUSDT', 'TRXUSDT', 'ETCUSDT', 'FILUSDT', 'APTUSDT'
];
const hash = input => createHash('sha256').update(input).digest('hex');
const hashFile = file => hash(fs.readFileSync(file));
const iso = value => new Date(value).toISOString();
const filePath = item => path.resolve(ROOT, item.path);
const relativeDataPath = file => path.relative(ROOT, file).replaceAll('\\', '/');

function canonicalDecimal(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`non-finite decimal: ${value}`);
  return number.toString();
}

function validateOhlc(row, label) {
  for (const field of ['openTime', 'closeTime', 'open', 'high', 'low', 'close']) {
    if (!Number.isFinite(row[field])) throw new Error(`${label}: invalid ${field}`);
  }
  if (row.closeTime !== row.openTime + FIVE_MINUTES_MS - 1) throw new Error(`${label}: invalid closeTime`);
  if (row.open <= 0 || row.high <= 0 || row.low <= 0 || row.close <= 0) throw new Error(`${label}: non-positive OHLC`);
  if (row.high < row.low || row.high < Math.max(row.open, row.close) || row.low > Math.min(row.open, row.close)) {
    throw new Error(`${label}: impossible OHLC`);
  }
}

function normalizeRestRows(symbol, value) {
  if (!Array.isArray(value)) throw new Error(`${symbol}: REST payload is not an array`);
  const seen = new Set();
  return value.map((raw, index) => {
    if (!Array.isArray(raw) || raw.length < 7) throw new Error(`${symbol}: malformed REST row ${index}`);
    const row = {
      symbol,
      openTime: normalizeTimestamp(raw[0]),
      open: Number(raw[1]),
      high: Number(raw[2]),
      low: Number(raw[3]),
      close: Number(raw[4]),
      volume: Number(raw[5]),
      closeTime: normalizeTimestamp(raw[6]),
      quoteVolume: Number(raw[7] ?? 0),
      trades: Number(raw[8] ?? 0),
      source: 'BINANCE_PUBLIC_REST_MARK_PRICE_KLINES'
    };
    validateOhlc(row, `${symbol}: REST row ${index}`);
    if (seen.has(row.openTime)) throw new Error(`${symbol}: duplicate REST openTime ${row.openTime}`);
    seen.add(row.openTime);
    if (row.openTime < RECOVERY_START || row.openTime >= RECOVERY_END) {
      throw new Error(`${symbol}: REST recovery row outside registered interval ${row.openTime}`);
    }
    for (const field of ['volume', 'quoteVolume', 'trades']) {
      if (!Number.isFinite(row[field]) || row[field] < 0) throw new Error(`${symbol}: invalid REST ${field}`);
    }
    return row;
  });
}

function normalizedRows(rows) {
  return rows.map(row => ({
    openTime: row.openTime,
    closeTime: row.closeTime,
    open: canonicalDecimal(row.open),
    high: canonicalDecimal(row.high),
    low: canonicalDecimal(row.low),
    close: canonicalDecimal(row.close)
  }));
}

function compareOhlc(left, right, label) {
  if (!right || left.openTime !== right.openTime) throw new Error(`${label}: openTime mismatch`);
  for (const field of ['open', 'high', 'low', 'close']) {
    if (canonicalDecimal(left[field]) !== canonicalDecimal(right[field])) {
      throw new Error(`${label}: ${field} mismatch at ${left.openTime}`);
    }
  }
}

function loadConfig() {
  const preregBuffer = fs.readFileSync(PREREG_PATH);
  const preregHash = hash(preregBuffer);
  if (preregHash !== EXPECTED_PREREG_HASH) throw new Error(`HY-EXP-0033 preregistration hash mismatch: ${preregHash}`);
  const prereg = JSON.parse(preregBuffer.toString('utf8'));
  if (prereg.experimentId !== 'HY-EXP-0033') throw new Error('wrong experiment id');
  if (prereg.freezeContract.outcomesRead || prereg.freezeContract.pnlComputed) throw new Error('preregistration outcome flags are not clean');
  const sourceBuffer = fs.readFileSync(SOURCE_MANIFEST_PATH);
  const sourceManifest = JSON.parse(sourceBuffer.toString('utf8'));
  if (sourceManifest.experimentId !== 'HY-EXP-0032') throw new Error('wrong source manifest experiment');
  if (sourceManifest.outcomeRead || sourceManifest.pnlComputed || sourceManifest.finalOosRead) throw new Error('source manifest is not pre-outcome clean');
  return { prereg, preregHash, sourceManifest, sourceManifestHash: hash(sourceBuffer) };
}

function loadArchiveRows(sourceManifest, symbol, kind) {
  const items = sourceManifest.files
    .filter(item => item.symbol === symbol && item.kind === kind && item.path)
    .sort((left, right) => `${left.period}/${left.cadence}`.localeCompare(`${right.period}/${right.cadence}`));
  if (!items.length) throw new Error(`${symbol}/${kind}: no source files`);
  const chunks = items.map(item => {
    const absolute = filePath(item);
    if (!fs.existsSync(absolute)) throw new Error(`source file unavailable: ${item.path}`);
    const bytes = fs.readFileSync(absolute);
    if (hash(bytes) !== item.sha256) throw new Error(`source hash mismatch: ${item.path}`);
    if (kind === 'funding' && item.cadence === 'rest') {
      return JSON.parse(bytes.toString('utf8')).map(value => ({
        symbol,
        archiveTime: Number(value.fundingTime),
        eventTime: Number(value.fundingTime),
        fundingIntervalHours: 8,
        fundingRate: Number(value.fundingRate)
      }));
    }
    return kind === 'funding' ? parseFundingArchive(bytes, symbol) : parseKlineArchive(bytes, symbol, kind);
  });
  const field = kind === 'funding' ? 'eventTime' : 'openTime';
  return mergeUniqueSeries(chunks, field, `${symbol}/${kind}`).filter(row => row[field] >= START && row[field] < END);
}

function assertFullContinuity(rows, symbol, kind) {
  if (kind === 'funding') {
    if (!rows.length || rows[0].eventTime > START || rows.at(-1).eventTime >= END) {
      throw new Error(`${symbol}/funding: incomplete frozen-window coverage`);
    }
    return { rows: rows.length, first: rows[0].eventTime, last: rows.at(-1).eventTime, continuous: true };
  }
  if (rows.length !== EXPECTED_ROWS) throw new Error(`${symbol}/${kind}: expected ${EXPECTED_ROWS}, received ${rows.length}`);
  if (rows[0]?.openTime !== START || rows.at(-1)?.openTime !== END - FIVE_MINUTES_MS) {
    throw new Error(`${symbol}/${kind}: wrong first/last openTime`);
  }
  assertContiguous(rows, `${symbol}/${kind}`);
  return { rows: rows.length, first: rows[0].openTime, last: rows.at(-1).openTime, continuous: true };
}

async function requestRest(symbol, startTime, endTime, limit, purpose) {
  const requestStartedAt = Date.now();
  const query = new URLSearchParams({ symbol, interval: '5m', startTime: String(startTime), endTime: String(endTime), limit: String(limit) });
  const url = `${REST_BASE}?${query}`;
  const response = await fetch(url);
  const rawBytes = Buffer.from(await response.arrayBuffer());
  const receivedAt = Date.now();
  if (!response.ok) throw new Error(`${symbol}: REST ${purpose} HTTP ${response.status}`);
  const rawSha256 = hash(rawBytes);
  let value;
  try {
    value = JSON.parse(rawBytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${symbol}: REST ${purpose} non-JSON body: ${error.message}`);
  }
  return { symbol, purpose, endpoint: REST_BASE, query: query.toString(), url, requestStartedAt, receivedAt, responseStatus: response.status, rawBytes, rawSha256, value };
}

async function recoverSymbol(symbol, config) {
  const response = await requestRest(symbol, RECOVERY_START, RECOVERY_END - 1, 288, 'registered-recovery');
  const rows = normalizeRestRows(symbol, response.value);
  if (rows.length !== 288) throw new Error(`${symbol}: expected 288 recovery rows, received ${rows.length}`);
  rows.sort((left, right) => left.openTime - right.openTime);
  for (let index = 0; index < rows.length; index++) {
    const expected = RECOVERY_START + index * FIVE_MINUTES_MS;
    if (rows[index].openTime !== expected) throw new Error(`${symbol}: recovery gap/duplicate at ${expected}`);
  }
  const directory = path.join(RAW_ROOT, symbol, 'mark', 'recovery');
  fs.mkdirSync(directory, { recursive: true });
  const rawPath = path.join(directory, 'markPriceKlines-2026-06-29.json');
  const normalizedPath = path.join(directory, 'markPriceKlines-2026-06-29.normalized.json');
  fs.writeFileSync(rawPath, response.rawBytes);
  const normalizedBytes = Buffer.from(`${JSON.stringify(normalizedRows(rows))}\n`);
  fs.writeFileSync(normalizedPath, normalizedBytes);
  const item = {
    symbol,
    kind: 'mark',
    cadence: 'rest-native-recovery',
    period: '2026-06-29',
    url: response.url,
    endpoint: response.endpoint,
    query: response.query,
    requestStartedAt: iso(response.requestStartedAt),
    retrievedAt: iso(response.receivedAt),
    requestStartedAtMs: response.requestStartedAt,
    receivedAtMs: response.receivedAt,
    path: relativeDataPath(rawPath),
    normalizedPath: relativeDataPath(normalizedPath),
    bytes: response.rawBytes.length,
    sha256: response.rawSha256,
    normalizedSha256: hash(normalizedBytes),
    source: 'BINANCE_PUBLIC_REST_MARK_PRICE_KLINES',
    sourceSegment: 'REST_NATIVE_RECOVERY',
    rowCount: rows.length,
    firstOpenTime: rows[0].openTime,
    lastOpenTime: rows.at(-1).openTime
  };
  return { item, rows, response };
}

async function parityWindow(symbol, archiveRows, start, end, label) {
  const response = await requestRest(symbol, start, end - 1, (end - start) / FIVE_MINUTES_MS, `parity-${label}`);
  const restRows = normalizeRestRowsForParity(symbol, response.value, start, end);
  const expectedRows = archiveRows.filter(row => row.openTime >= start && row.openTime < end);
  if (expectedRows.length !== restRows.length) throw new Error(`${symbol}: ${label} parity row count mismatch`);
  expectedRows.sort((left, right) => left.openTime - right.openTime);
  restRows.sort((left, right) => left.openTime - right.openTime);
  if (expectedRows.some((row, index) => row.openTime !== restRows[index]?.openTime)) {
    throw new Error(`${symbol}: ${label} parity openTime set mismatch`);
  }
  const archiveByTime = new Map(expectedRows.map(row => [row.openTime, row]));
  for (const row of restRows) compareOhlc(row, archiveByTime.get(row.openTime), `${symbol}/${label}`);
  return {
    symbol,
    label,
    start: iso(start),
    endExclusive: iso(end),
    rowCount: restRows.length,
    archiveOpenTimes: expectedRows.map(row => row.openTime),
    restOpenTimes: restRows.map(row => row.openTime),
    archiveVsRestEqual: true,
    restUrl: response.url,
    restQuery: response.query,
    requestStartedAt: iso(response.requestStartedAt),
    receivedAt: iso(response.receivedAt),
    rawSha256: response.rawSha256
  };
}

function normalizeRestRowsForParity(symbol, value, start, end) {
  if (!Array.isArray(value)) throw new Error(`${symbol}: parity payload is not an array`);
  const seen = new Set();
  return value.map((raw, index) => {
    if (!Array.isArray(raw) || raw.length < 7) throw new Error(`${symbol}: malformed parity row ${index}`);
    const row = {
      symbol,
      openTime: normalizeTimestamp(raw[0]),
      open: Number(raw[1]),
      high: Number(raw[2]),
      low: Number(raw[3]),
      close: Number(raw[4]),
      closeTime: normalizeTimestamp(raw[6])
    };
    validateOhlc(row, `${symbol}: parity row ${index}`);
    if (row.openTime < start || row.openTime >= end) throw new Error(`${symbol}: parity row outside requested window`);
    if (seen.has(row.openTime)) throw new Error(`${symbol}: duplicate parity openTime ${row.openTime}`);
    seen.add(row.openTime);
    return row;
  });
}

function buildManifest(config, sourceRows, recovered, continuity, parity, startedAt) {
  const sourceFiles = config.sourceManifest.files.map(item => ({
    ...item,
    source: 'HY-EXP-0032_HASH_LOCKED_ARCHIVE',
    sourceSegment: item.kind === 'mark' && item.period === '2026-06' ? 'ARCHIVE_NATIVE_GAP' : 'ARCHIVE_NATIVE'
  }));
  const recoveryFiles = recovered.map(row => row.item);
  return {
    schemaVersion: 1,
    experimentId: 'HY-EXP-0033',
    artifactType: 'HY_EXP_0033_RECOVERED_DATA_MANIFEST',
    generatedAt: new Date().toISOString(),
    preregistrationCommit: 'd6cbcedd76a85c7844634377ddd6ecaa131a4795',
    preregistrationSha256: config.preregHash,
    sourceExperiment: 'HY-EXP-0032',
    sourceManifestSha256: config.sourceManifestHash,
    sourceManifestUnmodified: true,
    source: 'Binance official public USD-M archive plus the registered native REST recovery only',
    window: { start: iso(START), endExclusive: iso(END) },
    symbols: SYMBOLS,
    requiredStreams: ['contract.5m', 'mark.5m', 'funding'],
    registeredRecovery: {
      intervalStart: iso(RECOVERY_START),
      intervalEndExclusive: iso(RECOVERY_END),
      symbols: SYMBOLS,
      rowsPerSymbol: 288,
      source: 'BINANCE_PUBLIC_REST_MARK_PRICE_KLINES',
      noInterpolation: true,
      noForwardFill: true,
      noSyntheticRows: true
    },
    archiveGap: {
      classification: 'ARCHIVE_NATIVE_GAP',
      intervalStart: iso(RECOVERY_START),
      intervalEndExclusive: iso(RECOVERY_END),
      missingRowsPerSymbol: 288,
      symbols: SYMBOLS
    },
    files: [...sourceFiles, ...recoveryFiles],
    sourceRows,
    continuity,
    parity,
    missingCount: 0,
    coverageStatus: 'FULL_CONTINUOUS_AFTER_REGISTERED_NATIVE_RECOVERY',
    outcomeRead: false,
    pnlComputed: false,
    finalOosRead: false,
    developmentAllowed: true,
    safety: { paperOnly: true, signalOnly: true, gmail: false, scheduler: false, realEmail: false, autoTrading: false, accountApi: false, orderApi: false, finalOosRead: false, productionDeploy: false }
  };
}

async function main() {
  const startedAt = new Date().toISOString();
  const config = loadConfig();
  const recovered = [];
  const parity = [];
  const sourceRows = { contract: {}, markArchive: {}, funding: {} };
  const continuity = { contract: {}, mark: {}, funding: {}, combinedMark: {} };
  try {
    for (const symbol of SYMBOLS) {
      const contract = loadArchiveRows(config.sourceManifest, symbol, 'contract');
      const markArchive = loadArchiveRows(config.sourceManifest, symbol, 'mark');
      const funding = loadArchiveRows(config.sourceManifest, symbol, 'funding');
      sourceRows.contract[symbol] = assertFullContinuity(contract, symbol, 'contract');
      sourceRows.markArchive[symbol] = { rows: markArchive.length, first: markArchive[0]?.openTime, last: markArchive.at(-1)?.openTime, archiveGapRows: 288 };
      sourceRows.funding[symbol] = assertFullContinuity(funding, symbol, 'funding');
      continuity.contract[symbol] = sourceRows.contract[symbol];
      continuity.funding[symbol] = sourceRows.funding[symbol];
      const recoveredSymbol = await recoverSymbol(symbol, config);
      recovered.push(recoveredSymbol);
      const combinedMark = mergeUniqueSeries([markArchive, recoveredSymbol.rows], 'openTime', `${symbol}/combined-mark`);
      const combined = combinedMark.filter(row => row.openTime >= START && row.openTime < END);
      continuity.mark[symbol] = assertFullContinuity(combined, symbol, 'mark');
      continuity.combinedMark[symbol] = { archiveRows: markArchive.length, recoveryRows: recoveredSymbol.rows.length, combinedRows: combined.length, continuous: true };
      parity.push(await parityWindow(symbol, markArchive, Date.parse('2026-06-28T23:00:00Z'), RECOVERY_START, 'pre-gap'));
      parity.push(await parityWindow(symbol, markArchive, RECOVERY_END, Date.parse('2026-06-30T01:00:00Z'), 'post-gap'));
    }
    const manifest = buildManifest(config, sourceRows, recovered, continuity, parity, startedAt);
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
    const manifestSha256 = hashFile(MANIFEST_PATH);
    const audit = {
      schemaVersion: 1,
      artifactType: 'HY_EXP_0033_DATA_RECOVERY_AUDIT',
      experimentId: 'HY-EXP-0033',
      status: 'DATA_LOCK_CANDIDATE',
      preregistrationCommit: 'd6cbcedd76a85c7844634377ddd6ecaa131a4795',
      preregistrationSha256: config.preregHash,
      sourceManifestSha256: config.sourceManifestHash,
      recoveryPolicy: config.prereg.dataPolicy.recoveryPolicy,
      recovery: recovered.map(item => item.item),
      parity,
      continuity,
      all16Symbols: true,
      recoveryRows: recovered.reduce((total, item) => total + item.rows.length, 0),
      markRowsExpected: EXPECTED_ROWS * SYMBOLS.length,
      markRowsActual: Object.values(continuity.mark).reduce((total, item) => total + item.rows, 0),
      contractRowsExpected: EXPECTED_ROWS * SYMBOLS.length,
      contractRowsActual: Object.values(continuity.contract).reduce((total, item) => total + item.rows, 0),
      gapCount: 0,
      duplicateCount: 0,
      outOfRangeCount: 0,
      parityMismatchCount: 0,
      continuous: true,
      manifestSha256,
      outcomeRead: false,
      pnlComputed: false,
      finalOosRead: false,
      developmentAllowed: true,
      safety: { paperOnly: true, signalOnly: true, gmail: false, scheduler: false, realEmail: false, autoTrading: false, accountApi: false, orderApi: false, finalOosRead: false, productionDeploy: false }
    };
    fs.writeFileSync(AUDIT_PATH, `${JSON.stringify(audit, null, 2)}\n`);
    console.log(JSON.stringify({ status: audit.status, recoveryRows: audit.recoveryRows, symbols: SYMBOLS.length, parityChecks: parity.length, markRows: audit.markRowsActual, contractRows: audit.contractRowsActual, gapCount: audit.gapCount, duplicateCount: audit.duplicateCount, manifestSha256 }, null, 2));
  } catch (error) {
    const audit = {
      schemaVersion: 1,
      artifactType: 'HY_EXP_0033_DATA_RECOVERY_AUDIT',
      experimentId: 'HY-EXP-0033',
      status: 'DATA_FAIL',
      reason: error.message,
      preregistrationCommit: 'd6cbcedd76a85c7844634377ddd6ecaa131a4795',
      preregistrationSha256: config.preregHash,
      sourceManifestSha256: config.sourceManifestHash,
      outcomeRead: false,
      pnlComputed: false,
      finalOosRead: false,
      safety: { paperOnly: true, signalOnly: true, gmail: false, scheduler: false, realEmail: false, autoTrading: false, accountApi: false, orderApi: false, finalOosRead: false, productionDeploy: false }
    };
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    fs.writeFileSync(AUDIT_PATH, `${JSON.stringify(audit, null, 2)}\n`);
    console.error(JSON.stringify(audit, null, 2));
    process.exitCode = 1;
  }
}

main();
