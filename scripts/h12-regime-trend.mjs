import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertContiguous, mergeUniqueSeries, parseKlineArchive } from '../src/research/archive.mjs';
import { aggregateFourHourBars, replayH10Trend } from '../src/research/h10-trend.mjs';
import { summarizeH11, h11PromotionDecision } from '../src/research/h11-short-trend.mjs';
import { broadBearRegimeTimes } from '../src/research/h12-regime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ID = 'HY-EXP-0018';
const SOURCE_ID = 'HY-EXP-0015';
const ARTIFACT = path.join(ROOT, 'artifacts', ID);
const PREREG = path.join(ROOT, 'registry', 'experiments', ID, 'preregistration.json');
const SOURCE_MANIFEST = path.join(ROOT, 'artifacts', SOURCE_ID, 'data-manifest.json');
const MANIFEST = path.join(ARTIFACT, 'data-manifest.json');
const RESULT = path.join(ARTIFACT, 'result.json');
const TRADES = path.join(ARTIFACT, 'trades.jsonl');
const config = JSON.parse(fs.readFileSync(PREREG, 'utf8'));
const sha256 = value => createHash('sha256').update(value).digest('hex');

function prepare() {
  const source = JSON.parse(fs.readFileSync(SOURCE_MANIFEST, 'utf8'));
  const manifest = {
    experimentId: ID,
    generatedAt: new Date().toISOString(),
    sourceExperimentId: SOURCE_ID,
    sourceManifest: path.relative(ROOT, SOURCE_MANIFEST).replaceAll('\\', '/'),
    sourceManifestSha256: sha256(fs.readFileSync(SOURCE_MANIFEST)),
    preregistrationSha256: sha256(fs.readFileSync(PREREG)),
    files: source.files
  };
  fs.mkdirSync(ARTIFACT, { recursive: true });
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ experimentId: ID, reusedFiles: manifest.files.length }, null, 2));
}

function monthKeys(start, endExclusive) {
  const startDate = new Date(start);
  const cursor = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1));
  const end = new Date(endExclusive);
  const output = [];
  while (cursor < end) {
    output.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return output;
}

function groupStatistics(trades) {
  const groups = {};
  for (const trade of trades) (groups[trade.symbol] ??= []).push(trade);
  return Object.fromEntries(Object.entries(groups).map(([symbol, rows]) => {
    const wins = rows.filter(row => row.netReturn > 0);
    const losses = rows.filter(row => row.netReturn < 0);
    const profit = wins.reduce((total, row) => total + row.netReturn, 0);
    const loss = -losses.reduce((total, row) => total + row.netReturn, 0);
    return [symbol, {
      trades: rows.length,
      wins: wins.length,
      winRate: wins.length / rows.length,
      profitFactor: loss > 0 ? profit / loss : null,
      accountReturnFraction: rows.reduce((total, row) => total + row.netReturn / config.symbols.length, 0)
    }];
  }));
}

function loadSeries(manifest, symbol) {
  const chunks = manifest.files.filter(row => row.symbol === symbol).map(item => {
    const buffer = fs.readFileSync(path.join(ROOT, item.file));
    if (sha256(buffer) !== item.sha256) throw new Error(`hash mismatch: ${item.file}`);
    return parseKlineArchive(buffer, symbol, 'contract');
  });
  const bars = mergeUniqueSeries(chunks, 'openTime', `${symbol}/h12-bars`)
    .filter(row => row.openTime >= Date.parse(config.data.download_start_utc)
      && row.openTime < Date.parse(config.data.evaluation_end_exclusive_utc));
  assertContiguous(bars, `${symbol}/h12-bars`);
  return aggregateFourHourBars(bars);
}

