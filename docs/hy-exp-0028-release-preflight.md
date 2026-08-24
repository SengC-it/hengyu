# HY-EXP-0028 controlled email release preflight

This document is an operational checklist for the `EMAIL_SIGNAL_RELEASE_READY`
state. It is not a release authorization. The preflight does not change
`config/email-signal-cutover.json`, does not enable the scheduler, and does not
send email.

## Current safety boundary

- `EMAIL_SIGNAL_RELEASED=false`
- `PRODUCTION_DEPLOYED=false`
- `SCHEDULER_ACTIVATED=false`
- `SHADOW_ACTIVATED=false`
- `AUTO_TRADING=false`
- `SIGNAL_ONLY=true` and `PAPER_ONLY=true`
- no account, balance, position, private, or order API
- no Final OOS read and no backfill

The runner must return `EMAIL_STRATEGY_NOT_RELEASED` before calling any market
data fetcher, database ingestion, outbox dispatcher, or SMTP transport while
the configuration remains `EMAIL_SIGNAL_RELEASE_READY`.

## Release checklist (not executed by this preflight)

1. Start from a clean checkout of the reviewed main commit and run `npm test`,
   `npm run registry:verify`, and `git diff --check`.
2. Verify production environment variable *presence* in the Vercel Production
   environment without printing values. Confirm Supabase service-role access,
   one configured Gmail transport, scheduler authentication, and the explicit
   PAPER_ONLY safety variables. A local `.env` is not evidence of Production
   configuration.
3. Add and review the exact GitHub Actions workflow referenced by
   `HY_EXP_0028_OIDC_WORKFLOW_REF`. It must use `id-token: write`, target
   `refs/heads/main`, accept only `schedule`/`workflow_dispatch`, and request
   the audience `hengyu-hy-exp-0028-production`.
4. Verify the Vercel route is deployed with the reviewed `/api/hy-exp-0028-scan`
   function configuration and that the Vercel plan supports its 120-second
   maximum duration. The existing H12 route remains unchanged at 60 seconds.
5. Verify the Supabase advisory/outbox/delivery tables, RLS denial for public
   roles, service-role grants, dedupe keys, and append-only delivery history.
6. Approve a separate, reviewed state transition from
   `EMAIL_SIGNAL_RELEASE_READY` to `EMAIL_SIGNAL_RELEASED`. This transition is
   outside this preflight and requires an explicit human approval.
7. Deploy only through the separately approved release process. Do not enable
   a scheduler or send a real message as part of a fixture test. A fixture test
   must inject fake market data, ingestion, and dispatch functions and assert
   that no network or SMTP implementation is called.
8. Observe the first controlled run. Confirm dedupe, expiry, wrong strategy,
   wrong provenance, and entry capture delays over 90 seconds fail closed.
9. Record the deployment, workflow run, advisory/outbox IDs, and safety state
   in an immutable operational record. Keep `EMAIL_SIGNAL_RELEASED` false until
   all prior steps are explicitly approved.

## Rollback checklist (not executed by this preflight)

1. Stop/disable the HY-EXP-0028 scheduler and confirm no new run is starting.
2. Revert the release state to `EMAIL_SIGNAL_RELEASE_READY` in a reviewed
   commit; do not alter strategy parameters or historical evidence.
3. Confirm the runner returns the pre-release no-op before market data, DB, and
   SMTP calls.
4. Review pending outbox rows and mark only explicitly rejected/expired rows
   according to the existing append-only audit policy. Never delete or rewrite
   research evidence.
5. Confirm no account/order/private API or automatic trading path was enabled.
6. If a deployment rollback is required, use the hosting platform's reviewed
   rollback operation separately from the state rollback. Do not redeploy from
   an unreviewed working tree.

## Preflight evidence

The machine-readable result is
`artifacts/HY-EXP-0028/release-preflight.json`. A `BLOCKED` result is expected
until the missing OIDC workflow, Production-only environment verification, and
Vercel plan verification are completed by an authorized operator.
