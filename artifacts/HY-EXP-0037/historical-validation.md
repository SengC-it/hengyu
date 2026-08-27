# HY-EXP-0037 Historical Validation

- Code commit: `7fc97112551cf62a7e13f3564d7cfed83739fbd7`
- Data manifest SHA-256: `011824f5b6c77d5670f093a4fd3e7cff5aea8c5a64b5f4912193510781cd2bc0`
- Development: 2024-08-26T00:00:00.000Z to 2025-08-26T00:00:00.000Z (exclusive)
- Historical validation: 2025-08-26T00:00:00.000Z to 2026-08-26T00:00:00.000Z (exclusive)
- Validation type: registered historical validation, not Final OOS
- Final OOS read: false

## Result: NO_PROFITABLE_EMAIL_STRATEGY_FOUND

Development config: **DEVELOPMENT_CONFIG_FOUND**
Historical predictions: **15535**
Accepted signals: **326**

| Gate | Result |
|---|---|
| validationSignals | PASS |
| averageSignalsPer30Days | PASS |
| activeMonths | PASS |
| symbolBreadth | PASS |
| net27Expectancy | FAIL |
| PF27 | FAIL |
| totalNet27Pnl | FAIL |
| net36Expectancy | FAIL |
| portfolioMtm | FAIL |
| portfolioCvar | PASS |
| maxLossStreak | FAIL |
| positiveMonths | FAIL |
| withoutBestEvent | FAIL |
| withoutBest5Events | FAIL |
| withoutBestMonth | FAIL |
| largestSymbolContribution | PASS |
| bootstrapNet27Lower95 | FAIL |

Gate failures: net27Expectancy, PF27, totalNet27Pnl, net36Expectancy, portfolioMtm, maxLossStreak, positiveMonths, withoutBestEvent, withoutBest5Events, withoutBestMonth, bootstrapNet27Lower95

No Final OOS was read. No email, scheduler, order, account, private API, or trading action is authorized.
