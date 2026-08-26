# HY-DATA-0036 forward microstructure dataset

This document is the frozen preparation contract for a prospective, public-market-data-only dataset. It is not a profitability result, a strategy, an outcome dataset, or a release authorization. The five feature families are reserved with status `FEATURE_FAMILY_RESERVED_ONLY`; no threshold, label, PnL, email, or trading decision is defined here.

## Boundary and fixed universe

The collector must persist one `collectionStartAt` UTC millisecond timestamp before opening its first connection. It must reject every event whose exchange event time or local receive time is earlier than that boundary. The timestamp is immutable for the run. There is no historical backfill, third-party recovery, interpolation, forward-fill, synthetic event, or outcome read. An engineering dry run is stored under a separate root and can never become Development evidence.

The fixed universe is:

`BTCUSDT`, `ETHUSDT`, `BNBUSDT`, `SOLUSDT`, `XRPUSDT`, `DOGEUSDT`, `LINKUSDT`, `LTCUSDT`.

Symbols are fixed before collection and cannot be added or removed based on market movement or later outcomes.

## Collector architecture and public streams

Use one persistent Node.js process in a long-running container with bounded combined WebSocket batches and a process supervisor. The collector records connection health, reconnects, rotates sealed partitions, and exits into an explicit failure state when storage or clock checks fail. It is not a Vercel serverless function and is not a GitHub Actions job.

The only planned public streams are:

| Data | Subscription | Binance route | Role |
| --- | --- | --- | --- |
| Aggregate trades | `<symbol>@aggTrade` | `wss://fstream.binance.com/market/stream` | trade direction, notional and flow |
| Best bid/ask | `<symbol>@bookTicker` | `wss://fstream.binance.com/public/stream` | executable top-of-book state |
| 20-level book | `<symbol>@depth20@100ms` | `wss://fstream.binance.com/public/stream` | small raw depth observation |
| Diff depth | `<symbol>@depth@100ms` | `wss://fstream.binance.com/public/stream` | sequence-correct local book |
| Depth snapshot | REST `/fapi/v1/depth?symbol=...&limit=1000` | `https://fapi.binance.com` | local-book initialization/resync only |

No API key is needed. User streams, account, order, private, and trading endpoints are not in the collector contract.

## Raw record and immutable storage

Every received message is appended as an exact raw record with:

```text
source, stream, symbol, exchangeEventTime, tradeTime,
localReceiveTime, sequence, rawPayload, schemaVersion
```

`localReceiveTime` is taken only after the complete WebSocket message or REST response body is received. Raw partitions are compressed JSONL or Parquet by UTC hour/day. A sealed partition cannot be edited or deleted by the collector. The immutable manifest stores each relative path, SHA-256, row count, symbol, stream, coverage, schema version, source, and manifest hash.

The proposed data layout is:

```text
object storage/raw/hy-data-0036/YYYY-MM-DD/HH/*.jsonl.zst
Supabase/Postgres private research_hy_data_0036.features_1s
Supabase/Postgres private research_hy_data_0036.features_5s
Supabase/Postgres private research_hy_data_0036.features_1m
object storage/manifests/HY-DATA-0036/YYYY-MM-DD.json
```

The feature tables are a storage proposal only; this phase creates no Supabase migration and writes no rows. Before activation, provision private schema/table privileges and verify that the public Data API does not expose the tables. This is consistent with the current Supabase platform behavior that newly created public tables are not automatically exposed by default; the deployment must still explicitly verify the intended private grants.

## Local-book sequence and resynchronization

For each symbol, retain raw diff events and maintain independent book state. A REST snapshot records `snapshotLastUpdateId`. The first applicable diff must satisfy:

```text
U <= snapshotLastUpdateId <= u
```

Updates with `u < snapshotLastUpdateId` are retained as raw evidence but are stale and are not applied. Once aligned, every update must satisfy `pu == previousFinalUpdateId`, have an increasing final id, and not skip an update range. The collector records `snapshotLastUpdateId`, `firstUpdateId`, `finalUpdateId`, and `previousFinalUpdateId` for each segment.

