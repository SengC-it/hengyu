# 本地实时 Worker

根目录的 `start-live-worker.bat` 是双击入口。它会启动本地实时链路：

1. 连接 Binance USD-M 公共深度、成交、强平和资金费率数据；
2. 每分钟完成一次 H9 压力窗口评估；
3. 只生成 `PAPER_ONLY` 的人工复核信号；
4. 通过签名请求写入 Vercel API，再写入 Supabase `hengyu_advisories` 和 `hengyu_email_outbox`；
5. 触发邮件 outbox 派发；Vercel 或 Supabase 暂时不可用时，信号保存在 `data/live/pending-advisories.ndjson`，恢复后自动重试。

## 第一次启动

双击 `start-live-worker.bat`。如果没有 `.env.live.local`，脚本会从 `config/live-worker.env.example` 创建并打开它。

只需要填写：

- `HENGYU_API_BASE_URL`：当前生产站点，例如 `https://hengyu-research.vercel.app`；
- `HENGYU_INGEST_SECRET`：必须与 Vercel 环境变量中的值完全一致。

默认只扫描 `BTCUSDT`。确认链路稳定后，可把 `HENGYU_WORKER_SYMBOLS` 改成逗号分隔的合约，例如 `BTCUSDT,ETHUSDT`。不要把 Supabase service-role key、Gmail App Password 或 Gmail OAuth 密钥放进本地 worker；它们只应配置在 Vercel 的服务端环境变量中。

## Vercel 端需要的环境变量

要真正写 Supabase 并发送邮件，生产环境需要配置：

- `HENGYU_SUPABASE_URL`
- `HENGYU_SUPABASE_SECRET_KEY`（Supabase service-role key，仅服务端）
- `HENGYU_INGEST_SECRET`
- `HENGYU_GMAIL_FROM_ADDRESS`
- `HENGYU_GMAIL_TO_ADDRESS`
- `HENGYU_GMAIL_APP_PASSWORD`

这三个变量即可通过 Gmail SMTP 发送提醒。旧的 Gmail API OAuth 变量只作为兼容 fallback，不是必需配置。

## 信号和复盘规则

现有 H9 事件本身没有 TP，因此 worker 默认使用：

`TP = 邮件入场价 ± 1.0 × 事件冲击幅度`

这个倍数可用 `HENGYU_WORKER_TP_MULTIPLIER` 修改。邮件固定包含入场、止损、止盈三档，复盘只按邮件中的三档执行：TP/SL 首次触发即结算；两者都未触发就继续持仓，不按 `expires_at` 做时间平仓。

H9 仍需先完成 30 天压力历史预热；预热期间 worker 可以正常运行、保存状态和发送 heartbeat，但不会生成可用信号。状态保存在 `data/live/state.json`，只保存压力窗口，不保存高频原始盘口，适合长期运行。

窗口打开后不要关闭它。关闭或休眠电脑会停止实时采集；重新打开 BAT 后会从本地状态继续，但中断期间缺失的数据不会被伪造补齐。
