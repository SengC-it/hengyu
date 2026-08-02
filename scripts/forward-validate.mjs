import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCaptureDirectory } from '../src/model/forward-data.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = process.argv[2];
if (!input) {
  console.error('usage: node scripts/forward-validate.mjs <capture-directory-or-manifest>');
  process.exit(1);
}
const target = path.resolve(ROOT, input);
const directory = target.endsWith('.json') ? path.dirname(target) : target;
try {
  const result = validateCaptureDirectory(directory);
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'valid') process.exitCode = 1;
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
