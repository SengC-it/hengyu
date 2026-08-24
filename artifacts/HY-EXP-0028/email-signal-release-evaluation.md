# HY-EXP-0028 EMAIL_SIGNAL_RELEASE evaluation

This is a derived governance evaluation. It does not rewrite or replace the frozen HY-EXP-0028 holdout result.

## Decision

`EMAIL_SIGNAL_RELEASE_READY`

The V2 base-cost economics, risk/concentration, integrity, and readiness gates pass: 43 validated advisories over 53 calendar days meet the minimum of 40 signals over 45 days. This state makes the frozen strategy eligible for explicit approval of PAPER_ONLY human-review email signals; it is not EMAIL_SIGNAL_RELEASED and does not authorize production sending or automatic trading.

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
| Cost basis integrity | PASS | baseCostBps=18 and stressCostBps=27 explicitly match policy |
| Max MTM DD <= 10% | PASS | 7.723556081371896% |
| Distinct symbols >= 6 | PASS | 8 |
| Largest symbol share <= 40% | PASS | 20.930232558139536% |
| Net PnL after best trade removed > 0 | PASS | 4.4107091824917 USDT |
| Validated signals >= 40 | PASS | 43 |
| Validation span >= 45 days | PASS | 53 days |

The frozen monthly calculation is still recorded for audit: July 2026 was `-564.8740225660517` USDT and August 2026 was `1236.65249041285` USDT. Removing the highest-PnL month (August) leaves `-564.8740225660517` USDT, so `MONTH_CONCENTRATION_WARNING=true`. Under V2 this is a warning only and is not a release veto.

## Warnings

- `COST_STRESS_WARNING=true`: 27bps net expectancy is -3.7622188996869474 bps. The 27bps stress case is a warning and is not a veto under this policy.
- `LOSS_STREAK_WARNING=true`: maximum loss streak is 12, above the warning threshold of 6. This is a warning and is not a veto under this policy.
- `MONTH_CONCENTRATION_WARNING=true`: removing the best calendar month leaves negative base-cost net PnL. This is a warning and is not a veto under this policy.

## Safety and next step

The policy remains `SIGNAL_ONLY` / `PAPER_ONLY`; live orders, account APIs, order APIs, automatic trading, production deployment, and production Gmail sending are disabled. `EMAIL_SIGNAL_RELEASE_READY` still requires explicit human approval before any PAPER_ONLY signal email is sent. HY-EXP-0028 must not be tuned with remaining observations, and the immutable `HOLDOUT_FAILED` source remains unchanged.
