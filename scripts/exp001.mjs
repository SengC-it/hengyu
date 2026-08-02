import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  applyExecution,
  detectSignals,
  developmentScreen,
  parseFundingArchive,
  parseKlineArchive,
  summarizeTrades
} from '../src/research/exp001.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
const EXPERIMENT_ID = 'HY-EXP-0001';
const RAW_DIR = path.join(ROOT, 'data', 'raw', EXPERIMENT_ID);
const ARTIFACT_DIR = path.join(ROOT, 'artifacts', EXPERIMENT_ID);
const MANIFEST_FILE = path.join(ARTIFACT_DIR, 'data-manifest.json');
const RESULT_FILE = path.join(ARTIFACT_DIR, 'result.json');
const TRADES_FILE = path.join(ARTIFACT_DIR, 'trades.csv');
const COMPLETION_FILE = path.join(ARTIFACT_DIR, 'completion.json');
const PREREGISTRATION_FILE = path.join(ROOT, 'registry', 'experiments', EXPERIMENT_ID, 'preregistration.json');

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function verifyHash(file, expected) {
  if (!fs.existsSync(file)) throw new Error(`frozen artifact is unavailable: ${path.relative(ROOT, file)}`);
  const actual = sha256(fs.readFileSync(file));
  if (actual !== expected) throw new Error(`frozen artifact hash mismatch: ${path.relative(ROOT, file)}`);
}

function verifyCompletion() {
  const completion = JSON.parse(fs.readFileSync(COMPLETION_FILE, 'utf8'));
  for (const artifact of completion.artifacts) {
    verifyHash(path.join(ROOT, artifact.path), artifact.sha256);
  }
  return completion;
}

function verifyLockedManifest() {
  const preregistration = fs.readFileSync(PREREGISTRATION_FILE);
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  if (manifest.preregistration_sha256 !== sha256(preregistration)) {
    throw new Error('locked manifest does not match the preregistration');
  }
  for (const item of manifest.files.filter(file => file.status === 200)) {
    verifyHash(path.join(ROOT, item.path), item.sha256);
  }
  return manifest;
}

function monthKeys(start, end) {
  const output = [];
  const cursor = new Date(`${start}-01T00:00:00Z`);
  const last = new Date(`${end}-01T00:00:00Z`);
  while (cursor <= last) {
    output.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return output;
}

async function mapLimit(items, limit, mapper) {
  const output = Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      output[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return output;
}

async function fetchArchive(url) {
  let lastError;
  for (const delay of [0, 500, 1000, 2000, 4000]) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': 'hengyu-research/0.1 research-only' },
        signal: AbortSignal.timeout(30000)
      });
      if (response.status === 404) return { status: 404, buffer: null };
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}: ${url}`);
        if (response.status !== 429 && response.status < 500) throw lastError;
        continue;
      }
      return { status: response.status, buffer: Buffer.from(await response.arrayBuffer()) };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error(`download failed: ${url}`);
}

function archiveSpec(symbol, month, kind) {
  if (kind === 'kline') {
    const name = `${symbol}-5m-${month}.zip`;
    return {
      kind,
      symbol,
      month,
      name,
      url: `https://data.binance.vision/data/futures/um/monthly/klines/${symbol}/5m/${name}`
    };
  }
  const name = `${symbol}-fundingRate-${month}.zip`;
  return {
    kind,
    symbol,
    month,
    name,
    url: `https://data.binance.vision/data/futures/um/monthly/fundingRate/${symbol}/${name}`
  };
}

async function downloadOne(spec) {
  const directory = path.join(RAW_DIR, spec.symbol, spec.kind);
  const file = path.join(directory, spec.name);
  fs.mkdirSync(directory, { recursive: true });
  if (fs.existsSync(file)) {
    const buffer = fs.readFileSync(file);
    return {
      ...spec,
      status: 200,
      cached: true,
      bytes: buffer.length,
      sha256: sha256(buffer),
      path: path.relative(ROOT, file).replaceAll('\\', '/')
    };
  }
  const fetched = await fetchArchive(spec.url);
  if (!fetched.buffer) {
    return { ...spec, status: fetched.status, cached: false, bytes: 0, sha256: null, path: null };
  }
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, fetched.buffer);
  fs.renameSync(temporary, file);
  return {
    ...spec,
    status: fetched.status,
    cached: false,
    bytes: fetched.buffer.length,
    sha256: sha256(fetched.buffer),
    path: path.relative(ROOT, file).replaceAll('\\', '/')
  };
}

