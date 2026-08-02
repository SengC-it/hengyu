# HY-EXP-0012 结果

结论：`EXACT_SPECIFICATION_ELIMINATED`。本结果只属于D0开发筛选。

固定日程产生 116 个周组合，98 个通过数据和容量规则。

| 情景 | 周组合 | 胜率 | 毛价格收益 | 资金费 | 净收益单位 | PF | 去最佳5周 | 最大回撤 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| base | 98 | 43.9% | 0.086721 | 0.008977 | -0.021832 | 0.980 | -0.471686 | -0.452763 |
| stress | 98 | 41.8% | 0.086721 | 0.008977 | -0.139363 | 0.879 | -0.582631 | -0.535101 |
| extreme | 98 | 41.8% | 0.086721 | 0.008977 | -0.296070 | 0.761 | -0.730557 | -0.644885 |
| delay5m | 98 | 41.8% | 0.083677 | 0.008976 | -0.142425 | 0.876 | -0.585711 | -0.536857 |

跳过原因：{"reference_capacity":18}
失败项：minimumEvents, stressProfitFactor, positiveNet, withoutBest5Events, maxDrawdown, symbolBreadth, bothAltSleeves, bothBtcTrendRegimes, halfYearBreadth, monthConcentration, symbolConcentration, extremePositive, delay5mPositive, delay5mProfitFactor

## 收益来源诊断

- 每周组合平均毛价格收益只有 +8.85 bps，低于冻结的基础交易摩擦；因此基础情景已经亏损 -0.021832，PF 0.980。
- 压力情景净收益 -0.139363、PF 0.879、最大回撤 -0.535101，平均每周组合净亏损 14.22 bps。
- 2024年11月单月贡献 +0.362563；排除该月后压力净收益为 -0.501926，结果具有明显时间集中。
- BTC事前上涨状态贡献 +0.310843，而下跌状态贡献 -0.450206；2025上半年、2025下半年和2026上半年全部亏损。
- 压力情景中，多头赢家腿 -0.056988、空头输家腿 +0.023650、BTC对冲腿 -0.106025。事前Beta中性没有带来稳定的事后市场中性收益。
- 最佳5周合计 +0.443268；删除后净收益为 -0.582631，盈利依赖少数时期。

精确H8规格淘汰。查看结果后不得事后只交易BTC上涨状态、删除对冲腿、降低容量门槛或更换窗口；这些都必须作为新的预注册假设，并继续计入试验次数。

- All observations are exposed D0 development data and cannot prove out-of-sample profitability.
- The fixed 16-symbol panel has survivor bias and is not a point-in-time full-market universe.
- Residual momentum uses a backward-looking linear BTC beta; nonlinear factor and sector exposures remain.
- Weekly full turnover is charged conservatively, but a 5m open plus fixed slippage is not a bid/ask or order-book fill.
- The one-day skip and 28-day horizon are a single preregistered specification, not evidence that neighboring horizons fail or pass.
- Return-unit drawdown is not leveraged account equity drawdown or a liquidation simulation.
- A pass would still require point-in-time universe replication and forward shadow evidence.
