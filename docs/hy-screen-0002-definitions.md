# HY-SCREEN-0002 definitions (not executed)

This file records candidate-family names and causal inputs only. It is not a
strategy release, does not select thresholds, and must not be run during
HY-DATA-0001 collection.

All families require complete, valid HY-DATA-0001 observations after
`collectorActivatedAt`. Missing intervals remain missing; no forward fill is
permitted. Any later threshold, holding period, cost hurdle, validation split,
or promotion gate requires a new preregistration.

## 1. FUNDING_DISLOCATION

Inputs: current funding rate, funding time, mark price, index price, and
receipt/source timestamps. The research question is whether an unusually
large, causally observable funding dislocation contains information after
fees, spread, slippage, funding, and other frozen costs. No cutoff is selected
here.

## 2. FUNDING_OPEN_INTEREST_CONFIRMATION

Inputs: the same funding fields plus open interest and its exchange timestamp.
The research question is whether a funding dislocation confirmed by a
causal open-interest change is informative. Confirmation logic and thresholds
are intentionally unspecified until separate preregistration.

## 3. BASIS_DISLOCATION

Inputs: mark price, index price, derived premium/basis bps, and source timing.
The research question is whether a persistent or reverting mark/index basis is
informative. The derived basis is unavailable when either price is invalid.

## 4. TAKER_FLOW_IMBALANCE

Inputs: completed 5m contract-price OHLCV, taker-buy volume, total volume,
trade count, and causal timestamps. The research question is whether taker
flow imbalance predicts a future outcome. No threshold is inferred from this
dataset in the collection stage.

## 5. FUNDING_TAKER_FLOW

Inputs: funding fields, completed 5m bar, taker-buy ratio, mark/index basis,
and open interest where available. The research question is whether these
public derivatives signals provide incremental information together. This is
only a candidate family label; it is not permission for multi-feature search.

## Execution prohibition

`HY-SCREEN-0002` is not executable from this document. There is no signal
email, advisory, order, account, Final OOS read, PnL calculation, or promotion
path in HY-DATA-0001.
