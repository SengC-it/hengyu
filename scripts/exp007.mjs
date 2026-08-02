import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  assertContiguous,
  mergeUniqueSeries,
  parseFundingArchive,
  parseKlineArchive
} from '../src/research/archive.mjs';
import {
  buildPairSeries,
  detectPairEvents,
  developmentScreen,
  executePairEvent,
  parseFundingHistoryJson,
  summarizePairTrades
} from '../src/research/exp007.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMMAND = process.argv[2];
const REQUESTED_ID = /^HY-EXP-\d{4}$/.test(process.argv[3] ?? '') ? process.argv[3] : null;
const ID = REQUESTED_ID ?? 'HY-EXP-0007';
const RAW = path.join(ROOT, 'data', 'raw', ID);
const ARTIFACT = path.join(ROOT, 'artifacts', ID);
const PREREG = path.join(ROOT, 'registry', 'experiments', ID, 'preregistration.json');
const MANIFEST = path.join(ARTIFACT, 'data-manifest.json');
const RESULT = path.join(ARTIFACT, 'result.json');
const TRADES = path.join(ARTIFACT, 'trades.jsonl');
const REPORT = path.join(ARTIFACT, 'report.md');
const COMPLETION = path.join(ARTIFACT, 'completion.json');
const FAILURE = path.join(ARTIFACT, 'failure.json');

const hash = buffer => createHash('sha256').update(buffer).digest('hex');
const relative = file => path.relative(ROOT, file).replaceAll('\\', '/');
const execFileAsync = promisify(execFile);

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
  for (const item of completion.artifacts) {
    verifyHash(path.join(ROOT, item.path), item.sha256);
  }
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
  if (kind === 'mark') {
    candidates.push(path.join(ROOT, 'data', 'raw', 'HY-EXP-0002', symbol, 'mark', name));
  }
  if (kind === 'contract' || kind === 'fx') {
    candidates.push(path.join(ROOT, 'data', 'raw', 'HY-EXP-0007', symbol, kind, name));
  }
  return candidates.find(fs.existsSync);
}

