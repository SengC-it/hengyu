import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  EMAIL_SIGNAL_CUTOVER_CONFIG,
  isEmailSignalCutoverConfigValid
} from '../src/model/email-signal-cutover.mjs';
import {
  buildPreflightReport,
  inspectEnvironmentPresence,
  verifyOidcContract,
  verifySafetyState,
  verifySupabaseEvidence,
  verifyVercelCompatibility
} from '../src/model/hy-exp-0028-release-preflight.mjs';
import { runHyExp0028Scan } from '../api/hy-exp-0028-scan.mjs';

const schedulerConfig = {
  activated: false,
  applied: false,
  supabaseMigrationApplied: false,
  requiresReleaseState: 'EMAIL_SIGNAL_RELEASED'
};

const vercelConfig = {
  functions: {
    'api/h12-scan.mjs': { regions: ['sin1'], maxDuration: 60 },
    'api/hy-exp-0028-scan.mjs': { regions: ['sin1'], maxDuration: 120 }
  },
  crons: [{ path: '/api/cron-health', schedule: '0 0 * * *' }]
};

const supabaseEvidence = {
  source: 'test read-only schema snapshot',
  projectId: 'test-project',
  tables: {
    hengyu_advisories: {
      columns: ['advisory_id', 'experiment_id', 'symbol', 'advisory_type', 'status', 'signal_at', 'expires_at', 'authorization_mode', 'live_orders_enabled', 'dedupe_key'],
      rlsEnabled: true, publicBlocked: true, publicGrants: [],
      serviceRolePrivileges: ['SELECT'], appendOnly: false
    },
    hengyu_email_outbox: {
      columns: ['outbox_id', 'advisory_id', 'from_address', 'to_address', 'subject', 'body_plain', 'body_sha256', 'dedupe_key', 'status', 'attempts'],
      rlsEnabled: true, publicBlocked: true, publicGrants: [],
      serviceRolePrivileges: ['SELECT'], appendOnly: false
    },
    hengyu_email_deliveries: {
      columns: ['delivery_id', 'outbox_id', 'attempt_number', 'status', 'created_at'],
      rlsEnabled: true, publicBlocked: true, publicGrants: [],
      serviceRolePrivileges: ['SELECT'], appendOnly: true
    }
  }
};

test('environment preflight exposes presence booleans only, never values', () => {
  const inspected = inspectEnvironmentPresence({
    HENGYU_SUPABASE_URL: 'https://example.invalid',
    HENGYU_SUPABASE_SECRET_KEY: 'secret-value',
    HENGYU_GMAIL_FROM_ADDRESS: 'from@example.invalid',
    HENGYU_GMAIL_TO_ADDRESS: 'to@example.invalid',
    HENGYU_GMAIL_SEND_ENABLED: 'true',
    HENGYU_GMAIL_CLIENT_ID: 'client',
    HENGYU_GMAIL_CLIENT_SECRET: 'client-secret',
    HENGYU_GMAIL_REFRESH_TOKEN: 'refresh',
    HENGYU_CRON_SECRET: 'cron-secret'
  });
  const serialized = JSON.stringify(inspected);
  assert.equal(inspected.valuesRead, false);
  assert.equal(inspected.complete, true);
  assert.equal(serialized.includes('secret-value'), false);
  assert.equal(serialized.includes('client-secret'), false);
  assert.equal(serialized.includes('cron-secret'), false);
  assert.equal(inspected.fields.supabaseUrl.present, true);
});

test('Vercel route compatibility keeps H12 unchanged and does not activate a cron', () => {
  const result = verifyVercelCompatibility(vercelConfig, { planSupportsMaxDuration: true });
  assert.equal(result.configPass, true);
  assert.equal(result.pass, true);
  assert.equal(result.h12.unchanged, true);
  assert.equal(result.schedulerRoutePresent, false);
  assert.equal(verifyVercelCompatibility({
    ...vercelConfig,
    functions: {
      ...vercelConfig.functions,
      'api/hy-exp-0028-scan.mjs': { regions: ['sin1'], maxDuration: 60 }
    }
  }, { planSupportsMaxDuration: true }).pass, false);
});

test('OIDC contract fails closed without the referenced workflow', () => {
  const missing = verifyOidcContract();
  assert.equal(missing.pass, false);
  assert.equal(missing.workflowFileExists, false);
  assert.equal(missing.reason, 'OIDC_WORKFLOW_REF_TARGET_MISSING');
});

test('OIDC contract requires exact audience/ref and id-token workflow permissions', () => {
  const content = `
    on: [workflow_dispatch]
    permissions: { id-token: write, contents: read }
    ref: refs/heads/main
  `;
  assert.equal(verifyOidcContract({ workflowContent: content }).pass, true);
  assert.equal(verifyOidcContract({
    workflowContent: content,
    audience: 'wrong-audience'
  }).pass, false);
});

