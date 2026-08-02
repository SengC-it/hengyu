import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { appendRegistryEvent, verifyRegistry } from '../scripts/registry.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hengyu-registry-'));
  fs.mkdirSync(path.join(root, 'registry', 'experiments', 'HY-EXP-0001'), { recursive: true });
  fs.writeFileSync(path.join(root, 'CHARTER.md'), 'charter\n');
  fs.writeFileSync(
    path.join(root, 'registry', 'experiments', 'HY-EXP-0001', 'preregistration.json'),
    '{"fixed":true}\n'
  );
  fs.mkdirSync(path.join(root, 'artifacts', 'HY-EXP-0001'), { recursive: true });
  fs.writeFileSync(path.join(root, 'artifacts', 'HY-EXP-0001', 'manifest.json'), '{"files":[]}\n');
  return root;
}

test('registry hash chain verifies and detects payload mutation', () => {
  const root = fixture();
  appendRegistryEvent({
    root,
    experimentId: 'PROJECT',
    eventType: 'project_genesis',
    payloadPath: 'CHARTER.md'
  });
  appendRegistryEvent({
    root,
    experimentId: 'HY-EXP-0001',
    eventType: 'preregistered',
    payloadPath: 'registry/experiments/HY-EXP-0001/preregistration.json'
  });
  appendRegistryEvent({
    root,
    experimentId: 'HY-EXP-0001',
    eventType: 'data_locked',
    payloadPath: 'artifacts/HY-EXP-0001/manifest.json'
  });
  assert.equal(verifyRegistry({ root }).records, 3);
  fs.appendFileSync(
    path.join(root, 'registry', 'experiments', 'HY-EXP-0001', 'preregistration.json'),
    'tampered'
  );
  assert.throws(() => verifyRegistry({ root }), /payload hash mismatch/);
});

test('registry refuses amendments after data lock', () => {
  const root = fixture();
  appendRegistryEvent({
    root,
    experimentId: 'HY-EXP-0001',
    eventType: 'preregistered',
    payloadPath: 'registry/experiments/HY-EXP-0001/preregistration.json'
  });
  appendRegistryEvent({
    root,
    experimentId: 'HY-EXP-0001',
    eventType: 'data_locked',
    payloadPath: 'artifacts/HY-EXP-0001/manifest.json'
  });
  assert.throws(() => appendRegistryEvent({
    root,
    experimentId: 'HY-EXP-0001',
    eventType: 'amended',
    payloadPath: 'registry/experiments/HY-EXP-0001/preregistration.json'
  }), /cannot be amended/);
});

test('completed event verifies every artifact in its bundle', () => {
  const root = fixture();
  const resultPath = path.join(root, 'artifacts', 'HY-EXP-0001', 'result.json');
  fs.writeFileSync(resultPath, '{"pass":false}\n');
  const resultHash = createHash('sha256').update(fs.readFileSync(resultPath)).digest('hex');
  const completionPath = path.join(root, 'artifacts', 'HY-EXP-0001', 'completion.json');
  fs.writeFileSync(completionPath, JSON.stringify({
    experiment_id: 'HY-EXP-0001',
    code_commit: 'a'.repeat(40),
    artifacts: [{ path: 'artifacts/HY-EXP-0001/result.json', sha256: resultHash }]
  }));
  appendRegistryEvent({
    root,
    experimentId: 'HY-EXP-0001',
    eventType: 'preregistered',
    payloadPath: 'registry/experiments/HY-EXP-0001/preregistration.json'
  });
  appendRegistryEvent({
    root,
    experimentId: 'HY-EXP-0001',
    eventType: 'data_locked',
    payloadPath: 'artifacts/HY-EXP-0001/manifest.json'
  });
  appendRegistryEvent({
    root,
    experimentId: 'HY-EXP-0001',
    eventType: 'completed',
    payloadPath: 'artifacts/HY-EXP-0001/completion.json'
  });
  assert.equal(verifyRegistry({ root }).records, 3);
  fs.writeFileSync(resultPath, '{"pass":true}\n');
  assert.throws(() => verifyRegistry({ root }), /completion artifact hash mismatch/);
});

test('completed event rejects a bundle for another experiment', () => {
  const root = fixture();
  const resultPath = path.join(root, 'artifacts', 'HY-EXP-0001', 'result.json');
  fs.writeFileSync(resultPath, '{"pass":false}\n');
  const resultHash = createHash('sha256').update(fs.readFileSync(resultPath)).digest('hex');
  const completionPath = path.join(root, 'artifacts', 'HY-EXP-0001', 'completion.json');
  fs.writeFileSync(completionPath, JSON.stringify({
    experiment_id: 'HY-EXP-9999',
    code_commit: 'a'.repeat(40),
    artifacts: [{ path: 'artifacts/HY-EXP-0001/result.json', sha256: resultHash }]
  }));
  appendRegistryEvent({
    root,
    experimentId: 'HY-EXP-0001',
    eventType: 'preregistered',
    payloadPath: 'registry/experiments/HY-EXP-0001/preregistration.json'
  });
  appendRegistryEvent({
    root,
    experimentId: 'HY-EXP-0001',
    eventType: 'data_locked',
    payloadPath: 'artifacts/HY-EXP-0001/manifest.json'
  });
  assert.throws(() => appendRegistryEvent({
    root,
    experimentId: 'HY-EXP-0001',
    eventType: 'completed',
    payloadPath: 'artifacts/HY-EXP-0001/completion.json'
  }), /experiment mismatch/);
});

test('download failure can be finalized before data lock', () => {
  const root = fixture();
  const failurePath = path.join(root, 'artifacts', 'HY-EXP-0001', 'failure.json');
  fs.writeFileSync(failurePath, '{"stage":"download"}\n');
  appendRegistryEvent({
    root,
    experimentId: 'HY-EXP-0001',
    eventType: 'preregistered',
    payloadPath: 'registry/experiments/HY-EXP-0001/preregistration.json'
  });
  appendRegistryEvent({
    root,
    experimentId: 'HY-EXP-0001',
    eventType: 'failed',
    payloadPath: 'artifacts/HY-EXP-0001/failure.json'
  });
  assert.equal(verifyRegistry({ root }).records, 2);
});

test('verify rejects a rehashed but invalid state transition', () => {
  const root = fixture();
  const ledger = path.join(root, 'registry', 'ledger.jsonl');
  const body = {
    sequence: 1,
    recorded_at: '2026-07-30T00:00:00.000Z',
    experiment_id: 'HY-EXP-0001',
    event_type: 'completed',
    payload_path: 'artifacts/HY-EXP-0001/manifest.json',
    payload_sha256: createHash('sha256')
      .update(fs.readFileSync(path.join(root, 'artifacts', 'HY-EXP-0001', 'manifest.json')))
      .digest('hex'),
    previous_hash: '0'.repeat(64),
    note: ''
  };
  const canonical = value => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  };
  const hash = createHash('sha256').update(canonical(body)).digest('hex');
  fs.writeFileSync(ledger, `${JSON.stringify({ ...body, hash })}\n`);
  assert.throws(() => verifyRegistry({ root }), /must start with preregistered/);
});
