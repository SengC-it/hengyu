# H9 executable replay

`HY-EXP-0013` is a forward-only, PAPER_ONLY experiment. The append-only amendments were recorded before data lock:

- A1 fixes the 60-second pre-event depth median, five-second recovery observation with a two-second arrival tolerance, the top-five 10 bps depth measure, the event-impulse formula, missing-book rejection, and official funding-rate treatment.
- A2 fixes the research stress assumptions at 5 bps per fill, 2x observed book cost, 1 bps impact per fill, and 1 bps latency per fill.
- A3 requires replaying every qualifying event. No post-outcome profitability or edge filter is allowed.
- A5 fixes a 1,000 USDT gross research notional per event, derived from the decision mid without compounding.
- A6 fixes the pressure threshold as the nearest-rank 99.5th percentile over the immediately preceding 30 calendar days.
- A7 excludes delayed pressure rows and delayed recovery observations from the causal decision.
- A8 rejects a capture containing any event at or before `2026-07-30T16:00:00.000Z`; it is not silently filtered.

The failed zero-record smoke capture is separately recorded as `capture-attempt-001.json`; it did not data-lock or finalize H9.

The implementation is split into three auditable stages:

1. `src/model/forward-data.mjs` checks file hashes, timestamps, duplicates, force-order payloads, funding rows, and depth sequence alignment.
2. `src/model/local-book.mjs` applies the REST snapshot and `U/u/pu` deltas to produce causal books. A gap rejects the capture; it is never filled silently.
3. `src/model/h9-events.mjs` builds causal pressure windows, detects recovery events, walks both entry and exit books, applies funding, fees, latency, impact, and 2x book-cost stress, then summarizes stressed PnL.

Run:

```powershell
npm.cmd run forward:validate -- data/raw/forward/<run-id>
npm.cmd run h9:replay -- --capture data/raw/forward/<run-id>
```

The replay exits without PnL when the manifest is `failed`, the data is `not_ready` or `invalid`, or the 30-day warmup is incomplete. These are data/coverage outcomes, not strategy gains or losses.

The first two public captures on 2026-08-01 failed because the local Node
process did not use the configured HTTP(S) proxy. After enabling Node's proxy
support and fixing snapshot buffering/alignment, capture attempt 003 produced
3,806 records for a 30-second BTCUSDT smoke run. Attempt 004 then produced
74,016 valid records across six symbols in five minutes, and attempt 005
produced 291,512 valid records across the same six symbols in fifteen minutes.
All three runs have insufficient warmup, no qualifying event, and no PnL
result. Replay bounds retained local-book depth to 100 levels per side; deeper
liquidity is treated as unavailable for oversized fills, so this optimization
cannot create a fill that the retained book cannot support. H9 remains
forward-pending.
