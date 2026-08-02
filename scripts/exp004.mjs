import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  assertContiguous,
  mergeUniqueSeries,
  parseFundingArchive,
  parseKlineArchive,
  unzipSingle
} from '../src/research/archive.mjs';
import {
  buildPortfolioFromCandidates,
  collapseMetricsCollisions,
  computeSymbolEventFeatures,
  detectMarketShocks,
  developmentScreen,
  executePortfolio,
  parseMetricsArchiveLines,
  summarizePortfolios
} from '../src/research/exp004.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMMAND = process.argv[2];
const REQUESTED_ID = /^HY-EXP-\d{4}$/.test(process.argv[3] ?? '') ? process.argv[3] : null;
const ID = REQUESTED_ID ?? 'HY-EXP-0004';
const RAW = path.join(ROOT, 'data', 'raw', ID);
const ARTIFACT = path.join(ROOT, 'artifacts', ID);
const PREREG = path.join(ROOT, 'registry', 'experiments', ID, 'preregistration.json');
const MANIFEST = path.join(ARTIFACT, 'data-manifest.json');
const RESULT = path.join(ARTIFACT, 'result.json');
const PORTFOLIOS = path.join(ARTIFACT, 'portfolios.jsonl');
const REPORT = path.join(ARTIFACT, 'report.md');
const COMPLETION = path.join(ARTIFACT, 'completion.json');
const FAILURE = path.join(ARTIFACT, 'failure.json');

const hash = buffer => createHash('sha256').update(buffer).digest('hex');
const relative = file => path.relative(ROOT, file).replaceAll('\\', '/');

function preregistration() {
  const declared = JSON.parse(fs.readFileSync(PREREG, 'utf8'));
  if (!declared.inherits) return declared;
  const baseFile = path.join(ROOT, declared.inherits.path);
  verifyHash(baseFile, declared.inherits.sha256);
  const base = JSON.parse(fs.readFileSync(baseFile, 'utf8'));
  return {
    ...base,
    experiment_id: declared.experiment_id,
    title: declared.title,
    evidence_class: declared.evidence_class,
    declared_date: declared.declared_date,
    provenance: declared.provenance,
    data: {
      ...base.data,
      metrics_timestamp_semantics: declared.overrides['data.metrics_timestamp_semantics'],
      maximum_metrics_publication_lag_ms:
        declared.overrides['data.maximum_metrics_publication_lag_ms'],
      metrics_collision_policy: declared.overrides['data.metrics_collision_policy']
    },
    interpretation: {
      ...base.interpretation,
      special_caveat: declared.overrides['interpretation.special_caveat']
    }
  };
}

function verifyHash(file, expected) {
  if (!fs.existsSync(file) || hash(fs.readFileSync(file)) !== expected) {
    throw new Error(`hash mismatch: ${relative(file)}`);
  }
}

function verifyManifest() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  verifyHash(PREREG, manifest.preregistration_sha256);
  for (const item of manifest.files.filter(item => item.status === 200)) {
    verifyHash(path.join(ROOT, item.path), item.sha256);
  }
  return manifest;
}

function verifyCompletion() {
  const completion = JSON.parse(fs.readFileSync(COMPLETION, 'utf8'));
  for (const item of completion.artifacts) verifyHash(path.join(ROOT, item.path), item.sha256);
  return completion;
}

function months(start, end) {
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
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await mapper(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return output;
}

async function fetchArchive(url) {
  let last;
  for (const delay of [0, 500, 1000, 2000, 4000]) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': 'hengyu-research/0.1 research-only' },
        signal: AbortSignal.timeout(30000)
      });
      if (response.status === 404) return { status: 404, buffer: null };
      if (!response.ok) {
        last = new Error(`HTTP ${response.status}: ${url}`);
        if (response.status !== 429 && response.status < 500) throw last;
        continue;
      }
      return { status: response.status, buffer: Buffer.from(await response.arrayBuffer()) };
    } catch (error) {
      last = error;
    }
  }
  throw last;
}

