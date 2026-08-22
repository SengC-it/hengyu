import fs from 'node:fs';
import path from 'node:path';

import {
  HY_EXP_0022_FIRST_PROSPECTIVE_BAR,
  buildHyExp0022FirstProspectiveBarSmoke,
  runHyExp0022EngineeringDryRun
} from '../src/model/hy-exp-0022-collector.mjs';

function flags(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const name = arg.slice(2);
    const value = args[index + 1];
    if (value == null || value.startsWith('--')) throw new Error(`missing value for --${name}`);
    result[name] = value;
    index += 1;
  }
  return result;
}

async function main() {
  const options = flags(process.argv.slice(2));
  const now = Date.now();
  const defaultDuration = Math.max(5 * 60 * 1_000, HY_EXP_0022_FIRST_PROSPECTIVE_BAR.closeTime + 60_000 - now);
  const result = await runHyExp0022EngineeringDryRun({
    maxRuntimeMs: Number(options['duration-ms'] ?? defaultDuration),
    maxSymbols: Number(options['max-symbols'] ?? 3),
    segmentMaxMs: options['segment-max-ms'] == null ? undefined : Number(options['segment-max-ms']),
    confirmationTimeoutMs: options['confirmation-timeout-ms'] == null ? undefined : Number(options['confirmation-timeout-ms']),
    targetBar: HY_EXP_0022_FIRST_PROSPECTIVE_BAR,
    projectRoot: options['project-root'] ?? process.cwd()
  });
  const smoke = buildHyExp0022FirstProspectiveBarSmoke({ result });
  const artifactDirectory = path.resolve(options['project-root'] ?? process.cwd(), 'artifacts', 'HY-EXP-0022');
  fs.mkdirSync(artifactDirectory, { recursive: true });
  const artifactPath = path.join(artifactDirectory, 'first-prospective-bar-smoke.json');
  fs.writeFileSync(artifactPath, `${JSON.stringify(smoke, null, 2)}\n`, { flag: 'w' });
  console.log(JSON.stringify({
    ...smoke,
    artifactPath,
    manifestPath: result.manifestWrite.manifestPath,
    collectorDirectory: result.directory,
    collectorCommand: 'npm run hy-exp-0022:first-bar-smoke'
  }, null, 2));
  if (smoke.status !== 'PASS') process.exitCode = 2;
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
