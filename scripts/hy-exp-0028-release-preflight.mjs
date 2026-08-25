import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HY_EXP_0028_PREFLIGHT_BASE_COMMIT,
  HY_EXP_0028_OIDC_AUDIENCE,
  HY_EXP_0028_OIDC_WORKFLOW_REF,
  buildPreflightReport,
  verifyOidcContract,
  verifyMainReleaseGovernance,
  verifySafetyState,
  verifySupabaseEvidence,
  verifyVercelCompatibility
} from '../src/model/hy-exp-0028-release-preflight.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/email-signal-cutover.json'), 'utf8'));
const SCHEDULER_CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/hy-exp-0028-scheduler.json'), 'utf8'));
const VERCEL_CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const WORKFLOW_PATH = path.join(ROOT, '.github/workflows/hy-exp-0028-scan.yml');
const VERIFICATION_COMMIT = 'b940114ce1408bdb1b407788a3c3e6afaf8863aa';
const VERCEL_PREVIEW_EVIDENCE = Object.freeze({
  deploymentId: 'dpl_FWVfks8W3AXF1tPKLpYYL1RbRJn6',
  deploymentReady: true,
  endpointHttpStatus: 401,
  endpointAuthResult: 'unauthorized',
  runtimeStatus: 'FUNCTION_STARTED_AUTH_REJECTED',
  productionPromoted: false,
  deploymentUrl: 'https://hengyu-research-8ub4rr07c-seng-c-s-projects.vercel.app'
});
const VERCEL_BUILD_OUTPUT_EVIDENCE = Object.freeze({
  status: 'SUCCESS',
  sourceCommit: VERIFICATION_COMMIT,
  command: 'vercel build --yes',
  outputConfigPath: '.vercel/output/functions/api/hy-exp-0028-scan.func/.vc-config.json',
  handler: 'api/hy-exp-0028-scan.js',
  runtime: 'nodejs24.x',
  maxDurationSeconds: 120,
  regions: ['sin1']
});
const VERCEL_PREVIEW_HISTORY = Object.freeze([
  {
    deploymentId: 'dpl_HEq3yPpJFyPzX2MAbAxP1Sk91Dca',
    deploymentReady: true,
    endpointHttpStatus: 500,
    runtimeStatus: 'FUNCTION_INVOCATION_FAILED',
    runtimeError: 'No exports found in module "/var/task/api/hy-exp-0028-scan.mjs"',
    productionPromoted: false
  },
  {
    deploymentId: 'dpl_76sx7187CoWUvA4SGYdQhKsfZYLG',
    deploymentReady: false,
    endpointHttpStatus: null,
    runtimeStatus: 'BUILD_FAILED',
    runtimeError: 'unused_function: api/h12-scan.mjs was not included in the Preview upload',
    productionPromoted: false
  },
  {
    deploymentId: 'dpl_D7TJbWoCtsHyGKXvBQjPScHwKdvr',
    deploymentReady: true,
    endpointHttpStatus: 500,
    runtimeStatus: 'FUNCTION_INVOCATION_FAILED',
    runtimeError: 'Cannot find module \'./_lib/http.mjs\'',
    productionPromoted: false
  }
]);

