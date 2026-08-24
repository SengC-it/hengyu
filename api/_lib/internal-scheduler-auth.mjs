import { verifyGitHubActionsOidc } from './github-oidc.mjs';

const OIDC_AUDIENCE = 'hengyu-hy-exp-0028-production';
const OIDC_WORKFLOW_REF = 'SengC-it/hengyu/.github/workflows/hy-exp-0028-scan.yml@refs/heads/main';

export async function authorizeInternalScheduler(request, {
  fetchImpl = fetch,
  now = Date.now()
} = {}) {
  const authorization = request?.headers?.authorization ?? '';
  const expected = process.env.CRON_SECRET || process.env.HENGYU_CRON_SECRET || '';
  if (expected && authorization === `Bearer ${expected}`) return true;
  if (!authorization.startsWith('Bearer ')) return false;
  return verifyGitHubActionsOidc(authorization.slice('Bearer '.length), {
    fetchImpl,
    now,
    audience: OIDC_AUDIENCE,
    workflowRef: OIDC_WORKFLOW_REF
  });
}

export const HY_EXP_0028_OIDC_AUDIENCE = OIDC_AUDIENCE;
export const HY_EXP_0028_OIDC_WORKFLOW_REF = OIDC_WORKFLOW_REF;
