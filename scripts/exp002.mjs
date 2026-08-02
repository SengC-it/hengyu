import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  assertContiguous,
  mergeUniqueSeries,
  parseFundingArchive,
  parseKlineArchive
} from '../src/research/archive.mjs';
import {
  applyExecution,
  detectFundingUnwindSignals,
  developmentScreen,
  summarizeFundingTrades
} from '../src/research/exp002.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
const COMMAND = process.argv[2];
const REQUESTED_EXPERIMENT_ID = /^HY-EXP-\d{4}$/.test(process.argv[3] ?? '')
  ? process.argv[3]
  : null;
const EXPERIMENT_ID = REQUESTED_EXPERIMENT_ID ?? 'HY-EXP-0002';
const RAW_DIR = path.join(ROOT, 'data', 'raw', EXPERIMENT_ID);
const REUSED_RAW_DIR = path.join(ROOT, 'data', 'raw', 'HY-EXP-0001');
const REUSED_PREMIUM_RAW_DIR = path.join(ROOT, 'data', 'raw', 'HY-EXP-0002');
const ARTIFACT_DIR = path.join(ROOT, 'artifacts', EXPERIMENT_ID);
const MANIFEST_FILE = path.join(ARTIFACT_DIR, 'data-manifest.json');
const RESULT_FILE = path.join(ARTIFACT_DIR, 'result.json');
const TRADES_FILE = path.join(ARTIFACT_DIR, 'trades.csv');
const REPORT_FILE = path.join(ARTIFACT_DIR, 'report.md');
const COMPLETION_FILE = path.join(ARTIFACT_DIR, 'completion.json');
const FAILURE_FILE = path.join(ARTIFACT_DIR, 'failure.json');
const PREREGISTRATION_FILE = path.join(
  ROOT,
  'registry',
  'experiments',
  EXPERIMENT_ID,
  'preregistration.json'
);

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function relative(file) {
  return path.relative(ROOT, file).replaceAll('\\', '/');
}

function verifyHash(file, expected) {
  if (!fs.existsSync(file)) throw new Error(`frozen artifact is unavailable: ${relative(file)}`);
  if (sha256(fs.readFileSync(file)) !== expected) {
    throw new Error(`frozen artifact hash mismatch: ${relative(file)}`);
  }
}

function verifyCompletion() {
  const completion = JSON.parse(fs.readFileSync(COMPLETION_FILE, 'utf8'));
  if (completion.experiment_id !== EXPERIMENT_ID) throw new Error('completion experiment mismatch');
  for (const artifact of completion.artifacts) {
    verifyHash(path.join(ROOT, artifact.path), artifact.sha256);
  }
  return completion;
}

function verifyFailure() {
  const failure = JSON.parse(fs.readFileSync(FAILURE_FILE, 'utf8'));
  if (failure.experiment_id !== EXPERIMENT_ID) throw new Error('failure experiment mismatch');
  verifyHash(PREREGISTRATION_FILE, failure.preregistration_sha256);
  if (failure.data_manifest_sha256) verifyHash(MANIFEST_FILE, failure.data_manifest_sha256);
  if (failure.report) verifyHash(path.join(ROOT, failure.report.path), failure.report.sha256);
  return failure;
}

function verifyLockedManifest() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  if (manifest.preregistration_sha256 !== sha256(fs.readFileSync(PREREGISTRATION_FILE))) {
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
      output[index] = await mapper(items[index]);
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
  const directory = kind === 'contract'
    ? 'klines'
    : kind === 'funding'
      ? 'fundingRate'
      : kind === 'premium'
        ? 'premiumIndexKlines'
        : 'markPriceKlines';
  const name = kind === 'funding'
    ? `${symbol}-fundingRate-${month}.zip`
    : `${symbol}-5m-${month}.zip`;
  const url = kind === 'funding'
    ? `https://data.binance.vision/data/futures/um/monthly/${directory}/${symbol}/${name}`
    : `https://data.binance.vision/data/futures/um/monthly/${directory}/${symbol}/5m/${name}`;
  const reusedKind = kind === 'contract' ? 'kline' : kind;
  const localDirectory = kind === 'contract' || kind === 'funding'
    ? path.join(REUSED_RAW_DIR, symbol, reusedKind)
    : EXPERIMENT_ID !== 'HY-EXP-0002'
      ? path.join(REUSED_PREMIUM_RAW_DIR, symbol, kind)
      : path.join(RAW_DIR, symbol, kind);
  return { kind, symbol, month, name, url, localDirectory };
}

