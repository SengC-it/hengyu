# HY-EXP-0033 Recovered-Data Strategy Family Tournament

Winner: **NO_ROBUST_STRATEGY_FOUND**

| Family | Events | Net18 bps | PF18 | Net27 bps | PF27 | Net36 bps | PF36 | MTM DD | CVaR | Gate |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| H12_BROAD_BEAR_SHORT | 64 | 3.5807 | 1.065 | 2.0807 | 1.037 | 0.5807 | 1.010 | 0.293873 | 0.029164 | FAIL |

- H12_BROAD_BEAR_SHORT failures: PF18, PF27, PF36, portfolioMtmDD, maxLossStreak, withoutBestEvent, withoutBest5, withoutBestMonth, positiveMonthShare, bootstrapNet27Lower
- Bootstrap net27 lower 95%: -55.08819499226858

| H6_BETA_NEUTRAL_FUNDING_CARRY | 6 | 111.4846 | 2.702 | 102.4846 | 2.496 | 93.4846 | 2.307 | 0.057302 | 0.005140 | FAIL |

- H6_BETA_NEUTRAL_FUNDING_CARRY failures: eventCount, activeMonths, withoutBest5, bootstrapNet27Lower
- Bootstrap net27 lower 95%: -134.6490109559464

| H7_CROSS_ASSET_RELATIVE_VALUE | 15 | 29.5689 | 2.064 | 27.3189 | 1.953 | 25.0689 | 1.843 | 0.049916 | 0.003108 | FAIL |

- H7_CROSS_ASSET_RELATIVE_VALUE failures: eventCount, activeMonths, withoutBest5, concentration, bootstrapNet27Lower
- Bootstrap net27 lower 95%: -23.696626935142007

All results are development evidence only; no final OOS was read and no release/trading authorization is implied.
