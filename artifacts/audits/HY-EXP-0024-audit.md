# HY-EXP-0024 signal funnel audit and practical model design

Status: AUDIT_ONLY_NOT_PREREGISTERED; no promotion, no live orders, and no new OOS.

Audit window: 2024-01-01T00:00:00.000Z to 2025-07-01T00:00:00.000Z (0019 development information only).

## Structural H12 finding

Live H12 edge fields are null/UNVERIFIED/sampleSize=0; forceUnverifiedEdgeNoTrade=true. Otherwise-valid historical breakout candidates therefore cannot become Gmail advisories through the live path.

## Funnel

- Current H12 theoretical 4h breakout candidates: 112
- Current H12 strict historical executable candidates: 0
- Current H12 edge/net-edge/risk/Gmail pass: 0/0/0/0
- Proposed 1h family observations: 9982; unique candidate slots: 8823; family overlap slots: 1117; edge/net-edge/risk/Gmail pass remains 0 until a separately validated edge model exists.
- Controlled counts: baseline=112; +bidirectional=459; +universe-only(2/3 breadth)=577; +breadth50%=587; 1h breakout unique=1533; all-family observations=9982; all-family unique=8823.
- Direction attribution: bear/SELL=112; bull/BUY=347; bidirectional=459; SELL_ONLY impact is bull/BUY only under fixed-six 4h semantics.
- Edge/exit alignment: ALIGNED_PROPOSAL_PENDING_PREREGISTRATION_REVIEW; recommended resolution=B_EXACT_EXECUTION_LABEL_WITH_FROZEN_EVALUATION_CAP; no Edge Model training or horizon tuning was run.

## Cost/profitability interpretation

The JSON reports candidate-level descriptive forward outcomes using an 18 bps round-trip OHLCV execution proxy plus archived funding. These are DESCRIPTIVE_ONLY, NOT_PNL, NOT_OOS, and NOT_PROMOTION_ELIGIBLE. Overlapping family observations are not portfolio returns or portfolio drawdown; no validated candidate-level edge is available.

## Decision

FAIL / NOT PROMOTED: the audit establishes a structural zero-advisory edge blocker and does not demonstrate a promotion-grade improvement in net profitability plus usable signal count.

See the JSON artifacts for symbol/month/regime/direction/family breakdowns, Pareto diagnostics, exact proposed model, gates and limitations.
