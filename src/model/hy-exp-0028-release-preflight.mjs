import {
  EMAIL_SIGNAL_CUTOVER_CONFIG,
  isEmailSignalCutoverConfigValid
} from './email-signal-cutover.mjs';
import {
  HY_EXP_0028_OIDC_AUDIENCE,
  HY_EXP_0028_OIDC_WORKFLOW_REF
} from '../../api/_lib/internal-scheduler-auth.mjs';

export { HY_EXP_0028_OIDC_AUDIENCE, HY_EXP_0028_OIDC_WORKFLOW_REF };

export const HY_EXP_0028_PREFLIGHT_BASE_COMMIT =
  '6e1a370d39be32303fbe1831e81b318aa544b262';
export const HY_EXP_0028_ENTRY_CAPTURE_MAX_DELAY_MS = 90_000;

export const HY_EXP_0028_REQUIRED_ENV = Object.freeze({
  supabaseUrl: ['HENGYU_SUPABASE_URL'],
  supabaseServiceRole: ['HENGYU_SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY'],
  gmailFrom: ['HENGYU_GMAIL_FROM_ADDRESS'],
  gmailTo: ['HENGYU_GMAIL_TO_ADDRESS'],
  gmailSendEnabled: ['HENGYU_GMAIL_SEND_ENABLED'],
  smtpAppPassword: ['HENGYU_GMAIL_APP_PASSWORD'],
  gmailClientId: ['HENGYU_GMAIL_CLIENT_ID'],
  gmailClientSecret: ['HENGYU_GMAIL_CLIENT_SECRET'],
  gmailRefreshToken: ['HENGYU_GMAIL_REFRESH_TOKEN'],
  schedulerAuth: ['HENGYU_CRON_SECRET', 'CRON_SECRET']
});

export const HY_EXP_0028_REQUIRED_SUPABASE_TABLES = Object.freeze({
  hengyu_advisories: Object.freeze([
    'advisory_id', 'experiment_id', 'symbol', 'advisory_type', 'status',
    'signal_at', 'expires_at', 'authorization_mode', 'live_orders_enabled',
    'dedupe_key'
  ]),
  hengyu_email_outbox: Object.freeze([
    'outbox_id', 'advisory_id', 'from_address', 'to_address', 'subject',
    'body_plain', 'body_sha256', 'dedupe_key', 'status', 'attempts'
  ]),
  hengyu_email_deliveries: Object.freeze([
    'delivery_id', 'outbox_id', 'attempt_number', 'status', 'created_at'
  ])
});

const REQUIRED_SAFETY = Object.freeze({
  signal_only: true,
  authorization_mode: 'PAPER_ONLY',
  live_orders_enabled: false,
  account_api: false,
  order_api: false,
  automatic_trading: false,
  final_oos_read: false,
  shadow_activated: false
});

function present(environment, names) {
  return names.some(name => typeof environment?.[name] === 'string'
    ? environment[name].trim().length > 0
    : environment?.[name] != null);
}

function presenceRecord(environment, names) {
  return {
    names: [...names],
    present: present(environment, names)
  };
}

/**
 * Inspect only whether configured variable names have non-empty values.
 * Values are intentionally never returned, hashed, or logged.
 */
export function inspectEnvironmentPresence(environment = {}) {
  const fields = Object.fromEntries(Object.entries(HY_EXP_0028_REQUIRED_ENV)
    .map(([field, names]) => [field, presenceRecord(environment, names)]));
  const smtpComplete = fields.gmailFrom.present
    && fields.gmailTo.present
    && fields.smtpAppPassword.present;
  const oauthComplete = fields.gmailSendEnabled.present
    && fields.gmailClientId.present
    && fields.gmailClientSecret.present
    && fields.gmailRefreshToken.present;
  const complete = fields.supabaseUrl.present
    && fields.supabaseServiceRole.present
    && fields.gmailSendEnabled.present
    && fields.schedulerAuth.present
    && (smtpComplete || oauthComplete);
  return {
    scope: 'process-env-presence-only',
    valuesRead: false,
    fields,
    transports: {
      smtp: { complete: smtpComplete },
      oauth: { complete: oauthComplete }
    },
    complete
  };
}

