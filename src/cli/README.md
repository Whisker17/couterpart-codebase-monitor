# Counterpart Monitor CLI Guide

这个目录里的 CLI 是给日常测试和手动运维用的入口。它把原来分散在脚本和 runbook 里的常用动作收敛到一个命令树里：

```bash
bun run cli -- <command> [options]
```

## 安全规则

- 默认尽量只读或 dry-run。会改数据库、发送 Lark 卡片、重置发送状态的命令都需要显式加 `--yes`。
- `report send` 默认只生成本地预览文件，不发送 Lark，也不写 `reports` / `report_deliveries`。
- `report redispatch` 默认只打印目标报告和 delivery 状态，不重置、不发送。
- `report mark-delivery` 默认只打印变更前后预览，不写数据库。
- 需要在生产数据上验证时，优先复制数据库后用 `--db <path>` 指向副本。
- CLI 的 `run` 只提供 `daily`、`weekly`、`monthly` 三种明确模式，避免一次命令混合触发多个报告周期。

## 全局参数

全局参数可以放在命令前或命令后：

| 参数 | 作用 |
| --- | --- |
| `--json` | 输出机器可读 JSON，目前主要用于只读查询命令。 |
| `--verbose`, `-v` | 保留给更详细输出。 |
| `--timezone <tz>` | 覆盖配置里的时区，例如 `Asia/Shanghai`。 |
| `--db <path>` | 使用指定 SQLite 数据库文件，适合操作数据库副本。 |

示例：

```bash
bun run cli -- --db /tmp/monitor-copy.db db status --date 2026-06-09
bun run cli -- --json project list --date 2026-06-09
```

## 常用工作流

### 1. 查看当前系统状态

```bash
bun run cli -- db status
bun run cli -- db status --date 2026-06-09
bun run cli -- db status --date 2026-06-09 --week-date 2026-06-09
```

`db status` 会读取 PR、分析状态、diff 状态、日报 digest 覆盖、最近报告、最近 delivery 和本月成本。它不会修改数据库。

PR counts 表会显示所有 active 项目，包括目标日期窗口内没有 PR 的项目（显示为 `pr_count = 0`）。每行还包括：

- `budget_skipped`：因预算跳过分析的 PR 数。
- `last_pr_at`：该项目最近一个被采集的 PR 的合并时间（不是 collector 运行时间）。
- `collected`：collector 最近一次成功检查该项目的时间（即使当时 0 PR）。

如果 `collected` 是今天但 `last_pr_at` 是几天前，说明项目只是安静，不是 sync 出了问题。如果两列都很旧，说明 collector 可能没在正常运行。

PR counts 表之后，如果存在 inactive 项目（例如被订阅移除或仓库不存在），会额外显示 inactive projects 列表及停用原因。

如果要接脚本处理：

```bash
bun run cli -- --json db status --date 2026-06-09
```

### 2. 查看项目和配置

```bash
bun run cli -- project list
bun run cli -- project list --date 2026-06-09
bun run cli -- config show
bun run cli -- config show projects
bun run cli -- config show budget
bun run cli -- budget
bun run cli -- budget --month 2026-06
```

- `project list --date` 会按项目补充当天 PR 和分析状态计数。
- `config show` 会隐藏敏感值，只显示对应环境变量是否已设置。
- `budget` 会显示目标月份的 LLM token、估算成本、预算余量和当前动作建议。

### 3. 手动触发 pipeline

```bash
bun run cli -- run daily --no-dispatch
bun run cli -- run weekly --no-dispatch
bun run cli -- run monthly --month 2026-06 --no-dispatch
```

`run` 走完整 pipeline：

| 模式 | 行为 |
| --- | --- |
| `daily` | collect -> analyze -> daily report -> dispatch |
| `weekly` | collect -> analyze -> daily report + weekly report -> dispatch |
| `monthly` | collect -> analyze -> daily report + monthly report -> dispatch |

`--no-dispatch` 只跳过 Lark dispatch，仍然会执行前面的采集、分析和报告生成。月报已接入 pipeline，手动指定月份时使用 `--month YYYY-MM`。

### 4. 预览或发送报告卡片

```bash
bun run cli -- report send daily --date 2026-06-09
bun run cli -- report send weekly --date 2026-06-09
bun run cli -- report send monthly --month 2026-06
```

不加 `--yes` 时，命令只会把卡片 JSON 写到 `data/reports/prompt-lab/`，方便检查 Lark card 结构和 prompt 输入。

确认要发送到 Lark 时：

```bash
bun run cli -- report send daily --date 2026-06-09 --yes
bun run cli -- report send weekly --date 2026-06-09 --yes
bun run cli -- report send monthly --month 2026-06 --yes
```

发送模式需要 `LARK_WEBHOOK_URL`。日报还会调用 LLM 生成正文；不加 `--yes` 的预览模式不会调用 LLM。

`report send` 和 `run` 的区别：

- `run` 是 pipeline 验收入口，会采集、分析、持久化报告，并按 pipeline 的 dispatch 规则发送。
- `report send` 是卡片检查和手动发送入口，只构建当前目标报告卡片并发送，不更新 `reports` / `report_deliveries` 的发送状态。
- 如果目标是“把数据库里已有报告重新发一遍”，使用 `report redispatch`。

### 5. 修改 delivery 状态

先 dry-run 看目标是否正确：

```bash
bun run cli -- report mark-delivery daily --date 2026-06-09 --status pending
bun run cli -- report mark-delivery weekly --date 2026-06-09 --status pending
bun run cli -- report mark-delivery monthly --month 2026-06 --status pending
```

