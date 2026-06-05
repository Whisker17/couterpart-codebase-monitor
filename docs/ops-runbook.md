# Pipeline 排查手册

在 VPS 上排查 Counterpart Monitor 的运行情况。所有命令在项目根目录执行。

## 前置

VPS 上没有 `sqlite3`，下面统一用 `docker compose exec monitor bun -e` 查库，数据库路径为 `/app/data/monitor.db`。

---

## Docker 运维

```bash
# 查看容器状态
docker compose ps

# 查看实时日志
docker compose logs -f --tail=50

# 查看最近 6 小时的关键事件
docker compose logs --since 6h 2>&1 | grep -E '\[Scheduler\]|\[Pipeline\]|\[Report\]|\[Dispatch\]|\[Collect\]|\[Analyze\]'

# 更新代码并重启（有代码变更时）
git pull origin main
docker compose down
docker compose up -d --build

# 强制重建（依赖有变更时）
docker compose down
docker system prune -a -f   # 清理旧镜像（磁盘紧张时用）
docker compose up -d --build
```

---

## 0. 快速健康检查

```bash
# 最近一次运行是否成功
docker compose exec monitor cat data/health.json

# 查看最新的 collect 时间（各项目上次同步到哪里）
docker compose exec monitor bun -e "
import { Database } from 'bun:sqlite';
const db = new Database('/app/data/monitor.db');
console.log(db.query('SELECT id, last_synced_at, datetime(last_synced_at, \"unixepoch\") as synced_utc FROM projects').all());
db.close();
"
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

将 `$START` / `$END` 替换为第 1 步算出的 unix 秒数。

```bash
# 按项目统计 PR 数量
docker compose exec monitor bun -e "
import { Database } from 'bun:sqlite';
const db = new Database('/app/data/monitor.db');
const START = \$START, END = \$END;
console.log(db.query('SELECT project_id, COUNT(*) as pr_count FROM pull_requests WHERE merged_at BETWEEN ? AND ? GROUP BY project_id').all(START, END));
db.close();
"

