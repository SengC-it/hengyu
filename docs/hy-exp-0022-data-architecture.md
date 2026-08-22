# HY-EXP-0022 prospective data architecture

HY-EXP-0022 is a new, paper-only experiment. HY-EXP-0021 was closed before data use because its preregistration did not freeze a prospective 4h bar source and its time firewall was incomplete. This design does not reopen 0021, alter its specification, consume its raw data, or reuse its results.

## Commit and window firewall

The first commit is deliberately only `registry/experiments/HY-EXP-0022/preregistration.json`:

- commit: `792f9ef4630d724e77fa4df13847ff421bd3e521`
- committed at: `2026-08-22T00:28:19.000Z`
- file SHA-256: `552bc2610df8c6bd85ed955aa4744cf172a82172cfcfbeab14b21d6d606dc74e`
- capture start: `2026-08-22T04:00:00Z`, the first complete UTC 4h boundary strictly after the commit

The proposed Development start is `2026-08-24T00:00:00Z` and its exclusive end is `2027-03-01T00:00:00Z`. The immutable Final OOS window is `2027-03-01T00:00:00Z` through `2027-09-01T00:00:00Z` exclusive. The first possible candidate is `2026-09-21T04:00:00Z`, after 180 valid prospective completed bars and the Development start gate.

No record is eligible merely because it is stored in a directory. For Development capture, every causal source timestamp and `receivedAt` must be in `[captureStart, developmentEndExclusive)`. A Development candidate must also have `decisionTime` in `[developmentStart, developmentEndExclusive)`. Final-OOS capture uses `[finalOosStart, finalOosEndExclusive)` and rejects data before the start or at/after the end. The two canonical roots are disjoint:

```text
data/raw/prospective-development/HY-EXP-0022
data/raw/prospective-final-oos/HY-EXP-0022
```

The collector validates canonical path containment with `path.resolve` and `path.relative`; a path containing the experiment text is not identity proof. A record with a source timestamp later than `receivedAt`, or any pre-capture timestamp, is rejected and audited.

## Prospective 4h bars

The sole signal bar source is Binance USD-M **contract-price** 4h Kline:

- REST confirmation: `/fapi/v1/klines?symbol=<symbol>&interval=4h`
- raw final WebSocket event: `<symbol>@kline_4h`
- mark-price kline, OHLCV backfill, and bookTicker depth are forbidden

Each accepted final bar contains `openTime`, `closeTime`, `open`, `high`, `low`, `close`, `volume`, `quoteVolume`, `tradeCount`, `finalClosed`, `sourceExchangeTimestamp`, and `receivedAt`. Only `finalClosed=true` bars whose close has completed before the decision are eligible.

The final WebSocket kline is primary. An immediate post-boundary REST request for that just-closed bar is secondary confirmation. Both normalized records must match on open/close times, OHLCV, quote volume, and trade count. A single source remains `WAITING_CONFIRMATION` and cannot enter Development. A conflict invalidates the segment; the collector never chooses one source, interpolates a value, or fills a gap. Raw events remain append-only even when a derived index deduplicates identical source records.

Universe `priorSixBarQuoteVolume` is exactly the sum of the six immediately preceding contiguous completed contract-price bars. The 24h ticker is diagnostic only and can never substitute for this quantity.

All SMA60/180, Donchian120, ATR30, channel60, and volume6 history is prospective. No candidate or model row is emitted until 180 valid post-capture completed bars exist. Warm-up rows are capture data, not trades and not PnL.

## Required capture streams

The experiment-specific raw namespace must contain append-only NDJSON for:

`depth.diff`, `depth.snapshot`, `kline.4h`, `exchangeInfo`, `funding`, `universe.snapshot`, `universe.audit`, and `segment.audit`.

Ticker may be collected for diagnostics but cannot define volume6 or eligibility. L2 uses the inherited engineering capability: REST limit 1000 snapshot, combined/multiplex depth streams, `U/u/pu` continuity, per-symbol alignment, receipt timestamps, invalid-segment fail-closed behavior, raw file SHA-256, immutable manifests, and no proxy depth.

Every raw file is append-only and receives a SHA-256 entry in an immutable manifest. A missing receipt timestamp, sequence gap, crossed book, missing required funding event, missing bar confirmation, or lost exchangeInfo coverage excludes the segment and fails the required-window gate; there is no silent repair.

