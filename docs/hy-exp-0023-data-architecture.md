# HY-EXP-0023 prospective collector engineering

HY-EXP-0023 is a new paper-only experiment. It does not reopen HY-EXP-0020, consume its raw data, or inherit its results. The frozen preregistration is resolved by `artifacts/HY-EXP-0023/preregistration-resolution.json`; the official capture remains locked until a later explicit authorization.

## Immutable namespaces and windows

Engineering diagnostics write only to:

`data/raw/engineering-dry-run/HY-EXP-0023/<runId>`

The prospective roots are reserved and never written by the engineering command:

`data/raw/prospective-development/HY-EXP-0023`

`data/raw/prospective-final-oos/HY-EXP-0023`

The resolved capture start is `2026-08-23T12:00:00Z`. Development candidate eligibility cannot begin before `2026-09-22T12:00:00Z`, after 180 completed prospective 4h bars. Final OOS is `2027-03-01T00:00:00Z` through `2027-09-01T00:00:00Z` exclusive. No engineering artifact is Development- or OOS-eligible.

## Collector process

The executable diagnostic command is:

`npm run hy-exp-0023:engineering-diagnostic -- --duration-ms 300000 --max-symbols 20`

The supervisor command runs the same child in isolated engineering mode, adds a new segment id after each restart, and refuses an official-capture authorization:

`npm run hy-exp-0023:supervisor -- --duration-ms 300000 --max-symbols 20`

The collector uses Binance USD-M documented endpoints only:

- depth: `wss://fstream.binance.com/public/stream`
- kline: `wss://fstream.binance.com/market/stream`
- REST depth snapshot: `/fapi/v1/depth?limit=1000`
- exact closed-bar confirmation: `/fapi/v1/klines` with one exact `startTime`, `endTime`, and `limit=1`

Each depth connection is bounded to at most 20 dynamically selected symbols; the current 0023 profile uses batches of five to reduce event-loop receipt stalls while retaining combined streams. A depth segment is aligned per symbol. The first applied event must cover `lastUpdateId`; later events require `pu` to equal the previous `u`. A U/u/pu gap, duplicate, out-of-order update, crossed book, or invalid snapshot permanently invalidates that segment. A local receipt interval over the diagnostic limit is classified separately as `receipt_stall`: it still invalidates the segment and requires a fresh segment, but it is never reported as a source sequence gap when `pu === previous u`. Reconnects create a new segment and require a fresh REST snapshot; the invalid segment is never repaired.

The raw streams are `depth.diff`, `depth.snapshot`, `kline.4h`, `exchangeInfo`, `funding`, `universe.snapshot`, `universe.audit`, and `segment.audit`. Ticker is diagnostic-only and never substitutes for the six completed-bar quote-volume rule. `st=2` is rejected, `st=1` is accepted when present, and raw `st`/`ps` are preserved.

## Durability and monitoring

The intended host is a long-running process/container with a process supervisor, automatic restart, bounded backoff, graceful shutdown, append-only crash recovery, durable object storage, immutable per-file SHA-256 records, and an immutable manifest. Vercel serverless is not a suitable long-running L2 collector.

Required health signals are collector death, sequence gap, crossed book, snapshot-alignment failure, missing receipt timestamp, stale data, NTP failure, manifest-sealing lag, and storage pressure. The supervisor and readiness code fail closed when required alerts are absent. OS clock synchronization and Binance server-time drift are measured; timestamps are never rewritten.

Storage metrics record bytes/sec, events/sec, per-stream bytes, per-symbol rate, and projected 30-day, Development, Final-OOS, and full-experiment storage. A readiness pass requires durable storage, a retention plan, and available capacity at least equal to the projected full experiment. The local engineering dry-run filesystem is diagnostic evidence only and is not a production storage qualification; measured capacity shortfall remains a hard readiness blocker until an approved durable store is provisioned and evidenced.

## Workflow lock

Before Development PASS, Final-OOS capture may eventually be sealed using write/hash/integrity-only operations, but it cannot be queried, summarized, inspected, exported, optimized, or used for metrics. Development evaluation is allowed only after the complete Final-OOS capture is sealed; Final-OOS research reads require Development PASS. This engineering phase does not perform either operation and never computes PnL.