function reusable(symbol, kind, name) {
  const candidates = [];
  if (kind === 'contract') candidates.push(path.join(ROOT, 'data', 'raw', 'HY-EXP-0001', symbol, 'kline', name));
  if (kind === 'funding') candidates.push(path.join(ROOT, 'data', 'raw', 'HY-EXP-0001', symbol, 'funding', name));
  if (kind === 'mark') candidates.push(path.join(ROOT, 'data', 'raw', 'HY-EXP-0002', symbol, 'mark', name));
  candidates.push(path.join(ROOT, 'data', 'raw', 'HY-EXP-0004', symbol, kind, name));
  return candidates.find(fs.existsSync);
}

function monthlySpec(symbol, month, kind) {
  const directory = kind === 'contract' ? 'klines' : kind === 'mark' ? 'markPriceKlines' : 'fundingRate';
  const name = kind === 'funding' ? `${symbol}-fundingRate-${month}.zip` : `${symbol}-5m-${month}.zip`;
  const url = kind === 'funding'
    ? `https://data.binance.vision/data/futures/um/monthly/${directory}/${symbol}/${name}`
    : `https://data.binance.vision/data/futures/um/monthly/${directory}/${symbol}/5m/${name}`;
  return {
    symbol, period: month, kind, name, url,
    file: reusable(symbol, kind, name) ?? path.join(RAW, symbol, kind, name)
  };
}

function metricsSpec(symbol, date) {
  const name = `${symbol}-metrics-${date}.zip`;
  return {
    symbol, period: date, kind: 'metrics', name,
    url: `https://data.binance.vision/data/futures/um/daily/metrics/${symbol}/${name}`,
    file: ID === 'HY-EXP-0004'
      ? path.join(RAW, symbol, 'metrics', name)
      : path.join(ROOT, 'data', 'raw', 'HY-EXP-0004', symbol, 'metrics', name)
  };
}

async function downloadOne(spec) {
  fs.mkdirSync(path.dirname(spec.file), { recursive: true });
  let buffer;
  let status = 200;
  let cached = true;
  if (fs.existsSync(spec.file)) {
    buffer = fs.readFileSync(spec.file);
  } else {
    const response = await fetchArchive(spec.url);
    status = response.status;
    cached = false;
    buffer = response.buffer;
    if (buffer) {
      const temporary = `${spec.file}.tmp`;
      fs.writeFileSync(temporary, buffer);
      fs.renameSync(temporary, spec.file);
    }
  }
  return {
    symbol: spec.symbol, period: spec.period, kind: spec.kind, name: spec.name, url: spec.url,
    status, cached, bytes: buffer?.length ?? 0, sha256: buffer ? hash(buffer) : null,
    path: buffer ? relative(spec.file) : null
  };
}

function loadKindFromFiles(files, symbol, kind, options = {}) {
  const chunks = files
    .filter(item => item.symbol === symbol && item.kind === kind && item.status === 200)
    .sort((a, b) => a.period.localeCompare(b.period))
    .map(item => {
      const buffer = fs.readFileSync(path.join(ROOT, item.path));
      if (hash(buffer) !== item.sha256) throw new Error(`data hash mismatch: ${item.path}`);
      if (kind === 'funding') return parseFundingArchive(buffer, symbol);
      if (kind === 'metrics') {
        const lines = unzipSingle(buffer).toString('utf8').trim().split(/\r?\n/).slice(1);
        return parseMetricsArchiveLines(lines, symbol, {
          maximumPublicationLagMs: options.maximumMetricsPublicationLagMs ?? 0,
          allowNormalizedCollisions: options.metricsCollisionPolicy === 'exclude_symbol_for_event'
        });
      }
      return parseKlineArchive(buffer, symbol, kind);
    });
  const field = kind === 'funding' ? 'eventTime' : kind === 'metrics' ? 'createTime' : 'openTime';
  const rows = kind === 'metrics' && options.metricsCollisionPolicy === 'exclude_symbol_for_event'
    ? collapseMetricsCollisions(chunks.flat())
    : mergeUniqueSeries(chunks, field, `${symbol}/${kind}`);
  if (kind === 'contract' || kind === 'mark') assertContiguous(rows, `${symbol}/${kind}`);
  return rows;
}

