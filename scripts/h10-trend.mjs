import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertContiguous, mergeUniqueSeries, parseKlineArchive } from '../src/research/archive.mjs';
import { aggregateFourHourBars, promotionDecision, replayH10Trend, summarizeH10Trend } from '../src/research/h10-trend.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ID = 'HY-EXP-0016';
const SOURCE_ID = 'HY-EXP-0015';
const ARTIFACT = path.join(ROOT, 'artifacts', ID);
const PREREG = path.join(ROOT, 'registry', 'experiments', ID, 'preregistration.json');
const AMENDMENT = path.join(ROOT, 'registry', 'experiments', ID, 'amendment-001.json');
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
    amendmentSha256: sha256(fs.readFileSync(AMENDMENT)),
    files: source.files
  };
  fs.mkdirSync(ARTIFACT, { recursive: true });
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ experimentId: ID, reusedFiles: manifest.files.length, sourceManifestSha256: manifest.sourceManifestSha256 }, null, 2));
}

function evaluationMonths(start, endExclusive) {
  const months = [];
  const cursor = new Date(Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth(), 1));
  const end = new Date(endExclusive);
  while (cursor < end) {
    months.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

function run() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  if (manifest.preregistrationSha256 !== sha256(fs.readFileSync(PREREG))) throw new Error('preregistration changed after data lock');
  if (manifest.amendmentSha256 !== sha256(fs.readFileSync(AMENDMENT))) throw new Error('amendment changed after data lock');
  if (manifest.sourceManifestSha256 !== sha256(fs.readFileSync(SOURCE_MANIFEST))) throw new Error('source manifest changed after data lock');
  const trades = [];
  const coverage = {};
  for (const symbol of config.symbols) {
    const chunks = manifest.files.filter(row => row.symbol === symbol).map(item => {
      const file = path.join(ROOT, item.file);
      const buffer = fs.readFileSync(file);
      if (sha256(buffer) !== item.sha256) throw new Error(`hash mismatch: ${item.file}`);
      return parseKlineArchive(buffer, symbol, 'contract');
    });
    const fiveMinuteBars = mergeUniqueSeries(chunks, 'openTime', `${symbol}/h10-bars`)
      .filter(row => row.openTime >= Date.parse(config.data.download_start_utc)
        && row.openTime < Date.parse(config.data.evaluation_end_exclusive_utc));
    assertContiguous(fiveMinuteBars, `${symbol}/h10-bars`);
    const fourHourBars = aggregateFourHourBars(fiveMinuteBars);
    coverage[symbol] = {
      fiveMinuteBars: fiveMinuteBars.length,
      fourHourBars: fourHourBars.length,
      start: new Date(fourHourBars[0].openTime).toISOString(),
      end: new Date(fourHourBars.at(-1).closeTime).toISOString()
    };
    trades.push(...replayH10Trend(fourHourBars, {
      evaluationStart: Date.parse(config.data.evaluation_start_utc),
      evaluationEnd: Date.parse(config.data.evaluation_end_exclusive_utc),
      entryChannelBars: config.strategy.entry_channel_bars,
      exitChannelBars: config.strategy.exit_channel_bars,
      atrBars: config.strategy.atr_bars,
      initialStopAtrMultiple: config.strategy.initial_stop_atr_multiple,
      stressCostBpsPerFill: config.strategy.stress_cost_bps_per_fill
    }));
  }
  const monthKeys = evaluationMonths(config.data.evaluation_start_utc, config.data.evaluation_end_exclusive_utc);
  const summary = summarizeH10Trend(trades, { allocationFraction: 1 / config.symbols.length, monthKeys });
  const decision = promotionDecision(summary, config.promotion_screen);
  const result = {
    experimentId: ID,
    generatedAt: new Date().toISOString(),
    evidenceClass: config.evidence_class,
    evaluation: {
      start: config.data.evaluation_start_utc,
      endExclusive: config.data.evaluation_end_exclusive_utc,
      stressCostBpsPerFill: config.strategy.stress_cost_bps_per_fill,
      fixedAllocationPerSymbol: 1 / config.symbols.length
    },
    coverage,
    summary,
    decision,
    limitations: [
      'This is an in-sample historical screen of one frozen candidate, not independent forward validation.',
      'Funding payments are omitted and can improve or worsen actual perpetual-futures results.',
      'Fixed stressed fills do not reconstruct historical order-book slippage.',
      'Closed-equity drawdown excludes intratrade mark-to-market drawdown and therefore can understate risk.',
      'A pass permits only frozen forward paper validation, never immediate live replacement.'
    ]
  };
  fs.writeFileSync(TRADES, `${trades.sort((a, b) => a.exitTime - b.exitTime).map(JSON.stringify).join('\n')}\n`);
  fs.writeFileSync(RESULT, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}

const command = process.argv[2];
if (command === 'prepare') prepare();
else if (command === 'run') run();
else throw new Error('usage: node scripts/h10-trend.mjs prepare|run');
