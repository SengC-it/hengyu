import fs from 'node:fs';
import path from 'node:path';
import {
  HY_EXP_0028_POLICY_ID,
  HY_EXP_0028_SOURCE_COMMIT,
  HY_EXP_0028_STRATEGY_ID,
  HY_VAL_0028_001_ID
} from './hy-val-0028-001.mjs';

export const HY_VAL_0028_001_STORAGE_TABLES = Object.freeze({
  activation: 'hengyu_shadow_validation_activation',
  signals: 'hengyu_shadow_signals',
  resolutions: 'hengyu_shadow_trade_resolutions',
  health: 'hengyu_shadow_health'
});

const FILES = Object.freeze({
  activation: 'activation.ndjson',
  signals: 'signals.ndjson',
  resolutions: 'trade-resolutions.ndjson',
  health: 'health.ndjson'
});

function tablePath(root, table) {
  const filename = FILES[table];
  if (!filename) throw new Error(`unknown shadow table: ${table}`);
  return path.join(root, filename);
}

function readRows(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

function assertSafety(row) {
  if (row.validationId !== HY_VAL_0028_001_ID
    || row.strategyId !== HY_EXP_0028_STRATEGY_ID
    || row.policyId !== HY_EXP_0028_POLICY_ID
    || row.sourceCommit !== HY_EXP_0028_SOURCE_COMMIT) {
    throw new Error('shadow provenance mismatch');
  }
  if (row.emailSent !== false || row.productionAdvisory !== false || row.orderPlaced !== false) {
    throw new Error('shadow record cannot enter production delivery or trading');
  }
  if (row.safety?.signal_only !== true
    || row.safety?.authorization_mode !== 'PAPER_ONLY'
    || row.safety?.live_orders_enabled !== false
    || row.safety?.account_api !== false
    || row.safety?.order_api !== false
    || row.safety?.automatic_trading !== false
    || row.safety?.final_oos_read !== false) {
    throw new Error('shadow safety envelope is invalid');
  }
}

function appendIdempotent({ root, table, row, key }) {
  fs.mkdirSync(root, { recursive: true });
  const file = tablePath(root, table);
  const rows = readRows(file);
  const existing = rows.find(item => item.idempotencyKey === key);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(row)) throw new Error('immutable shadow key conflict');
    return { inserted: false, duplicate: true, file, row: existing };
  }
  const handle = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeSync(handle, `${JSON.stringify(row)}\n`, null, 'utf8');
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  return { inserted: true, duplicate: false, file, row };
}

export function shadowStoragePaths(root) {
  return Object.fromEntries(Object.keys(FILES).map(table => [table, tablePath(root, table)]));
}

export function appendShadowActivation({ root, activationRecord }) {
  if (activationRecord?.shadowValidationActivatedAt == null) throw new Error('activation timestamp is required once activating');
  assertSafety({
    ...activationRecord,
    emailSent: false,
    productionAdvisory: false,
    orderPlaced: false,
    safety: activationRecord.safety
  });
  const row = {
    ...activationRecord,
    idempotencyKey: HY_VAL_0028_001_ID,
    immutable: true
  };
  return appendIdempotent({ root, table: 'activation', row, key: row.idempotencyKey });
}

export function appendShadowSignal({ root, signal }) {
  assertSafety(signal);
  const idempotencyKey = `${signal.validationId}:${signal.symbol}:${signal.decisionTime}`;
  return appendIdempotent({
    root,
    table: 'signals',
    row: { ...signal, idempotencyKey, immutable: true },
    key: idempotencyKey
  });
}

export function appendShadowResolution({ root, resolution, result } = {}) {
  const finalResolution = resolution ?? result;
  if (finalResolution?.status !== 'RESOLVED' || finalResolution?.paperPnlComputed !== true) {
    throw new Error('only final RESOLVED shadow evidence may be persisted');
  }
  assertSafety(finalResolution);
  const idempotencyKey = `${finalResolution.validationId}:${finalResolution.signalId}`;
  return appendIdempotent({
    root,
    table: 'resolutions',
    row: { ...finalResolution, idempotencyKey, immutable: true },
    key: idempotencyKey
  });
}

export function appendShadowHealth({ root, health }) {
  assertSafety({
    ...health,
    emailSent: false,
    productionAdvisory: false,
    orderPlaced: false,
    safety: health.safety
  });
  const idempotencyKey = `${health.validationId}:${health.observationTime}`;
  return appendIdempotent({
    root,
    table: 'health',
    row: { ...health, idempotencyKey, immutable: true },
    key: idempotencyKey
  });
}
