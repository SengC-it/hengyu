# HY-EXP-0039 Historical Validation

- Code commit: `29516f4eeec1ad9bec531e269b2ed851cf0492dc`
- Data manifest SHA-256: `d5d124f01f8c4cdc47fb6219767356abc390d3258e4c3f631542dc33eb6c4621`
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
