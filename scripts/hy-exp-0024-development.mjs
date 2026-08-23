import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildHyExp0024Manifest,
  loadHyExp0024Dataset,
  runHyExp0024Development
} from '../src/research/hy-exp-0024.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACT_DIR = path.join(ROOT, 'artifacts', 'HY-EXP-0024');
const MANIFEST = path.join(ARTIFACT_DIR, 'development-manifest.json');
const RESULT = path.join(ARTIFACT_DIR, 'development-result.json');
const TRADES = path.join(ARTIFACT_DIR, 'development-trades.jsonl');
const DIAGNOSTICS = path.join(ARTIFACT_DIR, 'development-diagnostics.jsonl');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
}

function relative(file) {
  return path.relative(ROOT, file).replaceAll('\\', '/');
}

function run() {
  const refresh = process.argv.includes('--refresh');
  for (const file of [MANIFEST, RESULT, TRADES, DIAGNOSTICS]) {
    if (fs.existsSync(file) && !refresh) throw new Error(`refusing to overwrite locked HY-EXP-0024 Development artifact: ${relative(file)}`);
  }
  const dataset = loadHyExp0024Dataset({ root: ROOT });
  const result = runHyExp0024Development({ dataset });
  const manifest = buildHyExp0024Manifest({ root: ROOT });
  writeJson(MANIFEST, { ...manifest, generatedAt: new Date().toISOString() });
  writeJson(RESULT, {
    ...result,
    developmentPnlComputed: true,
    finalOosPnlComputed: false,
    finalOosRead: false,
    finalOosData: 'UNREAD',
    artifacts: {
      manifest: relative(MANIFEST),
      result: relative(RESULT),
      trades: relative(TRADES),
      diagnostics: relative(DIAGNOSTICS)
    }
  });
  writeJsonl(TRADES, result.trades);
  writeJsonl(DIAGNOSTICS, result.diagnostics);
  console.log(JSON.stringify({
    experimentId: result.experimentId,
    status: result.status,
    experimentalReleaseReady: result.experimentalReleaseReady,
    development: result.development.metrics,
    fastTrackGates: result.development.fastTrackGates,
    fullDevelopmentGates: result.development.fullDevelopmentGates,
    artifacts: {
      manifest: relative(MANIFEST),
      result: relative(RESULT),
      trades: relative(TRADES),
      diagnostics: relative(DIAGNOSTICS)
    }
  }, null, 2));
}

try {
  if (process.argv[2] !== 'run') throw new Error('usage: node scripts/hy-exp-0024-development.mjs run');
  run();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
