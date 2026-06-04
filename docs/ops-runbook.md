# Pipeline 排查手册

在 VPS 上排查 Counterpart Monitor 的运行情况。所有命令在项目根目录执行。

## 前置

如果服务跑在 Docker 里，先进容器：

```bash
docker compose exec monitor sh
```

如果 VPS 上没有 `sqlite3`，下面统一用 `bun -e` 查库。

---

## 0. 快速健康检查

```bash
# 最近一次运行是否成功
cat data/health.json

# Docker 日志（最近 6 小时的关键事件）
docker compose logs --since 6h 2>&1 | grep -E '\[Scheduler\]|\[Pipeline\]|\[Report\]|\[Dispatch\]'
```

---

## 1. 计算当前报告时间窗口

后续 SQL 查询都需要 `startUnix` / `endUnix`，先算出来：

```bash
# 日报窗口（上海时间昨天）
bun -e "
import { getYesterdayPeriod } from './src/utils/time-window.ts';
const p = getYesterdayPeriod('Asia/Shanghai');
console.log('daily startUnix:', p.startUnix, ' →', new Date(p.startUnix*1000).toISOString());
console.log('daily endUnix:  ', p.endUnix, ' →', new Date(p.endUnix*1000).toISOString());
"

# 周报窗口（上海时间过去 7 个完整自然日）
bun -e "
import { getWeekPeriod } from './src/utils/time-window.ts';
const p = getWeekPeriod('Asia/Shanghai');
console.log('weekly startUnix:', p.startUnix, ' →', new Date(p.startUnix*1000).toISOString());
console.log('weekly endUnix:  ', p.endUnix, ' →', new Date(p.endUnix*1000).toISOString());
"
```

记下输出的 `startUnix` 和 `endUnix`，替换到下面 SQL 的 `$START` 和 `$END`。

---

## 2. Collect 阶段 — 抓了多少 PR

```bash
# 按项目统计 PR 数量
sqlite3 data/monitor.db "
SELECT project_id, COUNT(*) as pr_count
FROM pull_requests
WHERE merged_at BETWEEN $START AND $END
GROUP BY project_id;
"

# 查看具体 PR 列表
sqlite3 data/monitor.db "
SELECT project_id, pr_number, title, author,
       datetime(merged_at, 'unixepoch') as merged_utc,
       diff_status, analysis_status
FROM pull_requests
WHERE merged_at BETWEEN $START AND $END
ORDER BY project_id, merged_at;
"
```

关注点：
- `diff_status`：`available` 正常，`too_large` 表示 diff 超 2MB 未存储，`fetch_failed` 需要排查 GitHub API
- `analysis_status`：`complete` 正常，`pending` 表示还没分析，`failed` / `budget_skipped` 需要关注

---

## 3. Analyze 阶段 — LLM 分析结论

```bash
# 每个 PR 的分析结果
sqlite3 -header -column data/monitor.db "
SELECT a.id, p.project_id, p.pr_number, p.title,
       a.significance, a.direction_signal,
       substr(a.summary, 1, 80) as summary_preview,
       a.model_id,
       a.input_tokens, a.output_tokens,
       printf('\$%.4f', a.estimated_cost_usd) as cost
FROM analyses a
JOIN pull_requests p ON a.pr_id = p.id
WHERE p.merged_at BETWEEN $START AND $END
ORDER BY
  CASE a.significance
    WHEN 'directional_shift' THEN 0
    WHEN 'notable' THEN 1
    ELSE 2
  END,
  p.project_id;
"
```

关注点：
- `significance`：`directional_shift` > `notable` > `routine`，这决定了 PR 在日报中的展示层级
- `direction_signal`：方向性判断的文字说明，只有 notable 和 directional_shift 才有
- `cost`：单次分析成本，正常范围 $0.02-0.04

---

## 4. Analysis Inputs — LLM 实际看到了什么

```bash
sqlite3 -header -column data/monitor.db "
SELECT ai.analysis_id,
       p.project_id, p.pr_number,
       ai.input_quality,
       ai.diff_included_files, ai.diff_total_files,
       ai.diff_truncated,
       ai.prompt_version
FROM analysis_inputs ai
JOIN analyses a ON ai.analysis_id = a.id
JOIN pull_requests p ON a.pr_id = p.id
WHERE p.merged_at BETWEEN $START AND $END
ORDER BY p.project_id;
"
```

