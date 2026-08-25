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
        maxDurationCapability: 'NOT_VERIFIED_BY_READ_ONLY_CONNECTOR'
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
  console.log(JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run();
}
