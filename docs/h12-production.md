# H12 production signal worker

H12 is deployed in `SIGNAL_ONLY` / `PAPER_ONLY` mode. It has no exchange account access and cannot place orders.

- Schedule: minute 5 of every fourth UTC hour via GitHub Actions. The action uses a short-lived OIDC identity to trigger the Vercel `/api/h12-scan` function in Singapore (`sin1`).
- Universe: BTCUSDT, ETHUSDT, BNBUSDT, SOLUSDT, XRPUSDT and DOGEUSDT.
- Entry: short-only 120-bar 4h downside breakout while the frozen broad-bear regime is true.
- Entry price: the 4h K-line open is diagnostic only. The candidate is priced from decision-time Binance USD-M bid/ask/depth and records the executable VWAP plus the top-of-book quote.
- Risk reference: fixed initial two-ATR stop and a maximum paper holding period.
- Exit: stateful next-4h-close channel/stop logic with a maximum hold. There is no fixed take-profit, so the generic fixed TP/SL review is invalid for H12.
- Decision path: `Candidate -> HENGYU-NET-EDGE-001 -> paper Portfolio Risk Gate -> manual Advisory`. Fees, spread/depth cost, slippage, impact, latency, funding and forecast uncertainty are included before an advisory is emitted.
- Timing: every scan records `schedulerDelay`, `decisionTime`, `theoreticalOpen`, `executablePrice`; a delayed breakout is `MISSED_SIGNAL` and is not emailed as tradeable.
- Diagnostics: every H12 scan is append-only in `hengyu_scan_diagnostics`, including regime, breadth, per-symbol breakout distance and rejection reasons. The dashboard exposes the latest “why no signal” panel.
- Delivery: signed `/api/ingest` request, Supabase advisory/outbox, then Gmail dispatch.
- Market-data transport: Binance USD-M primary REST host with the four Binance futures fallback hosts; no non-Binance substitution.
- Deduplication: experiment, symbol, side and completed signal-bar time.

`HY-EXP-0018` remains `pass=false`; a live/paper advisory must never be presented as a validated profitable historical strategy.

Before deployment, apply the candidate-engine migration `supabase/migrations/20260820150000_candidate_engine_diagnostics.sql`, then verify `/api/health`, `/api/dashboard`, one dry-run scan, one signed paper-only ingest, and the email outbox lease/retry status. Do not add exchange credentials, account scopes, order routes or order payloads.

The former H9 workflow remains manually dispatchable for audit but no longer has a schedule. GitHub-hosted market-data execution is not used because Binance returns HTTP 451 from the US runner region; GitHub only triggers the Singapore function.

The GitHub workflow needs no repository secret. Vercel retains `CRON_SECRET` for its daily health cron plus the existing Supabase and Gmail variables. `HENGYU_INGEST_SECRET` is needed only for an explicitly triggered external/manual worker.
