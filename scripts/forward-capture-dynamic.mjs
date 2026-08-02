import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function flag(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}

function runNode(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, script, ...args], {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'inherit']
    });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout }));
  });
}

function parseJsonOutput(stdout) {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/).reverse();
    for (const line of lines) {
      try { return JSON.parse(line); } catch { /* keep searching */ }
    }
    throw new Error('child command did not return JSON');
  }
}

async function main() {
  const seconds = flag('seconds', '60');
  const policy = flag('policy', 'config/universe-policy.json');
  let universeFile = flag('universe-file');
  if (!universeFile) {
    const result = await runNode('scripts/universe-snapshot.mjs', ['--policy', policy]);
    if (result.code !== 0) throw new Error('universe snapshot failed');
    universeFile = parseJsonOutput(result.stdout).output;
  }
  const snapshot = JSON.parse(fs.readFileSync(path.resolve(ROOT, universeFile), 'utf8'));
  if (!snapshot.pointInTime || snapshot.futureDataUsed) throw new Error('universe snapshot is not point-in-time safe');
  if (!snapshot.symbols?.length) throw new Error('dynamic universe has no eligible symbols');
  const captureArgs = [
    '--config', flag('config', 'config/forward-capture-dynamic.json'),
    '--seconds', seconds,
    '--universe-file', universeFile,
    '--capture-id', flag('capture-id', 'HY-FWD-USD-M-DYNAMIC-001'),
    '--output-root', flag('output-root', 'data/raw/forward'),
    '--open-interest-poll-seconds', flag('open-interest-poll-seconds', '60')
  ];
  const result = await runNode('scripts/forward-capture.mjs', captureArgs);
  process.stdout.write(result.stdout);
  if (result.code !== 0) process.exitCode = result.code;
}

try {
  await main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
