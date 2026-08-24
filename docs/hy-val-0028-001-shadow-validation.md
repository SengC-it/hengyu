# HY-VAL-0028-001 prospective shadow validation

This is a paper/shadow extension of the frozen HY-EXP-0028 Rule A. It is not a new strategy, an email-release decision, or an automatic-trading path.

## Source lock

The implementation records the immutable source commit `a61cb20318af1e0b188c0276a1a3d65e52bc4467`, the HY-EXP-0028 preregistration hash `4085fad293275ce055a67516d1c8168331f221a91b688f3b093ff2eef11708a3`, and the frozen holdout result hash `92304ec0252be9ee2bba2e13a9ccc64c923f3b067d91e12513be089d56f3d2e5`. The referenced source file hashes are frozen in `config/hy-val-0028-001.json` and checked by `verifyFrozenSourceManifest`; hash drift fails closed.

The frozen shadow candidate engine does not accept regime, side, ATR, signal close, or feature values as admission inputs. It derives the latest completed 4h context, BTC SMA60/SMA180 regime, eight-symbol breadth, each symbol's ATR20, prior-120 breakout channel, prior-60 exit channel, six-bar quote-volume feature, and the complete eight-feature vector from causal completed bars. It then applies the fixed BULL/BUY Rule A and Q75 `10.051547664406323` gate. The resulting contract is exact: eight fixed USDT perpetual symbols, entry at the exact completed contract-price 5m bar open at `decisionTime + 5 minutes`, BUY stop `entryPrice - 2 * ATR20`, dynamic prior-60 completed 1h channel exit, terminal exit after six completed 1h bars, actual realized funding, and 18/27bps base/stress costs.

## Activation and warmup

`shadowValidationActivatedAt` is unset (`null`) in this PR. A later controlled activation must set it exactly once through `ShadowValidationActivation.setOnce`; a second set is rejected. A signal counts only when `decisionTime >= shadowValidationActivatedAt`.

Historical Binance public USD-M data may be used to build causal indicator warmup only. Warmup rows are tagged `WARMUP_ONLY`, cannot count as validation evidence, cannot generate counted signals or PnL, and cannot change the frozen parameters. No pre-activation signal or outcome backfill is allowed.

## Shadow lifecycle

1. Build the frozen Rule A candidate using only completed causal bars and frozen Q75.
2. Store an immutable `SHADOW_SIGNAL` under `(validation_id, symbol, decision_time)`.
3. Do not email, write the production advisory outbox, or place an order.
4. At `decisionTime + 5 minutes`, use the exact completed contract-price 5m bar open as the theoretical paper entry.
5. Resolve only after the relevant public bars/funding events have occurred; otherwise keep the complete safe resolution state `PENDING` in runtime/health state with no PnL.
6. Persist only a final `RESOLVED` record with `paperPnlComputed=true`; it is immutable and unique by `(validation_id, signal_id)`. A `PENDING` record is rejected by the resolution store and cannot occupy the final-result key.
7. Store realized gross bps, actual funding, net18/net27 bps, paper PnL, exit reason, MAE/MFE, MTM drawdown, timestamps, and source provenance.

The local append-only adapter uses a separate root such as `data/shadow-validation/HY-VAL-0028-001` and these generic table contracts:

| Table | Required key |
| --- | --- |
| `hengyu_shadow_validation_activation` | `validation_id` |
| `hengyu_shadow_signals` | `validation_id, symbol, decision_time` |
| `hengyu_shadow_trade_resolutions` | `validation_id, signal_id` |
| `hengyu_shadow_health` | `validation_id, observation_time` |

No Supabase migration or scheduler activation is included in this PR. A future controlled deployment may map these contracts to a dedicated shadow schema; it must not reuse production advisory/Gmail tables.

## Evidence combination

The original HY-EXP-0028 evidence remains `43` signals over `53` days. This validator reports prospective counts separately and exposes a combination ledger of `43 + N` signals and `53 + N` completed validation days. Gaps and warmup are excluded. Final release metrics must be recomputed from combined trade-level rows; aggregate PF/expectancy values must never be added.

## Safety

`SIGNAL_ONLY=true`, `PAPER_ONLY`, `live_orders_enabled=false`, `account_api=false`, `order_api=false`, and `automatic_trading=false` are enforced in every shadow record. No credentials, private endpoints, order endpoints, production Gmail writes, production advisory writes, Final OOS reads, scheduler changes, or deployment are part of this PR.
