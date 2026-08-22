import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  assertHyExp0023CaptureMode,
  assertHyExp0023FrozenResolution,
  HY_EXP_0023_CAPTURE_MODES,
  HY_EXP_0023_CAPTURE_START,
  HY_EXP_0023_DEVELOPMENT_END_EXCLUSIVE,
  HY_EXP_0023_DEVELOPMENT_ROOT,
  HY_EXP_0023_FINAL_OOS_END_EXCLUSIVE,
  HY_EXP_0023_FINAL_OOS_START,
  HY_EXP_0023_ID,
  HY_EXP_0023_PREREGISTRATION_COMMIT,
  HY_EXP_0023_PREREGISTRATION_COMMITTED_AT
} from './hy-exp-0023-prospective.mjs';

export const HY_EXP_0023_DEFAULT_PREREGISTRATION_PATH = path.join(
  'registry', 'experiments', HY_EXP_0023_ID, 'preregistration.json'
);
export const HY_EXP_0023_DEFAULT_RESOLUTION_PATH = path.join(
  'artifacts', HY_EXP_0023_ID, 'preregistration-resolution.json'
);

function captureGateError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function timestamp(name, value) {
  const parsed = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
  if (!Number.isFinite(parsed)) throw captureGateError('HY_EXP_0023_INVALID_TIMESTAMP', `invalid ${name}`);
  return parsed;
}

