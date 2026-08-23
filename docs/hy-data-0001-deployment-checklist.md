# HY-DATA-0001 deployment checklist

This is a review checklist only. The implementation commit does not deploy or
enable the collector.

1. Review Commit A and Commit B and confirm the branch is still
   `agent/hy-data-0001`.
2. Apply `20260823140000_hy_data_0001_prospective.sql` manually to the existing
   Hengyu Supabase project. Confirm the three `hengyu_hy_data_0001_*` tables,
   RLS, deny policies, service-role-only grants, checks, and append-only
   triggers.
3. Set `HENGYU_HY_DATA_0001_INGEST_SECRET` in Vercel and GitHub Actions. Keep
   it out of the repository and logs. Confirm Vercel supplies
   `VERCEL_GIT_COMMIT_SHA`, or explicitly set `HY_DATA_0001_SOURCE_COMMIT` to
   the deployed collector commit; the collector must refuse to start without
   one. Set `HENGYU_API_BASE_URL` to the reviewed existing Singapore
   deployment.
4. Choose and record `HENGYU_HY_DATA_0001_ACTIVATED_AT` before the first
   accepted run, or explicitly approve the first-request boundary. It must not
   be a historical backfill timestamp.
5. Deploy the API only to the existing Vercel Singapore project after review;
   do not use a production promotion command as part of this task.
6. Verify the endpoint is POST-only, public Binance market-data-only, and has
   no order/account/private API or Gmail dispatch path.
7. Run one manually observed collector cycle. Confirm 8 symbol attempts,
   source receipt timestamps after body completion, no pre-activation rows, and
   a health row.
8. Confirm duplicate retries do not create a second row for the same
   `symbol:observationAt` key and that invalid rows remain flagged rather than
   being repaired.
9. Enable `.github/workflows/hy-data-0001-collector.yml` on the five-minute
   schedule only after steps 1-8 pass. Monitor expected 2,304 rows per UTC day,
   missing intervals, stale count, delay, and last success.
10. Keep HY-SCREEN-0002 unexecuted. No model, PnL, advisory, signal email,
    Final OOS read, or live trading is allowed by this dataset.
