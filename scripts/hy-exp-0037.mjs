import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BASE_MAIN_COMMIT,
  DEVELOPMENT_END,
  DEVELOPMENT_START,
  FIXED_SYMBOLS,
  HY_EXP_0037,
  SOURCE_MANIFEST_PATH,
  SOURCE_MANIFEST_SHA256,
  VALIDATION_END,
  VALIDATION_START,
  buildCompletionBundle,
  buildDataManifest,
  buildDevelopmentReport,
  buildEmailPreparation,
  buildFrozenModelSpec,
  buildHistoricalValidationReport,
  buildSeries,
  generateCandidates,
  loadSourceManifest,
  resolveCandidates,
  runDevelopmentWalkForward,
  runHistoricalValidation,
  selectDevelopmentConfig,
  sha256,
  sha256File,
  writeJson,
  iso
} from '../src/research/hy-exp-0037-email-signal.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACT_DIR = path.join(ROOT, 'artifacts', HY_EXP_0037);
const PREREG_PATH = path.join(ROOT, 'registry', 'experiments', HY_EXP_0037, 'preregistration.json');
const DATA_MANIFEST_PATH = path.join(ARTIFACT_DIR, 'data-manifest.json');

function argument(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1] ?? fallback;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function safeSummary(value) {
  return JSON.stringify(value, null, 2);
}

function artifactEntry(relative) {
  const absolute = path.join(ROOT, relative);
  return { path: relative.replaceAll('\\', '/'), sha256: sha256File(absolute) };
}

function lockData() {
  const source = loadSourceManifest({ root: ROOT });
  const manifest = buildDataManifest({ root: ROOT, sourceManifest: source });
  writeJson(DATA_MANIFEST_PATH, manifest);
  console.log(safeSummary({
    mode: 'DATA_LOCK',
    experimentId: HY_EXP_0037,
    sourceManifestPath: SOURCE_MANIFEST_PATH,
    sourceManifestSha256: SOURCE_MANIFEST_SHA256,
    dataManifestSha256: sha256File(DATA_MANIFEST_PATH),
    verifiedFiles: manifest.verifiedFiles,
    symbols: manifest.symbols,
    requiredStreams: manifest.requiredStreams,
    outcomeRead: manifest.outcomeRead,
    pnlComputed: manifest.pnlComputed,
    finalOosRead: manifest.finalOosRead,
    status: manifest.coverageStatus
  }));
}

function writeHistoricalMarkdown(report, development, codeCommit, dataManifestSha256) {
  const lines = [
    '# HY-EXP-0037 Historical Validation',
    '',
    `- Code commit: \`${codeCommit}\``,
    `- Data manifest SHA-256: \`${dataManifestSha256}\``,
    `- Development: ${iso(DEVELOPMENT_START)} to ${iso(DEVELOPMENT_END)} (exclusive)`,
    `- Historical validation: ${iso(VALIDATION_START)} to ${iso(VALIDATION_END)} (exclusive)`,
    '- Validation type: registered historical validation, not Final OOS',
    '- Final OOS read: false',
    '',
    `## Result: ${report.result}`,
    '',
    `Development config: **${development.status}**`,
    `Historical predictions: **${report.counts.predictions}**`,
    `Accepted signals: **${report.counts.accepted}**`,
    '',
    '| Gate | Result |',
    '|---|---|'
  ];
  for (const [name, value] of Object.entries(report.gates)) lines.push(`| ${name} | ${value ? 'PASS' : 'FAIL'} |`);
  lines.push('', `Gate failures: ${report.gateFailures.join(', ') || 'none'}`, '', 'No Final OOS was read. No email, scheduler, order, account, private API, or trading action is authorized.');
  fs.writeFileSync(path.join(ARTIFACT_DIR, 'historical-validation.md'), `${lines.join('\n')}\n`);
}

