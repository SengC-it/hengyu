import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HY_EXP_0040,
  WINDOW_START,
  WINDOW_END,
  FIXED_SYMBOLS,
  discoverArchives,
  processAggTradeArchives,
  readDerivedBuckets,
  generateAggTradeCandidates,
  buildSourceManifest,
  loadReferenceSeries,
  sha256File
} from '../src/research/hy-exp-0040-aggtrade.mjs';
import {
  benchmarkOfficialTransports,
  buildAcquisitionProgress,
  createDownloadCoordinator,
  createSpoolController,
  directS3UrlFor,
  loadPartitionState,
  setPartitionState
} from '../src/research/hy-exp-0040-transport.mjs';
import {
  buildCompletionBundle,
  buildDevelopmentReport,
  buildFrozenModelSpec,
  buildHistoricalValidationReport,
  resolveReferenceOutcome,
  runDevelopmentWalkForward,
  runHistoricalValidation,
  selectDevelopmentConfig
} from '../src/research/hy-exp-0040-engine.mjs';
import { appendRegistryEvent, verifyRegistry } from './registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACT_DIR = path.join(ROOT, 'artifacts', HY_EXP_0040);
const PREREG_PATH = path.join(ROOT, 'registry', 'experiments', HY_EXP_0040, 'preregistration.json');
const SOURCE_MANIFEST_PATH = path.join(ARTIFACT_DIR, 'source-manifest.json');
const DERIVED_MANIFEST_PATH = path.join(ARTIFACT_DIR, 'derived-feature-manifest.json');
const COVERAGE_PATH = path.join(ARTIFACT_DIR, 'aggtrade-coverage.json');
const CACHE_ROOT = path.resolve(ROOT, '..', 'data', 'cache', HY_EXP_0040);
const DOWNLOAD_ROOT = path.join(CACHE_ROOT, 'download');
const TRANSPORT_EVIDENCE_PATH = path.join(ARTIFACT_DIR, 'data-transport-evidence.json');
const PROGRESS_PATH = path.join(ARTIFACT_DIR, 'data-acquisition-progress.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function argument(name, fallback = null) {
  const index = process.argv.indexOf('--' + name);
  return index < 0 ? fallback : process.argv[index + 1] ?? fallback;
}

function iso(value) {
  return new Date(value).toISOString();
}

function relativeToRoot(file) {
  return path.relative(ROOT, file).replaceAll('\\', '/');
}

function safety() {
  return {
    paperOnly: true,
    signalOnly: true,
    gmail: false,
    scheduler: false,
    realEmail: false,
    automaticTrading: false,
    accountApi: false,
    orderApi: false,
    privateApi: false,
    finalOosRead: false,
    productionDeploy: false
  };
}