function run() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  if (manifest.preregistrationSha256 !== sha256(fs.readFileSync(PREREG))) throw new Error('preregistration changed after data lock');
  if (manifest.sourceManifestSha256 !== sha256(fs.readFileSync(SOURCE_MANIFEST))) throw new Error('source manifest changed after data lock');
  const seriesBySymbol = Object.fromEntries(config.symbols.map(symbol => [symbol, loadSeries(manifest, symbol)]));
  const regime = config.strategy.regime;
  const eligibleTimes = broadBearRegimeTimes(seriesBySymbol, {
    symbols: config.symbols,
    fastBars: regime.btc_fast_sma_bars,
    slowBars: regime.slow_sma_bars,
    minimumBreadth: regime.minimum_breadth_below_slow_sma
  });
  const trades = [];
  const coverage = {};
  for (const symbol of config.symbols) {
    const bars = seriesBySymbol[symbol];
    coverage[symbol] = {
      fourHourBars: bars.length,
      start: new Date(bars[0].openTime).toISOString(),
      end: new Date(bars.at(-1).closeTime).toISOString()
    };
    trades.push(...replayH10Trend(bars, {
      evaluationStart: Date.parse(config.data.evaluation_start_utc),
      evaluationEnd: Date.parse(config.data.evaluation_end_exclusive_utc),
      entryChannelBars: config.strategy.entry_channel_bars,
      exitChannelBars: config.strategy.exit_channel_bars,
      atrBars: config.strategy.atr_bars,
      initialStopAtrMultiple: config.strategy.initial_stop_atr_multiple,
      stressCostBpsPerFill: config.strategy.stress_cost_bps_per_fill,
      allowLong: false,
      allowShort: true,
      entryFilter: ({ bar }) => eligibleTimes.has(bar.openTime)
    }));
  }
  const allocationFraction = 1 / config.symbols.length;
  const summary = summarizeH11(trades, {
    allocationFraction,
    monthKeys: monthKeys(config.data.evaluation_start_utc, config.data.evaluation_end_exclusive_utc),
    midpoint: Date.parse(config.data.evaluation_midpoint_utc)
  });
  summary.grossAccountReturnFraction = trades.reduce((total, row) => total + row.grossReturn * allocationFraction, 0);
  summary.stressCostAccountFraction = trades.length * 2 * config.strategy.stress_cost_bps_per_fill / 10_000 * allocationFraction;
  summary.bySymbolStatistics = groupStatistics(trades);
  const decision = h11PromotionDecision(summary, config.promotion_screen);
  const evaluationStart = Date.parse(config.data.evaluation_start_utc);
  const evaluationEnd = Date.parse(config.data.evaluation_end_exclusive_utc);
  const result = {
    experimentId: ID,
    generatedAt: new Date().toISOString(),
    evidenceClass: config.evidence_class,
    selectionDisclosure: config.selection_disclosure,
    evaluation: {
      start: config.data.evaluation_start_utc,
      midpoint: config.data.evaluation_midpoint_utc,
      endExclusive: config.data.evaluation_end_exclusive_utc,
      stressCostBpsPerFill: config.strategy.stress_cost_bps_per_fill,
      fixedAllocationPerSymbol: allocationFraction,
      eligibleRegimeBars: [...eligibleTimes].filter(time => time >= evaluationStart && time < evaluationEnd).length
    },
    coverage,
    summary,
    decision,
    limitations: [
      'H12 is a third iteration selected after observing H10 and H11 on this same interval; it is not independent validation.',
      'Funding payments are omitted and can improve or worsen actual perpetual-futures results.',
      'Fixed stressed fills do not reconstruct historical order-book slippage.',
      'Closed-equity drawdown excludes intratrade mark-to-market drawdown and therefore can understate risk.',
      'A pass permits only a newly frozen forward paper-validation clock.'
    ]
  };
  fs.writeFileSync(TRADES, `${trades.sort((a, b) => a.exitTime - b.exitTime).map(JSON.stringify).join('\n')}\n`);
  fs.writeFileSync(RESULT, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}

const command = process.argv[2];
if (command === 'prepare') prepare();
else if (command === 'run') run();
else throw new Error('usage: node scripts/h12-regime-trend.mjs prepare|run');
