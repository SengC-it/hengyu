# H12 production signal worker

H12 is deployed in `SIGNAL_ONLY` / `PAPER_ONLY` mode. It has no exchange account access and cannot place orders.

- Schedule: minute 5 of every fourth UTC hour via `.github/workflows/hengyu-h12.yml`.
- Universe: BTCUSDT, ETHUSDT, BNBUSDT, SOLUSDT, XRPUSDT and DOGEUSDT.
- Entry: short-only 120-bar 4h downside breakout while the frozen broad-bear regime is true.
- Risk reference: fixed initial two-ATR stop.
- Exit: next 4h open after a completed close exceeds the prior 60-bar high. There is no fixed take-profit.
- Delivery: signed `/api/ingest` request, Supabase advisory/outbox, then Gmail dispatch.
- Deduplication: experiment, symbol, side and completed signal-bar time.

The former H9 workflow remains manually dispatchable for audit but no longer has a schedule.

Required GitHub Actions secret: `HENGYU_INGEST_SECRET`. The Vercel project must use the same secret and retain its Supabase and Gmail variables.