export function verifyVercelCompatibility(vercelConfig, {
  capabilityVerified = false,
  projectEvidence = null
} = {}) {
  const functions = vercelConfig?.functions ?? {};
  const runner = functions['api/hy-exp-0028-scan.js'];
  const legacyRunnerPresent = Object.hasOwn(functions, 'api/hy-exp-0028-scan.mjs');
  const h12 = functions['api/h12-scan.mjs'];
  const runnerConfigValid = Array.isArray(runner?.regions)
    && runner.regions.length === 1
    && runner.regions[0] === 'sin1'
    && runner.maxDuration === 120;
  const h12Unchanged = Array.isArray(h12?.regions)
    && h12.regions.length === 1
    && h12.regions[0] === 'sin1'
    && h12.maxDuration === 60;
  const runnerCron = (vercelConfig?.crons ?? [])
    .some(cron => String(cron?.path ?? '').includes('hy-exp-0028-scan'));
  return {
    configPass: runnerConfigValid && h12Unchanged && !runnerCron && !legacyRunnerPresent,
    capabilityStatus: capabilityVerified ? 'VERIFIED' : 'NOT_VERIFIED',
    capabilityVerificationPass: capabilityVerified === true,
    projectEvidence,
    runner: {
      route: '/api/hy-exp-0028-scan',
      regions: runner?.regions ?? null,
      maxDuration: runner?.maxDuration ?? null
    },
    h12: {
      regions: h12?.regions ?? null,
      maxDuration: h12?.maxDuration ?? null,
      unchanged: h12Unchanged
    },
    schedulerRoutePresent: runnerCron,
    legacyRunnerPresent,
    pass: runnerConfigValid
      && h12Unchanged
      && !runnerCron
      && !legacyRunnerPresent
      && capabilityVerified === true
  };
}

export function verifyMainReleaseGovernance(evidence = {}) {
  const branchProtectionAvailable = evidence.branchProtectionAvailable === true;
  const pullRequestRequired = evidence.pullRequestRequired === true;
  const requiredChecksConfigured = evidence.requiredChecksConfigured === true;
  const forcePushBlocked = evidence.forcePushBlocked === true;
  const deletionBlocked = evidence.deletionBlocked === true;
  const pass = branchProtectionAvailable
    && pullRequestRequired
    && requiredChecksConfigured
    && forcePushBlocked
    && deletionBlocked;
  const confirmedNotEnforced = evidence.confirmedNotEnforced === true;
  return {
    status: pass ? 'VERIFIED' : confirmedNotEnforced ? 'CONFIRMED_NOT_ENFORCED' : 'NOT_VERIFIED',
    branchProtectionAvailable,
    pullRequestRequired,
    requiredChecksConfigured,
    forcePushBlocked,
    deletionBlocked,
    pass,
    reason: pass ? null : 'MAIN_RELEASE_GOVERNANCE_NOT_ENFORCED',
    confirmedNotEnforced,
    evidence: evidence.evidence ?? null
  };
}

function hasPermission(table, permission) {
  return Array.isArray(table?.serviceRolePrivileges)
    && table.serviceRolePrivileges.includes(permission);
}

export function verifySupabaseEvidence(evidence) {
  const tableResults = Object.entries(HY_EXP_0028_REQUIRED_SUPABASE_TABLES).map(([tableName, columns]) => {
    const table = evidence?.tables?.[tableName];
    const columnSet = new Set(table?.columns ?? []);
    const missingColumns = columns.filter(column => !columnSet.has(column));
    const grantsPass = table?.publicGrants?.length === 0
      && table?.rlsEnabled === true
      && table?.publicBlocked === true
      && hasPermission(table, 'SELECT');
    return {
      table: tableName,
      exists: Boolean(table),
      rlsEnabled: table?.rlsEnabled === true,
      publicBlocked: table?.publicBlocked === true,
      missingColumns,
      serviceRolePrivileges: table?.serviceRolePrivileges ?? [],
      grantsPass,
      appendOnly: table?.appendOnly === true
    };
  });
  const deliveries = tableResults.find(row => row.table === 'hengyu_email_deliveries');
  const pass = tableResults.every(row => row.exists
    && row.rlsEnabled
    && row.publicBlocked
    && row.missingColumns.length === 0
    && row.grantsPass)
    && deliveries?.appendOnly === true;
  return {
    source: evidence?.source ?? 'unspecified',
    projectId: evidence?.projectId ?? null,
    tableResults,
    appendOnlyDeliveries: deliveries?.appendOnly === true,
    pass
  };
}

