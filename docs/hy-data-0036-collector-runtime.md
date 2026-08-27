# HY-DATA-0036 collector runtime

This document describes the engineering-only runtime added after the
HY-DATA-0036 contract was registered. It does not activate formal collection,
create a `collectionStartAt`, or make engineering data eligible for research.

## Runtime boundary

The command is:

```text
npm run data:hy-0036:dry-run -- --duration-ms 3600000 --max-symbols 8
```

The command requires `--dry-run`, all eight frozen symbols, and an engineering
raw root containing both `engineering` and `hy-data-0036`. It rejects roots
under prospective, development, or final-OOS paths. The default root is under
the host temporary directory. `collectionStartAt` remains `null`,
`formalCollectionActivated` remains `false`, and the report always declares
`researchEligible=false`.

The runtime has no private, account, order, API-key, Gmail, scheduler, PnL, or
strategy path. The only network calls are public Binance USD-M market data:

* `wss://fstream.binance.com/public/stream` for `bookTicker`, `depth20`, and
  `depth@100ms`;
* `wss://fstream.binance.com/market/stream` for `aggTrade`,
  `markPrice@1s`, and `forceOrder`;
* `GET https://fapi.binance.com/fapi/v1/depth?symbol=...&limit=1000` for local
  book snapshots; and
* `GET https://fapi.binance.com/fapi/v1/time` for clock evidence.

Subscriptions are lower-case, combined, and bounded. There is one public and
one market socket for the frozen universe. The runtime rotates both sockets at
23h45m or sooner, creates a new `connectionId`, seals the old raw segment, and
reconnects. A reconnect always requires a fresh public subscription and fresh
depth snapshot/alignment. Ping/pong is recorded when the runtime exposes a
`ping` method; WebSocket protocol implementations remain responsible for
their own control frames.

Before a canary is allowed, `scripts/hy-data-0036-collector.mjs` runs an
engineering preflight. It checks the shared REST governor, host NTP, local
spool capacity, configured remote storage, and a subscription handshake on
both documented WebSocket endpoints. A rate-limit ban, missing `Retry-After`,
untrusted clock, missing storage configuration, insufficient local spool, or
failed public handshake blocks the canary. The preflight report is written
with exclusive creation and contains only safe rate-limit metadata.

## Raw durability and local books

Every accepted or rejected market message is written before normalization. The
exact payload, stream, symbol, event time, receipt time, transport `st`/`ps`,
connection id, and schema metadata are retained. REST snapshots also retain
`requestStartedAt` and the `receivedAt` taken only after the response body has
completed. Raw partitions are gzip NDJSON under UTC-hour directories. A
partition is written to a unique `.part` file, flushed and fsynced, atomically
renamed, and then included in an immutable SHA-256 manifest. A second
`manifest.ndjson` append is written at seal time.

Depth updates are kept in a per-symbol bounded buffer. The first applied
update must satisfy `U <= snapshot.lastUpdateId <= u`; after alignment every
update must satisfy `pu === previous.u`. A snapshot older than the first
buffered update causes bounded refetch; a snapshot ahead of the buffered
range is retained while the bridge is awaited, with a five-second timeout.
The runtime never refetches merely because a snapshot is ahead. Quantities
are absolute and zero quantities delete levels. Stale updates are retained in
raw evidence but not applied, and the consumed per-symbol buffer is released
after alignment. Gaps, duplicates, out-of-order updates, crossed books,
disconnects, snapshot failures, storage failures, and queue limits produce
explicit invalid segments or a fail-closed run. No synthetic update,
interpolation, silent repair, or gap filling is permitted. A live sequence
failure schedules a fresh snapshot for that symbol; the prior invalid segment
is not rewritten. All depth REST requests pass through one shared governor:
429 responses honor a parsed global cooldown, 418 responses become an
`IP_RATE_LIMIT_BANNED` hard stop for REST without IP rotation, and missing
`Retry-After` is a failure.

`st=1` is the USD-M/UM transport identity. A present value other than `1` is
recorded as rejected raw evidence and never enters normalized feature state.
The aggregate-trade parser stores `q` as total quantity and `nq` as normal
quantity, without substituting `q` when `nq` is absent. Total-flow notional and
visible-book-comparable notional are separate fields. `forceOrder` is treated
as Binance's one-second liquidation snapshot stream, not a complete
tick-by-tick liquidation feed.

## Quality and storage report

The report uses time coverage rather than an event-per-second assumption:

* socket health is subscribed healthy time / scheduled time;
* aggregate-trade coverage is healthy market-socket time, reduced to zero for
  an aggregate-trade ID integrity failure;
* bookTicker coverage is healthy public-socket time;
* book validity is valid reconstructed-book time; and
* raw durability coverage is zero on raw or queue failure, otherwise one for
  the engineering run.