async function download() {
  if (fs.existsSync(MANIFEST_FILE)) {
    const manifest = verifyLockedManifest();
    if (fs.existsSync(COMPLETION_FILE)) verifyCompletion();
    console.log(JSON.stringify({
      manifest: path.relative(ROOT, MANIFEST_FILE).replaceAll('\\', '/'),
      frozen: true,
      requestedFiles: manifest.requested_files,
      availableFiles: manifest.available_files,
      missingFiles: manifest.missing_files,
      totalBytes: manifest.total_bytes
    }, null, 2));
    return;
  }
  if (fs.existsSync(COMPLETION_FILE)) {
    throw new Error('completion exists without its locked data manifest');
  }
  const preregistration = JSON.parse(fs.readFileSync(PREREGISTRATION_FILE, 'utf8'));
  const months = monthKeys(
    preregistration.data.download_start_month,
    preregistration.data.download_end_month
  );
  const specs = preregistration.symbols.flatMap(symbol => months.flatMap(month => [
    archiveSpec(symbol, month, 'kline'),
    archiveSpec(symbol, month, 'funding')
  ]));
  let completed = 0;
  const files = await mapLimit(specs, 12, async spec => {
    const row = await downloadOne(spec);
    completed++;
    if (completed % 50 === 0 || completed === specs.length) {
      console.error(`downloaded or checked ${completed}/${specs.length}`);
    }
    return row;
  });
  const manifest = {
    experiment_id: EXPERIMENT_ID,
    generated_at: new Date().toISOString(),
    source: 'Binance official public archive',
    preregistration_sha256: sha256(fs.readFileSync(PREREGISTRATION_FILE)),
    requested_files: specs.length,
    available_files: files.filter(file => file.status === 200).length,
    missing_files: files.filter(file => file.status === 404).length,
    total_bytes: files.reduce((total, file) => total + file.bytes, 0),
    files: files.sort((a, b) =>
      a.symbol.localeCompare(b.symbol)
      || a.month.localeCompare(b.month)
      || a.kind.localeCompare(b.kind))
  };
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({
    manifest: path.relative(ROOT, MANIFEST_FILE).replaceAll('\\', '/'),
    requestedFiles: manifest.requested_files,
    availableFiles: manifest.available_files,
    missingFiles: manifest.missing_files,
    totalBytes: manifest.total_bytes
  }, null, 2));
}

function loadAndVerify(manifest, symbol, kind) {
  const files = manifest.files
    .filter(file => file.symbol === symbol && file.kind === kind && file.status === 200)
    .sort((a, b) => a.month.localeCompare(b.month));
  const rows = [];
  for (const item of files) {
    const file = path.join(ROOT, item.path);
    const buffer = fs.readFileSync(file);
    const actualHash = sha256(buffer);
    if (actualHash !== item.sha256) throw new Error(`data hash mismatch: ${item.path}`);
    rows.push(...(kind === 'kline'
      ? parseKlineArchive(buffer, symbol)
      : parseFundingArchive(buffer)));
  }
  const timeField = kind === 'kline' ? 'openTime' : 'fundingTime';
  const byTime = new Map(rows.map(row => [row[timeField], row]));
  return [...byTime.values()].sort((a, b) => a[timeField] - b[timeField]);
}

