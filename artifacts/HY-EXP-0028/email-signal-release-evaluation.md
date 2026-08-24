# HY-EXP-0028 EMAIL_SIGNAL_RELEASE evaluation

This is a derived governance evaluation. It does not rewrite or replace the frozen HY-EXP-0028 holdout result.

## Decision

`EMAIL_SIGNAL_RELEASE_READY`

The V2 economics, risk/concentration, integrity, readiness, immutable-source, and validated-baseline gates pass. This is eligibility for explicit PAPER_ONLY human-review email approval only; it is not an automatic release or trading authorization.

## Immutable source

| Field | Value |
| --- | --- |
| Source ref | `origin/agent/hengyu-exp-0028` |
| Source commit | `a61cb20318af1e0b188c0276a1a3d65e52bc4467` |
| Source artifact | `artifacts/HY-EXP-0028/holdout-result.json` |
| Expected SHA-256 | `92304ec0252be9ee2bba2e13a9ccc64c923f3b067d91e12513be089d56f3d2e5` |
| Computed SHA-256 | `92304ec0252be9ee2bba2e13a9ccc64c923f3b067d91e12513be089d56f3d2e5` |
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
| Artifact-derived metrics | PASS | all release metrics are derived from verified holdout-result.json bytes and immutable trades |
| Caller metric assertions | PASS | supplied values match the artifact-derived values; they cannot override them |
| Immutable source bytes/provenance | PASS | exact source bytes and frozen SHA-256 recomputed successfully |
| Better than HY-EXP-0019 baseline | PASS | verified candidate is positive and improves PF and equity-bps/trade |
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

## HY-EXP-0019 validated baseline

The derived manifest at `artifacts/HY-EXP-0019/baseline-manifest.json` records the canonical leakage-free OOS reference without rewriting its result: source commit `9d6b5298fab9760a611c2b5e52e86c500a6688a1`, frozen result commit `9f23475802f3ca9a85957a5ab2e69ac42b0c1aa2`, manifest SHA-256 `3d1865afea13221d64f85641ba92312a7e0b593c94e629b17e520c19875b3edd`, result SHA-256 `3c45646c589f9576a1645d43ff30d73469900c4aebccbed7a7c2bc3cf8f4878f`, and data-manifest SHA-256 `136ba1268cb91c700f55cdfa5a487aa3e9bd0c0575996bece314fb5223cf4986`. The verified result contains 41 trades over `2025-07-01` through `2026-07-01` exclusive, research equity `100000 USDT`, OOS PF `0`, net return `-127.63487537771283 bps`, and equity-normalized `-3.113045740919825 bps/trade`. HY-EXP-0028 derives `1.5622755066204606 equity bps/trade` from `netPnl / 100000 * 10000 / 43`, so the baseline comparison passes without using raw total PnL as the gate.

## Safety and next step

The policy remains `SIGNAL_ONLY` / `PAPER_ONLY`; live orders, account APIs, order APIs, automatic trading, production deployment, and production Gmail sending are disabled. `EMAIL_SIGNAL_RELEASED` is false. HY-EXP-0028 must not be tuned with remaining observations, and the immutable `HOLDOUT_FAILED` source remains unchanged.
