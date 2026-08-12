import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertContiguous, mergeUniqueSeries, parseKlineArchive } from '../src/research/archive.mjs';
import { continuationDecision, replayH9Proxy, summarizeH9Proxy } from '../src/research/h9-proxy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ID = 'HY-EXP-0015';
const RAW = path.join(ROOT, 'data', 'raw', ID);
const ARTIFACT = path.join(ROOT, 'artifacts', ID);
const PREREG = path.join(ROOT, 'registry', 'experiments', ID, 'preregistration.json');
const MANIFEST = path.join(ARTIFACT, 'data-manifest.json');
const RESULT = path.join(ARTIFACT, 'result.json');
const TRADES = path.join(ARTIFACT, 'trades.jsonl');
const command = process.argv[2];
const config = JSON.parse(fs.readFileSync(PREREG, 'utf8'));
const hash = buffer => createHash('sha256').update(buffer).digest('hex');
const relative = file => path.relative(ROOT, file).replaceAll('\\', '/');

function monthKeys(start, end) {
  const rows = [];
  const cursor = new Date(`${start}-01T00:00:00Z`);
  const last = new Date(`${end}-01T00:00:00Z`);
  while (cursor <= last) {
    rows.push(cursor.toISOString().slice(0, 7));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return rows;
}

function dayKeys(start, endExclusive) {
  const rows = [];
  for (let cursor = new Date(start); cursor < new Date(endExclusive); cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    rows.push(cursor.toISOString().slice(0, 10));
  }
  return rows;
}

function specs() {
  const months = monthKeys('2025-07', '2026-07');
  const days = dayKeys('2026-08-01T00:00:00Z', config.data.evaluation_end_exclusive_utc);
  return config.symbols.flatMap(symbol => [
    ...months.map(period => ({
      symbol, period, frequency: 'monthly',
      name: `${symbol}-5m-${period}.zip`,
      url: `https://data.binance.vision/data/futures/um/monthly/klines/${symbol}/5m/${symbol}-5m-${period}.zip`
    })),
    ...days.map(period => ({
      symbol, period, frequency: 'daily',
      name: `${symbol}-5m-${period}.zip`,
      url: `https://data.binance.vision/data/futures/um/daily/klines/${symbol}/5m/${symbol}-5m-${period}.zip`
    }))
  ]).map(row => ({ ...row, file: path.join(RAW, row.symbol, row.frequency, row.name) }));
}

async function mapLimit(items, limit, mapper) {
  const output = Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return output;
}

async function downloadOne(spec) {
  fs.mkdirSync(path.dirname(spec.file), { recursive: true });
  let buffer;
  if (fs.existsSync(spec.file)) buffer = fs.readFileSync(spec.file);
  else {
    let lastError;
    for (const delay of [0, 500, 1_000, 2_000, 4_000]) {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      try {
        const response = await fetch(spec.url, { signal: AbortSignal.timeout(60_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${spec.url}`);
        buffer = Buffer.from(await response.arrayBuffer());
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!buffer) throw lastError ?? new Error(`download failed: ${spec.url}`);
    fs.writeFileSync(spec.file, buffer);
  }
  parseKlineArchive(buffer, spec.symbol, 'contract');
  return { ...spec, file: relative(spec.file), bytes: buffer.length, sha256: hash(buffer) };
}

async function download() {
  const requested = specs();
  let completed = 0;
  const files = await mapLimit(requested, 4, async spec => {
    const result = await downloadOne(spec);
    completed++;
    if (completed % 20 === 0 || completed === requested.length) console.error(`verified ${completed}/${requested.length}`);
    return result;
  });
  const manifest = {
    experimentId: ID,
    generatedAt: new Date().toISOString(),
    preregistrationSha256: hash(fs.readFileSync(PREREG)),
    files: files.map(({ file, symbol, period, frequency, url, bytes, sha256 }) => ({ file, symbol, period, frequency, url, bytes, sha256 }))
  };
  fs.mkdirSync(ARTIFACT, { recursive: true });
  fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ files: files.length, bytes: files.reduce((total, row) => total + row.bytes, 0) }, null, 2));
}

function run() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  if (manifest.preregistrationSha256 !== hash(fs.readFileSync(PREREG))) throw new Error('preregistration changed after download');
  const allTrades = [];
  const coverage = {};
  for (const symbol of config.symbols) {
    const chunks = manifest.files.filter(row => row.symbol === symbol).map(item => {
      const buffer = fs.readFileSync(path.join(ROOT, item.file));
      if (hash(buffer) !== item.sha256) throw new Error(`hash mismatch: ${item.file}`);
      return parseKlineArchive(buffer, symbol, 'contract');
    });
    const bars = mergeUniqueSeries(chunks, 'openTime', `${symbol}/proxy-bars`)
      .filter(row => row.openTime >= Date.parse(config.data.download_start_utc)
        && row.openTime < Date.parse(config.data.evaluation_end_exclusive_utc));
    assertContiguous(bars, `${symbol}/proxy-bars`);
    coverage[symbol] = { bars: bars.length, start: new Date(bars[0].openTime).toISOString(), end: new Date(bars.at(-1).closeTime).toISOString() };
    allTrades.push(...replayH9Proxy(bars, {
      evaluationStart: Date.parse(config.data.evaluation_start_utc),
      evaluationEnd: Date.parse(config.data.evaluation_end_exclusive_utc),
      stressCostBpsPerFill: config.proxy.stress_cost_bps_per_fill
    }));
  }
  const summary = summarizeH9Proxy(allTrades);
  const decision = continuationDecision(summary, config.continuation_screen);
  const result = {
    experimentId: ID,
    generatedAt: new Date().toISOString(),
    evidenceClass: config.evidence_class,
    coverage,
    summary,
    decision,
    limitations: [
      'This is a public-kline continuation screen, not an exact H9 replay.',
      'Aggressive trade imbalance is not force-order liquidation pressure.',
      'Candle recovery is not causal five-second order-book recovery.',
      'Fixed stress cost is not a walked historical order book.',
      'A pass only justifies continued exact H9 collection; a fail stops prioritizing the frozen exact specification.'
    ]
  };
  fs.mkdirSync(ARTIFACT, { recursive: true });
  fs.writeFileSync(TRADES, `${allTrades.sort((a, b) => a.eventTime - b.eventTime).map(JSON.stringify).join('\n')}\n`);
  fs.writeFileSync(RESULT, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}

if (command === 'download') await download();
else if (command === 'run') run();
else throw new Error('usage: node scripts/h9-proxy.mjs download|run');
