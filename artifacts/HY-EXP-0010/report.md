# HY-EXP-0010 结果

结论：`EXACT_SPECIFICATION_ELIMINATED`。本结果只属于D0开发筛选。

固定日程产生 62 个非重叠候选组合，13 个达到冻结的24 bp预测携带门槛及容量规则。

| 情景 | 组合事件 | 胜率 | 实际资金费 | 资金费扣执行成本 | 净收益单位 | PF | 去最佳5期 | 最大回撤 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| base | 13 | 76.9% | 0.035810 | 0.020254 | 0.140656 | 2.135 | -0.050449 | -0.085936 |
| stress | 13 | 76.9% | 0.035810 | 0.004698 | 0.125100 | 1.981 | -0.060001 | -0.087184 |
| extreme | 13 | 76.9% | 0.035810 | -0.016043 | 0.104359 | 1.789 | -0.072736 | -0.088847 |
| delay5m | 13 | 76.9% | 0.035849 | 0.004746 | 0.125941 | 2.002 | -0.059348 | -0.087471 |

跳过原因：{"insufficient_projected_carry":46,"reference_capacity":3}
失败项：minimumEvents, withoutBest5Events, bothAltSleeves

## 收益来源诊断

- 压力情景每期预测资金费收入平均41.81 bp，实际只有27.55 bp，兑现率65.9%；预测值与实际资金费的事件级相关系数为0.714。
- 实际资金费扣除压力手续费和滑点后只剩3.61 bp/期，说明存在微弱携带收入，但安全垫很薄。
- 压力净收益的81.7%来自滑点后的价格损益，而不是资金费现金流。
- 最佳5期合计盈利0.185101，达到全部压力净收益的148.0%；删除后亏损0.060001。
- ETH单币贡献0.125481，达到全部压力净收益的100.3%；删除ETH后组合亏损0.000381。
- 低资金费多头侧亏损0.023641，高资金费空头侧盈利0.116793，BTC对冲腿盈利0.031949。该结果依赖空头侧价格表现，不能证明对称、可重复的资金费率携带。

因此不能把正的总收益、PF或胜率解释为晋级。精确规格按预登记淘汰，也同时违反项目级“不得依赖单一币种”的标准。

- All observations are exposed D0 development data and cannot prove out-of-sample profitability.
- The fixed 16-symbol panel has survivor bias and is not a point-in-time full-market universe.
- Trailing realized funding is observable after settlement, but historical API publication latency is not archived; the frozen 10m entry delay is a conservative proxy.
- A 5m open plus fixed slippage is not a bid/ask or order-book fill.
- The portfolio is beta neutral only under a backward-looking linear estimate; nonlinear and intraperiod basis risks remain.
- Return-unit drawdown is not leveraged account equity drawdown or a liquidation simulation.
- The premium-index archive is validated for completeness but is not used to select or tune this experiment.
- A pass would still require point-in-time universe replication and forward shadow evidence.
- ETH alone contributes 100.3% of stress net return and removing ETH makes stress net return slightly negative; this also fails the project-wide no-single-symbol-dependence requirement even though the preregistered profitable-symbol count passes.
