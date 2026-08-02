import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { assertPaperOnly, safetyEnvelope } from '../api/_lib/safety.mjs';
import { publicSignal } from '../api/_lib/read-model.mjs';
import { verifySignedRequest } from '../api/_lib/signature.mjs';

test('Vercel safety envelope stays paper-only and exposes no account controls', () => {
  const envelope = safetyEnvelope();
  assert.equal(envelope.authorization, 'PAPER_ONLY');
  assert.equal(envelope.liveOrdersEnabled, false);
  assert.equal(envelope.orderPlacementEnabled, false);
  assert.equal(envelope.accountAccess, false);
  assert.throws(() => assertPaperOnly({ leverage: 3 }), /forbidden_field/);
  assert.throws(() => assertPaperOnly({ live_orders_enabled: true }), /live_orders_disabled/);
});

test('public signal projection omits quantity, leverage, order and account fields', () => {
  const signal = publicSignal({
    advisory_id: 'a', experiment_id: 'HY-EXP-0014', symbol: 'BTCUSDT',
    advisory_type: 'REVIEW_BUY', alert_level: 'STRONG', signal_at: '2026-08-02T00:00:00Z',
    expires_at: '2026-08-02T00:15:00Z', entry_reference: '100', stop_reference: '99',
    exit_reference: '101', conservative_net_edge_bps: '7', status: 'ACTIVE', pnl_eligible: false,
    fee_bps: '10', slippage_bps: '2', impact_bps: '1', latency_buffer_bps: '1', uncertainty_bps: '2'
  });
  const text = JSON.stringify(signal).toLowerCase();
  assert.match(text, /manualonly/);
  assert.doesNotMatch(text, /quantity|leverage|notional|orderplacement|accountaccess/);
});

test('signed collector request verifies the exact body and timestamp', () => {
  const previous = process.env.HENGYU_INGEST_SECRET;
  process.env.HENGYU_INGEST_SECRET = 'test-secret';
  const body = JSON.stringify({ kind: 'heartbeat', record: { service_name: 'test' } });
  const timestamp = String(Date.now());
  const signature = crypto.createHmac('sha256', 'test-secret').update(`${timestamp}.${body}`).digest('hex');
  const result = verifySignedRequest({ headers: {
    'x-hengyu-timestamp': timestamp,
    'x-hengyu-signature': signature
  } }, body);
  assert.deepEqual(result, { ok: true });
  if (previous === undefined) delete process.env.HENGYU_INGEST_SECRET;
  else process.env.HENGYU_INGEST_SECRET = previous;
});
