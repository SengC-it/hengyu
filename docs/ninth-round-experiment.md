# 第九轮前向实验：HY-EXP-0013

## 目的

H1 使用成交量、主动成交和影线作为冲击代理，H4–H8 又分别暴露了理想成交、成本不足、样本集中和事后市场状态依赖的问题。H9 改用币安公开的真实强平事件和本地盘口恢复，研究短持仓事件是否存在足以覆盖可成交成本的净优势。

这不是 H1 的参数迭代。H9 不使用K线影线阈值、固定成交量倍数、旧趋势突破、旧配对中心或H8的周频排名；强平流、逐笔成交和盘口更新必须从前向边界后重新采集。

## 冻结规则

- 固定六个币安USDⓈ-M永续合约：BTC、ETH、BNB、SOL、XRP、DOGE；
- 记录 `forceOrder`、`aggTrade`、`bookTicker`、`depth@100ms` 和 `markPrice@1s`；
- 先完成30天暖机，仅用于建立此前60秒窗口的强平压力和成交额分布；
- 强平压力为60秒净强平名义额/此前30分钟聚合成交额；阈值为截至当时的99.5%历史分位数；
- 净卖出强平后只允许研究做多，净买入强平后只允许研究做空；
- 事件结束后等待5秒，前五档10bps以内深度恢复至事件前中位数的80%以上，且价格不再创事件方向极值，才产生候选；
- 使用恢复决策后的第一个可用相反盘口报价，信号到成交超过2秒则跳过；
- 最长持有15分钟，或触发固定的0.75倍事件冲击止损；
- 同一币种30分钟冷却，同一UTC 5分钟桶视为一个事件簇；
- 使用净优势模型计算双边盘口、手续费、延迟、资金费和两倍盘口成本压力；
- 所有不完整、过期或序列断裂事件写入排除原因，不静默补齐。

## 验证闸门

H9必须同时达到至少180个前向日历日和100个已关闭事件，压力PF不低于1.30、压力净收益为正、删除最佳5个事件簇后仍盈利、最大回撤不超过20%，至少4/6币种盈利，多空两侧和至少3个半年区间盈利，且月度/币种集中度不过限。任一失败即淘汰精确规格。

直到闸门满足，任何结果都只是F0观察，不是实盘价值证明；当前仍为 `PAPER_ONLY`。

## 当前状态

规则已在 [预注册文件](../registry/experiments/HY-EXP-0013/preregistration.json) 中登记。2026-08-01的10秒公开流烟测因外部网络连接失败收到0条消息，已写入本地 `status: failed` 清单，不能计入H9样本；正式前向采集必须在连接稳定、盘口连续性可验证后开始。

## Forward capture update — 2026-08-01

Proxy-backed capture attempts 003, 004, and 005 passed hash, envelope, and
depth-sequence validation. Attempt 005 covered the frozen six-symbol universe
for 15 minutes and produced 291,512 accepted records. It remains warmup data:
no H9 event, closed trade, or PnL conclusion is reported until the 30-day
warmup and later forward promotion gates are met.

Capture attempt 006 requested a one-hour segment but failed through the proxy
route: both WebSocket endpoints errored and all six funding REST requests
returned HTTP 451. Its partial records are retained for diagnostics only and
are excluded from the H9 sample.
