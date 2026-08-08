# Advisory API contract

The local read-only server is started with `npm.cmd run advisory:server`.

| Endpoint | Method | Meaning |
|---|---|---|
| `/api/health` | GET | Shows `SIGNAL_ONLY`, `PAPER_ONLY`, and disabled order/account flags. |
| `/api/signals?limit=100` | GET | Newest candidate and `NO_TRADE` envelopes from `data/signals.ndjson`. |
| `/api/alerts?limit=100` | GET | Email/web outbox entries with delivery status and dedupe keys. |
| `/api/dashboard?limit=100` | GET | Read-only combined dashboard snapshot. |
| `/api/review?limit=100` | GET | Only `SENT` STRONG/MEDIUM emails, reviewed against their entry/SL/TP prices. |

All non-GET requests return `405 read_only_endpoint`. The dashboard payload
contains reference prices, expiry, cost breakdown and failure reasons, but not
account balance, quantity, leverage, account risk or order parameters.

The file store is an append-only NDJSON staging layer. A hosted deployment may
replace it with `hengyu_` database tables without changing the advisory envelope
or the experiment registry.

`/api/review` is a paper review, not account PnL. It uses the email's entry,
stop-loss and take-profit prices exactly, closes at the first observed TP/SL
touch, and leaves the row `HOLDING` when neither level has been touched. The
signal's research expiry is never used as an exit. A candle that reaches both
levels is resolved with aggregate-trade order; if that evidence is unavailable,
the row remains `DATA_INSUFFICIENT` and is excluded from realized PnL.
