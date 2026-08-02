import fs from 'node:fs';
import path from 'node:path';

const EMAIL_LEVELS = new Set(['STRONG', 'MEDIUM']);

function integer(name, value, { minimum = 0 } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`invalid ${name}`);
  return parsed;
}

function levelOf(signal) {
  const level = String(signal?.alertLevel ?? 'NONE').toUpperCase();
  if (!['STRONG', 'MEDIUM', 'OBSERVE', 'NONE'].includes(level)) throw new Error('invalid alert level');
  return level;
}

export function formatAdvisoryEmail(signal) {
  const level = levelOf(signal);
  const action = signal.action ?? 'NO_TRADE';
  const symbol = signal.symbol ?? 'UNKNOWN';
  const entry = signal.reference?.entryPrice ?? 'n/a';
  const stop = signal.reference?.stopPrice ?? 'n/a';
  const expiry = signal.expiresAt == null ? 'n/a' : new Date(signal.expiresAt).toISOString();
  const edge = signal.costs?.conservativeNetEdgeBps == null
    ? 'n/a'
    : `${Number(signal.costs.conservativeNetEdgeBps).toFixed(2)} bps`;
  const subject = `[Hengyu ${level}] ${action} ${symbol} · manual review only`;
  const text = [
    subject,
    '',
    `Reference entry: ${entry}`,
    `Reference stop: ${stop}`,
    `Research expiry: ${expiry}`,
    `Conservative net edge: ${edge}`,
    `Reasons: ${(signal.reasons ?? []).join(', ') || 'gate passed'}`,
    '',
    'PAPER_ONLY. This is a research advisory, not an order instruction.',
    'No account balance, quantity, leverage or private API was used.'
  ].join('\n');
  return { subject, text };
}

export function buildAlertDelivery(signal, { now = Date.now() } = {}) {
  if (!signal?.signalId) throw new Error('signalId is required');
  const level = levelOf(signal);
  const createdAt = integer('createdAt', now);
  const email = EMAIL_LEVELS.has(level)
    ? (level === 'STRONG' ? 'IMMEDIATE' : 'DIGEST_15M')
    : 'NONE';
  return {
    schemaVersion: 1,
    recordType: 'ADVISORY_ALERT_OUTBOX',
    outboxId: `${signal.signalId}:${level}`,
    dedupeKey: signal.delivery?.dedupeKey ?? `${signal.signalId}:${level}`,
    createdAt,
    signalId: signal.signalId,
    experimentId: signal.experimentId,
    symbol: signal.symbol,
    side: signal.side,
    alertLevel: level,
    web: true,
    email,
    message: formatAdvisoryEmail(signal),
    status: 'PENDING',
    manualOnly: true,
    orderPlacement: false,
    accountAccess: false
  };
}

export function appendAlertOutbox(file, entry) {
  if (!file || typeof file !== 'string') throw new Error('outbox file is required');
  if (!entry || entry.recordType !== 'ADVISORY_ALERT_OUTBOX') throw new Error('invalid outbox entry');
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true });
  let existing = [];
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8').trim();
    if (text) existing = text.split(/\r?\n/).map(line => JSON.parse(line));
  }
  if (existing.some(row => row.dedupeKey === entry.dedupeKey)) {
    return { appended: false, duplicate: true, entry };
  }
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
  return { appended: true, duplicate: false, entry };
}

export function readAlertOutbox(file, { limit = 100 } = {}) {
  const count = integer('limit', limit, { minimum: 1 });
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!text) return [];
  return text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).slice(-count).reverse();
}
