import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const WORKTREE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHARED_RAW_ROOT = path.resolve(WORKTREE_ROOT, '..', 'data', 'raw');
const EXPERIMENT_RAW_ROOT = path.join(SHARED_RAW_ROOT, 'HY-EXP-0032');
const MANIFEST_PATH = path.join(WORKTREE_ROOT, 'artifacts', 'HY-EXP-0032', 'data-manifest.json');
const START = Date.UTC(2024, 7, 1);
const END = Date.UTC(2026, 7, 26);
const SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'XRPUSDT', 'SOLUSDT', 'DOGEUSDT', 'LINKUSDT', 'LTCUSDT',
  'ADAUSDT', 'BCHUSDT', 'DOTUSDT', 'AVAXUSDT', 'TRXUSDT', 'ETCUSDT', 'FILUSDT', 'APTUSDT'
];
const hash = buffer => createHash('sha256').update(buffer).digest('hex');
const monthLabel = time => new Date(time).toISOString().slice(0, 7);
const dayLabel = time => new Date(time).toISOString().slice(0, 10);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function existingCandidates(symbol, kind, name) {
  const candidates = [];
  const roots = [
    path.join(SHARED_RAW_ROOT, 'HY-EXP-0001'),
    path.join(SHARED_RAW_ROOT, 'HY-EXP-0002'),
    path.join(SHARED_RAW_ROOT, 'HY-EXP-0004'),
    path.join(SHARED_RAW_ROOT, 'HY-EXP-0015')
  ];
  for (const root of roots) {
    if (kind === 'contract') {
      candidates.push(path.join(root, symbol, 'kline', name));
      candidates.push(path.join(root, symbol, 'contract', name));
      candidates.push(path.join(root, symbol, 'monthly', name));
      candidates.push(path.join(root, symbol, 'daily', name));
    }
    if (kind === 'mark') {
      candidates.push(path.join(root, symbol, 'mark', name));
      candidates.push(path.join(root, symbol, 'markPriceKlines', name));
      candidates.push(path.join(root, symbol, 'monthly', name));
      candidates.push(path.join(root, symbol, 'daily', name));
    }
    if (kind === 'funding') {
      candidates.push(path.join(root, symbol, 'funding', name));
      candidates.push(path.join(root, symbol, 'fundingRate', name));
      candidates.push(path.join(root, symbol, 'monthly', name));
    }
  }
  return candidates.find(fs.existsSync) ?? null;
}

function archiveUrl(symbol, kind, label, cadence) {
  if (kind === 'funding') {
    return `https://data.binance.vision/data/futures/um/${cadence}/fundingRate/${symbol}/${symbol}-fundingRate-${label}.zip`;
  }
  const directory = kind === 'contract' ? 'klines' : 'markPriceKlines';
  return `https://data.binance.vision/data/futures/um/${cadence}/${directory}/${symbol}/5m/${symbol}-5m-${label}.zip`;
}

