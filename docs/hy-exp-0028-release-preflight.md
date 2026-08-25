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
3. The branch now contains the exact GitHub Actions workflow referenced by
   `HY_EXP_0028_OIDC_WORKFLOW_REF`. It uses `id-token: write`, targets
   `refs/heads/main`, accepts only `workflow_dispatch` (there is no `schedule`
   trigger in the preflight branch), and requests the audience
   `hengyu-hy-exp-0028-production`. The workflow has not been executed and is
   not active on Production while this branch is unmerged.
4. Verify the actual Vercel project/build capability for the reviewed
   `/api/hy-exp-0028-scan` function configuration and its 120-second maximum
   duration. A plan label alone is not evidence and is not used to fail the
   check. The existing H12 route remains unchanged at 60 seconds.
5. Verify the Supabase advisory/outbox/delivery tables, RLS denial for public
   roles, service-role grants, dedupe keys, and append-only delivery history.
6. Verify main branch governance: direct pushes are blocked, PR review is
   required, required CI checks are configured, and force-push/delete are
   blocked. The current main evidence is explicitly
   `protected=false`, `protection.enabled=false`, and required checks off, so
   the report records `CONFIRMED_NOT_ENFORCED` and release remains blocked.
7. Approve a separate, reviewed state transition from
   `EMAIL_SIGNAL_RELEASE_READY` to `EMAIL_SIGNAL_RELEASED`. This transition is
   outside this preflight and requires an explicit human approval.
8. Deploy only through the separately approved release process. Do not enable
   a scheduler or send a real message as part of a fixture test. A fixture test
   must inject fake market data, ingestion, and dispatch functions and assert
   that no network or SMTP implementation is called.
9. Observe the first controlled run. Confirm dedupe, expiry, wrong strategy,
   wrong provenance, and entry capture delays over 90 seconds fail closed.
10. Record the deployment, workflow run, advisory/outbox IDs, and safety state
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

## Runtime remediation evidence

The Vercel entrypoint is the standard ESM handler in
`api/hy-exp-0028-scan.js`; the scan runner remains isolated in
`src/model/hy-exp-0028-runner.mjs`, and the legacy `.mjs` route was removed.
The local Vercel Build Output for the reviewed source commit records
`runtime=nodejs24.x`, `maxDuration=120`, handler
`api/hy-exp-0028-scan.js`, and region `sin1` in
`.vercel/output/functions/api/hy-exp-0028-scan.func/.vc-config.json`.

Preview deployment `dpl_FWVfks8W3AXF1tPKLpYYL1RbRJn6` reached `READY`; an
unauthorized `GET /api/hy-exp-0028-scan` returned HTTP 401 JSON rather than a
function invocation failure. No test credential was available, so no
authorized Preview request was attempted. The earlier 500 deployments remain
recorded as historical failures and are not treated as passing evidence. This
resolves the Preview runtime and max-duration blockers only; Production
environment presence and main-branch governance remain active blockers.

The safe `pull_request` to `main` CI path only runs tests, registry
verification, and diff checking. It does not request secrets/OIDC tokens and
does not deploy.

## Preflight evidence

The machine-readable result is
`artifacts/HY-EXP-0028/release-preflight.json`. The current `BLOCKED` result is
expected until Production-only environment presence and main-branch governance
are verified by an authorized operator. The Vercel 120-second capability is
verified by Build Output plus the successful Preview runtime smoke. The OIDC
workflow contract itself is verified on this branch but has not been executed
or activated.
