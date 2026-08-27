import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BASE_MAIN_COMMIT,
  DEVELOPMENT_END,
  DEVELOPMENT_START,
  FIXED_SYMBOLS,
  HY_EXP_0039,
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
} from '../src/research/hy-exp-0039-email-signal.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACT_DIR = path.join(ROOT, 'artifacts', HY_EXP_0039);
const PREREG_PATH = path.join(ROOT, 'registry', 'experiments', HY_EXP_0039, 'preregistration.json');
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
    experimentId: HY_EXP_0039,
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
    '# HY-EXP-0039 Historical Validation',
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
  if (dataManifest.experimentId !== HY_EXP_0039) throw new Error('DATA_MANIFEST_EXPERIMENT_MISMATCH');
  if (dataManifest.sourceManifestSha256 !== SOURCE_MANIFEST_SHA256) throw new Error('DATA_MANIFEST_SOURCE_HASH_MISMATCH');
  if (dataManifest.outcomeRead || dataManifest.pnlComputed || dataManifest.finalOosRead) throw new Error('DATA_MANIFEST_NOT_PRE_OUTCOME_CLEAN');
  const source = loadSourceManifest({ root: ROOT });
  const series = buildSeries({ root: ROOT, sourceManifest: source });
  const generated = generateCandidates(series);
  if (generated.coverage.coverageRatio !== 1 || generated.coverage.maxUnexpectedGapMs !== 0
    || generated.counts.BUY !== generated.counts.SELL
    || generated.coverage.BUY !== generated.coverage.SELL) {
    throw new Error(`CANDIDATE_COVERAGE_FAILED:${JSON.stringify(generated.coverage)}`);
  }
  const resolved = resolveCandidates(generated.candidates, series);
  const walkForward = runDevelopmentWalkForward(resolved.resolved);
  const developmentConfig = selectDevelopmentConfig(walkForward.predictionsByLambda, { series });
  const developmentReport = buildDevelopmentReport({
    candidates: generated.candidates,
    outcomes: resolved.outcomes,
    walkForward,
    developmentConfig,
    candidateCoverage: generated.coverage
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
    artifactType: 'HY_EXP_0039_DEVELOPMENT_OOF_SUMMARY',
    immutable: true,
    experimentId: HY_EXP_0039,
    count: walkForward.predictions.length,
    countsByLambda: Object.fromEntries(Object.entries(walkForward.predictionsByLambda ?? {} ).map(([lambda, rows]) => [lambda, rows.length])),
    expectedOofCountPerLambda: walkForward.expectedOofCountPerLambda ?? null,
    oofCoverageRatioByLambda: walkForward.oofCoverageRatioByLambda ?? null,
    oofCandidateIdsEqual: walkForward.oofCandidateIdsEqual ?? false,
    sample: walkForward.predictions.slice(0, 25),
    folds: walkForward.folds,
    fullOofPersisted: false,
    reason: 'Compact evidence only; reproducible from preregistration, data manifest and code.'
  });
  const historicalTrades = historical.accepted ?? [];
  fs.writeFileSync(path.join(ARTIFACT_DIR, 'historical-trades.jsonl'), `${historicalTrades.map(row => JSON.stringify(row)).join('\n')}${historicalTrades.length ? '\n' : ''}`);
  writeJson(path.join(ARTIFACT_DIR, 'candidate-coverage.json'), {
    schemaVersion: 1,
    artifactType: 'HY_EXP_0039_CANDIDATE_COVERAGE',
    immutable: true,
    experimentId: HY_EXP_0039,
    preregistrationSha256,
    dataManifestSha256: sha256File(DATA_MANIFEST_PATH),
    coverage: generated.coverage,
    counts: generated.counts,
    requiredCoverageRatio: 1,
    coveragePass: generated.coverage.coverageRatio === 1 && generated.coverage.maxUnexpectedGapMs === 0,
    safety: { outcomeRead: true, finalOosRead: false, paperOnly: true, signalOnly: true }
  });
  writeJson(path.join(ARTIFACT_DIR, 'development-selection-grid.json'), {
    schemaVersion: 1,
    artifactType: 'HY_EXP_0039_DEVELOPMENT_SELECTION_GRID',
    immutable: true,
    experimentId: HY_EXP_0039,
    preregistrationSha256,
    dataManifestSha256: sha256File(DATA_MANIFEST_PATH),
    status: developmentConfig.status,
    reason: developmentConfig.reason ?? null,
    grid: developmentConfig.selectionGrid ?? [],
    diagnostics: developmentConfig.selectionDiagnostics ?? null,
    oofCountsByLambda: developmentConfig.oofCountsByLambda ?? walkForward.oofCountsByLambda ?? null,
    expectedOofCountPerLambda: developmentConfig.expectedOofCountPerLambda ?? walkForward.expectedOofCountPerLambda ?? null,
    oofCoverageRatioByLambda: developmentConfig.oofCoverageRatioByLambda ?? walkForward.oofCoverageRatioByLambda ?? null,
    oofCandidateIdsEqual: developmentConfig.oofCandidateIdsEqual ?? walkForward.oofCandidateIdsEqual ?? false,
    safety: { outcomeRead: true, finalOosRead: false, paperOnly: true, signalOnly: true }
  });
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
      sourceExperiment: HY_EXP_0039,
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
    'registry/experiments/HY-EXP-0039/preregistration.json',
    'artifacts/HY-EXP-0039/data-manifest.json',
    'artifacts/HY-EXP-0039/development-report.json',
    'artifacts/HY-EXP-0039/frozen-model-spec.json',
    'artifacts/HY-EXP-0039/historical-validation.json',
    'artifacts/HY-EXP-0039/historical-validation.md',
    'artifacts/HY-EXP-0039/development-oof-summary.json',
    'artifacts/HY-EXP-0039/historical-trades.jsonl',
    'artifacts/HY-EXP-0039/candidate-coverage.json',
    'artifacts/HY-EXP-0039/development-selection-grid.json'
  ];
  if (emailPreparation) {
    relativeArtifacts.push('artifacts/HY-EXP-0039/email-preparation.json', 'registry/forward/HY-FWD-0037-001.json');
  }
  const finalResult = validation.result.productConclusion;
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
    candidateCoverage: generated.coverage,
    outcomes: { total: resolved.outcomes.length, resolved: resolved.resolved.length, invalid: resolved.invalid },
    development: {
      status: developmentConfig.status,
      oofPredictions: walkForward.predictions.length,
      folds: walkForward.folds.length,
      oofCountsByLambda: walkForward.oofCountsByLambda,
      expectedOofCountPerLambda: walkForward.expectedOofCountPerLambda,
      oofCoverageRatioByLambda: walkForward.oofCoverageRatioByLambda,
      selectionGridCount: developmentConfig.selectionDiagnostics?.gridCount ?? 0,
      rateEligibleConfigCount: developmentConfig.selectionDiagnostics?.rateEligibleConfigCount ?? 0,
      positiveExpectancyConfigCount: developmentConfig.selectionDiagnostics?.positiveExpectancyConfigCount ?? 0,
      pfPassingConfigCount: developmentConfig.selectionDiagnostics?.pfPassingConfigCount ?? 0,
      fullyEligibleConfigCount: developmentConfig.selectionDiagnostics?.fullyEligibleConfigCount ?? 0,
      bestRateEligibleExpectancyConfig: developmentConfig.selectionDiagnostics?.bestRateEligibleExpectancyConfig ?? null,
      bestRateEligiblePFConfig: developmentConfig.selectionDiagnostics?.bestRateEligiblePFConfig ?? null
    },
    historical: {
      status: validation.result.status,
      predictions: validation.result.counts.predictions,
      accepted: validation.result.counts.accepted,
      result: validation.result.result,
      productConclusion: validation.result.productConclusion,
      failureStage: validation.result.failureStage,
      gateFailures: validation.result.gateFailures
    },
    emailPreparation: Boolean(emailPreparation),
    safety: { paperOnly: true, signalOnly: true, gmail: false, scheduler: false, realEmail: false, automaticTrading: false, accountApi: false, orderApi: false, finalOosRead: false, productionDeploy: false }
  }, null, 2));
}

const mode = process.argv[2];
if (mode === 'lock') lockData();
else if (mode === 'run') runResearch();
  else throw new Error('usage: node scripts/hy-exp-0039.mjs lock | run --code-commit FULL_SHA');
