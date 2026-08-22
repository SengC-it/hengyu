import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  HY_EXP_0021_CAPTURE_ROOTS,
  HY_EXP_0021_CAPTURE_START,
  HY_EXP_0021_DEVELOPMENT_END_EXCLUSIVE,
  HY_EXP_0021_FINAL_OOS_END_EXCLUSIVE,
  HY_EXP_0021_FINAL_OOS_START,
  HY_EXP_0021_ID,
  HY_EXP_0021_PREREGISTRATION_COMMIT,
  HY_EXP_0021_PREREGISTRATION_COMMITTED_AT,
  HY_EXP_0021_WINDOWS,
  assertHyExp0021CaptureRoot,
  assertHyExp0021FinalOosOperation,
  assertHyExp0021FinalOosWindow,
  assertHyExp0021InputIdentity,
  assertHyExp0021PaperOnly,
  buildHyExp0021CaptureMetadata,
  firstCompleteUtc4hBoundaryAfter,
  resolveHyExp0021Windows,
  validateHyExp0021ProspectiveRecord
} from '../src/model/hy-exp-0021-prospective.mjs';

const ROOT = path.resolve(process.cwd());
const readJson = relative => JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
const sha256 = relative => createHash('sha256').update(fs.readFileSync(path.join(ROOT, relative))).digest('hex');

test('HY-EXP-0020 remains frozen DATA_FAIL and is not a 0021 input', () => {
  const closure = readJson('artifacts/HY-EXP-0020/closure.json');
  assert.equal(closure.status, 'DATA_FAIL_FROZEN');
  assert.equal(closure.reason, 'HISTORICAL_PIT_EXCHANGE_INFO_UNAVAILABLE_OR_NOT_PROVABLY_COMPLETE');
  assert.equal(sha256('artifacts/HY-EXP-0020/closure.json'), '01a9f49b2527a5a7adaf79903a4b5218e1de44210794c7f7314800b2441193ec');
  assert.throws(
    () => assertHyExp0021InputIdentity({ experimentId: 'HY-EXP-0020', inputPath: 'data/raw/final-oos/HY-EXP-0020/run' }),
    /foreign experiment input/
  );
  assert.throws(
    () => assertHyExp0021InputIdentity({ experimentId: HY_EXP_0021_ID, inputPath: 'data/raw/final-oos/HY-EXP-0020/run' }),
    /experiment-isolated/
  );
});

test('0021 capture start is the first complete boundary after preregistration and windows are immutable', () => {
  const prereg = readJson('registry/experiments/HY-EXP-0021/preregistration.json');
  const readiness = readJson('artifacts/HY-EXP-0021/capture-readiness.json');
  assert.equal(prereg.status, 'PREREGISTERED_PENDING_ACCEPTANCE');
  assert.equal(readiness.preregistrationCommit, HY_EXP_0021_PREREGISTRATION_COMMIT);
  assert.equal(readiness.preregistrationSha256, '75a2533e9c00e917f7aa1207f75b961efa9d0410c51f65ebea59df4cd8c216a7');
  assert.equal(readiness.registryPreregisteredSequence, 72);
  assert.equal(readiness.preregistrationCommittedAt, HY_EXP_0021_PREREGISTRATION_COMMITTED_AT);
  assert.equal(firstCompleteUtc4hBoundaryAfter(HY_EXP_0021_PREREGISTRATION_COMMITTED_AT), HY_EXP_0021_CAPTURE_START);
  assert.equal(HY_EXP_0021_WINDOWS.captureStart, HY_EXP_0021_CAPTURE_START);
  assert.equal(HY_EXP_0021_WINDOWS.developmentStart, '2026-08-24T00:00:00.000Z');
  assert.equal(HY_EXP_0021_WINDOWS.developmentEndExclusive, HY_EXP_0021_DEVELOPMENT_END_EXCLUSIVE);
  assert.equal(HY_EXP_0021_WINDOWS.finalOosStart, HY_EXP_0021_FINAL_OOS_START);
  assert.equal(HY_EXP_0021_WINDOWS.finalOosEndExclusive, HY_EXP_0021_FINAL_OOS_END_EXCLUSIVE);
  assert.throws(
    () => assertHyExp0021FinalOosWindow({ start: '2027-02-28T20:00:00Z', endExclusive: HY_EXP_0021_FINAL_OOS_END_EXCLUSIVE }),
    /immutable/
  );
  assert.equal(resolveHyExp0021Windows({ preregistrationCommittedAt: '2026-08-24T01:00:00Z' }).developmentStart, '2026-08-24T04:00:00.000Z');
});