async function lockData() {
  const preregistrationSha256 = sha256File(PREREG_PATH);
  const files = await discoverArchives();
  const sourceManifest = buildSourceManifest({ files, preregistrationSha256 });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeJson(SOURCE_MANIFEST_PATH, sourceManifest);
  fs.mkdirSync(CACHE_ROOT, { recursive: true });
  fs.mkdirSync(DOWNLOAD_ROOT, { recursive: true });
  const requestedConcurrency = Math.min(12, Math.max(1, Number(argument('http-concurrency', 8)) || 8));
  const maxSpoolBytes = Math.max(1, Number(argument('spool-bytes', 8 * 1024 ** 3)) || 8 * 1024 ** 3);
  const benchmark = await benchmarkOfficialTransports(files, {
    sampleBytes: Math.max(8_000_000, Number(argument('benchmark-bytes', 8_000_000)) || 8_000_000)
  });
  writeJson(TRANSPORT_EVIDENCE_PATH, {
    schemaVersion: 1,
    artifactType: 'HY_EXP_0040_DATA_TRANSPORT_EVIDENCE',
    immutable: true,
    experimentId: HY_EXP_0040,
    canonicalSource: 'https://data.binance.vision/data/futures/um/<same-object-key>',
    transportOptions: ['canonical', 'direct-s3'],
    benchmark,
    selectedTransport: benchmark.selectedEndpoint,
    selectedConcurrency: benchmark.selectedConcurrency,
    outcomeRead: false,
    pnlComputed: false,
    finalOosRead: false,
    safety: safety()
  });
  const coordinator = createDownloadCoordinator({ maxConcurrency: benchmark.selectedConcurrency ?? requestedConcurrency, maxAllowedConcurrency: 12 });
  const spoolController = createSpoolController(maxSpoolBytes);
  for (const file of files) {
    if (!loadPartitionState(file, DOWNLOAD_ROOT)) await setPartitionState(file, DOWNLOAD_ROOT, 'DISCOVERED');
  }
  const refreshArtifacts = () => {
    for (const manifestFile of sourceManifest.files) {
      const state = loadPartitionState(manifestFile, DOWNLOAD_ROOT);
      manifestFile.checksumVerified = state?.checksumVerified === true;
      manifestFile.rawRetained = state?.rawDeleted !== true;
      manifestFile.partitionState = state?.state ?? 'DISCOVERED';
    }
    writeJson(SOURCE_MANIFEST_PATH, sourceManifest);
    writeJson(PROGRESS_PATH, buildAcquisitionProgress(files, {
      root: DOWNLOAD_ROOT,
      benchmark,
      now: Date.now()
    }));
  };
  refreshArtifacts();
  if (!benchmark.selectedEndpoint) {
    const blocker = {
      schemaVersion: 1,
      artifactType: 'HY_EXP_0040_DATA_ACQUISITION_BLOCKER',
      immutable: true,
      experimentId: HY_EXP_0040,
      preregistrationSha256,
      sourceManifestSha256: sha256File(SOURCE_MANIFEST_PATH),
      status: 'BLOCKED_SOURCE_TRANSFER',
      reason: 'HOST_NETWORK_TRANSPORT_BLOCKER',
      transportEvidenceSha256: sha256File(TRANSPORT_EVIDENCE_PATH),
      benchmark,
      dataLocked: false,
      outcomeRead: false,
      pnlComputed: false,
      finalOosRead: false,
      noSyntheticData: true,
      noInterpolation: true,
      noForwardFill: true,
      noPrivateApi: true,
      windowsResumeReady: true,
      resumeCommand: 'npm run research:hy-exp-0040:lock',
      safety: safety()
    };
    writeJson(path.join(ARTIFACT_DIR, 'data-acquisition-blocker.json'), blocker);
    console.log(JSON.stringify({ mode: 'DATA_LOCK_BLOCKED', experimentId: HY_EXP_0040, blocker: 'HOST_NETWORK_TRANSPORT_BLOCKER', progress: readJson(PROGRESS_PATH), safety: safety() }, null, 2));
    return;
  }
  const selectedTransport = benchmark.selectedEndpoint;
  for (const file of sourceManifest.files) {
    file.transportUrl = selectedTransport === 'direct-s3' ? directS3UrlFor(file.url) : file.url;
  }
  writeJson(SOURCE_MANIFEST_PATH, sourceManifest);
  const coverage = [];
  const derivedFiles = [];
  for (const symbol of FIXED_SYMBOLS) {
    const outputPath = path.join(CACHE_ROOT, symbol + '-1m.ndjson.gz');
    console.log('processing ' + symbol + ' archives=' + files.filter(file => file.symbol === symbol).length);
    const symbolFiles = files.filter(file => file.symbol === symbol).map(file => ({
      ...file,
      transportUrl: selectedTransport === 'direct-s3' ? directS3UrlFor(file.url) : file.url
    }));
    let result;
    try {
      result = await processAggTradeArchives({
        symbol,
        archives: symbolFiles,
        outputPath,
        start: WINDOW_START,
        end: WINDOW_END,
        checkpointRoot: DOWNLOAD_ROOT,
        downloadOptions: {
          root: DOWNLOAD_ROOT,
          concurrency: benchmark.selectedConcurrency ?? requestedConcurrency,
          coordinator,
          spoolController
        },
        onPartitionState: async () => refreshArtifacts()
      });
    } catch (error) {
      refreshArtifacts();
      const blocker = {
        schemaVersion: 1,
        artifactType: 'HY_EXP_0040_DATA_ACQUISITION_BLOCKER',
        immutable: true,
        experimentId: HY_EXP_0040,
        preregistrationSha256,
        sourceManifestSha256: sha256File(SOURCE_MANIFEST_PATH),
        status: 'BLOCKED_SOURCE_TRANSFER',
        reason: error.message === 'DATA_FAIL_SOURCE_INTEGRITY' ? 'DATA_FAIL_SOURCE_INTEGRITY' : 'HOST_NETWORK_TRANSPORT_BLOCKER',
        errorCode: error.code ?? error.message,
        transportEvidenceSha256: sha256File(TRANSPORT_EVIDENCE_PATH),
        dataLocked: false,
        outcomeRead: false,
        pnlComputed: false,
        finalOosRead: false,
        noSyntheticData: true,
        noInterpolation: true,
        noForwardFill: true,
        noPrivateApi: true,
        windowsResumeReady: true,
        resumeCommand: 'npm run research:hy-exp-0040:lock',
        safety: safety()
      };
      writeJson(path.join(ARTIFACT_DIR, 'data-acquisition-blocker.json'), blocker);
      console.log(JSON.stringify({ mode: 'DATA_LOCK_BLOCKED', experimentId: HY_EXP_0040, blocker: blocker.reason, progress: readJson(PROGRESS_PATH), safety: safety() }, null, 2));
      return;
    }
    coverage.push({
      symbol,
      sourcePartitions: files.filter(file => file.symbol === symbol).map(file => ({
        cadence: file.cadence,
        period: file.period,
        url: file.url,
        sha256: file.sha256,
        checksumUrl: file.checksumUrl
      })),
      archiveRows: result.archiveRows,
      archiveRowsInWindow: result.archiveRowsInWindow,
      expectedMinuteBuckets: result.expectedMinuteBuckets,
      actualMinuteBuckets: result.bucketCount,
      validMinuteBuckets: result.validBucketCount,
      missingMinuteBuckets: result.missingBucketCount,
      continuityPass: result.bucketCount === result.expectedMinuteBuckets,
      missingIntervals: result.missingBucketCount,
      noForwardFill: true
    });
    derivedFiles.push({
      symbol,
      kind: 'aggtrade.derived.1m',
      path: relativeToRoot(outputPath),
      sha256: result.sha256,
      bytes: fs.statSync(outputPath).size,
      rows: result.bucketCount,
      compressed: true,
      rawArchiveRetained: false
    });
    refreshArtifacts();
  }
  const allCoveragePass = coverage.every(row => row.continuityPass && row.missingIntervals === 0);
  refreshArtifacts();
  const sourceChecksumPass = sourceManifest.files.every(file => file.checksumVerified === true);
  const derivedManifest = {
    schemaVersion: 1,
    artifactType: 'HY_EXP_0040_DERIVED_FEATURE_MANIFEST',
    immutable: true,
    experimentId: HY_EXP_0040,
    preregistrationSha256,
    sourceManifestSha256: sha256File(SOURCE_MANIFEST_PATH),
    generatedAt: new Date().toISOString(),
    window: { start: iso(WINDOW_START), endExclusive: iso(WINDOW_END), baseInterval: 'completed UTC 1 minute' },
    files: derivedFiles,
    retainedRepresentation: 'compact gzip NDJSON 1m aggregates; no permanent raw ZIP or decompressed CSV',
    fields: ['buyNotional', 'sellNotional', 'buyQty', 'sellQty', 'buyTradeCount', 'sellTradeCount', 'totalNotional', 'totalTrades', 'signedNotional', 'CVD', 'largeBuyNotional', 'largeSellNotional', 'largeTradeImbalance'],
    causal: true,
    noSyntheticData: true,
    noInterpolation: true,
    noForwardFill: true,
    outcomeRead: false,
    pnlComputed: false,
    finalOosRead: false,
    safety: safety()
  };
  const coverageArtifact = {
    schemaVersion: 1,
    artifactType: 'HY_EXP_0040_AGGTRADE_COVERAGE',
    immutable: true,
    experimentId: HY_EXP_0040,
    preregistrationSha256,
    sourceManifestSha256: sha256File(SOURCE_MANIFEST_PATH),
    derivedFeatureManifestSha256: null,
    window: { start: iso(WINDOW_START), endExclusive: iso(WINDOW_END), calendarDays: 730 },
    symbols: FIXED_SYMBOLS,
    requiredNativeFields: ['p', 'q', 'T', 'm'],
    expectedDecisionCadenceMs: 900000,
    expectedMinuteCadenceMs: 60000,
    symbolCoverage: coverage,
    continuityPass: allCoveragePass,
    missingIntervals: coverage.reduce((sum, row) => sum + row.missingIntervals, 0),
    sourceChecksumPass,
    nativeOrderingChecked: true,
    duplicateAggregateIds: 0,
    outOfOrderRows: 0,
    rawArchiveRetained: false,
    outcomeRead: false,
    pnlComputed: false,
    finalOosRead: false,
    safety: safety()
  };
  writeJson(DERIVED_MANIFEST_PATH, derivedManifest);
  coverageArtifact.derivedFeatureManifestSha256 = sha256File(DERIVED_MANIFEST_PATH);
  writeJson(COVERAGE_PATH, coverageArtifact);
  if (!allCoveragePass || !sourceChecksumPass || coverage.length !== FIXED_SYMBOLS.length) {
    throw new Error('AGGTRADE_COVERAGE_OR_SOURCE_CHECKSUM_FAILED');
  }
  const event = appendRegistryEvent({
    experimentId: HY_EXP_0040,
    eventType: 'data_locked',
    payloadPath: relativeToRoot(SOURCE_MANIFEST_PATH),
    note: 'Official Binance USD-M aggTrades checksummed and compact causal 1m derivatives written; no outcomes read.'
  });
  console.log(JSON.stringify({
    mode: 'DATA_LOCK',
    experimentId: HY_EXP_0040,
    sourceManifestSha256: sha256File(SOURCE_MANIFEST_PATH),
    derivedFeatureManifestSha256: sha256File(DERIVED_MANIFEST_PATH),
    coverageSha256: sha256File(COVERAGE_PATH),
    dataLockedEvent: event,
    continuityPass: allCoveragePass,
    safety: safety()
  }, null, 2));
}