## OOS access policy

Before Development PASS, Final-OOS files may only be written, hashed, or integrity-checked. There is no query, inspect, summarize, calculate, train, optimize, backtest, or metrics operation in that state. After Development PASS, only the explicit allowlist `read_raw_final_oos`, `read_manifest`, `calculate_metrics`, and `generate_report` is accepted. Unknown operations remain rejected; delete, overwrite, move, export-unsealed, order, account, trade, and execute are always blocked. A Development failure permanently locks Final-OOS research reads for this experiment.

Capture creates no `result.json`, `trades.jsonl`, or PnL. The implementation has no order or account endpoints and remains `PAPER_ONLY`; this document proposes a collector architecture and does not deploy one.

## Long-running collector proposal

Vercel serverless execution is not suitable for continuous 100ms depth capture over the six-to-twelve-month windows. The intended deployment, pending separate authorization, is a supervised long-running container/process with:

1. automatic restart and health checks;
2. NTP/time-drift monitoring and receipt-lag alerts;
3. combined/multiplex WebSocket depth streams rather than uncontrolled one-connection-per-symbol processes;
4. fresh REST snapshots after every reconnect and at every UTC 4h rotation;
5. per-symbol segment lifecycle, immutable object storage, and atomic manifest publication;
6. storage-capacity monitoring for raw depth, bars, metadata, funding, audits, and manifests;
7. alerts for sequence gaps, crossed books, stale books, missing bars, missing funding, missing receipts, and manifest incompleteness.

The collector must stop a segment on a gap or crossed book and start a new segment only after a fresh snapshot. It must never repair a gap synthetically. Development and Final-OOS capture use separate credentials, roots, manifests, and operation policies even though both remain paper-only.

## Phase A collector engineering

Phase A exposes an executable command:

```text
npm run hy-exp-0022:engineering-dry-run -- --duration-ms 300000 --max-symbols 3
```

It writes only to `data/raw/engineering-dry-run/HY-EXP-0022/<runId>`. That root is canonical, distinct from both prospective roots, and is always marked `developmentEligible=false`; it can never be passed to a Development reader. Raw files are not committed. The command writes the small engineering result to `artifacts/HY-EXP-0022/collector-engineering-readiness.json`.

The current Binance transport endpoints are verified at runtime and no legacy `/stream` fallback exists:

- depth combined subscriptions: `wss://fstream.binance.com/public/stream`;
- kline combined subscriptions: `wss://fstream.binance.com/market/stream`.

Both connections use a bounded `SUBSCRIBE` batch. Every message is capability-checked before reconstruction. If `st` is present it must equal `1`; `st=2` fails closed. `st` and `ps` are retained in the raw record. A reconnect closes the old segment and starts a new segment with fresh snapshots; an invalid segment is never repaired or relabeled as valid.

The five-minute dry run verifies dynamic exchangeInfo/ticker sampling, REST depth limit 1000, per-symbol snapshot alignment, `U/u/pu` continuity, real kline stream receipt, exchangeInfo, funding, append-only NDJSON, raw-file hashes, and an immutable manifest. It does not fabricate a completed 4h bar. An open current 4h kline is recorded only as an engineering schema/transport observation. If the currently open bar began before the frozen `captureStart`, it is retained in the engineering root but reported as `PASS_TRANSPORT_PRECAPTURE_BAR_EXCLUDED`; it is never a Development input. A final kline is eligible for REST confirmation only when it is closed and its `openTime` is at or after `captureStart`; the REST request is bounded to that exact `openTime`/`closeTime` pair. A mismatch is `BAR_SOURCE_CONFLICT`, a timeout is `BAR_CONFIRMATION_MISSING`, and neither condition has a fallback.

The OOS workflow is intentionally stricter than a generic “PASS” flag. Before Development PASS, Final-OOS raw data may only be written, hashed, and integrity-checked. The system rejects a Development PASS decision while Final-OOS capture is not sealed. Once the full Final-OOS capture is sealed, Development may be evaluated; only a real Development PASS then unlocks the explicit Final-OOS research-read allowlist. No Phase A command marks Development PASS, reads OOS, computes PnL, or enables order/account APIs.
