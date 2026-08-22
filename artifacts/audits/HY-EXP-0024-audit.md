# HY-EXP-0024 signal funnel audit and practical model design

Status: AUDIT_ONLY_NOT_PREREGISTERED; no promotion, no live orders, and no new OOS.

Audit window: 2024-01-01T00:00:00.000Z to 2025-07-01T00:00:00.000Z (0019 development information only).

## Structural H12 finding

Live H12 edge fields are null/UNVERIFIED/sampleSize=0; forceUnverifiedEdgeNoTrade=true. Otherwise-valid historical breakout candidates therefore cannot become Gmail advisories through the live path.

## Funnel

- Current H12 theoretical 4h breakout candidates: 112
- Current H12 strict historical executable candidates: 0
- Current H12 edge/net-edge/risk/Gmail pass: 0/0/0/0
- Proposed 1h family candidates: 9926; edge/net-edge/risk/Gmail pass remains 0 until a separately validated edge model exists.

## Cost/profitability interpretation

The JSON reports candidate-level descriptive forward outcomes using an 18 bps round-trip OHLCV execution proxy plus archived funding. These are not deployable PnL, not OOS results, and cannot promote HY-EXP-0024 because historical L2 and candidate-level validated edge are absent.

## Decision

FAIL / NOT PROMOTED: the audit establishes a structural zero-advisory edge blocker and does not demonstrate a promotion-grade improvement in net profitability plus usable signal count.

See the JSON artifacts for symbol/month/regime/direction/family breakdowns, Pareto diagnostics, exact proposed model, gates and limitations.
