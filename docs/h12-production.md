# H12 production signal worker

H12 is deployed in `SIGNAL_ONLY` / `PAPER_ONLY` mode. It has no exchange account access and cannot place orders.

- Schedule: a GitHub Actions poll every five minutes, with three 30-second request retries. The poll is intentionally offset from the 4h boundary and records `schedulerSource` plus `schedulerAttempt`; its target is one successful scan in the first 15 minutes after each boundary. The action uses a short-lived OIDC identity to trigger the Vercel `/api/h12-scan` function in Singapore (`sin1`).
- Universe: BTCUSDT, ETHUSDT, BNBUSDT, SOLUSDT, XRPUSDT and DOGEUSDT.
- Entry: short-only 120-bar 4h downside breakout while the frozen broad-bear regime is true.
- Entry price: the 4h K-line open is diagnostic only. The candidate is priced from decision-time Binance USD-M bid/ask/depth and records the executable VWAP plus the top-of-book quote.
- Risk reference: fixed initial two-ATR stop. `researchExpiryMs` expires the research advisory only; it is not a position holding period.
- Exit: stateful next-4h-close dynamic Donchian channel/stop logic. HY-EXP-0018 has no forced 24h exit and no fixed take-profit, so the generic fixed TP/SL review is invalid for H12. Any future maximum-hold experiment must use a new experiment ID.
- Decision path: `Candidate -> HENGYU-NET-EDGE-001 -> paper Portfolio Risk Gate -> manual Advisory`. Fees, spread/depth cost, slippage, impact, latency, funding and forecast uncertainty are included before an advisory is emitted.
- Timing: `scanStartedAt` is captured before market-data requests; `decisionTime` is captured only after every K-line, depth and funding request completes. Every scan records `schedulerDelay`, `decisionTime`, `theoreticalOpen`, `executablePrice`, and book receive time; a delayed breakout is `MISSED_SIGNAL` and is not emailed as tradeable.
- Edge provenance: H12 produces a Candidate with no price-edge estimate. `HENGYU-NET-EDGE-001` still calculates real execution/funding costs for diagnostics, but an independently verified `edgeSource`/`edgeModelId` is required before any future H12 advisory can become tradeable.
- Diagnostics: every H12 scan is append-only in `hengyu_scan_diagnostics`, including regime, breadth, per-symbol breakout distance and rejection reasons. The dashboard exposes the latest “why no signal” panel.
- Delivery: signed `/api/ingest` request, Supabase advisory/outbox, then Gmail dispatch.
- Market-data transport: Binance USD-M primary REST host with the four Binance futures fallback hosts; no non-Binance substitution.
- Deduplication: scan diagnostics use experiment, completed signal-bar time, scheduler source and attempt; advisory deduplication uses experiment, symbol, side and completed signal-bar time.

`HY-EXP-0018` remains `pass=false`; a live/paper advisory must never be presented as a validated profitable historical strategy.

Before deployment, apply migrations `supabase/migrations/20260820150000_candidate_engine_diagnostics.sql` and `supabase/migrations/20260821100000_h12_timing_edge_scheduler.sql`, then verify `/api/health`, `/api/dashboard`, one dry-run scan, one signed paper-only ingest, and the email outbox lease/retry status. Do not add exchange credentials, account scopes, order routes or order payloads.

The former H9 workflow remains manually dispatchable for audit but no longer has a schedule. GitHub-hosted market-data execution is not used because Binance returns HTTP 451 from the US runner region; GitHub only triggers the Singapore function.

The GitHub workflow needs no repository secret. Vercel retains `CRON_SECRET` for its daily health cron plus the existing Supabase and Gmail variables. `HENGYU_INGEST_SECRET` is needed only for an explicitly triggered external/manual worker.
