# Advisory API contract

The local read-only server is started with `npm.cmd run advisory:server`.

| Endpoint | Method | Meaning |
|---|---|---|
| `/api/health` | GET | Shows `SIGNAL_ONLY`, `PAPER_ONLY`, and disabled order/account flags. |
| `/api/signals?limit=100` | GET | Newest candidate and `NO_TRADE` envelopes from `data/signals.ndjson`. |
| `/api/alerts?limit=100` | GET | Email/web outbox entries with delivery status and dedupe keys. |
| `/api/dashboard?limit=100` | GET | Read-only combined dashboard snapshot. |

All non-GET requests return `405 read_only_endpoint`. The dashboard payload
contains reference prices, expiry, cost breakdown and failure reasons, but not
account balance, quantity, leverage, account risk or order parameters.

The file store is an append-only NDJSON staging layer. A hosted deployment may
replace it with `hengyu_` database tables without changing the advisory envelope
or the experiment registry.

