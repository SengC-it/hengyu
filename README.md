# 衡域研究 / Hengyu Research

`hengyu-research` 是一个全新的币安永续合约策略研究项目。它不是“恒势永续”的后续版本，也不继承旧项目的入场、退出、分层或参数。

当前阶段只建设研究治理、数据边界、可审计实验登记和最小研究实验。项目没有下单接口，不部署服务，且永久保持：

```json
{
  "authorization": "PAPER_ONLY",
  "liveOrdersEnabled": false
}
```

首个预注册实验 `HY-EXP-0001` 已完成并被淘汰：压力情景 416 笔、PF 0.607，净收益单位 -1.0819。完整证据见 [实验报告](artifacts/HY-EXP-0001/report.md)。

第二个独立机制实验 `HY-EXP-0002` 在收益计算前被严格数据质量门槛终止：官方 2026-06 归档的 8 个币种均缺少完整一天的 premium index 与 mark price 5 分钟数据。该实验没有 PnL 结论，详情见 [失败报告](artifacts/HY-EXP-0002/failure-report.md)。

使用相同经济规则、但截至最后完整月份的 `HY-EXP-0003` 只产生 6 笔交易：压力情景 0 胜、PF 0、净收益单位 -0.11535，固定规格已淘汰。详情见 [实验报告](artifacts/HY-EXP-0003/report.md)。

第三个独立机制 H3 在解决官方 OI 发布时间与重复快照问题后，由 `HY-EXP-0006` 完成 103 个事件组合：毛收益平均约 +1.35 bps/事件，但压力 PF 0.220、净收益单位 -0.23389，固定横截面规则淘汰。详情见 [实验报告](artifacts/HY-EXP-0006/report.md)。

第四个独立机制 H4 的 `HY-EXP-0008` 在理想同步成交下压力净收益单位 +0.07876、PF 36.723，但只有15个事件，88.6%的压力净收益来自2025-10-10单次市场冲击；任一腿延迟5分钟后15/15全部亏损、净收益单位 -0.69704，因此固定双合约收敛规则淘汰。详情见 [实验报告](artifacts/HY-EXP-0008/report.md)。

第五个独立机制 H5 的 `HY-EXP-0009` 完成54个不重叠事件组合：未计成本毛收益平均 -11.25 bps/事件，压力净收益单位 -0.19032、PF 0.134，多空两侧、BTC涨跌冲击和5/5个半年区间均亏，固定反应时差收敛规则淘汰。详情见 [实验报告](artifacts/HY-EXP-0009/report.md)。

第六个独立机制 H6 的 `HY-EXP-0010` 在压力情景下13个双周组合净收益单位+0.12510、PF 1.981，实际资金费扣执行成本后仍为+0.00470；但样本不足，删除最佳5期后亏损0.06000，低资金费多头侧亏损，且ETH单币贡献全部净收益的100.3%。固定资金费率携带规格因此淘汰。详情见 [实验报告](artifacts/HY-EXP-0010/report.md)。

第七个独立机制 H7 的 `HY-EXP-0011` 完成18笔跨资产相对价值交易：压力净收益单位+0.02958、PF 1.370，极端成本与延迟5分钟仍盈利；但只有1/18交易真正穿越冻结中心，最佳5笔贡献总净收益的293.2%，删除后亏损0.05716，且交易数和月份集中度不达标。固定跨资产收敛规格淘汰。详情见 [实验报告](artifacts/HY-EXP-0011/report.md)。

第八个独立机制 H8 的 `HY-EXP-0012` 完成98个周频残差动量组合：平均毛价格收益约+8.85 bps/组合，但基础净收益单位已为-0.02183；压力净收益单位-0.13936、PF 0.879、最大回撤-0.53510。2024年11月贡献+0.36256，排除该月后为-0.50193；多头腿及BTC对冲腿亏损，固定横截面残差动量规格淘汰。详情见 [实验报告](artifacts/HY-EXP-0012/report.md)。

盈利模型已重构为 `HENGYU-NET-EDGE-001`：候选必须先通过逐档盘口成本、双边手续费、延迟/冲击缓冲、资金费压力、不确定性下界和组合风险门控，失败即 `NO_TRADE`。该模型是研究内核，不是盈利证明或下单策略。详见 [盈利模型V2](docs/profit-model-v2.md) 和 [前向微观结构数据协议](docs/forward-microstructure-data.md)。

第九轮 `HY-EXP-0013` 已预注册真实强平压力与盘口恢复的前向验证：先进行30天数据暖机，再按冻结的99.5%强平压力分位数、5秒深度恢复、2秒成交延迟和15分钟上限验证。当前没有PnL结论；公开流烟测因网络失败收到0条消息，已明确记录为失败采集，不计入样本。详见 [第九轮实验](docs/ninth-round-experiment.md)。

## 证据状态

- 2026-07-30（Asia/Shanghai）结束前的所有市场数据均为已暴露开发数据。
- 开发数据只能提出、排除和压力测试假设，不能证明策略具备实盘价值。
- 只有规则冻结后、市场事件时间不早于 `2026-07-30T16:00:00.000Z` 的数据，才可能进入前向验证。
- 至少同时完成 180 个日历日和 100 笔已关闭交易之前，不得宣布具备实盘价值。
- 未经单独、明确批准，不得增加真钱下单能力。

## 文档

- [研究章程](docs/research-charter.md)
- [数据边界](docs/data-boundary.md)
- [旧项目基础设施审计](docs/infrastructure-audit.md)
- [候选假设与淘汰条件](docs/hypotheses.md)
- [实验登记规则](docs/experiment-registry.md)
- [第一轮最小实验](docs/first-round-experiment.md)
- [第二轮最小实验](docs/second-round-experiment.md)
- [第三轮最小实验](docs/third-round-experiment.md)
- [第四轮最小实验](docs/fourth-round-experiment.md)
- [第五轮最小实验](docs/fifth-round-experiment.md)
- [第六轮最小实验](docs/sixth-round-experiment.md)
- [第七轮最小实验](docs/seventh-round-experiment.md)
- [第八轮最小实验](docs/eighth-round-experiment.md)
- [盈利模型 V2](docs/profit-model-v2.md)
- [前向微观结构数据协议](docs/forward-microstructure-data.md)
- [第九轮前向实验](docs/ninth-round-experiment.md)
- [合约交易系统亏损风险审计](docs/system-loss-audit-2026-07-30.md)

## 本地验证

```powershell
npm.cmd test
npm.cmd run registry:verify
```

### HY-EXP-0014 只读信号层

新一轮 `HY-EXP-0014` 已冻结为点时动态全 USD-M 宇宙和可成交净优势门槛。它仍处于 `F0_PENDING`，不代表盈利。

```powershell
# 生成点时动态币种快照（只读公共接口）
npm.cmd run universe:snapshot -- --policy config/universe-policy.json

# 通过合规代理开始动态公共数据采集
npm.cmd run forward:capture:dynamic:proxy -- --seconds 86400

# 本地只读信号页面/API
npm.cmd run advisory:server
```

候选评估输出只包含方向、参考价格、失效时间和成本；数量、杠杆、账户风险和任何下单接口均不会输出。分级提醒写入 `data/advisory-outbox.ndjson`，需要你提供邮件供应商凭据后再接入投递适配器。

下载和运行已预注册的第一轮开发样本实验：

```powershell
npm.cmd run exp:001:download
npm.cmd run exp:001:run
```

原始市场数据不会提交到 Git；数据清单、SHA-256、逐笔结果和失败状态必须作为实验工件登记。
