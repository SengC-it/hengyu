# HY-EXP-0030 development evidence

HY-EXP-0030 was preregistered before outcome computation. The development
window is the frozen interval `2024-08-26T00:00:00Z` through
`2026-08-26T00:00:00Z` (exclusive), with a hard minimum of 365 calendar days
and a preferred target of 730 days.

The run uses only public Binance USD-M sources: the Binance Vision monthly
archives plus public `fapi.binance.com` REST for the uncovered current-month
tail. Contract 5m/1h/4h klines, mark-price 5m klines, funding, quote volume,
and trade count are validated for continuity and native boundaries. Historical
open interest, historical L2, OHLCV depth proxies, private APIs, account APIs,
and order APIs are not used. The expanded point-in-time universe remains
`EXPANDED_UNIVERSE_NOT_EVALUABLE`; the fixed eight-symbol baseline is the
audited cohort.

The candidate dataset contains the frozen Bull/BUY and Bear/SELL generators,
plus compact `sideways-context.json` records for the frozen NO_TRADE context.
Features are captured causally at decision time. Outcomes use the exact next
5-minute contract-price open, the frozen ATR/channel/terminal exits, realized
funding, and 18/27/36 bps all-in costs. Ridge Logistic is the primary model;
the rule scorecard and capped depth-2 shallow GBT are diagnostic only.

The completed development run produced 2,640 raw and labeled candidates,
1,472 BUY, 1,168 SELL, 1,836 OOF predictions, and zero accepted OOF rows.
The primary result is `NOT_READY` and `promotionEligible=false`; no strategy
thresholds or costs were changed. OOF net expectancy was negative at all three
cost tiers, so portfolio MTM drawdown and portfolio CVaR remain
`EMPTY_SAMPLE_NOT_EVALUABLE` rather than being replaced by a trade-level proxy.

Final OOS was not read or created. HY-EXP-0031 was not created. The run remains
`PAPER_ONLY`/`SIGNAL_ONLY` with Gmail, scheduler, private/account/order APIs,
and automatic trading disabled.