# 查看具体 PR 列表（diff 状态 + 分析状态）
docker compose exec monitor bun -e "
import { Database } from 'bun:sqlite';
const db = new Database('/app/data/monitor.db');
const START = \$START, END = \$END;
console.log(db.query('SELECT project_id, pr_number, title, diff_status, analysis_status FROM pull_requests WHERE merged_at BETWEEN ? AND ? ORDER BY project_id, merged_at').all(START, END));
db.close();
"
```

关注点：
- `diff_status`：`available` 正常，`too_large` 表示 diff 超 2MB 未存储，`fetch_failed` 需要排查 GitHub API
- `analysis_status`：`complete` 正常，`pending` 表示还没分析，`failed` / `budget_skipped` 需要关注

---

## 3. Analyze 阶段 — LLM 分析结论

```bash
docker compose exec monitor bun -e "
import { Database } from 'bun:sqlite';
const db = new Database('/app/data/monitor.db');
const START = \$START, END = \$END;
const rows = db.query(\`
  SELECT a.id, p.project_id, p.pr_number, p.title,
         a.significance, a.direction_signal,
         substr(a.summary, 1, 100) as summary_preview,
         a.input_tokens, a.output_tokens, a.estimated_cost_usd
  FROM analyses a
  JOIN pull_requests p ON a.pr_id = p.id
  WHERE p.merged_at BETWEEN ? AND ?
  ORDER BY CASE a.significance WHEN 'directional_shift' THEN 0 WHEN 'notable' THEN 1 ELSE 2 END, p.project_id
\`).all(START, END);
console.log(rows);
db.close();
"
```

关注点：
- `significance`：`directional_shift` > `notable` > `routine`，这决定了 PR 在日报中的展示层级
- `direction_signal`：方向性判断的文字说明，只有 notable 和 directional_shift 才有
- `cost`：单次分析成本，正常范围 $0.02-0.04

---

## 4. Analysis Inputs — LLM 实际看到了什么

```bash
docker compose exec monitor bun -e "
import { Database } from 'bun:sqlite';
const db = new Database('/app/data/monitor.db');
const START = \$START, END = \$END;
console.log(db.query(\`
  SELECT p.project_id, p.pr_number, ai.input_quality,
         ai.diff_included_files, ai.diff_total_files, ai.diff_truncated
  FROM analysis_inputs ai
  JOIN analyses a ON ai.analysis_id = a.id
  JOIN pull_requests p ON a.pr_id = p.id
  WHERE p.merged_at BETWEEN ? AND ?
  ORDER BY p.project_id
\`).all(START, END));
db.close();
"
```

关注点：
- `input_quality`：`full` 最好，`truncated` 表示 diff 被截断（仍可分析），`no_diff` 表示没有 diff（分析仅基于标题/描述）
- `diff_truncated`：1 表示 diff 超过 8000 token 预算被截断
- `diff_included_files` vs `diff_total_files`：截断后保留了多少文件

---

## 5. Report 阶段 — 报告生成和投递

```bash
# 查看最近报告记录
docker compose exec monitor bun -e "
import { Database } from 'bun:sqlite';
const db = new Database('/app/data/monitor.db');
console.log(db.query('SELECT id, type, period_start, period_end, completeness FROM reports ORDER BY created_at DESC LIMIT 10').all());
db.close();
"

# 查看投递状态
docker compose exec monitor bun -e "
import { Database } from 'bun:sqlite';
const db = new Database('/app/data/monitor.db');
console.log(db.query(\`
  SELECT r.type, r.id as report_id, d.card_index, d.status, d.lark_message_id
  FROM report_deliveries d JOIN reports r ON d.report_id = r.id
  ORDER BY d.id DESC LIMIT 10
\`).all());
db.close();
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
docker compose exec monitor ls -la data/reports/

# 查看某一天报告内容（替换日期）
docker compose exec monitor bun -e "
const text = await Bun.file('data/reports/daily-2026-06-03.json').text();
const r = JSON.parse(text);
const cards = Array.isArray(r) ? r : [r];
for (const c of cards) {
  console.log('Title:', c.header?.title?.content);
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
docker compose exec monitor bun -e "
import { Database } from 'bun:sqlite';
const db = new Database('/app/data/monitor.db');
const monthStart = Math.floor(new Date(new Date().toISOString().slice(0,7) + '-01').getTime() / 1000);
console.log(db.query('SELECT COUNT(*) as total_analyses, SUM(input_tokens) as total_input, SUM(output_tokens) as total_output, SUM(estimated_cost_usd) as total_cost FROM analyses WHERE analyzed_at >= ?').get(monthStart));
db.close();
"

# 按天统计成本趋势（最近 30 天）
docker compose exec monitor bun -e "
import { Database } from 'bun:sqlite';
const db = new Database('/app/data/monitor.db');
const since = Math.floor(Date.now()/1000) - 30*86400;
console.log(db.query('SELECT date(analyzed_at, \"unixepoch\") as day, COUNT(*) as analyses, SUM(estimated_cost_usd) as cost FROM analyses WHERE analyzed_at >= ? GROUP BY day ORDER BY day').all(since));
db.close();
"
```

---

## 8. 审计导出

```bash
docker compose exec monitor bun run src/index.ts --export-audit \
  --since 2026-06-03 \
  --until 2026-06-04 \
  --output data/audit-20260603.json
```

---

## 9. 手动触发 pipeline

```bash
# 日报（不发 Lark，用于调试）
docker compose exec monitor bun run src/e2e-run.ts --mode daily --no-dispatch

# 日报（发 Lark）
docker compose exec monitor bun run src/e2e-run.ts --mode daily

# 周报
docker compose exec monitor bun run src/e2e-run.ts --mode weekly
```

---

## 10. 重发 / 重跑某条报告

如果 dispatch 跳过了（status 已是 sent），手动改回 pending 再跑：

```bash
docker compose exec monitor bun -e "
import { Database } from 'bun:sqlite';
const db = new Database('/app/data/monitor.db');
db.run(\"UPDATE report_deliveries SET status = 'pending', sent_at = NULL WHERE status = 'sent'\");
db.run('UPDATE reports SET sent_at = NULL WHERE sent_at IS NOT NULL');
console.log('after:', db.query('SELECT id, status FROM report_deliveries').all());
db.close();
"

# 然后重新跑（只有 dispatch 会有实际动作）
docker compose exec monitor bun run src/e2e-run.ts --mode daily
```

---

## 11. 历史数据回填

将某个日期之后的 PR 全部重新 collect + analyze（用于数据补录）：

```bash
# 把所有项目的 last_synced_at 设为指定日期（存秒）
docker compose exec monitor bun -e "
import { Database } from 'bun:sqlite';
const db = new Database('/app/data/monitor.db');
const since = Math.floor(new Date('2026-06-01T00:00:00Z').getTime() / 1000);
db.run('UPDATE projects SET last_synced_at = ?', [since]);
console.log('updated:', db.query('SELECT id, last_synced_at FROM projects').all());
db.close();
"

# 然后跑 e2e，collect 会从该日期重新抓取
docker compose exec monitor bun run src/e2e-run.ts --mode daily
```

注意：已经存在的 PR 会因为 `ON CONFLICT` 被 upsert 跳过分析，只有真正没有 analysis 记录的 PR 才会走 LLM。

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
