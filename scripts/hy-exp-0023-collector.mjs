import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  runHyExp0023EngineeringDiagnostic
} from '../src/model/hy-exp-0023-collector.mjs';
import {
  HY_EXP_0023_ID,
  assertHyExp0023CaptureMode,
  buildHyExp0023SafetyMetadata
} from '../src/model/hy-exp-0023-prospective.mjs';
import {
  HY_EXP_0023_REQUIRED_ALERTS,
  appendHyExp0023Alert,
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

function lastNdjsonRecord(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  if (!stat.size) return null;
  const length = Math.min(stat.size, 64 * 1024);
  const handle = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(handle, buffer, 0, length, stat.size - length);
    const lines = buffer.toString('utf8').split(/\r?\n/).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index--) {
      try { return JSON.parse(lines[index]); } catch { /* partial tail line */ }
    }
    return null;
  } finally {
    fs.closeSync(handle);
  }
}

function countNewNdjsonRecords(filePath, state) {
  if (!fs.existsSync(filePath)) return 0;
  const stat = fs.statSync(filePath);
  const previousOffset = state.fileOffsets.get(filePath) ?? 0;
  if (stat.size < previousOffset) {
    state.fileOffsets.set(filePath, stat.size);
    throw new Error(`append-only heartbeat source shrank: ${filePath}`);
  }
  if (stat.size === previousOffset) return 0;
  const handle = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(stat.size - previousOffset);
    fs.readSync(handle, buffer, 0, buffer.length, previousOffset);
    state.fileOffsets.set(filePath, stat.size);
    let count = 0;
    for (const byte of buffer) if (byte === 0x0a) count++;
    return count;
  } finally {
    fs.closeSync(handle);
  }
}