function artifactEntry(relative) {
  const file = path.join(ROOT, relative);
  return { path: relative.replaceAll('\\', '/'), sha256: sha256File(file) };
}

function writeHistoricalMarkdown(report, development, codeCommit, dataManifestSha256) {
  const lines = [
    '# HY-EXP-0040 Historical Validation',
    '',
    '- This is registered historical validation, not Final OOS.',
    '- No Final OOS was read; no live or private API was used.',
    '- Signal-only / paper-only; no email was sent.',
    '',
    '- Code commit: ' + codeCommit,
    '- Data manifest SHA-256: ' + dataManifestSha256,
    '- Development: ' + iso(DEVELOPMENT_START) + ' to ' + iso(DEVELOPMENT_END) + ' (exclusive)',
    '- Historical validation: ' + iso(VALIDATION_START) + ' to ' + iso(VALIDATION_END) + ' (exclusive)',
    '',
    '## Result: ' + report.result,
    '',
    'Development config: **' + development.status + '**',
    'Historical predictions: **' + report.counts.predictions + '**',
    'Accepted signals: **' + report.counts.accepted + '**',
    '',
    '| Gate | Result |',
    '|---|---|'
  ];
  for (const [name, value] of Object.entries(report.gates)) lines.push('| ' + name + ' | ' + (value ? 'PASS' : 'FAIL') + ' |');
  lines.push('', 'Gate failures: ' + (report.gateFailures.join(', ') || 'none'), '');
  fs.writeFileSync(path.join(ARTIFACT_DIR, 'historical-validation.md'), lines.join('\n') + '\n');
}

