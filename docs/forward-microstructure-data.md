# 前向微观结构数据协议

## 数据流

新模型依赖实际可成交和强平事件，不再把K线代理当作等价数据。当前币安USDⓈ-M官方WebSocket路由为：

| 数据 | 官方流 | 路由 | 用途 |
|---|---|---|---|
| 逐笔聚合成交 | `<symbol>@aggTrade` | `/market` | 主动成交方向、成交量和冲击路径 |
| 强平事件 | `<symbol>@forceOrder` / `!forceOrder@arr` | `/market` | 强平方向和名义金额 |
| 最优买卖价 | `<symbol>@bookTicker` | `/public` | 可成交价和价差 |
| 本地盘口增量 | `<symbol>@depth@100ms` | `/public` | 深度、冲击和恢复 |
| 标记价格 | `<symbol>@markPrice@1s` | `/market` | 资金费和风险估值 |

币安文档明确要求本地盘口先缓存增量、获取REST快照，再检查 `U/u/pu` 连续性；出现缺口必须重建盘口，不能把缺口当成可交易深度。[本地盘口管理规则](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/websocket-market-streams/How-to-manage-a-local-order-book-correctly)

官方文档还说明聚合成交按同一主动订单、价格和时间聚合，并且RPI订单不带可区分标签。[聚合成交接口](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data#compressed-aggregate-trades-list) 因此成交方向特征必须保留这一限制，不能声称观察到了完整订单流。

强平和普通聚合成交必须分开保存。强平流是事件数据，不允许从普通成交反推强平标签；普通成交也不应把保险基金或ADL交易当成普通主动成交。

## 时间和完整性

- 每条原始消息保存 `receivedAt`、源事件时间、流名、symbol、原始payload哈希；
- 每日文件完成后写入SHA-256清单，文件只追加不覆盖；
- WebSocket断线、`pu !== previous.u`、REST快照落后于首个增量或订阅重连必须产生显式缺口记录；
- 所有候选的信号时间必须晚于所使用的最后一条消息时间；
- 盘口特征必须使用当时的本地盘口，不得用事后盘口回填；
- 合约状态、tickSize、stepSize、minNotional和手续费等级每日留存。

OI历史REST接口当前只提供最近一个月，因此它不能单独承担长期历史回测；需要长期OI时必须使用已锁定的官方归档或从冻结边界后开始持续采集。[官方OI说明](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data#open-interest-statistics)

## 安全边界

本协议只读取公开市场流，不读取API密钥，不调用交易端点，不改变 `PAPER_ONLY`。任何未来的影子盘必须把“模型建议成交”和“实际可成交盘口”分开记录；影子盘也不自动授权真钱下单。

## 进入PnL前的验证

`npm.cmd run forward:validate -- <capture-directory>` 会先核对清单中的文件哈希，再检查事件字段、强平方向、未来时间戳、重复记录以及本地盘口的快照对齐和 `pu` 连续性。验证器返回 `valid` 前，采集目录不得进入H9收益计算；`not_ready` 或 `invalid` 只能计入数据质量统计。