确认后再写数据库：

```bash
bun run cli -- report mark-delivery daily --date 2026-06-09 --status pending --yes
bun run cli -- report mark-delivery weekly --date 2026-06-09 --status pending --yes
bun run cli -- report mark-delivery monthly --month 2026-06 --status failed --yes
```

可用状态：

| 状态 | 说明 |
| --- | --- |
| `pending` | 标记为待发送，并清空对应 delivery 的 `lark_message_id` 和 `sent_at`。 |
| `sent` | 标记为已发送。 |
| `failed` | 标记为发送失败。 |

如果一个 report 有多张卡片，可以用 `--card-index <n>` 只改其中一张：

```bash
bun run cli -- report mark-delivery daily --date 2026-06-09 --status pending --card-index 0 --yes
```

### 6. 重新发送已有日报

先查看将要操作的 report 和 delivery：

```bash
bun run cli -- report redispatch daily --date 2026-06-09
```

确认后发送：

```bash
bun run cli -- report redispatch daily --date 2026-06-09 --mode dispatch-only --yes
bun run cli -- report redispatch daily --date 2026-06-09 --mode report-only --yes
bun run cli -- report redispatch daily --date 2026-06-09 --mode full --yes
```

三种模式：

| 模式 | 行为 |
| --- | --- |
| `dispatch-only` | 不重新生成报告，直接重发 `report_deliveries.content` 里的已有卡片。 |
| `report-only` | 基于已有分析重新生成日报卡片，再发送。 |
| `full` | 对目标日期重新 collect/analyze，再重新生成日报卡片并发送。 |

`redispatch` 目前只支持日报。它适合配合 `mark-delivery daily --status pending --yes` 使用，用来触发 Lark card 的再次发送。

### 7. 回填历史数据

```bash
bun run cli -- backfill --since 2026-06-01 --until 2026-06-09
bun run cli -- backfill --since 2026-06-01 --until 2026-06-09 --allow-partial
```

`backfill` 会按日期循环执行 collect/analyze/daily report，不负责发送 Lark。`--allow-partial` 允许某些日期缺数据时继续处理后续日期。

### 8. 导出分析审计数据

```bash
bun run cli -- export audit --since 2026-06-01T00:00:00Z --until 2026-06-10T00:00:00Z --output /tmp/analysis-audit.jsonl
```

导出结果是 JSONL，适合离线抽样检查分析输入、输出和成本。

## 使用数据库副本

在需要改状态或测试发送前，建议先复制数据库，然后所有命令都带 `--db`：

```bash
cp data/monitor.db /tmp/monitor-copy.db
bun run cli -- --db /tmp/monitor-copy.db db status --date 2026-06-09
bun run cli -- --db /tmp/monitor-copy.db report mark-delivery daily --date 2026-06-09 --status pending
bun run cli -- --db /tmp/monitor-copy.db report mark-delivery daily --date 2026-06-09 --status pending --yes
```

这可以验证 SQL 命中范围和 dry-run 输出，避免直接改动真实运行库。

## 命令速查

| 命令 | 常用参数 | 是否默认改数据 |
| --- | --- | --- |
| `run daily` | `--no-dispatch`, `--timezone` | 会跑 pipeline；`--no-dispatch` 只跳过 Lark。 |
| `run weekly` | `--no-dispatch`, `--timezone` | 会跑 pipeline；`--no-dispatch` 只跳过 Lark。 |
| `run monthly` | `--month YYYY-MM`, `--no-dispatch`, `--timezone` | 会跑 pipeline；`--no-dispatch` 只跳过 Lark。 |
| `report send daily` | `--date YYYY-MM-DD`, `--prompt`, `--yes` | 否；加 `--yes` 后发送 Lark。 |
| `report send weekly` | `--date YYYY-MM-DD`, `--yes` | 否；加 `--yes` 后发送 Lark。 |
| `report send monthly` | `--month YYYY-MM`, `--yes` | 否；加 `--yes` 后发送 Lark。 |
| `report mark-delivery` | `daily --date`, `weekly --date`, `monthly --month`, `--status`, `--card-index`, `--yes` | 否；加 `--yes` 后写库。 |
| `report redispatch daily` | `--date YYYY-MM-DD`, `--mode`, `--yes` | 否；加 `--yes` 后重置并发送。 |
| `backfill` | `--since`, `--until`, `--allow-partial` | 会写回填结果，不发送 Lark。 |
| `db status` | `--date`, `--week-date`, `--json` | 否。 |
| `project list` | `--date`, `--json` | 否。 |
| `config show` | `projects`, `budget`, `--json` | 否。 |
| `budget` | `--month`, `--json` | 否。 |
| `export audit` | `--since`, `--until`, `--output` | 写导出文件，不改数据库。 |

## 排查提示

- 查看入口帮助：`bun run cli -- --help`
- 月报必须指定月份：`report send monthly --month YYYY-MM`，`report mark-delivery monthly --month YYYY-MM`。
- 周报按周窗口定位；传 `--date YYYY-MM-DD` 时会定位到该日期所在周。
- `--yes` 发送 Lark 前必须设置 `LARK_WEBHOOK_URL`。
- Bun 会自动读取 `.env`。如果要验证“环境变量缺失”的行为，用 `bun --no-env-file run src/cli/index.ts ...`。
- 如果 dry-run 找不到报告，先用 `db status` 查看目标日期或月份是否已经生成对应 `reports` 行。
