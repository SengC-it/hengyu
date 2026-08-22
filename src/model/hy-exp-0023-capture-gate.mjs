import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifyRegistry } from '../../scripts/registry.mjs';

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
export const HY_EXP_0023_DEFAULT_CORRECTION_PATH = path.join(
  'artifacts', HY_EXP_0023_ID, 'preregistration-resolution-correction.json'
);
export const HY_EXP_0023_ORIGINAL_RESOLUTION_SHA256 = '6c83ed256900963357570daed55dcb8df57ae40b9a1335da0959d42bfde1e4ae';
export const HY_EXP_0023_MALFORMED_PREREGISTRATION_SHA256 = '6fcd11c3c5767259b4c43e4a96ca733857f31d72f73e6f8eed0ff3e8eb61934';
export const HY_EXP_0023_PREREGISTRATION_GIT_BLOB_SHA = '27e2463752c3f061eac1a4eec039401b848a4fdb';
export const HY_EXP_0023_CORRECTION_TYPE = 'CLERICAL_TRUNCATED_SHA256_PRE_CAPTURE';
export const HY_EXP_0023_CORRECTION_STATEMENT = 'This correction repairs only the truncated SHA256 metadata recorded after the immutable preregistration commit. It does not amend experiment semantics.';

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

function sha1GitBlob(bytes) {
  const header = Buffer.from(`blob ${bytes.length}\0`);
  return createHash('sha1').update(Buffer.concat([header, bytes])).digest('hex');
}

function safeRelative(relative) {
  return relative.replaceAll(path.sep, '/');
}

