# Signal-only operation

Hengyu Research now exposes H9 as a read-only advisory layer. It can describe a
causal event for manual review, but it cannot place, cancel, amend, or query a
private order.

Each advisory signal contains:

- `REVIEW_BUY` or `REVIEW_SELL`, never an order instruction;
- the event and received timestamps, the two-second entry-validity boundary,
  and the research expiry metadata (it is not an automatic exit);
- the opposite best quote observed at the recovery decision;
- a stop reference and the observed event-impulse context;
- an entry, stop-loss and take-profit triplet for the sent-signal review; the
  first TP/SL touch settles the paper result, otherwise the position remains
  open;
- a fixed-notional research execution-cost estimate, explicitly labelled as
  research context rather than account sizing;
- `humanConfirmationRequired: true`, `autoExecution: false`, and
  `orderPlacement: false`.

The alert is emitted only after the existing H9 causal checks have passed. A
single Binance REST snapshot cannot create an H9 alert because it does not
provide the 30-day causal warm-up, force-order history, aggregate trades, or a
sequence-checked local book.

For a valid forward capture, the replay output includes `advisorySignals`:

```powershell
npm.cmd run h9:replay -- --capture data/raw/forward/<valid-run>
```

The first two capture attempts had zero usable records. Capture attempt 005 is
the latest valid six-symbol 15-minute segment with 291,512 accepted records,
but the segment ledger is fragmented and has no 30-day warmup, no qualifying
event, and no PnL result. The forward promotion gates remain unchanged: at
least 180 days or 100 closed events, positive stressed PnL, PF at least 1.30,
best-five robustness, cost stress, and breadth checks.

## Restoring the collector

On the current Windows environment, direct TCP access to Binance port 443
times out, while the configured local proxy at `127.0.0.1:10808` succeeds. Node
does not use that proxy unless started with `--use-env-proxy`:

```powershell
npm.cmd run forward:capture:proxy -- --seconds 86400
```

The collector now waits for both WebSocket connections, buffers depth updates,
and retries the REST snapshot until `U <= lastUpdateId <= u` is observed. A run
that cannot pass this alignment remains invalid and must not enter H9 PnL.
