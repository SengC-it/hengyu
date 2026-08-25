import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const review = JSON.parse(fs.readFileSync('artifacts/HY-EXP-0028/release-review.json', 'utf8'));
const cutover = JSON.parse(fs.readFileSync('config/email-signal-cutover.json', 'utf8'));
const workflow = fs.readFileSync('.github/workflows/hy-exp-0028-scan.yml', 'utf8');

test('controlled release review is immutable and human approval remains pending', () => {
  assert.equal(review.immutable, true);
  assert.equal(review.reviewedPreflightCommit, '73cc7ee1e83cf858301e088c5d798c8b9e69f6f6');
  assert.equal(review.releaseProposalCommit, '1119747d6ca5370eb1a120ec739b6e64326cdbf2');
  assert.equal(review.releaseProposalStatus, 'DRAFT_PR_ONLY');
  assert.equal(review.activationCommit, null);
  assert.equal(review.activationStatus, 'NOT_CREATED');
  assert.equal(review.deploymentSourcePolicy, 'POST_MERGE_MAIN_SHA_ONLY');
  assert.equal(review.directFeatureBranchDeploymentAllowed, false);
  assert.equal(review.humanApprovalRequired, true);
  assert.equal(review.humanApproval, 'NOT_APPROVED');
  assert.deepEqual(review.releaseState, {
    before: 'EMAIL_SIGNAL_RELEASE_READY',
    after: 'EMAIL_SIGNAL_RELEASED',
    transitionPreparedOnly: true,
    executableConfigChanged: false,
    releaseAllowed: false
  });
});

test('executable cutover remains READY and the draft cannot activate release', () => {
  assert.equal(cutover.releaseState, 'EMAIL_SIGNAL_RELEASE_READY');
  assert.equal(review.releaseState.before, 'EMAIL_SIGNAL_RELEASE_READY');
  assert.equal(review.releaseState.executableConfigChanged, false);
  assert.equal(cutover.status, 'DRAFT_CUTOVER_PREPARED');
  assert.equal(review.safety.paperOnly, true);
  assert.equal(review.safety.signalOnly, true);
  assert.equal(review.safety.autoTrading, false);
  assert.equal(review.safety.productionDeployed, false);
  assert.equal(review.safety.schedulerActivated, false);
  assert.equal(review.safety.realEmailSent, false);
  assert.equal(review.safety.gmailSendEnabled, false);
});

test('release workflow is manual-only and Gmail remains disabled', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s*schedule:/m);
  assert.equal(review.workflow.workflowDispatchOnly, true);
  assert.equal(review.workflow.schedulePresent, false);
  assert.equal(review.preflight.productionEnvironment.gmailSendEnabledPresent, true);
  assert.equal(review.preflight.productionEnvironment.gmailSendEnabledValue, false);
});

test('review evidence retains the fixed deployment and rollback controls', () => {
  assert.equal(review.preflight.ruleset.id, 21371114);
  assert.equal(review.preflight.ruleset.requiredCheck, 'Verify release preflight evidence');
  assert.equal(review.preflight.maxDuration.seconds, 120);
  assert.equal(review.preflight.preview.productionPromoted, false);
  assert.equal(review.deploymentPlan.length, 8);
  assert.equal(review.rollbackPlan[1], 'Set HENGYU_GMAIL_SEND_ENABLED=false in Vercel Production.');
  assert.equal(review.notExecuted.includes('Production deployment'), true);
  assert.equal(review.notExecuted.includes('Real email delivery'), true);
});
