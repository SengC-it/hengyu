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
  const symbols = String(options.symbols ?? '').split(',').map(value => value.trim()).filter(Boolean);
  if (!symbols.length) throw new Error('usage: hy-exp-0020-capture.mjs --symbols BTCUSDT,ETHUSDT [--mode ENGINEERING_DRY_RUN]');
  const result = await runHyExp0020Capture({
    requestedMode: options.mode ?? 'ENGINEERING_DRY_RUN',
    symbols,
    maxRuntimeMs: options['duration-ms'] == null ? undefined : Number(options['duration-ms'])
  });
  console.log(JSON.stringify({
    directory: result.directory,
    mode: result.mode,
    runId: result.runId,
    status: result.manifest.status,
    finalOosEligible: result.manifest.finalOosEligible,
    pnlComputed: result.manifest.pnlComputed,
    files: result.manifest.files,
    errors: result.manifest.errors
  }, null, 2));
}

if (process.argv[1] && process.argv[1].endsWith('hy-exp-0020-capture.mjs')) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
