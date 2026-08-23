import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendRegistryEvent } from './registry.mjs';
import { runHyExp0029Development } from '../src/research/hy-exp-0029.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACT_ROOT = path.join(ROOT, 'artifacts', 'HY-EXP-0029');
const RESULT_PATH = path.join(ARTIFACT_ROOT, 'development-result.json');
const CLOSURE_PATH = path.join(ARTIFACT_ROOT, 'closure.json');

function relative(file) {
  return path.relative(ROOT, file).replaceAll(path.sep, '/');
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) throw new Error(`refusing to overwrite locked HY-EXP-0029 artifact: ${relative(file)}`);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function main() {
  const [command] = process.argv.slice(2);
  if (command !== 'run') throw new Error('usage: node scripts/hy-exp-0029-development.mjs run');
  if (fs.existsSync(RESULT_PATH) || fs.existsSync(CLOSURE_PATH)) {
    throw new Error('HY-EXP-0029 Development result is already locked; rerun refused');
  }
  const result = runHyExp0029Development({ root: ROOT });
  writeJson(RESULT_PATH, result);
  if (!result.experimentalReleaseReady) {
    const failedGates = Object.entries(result.development.metrics.developmentGates.checks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name);
    const closure = {
      schemaVersion: 1,
      artifactType: 'HY_EXP_0029_CLOSURE',
      experimentId: 'HY-EXP-0029',
      status: 'DEVELOPMENT_FAILED_TERMINAL',
      terminal: true,
      reason: 'DEVELOPMENT_GATES_FAILED',
      failedGates,
      rawCandidateCount: result.development.rawCandidateCount,
      labeledCandidateCount: result.development.labeledCandidateCount,
      oofPredictionCount: result.development.oofPredictionCount,
      advisoryCount: result.development.advisoryCount,
      metrics: result.development.metrics,
      finalOosRead: false,
      finalOosPnlComputed: false,
      productionDeploy: false,
      paperOnly: true,
      signalOnly: true,
      liveOrdersEnabled: false,
      accountApi: false,
      orderApi: false,
      noParameterRescue: true,
      noSecondDevelopmentPass: true,
      nextStep: 'STOP_HY_EXP_0029; any new candidate family requires a new experiment ID.'
    };
    writeJson(CLOSURE_PATH, closure);
    const event = appendRegistryEvent({
      root: ROOT,
      experimentId: 'HY-EXP-0029',
      eventType: 'failed',
      payloadPath: relative(CLOSURE_PATH),
      note: 'HY-EXP-0029 TREND_PULLBACK_RECLAIM Development gates failed; terminal paper-only closure, no prospective validation or Final OOS read.'
    });
    console.log(JSON.stringify({
      resultPath: relative(RESULT_PATH),
      closurePath: relative(CLOSURE_PATH),
      status: result.status,
      failedGates,
      registryEvent: event
    }, null, 2));
    return;
  }
  console.log(JSON.stringify({
    resultPath: relative(RESULT_PATH),
    status: result.status,
    developmentPass: true,
    prospectiveValidationPrepared: true,
    deployed: false
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
