import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLocalBookSnapshots } from '../src/model/local-book.mjs';
import { normalizeFundingRate, validateCaptureDirectory } from '../src/model/forward-data.mjs';
import { evaluateCaptureDataQuality } from '../src/model/data-quality.mjs';
import { simulateAdvisorySignal, summarizeAdvisoryTrades } from '../src/model/advisory-replay.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function flag(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}

function readRows(file) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8').trim();
  return text ? text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : [];
}

function readCapture(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  const records = [];
  for (const file of manifest.files ?? []) {
    const absolute = path.resolve(directory, path.basename(file.path));
    for (const row of readRows(absolute)) records.push(row);
  }
  return { manifest, records };
}

function normalizeMarketRecords(records) {
  const markPrices = [];
  const fundingRates = [];
  for (const record of records) {
    if (record.data?.e === 'markPriceUpdate') {
      markPrices.push({
        symbol: String(record.data.s).toUpperCase(),
        eventTime: Number(record.data.E),
        receivedAt: record.receivedAt,
        markPrice: Number(record.data.p)
      });
    } else if (record.data?.e === 'fundingRate') {
      fundingRates.push({ ...normalizeFundingRate(record.data), receivedAt: record.receivedAt });
    }
  }
  return { markPrices, fundingRates };
}

function main() {
  const captureInput = flag('capture');
  if (!captureInput) throw new Error('--capture is required');
  const directory = path.resolve(ROOT, captureInput);
  const validation = validateCaptureDirectory(directory);
  const { manifest, records } = readCapture(directory);
  const quality = evaluateCaptureDataQuality({ manifest, validation, requiredSymbols: manifest.symbols ?? [] });
  if (!quality.pnlEligible) {
    console.log(JSON.stringify({ experiment_id: 'HY-EXP-0014', status: 'NOT_READY', quality }, null, 2));
    process.exitCode = 1;
    return;
  }
  const signalFile = path.resolve(ROOT, flag('signals', 'data/signals.ndjson'));
  const signals = readRows(signalFile).filter(signal => signal.status === 'ADVISORY' || signal.status === 'OBSERVE');
  const books = buildLocalBookSnapshots({ records, snapshots: manifest.snapshots, symbols: manifest.symbols });
  const { markPrices, fundingRates } = normalizeMarketRecords(records);
  const trades = signals.map(signal => simulateAdvisorySignal({
    signal,
    books,
    markPrices,
    fundingRates,
    researchNotionalUsdt: Number(flag('research-notional', '1000'))
  }));
  const closed = trades.filter(trade => trade.status === 'CLOSED');
  const summary = summarizeAdvisoryTrades(trades);
  console.log(JSON.stringify({
    experiment_id: 'HY-EXP-0014',
    status: 'evaluated',
    quality,
    capture: { runId: manifest.run_id, symbols: manifest.symbols },
    counts: { signals: signals.length, trades: trades.length, closedTrades: closed.length },
    signalMode: { mode: 'SIGNAL_ONLY', humanConfirmationRequired: true, autoExecution: false, orderPlacement: false },
    summary,
    trades
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}