function canonicalRoot(projectRoot, relativeRoot) {
  return path.resolve(projectRoot, relativeRoot);
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256HyExp0023Artifact(filePath) {
  return sha256Bytes(fs.readFileSync(path.resolve(filePath)));
}

function readJsonArtifact(filePath, name) {
  const absolute = path.resolve(filePath);
  if (!fs.existsSync(absolute)) throw captureGateError('HY_EXP_0023_ARTIFACT_MISSING', `${name} is missing: ${absolute}`);
  const bytes = fs.readFileSync(absolute);
  try {
    return { path: absolute, value: JSON.parse(bytes.toString('utf8')), sha256: sha256Bytes(bytes) };
  } catch (error) {
    throw captureGateError('HY_EXP_0023_ARTIFACT_INVALID', `${name} is not valid JSON: ${error.message}`);
  }
}

function assertPaperOnly(preregistration, readiness) {
  const authority = preregistration?.execution_authority ?? {};
  const orderEndpoints = preregistration?.execution_authority?.order_endpoints ?? [];
  const accountEndpoints = preregistration?.execution_authority?.account_endpoints ?? [];
  if (preregistration?.authorization !== 'PAPER_ONLY'
    || authority.paper_only !== true
    || preregistration?.liveOrdersEnabled !== false
    || preregistration?.developmentAllowed !== false
    || preregistration?.pnlComputed !== false
    || orderEndpoints.length !== 0
    || accountEndpoints.length !== 0) {
    throw captureGateError('HY_EXP_0023_SAFETY_GATE_FAILED', 'preregistration is not PAPER_ONLY or exposes execution authority');
  }
  if (readiness?.pnlComputed !== false
    || readiness?.officialCaptureAuthorized !== false
    || readiness?.orderApiEnabled !== false
    || readiness?.accountApiEnabled !== false) {
    throw captureGateError('HY_EXP_0023_READINESS_SAFETY_GATE_FAILED', 'readiness artifact is not locked to paper-only capture');
  }
}

function assertFrozenInputs({ projectRoot, preregistrationPath, resolutionPath } = {}) {
  const preregistrationArtifact = readJsonArtifact(
    preregistrationPath ?? path.join(projectRoot, HY_EXP_0023_DEFAULT_PREREGISTRATION_PATH),
    'HY-EXP-0023 preregistration'
  );
  const resolutionArtifact = readJsonArtifact(
    resolutionPath ?? path.join(projectRoot, HY_EXP_0023_DEFAULT_RESOLUTION_PATH),
    'HY-EXP-0023 resolution'
  );
  const preregistrationSha256 = preregistrationArtifact.sha256;
  if (!/^[0-9a-f]{64}$/.test(String(resolutionArtifact.value?.preregFileSha256 ?? '').toLowerCase())
    || resolutionArtifact.value.preregFileSha256 !== preregistrationSha256) {
    throw captureGateError(
      'HY_EXP_0023_PREREGISTRATION_HASH_MISMATCH',
      'frozen preregistration bytes do not match the complete SHA-256 recorded by the resolution'
    );
  }
  assertHyExp0023FrozenResolution({
    resolution: resolutionArtifact.value,
    preregistrationSha256
  });
  if (resolutionArtifact.value.preregCommit !== HY_EXP_0023_PREREGISTRATION_COMMIT
    || resolutionArtifact.value.preregCommitTimestamp !== HY_EXP_0023_PREREGISTRATION_COMMITTED_AT
    || resolutionArtifact.value.captureStart !== HY_EXP_0023_CAPTURE_START
    || resolutionArtifact.value.finalOosStart !== HY_EXP_0023_FINAL_OOS_START
    || resolutionArtifact.value.finalOosEndExclusive !== HY_EXP_0023_FINAL_OOS_END_EXCLUSIVE) {
    throw captureGateError('HY_EXP_0023_WINDOW_OR_RESOLUTION_MISMATCH', 'frozen resolution/window mismatch');
  }
  if (preregistrationArtifact.value?.experiment_id !== HY_EXP_0023_ID) {
    throw captureGateError('HY_EXP_0023_EXPERIMENT_MISMATCH', 'preregistration experiment id mismatch');
  }
  return {
    preregistration: preregistrationArtifact.value,
    resolution: resolutionArtifact.value,
    preregistrationSha256
  };
}

function assertExactDevelopmentRoot({ projectRoot, outputRoot } = {}) {
  const expected = canonicalRoot(projectRoot, HY_EXP_0023_DEVELOPMENT_ROOT);
  const actual = path.resolve(projectRoot, outputRoot ?? expected);
  if (actual !== expected) {
    throw captureGateError('HY_EXP_0023_DEVELOPMENT_ROOT_MISMATCH', `development output root must be ${expected}`);
  }
  return expected;
}

function recordSourceTimestamp(record) {
  return record?.sourceTimestamp
    ?? record?.sourceExchangeTimestamp
    ?? record?.exchangeObservedAt
    ?? record?.E
    ?? record?.T
    ?? record?.openTime
    ?? null;
}

export function validateHyExp0023ProspectiveRecord({ record, now = Date.now() } = {}) {
  const sourceTimestamp = timestamp('record source timestamp', recordSourceTimestamp(record));
  const receivedAt = timestamp('record receivedAt', record?.receivedAt);
  const start = timestamp('captureStart', HY_EXP_0023_CAPTURE_START);
  const end = timestamp('developmentEndExclusive', HY_EXP_0023_DEVELOPMENT_END_EXCLUSIVE);
  if (sourceTimestamp < start || receivedAt < start) {
    throw captureGateError('HY_EXP_0023_PRE_CAPTURE_RECORD', 'prospective record is before captureStart');
  }
  if (sourceTimestamp >= end || receivedAt >= end) {
    throw captureGateError('HY_EXP_0023_DEVELOPMENT_WINDOW_VIOLATION', 'prospective record is outside Development capture window');
  }
  if (sourceTimestamp > receivedAt) {
    throw captureGateError('HY_EXP_0023_FUTURE_SOURCE_TIMESTAMP', 'source timestamp is after receivedAt');
  }
  return {
    sourceTimestamp,
    receivedAt,
    validatedAt: timestamp('validation time', now)
  };
}

export function verifyHyExp0023Readiness({ readinessPath, expectedSha256, projectRoot = process.cwd() } = {}) {
  const artifact = readJsonArtifact(
    readinessPath ?? path.join(projectRoot, 'artifacts', HY_EXP_0023_ID, 'engineering-readiness.json'),
    'HY-EXP-0023 engineering readiness'
  );
  if (!expectedSha256 || artifact.sha256 !== String(expectedSha256).toLowerCase()) {
    throw captureGateError('HY_EXP_0023_READINESS_HASH_MISMATCH', 'engineering readiness hash does not match the expected immutable hash');
  }
  if (artifact.value?.experimentId !== HY_EXP_0023_ID || artifact.value?.status !== 'PASS') {
    throw captureGateError('HY_EXP_0023_READINESS_NOT_PASS', 'engineering readiness must be PASS for prospective capture');
  }
  return artifact;
}

export function validateHyExp0023ProspectiveCaptureGate({
  projectRoot = process.cwd(),
  outputRoot,
  readinessPath,
  readinessSha256,
  now = Date.now(),
  requireCaptureStart = false,
  existingRecords = []
} = {}) {
  const frozen = assertFrozenInputs({ projectRoot });
  const readiness = verifyHyExp0023Readiness({ readinessPath, expectedSha256: readinessSha256, projectRoot });
  const root = assertExactDevelopmentRoot({ projectRoot, outputRoot });
  assertPaperOnly(frozen.preregistration, readiness.value);
  const currentTime = timestamp('current time', now);
  const captureStart = timestamp('captureStart', HY_EXP_0023_CAPTURE_START);
  if (requireCaptureStart && currentTime < captureStart) {
    throw captureGateError('HY_EXP_0023_CAPTURE_NOT_STARTED', 'captureStart has not been reached');
  }
  if (currentTime >= timestamp('developmentEndExclusive', HY_EXP_0023_DEVELOPMENT_END_EXCLUSIVE)) {
    throw captureGateError('HY_EXP_0023_CAPTURE_WINDOW_CLOSED', 'Development capture window is closed');
  }
  for (const record of existingRecords) validateHyExp0023ProspectiveRecord({ record, now: currentTime });
  return {
    experimentId: HY_EXP_0023_ID,
    mode: requireCaptureStart ? HY_EXP_0023_CAPTURE_MODES.DEVELOPMENT_CAPTURE : HY_EXP_0023_CAPTURE_MODES.ARMED_PROSPECTIVE_CAPTURE,
    captureStart: HY_EXP_0023_CAPTURE_START,
    developmentEndExclusive: HY_EXP_0023_DEVELOPMENT_END_EXCLUSIVE,
    outputRoot: root,
    preregistrationSha256: frozen.preregistrationSha256,
    readinessSha256: readiness.sha256,
    officialCaptureAuthorized: false,
    developmentAllowed: requireCaptureStart,
    pnlComputed: false,
    paperOnly: true,
    orderApiEnabled: false,
    accountApiEnabled: false
  };
}

/**
 * Gate the real prospective writer. It can be armed before the boundary, but
 * no Development bytes can be written until the atomic start transition passes.
 */
export function createHyExp0023ProspectiveCaptureController({
  projectRoot = process.cwd(),
  outputRoot,
  readinessPath,
  readinessSha256,
  now = () => Date.now(),
  appendRecord = () => {},
  onReject = () => {}
} = {}) {
  const root = assertExactDevelopmentRoot({ projectRoot, outputRoot });
  let state = 'DISARMED';
  let gate = null;
  const rejectedPreCapture = [];
  const existingRecords = [];

  const arm = () => {
    if (state !== 'DISARMED') throw captureGateError('HY_EXP_0023_CAPTURE_STATE', `cannot arm from ${state}`);
    gate = validateHyExp0023ProspectiveCaptureGate({
      projectRoot,
      outputRoot: root,
      readinessPath,
      readinessSha256,
      now: now(),
      existingRecords
    });
    assertHyExp0023CaptureMode(HY_EXP_0023_CAPTURE_MODES.ARMED_PROSPECTIVE_CAPTURE, { gateValidated: true });
    state = HY_EXP_0023_CAPTURE_MODES.ARMED_PROSPECTIVE_CAPTURE;
    return { ...gate, state };
  };

  const start = () => {
    if (state !== HY_EXP_0023_CAPTURE_MODES.ARMED_PROSPECTIVE_CAPTURE) {
      throw captureGateError('HY_EXP_0023_CAPTURE_STATE', `cannot start from ${state}`);
    }
    const nextGate = validateHyExp0023ProspectiveCaptureGate({
      projectRoot,
      outputRoot: root,
      readinessPath,
      readinessSha256,
      now: now(),
      requireCaptureStart: true,
      existingRecords
    });
    assertHyExp0023CaptureMode(HY_EXP_0023_CAPTURE_MODES.DEVELOPMENT_CAPTURE, { gateValidated: true });
    gate = nextGate;
    state = HY_EXP_0023_CAPTURE_MODES.DEVELOPMENT_CAPTURE;
    return { ...gate, state };
  };

  const writeRecord = record => {
    if (state !== HY_EXP_0023_CAPTURE_MODES.DEVELOPMENT_CAPTURE) {
      const error = captureGateError(
        state === HY_EXP_0023_CAPTURE_MODES.ARMED_PROSPECTIVE_CAPTURE
          ? 'HY_EXP_0023_PRE_CAPTURE_WRITE_REJECTED'
          : 'HY_EXP_0023_CAPTURE_NOT_STARTED',
        'Development raw writes are locked until the atomic capture transition'
      );
      rejectedPreCapture.push({ record, rejectedAt: now(), code: error.code });
      onReject({ record, error });
      throw error;
    }
    validateHyExp0023ProspectiveRecord({ record, now: now() });
    const envelope = {
      ...record,
      experimentId: HY_EXP_0023_ID,
      captureMode: HY_EXP_0023_CAPTURE_MODES.DEVELOPMENT_CAPTURE,
      outputRoot: root,
      developmentEligible: false,
      pnlComputed: false,
      authorization: 'PAPER_ONLY'
    };
    existingRecords.push(envelope);
    appendRecord(envelope);
    return envelope;
  };

  return {
    arm,
    start,
    writeRecord,
    getState: () => state,
    getGate: () => gate == null ? null : { ...gate, state },
    diagnostics: () => ({
      state,
      outputRoot: root,
      rejectedPreCaptureCount: rejectedPreCapture.length,
      rejectedPreCapture,
      recordsWritten: existingRecords.length,
      officialCaptureAuthorized: false,
      developmentAllowed: state === HY_EXP_0023_CAPTURE_MODES.DEVELOPMENT_CAPTURE,
      pnlComputed: false,
      paperOnly: true
    })
  };
}
