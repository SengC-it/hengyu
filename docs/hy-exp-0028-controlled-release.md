# HY-EXP-0028 controlled email release review

This branch is a draft-only release review. It prepares, but does not
execute, the transition from `EMAIL_SIGNAL_RELEASE_READY` to
`EMAIL_SIGNAL_RELEASED`. The executable cutover configuration remains
`EMAIL_SIGNAL_RELEASE_READY` until a human approves a later merge and a
separate controlled deployment.

## Exact proposed state transition

```text
releaseState: EMAIL_SIGNAL_RELEASE_READY -> EMAIL_SIGNAL_RELEASED
humanApprovalRequired: true
humanApproval: NOT_APPROVED
```

The proposed after-state is review evidence only. It is not loaded by the
runner, does not authorize a scan, and does not enable email delivery.

This branch contains a release proposal, not an executable activation commit:

- `reviewedPreflightCommit=73cc7ee1e83cf858301e088c5d798c8b9e69f6f6`
- `releaseProposalCommit=1119747d6ca5370eb1a120ec739b6e64326cdbf2`
- `activationCommit=null`
- `activationStatus=NOT_CREATED`

The proposal commit is evidence for this Draft PR only. There is no executable
`RELEASED` activation commit yet.

The safety envelope remains fixed in both states:

- `PAPER_ONLY=true`
- `signalOnly=true`
- `AUTO_TRADING=false`
- `liveOrdersEnabled=false`
- `accountApi=false`
- `orderApi=false`
- `automaticTrading=false`
- `HENGYU_GMAIL_SEND_ENABLED=false`
- `productionDeployed=false`
- `schedulerActivated=false`
- `realEmailSent=false`

The HY-EXP-0028 workflow remains `workflow_dispatch`-only. No `schedule`
trigger is part of this review branch. Scheduler activation requires a
separate, future controlled-release approval.

## Deployment plan (not executed)

`deploymentSourcePolicy=POST_MERGE_MAIN_SHA_ONLY` and
`directFeatureBranchDeploymentAllowed=false`. The deployment target must be a
verified post-merge `main` SHA; an uncommitted working tree, this proposal SHA,
or any other feature-branch SHA is never an allowed deployment source.

1. Merge the approved release PR.
2. Record and verify the resulting post-merge `main` SHA.
3. Deploy only that verified post-merge `main` SHA to Vercel Production.
4. Verify the Production route health and safety response.
5. Run exactly one manual `workflow_dispatch`.
6. Observe the no-op or paper-only signal result.
7. Verify advisory, outbox, and delivery evidence without enabling live order
   or account APIs.
8. Only after review of the controlled run, propose a separate PR for
   scheduler activation.

`HENGYU_GMAIL_SEND_ENABLED` is a separate human-operated step and must remain
`false` throughout this draft PR. It is never changed as a side effect of
merge or deployment.

## Rollback plan (not executed)

1. Keep the scheduler disabled and confirm no scheduled trigger is active.
2. Set `HENGYU_GMAIL_SEND_ENABLED=false` in Vercel Production.
3. Revert `EMAIL_SIGNAL_RELEASED` to `EMAIL_SIGNAL_RELEASE_READY` (or the
   disabled state) in a reviewed commit.
4. Verify the runner returns its pre-release no-op before market-data, DB, or
   SMTP access.
5. Confirm `PAPER_ONLY`, `signalOnly`, and all private/order/automatic-trading
   safety flags remain enforced.

The immutable machine-readable review record is
`artifacts/HY-EXP-0028/release-review.json`.