test('Supabase advisory/outbox/delivery evidence requires RLS, public denial, columns, and append-only deliveries', () => {
  const result = verifySupabaseEvidence(supabaseEvidence);
  assert.equal(result.pass, true);
  const unsafe = structuredClone(supabaseEvidence);
  unsafe.tables.hengyu_email_outbox.rlsEnabled = false;
  assert.equal(verifySupabaseEvidence(unsafe).pass, false);
  const missing = structuredClone(supabaseEvidence);
  missing.tables.hengyu_advisories.columns = [];
  assert.equal(verifySupabaseEvidence(missing).pass, false);
});

test('current release state and scheduler remain safe and inactive', () => {
  assert.equal(isEmailSignalCutoverConfigValid(), true);
  const safety = verifySafetyState({
    config: EMAIL_SIGNAL_CUTOVER_CONFIG,
    schedulerConfig
  });
  assert.equal(safety.pass, true);
  assert.equal(safety.releaseState, 'EMAIL_SIGNAL_RELEASE_READY');
  assert.equal(schedulerConfig.activated, false);
});

test('READY runner is a no-op before market data, DB, and SMTP', async () => {
  let marketCalls = 0;
  let dbCalls = 0;
  let smtpCalls = 0;
  const result = await runHyExp0028Scan({
    causalInputFetcher: async () => { marketCalls += 1; return {}; },
    ingestImpl: async () => { dbCalls += 1; },
    dispatchImpl: async () => { smtpCalls += 1; }
  });
  assert.equal(result.noOp, true);
  assert.equal(result.reason, 'EMAIL_STRATEGY_NOT_RELEASED');
  assert.equal(marketCalls, 0);
  assert.equal(dbCalls, 0);
  assert.equal(smtpCalls, 0);
});

test('released-mode fixture is injectable and does not use external SMTP', async () => {
  const fixtureConfig = {
    ...EMAIL_SIGNAL_CUTOVER_CONFIG,
    status: 'CUTOVER_RELEASED',
    releaseState: 'EMAIL_SIGNAL_RELEASED'
  };
  let smtpCalls = 0;
  const result = await runHyExp0028Scan({
    config: fixtureConfig,
    causalInputFetcher: async () => ({ candidates: [] }),
    candidateBuilder: () => ({ candidates: [], rejections: [] }),
    ingestImpl: async () => { throw new Error('fixture must not ingest'); },
    dispatchImpl: async () => { smtpCalls += 1; return []; }
  });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'NO_CANDIDATE');
  assert.equal(smtpCalls, 0);
});

test('preflight report stays blocked when production-only proofs are unavailable', () => {
  const report = buildPreflightReport({
    config: EMAIL_SIGNAL_CUTOVER_CONFIG,
    schedulerConfig,
    environment: {},
    productionEnvironmentVerified: false,
    vercelCompatibility: verifyVercelCompatibility(vercelConfig),
    oidc: verifyOidcContract(),
    supabase: verifySupabaseEvidence(supabaseEvidence),
    runnerChecks: { readyNoOp: true, fixtureNoExternalIo: true },
    failClosedChecks: {
      DEDUPE_ENFORCED: true,
      EXPIRED_SIGNAL_REJECTED: true,
      WRONG_STRATEGY_REJECTED: true,
      WRONG_PROVENANCE_REJECTED: true,
      ENTRY_DELAY_OVER_90S_REJECTED: true
    },
    safety: verifySafetyState({ config: EMAIL_SIGNAL_CUTOVER_CONFIG, schedulerConfig })
  });
  assert.equal(report.status, 'BLOCKED');
  assert.equal(report.releaseAllowed, false);
  assert.deepEqual(report.execution, {
    releaseExecuted: false,
    productionDeployed: false,
    schedulerActivated: false,
    shadowActivated: false,
    autoTrading: false,
    paperOnly: true,
    signalOnly: true,
    realEmailSent: false,
    finalOosRead: false,
    backfill: false,
    marketDataCalled: false,
    dbWriteCalled: false,
    smtpCalled: false,
    accountApiCalled: false,
    orderApiCalled: false
  });
});

test('preflight artifact is blocked and contains no PnL or release execution', () => {
  const artifact = JSON.parse(fs.readFileSync(
    new URL('../artifacts/HY-EXP-0028/release-preflight.json', import.meta.url),
    'utf8'
  ));
  assert.equal(artifact.status, 'BLOCKED');
  assert.equal(artifact.releaseAllowed, false);
  assert.equal(artifact.execution.releaseExecuted, false);
  assert.equal(artifact.execution.realEmailSent, false);
  assert.equal(artifact.execution.finalOosRead, false);
  assert.equal(Object.hasOwn(artifact, 'pnl'), false);
});