关注点：
- `input_quality`：`full` 最好，`truncated` 表示 diff 被截断（仍可分析），`no_diff` 表示没有 diff（分析仅基于标题/描述）
- `diff_truncated`：1 表示 diff 超过 8000 token 预算被截断
- `diff_included_files` vs `diff_total_files`：截断后保留了多少文件

---

## 5. Report 阶段 — 报告生成和投递

```bash
# 查看报告记录
sqlite3 -header -column data/monitor.db "
SELECT id, type,
       datetime(period_start, 'unixepoch') as period_start_utc,
       datetime(period_end, 'unixepoch') as period_end_utc,
       completeness,
       datetime(created_at, 'unixepoch') as created_utc
FROM reports
ORDER BY created_at DESC
LIMIT 10;
"

# 查看投递状态
sqlite3 -header -column data/monitor.db "
SELECT r.type, r.id as report_id,
       d.card_index, d.status, d.lark_message_id,
       datetime(d.sent_at, 'unixepoch') as sent_utc
FROM report_deliveries d
JOIN reports r ON d.report_id = r.id
ORDER BY d.id DESC
LIMIT 10;
"
```

关注点：
- `status`：`sent` 正常，`pending` 表示还没发（dispatch 阶段没跑或失败），`failed` 需要查日志
- `lark_message_id`：Lark 返回的消息 ID，非空说明确实发出去了
- `completeness`：JSON 格式，记录了本次有多少项目成功/失败

---

## 6. 查看报告 JSON 文件

```bash
# 列出所有报告文件
ls -la data/reports/

# 查看最新日报的卡片标题和摘要
cat data/reports/daily-2026-06-03.json | python3 -m json.tool | head -40

# 如果没有 python3，用 bun
bun -e "
const text = await Bun.file('data/reports/daily-2026-06-03.json').text();
const r = JSON.parse(text);
const cards = Array.isArray(r) ? r : [r];
for (const c of cards) {
  console.log('Title:', c.header?.title?.content);
  console.log('Template:', c.header?.template);
  for (const el of c.elements ?? []) {
    if (el.tag === 'markdown') console.log(el.content.slice(0, 300), '\n');
  }
}
"
```

---

## 7. 成本统计

```bash
# 本月 LLM 成本
sqlite3 data/monitor.db "
SELECT COUNT(*) as total_analyses,
       SUM(input_tokens) as total_input,
       SUM(output_tokens) as total_output,
       printf('\$%.2f', SUM(estimated_cost_usd)) as total_cost
FROM analyses
WHERE analyzed_at >= unixepoch('now', 'start of month');
"

# 按天统计成本趋势
sqlite3 -header -column data/monitor.db "
SELECT date(analyzed_at, 'unixepoch') as day,
       COUNT(*) as analyses,
       printf('\$%.2f', SUM(estimated_cost_usd)) as cost
FROM analyses
WHERE analyzed_at >= unixepoch('now', '-30 days')
GROUP BY day
ORDER BY day;
"
```

---

## 8. 审计导出

导出指定时间段的分析记录为 JSON 文件：

```bash
bun run src/index.ts --export-audit \
  --since 2026-06-03 \
  --until 2026-06-04 \
  --output data/audit-20260603.json
```

---

## 9. 手动触发 pipeline

```bash
# 日报模式（不发送 Lark）
bun run src/e2e-run.ts --mode daily --no-dispatch

# 日报模式（发送 Lark）
bun run src/e2e-run.ts --mode daily

# 周报模式
bun run src/e2e-run.ts --mode weekly
```

---

## 常见问题速查

| 现象 | 可能原因 | 排查 |
|------|---------|------|
| 日报 "no deliverable PRs" | 时间窗口内没有 merge 的 PR | 第 2 步查 PR 数量 |
| analysis_status = failed | LLM API 调用失败 | `docker compose logs` 搜 `[LLM]` |
| analysis_status = budget_skipped | 月度 LLM 预算用完 | 第 7 步查成本 |
| diff_status = too_large | PR diff 超过 2MB | 正常，分析基于标题/描述 |
| delivery status = failed | Lark webhook 调用失败 | `docker compose logs` 搜 `[Dispatch]` |
| 日报日期错一天 | formatDate 用了 UTC 而非业务时区 | v0.1.1 已修复 |
