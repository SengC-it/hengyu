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
  verifyMainReleaseGovernance,
  verifyOidcContract,
  verifySafetyState,
  verifySupabaseEvidence,
  verifyVercelCompatibility
} from '../src/model/hy-exp-0028-release-preflight.mjs';
import { runHyExp0028Scan } from '../src/model/hy-exp-0028-runner.mjs';

const schedulerConfig = {
  activated: false,
  applied: false,
  supabaseMigrationApplied: false,
  requiresReleaseState: 'EMAIL_SIGNAL_RELEASED'
};

const vercelConfig = {
  functions: {
    'api/h12-scan.mjs': { regions: ['sin1'], maxDuration: 60 },
    'api/hy-exp-0028-scan.js': { regions: ['sin1'], maxDuration: 120 }
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

const githubRulesetEvidence = {
  source: 'github-api-ruleset',
  apiRead: true,
  apiUrl: 'https://api.github.com/repos/SengC-it/hengyu/rulesets/21371114',
  rulesetId: 21371114,
  rulesetName: 'HY-EXP-0028 Main Release Governance',
  enforcement: 'active',
  target: 'branch',
  includedDefaultBranch: '~DEFAULT_BRANCH',
  requiredRules: ['deletion', 'non_fast_forward', 'pull_request', 'required_status_checks'],
  requiredStatusChecks: ['Verify release preflight evidence'],
  bypassActors: [],
  currentUserCanBypass: 'never'
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
  const result = verifyVercelCompatibility(vercelConfig, { capabilityVerified: true });
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
  }, { capabilityVerified: true }).pass, false);
});