function shockOptions(preregistration) {
  return {
    shockWindowBars: preregistration.event.shock_window_bars,
    volatilityLookbackBars: preregistration.event.volatility_lookback_bars,
    evaluationStart: Date.parse(preregistration.data.evaluation_start_utc),
    evaluationEnd: Date.parse(preregistration.data.evaluation_end_exclusive_utc),
    maximumReturn: preregistration.event.maximum_absolute_return,
    maximumZscore: preregistration.event.maximum_zscore,
    cooldownBars: preregistration.event.cooldown_bars
  };
}

function localBtc(preregistration) {
  const files = months(preregistration.data.download_start_month, preregistration.data.download_end_month)
    .map(month => monthlySpec('BTCUSDT', month, 'contract'))
    .map(spec => ({
      ...spec,
      status: 200,
      path: relative(spec.file),
      sha256: hash(fs.readFileSync(spec.file))
    }));
  return loadKindFromFiles(files, 'BTCUSDT', 'contract');
}

async function download() {
  if (fs.existsSync(MANIFEST)) {
    const manifest = verifyManifest();
    console.log(JSON.stringify({ frozen: true, events: manifest.events.length, files: manifest.files.length }, null, 2));
    return;
  }
  const config = preregistration();
  const eventRows = detectMarketShocks(localBtc(config), shockOptions(config));
  const metricDates = new Set();
  for (const event of eventRows) {
    const date = new Date(event.eventTime);
    metricDates.add(date.toISOString().slice(0, 10));
    date.setUTCDate(date.getUTCDate() - 1);
    metricDates.add(date.toISOString().slice(0, 10));
  }
  const monthRows = months(config.data.download_start_month, config.data.download_end_month);
  const specs = config.symbols.flatMap(symbol => [
    ...monthRows.flatMap(month => ['contract', 'mark', 'funding'].map(kind => monthlySpec(symbol, month, kind))),
    ...[...metricDates].sort().map(date => metricsSpec(symbol, date))
  ]);
  let count = 0;
  const files = await mapLimit(specs, 20, async spec => {
    const item = await downloadOne(spec);
    if (++count % 100 === 0 || count === specs.length) console.error(`checked ${count}/${specs.length}`);
    return item;
  });
  const manifest = {
    experiment_id: ID,
    generated_at: new Date().toISOString(),
    source: 'Binance official public archive',
    preregistration_sha256: hash(fs.readFileSync(PREREG)),
    events: eventRows,
    metrics_dates: [...metricDates].sort(),
    requested_files: files.length,
    available_files: files.filter(item => item.status === 200).length,
    missing_files: files.filter(item => item.status === 404).length,
    total_bytes: files.reduce((sum, item) => sum + item.bytes, 0),
    files: files.sort((a, b) => a.symbol.localeCompare(b.symbol)
      || a.kind.localeCompare(b.kind) || a.period.localeCompare(b.period))
  };
  fs.mkdirSync(ARTIFACT, { recursive: true });
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({
    manifest: relative(MANIFEST), events: eventRows.length, metricDates: metricDates.size,
    requested: manifest.requested_files, available: manifest.available_files,
    missing: manifest.missing_files, bytes: manifest.total_bytes
  }, null, 2));
}

