# HY-EXP-0003 结果

结论：`EXACT_SPECIFICATION_ELIMINATED`。所有输入均为 D0 已暴露开发数据，不能证明样本外盈利。

固定规则只产生 6 笔、4 个结算事件簇，低于预登记的 100 笔容量门槛。未计成本的价格收益单位合计为 -0.100855，平均每笔约 -1.68%；压力情景 6 笔全部亏损，PF 为 0。出现信号的 BTC、ETH、SOL、DOGE 在压力情景均亏，多头和空头也均亏。

这组数据不支持“极端 premium 在结算后 5–65 分钟回归”的固定机制。不能通过降低 premium/z-score、提前入场或改变持有期继续本实验；任何变化必须使用新 ID。

| 情景 | 交易 | 净收益单位 | PF | 去最佳5笔 | 去最佳5事件簇 |
|---|---:|---:|---:|---:|---:|
| base | 6 | -0.108102 | 0.004 | -0.052628 | 0.000000 |
| stress | 6 | -0.115350 | 0.000 | -0.053859 | 0.000000 |
| extreme | 6 | -0.125014 | 0.000 | -0.055500 | 0.000000 |

## 预登记开发筛选

通过：否

失败项：minimumTrades, stressProfitFactor, positiveNet, withoutBest5Trades, withoutBest5EventClusters, symbolBreadth, bothDirections, halfYearBreadth, monthConcentration

## 解释限制

- All observations are exposed development data and cannot prove out-of-sample profitability.
- The fixed eight-symbol diagnostic panel is not a point-in-time full-market universe.
- The signal uses premium-index close before settlement but enters five minutes after settlement; 5m contract open remains a price proxy, not a bid/ask fill.
- Funding archive event timestamps determine the clock; realized funding-rate magnitude is excluded from signal generation.
- Max drawdown remains cumulative equal-notional return units, not account equity under margin and liquidation rules.
- The 2026-05 complete-month endpoint was selected after HY-EXP-0002 exposed a 2026-06 archive gap, but before any H2A PnL was computed.
- A passing screen only permits a broader preregistered development test including a non-event placebo.
