# Performance governance

The rolling performance audit turns a completed experiment into a repeatable
promotion decision. It does not optimize thresholds on exposed outcomes.

Run:

```powershell
npm.cmd run audit:h8
```

The command evaluates the latest complete twelve-month H8 window under the
frozen stress-cost scenario, applies the preregistered minimum trade count,
profit factor, net return, best-five-removal, and drawdown gates, and writes
`artifacts/audits/HY-EXP-0012-rolling-12m.json`. The derived audit is kept
outside the completed experiment bundle so the registered evidence remains
immutable.

An eliminated exact specification is assigned `newSignalsAllowed: false`.
Its post-gate PnL is reported as zero because it is disabled. This is avoided
future exposure through `NO_TRADE`, not retroactively avoided historical loss,
a profitable replacement strategy, or an out-of-sample claim.

H9 and HY-EXP-0014 remain PAPER_ONLY forward research. Their candidates may
continue to be recorded for evidence collection, but no profitability or live
promotion claim is allowed before every frozen forward gate passes.
