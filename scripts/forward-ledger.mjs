import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendRegistryEvent } from './registry.mjs';
import { validateCaptureDirectory } from '../src/model/forward-data.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXPERIMENT_ID = 'HY-EXP-0013';
const FORWARD_BOUNDARY = Date.parse('2026-07-30T16:00:00.000Z');

function flag(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}

function absoluteFromRoot(value) {
  return path.isAbsolute(value) ? value : path.resolve(ROOT, value);
}

function isoTime(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function manifestFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .sort();
}

function inspectDirectory(directory) {
  const relativePath = path.relative(ROOT, directory).replaceAll('\\', '/');
  const manifestPath = path.join(directory, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return {
      path: relativePath,
      status: 'unmanifested',
      files: manifestFiles(directory),
      errors: ['missing_manifest']
    };
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return { path: relativePath, status: 'invalid_manifest', errors: [error.message] };
  }
  const quality = validateCaptureDirectory(directory);
  const startedAt = isoTime(manifest.started_at);
  const finishedAt = isoTime(manifest.finished_at);
  const errors = [...(manifest.errors ?? []), ...(quality.errors ?? [])];
  if (startedAt == null || finishedAt == null) errors.push('invalid_manifest_times');
  if (startedAt != null && startedAt <= FORWARD_BOUNDARY) errors.push('before_forward_boundary');
  return {
    path: relativePath,
    runId: manifest.run_id ?? null,
    status: manifest.status ?? 'unknown',
    qualityStatus: quality.status,
    symbols: manifest.symbols ?? [],
    startedAt: startedAt == null ? null : new Date(startedAt).toISOString(),
    finishedAt: finishedAt == null ? null : new Date(finishedAt).toISOString(),
    durationSeconds: manifest.duration_seconds ?? null,
    wallDurationMs: startedAt != null && finishedAt != null ? Math.max(0, finishedAt - startedAt) : null,
    records: quality.data?.acceptedRecords ?? 0,
    rejectedRecords: quality.data?.rejectedRecords ?? 0,
    depthUpdates: quality.data?.byType?.depthUpdate ?? 0,
    forceOrders: quality.data?.byType?.forceOrder ?? 0,
    errors: [...new Set(errors)],
    files: manifest.files ?? []
  };
}

function intervals(segments) {
  const ordered = segments
    .filter(segment => segment.startedAt && segment.finishedAt)
    .map(segment => ({
      runId: segment.runId,
      start: Date.parse(segment.startedAt),
      end: Date.parse(segment.finishedAt)
    }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const gaps = [];
  const overlaps = [];
  let previous = null;
  for (const current of ordered) {
    if (previous) {
      if (current.start > previous.end) {
        gaps.push({
          from: new Date(previous.end).toISOString(),
          to: new Date(current.start).toISOString(),
          milliseconds: current.start - previous.end
        });
      } else if (current.start < previous.end) {
        overlaps.push({
          from: new Date(current.start).toISOString(),
          to: new Date(Math.min(previous.end, current.end)).toISOString(),
          milliseconds: Math.min(previous.end, current.end) - current.start
        });
      }
      if (current.end > previous.end) previous = current;
    } else {
      previous = current;
    }
  }
  const start = ordered[0]?.start ?? null;
  const end = ordered.length ? Math.max(...ordered.map(row => row.end)) : null;
  const observed = ordered.reduce((total, row) => total + Math.max(0, row.end - row.start), 0);
  return {
    segmentCount: ordered.length,
    start: start == null ? null : new Date(start).toISOString(),
    end: end == null ? null : new Date(end).toISOString(),
    wallSpanDays: start == null || end == null ? 0 : (end - start) / 86_400_000,
    observedSegmentDays: observed / 86_400_000,
    gaps,
    overlaps,
    continuous: ordered.length > 0 && gaps.length === 0 && overlaps.length === 0
  };
}

export function buildForwardLedger({ root = ROOT, captureRoot = path.join(root, 'data', 'raw', 'forward') } = {}) {
  if (!fs.existsSync(captureRoot)) throw new Error(`capture root is unavailable: ${captureRoot}`);
  const directories = fs.readdirSync(captureRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(captureRoot, entry.name))
    .sort();
  const inspected = directories.map(inspectDirectory);
  const validSegments = inspected.filter(segment => (
    segment.status === 'complete'
    && segment.qualityStatus === 'valid'
    && segment.errors.length === 0
  ));
  const frozenSymbols = [...new Set(validSegments.flatMap(segment => segment.symbols))].sort();
  const mismatchedSymbols = validSegments
    .filter(segment => JSON.stringify([...segment.symbols].sort()) !== JSON.stringify(frozenSymbols))
    .map(segment => segment.runId);
  const coverage = intervals(validSegments);
  const warmupComplete = coverage.continuous && coverage.wallSpanDays >= 30;
  return {
    experiment_id: EXPERIMENT_ID,
    generated_at_utc: new Date().toISOString(),
    forward_boundary_exclusive_utc: new Date(FORWARD_BOUNDARY).toISOString(),
    frozen_symbols: frozenSymbols,
    status: warmupComplete ? 'warmup_complete' : 'warmup_incomplete',
    usable_for_h9_pnl: warmupComplete && mismatchedSymbols.length === 0,
    coverage: {
      ...coverage,
      mismatched_symbol_segments: mismatchedSymbols,
      missing_continuity_prevents_pnl: !coverage.continuous
    },
    valid_segments: validSegments,
    excluded_entries: inspected.filter(segment => !validSegments.includes(segment))
  };
}

function main() {
  const captureRoot = absoluteFromRoot(flag('root', 'data/raw/forward'));
  const output = absoluteFromRoot(flag('output', 'registry/experiments/HY-EXP-0013/forward-ledger-001.json'));
  const ledger = buildForwardLedger({ captureRoot });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(ledger, null, 2)}\n`, { flag: 'wx' });
  if (flag('register', '0') === '1') {
    appendRegistryEvent({
      root: ROOT,
      experimentId: EXPERIMENT_ID,
      eventType: 'amended',
      payloadPath: path.relative(ROOT, output).replaceAll('\\', '/'),
      note: `Forward segment ledger: ${ledger.coverage.segmentCount} valid segments; ${ledger.status}; continuous=${ledger.coverage.continuous}`
    });
  }
  console.log(JSON.stringify(ledger, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