The thresholds are socket `>=0.99`, aggregate-trade `>=0.99`, bookTicker
`>=0.99`, valid book `>=0.98`, and raw durability `>=0.999`. Receive latency
reports p50/p95/p99 from event and local receipt timestamps. Clock evidence is
recorded from the Binance time endpoint using a request midpoint; an absolute
offset over 500 ms is `CLOCK_UNTRUSTED` and does not rewrite raw timestamps.

The sealed report includes per-symbol/per-stream counts, bytes, event and
receipt bounds, sequence/duplicate/out-of-order counts, invalid segments,
depth diagnostics, reconnects and resyncs, REST rate-limit metadata, manifest
and per-file hash verification, and projected raw storage for
24d/30d/60d/90d. Activation requires at least twice the 90-day projected raw
capacity and at least 72 hours of local spool capacity. Capacity sizing is
not eligible from a run shorter than 60 minutes; the prior 45-second run is
diagnostic only.

The causal feature builder materializes immutable 1s, 5s, and 1m rows using
only `localReceiveTime <= snapshotAt`. Its exact runtime schema includes
mid/spread, top-1/5/20 quantities and imbalances, depth within 5/10/25 bps,
micro-price, total and visible aggressive flow, signed volume, trade count,
large-trade notional, `CVD`, returns, realized volatility, spread/depth
changes, book validity, clock status, and feature coverage. Visible fields
are null when any contributing aggregate trade lacks `nq`; `q` is never used
as a substitute. Empty intervals are not synthesized or forward-filled, and
late events remain raw audit evidence without rewriting a sealed row.

Feature rows are written only to the engineering feature sink at
`<run-root>/features/`. Each interval/symbol partition is atomically sealed
and bound to a SHA-256 manifest. The sink is not Supabase and no formal
research write is performed by this runtime.

Remote persistence is provider-neutral. A caller may supply an AWS S3,
Cloudflare R2, Backblaze B2, or compatible client to the adapter. The upload
sequence is local seal, immutable object upload, remote HEAD/read hash
verification, manifest append, and local deletion only after verification.
No provider, endpoint, credential, or secret is hardcoded. Without a
configured client/bucket, the runtime reports
`STORAGE_BACKEND_NOT_CONFIGURED` and cannot become activation-ready.

## Canary result

The first real eight-symbol run is preserved in
`artifacts/HY-DATA-0036/engineering-canary.json` as
`ENGINEERING_CANARY_FAIL`. It ran from `2026-08-26T23:44:40.811Z` to
`2026-08-26T23:45:25.841Z` for `45,030` ms and stopped fail-closed after the
Binance depth endpoint returned HTTP 418 during bounded snapshot attempts.
The report's raw manifest and sealed partitions verify, with zero reported
sequence gaps, crossed books, and buffer-limit failures; this does not make
the canary ready because the 60-minute duration, depth alignment, quality,
clock, and storage gates were not met. The observed storage forecast also
reports `STORAGE_CAPACITY_BLOCKED`, and the Binance clock evidence is
`CLOCK_UNTRUSTED`. Clock trust in the new runtime is based on host NTP
(`chronyc tracking`, `timedatectl`, or `w32tm`) with a 500 ms bound; the
Binance time endpoint is a secondary public reachability/rate-limit check and
an HTTP 418 does not by itself imply a bad host clock. Controlled reconnect
was not reached before fail-closed.

`HY-DATA-0036-ACT-001` is recorded in
`artifacts/HY-DATA-0036/activation-preparation.json` only as a prepared,
blocked, unactivated record. `collectionStartAt` remains `null`; no
engineering raw data is research eligible, and no formal collection,
feature-store write, PnL, or outcome read is permitted until a later approved
run clears every gate. The current blocked preflight and its source binding are
also recorded in `artifacts/HY-DATA-0036/activation-preparation-v2.json`; it
does not create a collection boundary or unlock a canary.

## Operational deployment proposal

Formal collection is not deployed by this change. Before a separate
activation approval, run the process in a long-running Node.js container with
a supervisor such as systemd, Kubernetes, or an equivalent restart policy;
persist raw and manifest paths on durable object storage or a durable mounted
volume; and publish health/lag/storage alerts. The supervisor must restart a
crashed process without changing the registered boundary. NTP/chrony evidence
must be checked at startup and monitored during the run. Alerts must cover
socket disconnects, reconnect storms, depth invalid segments, queue/backlog
limits, raw write failures, manifest failures, clock drift, and storage below
the twice-90-day requirement.

The exact activation sequence is: review a preflight report, provision and
verify durable storage, verify supervisor and clock monitoring, run a new
60-minute-or-longer all-eight-symbol canary, approve
`HY-DATA-0036-ACT-001`, persist one UTC `collectionStartAt`, and only then
open formal connections. No engineering report, feature partition, or raw
path is promoted into the formal prospective root. If any preflight or
canary gate fails, the result remains `ENGINEERING_CANARY_FAIL` and
`activated=false`; there is no automatic retry that changes the registered
boundary.
