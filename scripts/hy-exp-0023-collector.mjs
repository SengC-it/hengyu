import fs from 'node:fs';
import path from 'node:path';

import {
  runHyExp0023EngineeringDiagnostic
} from '../src/model/hy-exp-0023-collector.mjs';
import {
  HY_EXP_0023_ID,
  assertHyExp0023CaptureMode,
  buildHyExp0023SafetyMetadata
} from '../src/model/hy-exp-0023-prospective.mjs';
import {
  evaluateHyExp0023Alerts,
  measureHyExp0023ClockReadiness,
  measureHyExp0023Storage,
  probeHyExp0023StorageCapacity
} from '../src/model/hy-exp-0023-operations.mjs';

function flags(args) {
  const result = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const name = arg.slice(2);
    const value = args[index + 1];
    if (value == null || value.startsWith('--')) throw new Error(`missing value for --${name}`);
    result[name] = value;
    index++;
  }
  return result;
}

function diagnosticGate(result) {
  const diagnostics = result.diagnostics ?? {};
  return {
    documentedEndpoints: result.transport?.depth?.status === 'VERIFIED'
      && result.transport?.kline?.status === 'VERIFIED',
    dynamicSymbols: result.symbols.length >= 20,
    validSegments: diagnostics.validSegments >= 1 && diagnostics.invalidSegments === 0,
    snapshotAlignmentFailures: diagnostics.snapshotAlignmentFailures === 0,
    sequenceGaps: diagnostics.sequenceGaps === 0,
    crossedBooks: diagnostics.crossedBooks === 0,
    bufferLimitFailures: diagnostics.bufferLimitFailures === 0,
    receivedAtPresent: diagnostics.missingReceivedAt === 0,
    fundingSchema: diagnostics.fundingRowsValid === true,
    exchangeInfoSchema: diagnostics.exchangeInfoSchemaValid === true,
    noPnl: result.pnlComputed === false,
    noDevelopment: result.noDevelopment === true,
    paperOnly: result.manifest?.authorization === 'PAPER_ONLY'
  };
}

async function main() {
  const options = flags(process.argv.slice(2));
  assertHyExp0023CaptureMode('ENGINEERING_DRY_RUN');
  const projectRoot = options['project-root'] ?? process.cwd();
  const result = await runHyExp0023EngineeringDiagnostic({
    projectRoot,
    maxRuntimeMs: options['duration-ms'] == null ? undefined : Number(options['duration-ms']),
    maxSymbols: options['max-symbols'] == null ? undefined : Number(options['max-symbols']),
    segmentMaxMs: options['segment-max-ms'] == null ? undefined : Number(options['segment-max-ms']),
    confirmationTimeoutMs: options['confirmation-timeout-ms'] == null ? undefined : Number(options['confirmation-timeout-ms'])
  });
  const startedAt = result.manifest.startedAt;
  const finishedAt = result.manifest.finishedAt;
  const storage = measureHyExp0023Storage({
    root: result.directory,
    startedAt,
    finishedAt,
    symbols: result.symbols
  });
  const capacity = probeHyExp0023StorageCapacity(result.directory);
  const clock = await measureHyExp0023ClockReadiness();
  const alerts = evaluateHyExp0023Alerts({ activeAlerts: [] });
  const checks = diagnosticGate(result);
  const segmentSummary = result.segments.map(segment => ({
    segmentId: segment.segmentId,
    status: segment.status,
    reason: segment.reason,
    diagnostics: segment.diagnostics,
    contexts: Object.fromEntries(Object.entries(segment.contexts ?? {}).map(([symbol, context]) => [symbol, {
      status: context.status,
      failureCode: context.failureCode,
      failureDiagnostic: context.failureDiagnostic,
      snapshotAttempts: context.snapshotAttempts,
      snapshotTooOldRetries: context.snapshotTooOldRetries,
      staleBufferedDropped: context.staleBufferedDropped,
      bufferedEventsPeak: context.bufferedEventsPeak,
      pendingDiffs: context.pendingDiffs
    }]))
  }));
  const artifact = {
    schemaVersion: 1,
    artifactType: 'HY_EXP_0023_ENGINEERING_DIAGNOSTIC_ONLY',
    experimentId: HY_EXP_0023_ID,
    runId: result.runId,
    runWindow: {
      startedAt,
      finishedAt,
      durationMs: result.manifest.durationMs
    },
    safety: buildHyExp0023SafetyMetadata({ runId: result.runId, startedAt }),
    status: Object.values(checks).every(Boolean) ? 'DIAGNOSTIC_GATES_PASS_NOT_FORMAL_READINESS' : 'ENGINEERING_DIAGNOSTIC_FAIL',
    formalReadiness: 'NOT_RUN',
    officialCaptureAuthorized: false,
    checks,
    diagnostics: result.diagnostics,
    transport: result.transport,
    barSourceVerification: result.barSourceVerification,
    storage: { metrics: storage, capacity },
    clock,
    alerts,
    manifestErrors: result.manifest.errors,
    segmentSummary,
    manifestSha256: result.manifest.manifestSha256,
    manifestFileSha256: result.manifestWrite.manifestFileSha256,
    rawFileSha256: Object.fromEntries(result.manifest.files.map(file => [file.path, file.sha256])),
    rawDirectory: result.directory,
    pnlComputed: false,
    developmentAllowed: false,
    finalOosRead: false,
    finalOosEligible: false,
    historicalBackfillUsed: false,
    proxyDepthUsed: false
  };
  const artifactDirectory = path.resolve(projectRoot, 'artifacts', HY_EXP_0023_ID);
  fs.mkdirSync(artifactDirectory, { recursive: true });
  const artifactPath = path.join(artifactDirectory, `engineering-diagnostic-${result.runId}.json`);
  fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({
    ...artifact,
    artifactPath,
    collectorCommand: 'npm run hy-exp-0023:engineering-diagnostic -- --duration-ms 300000 --max-symbols 20'
  }, null, 2));
  if (artifact.status === 'ENGINEERING_DIAGNOSTIC_FAIL') process.exitCode = 2;
}

if (process.argv[1] && process.argv[1].endsWith('hy-exp-0023-collector.mjs')) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
