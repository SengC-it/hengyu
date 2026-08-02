import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..');
const ZERO_HASH = '0'.repeat(64);
const FINAL_EVENTS = new Set(['completed', 'failed']);

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const fields = Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${fields.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

export function sha256File(file) {
  return sha256(fs.readFileSync(file));
}

function ledgerFile(root) {
  return path.join(root, 'registry', 'ledger.jsonl');
}

function readLedger(root) {
  const file = ledgerFile(root);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`ledger line ${index + 1} is invalid JSON: ${error.message}`);
      }
    });
}

function resolvePayload(root, payloadPath) {
  const normalized = payloadPath.replaceAll('\\', '/').replace(/^\/+/, '');
  const absolute = path.resolve(root, normalized);
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`payload path escapes project root: ${payloadPath}`);
  }
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new Error(`payload file is unavailable: ${normalized}`);
  }
  return { normalized, absolute };
}

function verifyCompletionBundle(root, file, experimentId) {
  let bundle;
  try {
    bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`completion bundle is invalid JSON: ${error.message}`);
  }
  if (!Array.isArray(bundle.artifacts) || !bundle.artifacts.length) {
    throw new Error('completion bundle must list artifact hashes');
  }
  if (bundle.experiment_id !== experimentId) {
    throw new Error(`completion bundle experiment mismatch: expected ${experimentId}`);
  }
  if (!/^[a-f0-9]{40}$/.test(bundle.code_commit)) {
    throw new Error('completion bundle must record a full Git commit hash');
  }
  const seen = new Set();
  for (const artifact of bundle.artifacts) {
    if (seen.has(artifact.path)) throw new Error(`duplicate completion artifact: ${artifact.path}`);
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) {
      throw new Error(`invalid completion artifact hash for ${artifact.path}`);
    }
    seen.add(artifact.path);
    const payload = resolvePayload(root, artifact.path);
    if (sha256File(payload.absolute) !== artifact.sha256) {
      throw new Error(`completion artifact hash mismatch for ${artifact.path}`);
    }
  }
}

function validateTransition(entries, experimentId, eventType) {
  if (experimentId === 'PROJECT') {
    if (eventType !== 'project_genesis') throw new Error('PROJECT only accepts project_genesis');
    if (entries.some(entry => entry.experiment_id === 'PROJECT')) {
      throw new Error('project_genesis is already registered');
    }
    return;
  }
  if (!/^HY-EXP-\d{4}$/.test(experimentId)) {
    throw new Error(`invalid experiment id: ${experimentId}`);
  }
  const events = entries
    .filter(entry => entry.experiment_id === experimentId)
    .map(entry => entry.event_type);
  if (!events.length && eventType !== 'preregistered') {
    throw new Error(`${experimentId} must start with preregistered`);
  }
  if (events.length && eventType === 'preregistered') {
    throw new Error(`${experimentId} is already preregistered`);
  }
  if (events.some(event => FINAL_EVENTS.has(event))) {
    throw new Error(`${experimentId} is already final`);
  }
  if (eventType === 'amended' && events.includes('data_locked')) {
    throw new Error(`${experimentId} cannot be amended after data_locked`);
  }
  if (eventType === 'data_locked' && !events.includes('preregistered')) {
    throw new Error(`${experimentId} must be preregistered before data_locked`);
  }
  if (eventType === 'data_locked' && events.includes('data_locked')) {
    throw new Error(`${experimentId} already has a locked data manifest`);
  }
  if (eventType === 'completed' && !events.includes('data_locked')) {
    throw new Error(`${experimentId} requires data_locked before completed`);
  }
  if (eventType === 'failed' && !events.includes('preregistered')) {
    throw new Error(`${experimentId} requires preregistered before failed`);
  }
  if (!['preregistered', 'amended', 'data_locked', 'completed', 'failed'].includes(eventType)) {
    throw new Error(`unsupported event type: ${eventType}`);
  }
}

