# HY-EXP-0021 prospective L2 data architecture

## Scope and status

HY-EXP-0021 is a new, paper-only experiment. This document specifies prospective data capture only; it does not run a model, calculate PnL, inspect Final OOS data, or deploy a collector.

HY-EXP-0020 remains closed as `DATA_FAIL_FROZEN` at commit `0f16caf4b79310d6c27aedac97c5bab76738e4e8`. Its raw files, manifests, metadata audit and results are not inputs to 0021. Only the engineering pattern of its Phase B collector may be reimplemented in the 0021 namespace.

The 0021 preregistration commit is `518530097a6205e58c540dc2b14adb28b4fe2cf1`, committed at `2026-08-22T00:10:47Z`. The first complete UTC 4h boundary strictly after that commit is the capture start:

```text
CAPTURE_START = 2026-08-22T04:00:00Z
```

The Development window is `2026-08-24T00:00:00Z` through `2027-03-01T00:00:00Z` exclusive. The Final OOS window is immutable at `2027-03-01T00:00:00Z` through `2027-09-01T00:00:00Z` exclusive.

## Namespaces and identity

Every raw record, segment, manifest and registry payload must identify `HY-EXP-0021`.

```text
Development raw: data/raw/prospective-development/HY-EXP-0021/
Final OOS raw:   data/raw/prospective-final-oos/HY-EXP-0021/
Manifests:       artifacts/HY-EXP-0021/manifests/
```

The writer rejects paths containing `HY-EXP-0020`, foreign experiment IDs, and any caller-supplied root outside the mode-specific 0021 directory. A 0020 manifest cannot be copied or relabeled as a 0021 Development input.

## Data plane

At each complete UTC 4h boundary:

1. Capture Binance USD-M `exchangeInfo` and 24-hour ticker responses, including request start, body-completion receipt time, server time when supplied, and the raw response.
2. Apply the frozen point-in-time universe policy: USDT/USDC perpetuals, `TRADING`, 30-day listing age, stable-base exclusions, volume thresholds, maximum 200 symbols.
3. Append a universe snapshot and an append-only membership audit. New symbols start a new L2 segment with a fresh REST snapshot; removed symbols end normally.
4. Subscribe to bounded combined `@depth@100ms` streams. Each symbol owns its buffer, snapshot, reconstructor and alignment diagnostics.
5. Fetch a REST depth snapshot with 1000 levels per side. Keep all raw WebSocket records. Drop only stale buffered updates already covered by the snapshot; require `U <= lastUpdateId <= u`, then require `pu == previous u` for every later applied update.
6. Reject duplicate, out-of-order, missing, crossed, future-timestamped or receipt-missing records. There is no synthetic event, gap fill or silent repair.
7. Capture settled funding with symbol, funding time, rate, mark price and receipt time. A required event missing from the prospective stream is a data failure, not a zero.
8. Seal each file with SHA-256 and write an immutable manifest containing source, authorization/provenance, coverage, invalid segments, sequence diagnostics and all file hashes.

The collector remains a data writer. Candidate generation, Edge Model fitting, Net Edge evaluation, portfolio risk and PnL are separate later phases and cannot run during this capture-design stage.

## OOS firewall

Final OOS raw capture is allowed before Development passes only for:

- `write`
- `hash`
- `integrity_check`

Before Development PASS, the system must reject `query`, `summarize`, `inspect`, `calculate`, `optimize`, `generate_metrics`, `train` and `backtest`. If any Development gate fails, the Final OOS namespace becomes permanently locked for 0021. Raw append and hash operations are not analytical reads.

Development and Final OOS have separate roots, manifests and access policies. The Final OOS start cannot be moved earlier because capture is delayed or because the Development sample is small.

## Long-running deployment proposal

Vercel serverless functions are not suitable for a six-to-twelve-month, 100ms L2 stream. The proposed runtime is a long-running container or VM process under `systemd` or a Kubernetes StatefulSet with `restartPolicy=Always`. This proposal is not deployed in this phase.

The process is split into these responsibilities:

- combined WebSocket reader with bounded symbol batches;
- per-symbol snapshot/buffer/reconstructor state;
- REST exchangeInfo, ticker and funding pollers;
- UTC 4h scheduler and segment rotator;
- append-only NDJSON journal and local spool;
- hash/manifest sealer writing to immutable object storage;
- health endpoint and metrics exporter;
- NTP drift monitor;
- OOS firewall that has no order or account API capability.

On restart, the process seals or marks the current segment, records the restart reason, opens a new segment and obtains a fresh REST snapshot. It never repairs an old invalid segment. WebSocket reconnects also require a fresh snapshot. Rotation occurs at every UTC 4h boundary and proactively before an exchange connection approaches its lifetime limit.

The host must use NTP. A 100ms offset emits an alert; a 500ms offset stops the segment until the clock is synchronized. Health checks cover process liveness, restart count, last receipt age, sequence gaps, crossed books, alignment latency, funding freshness, exchangeInfo freshness, manifest sealing lag and storage usage. Alerts fire for any data gap, stale receipt, crossed book, snapshot failure, clock drift, 80% storage usage or unsealed manifest.

## Storage estimate

The dominant cost is raw depth. A planning upper bound of 200 symbols, 10 depth events per second per symbol and 1–5 KiB per NDJSON event implies approximately:

| Window | Days | Events at upper bound | Raw bytes before replication |
| --- | ---: | ---: | ---: |
| Development | 189 | 32,659,200,000 | 33.4–167.2 TB |
| Final OOS | 184 | 31,795,200,000 | 32.6–162.8 TB |

Provision at least 2× this envelope for local spool, retries and immutable copies: roughly 66.9–334.4 TB for Development and 65.1–325.6 TB for Final OOS. This is intentionally conservative and is not an observed usage claim. A short authorized pilot must measure actual event rate, average serialized bytes, compression ratio and membership breadth before reserving capacity. Storage alerts should fire at 80%, with a hard fail-closed threshold before exhaustion.

## Promotion prerequisites

No Development read is permitted until the preregistration is accepted and the prospective capture manifests satisfy the frozen gates: 100% PIT exchangeInfo, 100% required L2 coverage, zero usable-segment sequence gaps and crossed books, zero missing receipts, complete required funding, complete provenance/hashes, zero future data and zero proxy depth. These conditions are data gates, not tuning targets.

No Final OOS read is permitted until every frozen Development gate passes. No order endpoint, account endpoint, production deployment or real-money capability is part of this design.
