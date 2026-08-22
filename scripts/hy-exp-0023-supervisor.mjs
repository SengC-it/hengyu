import path from 'node:path';
import process from 'node:process';

import { createHyExp0023Supervisor } from '../src/model/hy-exp-0023-operations.mjs';
import { assertHyExp0023CaptureMode } from '../src/model/hy-exp-0023-prospective.mjs';

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
  assertHyExp0023CaptureMode('ENGINEERING_DRY_RUN');
  const collector = path.resolve(process.cwd(), 'scripts', 'hy-exp-0023-collector.mjs');
  const childArgs = [collector];
  for (const [name, value] of Object.entries(options)) childArgs.push(`--${name}`, value);
  const heartbeatFile = path.resolve(
    options['heartbeat-file'] ?? path.join('artifacts', 'HY-EXP-0023', 'supervisor-heartbeat.json')
  );
  const alertFile = path.resolve(
    options['alert-file'] ?? path.join('artifacts', 'HY-EXP-0023', 'supervisor-alerts.ndjson')
  );
  const supervisor = createHyExp0023Supervisor({
    command: process.execPath,
    args: childArgs,
    cwd: process.cwd(),
    heartbeatFile,
    alertFile,
    onAlert: event => console.error(JSON.stringify({ supervisorAlert: event }))
  });
  supervisor.start({ officialCaptureAuthorized: false });
  const heartbeatTimer = setInterval(() => {
    supervisor.heartbeat();
    if (!supervisor.checkHealth().healthy) console.error(JSON.stringify({ supervisorHealth: supervisor.diagnostics() }));
  }, 5_000);
  const stop = () => {
    clearInterval(heartbeatTimer);
    supervisor.stop();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