test('Vercel project evidence does not infer maxDuration capability from a plan name', () => {
  const result = verifyVercelCompatibility(vercelConfig, {
    projectEvidence: {
      projectId: 'prj_test',
      latestProductionDeployment: { readyState: 'READY', target: 'production' }
    }
  });
  assert.equal(result.configPass, true);
  assert.equal(result.capabilityStatus, 'NOT_VERIFIED');
  assert.equal(result.pass, false);
  assert.deepEqual(result.projectEvidence.latestProductionDeployment, {
    readyState: 'READY',
    target: 'production'
  });
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

test('committed HY-EXP-0028 workflow has only workflow_dispatch OIDC trigger', () => {
  const workflow = fs.readFileSync(
    new URL('../.github/workflows/hy-exp-0028-scan.yml', import.meta.url),
    'utf8'
  );
  assert.equal(verifyOidcContract({ workflowContent: workflow }).pass, true);
  assert.match(workflow, /id-token:\s*write/);
  assert.match(workflow, /audience=hengyu-hy-exp-0028-production/);
  assert.match(workflow, /refs\/heads\/main/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /http_code="\$\(curl --show-error --silent/);
  assert.doesNotMatch(workflow, /http_code="\$\(curl --fail/);
  assert.match(workflow, /error: response\.error/);
  assert.match(workflow, /stage: response\.stage/);
  assert.doesNotMatch(workflow, /^\s*schedule:/m);
  assert.doesNotMatch(workflow, /^\s*push:/m);
  assert.doesNotMatch(workflow, /^\s*pull_request:/m);
  for (const field of [
    'marketDataFetched', 'candidates', 'advisories', 'outbox',
    'smtpDispatched', 'emailDeliveryEnabled', 'emailDeliverySuppressed'
  ]) {
    assert.match(workflow, new RegExp(`${field}: response\\.${field}`));
  }
  assert.doesNotMatch(workflow, /order|account|private/i);
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

test('main release governance records confirmed disabled protection and fails closed', () => {
  const result = verifyMainReleaseGovernance({
    confirmedNotEnforced: true,
    branchProtectionAvailable: false,
    pullRequestRequired: false,
    requiredChecksConfigured: false,
    forcePushBlocked: false,
    deletionBlocked: false,
    evidence: { branchProtectionApi: 'FORBIDDEN', rulesets: [] }
  });
  assert.equal(result.pass, false);
  assert.equal(result.status, 'CONFIRMED_NOT_ENFORCED');
  assert.equal(result.confirmedNotEnforced, true);
  assert.equal(result.reason, 'MAIN_RELEASE_GOVERNANCE_NOT_ENFORCED');
});

test('main release governance requires PR, required checks, and force/delete protections', () => {
  const result = verifyMainReleaseGovernance({
    branchProtectionAvailable: true,
    pullRequestRequired: true,
    requiredChecksConfigured: true,
    forcePushBlocked: true,
    deletionBlocked: true,
    evidence: githubRulesetEvidence
  });
  assert.equal(result.pass, true);
  assert.equal(result.status, 'VERIFIED');
  assert.equal(result.apiEvidencePass, true);
  assert.deepEqual(result.evidence.requiredStatusChecks, ['Verify release preflight evidence']);
});

test('main governance fails closed without independently read GitHub ruleset evidence', () => {
  const result = verifyMainReleaseGovernance({
    branchProtectionAvailable: true,
    pullRequestRequired: true,
    requiredChecksConfigured: true,
    forcePushBlocked: true,
    deletionBlocked: true
  });
  assert.equal(result.pass, false);
  assert.equal(result.status, 'NOT_VERIFIED');
  assert.equal(result.apiEvidencePass, false);
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
    productionEnvironmentEvidence: {
      source: 'test-vercel-production-env-list',
      valuesRead: false,
      complete: false,
      presence: {
        HENGYU_SUPABASE_URL: true,
        HENGYU_GMAIL_SEND_ENABLED: false
      },
      missingRequired: ['HENGYU_GMAIL_SEND_ENABLED']
    },
    vercelCompatibility: verifyVercelCompatibility(vercelConfig),
    oidc: verifyOidcContract(),
    supabase: verifySupabaseEvidence(supabaseEvidence),
    governance: verifyMainReleaseGovernance(),
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
  assert.equal(report.productionEnvironment.status, 'INCOMPLETE_REQUIRED_PRESENCE');
  assert.equal(report.productionEnvironment.presenceEvidence.presence.HENGYU_GMAIL_SEND_ENABLED, false);
  assert.ok(report.blockers.includes('MAIN_RELEASE_GOVERNANCE_NOT_ENFORCED'));
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

test('preflight artifact is ready for review but never release-authorized', () => {
  const artifact = JSON.parse(fs.readFileSync(
    new URL('../artifacts/HY-EXP-0028/release-preflight.json', import.meta.url),
    'utf8'
  ));
  assert.equal(artifact.status, 'READY_FOR_RELEASE_REVIEW');
  assert.equal(artifact.releaseAllowed, false);
  assert.equal(artifact.execution.releaseExecuted, false);
  assert.equal(artifact.execution.realEmailSent, false);
  assert.equal(artifact.execution.finalOosRead, false);
  assert.equal(artifact.governance.status, 'VERIFIED');
  assert.equal(artifact.governance.pass, true);
  assert.equal(artifact.governance.evidence.rulesetId, 21371114);
  assert.deepEqual(artifact.blockers, []);
  assert.equal(artifact.productionEnvironment.status, 'VERIFIED_PRESENCE_ONLY');
  assert.equal(artifact.productionEnvironment.presence.HENGYU_GMAIL_SEND_ENABLED, true);
  assert.deepEqual(artifact.productionEnvironment.missingRequired, []);
  assert.equal(artifact.vercelCompatibility.capabilityStatus, 'VERIFIED');
  assert.equal(artifact.vercelCompatibility.capabilityVerificationPass, true);
  assert.equal(artifact.vercelBuildOutputEvidence.maxDurationSeconds, 120);
  assert.equal(artifact.vercelBuildOutputEvidence.handler, 'api/hy-exp-0028-scan.js');
  assert.equal(artifact.vercelPreview.deploymentId, 'dpl_FWVfks8W3AXF1tPKLpYYL1RbRJn6');
  assert.equal(artifact.vercelPreview.endpointHttpStatus, 401);
  assert.equal(artifact.vercelPreviewHistory[0].runtimeStatus, 'FUNCTION_INVOCATION_FAILED');
  assert.equal(Object.hasOwn(artifact, 'pnl'), false);
});