Any gap, duplicate, out-of-order update, snapshot mismatch, disconnect, or crossed reconstructed book marks the segment invalid, records the reason, suppresses every depth-derived feature, and starts a fresh snapshot/resync segment. There is no silent repair or gap filling. A reconnect always creates a new segment; the old invalid segment stays in the manifest and audit log.

## Feature snapshots and causal large-trade rule

At 1s, 5s, and 1m boundaries, derive only from raw events already received at or before the snapshot time. The fixed feature fields are:

```text
midPrice, spreadBps,
bidQtyTop1, askQtyTop1, bookImbalanceTop1,
bidQtyTop5, askQtyTop5, bookImbalanceTop5,
bidQtyTop20, askQtyTop20, bookImbalanceTop20,
depthWithin5Bps, depthWithin10Bps, depthWithin25Bps,
microPrice,
aggressiveBuyNotional, aggressiveSellNotional, tradeImbalance,
tradeCount, largeTradeBuyNotional, largeTradeSellNotional,
signedVolume, cumulativeVolumeDelta, orderFlowImbalance,
midReturn1s, midReturn5s, midReturn30s, realizedVol30s,
spreadChange, depthChange
```

The aggregate-trade maker flag is preserved and maps `m=true` to an inferred aggressive sell and `m=false` to an inferred aggressive buy. This is an aggressor-side inference, not a claim of complete order-flow visibility.

The large-trade threshold is recalculated per symbol from the empirical 95th percentile of quote notional in the immediately prior 24 hours. A complete causal warmup is required. Until it exists, the threshold and large-trade fields are null. Events at or after the snapshot time are rejected from the threshold calculation.

When the book is invalid, `bookStateValid=false` and all depth-derived fields are null; trade-derived fields may remain available only when their own raw stream is valid. Missing feature intervals stay missing and are never forward-filled.

## Latency and clock trust

Store both exchange event time and local receive time, then compute `receiveLatencyMs`. The host must be NTP-synchronized and record its clock-drift check. Drift greater than 500ms sets `CLOCK_UNTRUSTED`; latency-derived features are unusable for that interval, while immutable raw timestamps remain available for diagnosis.

## Daily quality report and admission

Reports are grouped by symbol, stream, and UTC day, with:

```text
receivedEvents, firstEvent, lastEvent,
disconnectCount, reconnectCount, maxGapMs,
p50ReceiveLatencyMs, p95ReceiveLatencyMs, p99ReceiveLatencyMs,
duplicateCount, outOfOrderCount, sequenceGapCount,
featureCoverage, uptime
```

The fixed gates are uptime at least 99%, valid-book coverage at least 98%, aggregate-trade coverage at least 99%, and bookTicker coverage at least 99%. Any failed gate is `DATA_QUALITY_FAIL`; the affected interval remains excluded and visible. No alpha research may begin until at least 30 calendar days have been collected, preferably 60–90, and all daily gates pass.

## Retention, capacity, and activation checklist

Before activation, estimate bytes per event separately for each stream from a permitted sample, multiply by eight symbols, the selected retention period, compression ratio, manifest copies, and a fixed storage headroom allowance. Activate only after the persistent volume/object-storage quota, upload retry policy, and sealed-partition recovery procedure are tested. Preserve raw partitions and manifests for the complete collection window and any separately authorized research retention.

Activation requires all of the following:

1. A recorded `collectionStartAt` exists before the first connection.
2. The process supervisor, NTP monitor, durable raw storage, and manifest writer are available.
3. All eight symbols have bounded subscriptions and public-only endpoint checks.
4. The sequence/resync and append-only tests pass in the target runtime.
5. Capacity and alert thresholds are documented.
6. No strategy, outcome, PnL, email, scheduler, or trading code is enabled.

The proposed deployment target is a long-running Node.js container managed by a restart supervisor, with object storage for raw partitions/manifests and a private Supabase/Postgres feature store. No deployment is performed by HY-DATA-0036 preparation.
