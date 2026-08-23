import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HY_EXP_0028_EXPERIMENT_ID,
  HY_EXP_0028_HOLDOUT_END,
  HY_EXP_0028_HOLDOUT_START,
  HY_EXP_0028_SYMBOLS,
  canonicalJson,
  sha256
} from '../src/research/hy-exp-0028.mjs';
import { runHyExp0028Holdout } from '../src/research/hy-exp-0028.mjs';
import { appendRegistryEvent } from './registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW_ROOT = path.join(ROOT, 'data', 'raw', HY_EXP_0028_EXPERIMENT_ID, 'holdout');
const ARTIFACT_ROOT = path.join(ROOT, 'artifacts', HY_EXP_0028_EXPERIMENT_ID);
const MANIFEST_PATH = path.join(ARTIFACT_ROOT, 'holdout-data-manifest.json');
const API_ROOT = 'https://fapi.binance.com';
const FIVE_MINUTES = 5 * 60 * 1_000;
const DAY = 24 * 60 * 60 * 1_000;
const WARMUP_START = HY_EXP_0028_HOLDOUT_START - 32 * DAY;
const REQUEST_END = HY_EXP_0028_HOLDOUT_END - 1;
const KLINE_LIMIT = 1_500;
const FUNDING_LIMIT = 1_000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function writeExclusive(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const handle = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeSync(handle, content, null, 'utf8');
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

async function fetchJson(url) {
  const requestStartedAt = Date.now();
  const response = await fetch(url);
  const data = await response.json();
  const receivedAt = Date.now();
  if (!response.ok) throw new Error(`Binance public request failed ${response.status}: ${JSON.stringify(data)}`);
  return { data, requestStartedAt, receivedAt };
}

function apiUrl(pathname, params) {
  const url = new URL(`${API_ROOT}${pathname}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url.toString();
}

function assertKlineBatch(symbol, rows, cursor) {
  if (!Array.isArray(rows) || !rows.length) throw new Error(`${symbol}: empty kline API page at ${cursor}`);
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 9) throw new Error(`${symbol}: malformed kline API row`);
    if (!Number.isFinite(Number(row[0])) || !Number.isFinite(Number(row[6]))) throw new Error(`${symbol}: invalid kline timestamp`);
    if (Number(row[6]) !== Number(row[0]) + FIVE_MINUTES - 1) throw new Error(`${symbol}: non-5m kline close time`);
  }
}

async function downloadKlines(symbol) {
  const file = path.join(RAW_ROOT, 'klines', `${symbol}-5m.ndjson`);
  const lines = [];
  let cursor = WARMUP_START;
  let rows = 0;
  let pages = 0;
  while (cursor < HY_EXP_0028_HOLDOUT_END) {
    const response = await fetchJson(apiUrl('/fapi/v1/klines', {
      symbol,
      interval: '5m',
      startTime: cursor,
      endTime: REQUEST_END,
      limit: KLINE_LIMIT
    }));
    assertKlineBatch(symbol, response.data, cursor);
    const filtered = response.data.filter(row => Number(row[0]) >= WARMUP_START && Number(row[0]) < HY_EXP_0028_HOLDOUT_END);
    lines.push(JSON.stringify({
      experimentId: HY_EXP_0028_EXPERIMENT_ID,
      kind: 'contract-price-5m',
      symbol,
      interval: '5m',
      endpoint: '/fapi/v1/klines',
      requestStartedAt: response.requestStartedAt,
      receivedAt: response.receivedAt,
      request: { startTime: cursor, endTime: REQUEST_END, limit: KLINE_LIMIT },
      rows: filtered
    }));
    pages++;
    rows += filtered.length;
    const lastOpenTime = Number(response.data.at(-1)[0]);
    if (!(lastOpenTime >= cursor)) throw new Error(`${symbol}: kline pagination did not advance`);
    cursor = lastOpenTime + FIVE_MINUTES;
    if (response.data.length < KLINE_LIMIT && cursor >= HY_EXP_0028_HOLDOUT_END) break;
    await sleep(100);
  }
  writeExclusive(file, `${lines.join('\n')}\n`);
  return { file, rows, pages };
}

async function downloadFunding(symbol) {
  const file = path.join(RAW_ROOT, 'funding', `${symbol}-funding.ndjson`);
  const lines = [];
  let cursor = WARMUP_START;
  let rows = 0;
  let pages = 0;
  while (cursor < HY_EXP_0028_HOLDOUT_END) {
    const response = await fetchJson(apiUrl('/fapi/v1/fundingRate', {
      symbol,
      startTime: cursor,
      endTime: REQUEST_END,
      limit: FUNDING_LIMIT
    }));
    if (!Array.isArray(response.data) || !response.data.length) break;
    const filtered = response.data.filter(row => Number(row.fundingTime) >= WARMUP_START && Number(row.fundingTime) < HY_EXP_0028_HOLDOUT_END);
    lines.push(JSON.stringify({
      experimentId: HY_EXP_0028_EXPERIMENT_ID,
      kind: 'funding',
      symbol,
      endpoint: '/fapi/v1/fundingRate',
      requestStartedAt: response.requestStartedAt,
      receivedAt: response.receivedAt,
      request: { startTime: cursor, endTime: REQUEST_END, limit: FUNDING_LIMIT },
      rows: filtered
    }));
    pages++;
    rows += filtered.length;
    const lastFundingTime = Number(response.data.at(-1).fundingTime);
    if (!(lastFundingTime >= cursor)) throw new Error(`${symbol}: funding pagination did not advance`);
    cursor = lastFundingTime + 1;
    if (response.data.length < FUNDING_LIMIT && cursor >= HY_EXP_0028_HOLDOUT_END) break;
    await sleep(100);
  }
  if (!lines.length) throw new Error(`${symbol}: no funding data returned`);
  writeExclusive(file, `${lines.join('\n')}\n`);
  return { file, rows, pages };
}

async function downloadExchangeInfo() {
  const response = await fetchJson(apiUrl('/fapi/v1/exchangeInfo', {}));
  const selected = (response.data.symbols ?? []).filter(row => HY_EXP_0028_SYMBOLS.includes(row.symbol));
  if (selected.length !== HY_EXP_0028_SYMBOLS.length) throw new Error('exchangeInfo does not cover all fixed holdout symbols');
  for (const row of selected) {
    if (row.status !== 'TRADING' || row.contractType !== 'PERPETUAL' || row.quoteAsset !== 'USDT') {
      throw new Error(`${row.symbol}: current public metadata is not a USDT perpetual`);
    }
  }
  const file = path.join(RAW_ROOT, 'metadata', 'exchange-info.json');
  writeExclusive(file, `${JSON.stringify({
    experimentId: HY_EXP_0028_EXPERIMENT_ID,
    kind: 'causal-public-metadata',
    endpoint: '/fapi/v1/exchangeInfo',
    requestStartedAt: response.requestStartedAt,
    receivedAt: response.receivedAt,
    usedForHistoricalEligibility: false,
    data: { symbols: selected, serverTime: response.data.serverTime ?? null }
  }, null, 2)}\n`);
  return { file, symbols: selected.length };
}

function relativeFile(file) {
  return path.relative(ROOT, file).replaceAll('\\', '/');
}

function fileEntry(file, kind, symbol = null) {
  const bytes = fs.readFileSync(file);
  return {
    path: relativeFile(file),
    kind,
    ...(symbol ? { symbol } : {}),
    bytes: bytes.length,
    sha256: sha256(bytes)
  };
}

async function download() {
  if (fs.existsSync(MANIFEST_PATH)) throw new Error('HY-EXP-0028 holdout manifest already exists; immutable rerun refused');
  if (fs.existsSync(RAW_ROOT)) throw new Error('HY-EXP-0028 holdout raw root already exists; append-only rerun refused');
  fs.mkdirSync(RAW_ROOT, { recursive: true });
  const coverage = {};
  for (const symbol of HY_EXP_0028_SYMBOLS) {
    const [kline, funding] = await Promise.all([downloadKlines(symbol), downloadFunding(symbol)]);
    coverage[symbol] = { klineRows: kline.rows, klinePages: kline.pages, fundingRows: funding.rows, fundingPages: funding.pages };
  }
  const exchangeInfo = await downloadExchangeInfo();
  const files = [
    ...HY_EXP_0028_SYMBOLS.flatMap(symbol => [
      fileEntry(path.join(RAW_ROOT, 'klines', `${symbol}-5m.ndjson`), 'contract-price-5m', symbol),
      fileEntry(path.join(RAW_ROOT, 'funding', `${symbol}-funding.ndjson`), 'funding', symbol)
    ]),
    fileEntry(exchangeInfo.file, 'causal-public-metadata')
  ];
  const body = {
    artifactType: 'HY_EXP_0028_HOLDOUT_DATA_MANIFEST',
    experimentId: HY_EXP_0028_EXPERIMENT_ID,
    status: 'DATA_LOCKED',
    immutable: true,
    source: 'Binance public USD-M REST API',
    authorization: 'PUBLIC_NO_ACCOUNT_API',
    windowStart: new Date(HY_EXP_0028_HOLDOUT_START).toISOString(),
    windowEndExclusive: new Date(HY_EXP_0028_HOLDOUT_END).toISOString(),
    warmupStart: new Date(WARMUP_START).toISOString(),
    requestEndInclusive: new Date(REQUEST_END).toISOString(),
    symbols: [...HY_EXP_0028_SYMBOLS],
    streams: ['contract-price-5m', 'funding', 'causal-public-metadata'],
    noProxyDepth: true,
    noPrivateApi: true,
    noAccountApi: true,
    noOutcomeOutsideWindow: true,
    performanceUsesSignalWindowOnly: true,
    exchangeInfoUsedForHistoricalEligibility: false,
    coverage,
    files,
    lockedAt: new Date().toISOString()
  };
  const manifest = { ...body, manifestSha256: sha256(Buffer.from(canonicalJson(body))) };
  writeExclusive(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ manifestPath: relativeFile(MANIFEST_PATH), manifestSha256: manifest.manifestSha256, coverage, files }, null, 2));
}

function run() {
  const resultPath = path.join(ARTIFACT_ROOT, 'holdout-result.json');
  if (fs.existsSync(resultPath)) throw new Error('HY-EXP-0028 holdout result already exists; immutable rerun refused');
  const result = runHyExp0028Holdout({ root: ROOT, manifestPath: path.relative(ROOT, MANIFEST_PATH) });
  writeExclusive(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  if (!result.holdoutPass) {
    const failedGates = Object.entries(result.metrics.gates.checks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name);
    const closure = {
      experimentId: HY_EXP_0028_EXPERIMENT_ID,
      status: 'FAILED',
      terminal: true,
      failureReason: 'FRESH_HOLDOUT_RELEASE_GATES_FAILED',
      holdoutResultPath: relativeFile(resultPath),
      holdoutResultSha256: sha256(fs.readFileSync(resultPath)),
      failedGates,
      holdoutPass: false,
      experimentalReleaseReady: false,
      finalOosRead: false,
      productionDeploy: false,
      signalOnly: true,
      paperOnly: true,
      noRuleB: true,
      noParameterRescue: true
    };
    const closurePath = path.join(ARTIFACT_ROOT, 'closure.json');
    writeExclusive(closurePath, `${JSON.stringify(closure, null, 2)}\n`);
    const event = appendRegistryEvent({
      root: ROOT,
      experimentId: HY_EXP_0028_EXPERIMENT_ID,
      eventType: 'failed',
      payloadPath: relativeFile(closurePath),
      note: 'HY-EXP-0028 fresh Rule A holdout gates failed; terminal paper-only closure, no live deployment or automatic trading.'
    });
    console.log(JSON.stringify({ resultPath: relativeFile(resultPath), closurePath: relativeFile(closurePath), failedGates, registry: event }, null, 2));
    return;
  }
  console.log(JSON.stringify({ resultPath: relativeFile(resultPath), holdoutPass: true, experimentalReleaseReady: true, note: 'Prepare live-ready signal path in a reviewed Commit B; do not deploy automatically.' }, null, 2));
}

async function main() {
  const [command] = process.argv.slice(2);
  if (command === 'download') {
    await download();
    return;
  }
  if (command === 'run') {
    run();
    return;
  }
  throw new Error('usage: node scripts/hy-exp-0028-holdout.mjs download | run');
}

main().catch(error => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
