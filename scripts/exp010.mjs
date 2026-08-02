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
  buildCarryPortfolio,
  buildRebalanceEvents,
  computeCarryFeatures,
  developmentScreen,
  executeCarryPortfolio,
  summarizeCarryPortfolios
} from '../src/research/exp010.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ID = 'HY-EXP-0010';
const COMMAND = process.argv[2];
const RAW = path.join(ROOT, 'data', 'raw', ID);
const ARTIFACT = path.join(ROOT, 'artifacts', ID);
const PREREG = path.join(ROOT, 'registry', 'experiments', ID, 'preregistration.json');
const MANIFEST = path.join(ARTIFACT, 'data-manifest.json');
const RESULT = path.join(ARTIFACT, 'result.json');
const PORTFOLIOS = path.join(ARTIFACT, 'portfolios.jsonl');
const REPORT = path.join(ARTIFACT, 'report.md');
const COMPLETION = path.join(ARTIFACT, 'completion.json');

const hash = buffer => createHash('sha256').update(buffer).digest('hex');
const relative = file => path.relative(ROOT, file).replaceAll('\\', '/');

function verifyHash(file, expected) {
  if (!fs.existsSync(file) || hash(fs.readFileSync(file)) !== expected) {
    throw new Error(`hash mismatch: ${relative(file)}`);
  }
}

function verifyManifest() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  verifyHash(PREREG, manifest.preregistration_sha256);
  for (const item of manifest.files.filter(row => row.status === 200)) {
    verifyHash(path.join(ROOT, item.path), item.sha256);
  }
  return manifest;
}

