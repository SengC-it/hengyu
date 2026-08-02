import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { evaluateCaptureDataQuality } from '../src/model/data-quality.mjs';
import { validateCaptureDirectory } from '../src/model/forward-data.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = process.argv[2];
if (!input) {
  console.error('usage: node scripts/forward-quality.mjs <capture-directory>');
  process.exit(1);
}
const directory = path.resolve(ROOT, input);
try {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  const validation = validateCaptureDirectory(directory);
  const quality = evaluateCaptureDataQuality({
    manifest,
    validation,
    requiredSymbols: manifest.symbols ?? []
  });
  if (!manifest.universe?.path || !manifest.universe?.sha256) {
    quality.reasons.push('missing_universe_snapshot');
  } else {
    const universeFile = path.resolve(ROOT, manifest.universe.path);
    if (!fs.existsSync(universeFile)) quality.reasons.push('universe_snapshot_unavailable');
    else {
      const hash = createHash('sha256').update(fs.readFileSync(universeFile)).digest('hex');
      if (hash !== manifest.universe.sha256) quality.reasons.push('universe_snapshot_hash_mismatch');
    }
  }
  quality.reasons = [...new Set(quality.reasons)];
  quality.pnlEligible = quality.reasons.length === 0;
  quality.status = quality.pnlEligible ? 'READY' : 'NOT_READY';
  console.log(JSON.stringify({ runId: manifest.run_id, validation, quality }, null, 2));
  if (!quality.pnlEligible) process.exitCode = 1;
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