export function verifyOidcContract({
  workflowContent = null,
  audience = HY_EXP_0028_OIDC_AUDIENCE,
  workflowRef = HY_EXP_0028_OIDC_WORKFLOW_REF,
  expectedAudience = HY_EXP_0028_OIDC_AUDIENCE,
  expectedWorkflowRef = HY_EXP_0028_OIDC_WORKFLOW_REF
} = {}) {
  const content = typeof workflowContent === 'string' ? workflowContent : '';
  const workflowFileExists = content.length > 0;
  const workflowHasIdTokenPermission = /id-token\s*:\s*write/.test(content);
  const workflowHasAllowedTrigger = /workflow_dispatch/.test(content)
    || /schedule:/.test(content);
  const workflowHasMainRef = /refs\/heads\/main/.test(content)
    || /branches:\s*\[?\s*main/.test(content);
  const exactContract = audience === expectedAudience && workflowRef === expectedWorkflowRef;
  const pass = exactContract
    && workflowFileExists
    && workflowHasIdTokenPermission
    && workflowHasAllowedTrigger
    && workflowHasMainRef;
  return {
    audience,
    workflowRef,
    repository: 'SengC-it/hengyu',
    ref: 'refs/heads/main',
    workflowFileExists,
    workflowHasIdTokenPermission,
    workflowHasAllowedTrigger,
    workflowHasMainRef,
    exactContract,
    pass,
    reason: pass ? null : workflowFileExists
      ? 'OIDC_WORKFLOW_CONTRACT_INCOMPLETE'
      : 'OIDC_WORKFLOW_REF_TARGET_MISSING'
  };
}

export function verifySafetyState({
  config = EMAIL_SIGNAL_CUTOVER_CONFIG,
  schedulerConfig = {},
  productionDeployed = false,
  schedulerActivated = false,
  shadowActivated = false,
  autoTrading = false,
  finalOosRead = false,
  realEmailSent = false,
  backfill = false
} = {}) {
  const safety = config?.safety;
  const safetyPass = Object.entries(REQUIRED_SAFETY)
    .every(([key, expected]) => safety?.[key] === expected);
  const statePass = config?.releaseState === 'EMAIL_SIGNAL_RELEASE_READY'
    && config?.status === 'DRAFT_CUTOVER_PREPARED'
    && isEmailSignalCutoverConfigValid(config);
  const schedulerPass = schedulerConfig?.activated === false
    && schedulerConfig?.applied === false
    && schedulerConfig?.supabaseMigrationApplied === false
    && schedulerConfig?.requiresReleaseState === 'EMAIL_SIGNAL_RELEASED';
  const executionPass = !productionDeployed
    && !schedulerActivated
    && !shadowActivated
    && !autoTrading
    && !finalOosRead
    && !realEmailSent
    && !backfill;
  return {
    releaseState: config?.releaseState ?? null,
    statePass,
    safetyPass,
    schedulerPass,
    executionPass,
    pass: statePass && safetyPass && schedulerPass && executionPass
  };
}

export function buildPreflightReport({
  baseCommit = HY_EXP_0028_PREFLIGHT_BASE_COMMIT,
  config = EMAIL_SIGNAL_CUTOVER_CONFIG,
  schedulerConfig = {},
  environment = {},
  productionEnvironmentVerified = false,
  vercelCompatibility,
  oidc,
  supabase,
  governance,
  runnerChecks = {},
  failClosedChecks = {},
  safety
} = {}) {
  const envPresence = inspectEnvironmentPresence(environment);
  const blockers = [];
  if (!productionEnvironmentVerified) blockers.push('PRODUCTION_ENV_NOT_VERIFIED');
  if (!vercelCompatibility?.configPass) blockers.push('VERCEL_ROUTE_CONFIG_INVALID');
  if (!vercelCompatibility?.capabilityVerificationPass) blockers.push('VERCEL_MAX_DURATION_CAPABILITY_NOT_VERIFIED');
  if (!oidc?.pass) blockers.push(oidc?.reason ?? 'OIDC_CONTRACT_INVALID');
  if (!supabase?.pass) blockers.push('SUPABASE_SCHEMA_OR_PERMISSIONS_INVALID');
  if (!governance?.pass) blockers.push('MAIN_RELEASE_GOVERNANCE_NOT_ENFORCED');
  if (!safety?.pass) blockers.push('RELEASE_SAFETY_STATE_INVALID');
  if (runnerChecks.readyNoOp !== true) blockers.push('READY_RUNNER_NOOP_NOT_PROVEN');
  if (runnerChecks.fixtureNoExternalIo !== true) blockers.push('RELEASED_FIXTURE_EXTERNAL_IO_NOT_PROVEN');
  for (const [name, pass] of Object.entries(failClosedChecks)) {
    if (pass !== true) blockers.push(name);
  }
  return {
    schemaVersion: 1,
    artifactType: 'CONTROLLED_EMAIL_RELEASE_PREFLIGHT',
    baseCommit,
    status: blockers.length ? 'BLOCKED' : 'PASS',
    releaseAllowed: blockers.length === 0,
    blockers,
    productionEnvironment: {
      status: productionEnvironmentVerified ? 'VERIFIED_PRESENCE_ONLY' : 'NOT_VERIFIED',
      valuesRead: false,
      localPresence: envPresence
    },
    vercelCompatibility,
    oidc,
    supabase,
    governance,
    runner: {
      readyNoOp: runnerChecks.readyNoOp === true,
      fixture: runnerChecks.fixtureNoExternalIo === true
        ? 'TEST_ONLY_NO_EXTERNAL_IO'
        : 'NOT_PROVEN',
      failClosed: failClosedChecks
    },
    safety,
    execution: {
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
    }
  };
}
