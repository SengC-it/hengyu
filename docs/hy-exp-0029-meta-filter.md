# HY-EXP-0029 Meta Edge Filter

HY-EXP-0029 is an independent research experiment. It treats HY-EXP-0028 as a frozen candidate generator and may only emit `SEND_CANDIDATE` or `REJECT_CANDIDATE`. It cannot alter Rule A, Q75, entry, exit, universe, historical evidence, or release state.

## Evidence boundary

The current diagnostic uses only:

`artifacts/HY-EXP-0028/holdout-result.json`

The source SHA-256 is frozen as `92304ec0252be9ee2bba2e13a9ccc64c923f3b067d91e12513be089d56f3d2e5`. The artifact is failed HY-EXP-0028 holdout information, not independent HY-EXP-0029 validation. Final OOS is unread and remains firewalled.

## Architecture

```text
HY-EXP-0028 frozen Candidate
        |
        v
causal feature validator
        |
        v
purged expanding walk-forward meta model
        |
        v
expected net edge + uncertainty + confidence grade
        |
        +--> A+/A: SEND_CANDIDATE (paper research only)
        +--> B/REJECT: REJECT_CANDIDATE (B remains paper-only)
```

No meta filter result authorizes Gmail. `EMAIL_PROFITABILITY_READY` requires Research PASS, a fresh independent holdout PASS, and a PAPER_FORWARD_ONLY PASS, followed by a separate human approval.

## Frozen v1 features

Only fields known at `decisionTime` are allowed:

- `channelDistanceOverFrozenQ75 = channelDistance / frozenQ75`
- binary frozen regime and side indicators
- UTC decision-hour sine/cosine pair

Symbol is used for reporting and concentration checks but is not a model feature. ATR, BTC alignment, breadth, volume expansion, funding-at-entry, liquidity, and volatility-shock features are not present in the immutable HY-EXP-0028 artifact; they are not reconstructed from exits or realized funding and are not backfilled.

Forbidden fields include exit time/price/reason, realized return/PnL, realized funding, MAE/MFE, MTM drawdown, and marks.

## Model and validation

The preregistered model is deterministic ridge logistic regression (`lambda=1`, learning rate `0.05`, `800` batch iterations) over training-fold standardized features. The probability of a positive 18 bps net result is converted to candidate expected edge using the training-fold positive and negative conditional net means. Standard error is the training residual standard deviation divided by the square root of training rows; the conservative edge is expected edge minus `1.96 * standardErrorBps`.

Validation is expanding time-series walk-forward with 5-row validation blocks, a minimum of 12 training rows, 96-hour purge, and 24-hour embargo. Random splits are forbidden. Thresholds are fixed in preregistration and are never optimized against validation outcomes.

## Cost model and grades

Every report includes 18 bps base, 27 bps stress, and 36 bps severe stress. The stress projections subtract 9 and 18 bps from the base prediction respectively. A+ requires conservative 36 bps edge greater than zero and `pPositive >= 0.65`; A requires conservative 27 bps edge greater than zero and `pPositive >= 0.55`; B requires only conservative 18 bps edge greater than zero and remains paper-only; otherwise the grade is REJECT.

Any missing causal feature, invalid timestamp, invalid source hash, unsafe runtime state, or insufficient fold training data fails closed.

## Current diagnostic interpretation

HY-EXP-0028 has 43 signals over 53 calendar days, base net expectancy `5.2378 bps`, stress expectancy `-3.7622 bps`, PF18 `1.1507`, max loss streak `12`, and source MTM drawdown `7.7236%`. The 9 bps cost increase is larger than the base expectancy. All current rows are BUY/BULL, so regime and side cannot discriminate. ATR_STOP rows are exit decomposition only and cannot be used as a pre-entry filter.

After the frozen 96-hour purge and 24-hour embargo, the current artifact cannot supply the required 12 training rows for any validation fold. The resulting OOF prediction count is zero, filtered risk metrics are `EMPTY_SAMPLE_NOT_EVALUABLE`, and edge status is `EDGE_UNCERTAIN`. This is a fail-closed diagnostic result, not a reason to relax the purge, cost, uncertainty, or research thresholds.

## Promotion and forward gates

Research PASS requires at least 100 validated signals and 120 calendar days, positive and robust 18/27/36 bps results, MTM DD at most 8%, loss streak at most 6, positive results after removing the best trade and best month, at least 6 symbols, largest-symbol share at most 30%, and positive bootstrap lower confidence bounds. A separate fresh holdout requires at least 45 independent signals and cannot be retrained or filtered after it is read. PAPER_FORWARD_ONLY requires at least 30 signals or 30–60 days of real public market data.

No current gate passes the model to email, Gmail, scheduler, private APIs, orders, or automatic trading.
