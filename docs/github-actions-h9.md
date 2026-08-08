# GitHub Actions H9 采集器

`.github/workflows/hengyu-h9.yml` 使用 Hengyu 现有的 `scripts/live-worker.mjs`，每 30 分钟启动一次，并在每次运行中监听 25 分钟：

```text
GitHub Actions
  -> Binance USD-M public streams
  -> Hengyu LiveH9Scanner
  -> POST /api/ingest (HENGYU_INGEST_SECRET 签名)
  -> Hengyu Supabase hengyu_advisories / hengyu_system_heartbeats
```

每次运行结束时，GitHub Actions Cache 保存 `data/live/state.json` 和待重试队列，下一次运行恢复。这样 H9 的压力窗口可以跨运行累积；不会用不存在的历史数据伪造信号。

## 必须配置的变量

在 GitHub 仓库的 Settings → Secrets and variables → Actions 中配置：

| 类型 | 名称 | 用途 |
| --- | --- | --- |
| Secret | `HENGYU_INGEST_SECRET` | 必须与 Vercel 的同名环境变量完全一致 |
| Secret（可选） | `HENGYU_API_BASE_URL` | 默认是 `https://hengyu-research.vercel.app` |
| Variable（可选） | `HENGYU_WORKER_SYMBOLS` | 逗号分隔的 USD-M 合约，默认 `BTCUSDT` |
| Variable（可选） | `HENGYU_WORKER_TP_MULTIPLIER` | H9 默认 `1`，按信号邮件入场价计算 TP |
| Variable（可选） | `HENGYU_WORKER_ALERT_LEVEL` | 默认 `MEDIUM` |

Vercel 生产环境还必须已经配置：

- `HENGYU_INGEST_SECRET`
- `HENGYU_SUPABASE_URL`
- `HENGYU_SUPABASE_SECRET_KEY`（或项目现有的 `SUPABASE_SERVICE_ROLE_KEY`）

如果需要邮件提醒，还要在 Vercel 配置 Gmail SMTP 的三个变量：

- `HENGYU_GMAIL_FROM_ADDRESS`
- `HENGYU_GMAIL_TO_ADDRESS`
- `HENGYU_GMAIL_APP_PASSWORD`

这三项通过 Gmail SMTP App Password 发送邮件，不需要 Gmail Client ID。GitHub Actions 不需要保存 Gmail 密码；worker 只调用 Hengyu API。`/api/health` 的 `gmailConfigured` 会在三项齐全时变为 `true`。

Workflow 不直接携带 Supabase service-role key；它只调用 Hengyu API，由 Vercel 服务端写入 Hengyu Supabase。可用 `GET /api/health` 检查 `ingestConfigured` 和 `supabase.configured` 是否都是 `true`。如果不是，workflow 会在启动采集前失败，避免“看似运行但没有入库”。

## 运行与限制

- Cron 表达式是 `*/30 * * * *`，按 UTC 解释；GitHub 的排队、延迟或漏跑属于可接受行为。
- `concurrency` 防止两个采集器同时写同一份 H9 状态。
- H9 需要先累积约 30 天压力历史；预热期间不会凭空生成可交易 H9 信号，但 heartbeat 仍会写入 Supabase。
- 25 分钟是采集任务的运行时长，不是信号的到期平仓时间。信号的复盘规则仍是 `ENTRY_FIXED_TP_SL_FIRST_TOUCH_NO_TIME_EXIT`：只按邮件里的入场、止损、止盈执行，TP/SL 谁先触碰谁结算，期间都没碰到就继续持仓。
- workflow 同时支持 `workflow_dispatch`，可在 GitHub Actions 页面手动启动一次。
