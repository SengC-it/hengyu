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
- `/api/signals`、`/api/alerts`：分页只读接口

## 必需的托管配置

部署本身不把任何密钥写入 GitHub 或 Vercel 源码。需要在 Vercel 项目环境变量中单独设置：

- `HENGYU_SUPABASE_URL`
- `HENGYU_SUPABASE_SECRET_KEY`（只在服务端使用，不能放到网页）
- `HENGYU_INGEST_SECRET`
- `HENGYU_CRON_SECRET`
- `HENGYU_PAPER_ONLY=true`
- `HENGYU_LIVE_ORDERS_ENABLED=false`

启用 Gmail outbox 发送前，还必须配置 `HENGYU_GMAIL_CLIENT_ID`、`HENGYU_GMAIL_CLIENT_SECRET`、`HENGYU_GMAIL_REFRESH_TOKEN`、`HENGYU_GMAIL_FROM_ADDRESS`、`HENGYU_GMAIL_TO_ADDRESS`，并显式设置 `HENGYU_GMAIL_SEND_ENABLED=true`。没有这些变量时，邮件接口只返回未配置状态，不会尝试发送。

## 数据与盈利状态

当前 `/api/health` 的生产结果为 `degraded`（密钥未配置），`/api/dashboard` 返回空信号和 `dataStatus=not_configured`。这不是盈利结论；只有在采集器完成签名上报、数据质量通过、并满足注册表规定的前向样本门槛后，才允许计算模拟 PnL。

Vercel 无长连接采集器能力。原始盘口/成交流应在可长期运行的合规采集环境中保存，并通过签名的 `/api/ingest` 分片写入 Supabase；断线、序列缺口、过期盘口或 funding 失败时，采集器必须上报不可用于 PnL 的 segment。
