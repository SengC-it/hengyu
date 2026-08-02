# HY-EXP-0008 结果

结论：`EXACT_SPECIFICATION_ELIMINATED`。本结果仅属于 D0 开发筛选。

15 个双腿事件的未计成本价格收益单位合计 `+0.113847`；压力成本后净收益 `0.078762`、PF `36.723`。

该盈利不能晋级。15个事件只分布在6个交易日，其中9个发生于 `2025-10-10` 同一次市场冲击，贡献压力净收益 `0.069759`，占全部压力净收益88.6%。压力情景的 USDT 腿合计 `-0.756689`、USDC 腿合计 `+0.835451`，正收益只是两个大额相反腿收益之间的很小残差；任何一腿晚5分钟后，15/15事件全部亏损，净收益降为 `-0.697044`。

| 情景 | 双腿事件 | 胜率 | 净收益单位 | PF | 去最佳5事件 | 最大回撤单位 |
|---|---:|---:|---:|---:|---:|---:|
| base | 15 | 100.0% | 0.098304 | n/a | 0.024597 | 0.000000 |
| stress | 15 | 73.3% | 0.078762 | 36.723 | 0.012132 | -0.001289 |
| extreme | 15 | 0.0% | -0.697044 | 0.000 | -0.643249 | -0.697044 |

基准成本后净收益：0.098304。
失败项：minimumEvents, monthConcentration, extremeSingleLegDelay

- All observations are exposed D0 development data and cannot prove out-of-sample profitability.
- The fixed eight-base panel was selected after archive coverage inspection and is not a point-in-time full-market universe.
- Contract and FX 5m opens plus fixed slippage cannot prove that both live legs would fill simultaneously.
- The extreme one-bar leg delay is deterministic and is not an order-book or outage replay.
- Nine of fifteen pairs occurred in the same 2025-10-10 market episode, which supplied 88.6% of total stress net return.
- USDC settlement cash flows are converted with spot bar opens; collateral haircuts, cross-margin rules and conversion fees are absent.
- Return-unit drawdown orders overlapping event exits and is not leveraged account equity drawdown.
- A pass would still require a new full-universe replication, order-book shadow fills and forward evidence.
