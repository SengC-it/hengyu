# HY-EXP-0004 失败报告

结论：`DATA_QUALITY_FAILURE_NO_PNL_COMPUTED`

官方 metrics 日归档中有 1,075 条记录的 `create_time` 晚于 5 分钟整点 1–6 秒。103 个事件、16 个币种所需的 OI 截面中，AVAXUSDT 在事件 `2024-04-16T10:30:00Z` 缺少精确的 `2024-04-16T10:00:00Z` 记录。

预登记要求事件所需 OI 完整，因此实验在构建组合和计算 PnL 前终止。没有向下取整时间、删除 AVAX、跳过该事件或生成收益文件。

- 预登记 SHA-256：`a165ed0ddd729db2844f071255383d97583a4f8b76be68a4d800dbd04654efbd`
- 数据清单 SHA-256：`6e6287db3ce86a93ff22631f4e1311ffc27f2434d62a92fffb4232618965c044`
- 执行代码 commit：`de33329`
- 结果与组合文件：未生成

任何 metrics 时间归一化必须使用新实验 ID 并在 PnL 前冻结。
