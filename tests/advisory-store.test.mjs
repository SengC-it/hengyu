import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendAdvisoryRecord, dashboardSnapshot } from '../src/service/advisory-store.mjs';

const signal = {
  signalId: 'HY-EXP-0014:test',
  experimentId: 'HY-EXP-0014',
  alertLevel: 'STRONG',
  symbol: 'BTCUSDT',
  side: 'BUY',
  status: 'ADVISORY',
  delivery: { dedupeKey: 'dedupe-1' },
  manualOnly: { autoExecution: false, orderPlacement: false }
};

test('advisory store is append-only and deduplicates web/email delivery', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hengyu-advisory-'));
  const signalsFile = path.join(root, 'signals.ndjson');
  const outboxFile = path.join(root, 'outbox.ndjson');
  const first = appendAdvisoryRecord({ signal, signalsFile, outboxFile, now: 10_000 });
  const second = appendAdvisoryRecord({ signal, signalsFile, outboxFile, now: 10_001 });
  assert.equal(first.signal.appended, true);
  assert.equal(first.outbox.appended, true);
  assert.match(first.outbox.entry.message.subject, /manual review only/);
  assert.doesNotMatch(first.outbox.entry.message.text, /(?:quantity|leverage)\s*:/i);
  assert.equal(second.signal.duplicate, true);
  assert.equal(second.outbox.duplicate, true);
  const dashboard = dashboardSnapshot({ signalsFile, outboxFile });
  assert.equal(dashboard.counts.signals, 1);
  assert.equal(dashboard.counts.alerts, 1);
  assert.equal(dashboard.orderPlacementEnabled, false);
});
