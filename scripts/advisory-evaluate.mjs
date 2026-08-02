import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateHypothesisObservation } from '../src/model/advisory-evaluator.mjs';
import { appendAdvisoryRecord } from '../src/service/advisory-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function flag(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}

function inputFile() {
  const value = flag('input');
  if (!value) throw new Error('--input is required');
  return path.resolve(ROOT, value);
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function priceFromBook(book) {
  const bid = Number(book?.bids?.[0]?.[0]);
  const ask = Number(book?.asks?.[0]?.[0]);
  if (!(bid > 0) || !(ask > 0) || bid >= ask) throw new Error('book must have a valid best bid and ask');
  return (bid + ask) / 2;
}

function rowsFromInput(input) {
  if (Array.isArray(input)) return input;
  if (Array.isArray(input.rows)) return input.rows;
  return [input];
}

function main() {
  const input = loadJson(inputFile());
  const hypothesisPolicy = loadJson(path.join(ROOT, 'config', 'hypothesis-models.json'));
  const advisoryPolicy = loadJson(path.join(ROOT, 'config', 'advisory-alerts.json'));
  const fixedNotional = Number(flag('research-notional', '1000'));
  if (!Number.isFinite(fixedNotional) || fixedNotional <= 0) throw new Error('--research-notional must be positive');
  const signals = rowsFromInput(input).map(row => {
    const book = row.book;
    const quantity = row.quantity ?? (book ? fixedNotional / priceFromBook(book) : 1);
    return evaluateHypothesisObservation({
      hypothesisId: row.hypothesisId,
      observation: row.observation ?? row.event,
      book,
      quantity,
      now: row.now ?? Date.now(),
      hypothesisPolicy,
      advisoryPolicy,
      quality: row.quality ?? null
    });
  });
  if (flag('persist') === '1') {
    const signalsFile = path.resolve(ROOT, flag('signals-file', 'data/signals.ndjson'));
    const outboxFile = path.resolve(ROOT, flag('outbox-file', 'data/advisory-outbox.ndjson'));
    for (const signal of signals) appendAdvisoryRecord({ signal, signalsFile, outboxFile });
  }
  console.log(JSON.stringify({
    mode: 'SIGNAL_ONLY',
    authorization: 'PAPER_ONLY',
    persisted: flag('persist') === '1',
    count: signals.length,
    signals
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