async function runResearch() {
  const codeCommit = argument('code-commit');
  if (!/^[a-f0-9]{40}$/.test(codeCommit ?? '')) throw new Error('CODE_COMMIT_REQUIRED_AS_FULL_SHA');
  const registry = verifyRegistry({ root: ROOT });
  const entries = fs.readFileSync(path.join(ROOT, 'registry', 'ledger.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const dataLocked = entries.find(entry => entry.experiment_id === HY_EXP_0040 && entry.event_type === 'data_locked');
  if (!dataLocked) throw new Error('HY_EXP_0040_DATA_NOT_LOCKED');
  const preregistrationSha256 = sha256File(PREREG_PATH);
  const sourceManifest = readJson(SOURCE_MANIFEST_PATH);
  const derivedManifest = readJson(DERIVED_MANIFEST_PATH);
  if (sourceManifest.outcomeRead || sourceManifest.pnlComputed || sourceManifest.finalOosRead) throw new Error('SOURCE_MANIFEST_OUTCOME_BOUNDARY_FAILED');
  if (derivedManifest.outcomeRead || derivedManifest.pnlComputed || derivedManifest.finalOosRead) throw new Error('DERIVED_MANIFEST_OUTCOME_BOUNDARY_FAILED');
  const series = loadReferenceSeries({ root: ROOT });
  const allCandidates = [];
  const allOutcomes = [];
  const coverage = [];
  for (const symbol of FIXED_SYMBOLS) {
    const manifestFile = derivedManifest.files.find(row => row.symbol === symbol);
    const file = path.resolve(ROOT, manifestFile.path);
    const buckets = await readDerivedBuckets(file);
    const generated = generateAggTradeCandidates({ symbol, buckets, series, start: WINDOW_START, end: WINDOW_END });
    const simulated = [];
    for (const candidate of generated.candidates) simulated.push(resolveReferenceOutcome(candidate, series));
    allCandidates.push(...generated.candidates);
    allOutcomes.push(...simulated);
    coverage.push(generated.coverage);
    console.log('generated ' + symbol + ' candidates=' + generated.candidates.length + ' invalidFeatures=' + generated.coverage.featureInvalid);
  }
  const expected = coverage.reduce((sum, row) => sum + row.expectedRawCandidates, 0);
  const actual = coverage.reduce((sum, row) => sum + row.actualRawCandidates, 0);
  const candidateCoverage = {
    symbols: FIXED_SYMBOLS,
    expectedDecisionCadenceMs: FIFTEEN_MINUTES,
    perSymbol: coverage,
    expectedRawCandidates: expected,
    actualRawCandidates: actual,
    coverageRatio: actual / Math.max(1, expected),
    BUY: allCandidates.filter(row => row.side === 'BUY').length,
    SELL: allCandidates.filter(row => row.side === 'SELL').length,
    unexpectedGap: coverage.some(row => row.unexpectedGap),
    noRegimeGate: true
  };
  if (candidateCoverage.coverageRatio !== 1 || candidateCoverage.unexpectedGap || candidateCoverage.BUY !== candidateCoverage.SELL) {
    throw new Error('CANDIDATE_COVERAGE_FAILED:' + JSON.stringify(candidateCoverage));
  }
  const resolved = allOutcomes.filter(row => row.outcomeStatus === 'RESOLVED');
  const walkForward = runDevelopmentWalkForward(resolved);
  const developmentConfig = selectDevelopmentConfig(walkForward.predictionsByLambda, { series });
  const developmentReport = buildDevelopmentReport({
    candidates: allCandidates,
    outcomes: allOutcomes,
    walkForward,
    developmentConfig,
    coverage: candidateCoverage
  });
  const historical = runHistoricalValidation(resolved, developmentConfig);
  const historicalReport = buildHistoricalValidationReport({
    history: historical,
    series,
    developmentConfig,
    preregistrationSha256,
    dataManifestSha256: sha256File(SOURCE_MANIFEST_PATH)
  });
  const frozenModelSpec = buildFrozenModelSpec({
    developmentConfig,
    preregistrationSha256,
    dataManifestSha256: sha256File(SOURCE_MANIFEST_PATH)
  });
  writeJson(path.join(ARTIFACT_DIR, 'development-oof-summary.json'), {
    schemaVersion: 1,
    artifactType: 'HY_EXP_0040_DEVELOPMENT_OOF_SUMMARY',
    immutable: true,
    experimentId: HY_EXP_0040,
    count: walkForward.predictions.length,
    countsByLambda: walkForward.oofCountsByLambda,
    expectedOofCountPerLambda: walkForward.expectedOofCountPerLambda,
    oofCoverageRatioByLambda: walkForward.oofCoverageRatioByLambda,
    oofCandidateIdsEqual: walkForward.oofCandidateIdsEqual,
    folds: walkForward.folds,
    sample: walkForward.predictions.slice(0, 25),
    fullOofPersisted: false,
    outcomeRead: true,
    finalOosRead: false,
    safety: safety()
  });
  writeJson(path.join(ARTIFACT_DIR, 'development-selection-grid.json'), {
    schemaVersion: 1,
    artifactType: 'HY_EXP_0040_DEVELOPMENT_SELECTION_GRID',
    immutable: true,
    experimentId: HY_EXP_0040,
    preregistrationSha256,
    dataManifestSha256: sha256File(SOURCE_MANIFEST_PATH),
    status: developmentConfig.status,
    reason: developmentConfig.reason ?? null,
    grid: developmentConfig.selectionGrid ?? [],
    diagnostics: developmentConfig.selectionDiagnostics ?? null,
    outcomeRead: true,
    finalOosRead: false,
    safety: safety()
  });
  writeJson(path.join(ARTIFACT_DIR, 'development-report.json'), developmentReport);
  writeJson(path.join(ARTIFACT_DIR, 'frozen-model-spec.json'), frozenModelSpec);
  writeJson(path.join(ARTIFACT_DIR, 'historical-validation.json'), historicalReport);
  writeHistoricalMarkdown(historicalReport, developmentConfig, codeCommit, sha256File(SOURCE_MANIFEST_PATH));
  let emailPreparation = null;
  if (historicalReport.emailPreparationEligible) {
    emailPreparation = {
      schemaVersion: 1,
      artifactType: 'HY_EXP_0040_PAPER_EMAIL_PREPARATION',
      immutable: true,
      experimentId: HY_EXP_0040,
      futureValidationExperimentId: 'HY-FWD-0040-001',
      prepared: true,
      activated: false,
      gmailSendEnabled: false,
      schedulerActivated: false,
      realEmailSent: false,
      paperOnly: true,
      signalOnly: true,
      noQuantity: true,
      noLeverage: true,
      noOrder: true,
      fields: ['symbol', 'BUY/SELL', 'signalTime', 'signalGrade', 'predictedEdge', 'referencePrice', 'referenceStop', 'referenceTarget', 'validUntil', 'maxChase'],
      safety: safety()
    };
    writeJson(path.join(ARTIFACT_DIR, 'email-preparation.json'), emailPreparation);
    writeJson(path.join(ROOT, 'registry', 'forward', 'HY-FWD-0040-001.json'), emailPreparation);
  }
  const required = [
    'registry/experiments/HY-EXP-0040/preregistration.json',
    'artifacts/HY-EXP-0040/source-manifest.json',
    'artifacts/HY-EXP-0040/data-transport-evidence.json',
    'artifacts/HY-EXP-0040/data-acquisition-progress.json',
    'artifacts/HY-EXP-0040/aggtrade-coverage.json',
    'artifacts/HY-EXP-0040/derived-feature-manifest.json',
    'artifacts/HY-EXP-0040/development-oof-summary.json',
    'artifacts/HY-EXP-0040/development-selection-grid.json',
    'artifacts/HY-EXP-0040/development-report.json',
    'artifacts/HY-EXP-0040/frozen-model-spec.json',
    'artifacts/HY-EXP-0040/historical-validation.json',
    'artifacts/HY-EXP-0040/historical-validation.md'
  ];
  if (emailPreparation) required.push('artifacts/HY-EXP-0040/email-preparation.json', 'registry/forward/HY-FWD-0040-001.json');
  const finalResult = historicalReport.result;
  const completionPath = path.join(ARTIFACT_DIR, 'completion-bundle.json');
  writeJson(completionPath, buildCompletionBundle({
    codeCommit,
    preregistrationSha256,
    dataManifestSha256: sha256File(SOURCE_MANIFEST_PATH),
    artifactEntries: required.map(artifactEntry),
    finalResult,
    emailPreparation
  }));
  const eventType = historicalReport.result === 'HISTORICAL_VALIDATION_PASS' ? 'completed' : 'failed';
  const event = appendRegistryEvent({
    experimentId: HY_EXP_0040,
    eventType,
    payloadPath: 'artifacts/HY-EXP-0040/completion-bundle.json',
    note: eventType === 'completed'
      ? 'Historical validation passed; paper-only forward validation prepared but not activated.'
      : 'No profitable aggTrade email strategy found under preregistered gates; no Final OOS read.'
  });
  console.log(JSON.stringify({
    mode: 'RESEARCH',
    registryRecords: registry.records + 2,
    experimentId: HY_EXP_0040,
    codeCommit,
    preregistrationSha256,
    sourceManifestSha256: sha256File(SOURCE_MANIFEST_PATH),
    candidates: { total: allCandidates.length, BUY: candidateCoverage.BUY, SELL: candidateCoverage.SELL },
    outcomes: { total: allOutcomes.length, resolved: resolved.length, invalid: allOutcomes.length - resolved.length },
    development: { status: developmentConfig.status, oof: walkForward.oofCountsByLambda, selected: developmentConfig.acceptedDevelopmentRows?.length ?? 0 },
    historical: { status: historicalReport.status, result: historicalReport.result, accepted: historicalReport.counts.accepted, failures: historicalReport.gateFailures },
    terminalEvent: event,
    emailPreparation: Boolean(emailPreparation),
    safety: safety()
  }, null, 2));
}

const mode = process.argv[2];
try {
  if (mode === 'lock') await lockData();
  else if (mode === 'run') await runResearch();
  else throw new Error('usage: node scripts/hy-exp-0040.mjs lock | run --code-commit FULL_SHA');
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
