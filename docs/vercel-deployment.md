# Vercel 只读部署

## 当前部署

- 项目：`hengyu-research`
- 生产地址：<https://hengyu-research.vercel.app>
- 运行模式：`SIGNAL_ONLY` / `PAPER_ONLY`
- 真实下单：永久关闭（`liveOrdersEnabled=false`、`orderPlacementEnabled=false`）
- Hobby Cron：每天一次 `/api/cron-health`，只记录服务心跳；每 60 秒的信号评估必须由外部采集器调用 `/api/ingest`

生产部署验收的公开接口：

- `/`：只读信号页
- `/api/health`：安全状态和配置状态
- `/api/dashboard`：信号与邮件 outbox 的脱敏读模型
- `/api/h12-scan`：受保护的 H12 公开行情扫描；只写入纸面提醒和扫描诊断
- `/api/review`：已实际发送信号的 TP/SL 首触复盘和价格收益统计
- `/api/signals`、`/api/alerts`：分页只读接口

## 必需的托管配置

部署本身不把任何密钥写入 GitHub 或 Vercel 源码。需要在 Vercel 项目环境变量中单独设置：

- `HENGYU_SUPABASE_URL`
- `HENGYU_SUPABASE_SECRET_KEY`（只在服务端使用，不能放到网页）
- `HENGYU_INGEST_SECRET`
- `HENGYU_CRON_SECRET`
- `HENGYU_PAPER_ONLY=true`
- `HENGYU_LIVE_ORDERS_ENABLED=false`

部署前必须先应用候选引擎诊断迁移，并确认 `hengyu_scan_diagnostics` 已启用 RLS、匿名/认证角色无读写权限、`service_role` 只有应用所需权限。迁移不会创建下单表、交易所账户权限或订单函数。

启用 Gmail outbox 发送只需要配置 `HENGYU_GMAIL_FROM_ADDRESS`、`HENGYU_GMAIL_TO_ADDRESS`、`HENGYU_GMAIL_APP_PASSWORD`。实现使用 Gmail SMTP App Password；`HENGYU_GMAIL_SEND_ENABLED` 默认不需要设置。旧的 Gmail API OAuth 变量仍作为兼容 fallback，但不应与 SMTP 配置混用。没有这些变量时，邮件接口只返回未配置状态，不会尝试发送。

## 数据与盈利状态

当前 `/api/health` 的生产结果为 `degraded`（密钥未配置），`/api/dashboard` 返回空信号和 `dataStatus=not_configured`。这不是盈利结论；`/api/review` 只在邮件真实发送且行情证据可用时计算价格收益，未确认的 TP/SL 先后不会被算作盈亏。

Vercel 无长连接采集器能力。原始盘口/成交流应在可长期运行的合规采集环境中保存，并通过签名的 `/api/ingest` 分片写入 Supabase；断线、序列缺口、过期盘口或 funding 失败时，采集器必须上报不可用于 PnL 的 segment。

## 本轮生产前 checklist

- `npm.cmd test` 全部通过；`npm.cmd run registry:verify` 通过。
- `HY-EXP-0018` 在 Dashboard 中明确显示 `pass=false`；不得把其历史结果包装为已验证策略。
- H12 dry-run 确认入场价来自 bid/ask/depth，不是 4h `open`；确认 `schedulerDelayMs` 超限只产生 `MISSED_SIGNAL`。
- Dashboard 能看到 `NO_SIGNAL`、regime/breadth、每币突破距离、盘口/funding/Net Edge 拒绝原因。
- 应用 migration 后，用无 funding、过期盘口、无深度和 sideways 数据各做一次拒绝测试，并确认均不产生可交易提醒。
- Gmail 仅使用提醒投递凭据；确认 outbox 为 `SENDING` 时不会并发重复发送，失败会退避重试并最终标记 `FAILED`。
- `PAPER_ONLY`、`SIGNAL_ONLY`、`liveOrdersEnabled=false`、`orderPlacementEnabled=false`、`accountAccess=false` 在 health/dashboard/ingest 中一致。
- 未配置 Binance API key、账户读取权限、杠杆、仓位或订单端点；不自动合并、不启用真钱交易。