function readLedger(root) {
  const ledgerPath = path.join(root, 'registry', 'ledger.jsonl');
  if (!fs.existsSync(ledgerPath)) throw captureGateError('HY_EXP_0023_GOVERNANCE_CORRECTION_INVALID', 'registry ledger is missing');
  try {
    return fs.readFileSync(ledgerPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    throw captureGateError('HY_EXP_0023_GOVERNANCE_CORRECTION_INVALID', `registry ledger is invalid: ${error.message}`);
  }
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

export function verifyHyExp0023GovernanceCorrection({
  projectRoot,
  preregistrationArtifact,
  resolutionArtifact,
  correctionPath
} = {}) {
  try {
    const originalResolutionPath = path.join(projectRoot, HY_EXP_0023_DEFAULT_RESOLUTION_PATH);
    const preregistrationPath = path.join(projectRoot, HY_EXP_0023_DEFAULT_PREREGISTRATION_PATH);
    if (path.resolve(resolutionArtifact.path) !== path.resolve(originalResolutionPath)
      || resolutionArtifact.sha256 !== HY_EXP_0023_ORIGINAL_RESOLUTION_SHA256
      || resolutionArtifact.value?.preregFileSha256 !== HY_EXP_0023_MALFORMED_PREREGISTRATION_SHA256) {
      throw new Error('original resolution bytes or malformed hash do not match the frozen seq76 payload');
    }
    const preregistrationBytes = fs.readFileSync(preregistrationPath);
    const actualPreregistrationSha256 = sha256Bytes(preregistrationBytes);
    const actualPreregistrationGitBlobSha = sha1GitBlob(preregistrationBytes);
    if (actualPreregistrationGitBlobSha !== HY_EXP_0023_PREREGISTRATION_GIT_BLOB_SHA) {
      throw new Error('preregistration bytes do not match the original Git blob');
    }
    const correctionArtifact = readJsonArtifact(
      correctionPath ?? path.join(projectRoot, HY_EXP_0023_DEFAULT_CORRECTION_PATH),
      'HY-EXP-0023 preregistration resolution correction'
    );
    const correction = correctionArtifact.value;
    const expectedPaths = {
      originalResolutionPath: safeRelative(path.relative(projectRoot, originalResolutionPath)),
      preregistrationPath: safeRelative(path.relative(projectRoot, preregistrationPath))
    };
    const exactFields = {
      schemaVersion: 1,
      artifactType: 'HY_EXP_0023_PREREGISTRATION_RESOLUTION_CORRECTION',
      experimentId: HY_EXP_0023_ID,
      correctionType: HY_EXP_0023_CORRECTION_TYPE,
      originalResolutionPath: expectedPaths.originalResolutionPath,
      originalResolutionSha256: HY_EXP_0023_ORIGINAL_RESOLUTION_SHA256,
      preregistrationPath: expectedPaths.preregistrationPath,
      preregCommit: HY_EXP_0023_PREREGISTRATION_COMMIT,
      preregGitBlobSha: HY_EXP_0023_PREREGISTRATION_GIT_BLOB_SHA,
      recordedMalformedPreregSha256: HY_EXP_0023_MALFORMED_PREREGISTRATION_SHA256,
      correctedPreregSha256: actualPreregistrationSha256,
      captureStart: HY_EXP_0023_CAPTURE_START,
      createdBeforeCaptureStart: true,
      preregistrationBytesModified: false,
      resolutionBytesModified: false,
      strategySemanticsChanged: false,
      parametersChanged: false,
      captureWindowChanged: false,
      dataSourcesChanged: false,
      readinessRulesChanged: false,
      oosWindowChanged: false,
      executionAuthorityChanged: false,
      statement: HY_EXP_0023_CORRECTION_STATEMENT
    };
    for (const [key, value] of Object.entries(exactFields)) {
      if (correction[key] !== value) throw new Error(`correction field mismatch: ${key}`);
    }
    const captureStartMs = timestamp('captureStart', HY_EXP_0023_CAPTURE_START);
    if (timestamp('correction createdAt', correction.createdAt) >= captureStartMs) {
      throw new Error('correction artifact was created at or after captureStart');
    }
    if (!/^[a-f0-9]{64}$/.test(correctionArtifact.sha256)
      || correction.correctedPreregSha256 !== actualPreregistrationSha256) {
      throw new Error('correction artifact hash or corrected preregistration hash is invalid');
    }
    const entries = readLedger(projectRoot);
    const originalResolutionEvent = entries.find(entry => entry.sequence === 76
      && entry.experiment_id === HY_EXP_0023_ID
      && entry.event_type === 'preregistered'
      && entry.payload_path === safeRelative(path.relative(projectRoot, originalResolutionPath)));
    if (!originalResolutionEvent
      || originalResolutionEvent.payload_sha256 !== HY_EXP_0023_ORIGINAL_RESOLUTION_SHA256) {
      throw new Error('seq76 original resolution event is missing or changed');
    }
    const correctionEvents = entries.filter(entry => entry.experiment_id === HY_EXP_0023_ID
      && entry.event_type === 'amended'
      && entry.payload_path === safeRelative(path.relative(projectRoot, correctionArtifact.path)));
    if (correctionEvents.length !== 1) throw new Error('exactly one amended correction event is required');
    const correctionEvent = correctionEvents[0];
    if (correctionEvent.sequence !== 77
      || correctionEvent.payload_sha256 !== correctionArtifact.sha256
      || timestamp('correction recorded_at', correctionEvent.recorded_at) >= captureStartMs) {
      throw new Error('correction ledger event is not the pre-capture seq77 append');
    }
    const priorEvents = entries.filter(entry => entry.experiment_id === HY_EXP_0023_ID
      && entry.sequence < correctionEvent.sequence);
    if (priorEvents.some(entry => ['data_locked', 'completed', 'failed'].includes(entry.event_type))) {
      throw new Error('correction was appended after a final/data-lock event');
    }
    const verifiedRegistry = verifyRegistry({ root: projectRoot });
    if (!verifiedRegistry.ok || verifiedRegistry.records < correctionEvent.sequence) {
      throw new Error('registry verification did not include the correction event');
    }
    return {
      correction,
      correctionSha256: correctionArtifact.sha256,
      correctedPreregistrationSha256: actualPreregistrationSha256,
      originalResolutionSha256: resolutionArtifact.sha256,
      originalResolutionEvent,
      correctionEvent,
      registry: verifiedRegistry
    };
  } catch (error) {
    if (error?.code === 'HY_EXP_0023_GOVERNANCE_CORRECTION_INVALID') throw error;
    throw captureGateError('HY_EXP_0023_GOVERNANCE_CORRECTION_INVALID', error.message);
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
  if (!/^[0-9a-f]{64}$/.test(preregistrationSha256)) {
    throw captureGateError('HY_EXP_0023_PREREGISTRATION_HASH_MISMATCH', 'computed preregistration SHA-256 is invalid');
  }
  const correction = verifyHyExp0023GovernanceCorrection({
    projectRoot,
    preregistrationArtifact,
    resolutionArtifact
  });
  assertHyExp0023FrozenResolution({
    resolution: resolutionArtifact.value,
    preregistrationSha256: HY_EXP_0023_MALFORMED_PREREGISTRATION_SHA256
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
    preregistrationSha256,
    correction
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
