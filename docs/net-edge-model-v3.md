# Net-edge advisory model v3

`HY-EXP-0014` is the first frozen specification for a point-in-time dynamic
USD-M universe. It is a research and reminder layer, not an execution system.

## Decision path

Every candidate is evaluated causally at a 60-second decision boundary:

```text
expected price edge
+ expected funding
- two-sided fees
- stressed visible-book cost
- impact and latency buffers
- forecast uncertainty
- funding stress
= conservative net edge
```

`TRADE` is possible only when the candidate has fresh timestamps, available
two-sided depth, positive price edge, gross-to-cost ratio at least 1.5, and
conservative net edge at least 3 bps. A candidate that has positive but
sub-threshold conservative edge is recorded as `OBSERVE`; otherwise it is
`NO_TRADE` with every failure reason retained.

The public advisory envelope contains direction and reference prices, expiry,
stop/exit references, and cost details. It never contains account balance,
quantity, leverage, account risk, or an order payload.

## Alert delivery

- `STRONG`: at least 6 bps conservative edge and 2.0 gross-to-cost ratio;
  immediate email plus web record.
- `MEDIUM`: at least 3 bps and 1.5 ratio; 15-minute email digest plus web record.
- `OBSERVE`: web record only.

The file outbox is intentionally provider-neutral. A hosted deployment may
attach a Gmail/SMTP adapter after credentials are supplied; no Binance private
credential is ever needed.

## Evidence boundaries

The first 30 days after the new hosted collector becomes complete are warm-up.
No existing H9 segment or failed attempt 006 is reused as HY-EXP-0014 PnL.
F1 requires both 180 calendar days and 100 closed model simulations. A later
continuous-profitability claim additionally requires two consecutive positive
30-day rolling stress windows. None of these conditions is currently met.

