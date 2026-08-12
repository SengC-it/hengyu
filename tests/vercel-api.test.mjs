import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { assertPaperOnly, safetyEnvelope } from '../api/_lib/safety.mjs';
import { publicSignal } from '../api/_lib/read-model.mjs';
import { verifySignedRequest } from '../api/_lib/signature.mjs';
import { gmailFromHeader, gmailStatus } from '../api/_lib/gmail.mjs';
import { emailReferences } from '../api/_lib/review-read-model.mjs';
import { buildEmailOutboxRow } from '../api/ingest.mjs';
import testEmailHandler from '../api/test-email.mjs';
import h12ScanHandler from '../api/h12-scan.mjs';
import { verifyGitHubActionsOidc } from '../api/_lib/github-oidc.mjs';

function mockResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name] = value; },
    end(value) { this.body = value; }
  };
}

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

test('advisory bundle email row contains the same three reference prices', () => {
  const previousFrom = process.env.HENGYU_GMAIL_FROM_ADDRESS;
  const previousTo = process.env.HENGYU_GMAIL_TO_ADDRESS;
  process.env.HENGYU_GMAIL_FROM_ADDRESS = 'research@example.com';
  process.env.HENGYU_GMAIL_TO_ADDRESS = 'owner@example.com';
  const row = buildEmailOutboxRow({
    alert_level: 'MEDIUM',
    advisory_type: 'REVIEW_BUY',
    symbol: 'BTCUSDT',
    expires_at: '2026-08-02T00:15:00.000Z',
    entry_reference: 100,
    stop_reference: 98,
    exit_reference: 103,
    dedupe_key: 'test-advisory',
    metadata: { reasons: ['H9_FORCE_PRESSURE_RECOVERY'] }
  }, '00000000-0000-4000-8000-000000000001');
  assert.equal(row.from_address, 'research@example.com');
  assert.match(row.body_plain, /入场价：100/);
  assert.match(row.body_plain, /止损价：98/);
  assert.match(row.body_plain, /止盈价：103/);
  assert.match(row.body_sha256, /^[0-9a-f]{64}$/);
  if (previousFrom === undefined) delete process.env.HENGYU_GMAIL_FROM_ADDRESS;
  else process.env.HENGYU_GMAIL_FROM_ADDRESS = previousFrom;
  if (previousTo === undefined) delete process.env.HENGYU_GMAIL_TO_ADDRESS;
  else process.env.HENGYU_GMAIL_TO_ADDRESS = previousTo;
});

test('H12 email declares a dynamic Donchian exit instead of inventing a take-profit', () => {
  const previousFrom = process.env.HENGYU_GMAIL_FROM_ADDRESS;
  const previousTo = process.env.HENGYU_GMAIL_TO_ADDRESS;
  process.env.HENGYU_GMAIL_FROM_ADDRESS = 'research@example.com';
  process.env.HENGYU_GMAIL_TO_ADDRESS = 'owner@example.com';
  const row = buildEmailOutboxRow({
    alert_level: 'MEDIUM', advisory_type: 'REVIEW_SELL', symbol: 'BTCUSDT',
    expires_at: '2026-11-01T00:00:00.000Z', entry_reference: 100,
    stop_reference: 105, exit_reference: null, dedupe_key: 'h12-test',
    metadata: {
      hypothesisId: 'H12', reviewModel: 'DYNAMIC_DONCHIAN_NOT_FIXED_TP_SL',
      initialExitChannelPrice: 110, exitRule: '60-bar dynamic exit',
      reasons: ['H12_BROAD_BEAR_REGIME']
    }
  }, '00000000-0000-4000-8000-000000000012');
  assert.match(row.subject, /H12/);
  assert.match(row.body_plain, /60-bar dynamic exit/);
  assert.match(row.body_plain, /没有固定止盈价/);
  if (previousFrom === undefined) delete process.env.HENGYU_GMAIL_FROM_ADDRESS;
  else process.env.HENGYU_GMAIL_FROM_ADDRESS = previousFrom;
  if (previousTo === undefined) delete process.env.HENGYU_GMAIL_TO_ADDRESS;
  else process.env.HENGYU_GMAIL_TO_ADDRESS = previousTo;
});