async function fetchBuffer(url) {
  const temporary = path.join(os.tmpdir(), `hy-exp-0032-${process.pid}-${Math.random().toString(16).slice(2)}.bin`);
  const args = [
    '--location', '--silent', '--show-error', '--ssl-no-revoke', '--retry', '5', '--retry-delay', '1',
    '--connect-timeout', '30', '--max-time', '180', '--output', temporary,
    '--write-out', '%{http_code}', url
  ];
  const run = (file, commandArgs) => new Promise(resolve => {
    execFile(file, commandArgs, { encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ error, stdout: String(stdout).trim(), stderr: String(stderr).trim() });
    });
  });
  const result = await run('curl.exe', args);
  const curlStatus = result.stdout.slice(-3);
  try {
    if (curlStatus === '200' && !result.error) return fs.readFileSync(temporary);
    if (curlStatus === '404') return null;
    fs.rmSync(temporary, { force: true });
    const escapedUrl = url.replaceAll("'", "''");
    const escapedFile = temporary.replaceAll("'", "''");
    const powershell = "$ProgressPreference='SilentlyContinue'; "
      + `try { Invoke-WebRequest -Uri '${escapedUrl}' -UseBasicParsing -TimeoutSec 180 -OutFile '${escapedFile}'; Write-Output 'STATUS=200' } `
      + "catch { $code=$_.Exception.Response.StatusCode.value__; if($code -eq 404){Write-Output 'STATUS=404'} else {Write-Error $_; exit 1} }";
    const fallback = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', powershell]);
    if (fallback.stdout.includes('STATUS=404')) return null;
    if (fallback.error || !fallback.stdout.includes('STATUS=200')) {
      throw new Error(`curl ${curlStatus || '000'} / powershell failed ${url}: ${fallback.stderr || fallback.error?.message || result.stderr || result.error?.message || 'download failed'}`);
    }
    return fs.readFileSync(temporary);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

async function ensureArchive({ symbol, kind, label, cadence }) {
  const name = kind === 'funding'
    ? `${symbol}-fundingRate-${label}.zip`
    : `${symbol}-5m-${label}.zip`;
  const existing = cadence === 'monthly' ? existingCandidates(symbol, kind, name) : null;
  const url = archiveUrl(symbol, kind, label, cadence);
  if (existing) {
    const buffer = fs.readFileSync(existing);
    return {
      symbol, kind, cadence, period: label, url, path: path.relative(WORKTREE_ROOT, existing).replaceAll('\\', '/'),
      bytes: buffer.length, sha256: hash(buffer), source: 'REUSED_HASH_LOCKED_PUBLIC_ARCHIVE'
    };
  }
  const target = path.join(EXPERIMENT_RAW_ROOT, symbol, kind, cadence, name);
  if (!fs.existsSync(target)) {
    const buffer = await fetchBuffer(url);
    if (!buffer) return { symbol, kind, cadence, period: label, url, path: null, bytes: 0, sha256: null, source: 'NOT_AVAILABLE' };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(`${target}.tmp`, buffer);
    fs.renameSync(`${target}.tmp`, target);
  }
  const buffer = fs.readFileSync(target);
  return {
    symbol, kind, cadence, period: label, url, path: path.relative(WORKTREE_ROOT, target).replaceAll('\\', '/'),
    bytes: buffer.length, sha256: hash(buffer), source: 'BINANCE_OFFICIAL_PUBLIC_ARCHIVE'
  };
}

async function ensureFundingAugust(symbol) {
  const label = '2026-08';
  const target = path.join(EXPERIMENT_RAW_ROOT, symbol, 'funding', 'rest', `${symbol}-fundingRate-${label}.json`);
  const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&startTime=${Date.UTC(2026, 7, 1)}&endTime=${END}&limit=1000`;
  if (!fs.existsSync(target)) {
    const buffer = await fetchBuffer(url);
    if (!buffer) return { symbol, kind: 'funding', cadence: 'rest', period: label, url, path: null, bytes: 0, sha256: null, source: 'NOT_AVAILABLE' };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(`${target}.tmp`, buffer);
    fs.renameSync(`${target}.tmp`, target);
  }
  const buffer = fs.readFileSync(target);
  return {
    symbol, kind: 'funding', cadence: 'rest', period: label, url,
    path: path.relative(WORKTREE_ROOT, target).replaceAll('\\', '/'),
    bytes: buffer.length, sha256: hash(buffer), source: 'BINANCE_PUBLIC_FUNDING_REST'
  };
}

async function main() {
  if (fs.existsSync(MANIFEST_PATH)) {
    console.log(JSON.stringify({ frozen: true, manifest: path.relative(WORKTREE_ROOT, MANIFEST_PATH).replaceAll('\\', '/') }, null, 2));
    return;
  }
  const specs = [];
  for (const symbol of SYMBOLS) {
    for (let cursor = START; cursor < Date.UTC(2026, 7, 1); cursor = new Date(cursor).setUTCMonth(new Date(cursor).getUTCMonth() + 1)) {
      const label = monthLabel(cursor);
      for (const kind of ['contract', 'mark', 'funding']) specs.push({ symbol, kind, label, cadence: 'monthly' });
    }
    for (let cursor = Date.UTC(2026, 7, 1); cursor < END; cursor += 24 * 60 * 60 * 1000) {
      const label = dayLabel(cursor);
      for (const kind of ['contract', 'mark']) specs.push({ symbol, kind, label, cadence: 'daily' });
    }
    specs.push({ symbol, kind: 'funding', label: '2026-08', cadence: 'rest' });
  }
  const files = [];
  let cursor = 0;
  async function worker() {
    while (cursor < specs.length) {
      const spec = specs[cursor++];
      const item = spec.cadence === 'rest' ? await ensureFundingAugust(spec.symbol) : await ensureArchive(spec);
      files.push(item);
      if (files.length % 100 === 0) console.error(`HY-EXP-0032 acquired ${files.length}/${specs.length}`);
    }
  }
  await Promise.all(Array.from({ length: 1 }, worker));
  const missing = files.filter(row => !row.path);
  const manifest = {
    schemaVersion: 1,
    experimentId: 'HY-EXP-0032',
    generatedAt: new Date().toISOString(),
    source: 'Binance official public archive and public funding REST only',
    window: { start: '2024-08-26T00:00:00Z', endExclusive: '2026-08-26T00:00:00Z' },
    symbols: SYMBOLS,
    requiredStreams: ['contract.5m', 'mark.5m', 'funding'],
    files: files.sort((left, right) => `${left.symbol}/${left.kind}/${left.period}`.localeCompare(`${right.symbol}/${right.kind}/${right.period}`)),
    missingCount: missing.length,
    coverageStatus: missing.length === 0 ? 'FULL_FILE_COVERAGE_PENDING_CONTINUITY_VALIDATION' : 'DATA_FAIL_MISSING_PUBLIC_SOURCE_FILES',
    outcomeRead: false,
    pnlComputed: false,
    finalOosRead: false,
    developmentAllowed: true,
    safety: { paperOnly: true, signalOnly: true, gmail: false, scheduler: false, autoTrading: false, accountApi: false, orderApi: false }
  };
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ manifest: path.relative(WORKTREE_ROOT, MANIFEST_PATH).replaceAll('\\', '/'), files: files.length, missing: missing.length }, null, 2));
}

await main();
