import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const review = JSON.parse(fs.readFileSync('artifacts/HY-EXP-0028/release-review.json', 'utf8'));
const activation = JSON.parse(fs.readFileSync('artifacts/HY-EXP-0028/release-activation.json', 'utf8'));
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

test('executable cutover is released only as a prepared, unapproved activation', () => {
  assert.equal(cutover.releaseState, 'EMAIL_SIGNAL_RELEASED');
  assert.equal(review.releaseState.before, 'EMAIL_SIGNAL_RELEASE_READY');
  assert.equal(review.releaseState.executableConfigChanged, false);
  assert.equal(cutover.status, 'CUTOVER_RELEASED');
  assert.equal(activation.schemaVersion, 1);
  assert.equal(activation.artifactType, 'CONTROLLED_EMAIL_RELEASE_ACTIVATION');
  assert.equal(activation.immutable, true);
  assert.equal(activation.executableActivationCommit, '32864d3bc9cb9c7103d24b9e7909367f56973fae');
  assert.equal(activation.activationStatus, 'PREPARED_AWAITING_HUMAN_APPROVAL');
  assert.equal(activation.humanApprovalRequired, true);
  assert.equal(activation.humanApproval, 'NOT_APPROVED');
  assert.equal(activation.releaseAllowed, false);
  assert.equal(activation.deploymentSourcePolicy, 'POST_MERGE_MAIN_SHA_ONLY');
  assert.equal(activation.directFeatureBranchDeploymentAllowed, false);
  assert.deepEqual(activation.releaseState, {
    before: 'EMAIL_SIGNAL_RELEASE_READY',
    after: 'EMAIL_SIGNAL_RELEASED'
  });
  assert.deepEqual(activation.configStatus, {
    before: 'DRAFT_CUTOVER_PREPARED',
    after: 'CUTOVER_RELEASED'
  });
  assert.equal(activation.safety.paperOnly, true);
  assert.equal(activation.safety.signalOnly, true);
  assert.equal(activation.safety.autoTrading, false);
  assert.equal(activation.delivery.gmailSendRequiredFalse, true);
  assert.equal(activation.delivery.schedulerRequiredDisabled, true);
  assert.equal(activation.delivery.realEmailAllowed, false);
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