function verifyCompletion() {
  const completion = JSON.parse(fs.readFileSync(COMPLETION, 'utf8'));
  for (const item of completion.artifacts) verifyHash(path.join(ROOT, item.path), item.sha256);
  return completion;
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

function reusable(symbol, kind, name) {
  const candidates = [];
  if (kind === 'contract') {
    candidates.push(path.join(ROOT, 'data', 'raw', 'HY-EXP-0001', symbol, 'kline', name));
  }
  if (kind === 'funding') {
    candidates.push(path.join(ROOT, 'data', 'raw', 'HY-EXP-0001', symbol, 'funding', name));
  }
  if (kind === 'premium' || kind === 'mark') {
    candidates.push(path.join(ROOT, 'data', 'raw', 'HY-EXP-0002', symbol, kind, name));
  }
  candidates.push(path.join(ROOT, 'data', 'raw', 'HY-EXP-0004', symbol, kind, name));
  return candidates.find(fs.existsSync);
}

function archiveSpec(symbol, month, kind) {
  const directory = kind === 'contract'
    ? 'klines'
    : kind === 'premium'
      ? 'premiumIndexKlines'
      : kind === 'mark'
        ? 'markPriceKlines'
        : 'fundingRate';
  const name = kind === 'funding'
    ? `${symbol}-fundingRate-${month}.zip`
    : `${symbol}-5m-${month}.zip`;
  const url = kind === 'funding'
    ? `https://data.binance.vision/data/futures/um/monthly/${directory}/${symbol}/${name}`
    : `https://data.binance.vision/data/futures/um/monthly/${directory}/${symbol}/5m/${name}`;
  return {
    symbol,
    period: month,
    kind,
    name,
    url,
    file: reusable(symbol, kind, name) ?? path.join(RAW, symbol, kind, name)
  };
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
  let lastError;
  for (const delay of [0, 500, 1000, 2000, 4000]) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': 'hengyu-research/0.1 research-only' },
        signal: AbortSignal.timeout(30_000)
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

async function downloadOne(spec) {
  fs.mkdirSync(path.dirname(spec.file), { recursive: true });
  let buffer;
  let status = 200;
  let cached = true;
  if (fs.existsSync(spec.file)) {
    buffer = fs.readFileSync(spec.file);
  } else {
    const fetched = await fetchArchive(spec.url);
    status = fetched.status;
    cached = false;
    buffer = fetched.buffer;
    if (buffer) {
      const temporary = `${spec.file}.tmp`;
      fs.writeFileSync(temporary, buffer);
      fs.renameSync(temporary, spec.file);
    }
  }
  return {
    symbol: spec.symbol,
    period: spec.period,
    kind: spec.kind,
    name: spec.name,
    url: spec.url,
    status,
    cached,
    bytes: buffer?.length ?? 0,
    sha256: buffer ? hash(buffer) : null,
    path: buffer ? relative(spec.file) : null
  };
}

async function download() {
  if (fs.existsSync(MANIFEST)) {
    const manifest = verifyManifest();
    console.log(JSON.stringify({
      frozen: true,
      requested: manifest.requested_files,
      available: manifest.available_files,
      missing: manifest.missing_files,
      bytes: manifest.total_bytes
    }, null, 2));
    return;
  }
  const config = JSON.parse(fs.readFileSync(PREREG, 'utf8'));
  const months = monthKeys(config.data.download_start_month, config.data.download_end_month);
  const specs = config.symbols.flatMap(symbol => months.flatMap(month =>
    ['contract', 'premium', 'mark', 'funding'].map(kind => archiveSpec(symbol, month, kind))));
  let completed = 0;
  const files = await mapLimit(specs, 12, async spec => {
    const item = await downloadOne(spec);
    completed++;
    if (completed % 100 === 0 || completed === specs.length) {
      console.error(`downloaded or checked ${completed}/${specs.length}`);
    }
    return item;
  });
  const manifest = {
    experiment_id: ID,
    generated_at: new Date().toISOString(),
    source: 'Binance official public archive',
    preregistration_sha256: hash(fs.readFileSync(PREREG)),
    requested_files: files.length,
    available_files: files.filter(row => row.status === 200).length,
    missing_files: files.filter(row => row.status === 404).length,
    total_bytes: files.reduce((total, row) => total + row.bytes, 0),
    files: files.sort((left, right) =>
      left.symbol.localeCompare(right.symbol)
      || left.kind.localeCompare(right.kind)
      || left.period.localeCompare(right.period))
  };
  fs.mkdirSync(ARTIFACT, { recursive: true });
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({
    manifest: relative(MANIFEST),
    requested: manifest.requested_files,
    available: manifest.available_files,
    missing: manifest.missing_files,
    bytes: manifest.total_bytes
  }, null, 2));
}

function loadKind(manifest, symbol, kind) {
  const chunks = manifest.files
    .filter(row => row.symbol === symbol && row.kind === kind && row.status === 200)
    .sort((left, right) => left.period.localeCompare(right.period))
    .map(row => {
      const buffer = fs.readFileSync(path.join(ROOT, row.path));
      if (hash(buffer) !== row.sha256) throw new Error(`data hash mismatch: ${row.path}`);
      return kind === 'funding'
        ? parseFundingArchive(buffer, symbol)
        : parseKlineArchive(buffer, symbol, kind);
    });
  const field = kind === 'funding' ? 'eventTime' : 'openTime';
  const rows = mergeUniqueSeries(chunks, field, `${symbol}/${kind}`);
  if (kind !== 'funding') assertContiguous(rows, `${symbol}/${kind}`);
  return rows;
}

function eventOptions(config) {
  return {
    anchorTime: Date.parse(config.schedule.anchor_utc),
    evaluationStart: Date.parse(config.data.evaluation_start_utc),
    evaluationEnd: Date.parse(config.data.evaluation_end_exclusive_utc),
    rebalanceDays: config.schedule.rebalance_days,
    baseEntryOffsetBars: 2,
    holdBars: config.schedule.hold_bars,
    maximumEntryDelayBars: Math.max(
      ...Object.values(config.execution.scenarios).map(row => row.entry_delay_bars)
    )
  };
}

function featureOptions(config) {
  return {
    fundingLookbackDays: config.features.funding_score_lookback_days,
    minimumFundingEvents: config.features.minimum_funding_events,
    betaLookbackBars: config.features.beta_lookback_bars,
    capacityLookbackBars: config.features.capacity_lookback_bars
  };
}

function portfolioOptions(config) {
  return {
    benchmark: config.portfolio.benchmark,
    eligibleSymbols: config.portfolio.eligible_symbols,
    minimumValidSymbols: config.portfolio.minimum_valid_symbols,
    longCount: config.portfolio.long_count,
    shortCount: config.portfolio.short_count,
    minimumProjectedFundingReturn: config.portfolio.minimum_projected_funding_return,
    referenceGrossNotional: config.portfolio.reference_gross_notional_usdt,
    maximumParticipation: config.portfolio.maximum_reference_participation,
    maximumBetaExposure: config.portfolio.maximum_absolute_pretrade_beta_exposure,
    holdBars: config.schedule.hold_bars
  };
}

function scenarioRows(config) {
  return Object.entries(config.execution.scenarios).map(([name, row]) => ({
    name,
    entryDelayBars: row.entry_delay_bars,
    slippagePerFill: row.slippage_per_fill,
    feePerFill: config.execution.fee_per_fill
  }));
}

function screenThresholds(config) {
  return {
    minimumEvents: config.development_screen.minimum_event_portfolios,
    minimumStressProfitFactor: config.development_screen.minimum_stress_profit_factor,
    maximumDrawdown: config.development_screen.maximum_stress_drawdown_return_units,
    minimumProfitableAltSymbols: config.development_screen.minimum_profitable_alt_symbols,
    minimumProfitableHalfYears: config.development_screen.minimum_profitable_half_years,
    maximumMonthContributionShare:
      config.development_screen.maximum_positive_month_contribution_share,
    minimumDelayProfitFactor: config.development_screen.minimum_delay5m_profit_factor
  };
}

function writeReport(result) {
  const lines = [
    `# ${ID} 结果`,
    '',
    `结论：\`${result.conclusion}\`。本结果只属于D0开发筛选。`,
    '',
    `固定日程产生 ${result.scheduledEvents} 个非重叠候选组合，`
      + `${result.tradedEventPortfolios} 个达到冻结的24 bp预测携带门槛及容量规则。`,
    '',
    '| 情景 | 组合事件 | 胜率 | 实际资金费 | 资金费扣执行成本 | 净收益单位 | PF | 去最佳5期 | 最大回撤 |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|'
  ];
  for (const name of ['base', 'stress', 'extreme', 'delay5m']) {
    const row = result.summaries[name];
    lines.push(`| ${name} | ${row.eventPortfolios} | ${(100 * row.winRate).toFixed(1)}% | `
      + `${row.totalFunding.toFixed(6)} | ${row.fundingAfterExecutionCosts.toFixed(6)} | `
      + `${row.netReturnUnits.toFixed(6)} | `
      + `${row.profitFactor == null ? 'n/a' : row.profitFactor.toFixed(3)} | `
      + `${row.profitWithoutBest5Events.toFixed(6)} | `
      + `${row.maxDrawdownReturnUnits.toFixed(6)} |`);
  }
  lines.push(
    '',
    `跳过原因：${JSON.stringify(result.skippedEventsByReason)}`,
    `失败项：${result.developmentScreen.failures.join(', ') || '无'}`,
    '',
    ...result.limitations.map(row => `- ${row}`),
    ''
  );
  fs.writeFileSync(REPORT, lines.join('\n'));
}

function run() {
  if (fs.existsSync(COMPLETION)) {
    const completion = verifyCompletion();
    console.log(JSON.stringify({ frozen: true, conclusion: completion.conclusion }, null, 2));
    return;
  }
  if ([RESULT, PORTFOLIOS, REPORT].some(fs.existsSync)) {
    throw new Error('unfinalized result artifacts exist');
  }
  const config = JSON.parse(fs.readFileSync(PREREG, 'utf8'));
  const manifest = verifyManifest();
  if (manifest.missing_files > 0) throw new Error(`${manifest.missing_files} required archives are missing`);
  const btc = loadKind(manifest, config.portfolio.benchmark, 'contract');
  const events = buildRebalanceEvents({ btcBars: btc, ...eventOptions(config) });
  const featuresByEvent = new Map(events.map(event => [event.eventId, []]));
  const benchmarkByEvent = new Map();
  const coverage = {};
  for (const symbol of config.symbols) {
    const contract = symbol === config.portfolio.benchmark
      ? btc
      : loadKind(manifest, symbol, 'contract');
    const funding = loadKind(manifest, symbol, 'funding');
    const premium = loadKind(manifest, symbol, 'premium');
    const features = computeCarryFeatures({
      symbol,
      bars: contract,
      btcBars: btc,
      fundingRows: funding,
      events,
      ...featureOptions(config)
    });
    for (const feature of features) {
      if (symbol === config.portfolio.benchmark) benchmarkByEvent.set(feature.eventId, feature);
      else featuresByEvent.get(feature.eventId).push(feature);
    }
    coverage[symbol] = {
      contractBars: contract.length,
      premiumBars: premium.length,
      fundingEvents: funding.length,
      carryFeatures: features.length
    };
  }
  const attempts = events.map(event => buildCarryPortfolio({
    event,
    candidates: featuresByEvent.get(event.eventId),
    benchmarkFeature: benchmarkByEvent.get(event.eventId),
    ...portfolioOptions(config)
  }));
  const portfolios = attempts.filter(row => row.status === 'trade');
  const skippedEventsByReason = {};
  for (const row of attempts.filter(item => item.status === 'skipped')) {
    skippedEventsByReason[row.reason] = (skippedEventsByReason[row.reason] ?? 0) + 1;
  }
  const scenarios = scenarioRows(config);
  const neededExecutionTimes = new Set();
  for (const portfolio of portfolios) {
    for (const scenario of scenarios) {
      const entryTime = portfolio.baseEntryTime + scenario.entryDelayBars * 5 * 60 * 1000;
      neededExecutionTimes.add(entryTime);
      neededExecutionTimes.add(entryTime + portfolio.holdBars * 5 * 60 * 1000);
    }
  }
  const dataBySymbol = {};
  for (const symbol of config.symbols) {
    const contract = symbol === config.portfolio.benchmark
      ? btc
      : loadKind(manifest, symbol, 'contract');
    const funding = loadKind(manifest, symbol, 'funding');
    const usedFundingTimes = new Set(funding.filter(row => portfolios.some(portfolio =>
      portfolio.legs.some(leg => leg.symbol === symbol)
      && scenarios.some(scenario => {
        const entryTime = portfolio.baseEntryTime + scenario.entryDelayBars * 5 * 60 * 1000;
        return row.eventTime >= entryTime
          && row.eventTime < entryTime + portfolio.holdBars * 5 * 60 * 1000;
      }))).map(row => row.eventTime));
    const mark = loadKind(manifest, symbol, 'mark');
    dataBySymbol[symbol] = {
      contractByTime: new Map(
        contract.filter(row => neededExecutionTimes.has(row.openTime)).map(row => [row.openTime, row])
      ),
      funding,
      markByTime: new Map(
        mark.filter(row => usedFundingTimes.has(row.openTime)).map(row => [row.openTime, row])
      )
    };
    coverage[symbol].markBars = mark.length;
  }
  const tradesByScenario = Object.fromEntries(scenarios.map(scenario => [
    scenario.name,
    portfolios.map(portfolio => executeCarryPortfolio(portfolio, dataBySymbol, scenario))
  ]));
  const altSymbols = config.symbols.filter(symbol => symbol !== config.portfolio.benchmark);
  const summaries = Object.fromEntries(Object.entries(tradesByScenario).map(([name, rows]) => [
    name,
    summarizeCarryPortfolios(rows, altSymbols)
  ]));
  const screen = developmentScreen(
    summaries.stress,
    summaries.extreme,
    summaries.delay5m,
    screenThresholds(config)
  );
  const result = {
    experiment_id: ID,
    generated_at: new Date().toISOString(),
    evidence_class: config.evidence_class,
    conclusion: screen.pass
      ? 'DEVELOPMENT_SCREEN_PASS_NOT_OUT_OF_SAMPLE'
      : 'EXACT_SPECIFICATION_ELIMINATED',
    preregistration_sha256: hash(fs.readFileSync(PREREG)),
    data_manifest_sha256: hash(fs.readFileSync(MANIFEST)),
    code: {
      runtime: process.version,
      command: 'npm run exp:010:run'
    },
    coverage,
    scheduledEvents: events.length,
    tradedEventPortfolios: portfolios.length,
    skippedEventsByReason,
    summaries,
    developmentScreen: screen,
    limitations: [
      'All observations are exposed D0 development data and cannot prove out-of-sample profitability.',
      'The fixed 16-symbol panel has survivor bias and is not a point-in-time full-market universe.',
      'Trailing realized funding is observable after settlement, but historical API publication latency is not archived; the frozen 10m entry delay is a conservative proxy.',
      'A 5m open plus fixed slippage is not a bid/ask or order-book fill.',
      'The portfolio is beta neutral only under a backward-looking linear estimate; nonlinear and intraperiod basis risks remain.',
      'Return-unit drawdown is not leveraged account equity drawdown or a liquidation simulation.',
      'The premium-index archive is validated for completeness but is not used to select or tune this experiment.',
      'A pass would still require point-in-time universe replication and forward shadow evidence.'
    ]
  };
  fs.mkdirSync(ARTIFACT, { recursive: true });
  fs.writeFileSync(
    PORTFOLIOS,
    `${Object.values(tradesByScenario).flat().map(JSON.stringify).join('\n')}\n`
  );
  fs.writeFileSync(RESULT, `${JSON.stringify(result, null, 2)}\n`);
  writeReport(result);
  console.log(JSON.stringify({
    scheduledEvents: events.length,
    tradedPortfolios: portfolios.length,
    skippedEventsByReason,
    conclusion: result.conclusion,
    summaries,
    failures: screen.failures
  }, null, 2));
}

function complete(codeCommit) {
  if (!/^[a-f0-9]{40}$/.test(codeCommit ?? '')) throw new Error('full code commit required');
  if (fs.existsSync(COMPLETION)) {
    console.log(JSON.stringify(verifyCompletion(), null, 2));
    return;
  }
  const result = JSON.parse(fs.readFileSync(RESULT, 'utf8'));
  const artifacts = [PREREG, MANIFEST, RESULT, PORTFOLIOS, REPORT]
    .map(file => ({ path: relative(file), sha256: hash(fs.readFileSync(file)) }));
  const completion = {
    experiment_id: ID,
    completed_at: result.generated_at,
    evidence_class: result.evidence_class,
    conclusion: result.conclusion,
    code_commit: codeCommit,
    artifacts
  };
  fs.writeFileSync(COMPLETION, `${JSON.stringify(completion, null, 2)}\n`);
  console.log(JSON.stringify(completion, null, 2));
}

try {
  if (COMMAND === 'download') await download();
  else if (COMMAND === 'run') run();
  else if (COMMAND === 'complete') complete(process.argv[3]);
  else throw new Error('usage: exp010.mjs download | run | complete CODE_COMMIT');
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
