import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function option(args, name, fallback = null) {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (value == null || value.startsWith('--')) throw new Error(`missing value for --${name}`);
  return value;
}

function integerOption(args, name, fallback, minimum = 1) {
  const value = option(args, name, fallback == null ? null : String(fallback));
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`invalid --${name}`);
  return parsed;
}

function assertEngineeringRoot(rootDir) {
  const resolved = path.resolve(rootDir);
  const normalized = resolved.replaceAll('\\', '/').toLowerCase();
  if (normalized.includes('/prospective/') || normalized.includes('/development/') || normalized.includes('/final-oos/')) {
    throw new Error('engineering dry-run root must not be a research or OOS root');
  }
  if (!normalized.includes('engineering') || !normalized.includes('hy-data-0036')) {
    throw new Error('engineering dry-run root must include engineering/hy-data-0036');
  }
  return resolved;
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--plan')) {
    const { main: planMain } = await import('../src/data/hy-data-0036-collector.mjs');
    return planMain(args);
  }
  if (!args.includes('--dry-run')) throw new Error('usage: --plan or --dry-run');

  const durationMs = integerOption(args, 'duration-ms', 60 * 60 * 1000);
  const maxSymbols = integerOption(args, 'max-symbols', 8);
  if (maxSymbols !== 8) throw new Error('HY-DATA-0036 engineering dry-run requires all eight frozen symbols');
  const runId = option(args, 'run-id', `engineering-${Date.now()}`);
  if (!/^[A-Za-z0-9_.-]+$/.test(runId)) throw new Error('invalid --run-id');
  const rootDir = assertEngineeringRoot(option(args, 'raw-root', path.join(os.tmpdir(), 'engineering', 'hy-data-0036', runId)));
  const reportPath = option(args, 'report-path', null);
  const controlledReconnectAfterMs = option(args, 'controlled-reconnect-after-ms', null);
  const { createHyData0036Runtime } = await import('../src/data/hy-data-0036-runtime.mjs');
  const runtime = createHyData0036Runtime({
    dryRun: true,
    durationMs,
    maxBufferedEvents: integerOption(args, 'max-buffered-events', 20_000),
    queueLimit: integerOption(args, 'queue-limit', 50_000),
    controlledReconnectAfterMs: controlledReconnectAfterMs == null ? null : integerOption(args, 'controlled-reconnect-after-ms', 1),
    rootDir,
    runId
  });
  const report = await runtime.run();
  if (reportPath) {
    const resolvedReportPath = path.resolve(reportPath);
    await fs.mkdir(path.dirname(resolvedReportPath), { recursive: true });
    await fs.writeFile(resolvedReportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'ENGINEERING_CANARY_PASS') process.exitCode = 2;
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