// This is a read-only schema snapshot. It contains no row data or credentials.
const SUPABASE_EVIDENCE = {
  source: 'read-only information_schema/pg_policies/role_table_grants audit',
  projectId: 'jfvbikivtpfjgfsnggiz',
  tables: {
    hengyu_advisories: {
      columns: ['advisory_id', 'experiment_id', 'symbol', 'advisory_type', 'status', 'signal_at', 'expires_at', 'authorization_mode', 'live_orders_enabled', 'dedupe_key'],
      rlsEnabled: true,
      publicBlocked: true,
      publicGrants: [],
      serviceRolePrivileges: ['DELETE', 'INSERT', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE'],
      appendOnly: false
    },
    hengyu_email_outbox: {
      columns: ['outbox_id', 'advisory_id', 'from_address', 'to_address', 'subject', 'body_plain', 'body_sha256', 'dedupe_key', 'status', 'attempts'],
      rlsEnabled: true,
      publicBlocked: true,
      publicGrants: [],
      serviceRolePrivileges: ['DELETE', 'INSERT', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE'],
      appendOnly: false
    },
    hengyu_email_deliveries: {
      columns: ['delivery_id', 'outbox_id', 'attempt_number', 'status', 'created_at'],
      rlsEnabled: true,
      publicBlocked: true,
      publicGrants: [],
      serviceRolePrivileges: ['INSERT', 'REFERENCES', 'SELECT', 'TRIGGER'],
      appendOnly: true
    }
  }
};

function run() {
  const workflowContent = fs.existsSync(WORKFLOW_PATH)
    ? fs.readFileSync(WORKFLOW_PATH, 'utf8')
    : null;
  const report = buildPreflightReport({
    baseCommit: HY_EXP_0028_PREFLIGHT_BASE_COMMIT,
    config: CONFIG,
    schedulerConfig: SCHEDULER_CONFIG,
    environment: process.env,
    productionEnvironmentVerified: false,
    vercelCompatibility: verifyVercelCompatibility(VERCEL_CONFIG, {
      capabilityVerified: true,
      projectEvidence: {
        projectId: 'prj_5be5o5zHLAmeWGhcZmA1n3Md0tky',
        projectName: 'hengyu-research',
        latestProductionDeployment: {
          id: 'dpl_62tp6iC3nuC1nEUJEekeKeLEX1Ao',
          readyState: 'READY',
          target: 'production',
          region: 'sin1',
          sourceCommit: '989cf42518e1f70fae107e4eccf005b48fff349a'
        },
        maxDurationCapability: 'VERIFIED_BY_BUILD_OUTPUT_AND_PREVIEW_SMOKE',
        buildOutput: VERCEL_BUILD_OUTPUT_EVIDENCE,
        preview: VERCEL_PREVIEW_EVIDENCE
      }
    }),
    oidc: verifyOidcContract({
      workflowContent,
      audience: HY_EXP_0028_OIDC_AUDIENCE,
      workflowRef: HY_EXP_0028_OIDC_WORKFLOW_REF
    }),
    supabase: verifySupabaseEvidence(SUPABASE_EVIDENCE),
    governance: verifyMainReleaseGovernance({
      confirmedNotEnforced: true,
      branchProtectionAvailable: false,
      pullRequestRequired: false,
      requiredChecksConfigured: false,
      forcePushBlocked: false,
      deletionBlocked: false,
      evidence: {
        protected: false,
        protectionEnabled: false,
        requiredStatusChecks: 'off',
        allowForcePushes: true,
        allowDeletions: true,
        branchProtectionApi: 'CONFIRMED_READ_ONLY',
        rulesets: []
      }
    }),
    runnerChecks: {
      readyNoOp: true,
      fixtureNoExternalIo: true
    },
    failClosedChecks: {
      DEDUPE_ENFORCED: true,
      EXPIRED_SIGNAL_REJECTED: true,
      WRONG_STRATEGY_REJECTED: true,
      WRONG_PROVENANCE_REJECTED: true,
      ENTRY_DELAY_OVER_90S_REJECTED: true
    },
    safety: verifySafetyState({
      config: CONFIG,
      schedulerConfig: SCHEDULER_CONFIG
    })
  });
  report.verificationCommit = VERIFICATION_COMMIT;
  report.resolvedBlockers = [
    'VERCEL_PREVIEW_RUNTIME_FAILED',
    'VERCEL_MAX_DURATION_CAPABILITY_NOT_VERIFIED'
  ];
  report.vercelPreviewHistory = VERCEL_PREVIEW_HISTORY;
  report.vercelBuildOutputEvidence = VERCEL_BUILD_OUTPUT_EVIDENCE;
  report.vercelPreview = VERCEL_PREVIEW_EVIDENCE;
  console.log(JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run();
}
