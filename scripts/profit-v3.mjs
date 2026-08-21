import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  buildProfitV3DataManifest,
  loadProfitV3Dataset,
  runProfitV3Backtest,
  summarizeProfitV3
} from '../src/research/profit-v3.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
const EXPERIMENT_ID = 'HY-EXP-0019';
const EXPERIMENT_DIR = path.join(ROOT, 'artifacts', EXPERIMENT_ID);
const PREREGISTRATION = path.join(ROOT, 'registry', 'experiments', EXPERIMENT_ID, 'preregistration.json');
const DATA_MANIFEST = path.join(EXPERIMENT_DIR, 'data-manifest.json');
const RESULT = path.join(EXPERIMENT_DIR, 'result.json');
const TRADES = path.join(EXPERIMENT_DIR, 'trades.jsonl');
const SCANS = path.join(EXPERIMENT_DIR, 'scan-diagnostics.jsonl');

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function relative(file) {
  return path.relative(ROOT, file).replaceAll('\\', '/');
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rows.map(row => JSON.stringify(row)).join('\n')}${rows.length ? '\n' : ''}`);
}

function prepare() {
  const preregistrationBuffer = fs.readFileSync(PREREGISTRATION);
  const manifest = buildProfitV3DataManifest({
    root: ROOT,
    preregistrationSha256: sha256(preregistrationBuffer)
  });
  writeJson(DATA_MANIFEST, manifest);
  console.log(JSON.stringify({
    experimentId: EXPERIMENT_ID,
    dataManifest: relative(DATA_MANIFEST),
    files: manifest.files.length,
    sourceManifestSha256: manifest.source_manifest_sha256,
    preregistrationSha256: manifest.preregistration_sha256
  }, null, 2));
}

function assertLockedManifest() {
  const preregistrationSha256 = sha256(fs.readFileSync(PREREGISTRATION));
  const manifest = JSON.parse(fs.readFileSync(DATA_MANIFEST, 'utf8'));
  if (manifest.experiment_id !== EXPERIMENT_ID) throw new Error('Profit V3 data manifest experiment mismatch');
  if (manifest.preregistration_sha256 !== preregistrationSha256) {
    throw new Error('Profit V3 data manifest does not match preregistration');
  }
}

function run() {
  if (!fs.existsSync(DATA_MANIFEST)) prepare();
  assertLockedManifest();
  if (fs.existsSync(RESULT) || fs.existsSync(TRADES) || fs.existsSync(SCANS)) {
    throw new Error('Profit V3 result artifacts already exist; refusing to overwrite');
  }
  const dataset = loadProfitV3Dataset({ root: ROOT });
  const result = runProfitV3Backtest({ dataset });
  const persisted = { ...result };
  delete persisted.trades;
  delete persisted.scans;
  persisted.artifacts = {
    ...result.artifacts,
    dataManifest: relative(DATA_MANIFEST),
    trades: relative(TRADES),
    scans: relative(SCANS),
    result: relative(RESULT)
  };
  writeJsonl(TRADES, result.trades);
  writeJsonl(SCANS, result.scans);
  writeJson(RESULT, persisted);
  console.log(JSON.stringify({
    experimentId: EXPERIMENT_ID,
    result: relative(RESULT),
    trades: relative(TRADES),
    scans: relative(SCANS),
    summary: summarizeProfitV3(result)
  }, null, 2));
}

const command = process.argv[2];
try {
  if (command === 'prepare') prepare();
  else if (command === 'run') run();
  else throw new Error('usage: node scripts/profit-v3.mjs prepare|run');
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