async function downloadOne(spec) {
  fs.mkdirSync(spec.localDirectory, { recursive: true });
  const file = path.join(spec.localDirectory, spec.name);
  if (fs.existsSync(file)) {
    const buffer = fs.readFileSync(file);
    return {
      kind: spec.kind,
      symbol: spec.symbol,
      month: spec.month,
      name: spec.name,
      url: spec.url,
      status: 200,
      cached: true,
      bytes: buffer.length,
      sha256: sha256(buffer),
      path: relative(file)
    };
  }
  const fetched = await fetchArchive(spec.url);
  if (!fetched.buffer) {
    return {
      kind: spec.kind,
      symbol: spec.symbol,
      month: spec.month,
      name: spec.name,
      url: spec.url,
      status: fetched.status,
      cached: false,
      bytes: 0,
      sha256: null,
      path: null
    };
  }
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, fetched.buffer);
  fs.renameSync(temporary, file);
  return {
    kind: spec.kind,
    symbol: spec.symbol,
    month: spec.month,
    name: spec.name,
    url: spec.url,
    status: fetched.status,
    cached: false,
    bytes: fetched.buffer.length,
    sha256: sha256(fetched.buffer),
    path: relative(file)
  };
}

async function download() {
  if (fs.existsSync(MANIFEST_FILE)) {
    const manifest = verifyLockedManifest();
    if (fs.existsSync(COMPLETION_FILE)) verifyCompletion();
    console.log(JSON.stringify({
      manifest: relative(MANIFEST_FILE),
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
  const specs = preregistration.symbols.flatMap(symbol => months.flatMap(month =>
    ['contract', 'premium', 'mark', 'funding'].map(kind => archiveSpec(symbol, month, kind))
  ));
  let completed = 0;
  const files = await mapLimit(specs, 12, async spec => {
    const item = await downloadOne(spec);
    completed++;
    if (completed % 50 === 0 || completed === specs.length) {
      console.error(`downloaded or checked ${completed}/${specs.length}`);
    }
    return item;
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
    manifest: relative(MANIFEST_FILE),
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
  const chunks = files.map(item => {
    const buffer = fs.readFileSync(path.join(ROOT, item.path));
    if (sha256(buffer) !== item.sha256) throw new Error(`data hash mismatch: ${item.path}`);
    return kind === 'funding'
      ? parseFundingArchive(buffer, symbol)
      : parseKlineArchive(buffer, symbol, kind);
  });
  const timeField = kind === 'funding' ? 'eventTime' : 'openTime';
  const rows = mergeUniqueSeries(chunks, timeField, `${symbol}/${kind}`);
  if (kind !== 'funding') assertContiguous(rows, `${symbol}/${kind}`);
  return rows;
}

function csvCell(value) {
  if (value == null) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function writeTrades(tradesByScenario) {
  const columns = [
    'scenario', 'symbol', 'side', 'eventTime', 'signalTime', 'entryTime', 'exitTime',
    'entryPrice', 'exitPrice', 'entryFill', 'exitFill', 'quantity', 'premium',
    'premiumMean', 'premiumDeviation', 'premiumZscore', 'signalFundingRate',
    'signalFundingIntervalHours', 'grossPriceReturn', 'priceReturnAfterSlippage',
    'fees', 'fundingEventsDuringHold', 'fundingReturn', 'netReturn'
  ];
  const rows = [columns.join(',')];
  for (const trades of Object.values(tradesByScenario)) {
    for (const trade of trades) rows.push(columns.map(column => csvCell(trade[column])).join(','));
  }
  fs.writeFileSync(TRADES_FILE, `${rows.join('\n')}\n`);
}

function metric(value, digits = 6) {
  return value == null ? 'n/a' : Number(value).toFixed(digits);
}

function writeReport(result) {
  const lines = [
    `# ${EXPERIMENT_ID} 结果`,
    '',
    `结论：\`${result.conclusion}\`。所有输入均为 D0 已暴露开发数据，不能证明样本外盈利。`,
    '',
    '| 情景 | 交易 | 净收益单位 | PF | 去最佳5笔 | 去最佳5事件簇 |',
    '|---|---:|---:|---:|---:|---:|'
  ];
  for (const name of ['base', 'stress', 'extreme']) {
    const summary = result.summaries[name];
    lines.push(`| ${name} | ${summary.trades} | ${metric(summary.netReturnUnits)} | ${metric(summary.profitFactor, 3)} | ${metric(summary.profitWithoutBest5)} | ${metric(summary.profitWithoutBest5EventClusters)} |`);
  }
  lines.push(
    '',
    '## 预登记开发筛选',
    '',
    `通过：${result.developmentScreen.pass ? '是' : '否'}`,
    '',
    `失败项：${result.developmentScreen.failures.join(', ') || '无'}`,
    '',
    '## 解释限制',
    '',
    ...result.limitations.map(item => `- ${item}`),
    ''
  );
  fs.writeFileSync(REPORT_FILE, lines.join('\n'));
}

function run() {
  if (fs.existsSync(FAILURE_FILE)) {
    const failure = verifyFailure();
    console.log(JSON.stringify({
      failure: relative(FAILURE_FILE),
      frozen: true,
      conclusion: failure.conclusion
    }, null, 2));
    return;
  }
  if (fs.existsSync(COMPLETION_FILE)) {
    const completion = verifyCompletion();
    verifyLockedManifest();
    const result = JSON.parse(fs.readFileSync(RESULT_FILE, 'utf8'));
    console.log(JSON.stringify({
      result: relative(RESULT_FILE),
      frozen: true,
      conclusion: result.conclusion,
      records: completion.artifacts.length
    }, null, 2));
    return;
  }
  if ([RESULT_FILE, TRADES_FILE, REPORT_FILE].some(fs.existsSync)) {
    throw new Error('unfinalized result artifacts already exist; refusing to overwrite');
  }
  const preregistration = JSON.parse(fs.readFileSync(PREREGISTRATION_FILE, 'utf8'));
  const manifest = verifyLockedManifest();
  if (manifest.missing_files > 0) {
    throw new Error(`data manifest has ${manifest.missing_files} missing files; record a failed event`);
  }
  const evaluationStart = Date.parse(preregistration.data.evaluation_start_utc);
  const evaluationEnd = Date.parse(preregistration.data.evaluation_end_exclusive_utc);
  const allSignals = [];
  const scenarios = Object.entries(preregistration.execution.slippage_per_side).map(
    ([name, slippagePerSide]) => ({
      name,
      feePerSide: preregistration.execution.fee_per_side,
      slippagePerSide
    })
  );
  const tradesByScenario = Object.fromEntries(scenarios.map(scenario => [scenario.name, []]));
  const coverage = {};
  for (const symbol of preregistration.symbols) {
    const contract = loadAndVerify(manifest, symbol, 'contract');
    const premium = loadAndVerify(manifest, symbol, 'premium');
    const mark = loadAndVerify(manifest, symbol, 'mark');
    const funding = loadAndVerify(manifest, symbol, 'funding');
    const signals = detectFundingUnwindSignals({
      symbol,
      contractBars: contract,
      premiumBars: premium,
      fundingRows: funding,
      evaluationStart,
      evaluationEnd,
      historyEvents: preregistration.signal.history_events,
      minimumAbsolutePremium: preregistration.signal.minimum_absolute_premium,
      minimumAbsoluteZscore: preregistration.signal.minimum_absolute_zscore,
      entryDelayBars: 1,
      holdBars: preregistration.signal.hold_bars
    });
    allSignals.push(...signals);
    for (const scenario of scenarios) {
      tradesByScenario[scenario.name].push(
        ...signals.map(signal => applyExecution(signal, funding, mark, scenario))
      );
    }
    coverage[symbol] = {
      contractBars: contract.length,
      premiumBars: premium.length,
      markBars: mark.length,
      fundingEvents: funding.length,
      firstBar: contract[0]?.openTime ?? null,
      lastBar: contract.at(-1)?.openTime ?? null,
      signals: signals.length
    };
  }
  allSignals.sort((a, b) => a.eventTime - b.eventTime || a.symbol.localeCompare(b.symbol));
  for (const trades of Object.values(tradesByScenario)) {
    trades.sort((a, b) => a.eventTime - b.eventTime || a.symbol.localeCompare(b.symbol));
  }
  const summaries = Object.fromEntries(Object.entries(tradesByScenario).map(([name, trades]) => [
    name,
    summarizeFundingTrades(trades)
  ]));
  const screen = developmentScreen(summaries.stress, {
    minimumTrades: preregistration.development_screen.minimum_trades,
    minimumProfitFactor: preregistration.development_screen.minimum_stress_profit_factor,
    minimumProfitableSymbols: preregistration.development_screen.minimum_profitable_symbols,
    minimumProfitableHalfYears: preregistration.development_screen.minimum_profitable_half_years,
    maximumPositiveMonthContributionShare:
      preregistration.development_screen.maximum_positive_month_contribution_share
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
      command: 'npm run exp:002:run'
    },
    coverage,
    rawSignals: allSignals.length,
    summaries,
    developmentScreen: screen,
    limitations: [
      'All observations are exposed development data and cannot prove out-of-sample profitability.',
      'The fixed eight-symbol diagnostic panel is not a point-in-time full-market universe.',
      'The signal uses premium-index close before settlement but enters five minutes after settlement; 5m contract open remains a price proxy, not a bid/ask fill.',
      'Funding archive event timestamps determine the clock; realized funding-rate magnitude is excluded from signal generation.',
      'Max drawdown remains cumulative equal-notional return units, not account equity under margin and liquidation rules.',
      'A passing screen only permits a broader preregistered development test including a non-event placebo.'
    ],
    artifacts: {
      manifest: relative(MANIFEST_FILE),
      trades: relative(TRADES_FILE),
      report: relative(REPORT_FILE)
    }
  };
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeTrades(tradesByScenario);
  fs.writeFileSync(RESULT_FILE, `${JSON.stringify(result, null, 2)}\n`);
  writeReport(result);
  console.log(JSON.stringify({
    result: relative(RESULT_FILE),
    trades: allSignals.length,
    conclusion: result.conclusion,
    base: summaries.base,
    stress: summaries.stress,
    extreme: summaries.extreme,
    failures: screen.failures
  }, null, 2));
}

function complete(codeCommit) {
  if (!/^[a-f0-9]{40}$/.test(codeCommit ?? '')) {
    throw new Error('complete requires a full 40-character code commit hash');
  }
  if (fs.existsSync(FAILURE_FILE)) {
    throw new Error(`${EXPERIMENT_ID} is already failed and cannot be completed`);
  }
  if (fs.existsSync(COMPLETION_FILE)) {
    console.log(JSON.stringify({ frozen: true, ...verifyCompletion() }, null, 2));
    return;
  }
  for (const file of [MANIFEST_FILE, RESULT_FILE, TRADES_FILE, REPORT_FILE]) {
    if (!fs.existsSync(file)) throw new Error(`cannot complete without ${relative(file)}`);
  }
  const artifacts = [
    PREREGISTRATION_FILE,
    MANIFEST_FILE,
    RESULT_FILE,
    TRADES_FILE,
    REPORT_FILE
  ].map(file => ({ path: relative(file), sha256: sha256(fs.readFileSync(file)) }));
  const result = JSON.parse(fs.readFileSync(RESULT_FILE, 'utf8'));
  const completion = {
    experiment_id: EXPERIMENT_ID,
    completed_at: result.generated_at,
    evidence_class: result.evidence_class,
    conclusion: result.conclusion,
    code_commit: codeCommit,
    artifacts
  };
  fs.writeFileSync(COMPLETION_FILE, `${JSON.stringify(completion, null, 2)}\n`);
  console.log(JSON.stringify(completion, null, 2));
}

async function main() {
  if (COMMAND === 'download') return download();
  if (COMMAND === 'run') return run();
  if (COMMAND === 'complete') {
    return complete(process.argv[REQUESTED_EXPERIMENT_ID ? 4 : 3]);
  }
  throw new Error(
    'usage: exp002.mjs download [EXPERIMENT_ID] | run [EXPERIMENT_ID] | complete [EXPERIMENT_ID] CODE_COMMIT'
  );
}

try {
  await main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
