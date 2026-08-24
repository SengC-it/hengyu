# HY-EXP-0028 EMAIL_SIGNAL_RELEASE evaluation

This is a derived governance evaluation. It does not rewrite or replace the frozen HY-EXP-0028 holdout result.

## Decision

`EMAIL_SIGNAL_CANDIDATE`

The base-cost economics and risk/concentration gates pass, but the sample is not release-ready: 43 validated advisories over 53 calendar days do not satisfy the frozen minimum of 80 signals over 90 days. This state permits research monitoring only; it does not authorize production email sending or automatic trading.

## Immutable source

| Field | Value |
| --- | --- |
| Source ref | `origin/agent/hengyu-exp-0028` |
| Source commit | `a61cb20318af1e0b188c0276a1a3d65e52bc4467` |
| Source artifact | `artifacts/HY-EXP-0028/holdout-result.json` |
| Source SHA-256 | `92304ec0252be9ee2bba2e13a9ccc64c923f3b067d91e12513be089d56f3d2e5` |
| Frozen source status | `HOLDOUT_FAILED` |

## Frozen policy gates

| Gate | Result | Evidence |
| --- | --- | --- |
| Causal/no-lookahead and no future labels | PASS | Frozen holdout integrity evidence |
| Parameters frozen before validation | PASS | Frozen holdout integrity evidence |
| Independent holdout/provenance | PASS | Immutable source commit and hash |
| 18bps base-cost net PnL > 0 | PASS | 671.778467846798 USDT |
| 18bps net expectancy > 0 | PASS | 5.237781100313037 bps |
| 18bps net PF >= 1.10 | PASS | 1.1506895886413784 |
| Max MTM DD <= 10% | PASS | 7.723556081371896% |
| Distinct symbols >= 6 | PASS | 8 |
| Largest symbol share <= 40% | PASS | 20.930232558139536% |
| Net PnL after best trade removed > 0 | PASS | 4.4107091824917 USDT |
| Positive active-month share >= 50% | PASS | 1 of 2 active months |
| Validated signals >= 80 | FAIL | 43 |
| Validation span >= 90 days | FAIL | 53 days |

## Warnings

- `COST_STRESS_WARNING=true`: 27bps net expectancy is -3.7622188996869474 bps. The 27bps stress case is a warning and is not a veto under this policy.
- `LOSS_STREAK_WARNING=true`: maximum loss streak is 12, above the warning threshold of 6. This is a warning and is not a veto under this policy.

## Safety and next step

The policy remains `SIGNAL_ONLY` / `PAPER_ONLY`; live orders, account APIs, order APIs, automatic trading, production deployment, and production Gmail sending are disabled. HY-EXP-0028 must not be tuned with remaining observations. A future release evaluation requires a separately preregistered validation span reaching both 80 validated signals and 90 calendar days before any release-ready decision.
