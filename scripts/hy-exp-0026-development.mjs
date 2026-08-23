import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { appendRegistryEvent } from './registry.mjs';
import { runHyExp0026Development } from '../src/research/hy-exp-0026.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACT_DIR = path.join(ROOT, 'artifacts', 'HY-EXP-0026');
const MANIFEST = path.join(ARTIFACT_DIR, 'development-manifest.json');
const RESULT = path.join(ARTIFACT_DIR, 'development-result.json');
const TRADES = path.join(ARTIFACT_DIR, 'development-trades.jsonl');
const DIAGNOSTICS = path.join(ARTIFACT_DIR, 'development-diagnostics.jsonl');
const CLOSURE = path.join(ARTIFACT_DIR, 'closure.json');

function relative(file) {
  return path.relative(ROOT, file).replaceAll('\\', '/');
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
}

function run() {
  for (const file of [MANIFEST, RESULT, TRADES, DIAGNOSTICS, CLOSURE]) {
    if (fs.existsSync(file)) throw new Error(`refusing to overwrite locked HY-EXP-0026 artifact: ${relative(file)}`);
  }
  const result = runHyExp0026Development({ root: ROOT });
  const manifest = {
    experimentId: result.experimentId,
    evidenceClass: result.evidenceClass,
    baseCommit: result.baseCommit,
    preregistrationSha256: result.preregistrationSha256,
    sourceExperimentId: result.development.sourceExperimentId,
    sourceManifestSha256: result.development.sourceManifestSha256,
    developmentStart: result.development.start,
    developmentEndExclusive: result.development.endExclusive,
    developmentPnlComputed: result.developmentPnlComputed,
    finalOosPnlComputed: result.finalOosPnlComputed,
    finalOosRead: result.finalOosRead,
    paperOnly: result.paperOnly,
    signalOnly: result.signalOnly,
    liveOrdersEnabled: result.liveOrdersEnabled,
    accountApi: result.accountApi,
    orderApi: result.orderApi,
    sourceRule: result.development.developmentSourceRule
  };
  writeJson(MANIFEST, manifest);
  writeJson(RESULT, {
    ...result,
    artifacts: {
      manifest: relative(MANIFEST),
      result: relative(RESULT),
      trades: relative(TRADES),
      diagnostics: relative(DIAGNOSTICS)
    }
  });
  writeJsonl(TRADES, result.trades);
  writeJsonl(DIAGNOSTICS, result.diagnostics);
  let failedEvent = null;
  if (!result.experimentalReleaseReady) {
    const closure = {
      experimentId: result.experimentId,
      status: 'FAILED',
      terminal: true,
      failureReason: 'DEVELOPMENT_GATES_FAILED',
      developmentResultPath: relative(RESULT),
      developmentResultSha256: createHash('sha256').update(fs.readFileSync(RESULT)).digest('hex'),
      experimentalReleaseReady: false,
      finalOosRead: false,
      productionDeploy: false,
      signalOnly: true,
      paperOnly: true,
      noParameterRescue: true,
      noSecondarySelection: true,
      uncertaintyVetoApplied: false,
      failedGates: Object.entries(result.development.metrics.fastGates.checks)
        .filter(([, passed]) => !passed)
        .map(([name]) => name)
    };
    writeJson(CLOSURE, closure);
    failedEvent = appendRegistryEvent({
      root: ROOT,
      experimentId: result.experimentId,
      eventType: 'failed',
      payloadPath: relative(CLOSURE),
      note: 'HY-EXP-0026 Development rule-advisory gates failed; terminal paper-only closure, no Final OOS read or live path.'
    });
  }
  console.log(JSON.stringify({
    experimentId: result.experimentId,
    status: result.status,
    experimentalReleaseReady: result.experimentalReleaseReady,
    metrics: result.development.metrics,
    foldReports: result.development.foldReports,
    secondaryDiagnostics: result.development.secondaryDiagnostics,
    artifacts: {
      manifest: relative(MANIFEST),
      result: relative(RESULT),
      trades: relative(TRADES),
      diagnostics: relative(DIAGNOSTICS),
      closure: fs.existsSync(CLOSURE) ? relative(CLOSURE) : null
    },
    failedEvent
  }, null, 2));
}

try {
  if (process.argv[2] !== 'run') throw new Error('usage: node scripts/hy-exp-0026-development.mjs run');
  run();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
