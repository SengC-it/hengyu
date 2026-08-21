import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadProfitV3Dataset } from '../src/research/profit-v3.mjs';
import { buildFailureAttribution } from '../src/research/profit-v3-failure-attribution.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACT_DIR = path.join(ROOT, 'artifacts', 'HY-EXP-0019');
const OUTPUT = path.join(ARTIFACT_DIR, 'failure-attribution.json');

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function main() {
  if (fs.existsSync(OUTPUT)) throw new Error(`refusing to overwrite frozen attribution report: ${OUTPUT}`);
  const resultFile = path.join(ARTIFACT_DIR, 'result.json');
  const tradesFile = path.join(ARTIFACT_DIR, 'trades.jsonl');
  const manifestFile = path.join(ARTIFACT_DIR, 'data-manifest.json');
  const scansFile = path.join(ARTIFACT_DIR, 'scan-diagnostics.jsonl');
  const sourceManifestFile = path.join(ROOT, 'artifacts', 'HY-EXP-0001', 'data-manifest.json');
  const result = readJson(resultFile);
  const trades = readJsonl(tradesFile);
  const scans = readJsonl(scansFile);
  const dataset = loadProfitV3Dataset({ root: ROOT });
  const sourceHashes = {
    resultSha256: sha256File(resultFile),
    tradesSha256: sha256File(tradesFile),
    dataManifestSha256: sha256File(manifestFile),
    scanDiagnosticsSha256: sha256File(scansFile),
    sourceManifestSha256: sha256File(sourceManifestFile)
  };
  const report = buildFailureAttribution({
    result,
    trades,
    scans,
    barsBySymbol: dataset.barsBySymbol,
    sourceHashes,
    sourceCommit: '9d6b5298fab9760a611c2b5e52e86c500a6688a1'
  });
  fs.writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    output: path.relative(ROOT, OUTPUT).replaceAll('\\', '/'),
    sha256: sha256File(OUTPUT),
    oosTradeCount: report.tradeAttribution.count,
    bearCandidateCount: report.bearCandidateAttribution.candidateCount,
    bearFinalTradeCount: report.bearCandidateAttribution.finalTradeCount,
    counterfactualStatus: report.counterfactualExits.status
  }, null, 2));
}

main();