function csvCell(value) {
  if (value == null) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function writeTrades(tradesByScenario) {
  const columns = [
    'scenario',
    'symbol',
    'side',
    'signalTime',
    'entryTime',
    'exitTime',
    'entryPrice',
    'exitPrice',
    'entryFill',
    'exitFill',
    'shockReturn',
    'shockZ',
    'quoteVolumeMultiple',
    'takerImbalance',
    'directionalWick',
    'grossPriceReturn',
    'priceReturnAfterSlippage',
    'fees',
    'fundingReturn',
    'netReturn'
  ];
  const rows = [columns.join(',')];
  for (const trades of Object.values(tradesByScenario)) {
    for (const trade of trades) rows.push(columns.map(column => csvCell(trade[column])).join(','));
  }
  fs.writeFileSync(TRADES_FILE, `${rows.join('\n')}\n`);
}

function run() {
  if (fs.existsSync(COMPLETION_FILE)) {
    const completion = verifyCompletion();
    verifyLockedManifest();
    const result = JSON.parse(fs.readFileSync(RESULT_FILE, 'utf8'));
    console.log(JSON.stringify({
      result: path.relative(ROOT, RESULT_FILE).replaceAll('\\', '/'),
      frozen: true,
      conclusion: result.conclusion,
      records: completion.artifacts.length
    }, null, 2));
    return;
  }
  if (fs.existsSync(RESULT_FILE) || fs.existsSync(TRADES_FILE)) {
    throw new Error('unfinalized result artifacts already exist; refusing to overwrite');
  }
  const preregistration = JSON.parse(fs.readFileSync(PREREGISTRATION_FILE, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  if (manifest.missing_files > 0) {
    throw new Error(`data manifest has ${manifest.missing_files} missing files; record a failed event`);
  }
  const evaluationStart = Date.parse(preregistration.data.evaluation_start_utc);
  const evaluationEnd = Date.parse(preregistration.data.evaluation_end_exclusive_utc);
  const allSignals = [];
  const fundingBySymbol = {};
  const coverage = {};
  for (const symbol of preregistration.symbols) {
    const bars = loadAndVerify(manifest, symbol, 'kline');
    const funding = loadAndVerify(manifest, symbol, 'funding');
    fundingBySymbol[symbol] = funding;
    const signals = detectSignals(bars, {
      evaluationStart,
      evaluationEnd,
      returnBars: preregistration.signal.return_window_bars,
      volatilityLookback: preregistration.signal.volatility_lookback_bars,
      minimumAbsoluteReturn: preregistration.signal.minimum_absolute_log_return,
      volatilityMultiple: preregistration.signal.volatility_multiple,
      volumeLookback: preregistration.signal.quote_volume_lookback_bars,
      minimumVolumeMultiple: preregistration.signal.minimum_quote_volume_multiple,
      minimumImbalance: preregistration.signal.minimum_absolute_taker_imbalance,
      minimumWick: preregistration.signal.minimum_directional_wick_fraction,
      holdBars: preregistration.signal.hold_bars
    });
    allSignals.push(...signals);
    coverage[symbol] = {
      bars: bars.length,
      firstBar: bars[0]?.openTime ?? null,
      lastBar: bars.at(-1)?.openTime ?? null,
      fundingRows: funding.length,
      signals: signals.length
    };
  }
  allSignals.sort((a, b) => a.signalTime - b.signalTime || a.symbol.localeCompare(b.symbol));
  const scenarios = Object.entries(preregistration.execution.slippage_per_side).map(([name, slippage]) => ({
    name,
    feePerSide: preregistration.execution.fee_per_side,
    slippagePerSide: slippage
  }));
  const tradesByScenario = Object.fromEntries(scenarios.map(scenario => [
    scenario.name,
    allSignals.map(signal => applyExecution(signal, fundingBySymbol[signal.symbol], scenario))
  ]));
  const summaries = Object.fromEntries(Object.entries(tradesByScenario).map(([name, trades]) => [
    name,
    summarizeTrades(trades)
  ]));
  const screen = developmentScreen(summaries.stress, {
    minimumTrades: preregistration.development_screen.minimum_trades,
    minimumProfitFactor: preregistration.development_screen.minimum_stress_profit_factor,
    minimumProfitableSymbols: preregistration.development_screen.minimum_profitable_symbols,
    minimumProfitableHalfYears: preregistration.development_screen.minimum_profitable_half_years
  });
  const result = {
    experiment_id: EXPERIMENT_ID,
    generated_at: new Date().toISOString(),
    evidence_class: preregistration.evidence_class,
    conclusion: screen.pass
      ? 'DEVELOPMENT_SCREEN_PASS_NOT_OUT_OF_SAMPLE'
      : 'EXACT_SPECIFICATION_ELIMINATED',
    preregistration_sha256: sha256(fs.readFileSync(PREREGISTRATION_FILE)),
    data_manifest_sha256: sha256(fs.readFileSync(MANIFEST_FILE)),
    code: {
      runtime: process.version,
      command: 'npm run exp:001:run'
    },
    coverage,
    rawSignals: allSignals.length,
    summaries,
    developmentScreen: screen,
    limitations: [
      'All observations are exposed development data and cannot prove out-of-sample profitability.',
      'The fixed eight-symbol diagnostic panel is not a point-in-time full-market universe.',
      'Kline quote volume and taker imbalance are proxies; historical liquidation order flow and order-book depth are absent.',
      'Max drawdown is reported in cumulative equal-notional return units ordered by exit time, not as a deployable portfolio equity drawdown.',
      'A passing screen only permits a broader pre-registered development test.'
    ],
    artifacts: {
      manifest: path.relative(ROOT, MANIFEST_FILE).replaceAll('\\', '/'),
      trades: path.relative(ROOT, TRADES_FILE).replaceAll('\\', '/')
    }
  };
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeTrades(tradesByScenario);
  fs.writeFileSync(RESULT_FILE, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({
    result: path.relative(ROOT, RESULT_FILE).replaceAll('\\', '/'),
    trades: allSignals.length,
    conclusion: result.conclusion,
    base: summaries.base,
    stress: summaries.stress,
    extreme: summaries.extreme,
    failures: screen.failures
  }, null, 2));
}

function main() {
  const command = process.argv[2];
  if (command === 'download') return download();
  if (command === 'run') return run();
  throw new Error('usage: exp001.mjs download | run');
}

try {
  await main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
