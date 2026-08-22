import fs from 'node:fs';
import path from 'node:path';

import {
  buildCollectorEngineeringReadiness,
  runHyExp0022EngineeringDryRun
} from '../src/model/hy-exp-0022-collector.mjs';

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
  const result = await runHyExp0022EngineeringDryRun({
    projectRoot: options['project-root'] ?? process.cwd(),
    maxRuntimeMs: options['duration-ms'] == null ? undefined : Number(options['duration-ms']),
    maxSymbols: options['max-symbols'] == null ? undefined : Number(options['max-symbols']),
    segmentMaxMs: options['segment-max-ms'] == null ? undefined : Number(options['segment-max-ms']),
    confirmationTimeoutMs: options['confirmation-timeout-ms'] == null ? undefined : Number(options['confirmation-timeout-ms'])
  });
  const readiness = buildCollectorEngineeringReadiness({ result });
  const artifactDirectory = path.resolve(options['project-root'] ?? process.cwd(), 'artifacts', 'HY-EXP-0022');
  fs.mkdirSync(artifactDirectory, { recursive: true });
  const readinessPath = path.join(artifactDirectory, 'collector-engineering-readiness.json');
  fs.writeFileSync(readinessPath, `${JSON.stringify(readiness, null, 2)}\n`, { flag: 'w' });
  console.log(JSON.stringify({
    ...readiness,
    collectorCommand: 'npm run hy-exp-0022:engineering-dry-run -- --duration-ms 300000 --max-symbols 3',
    directory: result.directory,
    readinessPath,
    manifestPath: result.manifestWrite.manifestPath,
    manifestSha256: result.manifest.manifestSha256,
    manifestFileSha256: result.manifestWrite.manifestFileSha256,
    symbols: result.symbols,
    alignmentFailures: result.diagnostics.snapshotAlignmentFailures,
    sequenceGaps: result.diagnostics.sequenceGaps,
    crossedBooks: result.diagnostics.crossedBooks,
    pnlComputed: false,
    developmentAllowed: false,
    finalOosEligible: false
  }, null, 2));
  if (readiness.status !== 'PASS') process.exitCode = 2;
}

if (process.argv[1] && process.argv[1].endsWith('hy-exp-0022-collector.mjs')) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
