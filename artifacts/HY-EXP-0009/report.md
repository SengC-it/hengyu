# HY-EXP-0009 结果

结论：`EXACT_SPECIFICATION_ELIMINATED`。本结果仅属于 D0 开发筛选。

检测到 157 个不重叠 BTC 冲击；54 个满足冻结分散度和容量规则。

固定收敛方向在未计成本前已经亏损：基准毛收益平均每事件 `-11.25 bps`。压力情景平均每事件净亏 `-35.24 bps`，PF 0.134；多头、空头、BTC上涨冲击、BTC下跌冲击和5/5个半年区间全部亏损。额外延迟5分钟后毛收益仍为 `-3.47 bps/事件`，不能由执行优化挽救。

| 情景 | 组合事件 | 胜率 | 净收益单位 | PF | 去最佳5事件 | 最大回撤单位 |
|---|---:|---:|---:|---:|---:|---:|
| base | 54 | 29.6% | -0.125510 | 0.266 | -0.158619 | -0.126183 |
| stress | 54 | 16.7% | -0.190322 | 0.134 | -0.217453 | -0.190322 |
| extreme | 54 | 9.3% | -0.276737 | 0.065 | -0.295897 | -0.276737 |
| delay5m | 54 | 20.4% | -0.148265 | 0.211 | -0.183309 | -0.149036 |

跳过原因：{"insufficient_reaction_dispersion":102,"reference_capacity":1}
失败项：stressProfitFactor, positiveNet, withoutBest5Events, symbolBreadth, bothAltSleeves, bothShockDirections, halfYearBreadth, monthConcentration, extremePositive, delay5mPositive, delay5mProfitFactor

- All observations are exposed D0 development data and cannot prove out-of-sample profitability.
- The fixed 16-symbol panel has survivor bias and is not a point-in-time full-market universe.
- A 5m open plus fixed slippage is not a bid/ask or order-book fill.
- The delay5m scenario is coarse and cannot replace 5s, 30s and 60s trade/quote replay.
- The BTC cooldown makes the market event the observation unit, but residual legs within an event remain dependent.
- Return-unit drawdown is not leveraged account equity drawdown.
- A pass would still require a new full-universe replication and forward shadow evidence.
