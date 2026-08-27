# HY-EXP-0038 Historical Validation

- Code commit: `e78c1e9a206d6d3d7c5d14cc987e4c4a225162e3`
- Data manifest SHA-256: `ecfcf309223a9418cd4fa4911195c08abb1d0c1bb1ed2b52277b6035991d2a4d`
- Development: 2024-08-26T00:00:00.000Z to 2025-08-26T00:00:00.000Z (exclusive)
- Historical validation: 2025-08-26T00:00:00.000Z to 2026-08-26T00:00:00.000Z (exclusive)
- Validation type: registered historical validation, not Final OOS
- Final OOS read: false

## Result: NO_PROFITABLE_EMAIL_STRATEGY_FOUND

Development config: **NO_DEVELOPMENT_CONFIG**
Historical predictions: **0**
Accepted signals: **0**

| Gate | Result |
|---|---|
| validationSignals | FAIL |
| averageSignalsPer30Days | FAIL |
| activeMonths | FAIL |
| symbolBreadth | FAIL |
| net27Expectancy | FAIL |
| PF27 | FAIL |
| totalNet27Pnl | FAIL |
| net36Expectancy | FAIL |
| portfolioMtm | FAIL |
| portfolioCvar | FAIL |
| maxLossStreak | PASS |
| positiveMonths | FAIL |
| withoutBestEvent | FAIL |
| withoutBest5Events | FAIL |
| withoutBestMonth | FAIL |
| largestSymbolContribution | FAIL |
| largestMonthContribution | FAIL |

Gate failures: validationSignals, averageSignalsPer30Days, activeMonths, symbolBreadth, net27Expectancy, PF27, totalNet27Pnl, net36Expectancy, portfolioMtm, portfolioCvar, positiveMonths, withoutBestEvent, withoutBest5Events, withoutBestMonth, largestSymbolContribution, largestMonthContribution

No Final OOS was read. No email, scheduler, order, account, private API, or trading action is authorized.
