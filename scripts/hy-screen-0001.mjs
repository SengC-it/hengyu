import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHyScreen0001 } from '../src/research/hy-screen-0001.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACT_DIR = path.join(ROOT, 'artifacts', 'HY-SCREEN-0001');
const RESULT_PATH = path.join(ARTIFACT_DIR, 'screen-result.json');
const DIAGNOSTICS_PATH = path.join(ARTIFACT_DIR, 'screen-diagnostics.jsonl');

if (process.argv[2] !== 'run') {
  throw new Error('usage: node scripts/hy-screen-0001.mjs run');
}
if (fs.existsSync(RESULT_PATH) || fs.existsSync(DIAGNOSTICS_PATH)) {
  throw new Error('HY-SCREEN-0001 artifacts already exist; screening is frozen and cannot be rerun or tuned');
}

fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
const { result, diagnostics } = runHyScreen0001({ root: ROOT });
fs.writeFileSync(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
const lines = [
  JSON.stringify({
    type: 'screen_metadata',
    screenId: result.screenId,
    baseCommit: result.baseCommit,
    sourceExperimentId: result.data.sourceExperimentId,
    sourceManifestSha256: result.data.sourceManifestSha256,
    oofExposureStart: result.data.oofExposureStart,
    oofExposureEndExclusive: result.data.oofExposureEndExclusive,
    familyCount: Object.keys(result.families).length,
    finalOosRead: result.safety.finalOosRead,
    holdout0028Read: result.safety.holdout0028Read,
    newExperimentCreated: result.safety.newExperimentCreated
  }),
  ...diagnostics.map(row => JSON.stringify(row)),
  ...Object.entries(result.families).map(([family, metrics]) => JSON.stringify({
    type: 'family_summary',
    family,
    ...metrics
  }))
];
fs.writeFileSync(DIAGNOSTICS_PATH, `${lines.join('\n')}\n`, 'utf8');
console.log(JSON.stringify({
  screenId: result.screenId,
  recommendation: result.recommendation,
  resultPath: path.relative(ROOT, RESULT_PATH),
  diagnosticsPath: path.relative(ROOT, DIAGNOSTICS_PATH),
  families: Object.fromEntries(Object.entries(result.families).map(([family, metrics]) => [family, {
    rawCandidateCount: metrics.rawCandidateCount,
    oofAdvisoryCount: metrics.oofAdvisoryCount,
    qualified: metrics.qualified
  }])),
  registryModified: false,
  finalOosRead: result.safety.finalOosRead,
  holdout0028Read: result.safety.holdout0028Read,
  productionModified: result.safety.productionModified
}, null, 2));
