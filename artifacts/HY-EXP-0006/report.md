# HY-EXP-0006 结果

结论：`EXACT_SPECIFICATION_ELIMINATED`。本结果仅属于 D0 开发筛选。

103 个事件的未计成本毛收益单位合计仅 `+0.013857`，平均每事件约 `+1.35 bps`，不足以覆盖基准情景约 `12 bps` 的组合往返摩擦。基准 PF 只有 0.482；压力情景 PF 0.220，净收益单位 -0.233886。

压力情景下多头 sleeve -0.048283、空头 sleeve -0.153239、BTC 对冲 -0.032364，5/5 个半年区间全部亏损。去掉最佳 5 个事件仍亏 -0.269897。因此问题不只是少数异常交易或单侧对冲，固定规则没有可执行净优势。

| 情景 | 事件组合 | 胜率 | 净收益单位 | PF | 去最佳5事件 | 最大回撤单位 |
|---|---:|---:|---:|---:|---:|---:|
| base | 103 | 35.0% | -0.110210 | 0.482 | -0.152174 | -0.119504 |
| stress | 103 | 26.2% | -0.233886 | 0.220 | -0.269897 | -0.234762 |
| extreme | 103 | 11.7% | -0.398788 | 0.083 | -0.426860 | -0.398788 |

失败项：stressProfitFactor, positiveNet, withoutBest5Events, maxDrawdown, symbolBreadth, bothSleeves, halfYearBreadth, monthConcentration

- All observations are exposed D0 development data.
- The fixed 16-symbol panel has survivor bias and is not a point-in-time market universe.
- Metrics create_time is treated as period end; entry waits one full 5m bar after that timestamp.
- Metrics lag and collision-scope rules were selected after structural inspection but before any H3 PnL.
- The 22 conflicting normalized timestamps did not intersect required event OI snapshots; no conflicting value was selected.
- Kline open plus fixed slippage is still not an order-book fill.
- Return-unit drawdown is not leveraged account equity drawdown.
- A pass would require a new full-universe replication and event-time placebo.