function runResearch() {
  const codeCommit = argument('code-commit');
  if (!/^[a-f0-9]{40}$/.test(codeCommit ?? '')) throw new Error('CODE_COMMIT_REQUIRED_AS_FULL_SHA');
  const preregistrationSha256 = sha256File(PREREG_PATH);
  const dataManifest = readJson(DATA_MANIFEST_PATH);
  if (dataManifest.experimentId !== HY_EXP_0037) throw new Error('DATA_MANIFEST_EXPERIMENT_MISMATCH');
  if (dataManifest.sourceManifestSha256 !== SOURCE_MANIFEST_SHA256) throw new Error('DATA_MANIFEST_SOURCE_HASH_MISMATCH');
  if (dataManifest.outcomeRead || dataManifest.pnlComputed || dataManifest.finalOosRead) throw new Error('DATA_MANIFEST_NOT_PRE_OUTCOME_CLEAN');
  const source = loadSourceManifest({ root: ROOT });
  const series = buildSeries({ root: ROOT, sourceManifest: source });
  const generated = generateCandidates(series);
  const resolved = resolveCandidates(generated.candidates, series);
  const walkForward = runDevelopmentWalkForward(resolved.resolved);
  const developmentConfig = selectDevelopmentConfig(walkForward.predictions);
  const developmentReport = buildDevelopmentReport({
    candidates: generated.candidates,
    outcomes: resolved.outcomes,
    walkForward,
    developmentConfig
  });
  const historical = runHistoricalValidation(resolved.resolved, developmentConfig);
  const validation = buildHistoricalValidationReport({ history: historical, series, developmentConfig });
  const frozenModelSpec = buildFrozenModelSpec({ developmentConfig, preregistrationSha256 });

  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeJson(path.join(ARTIFACT_DIR, 'development-report.json'), developmentReport);
  writeJson(path.join(ARTIFACT_DIR, 'frozen-model-spec.json'), frozenModelSpec);
  writeJson(path.join(ARTIFACT_DIR, 'historical-validation.json'), validation.result);
  writeJson(path.join(ARTIFACT_DIR, 'development-oof-summary.json'), {
    schemaVersion: 1,
    artifactType: 'HY_EXP_0037_DEVELOPMENT_OOF_SUMMARY',
    immutable: true,
    experimentId: HY_EXP_0037,
    count: walkForward.predictions.length,
    sample: walkForward.predictions.slice(0, 25),
    folds: walkForward.folds,
    fullOofPersisted: false,
    reason: 'Compact evidence only; reproducible from preregistration, data manifest and code.'
  });
  const historicalTrades = historical.accepted ?? [];
  fs.writeFileSync(path.join(ARTIFACT_DIR, 'historical-trades.jsonl'), `${historicalTrades.map(row => JSON.stringify(row)).join('\n')}${historicalTrades.length ? '\n' : ''}`);
  writeHistoricalMarkdown(validation.result, developmentConfig, codeCommit, sha256File(DATA_MANIFEST_PATH));

  const emailPreparation = validation.result.emailPreparationEligible
    ? buildEmailPreparation({
      validation: validation.result,
      codeCommit,
      preregistrationSha256,
      dataManifestSha256: sha256File(DATA_MANIFEST_PATH)
    })
    : null;
  if (emailPreparation) writeJson(path.join(ARTIFACT_DIR, 'email-preparation.json'), emailPreparation);
  if (emailPreparation) {
    writeJson(path.join(ROOT, 'registry', 'forward', 'HY-FWD-0037-001.json'), {
      schemaVersion: 1,
      artifactType: 'HY_FWD_0037_PAPER_VALIDATION_PREPARATION',
      immutable: true,
      experimentId: 'HY-FWD-0037-001',
      sourceExperiment: HY_EXP_0037,
      activated: false,
      minimumDays: 30,
      minimumSignals: 20,
      paperOnly: true,
      signalOnly: true,
      gmailSendEnabled: false,
      schedulerActivated: false,
      realEmailSent: false,
      automaticTrading: false,
      accountApi: false,
      orderApi: false,
      finalOosRead: false
    });
  }

  const relativeArtifacts = [
    'registry/experiments/HY-EXP-0037/preregistration.json',
    'artifacts/HY-EXP-0037/data-manifest.json',
    'artifacts/HY-EXP-0037/development-report.json',
    'artifacts/HY-EXP-0037/frozen-model-spec.json',
    'artifacts/HY-EXP-0037/historical-validation.json',
    'artifacts/HY-EXP-0037/historical-validation.md',
    'artifacts/HY-EXP-0037/development-oof-summary.json',
    'artifacts/HY-EXP-0037/historical-trades.jsonl'
  ];
  if (emailPreparation) {
    relativeArtifacts.push('artifacts/HY-EXP-0037/email-preparation.json', 'registry/forward/HY-FWD-0037-001.json');
  }
  const finalResult = developmentConfig.status === 'DEVELOPMENT_CONFIG_FOUND'
    ? validation.result.result
    : 'NO_DEVELOPMENT_CONFIG';
  const completionBundle = buildCompletionBundle({
    codeCommit,
    preregistrationSha256,
    dataManifestSha256: sha256File(DATA_MANIFEST_PATH),
    artifactEntries: relativeArtifacts.map(artifactEntry),
    finalResult,
    emailPreparation
  });
  writeJson(path.join(ARTIFACT_DIR, 'completion-bundle.json'), completionBundle);
  console.log(safeSummary({
    mode: 'RESEARCH',
    codeCommit,
    preregistrationSha256,
    dataManifestSha256: sha256File(DATA_MANIFEST_PATH),
    candidates: generated.counts,
    outcomes: { total: resolved.outcomes.length, resolved: resolved.resolved.length, invalid: resolved.invalid },
    development: { status: developmentConfig.status, oofPredictions: walkForward.predictions.length, folds: walkForward.folds.length },
    historical: {
      status: validation.result.status,
      predictions: validation.result.counts.predictions,
      accepted: validation.result.counts.accepted,
      result: validation.result.result,
      gateFailures: validation.result.gateFailures
    },
    emailPreparation: Boolean(emailPreparation),
    safety: { paperOnly: true, signalOnly: true, gmail: false, scheduler: false, realEmail: false, automaticTrading: false, accountApi: false, orderApi: false, finalOosRead: false, productionDeploy: false }
  }, null, 2));
}

const mode = process.argv[2];
if (mode === 'lock') lockData();
else if (mode === 'run') runResearch();
else throw new Error('usage: node scripts/hy-exp-0037.mjs lock | run --code-commit FULL_SHA');
