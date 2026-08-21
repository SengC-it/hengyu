import { runHyExp0020Capture } from '../src/model/hy-exp-0020-capture-runtime.mjs';

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

async function main() {
  const options = flags(process.argv.slice(2));
  const result = await runHyExp0020Capture({
    requestedMode: options.mode ?? 'ENGINEERING_DRY_RUN',
    maxRuntimeMs: options['duration-ms'] == null ? undefined : Number(options['duration-ms'])
  });
  const diagnostics = result.manifest.diagnostics ?? {};
  console.log(JSON.stringify({
    directory: result.directory,
    mode: result.mode,
    runId: result.runId,
    status: result.manifest.status,
    finalOosEligible: result.manifest.finalOosEligible,
    pnlComputed: result.manifest.pnlComputed,
    developmentAllowed: false,
    symbolsCaptured: diagnostics.symbolsCaptured ?? [],
    validSegments: diagnostics.validSegments ?? 0,
    invalidSegments: diagnostics.invalidSegments ?? 0,
    sequenceGaps: diagnostics.sequenceGaps ?? 0,
    snapshotAlignmentFailures: diagnostics.snapshotAlignmentFailures ?? 0,
    snapshotExclusions: diagnostics.snapshotExclusions ?? 0,
    snapshotRequestFailures: diagnostics.snapshotRequestFailures ?? 0,
    insufficientDepthSymbols: diagnostics.insufficientDepthSymbols ?? 0,
    staleBufferedDropped: diagnostics.staleBufferedDropped ?? 0,
    bufferedEventsDiscarded: diagnostics.bufferedEventsDiscarded ?? 0,
    bufferedEventsPeak: diagnostics.bufferedEventsPeak ?? 0,
    snapshotAttempts: diagnostics.snapshotAttempts ?? 0,
    snapshotTooOldRetries: diagnostics.snapshotTooOldRetries ?? 0,
    alignmentSuccesses: diagnostics.alignmentSuccesses ?? 0,
    alignmentFailures: diagnostics.alignmentFailures ?? 0,
    bufferLimitFailures: diagnostics.bufferLimitFailures ?? 0,
    alignmentLatencyMs: diagnostics.alignmentLatencyMs ?? {},
    exchangeInfoSnapshots: diagnostics.exchangeInfoSnapshots ?? 0,
    universeSnapshots: diagnostics.universeSnapshots ?? 0,
    files: result.manifest.files,
    manifestSha256: result.manifest.manifestSha256,
    errors: result.manifest.errors
  }, null, 2));
}

if (process.argv[1] && process.argv[1].endsWith('hy-exp-0020-capture.mjs')) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