test('review parser reads prices from both Chinese and historical English emails', () => {
  assert.deepEqual(emailReferences({ body_plain: '入场价：100\n止损价：98\n止盈价：103' }, {}), {
    entryPrice: 100,
    stopPrice: 98,
    takeProfitPrice: 103
  });
  assert.deepEqual(emailReferences({
    body_plain: 'Reference entry: 100\nReference stop: 98\nReference take-profit: 103'
  }, {}), {
    entryPrice: 100,
    stopPrice: 98,
    takeProfitPrice: 103
  });
});

test('Gmail SMTP App Password mode needs only the three Hengyu email variables', () => {
  const names = [
    'HENGYU_GMAIL_FROM_ADDRESS',
    'HENGYU_GMAIL_TO_ADDRESS',
    'HENGYU_GMAIL_APP_PASSWORD',
    'HENGYU_GMAIL_SEND_ENABLED',
    'HENGYU_GMAIL_CLIENT_ID',
    'HENGYU_GMAIL_CLIENT_SECRET',
    'HENGYU_GMAIL_REFRESH_TOKEN'
  ];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  process.env.HENGYU_GMAIL_FROM_ADDRESS = 'research@example.com';
  process.env.HENGYU_GMAIL_TO_ADDRESS = 'owner@example.com';
  process.env.HENGYU_GMAIL_APP_PASSWORD = 'test-app-password';
  assert.deepEqual(gmailStatus(), {
    configured: true,
    enabled: true,
    mode: 'smtp_app_password',
    fromName: 'HengYu'
  });
  for (const name of names) {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name];
  }
});

test('Gmail sender header uses HengYu as the default display name', () => {
  const previous = process.env.HENGYU_GMAIL_FROM_NAME;
  delete process.env.HENGYU_GMAIL_FROM_NAME;
  assert.equal(gmailFromHeader('zunxian.chi@example.com'), 'HengYu <zunxian.chi@example.com>');
  if (previous === undefined) delete process.env.HENGYU_GMAIL_FROM_NAME;
  else process.env.HENGYU_GMAIL_FROM_NAME = previous;
});

test('test email endpoint rejects an unsigned request without sending', async () => {
  const previous = process.env.HENGYU_INGEST_SECRET;
  process.env.HENGYU_INGEST_SECRET = 'test-secret';
  const request = {
    method: 'POST',
    headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ report: 'test' })); }
  };
  const response = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[name] = value; },
    end(value) { this.body = value; }
  };
  await testEmailHandler(request, response);
  assert.equal(response.statusCode, 401);
  assert.match(response.body, /invalid_signature|stale_signature/);
  if (previous === undefined) delete process.env.HENGYU_INGEST_SECRET;
  else process.env.HENGYU_INGEST_SECRET = previous;
});

test('H12 cron endpoint rejects an invalid bearer token before market-data access', async () => {
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'cron-test-secret';
  const response = mockResponse();
  await h12ScanHandler({ method: 'GET', headers: { authorization: 'Bearer wrong' } }, response);
  assert.equal(response.statusCode, 401);
  assert.match(response.body, /unauthorized/);
  if (previous === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = previous;
});

test('H12 accepts only a signed short-lived GitHub OIDC identity for its main workflow', async () => {
  const now = 1_800_000_000_000;
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: 'https://token.actions.githubusercontent.com', aud: 'hengyu-h12-production',
    repository: 'SengC-it/hengyu', ref: 'refs/heads/main',
    workflow_ref: 'SengC-it/hengyu/.github/workflows/hengyu-h12.yml@refs/heads/main',
    event_name: 'workflow_dispatch', iat: now / 1000 - 5, exp: now / 1000 + 300
  })).toString('base64url');
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
  const token = `${header}.${payload}.${signature}`;
  const fetchImpl = async () => ({
    ok: true,
    async json() { return { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'test-key' }] }; }
  });
  assert.equal(await verifyGitHubActionsOidc(token, { fetchImpl, now }), true);
  assert.equal(await verifyGitHubActionsOidc(`${token}x`, { fetchImpl, now }), false);
});