test('0021 rejects all pre-capture records and future source timestamps', () => {
  assert.throws(
    () => validateHyExp0021ProspectiveRecord({
      sourceTimestamp: '2026-08-22T03:59:59.999Z',
      receivedAt: '2026-08-22T04:00:00.000Z'
    }),
    error => error.code === 'PRE_CAPTURE_DATA'
  );
  assert.throws(
    () => validateHyExp0021ProspectiveRecord({
      sourceTimestamp: '2026-08-22T04:00:00.001Z',
      receivedAt: '2026-08-22T04:00:00.000Z'
    }),
    error => error.code === 'FUTURE_DATA'
  );
  assert.deepEqual(
    validateHyExp0021ProspectiveRecord({
      sourceTimestamp: '2026-08-22T04:00:00.000Z',
      receivedAt: '2026-08-22T04:00:00.100Z'
    }),
    {
      eligible: true,
      sourceTimestamp: '2026-08-22T04:00:00.000Z',
      receivedAt: '2026-08-22T04:00:00.100Z',
      captureStart: HY_EXP_0021_CAPTURE_START,
      futureData: false,
      proxy: false
    }
  );
});

test('0021 roots are isolated and capture metadata is paper-only with no PnL', () => {
  const projectRoot = ROOT;
  const developmentRoot = assertHyExp0021CaptureRoot({ projectRoot, mode: 'DEVELOPMENT_CAPTURE' });
  const finalRoot = assertHyExp0021CaptureRoot({ projectRoot, mode: 'FINAL_OOS_CAPTURE' });
  assert.ok(developmentRoot.endsWith(path.join('prospective-development', HY_EXP_0021_ID)));
  assert.ok(finalRoot.endsWith(path.join('prospective-final-oos', HY_EXP_0021_ID)));
  assert.notEqual(developmentRoot, path.resolve(projectRoot, 'data/raw/engineering-dry-run/HY-EXP-0020'));
  assert.notEqual(finalRoot, path.resolve(projectRoot, 'data/raw/final-oos/HY-EXP-0020'));
  assert.deepEqual(HY_EXP_0021_CAPTURE_ROOTS, {
    development: path.join('data', 'raw', 'prospective-development', HY_EXP_0021_ID),
    finalOos: path.join('data', 'raw', 'prospective-final-oos', HY_EXP_0021_ID)
  });
  assert.throws(
    () => assertHyExp0021CaptureRoot({ projectRoot, mode: 'DEVELOPMENT_CAPTURE', outputRoot: 'data/raw/final-oos/HY-EXP-0020' }),
    /isolated/
  );
  const metadata = buildHyExp0021CaptureMetadata({ mode: 'DEVELOPMENT_CAPTURE', runId: 'test-run', startedAt: HY_EXP_0021_CAPTURE_START });
  assert.equal(metadata.experimentId, HY_EXP_0021_ID);
  assert.equal(metadata.authorization, 'PAPER_ONLY');
  assert.equal(metadata.liveOrdersEnabled, false);
  assert.equal(metadata.accountApiEnabled, false);
  assert.equal(metadata.orderApiEnabled, false);
  assert.deepEqual(metadata.orderEndpoints, []);
  assert.equal(metadata.pnlComputed, false);
  assert.equal(metadata.developmentAllowed, false);
  assert.equal(metadata.finalOosEligible, false);
  assert.equal(assertHyExp0021PaperOnly(metadata), true);
});

test('Final OOS permits only append/hash/integrity before Development PASS and locks after failure', () => {
  for (const operation of ['write', 'hash', 'integrity_check']) {
    assert.equal(assertHyExp0021FinalOosOperation({ operation, developmentStatus: 'NOT_PASS' }).allowed, true);
  }
  for (const operation of ['query', 'summarize', 'inspect', 'calculate', 'optimize', 'generate_metrics', 'train', 'backtest']) {
    assert.throws(
      () => assertHyExp0021FinalOosOperation({ operation, developmentStatus: 'NOT_PASS', developmentAllowed: false }),
      /Final-OOS.*locked/i
    );
    assert.throws(
      () => assertHyExp0021FinalOosOperation({ operation, developmentStatus: 'FAIL', developmentAllowed: false }),
      /Final-OOS.*locked/i
    );
  }
  assert.equal(assertHyExp0021FinalOosOperation({ operation: 'query', developmentStatus: 'PASS', developmentAllowed: true }).mode, 'POST_DEVELOPMENT_READ');
});
