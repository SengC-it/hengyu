# HY-EXP-0011 结果

结论：`EXACT_SPECIFICATION_ELIMINATED`。本结果只属于D0开发筛选。

共执行 18 笔非重叠配对交易。

| 情景 | 交易 | 胜率 | 毛价格收益 | 资金费 | 净收益单位 | PF | 去最佳5笔 | 去最佳5入场日 | 最大回撤 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| base | 18 | 61.1% | 0.038936 | 0.001324 | 0.034920 | 1.448 | -0.053269 | -0.053269 | -0.053612 |
| stress | 18 | 61.1% | 0.038936 | 0.001324 | 0.029581 | 1.370 | -0.057163 | -0.057163 | -0.054904 |
| extreme | 18 | 50.0% | 0.038936 | 0.001324 | 0.022462 | 1.270 | -0.062355 | -0.062355 | -0.056626 |
| delay5m | 18 | 61.1% | 0.033689 | 0.001345 | 0.024337 | 1.291 | -0.060329 | -0.060329 | -0.059499 |

按配对检测跳过：{"BTC_LTC":{},"ETH_ETC":{"reference_capacity":1},"SOL_AVAX":{},"ADA_DOT":{}}
失败项：minimumTrades, withoutBest5Trades, withoutBest5EntryDays, monthConcentration

## 收益来源诊断

- 压力情景平均毛价格收益21.63 bp/交易，净收益16.43 bp/交易；资金费平均只有0.74 bp/交易。
- 18笔交易中只有1笔真正穿越入场时冻结中心，另外17笔均在7天上限退出，实际中心穿越率仅5.6%。正收益不能证明预登记的中心收敛机制成立。
- 最佳5笔合计收益0.086744，是全部压力净收益的293.2%；删除后亏损0.057163。
- 最大盈利交易为2025-02-26的BTC/LTC，单笔贡献0.025387；删除该笔后只剩0.004194。
- 压力正收益月份的最大贡献占40.66%，超过冻结的40%上限。ETH/ETC合计亏损0.020054，其他三组盈利。

因此不能用正的总收益、PF 1.370或极端/延迟场景仍盈利来晋级。精确规格按预登记淘汰；不得事后延长持有期、删除ETH/ETC或降低3σ门槛。

- All observations are exposed D0 development data and cannot prove out-of-sample profitability.
- The four fixed economic pairs and their surviving contracts are selected with hindsight.
- Economic similarity does not guarantee cointegration; rolling zscore can mistake structural divergence for temporary dislocation.
- The beta hedge is a backward-looking linear estimate and can fail abruptly during regime changes.
- A 5m open plus fixed slippage is not a bid/ask or order-book fill, and both pair legs are not atomic.
- The 25% pair allocation caps simultaneous gross exposure but does not simulate exchange margin, liquidation or correlation stress.
- Return-unit drawdown is not leveraged account equity drawdown.
- A pass would still require point-in-time pair formation, formal stability diagnostics and forward shadow evidence.
- Only 1/18 trades crossed the frozen center; the other 17 maximum-hold exits make the observed profit weak evidence for the preregistered convergence mechanism.