function sha256File(filePath) {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function writeCollectorHeartbeat({ heartbeatFile, state }) {
  const runDirectory = state.runDirectory;
  const files = runDirectory == null ? [] : [
    'depth.diff.ndjson',
    'depth.snapshot.ndjson',
    'kline.4h.ndjson',
    'exchangeInfo.ndjson',
    'funding.ndjson',
    'segment.audit.ndjson'
  ].map(name => path.join(runDirectory, name));
  const stats = files.filter(filePath => fs.existsSync(filePath)).map(filePath => fs.statSync(filePath));
  const writtenBytes = stats.reduce((sum, stat) => sum + stat.size, 0);
  state.eventCount += files.reduce((sum, filePath) => sum + countNewNdjsonRecords(filePath, state), 0);
  state.lastWrittenBytes = writtenBytes;
  const depth = runDirectory == null ? null : lastNdjsonRecord(path.join(runDirectory, 'depth.diff.ndjson'));
  const kline = runDirectory == null ? null : lastNdjsonRecord(path.join(runDirectory, 'kline.4h.ndjson'));
  const exchange = runDirectory == null ? null : lastNdjsonRecord(path.join(runDirectory, 'exchangeInfo.ndjson'));
  const segment = runDirectory == null ? null : lastNdjsonRecord(path.join(runDirectory, 'segment.audit.ndjson'));
  const heartbeat = {
    schemaVersion: 1,
    experimentId: HY_EXP_0023_ID,
    captureMode: 'ENGINEERING_DRY_RUN',
    processId: process.pid,
    runId: state.runId,
    segmentId: segment?.segmentId ?? depth?.segmentId ?? (runDirectory == null ? null : path.basename(runDirectory)),
    lastDepthReceivedAt: depth?.receivedAt ?? null,
    lastKlineReceivedAt: kline?.receivedAt ?? null,
    lastExchangeEventAt: exchange?.exchangeObservedAt ?? exchange?.receivedAt ?? null,
    eventCount: state.eventCount,
    writtenBytes,
    heartbeatAt: Date.now(),
    runDirectory,
    developmentAllowed: false,
    pnlComputed: false,
    officialCaptureAuthorized: false
  };
  fs.mkdirSync(path.dirname(path.resolve(heartbeatFile)), { recursive: true });
  fs.writeFileSync(path.resolve(heartbeatFile), `${JSON.stringify(heartbeat)}\n`);
  return heartbeat;
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
    receiptStalls: diagnostics.receiptStalls === 0,
    outOfOrderReceipts: diagnostics.outOfOrderReceipts === 0,
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
  const maxSymbols = options['max-symbols'] === 'all'
    ? null
    : (options['max-symbols'] == null ? undefined : Number(options['max-symbols']));
  const heartbeatFile = options['heartbeat-file'] ?? null;
  const faultInjection = options['fault-inject'] == null
    ? []
    : [...new Set(String(options['fault-inject']).split(',').map(value => value.trim()).filter(Boolean))];
  const unsupportedFaults = faultInjection.filter(type => !HY_EXP_0023_REQUIRED_ALERTS.includes(type));
  if (unsupportedFaults.length) throw new Error(`unsupported engineering fault injection: ${unsupportedFaults.join(',')}`);
  const artifactDirectory = path.resolve(projectRoot, 'artifacts', HY_EXP_0023_ID);
  fs.mkdirSync(artifactDirectory, { recursive: true });
  const alertFile = options['alert-file'] ?? path.join(artifactDirectory, `engineering-alerts-${Date.now()}.ndjson`);
  let alertSinkActive = false;
  try {
    appendHyExp0023Alert(alertFile, { type: 'alert_sink_active', runId: null, processId: process.pid });
    alertSinkActive = true;
  } catch (error) {
    console.error(JSON.stringify({ alertSinkError: error.message }));
  }
  const heartbeatState = {
    runDirectory: null,
    runId: null,
    lastWrittenBytes: 0,
    eventCount: 0,
    fileOffsets: new Map()
  };
  const heartbeatTick = () => {
    if (heartbeatFile) {
      try {
        writeCollectorHeartbeat({ heartbeatFile, state: heartbeatState });
      } catch (error) {
        console.error(JSON.stringify({ heartbeatError: error.message }));
      }
    }
  };
  heartbeatTick();
  const heartbeatTimer = heartbeatFile ? setInterval(heartbeatTick, 1_000) : null;
  heartbeatTimer?.unref?.();
  let result;
  try {
    result = await runHyExp0023EngineeringDiagnostic({
      projectRoot,
      maxRuntimeMs: options['duration-ms'] == null ? undefined : Number(options['duration-ms']),
      maxSymbols,
      segmentMaxMs: options['segment-max-ms'] == null ? undefined : Number(options['segment-max-ms']),
      confirmationTimeoutMs: options['confirmation-timeout-ms'] == null ? undefined : Number(options['confirmation-timeout-ms']),
      onRunCreated: ({ runId, directory }) => {
        heartbeatState.runId = runId;
        heartbeatState.runDirectory = directory;
        heartbeatState.fileOffsets.clear();
        heartbeatState.lastWrittenBytes = 0;
        heartbeatState.eventCount = 0;
        heartbeatTick();
      }
    });
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTick();
  }
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
  const alertCounts = {};
  const emitDiagnosticAlert = (type, details) => {
    alertCounts[type] = (alertCounts[type] ?? 0) + 1;
    if (alertSinkActive) appendHyExp0023Alert(alertFile, { type, runId: result.runId, ...details });
  };
  for (const diagnostic of result.diagnostics.gapDiagnostics ?? []) {
    const alertType = diagnostic.failureCode === 'sequence_gap'
      ? 'sequence_gap'
      : diagnostic.failureCode === 'crossed_book'
        ? 'crossed_book'
        : diagnostic.failureCode === 'SNAPSHOT_ALIGNMENT'
          ? 'snapshot_alignment_failure'
          : diagnostic.failureCode === 'receipt_stall'
            ? 'stale_data'
            : null;
    if (alertType) emitDiagnosticAlert(alertType, diagnostic);
  }
  if (result.diagnostics.missingReceivedAt > 0) {
    emitDiagnosticAlert('missing_receivedAt', { count: result.diagnostics.missingReceivedAt });
  }
  for (const type of faultInjection) emitDiagnosticAlert(type, { faultInjection: true });
  const alerts = evaluateHyExp0023Alerts({
    activeAlerts: alertSinkActive ? [...HY_EXP_0023_REQUIRED_ALERTS] : []
  });
  const checks = diagnosticGate(result);
  const segmentSummary = result.segments.map(segment => ({
    segmentId: segment.segmentId,
    segmentSha256: segment.segmentSha256,
    startedAt: segment.startedAt,
    segmentDeadline: segment.segmentDeadline,
    finishedAt: segment.receivedAt,
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
    artifactType: maxSymbols == null ? 'HY_EXP_0023_ENGINEERING_CAPACITY_PILOT_ONLY' : 'HY_EXP_0023_ENGINEERING_DIAGNOSTIC_ONLY',
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
    capacityPilot: maxSymbols == null,
    alertSink: {
      active: alertSinkActive,
      file: alertFile,
      sha256: alertSinkActive ? sha256File(alertFile) : null,
      counts: alertCounts,
      errorCount: 0,
      faultInjection
    },
    eligibleUniverseCount: result.selection?.eligibleCount ?? 0,
    capturedSymbolCount: result.symbols.length,
    connectionCount: result.segments.length,
    maxSymbolsPerConnection: result.profile.maxSymbolsPerConnection,
    symbolsPerConnection: [...new Set(result.segments.map(segment => segment.symbols.length))].sort((left, right) => left - right),
    transport: result.transport,
    barSourceVerification: result.barSourceVerification,
    storage: {
      metrics: storage,
      capacity,
      localSpoolCapacity: capacity,
      durableStorageCapacity: {
        verified: false,
        availableBytes: null,
        provider: null,
        reason: 'DURABLE_STORAGE_NOT_PROVISIONED_OR_AUTHORIZED'
      },
      retentionPolicy: 'NO_CLEANUP_UNTIL_DURABLE_UPLOAD_AND_REMOTE_CHECKSUM_VERIFIED',
      uploadChecksumWorkflow: [
        'close_and_fsync_raw_ndjson',
        'sha256_raw_files',
        'write_immutable_manifest',
        'durable_upload',
        'verify_remote_checksum'
      ],
      storageReady: false
    },
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
  const artifactPath = path.join(artifactDirectory, `engineering-diagnostic-${result.runId}.json`);
  fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx' });
  const collectorCommand = maxSymbols == null
    ? 'npm run hy-exp-0023:engineering-diagnostic -- --duration-ms 60000 --max-symbols all'
    : 'npm run hy-exp-0023:engineering-diagnostic -- --duration-ms 300000 --max-symbols 20';
  const output = options['summary-only'] === 'true'
    ? {
      artifactPath,
      runId: artifact.runId,
      status: artifact.status,
      eligibleUniverseCount: artifact.eligibleUniverseCount,
      capturedSymbolCount: artifact.capturedSymbolCount,
      connectionCount: artifact.connectionCount,
      symbolsPerConnection: artifact.symbolsPerConnection,
      diagnostics: Object.fromEntries(Object.entries(artifact.diagnostics).filter(([key]) => key !== 'gapDiagnostics' && key !== 'exchangeInfoValidation')),
      alertSink: artifact.alertSink,
      storage: {
        metrics: Object.fromEntries(Object.entries(artifact.storage.metrics).filter(([key]) => !['bySymbol'].includes(key))),
        capacity: artifact.storage.capacity
      },
      clock: artifact.clock,
      manifestSha256: artifact.manifestSha256,
      manifestFileSha256: artifact.manifestFileSha256,
      collectorCommand
    }
    : { ...artifact, artifactPath, collectorCommand };
  console.log(JSON.stringify(output, null, 2));
  if (artifact.status === 'ENGINEERING_DIAGNOSTIC_FAIL') process.exitCode = 2;
}

if (process.argv[1] && process.argv[1].endsWith('hy-exp-0023-collector.mjs')) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
