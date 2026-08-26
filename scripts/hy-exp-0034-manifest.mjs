import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_PATH = path.join(ROOT, 'artifacts', 'HY-EXP-0033', 'data-manifest.json');
const OUTPUT_PATH = path.join(ROOT, 'artifacts', 'HY-EXP-0034', 'data-manifest.json');
const SOURCE_SHA256 = 'c5572595820b6d58c8480edd355320bbf28e7a641350d8eeff791afcb6ff9311';
const PREREG_COMMIT = '561989374e370aed824a5c12271b25dbf2ca8a5b';
const PREREG_SHA256 = '1824b119087503b07ded2da586df87d518bda9e783b51ec025ad7989c4085f93';
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'LINKUSDT', 'LTCUSDT'];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function cloneBySymbols(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([symbol]) => SYMBOLS.includes(symbol)));
}

function verifySourceFile(entry) {
  const absolute = path.resolve(ROOT, entry.path);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new Error(`missing source file: ${entry.path}`);
  }
  const actual = sha256(fs.readFileSync(absolute));
  if (actual !== entry.sha256) throw new Error(`source hash mismatch: ${entry.path}`);
}

const sourceBytes = fs.readFileSync(SOURCE_PATH);
if (sha256(sourceBytes) !== SOURCE_SHA256) throw new Error('HY-EXP-0033 source manifest hash mismatch');
const source = JSON.parse(sourceBytes);
if (source.experimentId !== 'HY-EXP-0033' || source.outcomeRead || source.pnlComputed || source.finalOosRead) {
  throw new Error('source manifest is not an eligible development-only source');
}

const files = source.files.filter(entry => SYMBOLS.includes(entry.symbol));
for (const entry of files) verifySourceFile(entry);
const parity = source.parity.filter(entry => SYMBOLS.includes(entry.symbol));
if (files.length === 0 || parity.length !== SYMBOLS.length * 2) throw new Error('incomplete fixed-eight source subset');
if (source.requiredStreams.join(',') !== 'contract.5m,mark.5m,funding') throw new Error('unexpected source streams');

const manifest = {
  schemaVersion: 1,
  experimentId: 'HY-EXP-0034',
  artifactType: 'HY_EXP_0034_DATA_MANIFEST',
  generatedAt: new Date().toISOString(),
  preregistrationCommit: PREREG_COMMIT,
  preregistrationSha256: PREREG_SHA256,
  sourceExperiment: 'HY-EXP-0033',
  sourceManifestSha256: SOURCE_SHA256,
  sourceManifestUnmodified: true,
  source: source.source,
  window: source.window,
  symbols: SYMBOLS,
  requiredStreams: source.requiredStreams,
  registeredRecovery: {...source.registeredRecovery, symbols: SYMBOLS},
  archiveGap: {...source.archiveGap, symbols: SYMBOLS},
  files,
  sourceRows: Object.fromEntries(Object.entries(source.sourceRows).map(([kind, value]) => [kind, cloneBySymbols(value)])),
  continuity: Object.fromEntries(Object.entries(source.continuity).map(([kind, value]) => [kind, cloneBySymbols(value)])),
  parity,
  missingCount: 0,
  coverageStatus: 'PASS_FIXED_EIGHT_SOURCE_SUBSET',
  outcomeRead: false,
  pnlComputed: false,
  finalOosRead: false,
  developmentAllowed: true,
  safety: {
    paperOnly: true,
    signalOnly: true,
    privateApi: false,
    accountApi: false,
    orderApi: false,
    gmail: false,
    scheduler: false,
    realEmail: false,
    automaticTrading: false,
    productionDeploy: false,
    finalOosRead: false
  }
};

fs.mkdirSync(path.dirname(OUTPUT_PATH), {recursive: true});
fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({
  output: path.relative(ROOT, OUTPUT_PATH).replaceAll('\\', '/'),
  sha256: sha256(fs.readFileSync(OUTPUT_PATH)),
  files: files.length,
  symbols: SYMBOLS.length,
  parityChecks: parity.length,
  sourceManifestSha256: SOURCE_SHA256,
  preregistrationCommit: PREREG_COMMIT,
  head: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: ROOT, encoding: 'utf8'}).trim()
}, null, 2));