export function verifyRegistry({ root = DEFAULT_ROOT } = {}) {
  const entries = readLedger(root);
  let previousHash = ZERO_HASH;
  const seenFinal = new Set();
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    validateTransition(entries.slice(0, index), entry.experiment_id, entry.event_type);
    if (entry.sequence !== index + 1) throw new Error(`sequence mismatch at line ${index + 1}`);
    if (!Number.isFinite(Date.parse(entry.recorded_at))) {
      throw new Error(`invalid recorded_at at line ${index + 1}`);
    }
    if (!/^[a-f0-9]{64}$/.test(entry.payload_sha256)) {
      throw new Error(`invalid payload hash at line ${index + 1}`);
    }
    if (entry.previous_hash !== previousHash) throw new Error(`previous hash mismatch at line ${index + 1}`);
    const { hash, ...body } = entry;
    const expectedHash = sha256(canonicalJson(body));
    if (hash !== expectedHash) throw new Error(`event hash mismatch at line ${index + 1}`);
    const payload = resolvePayload(root, entry.payload_path);
    const expectedPayloadHash = sha256File(payload.absolute);
    if (entry.payload_sha256 !== expectedPayloadHash) {
      throw new Error(`payload hash mismatch for ${entry.payload_path}`);
    }
    if (entry.event_type === 'completed') {
      verifyCompletionBundle(root, payload.absolute, entry.experiment_id);
    }
    if (seenFinal.has(entry.experiment_id)) {
      throw new Error(`event exists after final state for ${entry.experiment_id}`);
    }
    if (FINAL_EVENTS.has(entry.event_type)) seenFinal.add(entry.experiment_id);
    previousHash = hash;
  }
  return {
    ok: true,
    records: entries.length,
    head: entries.at(-1)?.hash ?? ZERO_HASH
  };
}

export function appendRegistryEvent({
  root = DEFAULT_ROOT,
  experimentId,
  eventType,
  payloadPath,
  note = ''
}) {
  const directory = path.join(root, 'registry');
  const lockFile = path.join(directory, 'ledger.lock');
  fs.mkdirSync(directory, { recursive: true });
  let lock;
  try {
    lock = fs.openSync(lockFile, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('registry is locked by another append operation');
    throw error;
  }
  try {
    verifyRegistry({ root });
    const entries = readLedger(root);
    validateTransition(entries, experimentId, eventType);
    const payload = resolvePayload(root, payloadPath);
    if (eventType === 'completed') {
      verifyCompletionBundle(root, payload.absolute, experimentId);
    }
    const body = {
      sequence: entries.length + 1,
      recorded_at: new Date().toISOString(),
      experiment_id: experimentId,
      event_type: eventType,
      payload_path: payload.normalized,
      payload_sha256: sha256File(payload.absolute),
      previous_hash: entries.at(-1)?.hash ?? ZERO_HASH,
      note
    };
    const event = { ...body, hash: sha256(canonicalJson(body)) };
    const file = ledgerFile(root);
    const handle = fs.openSync(file, 'a');
    try {
      fs.writeSync(handle, `${JSON.stringify(event)}\n`, null, 'utf8');
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    return event;
  } finally {
    if (lock != null) fs.closeSync(lock);
    fs.unlinkSync(lockFile);
  }
}

function parseFlags(args) {
  const output = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const name = arg.slice(2);
    const value = args[index + 1];
    if (value == null || value.startsWith('--')) throw new Error(`missing value for --${name}`);
    output[name] = value;
    index++;
  }
  return output;
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'verify') {
    console.log(JSON.stringify(verifyRegistry(), null, 2));
    return;
  }
  if (command === 'append') {
    const flags = parseFlags(rest);
    const event = appendRegistryEvent({
      experimentId: flags.experiment,
      eventType: flags.event,
      payloadPath: flags.payload,
      note: flags.note ?? ''
    });
    console.log(JSON.stringify(event, null, 2));
    return;
  }
  throw new Error('usage: registry.mjs verify | append --experiment ID --event TYPE --payload PATH [--note TEXT]');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