function futuresSpec(symbol, month, kind) {
  const directory = kind === 'contract'
    ? 'klines'
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

function fxSpec(symbol, month) {
  const name = `${symbol}-5m-${month}.zip`;
  return {
    symbol,
    period: month,
    kind: 'fx',
    name,
    url: `https://data.binance.vision/data/spot/monthly/klines/${symbol}/5m/${name}`,
    file: reusable(symbol, 'fx', name) ?? path.join(RAW, symbol, 'fx', name)
  };
}

function fundingApiSpec(symbol, startTime, endTime) {
  const name = `${symbol}-funding-history-${startTime}-${endTime}.json`;
  return {
    symbol,
    period: `${startTime}-${endTime}`,
    kind: 'fundingApi',
    name,
    url: `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}`
      + `&startTime=${startTime}&endTime=${endTime}&limit=1000`,
    startTime,
    endTime,
    file: path.join(RAW, symbol, 'fundingApi', name)
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

async function fetchFundingHistory(spec) {
  const rows = [];
  let cursor = spec.startTime;
  while (cursor <= spec.endTime) {
    const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${spec.symbol}`
      + `&startTime=${cursor}&endTime=${spec.endTime}&limit=1000`;
    const executable = process.platform === 'win32' ? 'curl.exe' : 'curl';
    const args = [
      ...(process.platform === 'win32' ? ['--ssl-no-revoke'] : []),
      '--location',
      '--fail',
      '--silent',
      '--show-error',
      '--retry',
      '4',
      '--retry-all-errors',
      '--connect-timeout',
      '10',
      '--max-time',
      '30',
      url
    ];
    const { stdout } = await execFileAsync(executable, args, {
      encoding: 'buffer',
      maxBuffer: 50 * 1024 * 1024,
      windowsHide: true
    });
    const page = JSON.parse(Buffer.from(stdout).toString('utf8'));
    if (!Array.isArray(page)) throw new Error(`funding history is not an array: ${spec.symbol}`);
    rows.push(...page);
    if (page.length < 1000) break;
    const lastTime = Number(page.at(-1)?.fundingTime);
    if (!Number.isFinite(lastTime) || lastTime < cursor) {
      throw new Error(`funding history pagination did not advance: ${spec.symbol}`);
    }
    cursor = lastTime + 1;
  }
  return { status: 200, buffer: Buffer.from(`${JSON.stringify(rows)}\n`) };
}

async function downloadOne(spec) {
  fs.mkdirSync(path.dirname(spec.file), { recursive: true });
  let buffer;
  let status = 200;
  let cached = true;
  if (fs.existsSync(spec.file)) {
    buffer = fs.readFileSync(spec.file);
  } else {
    const fetched = spec.kind === 'fundingApi'
      ? await fetchFundingHistory(spec)
      : await fetchArchive(spec.url);
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

function requestedSpecs(config) {
  const futures = config.base_assets.flatMap(baseAsset => {
    const monthRows = monthKeys(
      config.data.symbol_start_months[baseAsset],
      config.data.download_end_month
    );
    const monthlyKinds = config.data.funding_source_type === 'rest_history_with_mark_price'
      ? ['contract']
      : ['contract', 'mark', 'funding'];
    return config.symbols[baseAsset].flatMap(symbol => [
      ...monthRows.flatMap(month => monthlyKinds.map(kind => futuresSpec(symbol, month, kind))),
      ...(config.data.funding_source_type === 'rest_history_with_mark_price'
        ? [fundingApiSpec(
            symbol,
            Date.parse(`${config.data.symbol_start_months[baseAsset]}-01T00:00:00.000Z`),
            Date.parse(config.data.evaluation_end_exclusive_utc) - 1
          )]
        : [])
    ]);
  });
  const fx = monthKeys(config.data.fx_start_month, config.data.download_end_month)
    .map(month => fxSpec(config.data.fx_symbol, month));
  return [...futures, ...fx];
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
  const specs = requestedSpecs(config);
  let completed = 0;
  const files = await mapLimit(specs, 4, async spec => {
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
    available_files: files.filter(item => item.status === 200).length,
    missing_files: files.filter(item => item.status === 404).length,
    total_bytes: files.reduce((total, item) => total + item.bytes, 0),
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
    .filter(item => item.symbol === symbol && item.kind === kind && item.status === 200)
    .sort((left, right) => left.period.localeCompare(right.period))
    .map(item => {
      const buffer = fs.readFileSync(path.join(ROOT, item.path));
      if (hash(buffer) !== item.sha256) throw new Error(`data hash mismatch: ${item.path}`);
      return kind === 'funding'
        ? parseFundingArchive(buffer, symbol)
        : kind === 'fundingApi'
          ? parseFundingHistoryJson(buffer, symbol)
        : parseKlineArchive(buffer, symbol, kind === 'mark' ? 'mark' : kind);
    });
  const field = kind === 'funding' || kind === 'fundingApi' ? 'eventTime' : 'openTime';
  const rows = mergeUniqueSeries(chunks, field, `${symbol}/${kind}`);
  if (kind !== 'funding' && kind !== 'fundingApi') assertContiguous(rows, `${symbol}/${kind}`);
  return rows;
}

function scenarioRows(config) {
  return Object.entries(config.execution.slippage_per_fill).map(([name, slippagePerFill]) => ({
    name,
    slippagePerFill,
    feePerFill: config.execution.fee_per_fill,
    referenceGrossNotional: config.liquidity.reference_gross_notional_usdt,
    singleLegDelay: name === 'extreme'
  }));
}

function eventOptions(config) {
  return {
    robustLookbackBars: config.signal.robust_lookback_bars,
    minimumAbsoluteDeviation: config.signal.minimum_absolute_deviation,
    minimumAbsoluteRobustZ: config.signal.minimum_absolute_robust_z,
    rearmAbsoluteDeviation: 0.003,
    rearmAbsoluteRobustZ: 2,
    liquidityLookbackBars: config.liquidity.lookback_bars,
    minimumQuoteVolume: config.liquidity.minimum_quote_volume_per_leg,
    referenceLegNotional: config.liquidity.reference_leg_notional_usdt,
    maximumPriorBarParticipation:
      config.liquidity.maximum_reference_participation_of_prior_5m_quote_volume,
    maximumHoldBars: config.signal.maximum_hold_bars,
    evaluationStart: Date.parse(config.data.evaluation_start_utc),
    evaluationEnd: Date.parse(config.data.evaluation_end_exclusive_utc)
  };
}

function screenThresholds(config) {
  return {
    minimumEvents: config.development_screen.minimum_event_pairs,
    minimumProfitFactor: config.development_screen.minimum_stress_profit_factor,
    maximumDrawdown: config.development_screen.maximum_stress_drawdown_return_units,
    minimumProfitableBaseAssets: config.development_screen.minimum_profitable_base_assets,
    minimumProfitableHalfYears: config.development_screen.minimum_profitable_half_years,
    maximumPositiveMonthContributionShare:
      config.development_screen.maximum_positive_month_contribution_share,
    minimumMedianEntryDislocation:
      config.development_screen.minimum_median_entry_dislocation
  };
}

function writeReport(result) {
  const base = result.summaries.base;
  const stress = result.summaries.stress;
  const lines = [
    `# ${ID} 结果`,
    '',
    `结论：\`${result.conclusion}\`。本结果仅属于 D0 开发筛选。`,
    '',
    `${stress.eventPairs} 个双腿事件的未计成本价格收益单位合计 `
      + `\`${stress.grossPriceReturnUnits >= 0 ? '+' : ''}${stress.grossPriceReturnUnits.toFixed(6)}\`；`
      + `压力成本后净收益 \`${stress.netReturnUnits.toFixed(6)}\`、PF `
      + `\`${stress.profitFactor == null ? 'n/a' : stress.profitFactor.toFixed(3)}\`。`,
    '',
    '| 情景 | 双腿事件 | 胜率 | 净收益单位 | PF | 去最佳5事件 | 最大回撤单位 |',
    '|---|---:|---:|---:|---:|---:|---:|'
  ];
  for (const name of ['base', 'stress', 'extreme']) {
    const item = result.summaries[name];
    lines.push(`| ${name} | ${item.eventPairs} | ${(100 * item.winRate).toFixed(1)}% | `
      + `${item.netReturnUnits.toFixed(6)} | `
      + `${item.profitFactor == null ? 'n/a' : item.profitFactor.toFixed(3)} | `
      + `${item.profitWithoutBest5Events.toFixed(6)} | `
      + `${item.maxDrawdownReturnUnits.toFixed(6)} |`);
  }
  lines.push(
    '',
    `基准成本后净收益：${base.netReturnUnits.toFixed(6)}。`,
    `失败项：${result.developmentScreen.failures.join(', ') || '无'}`,
    '',
    ...result.limitations.map(item => `- ${item}`),
    ''
  );
  fs.writeFileSync(REPORT, lines.join('\n'));
}

function run() {
  if (fs.existsSync(FAILURE)) throw new Error(`${ID} is already failed`);
  if (fs.existsSync(COMPLETION)) {
    const completion = verifyCompletion();
    console.log(JSON.stringify({ frozen: true, conclusion: completion.conclusion }, null, 2));
    return;
  }
  if ([RESULT, TRADES, REPORT].some(fs.existsSync)) {
    throw new Error('unfinalized result artifacts exist');
  }
  const config = JSON.parse(fs.readFileSync(PREREG, 'utf8'));
  const manifest = verifyManifest();
  if (manifest.missing_files > 0) {
    throw new Error(`${manifest.missing_files} required archives are missing`);
  }
  const fx = loadKind(manifest, config.data.fx_symbol, 'fx');
  const fxByTime = new Map(fx.map(row => [row.openTime, row]));
  const scenarios = scenarioRows(config);
  const tradesByScenario = Object.fromEntries(scenarios.map(row => [row.name, []]));
  const coverage = {};

  for (const baseAsset of config.base_assets) {
    const [usdtSymbol, usdcSymbol] = config.symbols[baseAsset];
    const usdtBars = loadKind(manifest, usdtSymbol, 'contract');
    const usdcBars = loadKind(manifest, usdcSymbol, 'contract');
    const series = buildPairSeries({ baseAsset, usdtBars, usdcBars, fxBars: fx });
    const events = detectPairEvents(series, eventOptions(config));
    const fundingKind = config.data.funding_source_type === 'rest_history_with_mark_price'
      ? 'fundingApi'
      : 'funding';
    const usdtFunding = loadKind(manifest, usdtSymbol, fundingKind);
    const usdcFunding = loadKind(manifest, usdcSymbol, fundingKind);
    const usdtMark = fundingKind === 'fundingApi' ? [] : loadKind(manifest, usdtSymbol, 'mark');
    const usdcMark = fundingKind === 'fundingApi' ? [] : loadKind(manifest, usdcSymbol, 'mark');
    const usdtMarkByTime = new Map(usdtMark.map(row => [row.openTime, row]));
    const usdcMarkByTime = new Map(usdcMark.map(row => [row.openTime, row]));
    for (const scenario of scenarios) {
      for (const event of events) {
        tradesByScenario[scenario.name].push(executePairEvent({
          event,
          series,
          usdtFunding,
          usdcFunding,
          usdtMarkByTime,
          usdcMarkByTime,
          fxByTime,
          scenario
        }));
      }
    }
    coverage[baseAsset] = {
      synchronizedBars: series.length,
      firstBar: series[0]?.openTime ?? null,
      lastBar: series.at(-1)?.openTime ?? null,
      usdtFundingRows: usdtFunding.length,
      usdcFundingRows: usdcFunding.length,
      events: events.length
    };
  }

  const summaries = Object.fromEntries(Object.entries(tradesByScenario).map(([name, trades]) => [
    name,
    summarizePairTrades(trades)
  ]));
  const screen = developmentScreen(
    summaries.stress,
    summaries.extreme,
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
      command: 'npm run exp:007:run'
    },
    coverage,
    summaries,
    developmentScreen: screen,
    limitations: [
      'All observations are exposed D0 development data and cannot prove out-of-sample profitability.',
      'The fixed eight-base panel was selected after archive coverage inspection and is not a point-in-time full-market universe.',
      'Contract and FX 5m opens plus fixed slippage cannot prove that both live legs would fill simultaneously.',
      'The extreme one-bar leg delay is deterministic and is not an order-book or outage replay.',
      'USDC settlement cash flows are converted with spot bar opens; collateral haircuts, cross-margin rules and conversion fees are absent.',
      'Return-unit drawdown orders overlapping event exits and is not leveraged account equity drawdown.',
      'A pass would still require a new full-universe replication, order-book shadow fills and forward evidence.'
    ]
  };
  fs.writeFileSync(
    TRADES,
    `${Object.values(tradesByScenario).flat().map(JSON.stringify).join('\n')}\n`
  );
  fs.writeFileSync(RESULT, `${JSON.stringify(result, null, 2)}\n`);
  writeReport(result);
  console.log(JSON.stringify({
    events: summaries.stress.eventPairs,
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
  const artifacts = [PREREG, MANIFEST, RESULT, TRADES, REPORT]
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
  else if (COMMAND === 'complete') complete(process.argv[REQUESTED_ID ? 4 : 3]);
  else throw new Error('usage: exp007.mjs download [ID] | run [ID] | complete [ID] CODE_COMMIT');
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
