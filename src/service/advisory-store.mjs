import fs from 'node:fs';
import path from 'node:path';
import { buildAlertDelivery } from '../model/alert-outbox.mjs';

function ensureFile(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, '', { flag: 'wx' });
}

function readRows(file) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8').trim();
  return text ? text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : [];
}

function appendRow(file, row) {
  ensureFile(file);
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
}

export function appendAdvisoryRecord({ signal, signalsFile, outboxFile, now = Date.now() }) {
  if (!signal?.signalId) throw new Error('signal is missing signalId');
  if (signal.manualOnly?.autoExecution !== false || signal.manualOnly?.orderPlacement !== false) {
    throw new Error('advisory is not manual-only');
  }
  const existing = readRows(signalsFile);
  const duplicate = existing.find(row => row.signalId === signal.signalId);
  const signalResult = duplicate
    ? { appended: false, duplicate: true, signal }
    : (appendRow(signalsFile, signal), { appended: true, duplicate: false, signal });
  const delivery = buildAlertDelivery(signal, { now });
  const outboxRows = readRows(outboxFile);
  const outboxDuplicate = outboxRows.some(row => row.dedupeKey === delivery.dedupeKey);
  if (!outboxDuplicate) appendRow(outboxFile, delivery);
  return {
    signal: signalResult,
    outbox: { appended: !outboxDuplicate, duplicate: outboxDuplicate, entry: delivery }
  };
}

export function readAdvisories(file, { limit = 100 } = {}) {
  const rows = readRows(file);
  return rows.slice(-Math.max(1, Number(limit))).reverse();
}

export function readDeliveries(file, { limit = 100 } = {}) {
  const rows = readRows(file);
  return rows.slice(-Math.max(1, Number(limit))).reverse();
}

export function dashboardSnapshot({ signalsFile, outboxFile, limit = 100 } = {}) {
  const signals = readAdvisories(signalsFile, { limit });
  const alerts = readDeliveries(outboxFile, { limit });
  return {
    schemaVersion: 1,
    mode: 'SIGNAL_ONLY',
    authorization: 'PAPER_ONLY',
    liveOrdersEnabled: false,
    orderPlacementEnabled: false,
    humanConfirmationRequired: true,
    accountAccess: false,
    signals,
    alerts,
    counts: {
      signals: signals.length,
      alerts: alerts.length,
      strong: signals.filter(row => row.alertLevel === 'STRONG').length,
      medium: signals.filter(row => row.alertLevel === 'MEDIUM').length,
      observe: signals.filter(row => row.alertLevel === 'OBSERVE').length,
      noTrade: signals.filter(row => row.status === 'NO_TRADE').length
    }
  };
}