function writeReport(result) {
  const lines = [
    `# ${ID} 结果`, '',
    `结论：\`${result.conclusion}\`。本结果仅属于 D0 开发筛选。`, '',
    '| 情景 | 事件组合 | 胜率 | 净收益单位 | PF | 去最佳5事件 | 最大回撤单位 |',
    '|---|---:|---:|---:|---:|---:|---:|'
  ];
  for (const name of ['base', 'stress', 'extreme']) {
    const item = result.summaries[name];
    lines.push(`| ${name} | ${item.eventPortfolios} | ${(100 * item.winRate).toFixed(1)}% | ${item.netReturnUnits.toFixed(6)} | ${item.profitFactor == null ? 'n/a' : item.profitFactor.toFixed(3)} | ${item.profitWithoutBest5Events.toFixed(6)} | ${item.maxDrawdownReturnUnits.toFixed(6)} |`);
  }
  lines.push('', `失败项：${result.developmentScreen.failures.join(', ') || '无'}`, '',
    ...result.limitations.map(item => `- ${item}`), '');
  fs.writeFileSync(REPORT, lines.join('\n'));
}

function run() {
  if (fs.existsSync(FAILURE)) throw new Error(`${ID} is already failed`);
  if (fs.existsSync(COMPLETION)) {
    const completion = verifyCompletion();
    console.log(JSON.stringify({ frozen: true, conclusion: completion.conclusion }, null, 2));
    return;
  }
  if ([RESULT, PORTFOLIOS, REPORT].some(fs.existsSync)) throw new Error('unfinalized artifacts exist');
  const config = preregistration();
  const manifest = verifyManifest();
  if (manifest.missing_files) throw new Error(`${manifest.missing_files} required files are missing`);
  const btc = loadKindFromFiles(manifest.files, 'BTCUSDT', 'contract');
  const events = detectMarketShocks(btc, shockOptions(config));
  if (JSON.stringify(events) !== JSON.stringify(manifest.events)) throw new Error('event manifest mismatch');
  const candidatesByEvent = new Map(events.map(event => [event.eventTime, []]));
  const altSymbols = config.symbols.filter(symbol => symbol !== 'BTCUSDT');
  for (const symbol of altSymbols) {
    const contract = loadKindFromFiles(manifest.files, symbol, 'contract');
    const metricsRows = loadKindFromFiles(manifest.files, symbol, 'metrics', {
      maximumMetricsPublicationLagMs: config.data.maximum_metrics_publication_lag_ms,
      metricsCollisionPolicy: config.data.metrics_collision_policy
    });
    const metrics = new Map(metricsRows.map(row => [row.createTime, row]));
    const features = computeSymbolEventFeatures({
      symbol, symbolBars: contract, btcBars: btc, metrics, events,
      betaLookbackBars: config.portfolio.beta_lookback_bars,
      liquidityLookbackBars: config.portfolio.liquidity_lookback_bars,
      shockWindowBars: config.event.shock_window_bars,
      invalidOiPolicy: config.data.metrics_collision_policy
    });
    for (const feature of features) candidatesByEvent.get(feature.eventTime).push(feature);
  }
  const portfolios = events.map(event => buildPortfolioFromCandidates({
    event,
    candidates: candidatesByEvent.get(event.eventTime),
    benchmark: 'BTCUSDT',
    minimumValidSymbols: config.portfolio.minimum_valid_symbols,
    longCount: config.portfolio.long_count,
    shortCount: config.portfolio.short_count
  }));
  const neededContract = new Set(portfolios.flatMap(item => [
    item.eventTime + 5 * 60 * 1000,
    item.eventTime + 125 * 60 * 1000
  ]));
  const dataBySymbol = {};
  for (const symbol of config.symbols) {
    const contract = loadKindFromFiles(manifest.files, symbol, 'contract');
    const funding = loadKindFromFiles(manifest.files, symbol, 'funding');
    const fundingTimes = new Set(funding.filter(row => portfolios.some(item =>
      row.eventTime >= item.eventTime + 5 * 60 * 1000
      && row.eventTime < item.eventTime + 125 * 60 * 1000)).map(row => row.eventTime));
    const mark = loadKindFromFiles(manifest.files, symbol, 'mark');
    dataBySymbol[symbol] = {
      contractByTime: new Map(contract.filter(row => neededContract.has(row.openTime))
        .map(row => [row.openTime, row])),
      markByTime: new Map(mark.filter(row => fundingTimes.has(row.openTime))
        .map(row => [row.openTime, row])),
      funding
    };
  }
  const scenarios = Object.entries(config.execution.slippage_per_side)
    .map(([name, slippagePerSide]) => ({
      name, slippagePerSide, feePerSide: config.execution.fee_per_side
    }));
  const tradesByScenario = Object.fromEntries(scenarios.map(scenario => [
    scenario.name,
    portfolios.map(portfolio => executePortfolio(
      portfolio,
      dataBySymbol,
      scenario,
      config.portfolio.hold_bars
    ))
  ]));
  const summaries = Object.fromEntries(Object.entries(tradesByScenario).map(([name, trades]) => [
    name, summarizePortfolios(trades, altSymbols)
  ]));
  const screen = developmentScreen(summaries.stress, {
    minimumEvents: config.development_screen.minimum_event_portfolios,
    minimumProfitFactor: config.development_screen.minimum_stress_profit_factor,
    maximumDrawdown: config.development_screen.maximum_stress_drawdown_return_units,
    minimumProfitableSymbols: config.development_screen.minimum_profitable_alt_symbols,
    minimumProfitableHalfYears: config.development_screen.minimum_profitable_half_years,
    maximumPositiveMonthContributionShare:
      config.development_screen.maximum_positive_month_contribution_share
  });
  const result = {
    experiment_id: ID,
    generated_at: new Date().toISOString(),
    evidence_class: config.evidence_class,
    conclusion: screen.pass ? 'DEVELOPMENT_SCREEN_PASS_NOT_OUT_OF_SAMPLE' : 'EXACT_SPECIFICATION_ELIMINATED',
    preregistration_sha256: hash(fs.readFileSync(PREREG)),
    data_manifest_sha256: hash(fs.readFileSync(MANIFEST)),
    events: events.length,
    summaries,
    developmentScreen: screen,
    limitations: [
      'All observations are exposed D0 development data.',
      'The fixed 16-symbol panel has survivor bias and is not a point-in-time market universe.',
      'Metrics create_time is treated as period end; entry waits one full 5m bar after that timestamp.',
      'Kline open plus fixed slippage is still not an order-book fill.',
      'Return-unit drawdown is not leveraged account equity drawdown.',
      'A pass would require a new full-universe replication and event-time placebo.'
    ]
  };
  fs.writeFileSync(PORTFOLIOS, `${Object.values(tradesByScenario).flat().map(JSON.stringify).join('\n')}\n`);
  fs.writeFileSync(RESULT, `${JSON.stringify(result, null, 2)}\n`);
  writeReport(result);
  console.log(JSON.stringify({ events: events.length, conclusion: result.conclusion, summaries, failures: screen.failures }, null, 2));
}

function complete(codeCommit) {
  if (!/^[a-f0-9]{40}$/.test(codeCommit ?? '')) throw new Error('full code commit required');
  if (fs.existsSync(COMPLETION)) return console.log(JSON.stringify(verifyCompletion(), null, 2));
  const result = JSON.parse(fs.readFileSync(RESULT, 'utf8'));
  const artifacts = [PREREG, MANIFEST, RESULT, PORTFOLIOS, REPORT]
    .map(file => ({ path: relative(file), sha256: hash(fs.readFileSync(file)) }));
  const completion = {
    experiment_id: ID, completed_at: result.generated_at, evidence_class: result.evidence_class,
    conclusion: result.conclusion, code_commit: codeCommit, artifacts
  };
  fs.writeFileSync(COMPLETION, `${JSON.stringify(completion, null, 2)}\n`);
  console.log(JSON.stringify(completion, null, 2));
}

try {
  if (COMMAND === 'download') await download();
  else if (COMMAND === 'run') run();
  else if (COMMAND === 'complete') complete(process.argv[REQUESTED_ID ? 4 : 3]);
  else throw new Error('usage: exp004.mjs download | run | complete CODE_COMMIT');
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
