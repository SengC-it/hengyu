# H12 production signal worker

H12 is deployed in `SIGNAL_ONLY` / `PAPER_ONLY` mode. It has no exchange account access and cannot place orders.

- Schedule: minute 5 of every fourth UTC hour via GitHub Actions. The action uses a short-lived OIDC identity to trigger the Vercel `/api/h12-scan` function in Singapore (`sin1`).
- Universe: BTCUSDT, ETHUSDT, BNBUSDT, SOLUSDT, XRPUSDT and DOGEUSDT.
- Entry: short-only 120-bar 4h downside breakout while the frozen broad-bear regime is true.
- Risk reference: fixed initial two-ATR stop.
- Exit: next 4h open after a completed close exceeds the prior 60-bar high. There is no fixed take-profit.
- Delivery: signed `/api/ingest` request, Supabase advisory/outbox, then Gmail dispatch.
- Market-data transport: Binance USD-M primary REST host with the four Binance futures fallback hosts; no non-Binance substitution.
- Deduplication: experiment, symbol, side and completed signal-bar time.

The former H9 workflow remains manually dispatchable for audit but no longer has a schedule. GitHub-hosted market-data execution is not used because Binance returns HTTP 451 from the US runner region; GitHub only triggers the Singapore function.

The GitHub workflow needs no repository secret. Vercel retains `CRON_SECRET` for its daily health cron plus the existing Supabase and Gmail variables. `HENGYU_INGEST_SECRET` is needed only for an explicitly triggered external/manual worker.
