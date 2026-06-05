# Counterpart Codebase Monitor — Linear Milestones & Issues Design

## Project Metadata

| Field | Value |
|-------|-------|
| Project | Counterpart Codebase Monitor |
| Start Date | 2026-06-02 |
| Target Date | 2026-06-27 |
| Priority | High |
| Lead | whisker yu |
| Team | Whisker-Personal |

## Project Summary (for Linear, max 255 chars)

Engineering intelligence agent: tracks OSS repos via merged PRs, diff-aware LLM analysis with intelligent truncation, directional judgments, delivers layered daily + weekly reports to Lark.

## Project Description (for Linear)

Four-stage sequential pipeline: **GitHub Collector -> Analyzer -> Report Generator -> Lark Dispatcher**, communicating via SQLite (status columns: `pending`/`complete`/`failed`), not direct function calls. Pipeline is resumable and debuggable.

**Key architectural decision:** pi-agent's extension system is for LLM tool registration and lifecycle hooks only. Pipeline orchestration uses plain TS modules with direct function calls (`src/pipeline/runner.ts`).

**Tech stack:** Bun (TypeScript), pi-agent, SQLite via `bun:sqlite`, Octokit, Vercel AI SDK (`ai` + `@ai-sdk/anthropic`), Lark webhook (Message Card v2), croner. code-review-graph deferred to post-MVP M3.

---

## Milestones Overview

| Milestone | Name | Target Date | Issues |
|-----------|------|-------------|--------|
| M0 | Scaffold + pi-agent Learning | 2026-06-04 | 4 |
| M1 | Core Pipeline (Daily + Weekly) | 2026-06-16 | 7 |
| M2 | Harden | 2026-06-25 | 9 |
| M3 (post-MVP) | Deep Analysis + Evolution | TBD | 4+ |

**MVP Total: 20 issues (M0 + M1 + M2). Post-MVP: 4+ issues.**

> **Design change (2026-05-29):** code-review-graph removed from MVP scope. Diff-aware LLM analysis replaces CRG. Issues 11-14 moved to post-MVP M3. Old Issue 16 split into Issue 16 (M1: prompt baseline + audit export) and Issue 17 (M2: data-driven tuning); subsequent issues renumbered 18-24. Lark (Issue 9) deferred from M1 to early M2 — M1 validates locally via JSON output. See `docs/spark/2026-05-29-remove-crg-from-mvp-design.md` for full rationale.

---

## M0: Scaffold + pi-agent Learning

> Target: 2026-06-04 (3 days)
> Goal: 项目骨架就绪，pi-agent 基础能力验证完成，开发环境可复现。

---

### Issue 1: [Setup] Bun 项目初始化与依赖安装

**Priority:** Urgent

#### Blocked By
无（起点 issue）

#### Blocks
Issue 2, Issue 3, Issue 4

#### 目标

初始化 Bun 项目，安装所有核心依赖，配置 TypeScript，创建完整目录骨架。确保任何人 `git clone && bun install && bun run dev` 零报错。

#### 实现内容

**1. 项目初始化**

* `bun init` 创建项目
* `tsconfig.json`：`strict: true`, `target: "ESNext"`, `module: "ESNext"`, `moduleResolution: "bundler"`
* `bunfig.toml`：Bun 特定配置（如有需要）

**2. 核心依赖安装**

```
bun add pi-agent octokit croner ai @ai-sdk/anthropic zod
bun add -d @types/bun typescript
```

**3. 目录结构创建**

```
src/
├── index.ts                    # Entry point, pi-agent setup
├── config/                     # 项目注册表 + settings
├── extensions/
│   ├── github-collector/       # Octokit PR fetching + diff
│   ├── analyzer/               # Diff-aware LLM reviewer
│   ├── report-generator/       # Daily/weekly report
│   └── lark-dispatcher/        # Lark webhook
├── pipeline/                   # Pipeline runner + stages
│   └── stages/
├── storage/                    # SQLite schema, migrations, db
│   └── migrations/
├── scheduler/                  # croner
└── utils/                      # 共享工具函数
data/                           # SQLite db + diffs + analysis-inputs (gitignored)
config/                         # JSON config files
```

**4. Scripts 与 gitignore**

* `package.json` scripts: `"dev": "bun run src/index.ts"`, `"start": "bun run src/index.ts"`
* `.gitignore`: `node_modules/`, `data/`, `*.db`, `*.db-wal`, `*.db-shm`, `.env`

#### 相关文件

| 操作 | 文件 |
|------|------|
| CREATE | `package.json`, `tsconfig.json`, `bunfig.toml`, `.gitignore`, `src/index.ts`（空壳） |
| CREATE | 所有目录下的 `.gitkeep`（保持目录结构） |

#### 验收标准

* [ ] `git clone && bun install && bun run dev` 零报错
* [ ] TypeScript strict mode 编译通过
* [ ] 目录结构完整，所有子目录存在

---

### Issue 2: [Setup] SQLite schema 定义与 db 模块实现

**Priority:** Urgent

#### Blocked By
Issue 1

#### Blocks
Issue 5, Issue 6

#### 目标

实现 SQLite 数据库模块：完整 schema（6 张表）、生产级 pragma 配置、自动建表。这是整个 pipeline 的通信层 — 各 stage 通过 SQLite status 列协调。

#### 实现内容

**1. Schema 定义 (`src/storage/schema.ts`)**

完整 DDL 如下，必须严格遵守：

```sql
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,              -- 格式: "org/repo"
  org TEXT NOT NULL,
  repo TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT,                 -- GitHub repo description
  language TEXT,                    -- GitHub primary language
  topics TEXT,                      -- GitHub repo topics (JSON array)
  overview TEXT,                    -- LLM 生成的项目概述 (post-MVP)
  tech_stack TEXT,                  -- JSON array: ["typescript", "rust", ...] (post-MVP)
  clone_path TEXT,                  -- 本地 clone 路径 (post-MVP)
  last_synced_at INTEGER,           -- Unix timestamp
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS pull_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,  -- surrogate key, 非 GitHub PR ID
  project_id TEXT NOT NULL REFERENCES projects(id),
  pr_number INTEGER NOT NULL,
  github_node_id TEXT,
  title TEXT NOT NULL,
  body TEXT,
  author TEXT,
  merged_at INTEGER,                -- Unix timestamp
  files_changed INTEGER,
  additions INTEGER,
  deletions INTEGER,
  diff_path TEXT,                   -- 文件系统路径: data/diffs/{org}-{repo}/{pr_number}.patch
  diff_status TEXT CHECK(diff_status IN ('available', 'missing', 'fetch_failed', 'too_large')) DEFAULT 'missing',
  analysis_status TEXT CHECK(analysis_status IN ('pending', 'complete', 'failed')) DEFAULT 'pending',
  retry_count INTEGER DEFAULT 0,    -- 分析重试次数（达到上限后永久 failed）
  last_error TEXT,                  -- 最近一次失败的错误信息
  fetched_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(project_id, pr_number)     -- 幂等写入保证
);

CREATE TABLE IF NOT EXISTS analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_id INTEGER NOT NULL REFERENCES pull_requests(id),
  project_id TEXT NOT NULL REFERENCES projects(id),  -- 冗余字段，方便直接查询
  summary TEXT NOT NULL,            -- 1-2 句总结
  technical_detail TEXT,            -- 2-4 句技术分析
  direction_signal TEXT,            -- 对项目方向的判断，routine PR 为 null
  significance TEXT CHECK(significance IN ('routine', 'notable', 'directional_shift')),
  categories TEXT,                  -- JSON array: ["architecture", "performance", ...]
  model_id TEXT,                    -- 实际使用的 model (e.g. "claude-sonnet-4-6")
  input_tokens INTEGER,             -- prompt tokens 消耗量
  output_tokens INTEGER,            -- completion tokens 消耗量
  estimated_cost_usd REAL,          -- 基于 model 定价的估算成本
  analyzed_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT CHECK(type IN ('daily', 'weekly', 'monthly')),
  period_start INTEGER NOT NULL,    -- 报告周期起始时间 (Unix timestamp)
  period_end INTEGER NOT NULL,      -- 报告周期结束时间 (Unix timestamp)
  project_ids TEXT,                 -- JSON array: ["org/repo1", "org/repo2"]
  content TEXT NOT NULL,            -- 完整报告内容 (Lark card JSON)
  completeness TEXT,                -- JSON: {"total": 5, "success": 4, "failed": ["org/repo"]}
  sent_at INTEGER,                  -- 所有 delivery 成功后的时间
  created_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(type, period_start, period_end)  -- 同一周期同一类型报告幂等
);

CREATE TABLE IF NOT EXISTS report_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL REFERENCES reports(id),
  card_index INTEGER NOT NULL,      -- 卡片序号 (单卡片时为 0)
  content TEXT NOT NULL,            -- 单张卡片的 JSON
  lark_message_id TEXT,             -- Lark 返回的 message_id
  status TEXT CHECK(status IN ('pending', 'sent', 'failed')) DEFAULT 'pending',
  sent_at INTEGER,
  UNIQUE(report_id, card_index)     -- 同一报告内卡片序号唯一
);

-- 分析输入快照（分析时持久化，用于审计/重放）
CREATE TABLE IF NOT EXISTS analysis_inputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  analysis_id INTEGER NOT NULL REFERENCES analyses(id),
  prompt_version TEXT NOT NULL,         -- prompt 模板的 hash 或版本标签
  input_quality TEXT NOT NULL,          -- "diff_aware" | "metadata_only" | "diff_plus_graph" (post-MVP M3)
  rendered_project_context TEXT,        -- 发送给 LLM 的完整 PROJECT CONTEXT 块
  file_manifest TEXT,                   -- JSON array of FileEntry objects
  diff_included_files INTEGER,
  diff_total_files INTEGER,
  diff_truncated BOOLEAN NOT NULL,
  truncated_diff_path TEXT,             -- 截断后 diff 快照路径: data/analysis-inputs/{analysis_id}.diff
  created_at INTEGER DEFAULT (unixepoch())
);
```

**2. Database 模块 (`src/storage/db.ts`)**

* 使用 `bun:sqlite` 的 `Database` 类
* 数据库文件路径：`data/monitor.db`（目录不存在时自动创建）
* 生产级 pragma 配置（**必须全部设置**，这是 eng review 的硬性要求）：
  ```ts
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA temp_store=MEMORY");
  db.exec("PRAGMA cache_size=-64000");     // 64MB
  db.exec("PRAGMA mmap_size=268435456");   // 256MB
  db.exec("PRAGMA busy_timeout=5000");     // 5s
  ```
* macOS WAL 清理（shutdown hook）：尝试 `db.fileControl(SQLITE_FCNTL_PERSIST_WAL, 0)`，如果 API 不可用则 fallback 到 `db.exec("PRAGMA wal_checkpoint(TRUNCATE)")`
* 导出：`getDb(): Database`（单例）+ `closeDb(): void`
* 首次运行时自动执行 DDL 建表

**3. 迁移机制**

* 简单方案：`migrations` 表记录已执行的 migration 版本号
* 初始 migration: `src/storage/migrations/001_init.sql`（包含上述全部 DDL）

#### 相关文件

| 操作 | 文件 |
|------|------|
| CREATE | `src/storage/db.ts` |
| CREATE | `src/storage/schema.ts` |
| CREATE | `src/storage/migrations/001_init.sql`（含 5 张表 DDL） |

#### 验收标准

* [ ] `bun run dev` 后 `data/monitor.db` 自动创建
* [ ] 六张表结构正确（`sqlite3 data/monitor.db ".schema"` 验证，含 `analysis_inputs`）
* [ ] `PRAGMA journal_mode` 返回 `wal`
* [ ] `UNIQUE(project_id, pr_number)` 约束生效：重复 INSERT 报错或被 IGNORE
* [ ] `reports` 表的 `UNIQUE(type, period_start, period_end)` 约束生效
* [ ] `report_deliveries` 表结构正确，`UNIQUE(report_id, card_index)` 约束生效
* [ ] `pull_requests.retry_count` 默认为 0
* [ ] `pull_requests.diff_status` 默认为 `'missing'`，CHECK 约束包含 4 个值
* [ ] `projects` 表包含 `description`, `language`, `topics` 列
* [ ] 进程 `SIGTERM` 退出时 WAL checkpoint 执行

---

### Issue 3: [Setup] pi-agent hello-world extension 学习与验证

**Priority:** High

#### Blocked By
Issue 1

#### Blocks
Issue 5（提供 `src/index.ts` 中 pi-agent 初始化模式）

#### 目标

实现一个最小 pi-agent extension，验证 extension 开发模式：tool 注册、事件订阅、hot-reload。产出 `src/index.ts` 的 pi-agent 初始化入口，后续所有 extension 沿用此模式。

**关键架构约束**：pi-agent extension 系统**仅用于** LLM tool 注册和生命周期 hooks。Pipeline 顺序执行通过 `src/pipeline/runner.ts`（plain TS direct function calls）实现，**不通过** pi-agent 的事件系统编排。Extension 之间**不直接调用**，通过 SQLite 通信。

#### 实现内容

**1. pi-agent 文档学习**

* 阅读 pi-agent 官方文档 Extensions 章节
* 理解 `AgentSession` API：`agent.tool(name, schema, handler)`, `agent.on(event, handler)`
* 理解 extension 生命周期：register -> start -> (hot-reload) -> stop
* 理解 extension 注册方式：导出 `register(agent: AgentSession)` 函数

**2. Hello-world Extension (`src/extensions/hello/index.ts`)**

```ts
// 预期模式（实际 API 以 pi-agent 文档为准）
export function register(agent: AgentSession) {
  agent.tool("hello-world", {}, async () => {
    return { time: new Date().toISOString(), status: "ok" };
  });
}
```

* 注册 `hello-world` tool，返回当前时间
* 验证 hot-reload：修改 handler 后 `/reload` 生效，无需重启进程

**3. Entry Point (`src/index.ts`)**

* 初始化 pi-agent session
* 加载 hello-world extension
* 后续 issue 会在此基础上加载业务 extension

#### 相关文件

| 操作 | 文件 |
|------|------|
| CREATE | `src/extensions/hello/index.ts` |
| MODIFY | `src/index.ts`（从空壳改为 pi-agent 初始化入口） |

#### 验收标准

* [ ] `bun run dev` 后 pi-agent session 正常初始化，无报错
* [ ] `hello-world` tool 可调用并返回 JSON 结果
* [ ] 修改 handler 后 hot-reload 生效
* [ ] `src/index.ts` 建立了可复用的 extension 加载模式

---

### Issue 4: [Setup] 项目注册表配置与 settings 模块

**Priority:** High

#### Blocked By
Issue 1

#### Blocks
Issue 5, Issue 6

#### 目标

实现配置系统：tracked repos 注册表 + 全局 settings + 环境变量。后续 pipeline 所有 stage 通过此模块读取配置。

#### 实现内容

**1. 项目注册表 (`src/config/projects.ts` + `config/projects.json`)**

TypeScript 类型定义：
```ts
interface ProjectConfig {
  org: string;        // GitHub org, e.g. "vercel"
  repo: string;       // GitHub repo name, e.g. "next.js"
  url: string;        // Full URL: "https://github.com/vercel/next.js"
  tags?: string[];     // 可选标签: ["frontend", "framework"]
  notes?: string;      // 可选备注
}
```

* 从 `config/projects.json` 读取，导出 `getTrackedProjects(): ProjectConfig[]`
* 初始配置 3-5 个近期活跃的开源项目（确保有足够 merged PR 用于测试）
* 推荐选择：`vercel/next.js`, `denoland/deno`, `oven-sh/bun`, `astral-sh/ruff`, `pydantic/pydantic`

**2. 全局设置 (`src/config/settings.ts` + `config/settings.json`)**

```ts
interface Settings {
  llm: {
    model: string;              // "claude-sonnet-4-6"
    baseUrlEnvVar: string;      // "LLM_BASE_URL" (Anthropic-compatible AI gateway endpoint)
    apiKeyEnvVar: string;       // "LLM_API_KEY"
    maxTokensPerCall: number;   // 4096
    diffTokenBudget: number;    // 8000 (diff truncation token budget)
    maxManifestEntries: number; // 100 (file manifest cap before tier aggregation)
  };
  lark: {
    webhookUrlEnvVar: string; // "LARK_WEBHOOK_URL"
  };
  github: {
    tokenEnvVar: string;      // "GITHUB_TOKEN"
  };
  schedule: {
    dailyCron: string;        // "0 8 * * *"
    weeklyCron: string;       // "0 9 * * 1" (Monday)
  };
  budget: {
    monthlyCap: number;       // 80 (USD)
    warningThreshold: number; // 0.8
    cutoffThreshold: number;  // 1.0
  };
  // clone section deferred to post-MVP M3
}
```

* JSON 文件提供默认值，环境变量覆盖敏感字段
* 导出 `getSettings(): Settings`

**3. 配置校验**

* 启动时校验必填环境变量：`GITHUB_TOKEN`, `LLM_BASE_URL`, `LLM_API_KEY`
* Lark 环境变量 `LARK_WEBHOOK_URL` 在 M2 Lark 集成时校验（M1 不需要）
* 缺失时打印明确信息（列出缺失项 + 提示查看 `.env.example`）并 `process.exit(1)`

**4. 环境变量模板**

创建 `.env.example`：
```
GITHUB_TOKEN=ghp_xxx
LLM_BASE_URL=https://your-gateway.example.com/v1
LLM_API_KEY=sk-xxx
LARK_WEBHOOK_URL=https://open.larksuite.com/open-apis/bot/v2/hook/xxx
```

#### 相关文件

| 操作 | 文件 |
|------|------|
| CREATE | `src/config/projects.ts`, `src/config/settings.ts` |
| CREATE | `config/projects.json`, `config/settings.json` |
| CREATE | `.env.example` |

#### 验收标准

* [ ] `getTrackedProjects()` 返回 3-5 个真实项目
* [ ] `getSettings()` 返回完整配置对象（包含 `llm.diffTokenBudget` 和 `llm.maxManifestEntries` 默认值）
* [ ] 缺失 `GITHUB_TOKEN` 或 `LLM_BASE_URL` 或 `LLM_API_KEY` 时启动报错，信息包含缺失变量名
* [ ] 环境变量可覆盖 JSON 配置中的值

---

## M1: Core Pipeline (Daily + Weekly)

> Target: 2026-06-16 (8 working days)
> Goal: 端到端 pipeline 跑通（collect → analyze → report），本地 JSON 验证分析质量。Diff-aware LLM 分析 + prompt baseline + audit export + end-to-end 验证。Lark 推送延迟到 M2。

> **Note:** Issues 15 (weekly report) and 16 (prompt baseline + audit export) absorbed into M1. Issue 9 (Lark) moved to early M2.

---

### Issue 5: [Pipeline] Pipeline runner 与调度框架实现

**Priority:** Urgent

#### Blocked By
Issue 2, Issue 3, Issue 4（需要 db、pi-agent 入口、config 全部就绪）

#### Blocks
Issue 6, Issue 7, Issue 8

#### 目标

实现 pipeline 顺序执行框架和 croner 调度。这是 eng review 明确要求的架构：**plain TS modules with direct function calls**，不使用 pi-agent 的 extension system 做 pipeline orchestration。

#### 实现内容

**1. Pipeline Runner (`src/pipeline/runner.ts`)**

```ts
interface StageResult {
  success: boolean;
  itemsProcessed: number;
  errors: string[];
  durationMs: number;
  failedProjects?: string[];  // collect/analyze 失败的项目 ID 列表
}

interface PipelineContext {
  stageResults: Map<string, StageResult>;  // 下游 stage 可查询上游执行情况
}

interface PipelineStage {
  name: string;
  execute: (ctx: PipelineContext) => Promise<StageResult>;
}

// 顺序执行所有 stage，单个失败不阻断后续
// PipelineContext 随 stage 累积，下游可检查上游完整性
async function runPipeline(stages: PipelineStage[]): Promise<Map<string, StageResult>>;
```

* 每个 stage 执行前后记录日志：`[Pipeline] Starting stage: collect`, `[Pipeline] Stage collect completed in 3200ms (5 items)`
* 单个 stage 抛异常时 catch，记录 error，继续下一个 stage
* **PipelineContext 传递**：每个 stage 接收 `ctx` 参数，可查询已完成 stage 的 `failedProjects`。Report stage 据此标记报告完整性（partial vs complete）
* 返回所有 stage 的执行结果

**2. Scheduler (`src/scheduler/cron.ts`)**

* 使用 `croner` 注册两个定时任务：
  * Daily pipeline: 读取 `settings.schedule.dailyCron`
  * Weekly pipeline: 读取 `settings.schedule.weeklyCron`（在 daily 之后触发 weekly report 逻辑）
* 提供 `runNow()` 手动触发入口（CLI 调试用）

**3. Stage 骨架（4 个空壳）**

创建四个 stage 文件，各导出 `execute(): Promise<StageResult>`，初始实现为 `return { success: true, itemsProcessed: 0, errors: [], durationMs: 0 }`：

* `src/pipeline/stages/collect.ts`
* `src/pipeline/stages/analyze.ts`
* `src/pipeline/stages/report.ts`
* `src/pipeline/stages/dispatch.ts`

**4. 集成到 `src/index.ts`**

* 在 pi-agent 初始化后，注册 scheduler
* `runPipeline([collect, analyze, report, dispatch])` 作为 scheduled task

#### 相关文件

| 操作 | 文件 |
|------|------|
| CREATE | `src/pipeline/runner.ts` |
| CREATE | `src/scheduler/cron.ts` |
| CREATE | `src/pipeline/stages/collect.ts`（空壳） |
| CREATE | `src/pipeline/stages/analyze.ts`（空壳） |
| CREATE | `src/pipeline/stages/report.ts`（空壳） |
| CREATE | `src/pipeline/stages/dispatch.ts`（空壳） |
| MODIFY | `src/index.ts`（注册 scheduler + pipeline） |

#### 验收标准

* [ ] `runPipeline()` 顺序执行 4 个 stage，日志清晰标注每个 stage 的名称/耗时/结果
* [ ] 某个 stage `throw Error` 时 pipeline 继续执行后续 stage
* [ ] 下游 stage 可通过 `ctx.stageResults` 查询上游执行情况
* [ ] `runNow()` 可在 CLI 直接手动触发完整 pipeline
* [ ] croner 设为 1 分钟间隔时可验证自动触发

---

### Issue 6: [Collector] GitHub PR 数据采集与 diff 存储

**Priority:** Urgent

#### Blocked By
Issue 2（SQLite schema）, Issue 4（项目注册表）, Issue 5（pipeline runner 提供的 stage 骨架）

#### Blocks
Issue 7, Issue 10

#### 目标

实现完整的 GitHub Collector stage：通过 Octokit 抓取 tracked repos 的已合并 PR 元数据 + diff 内容，写入 SQLite `pull_requests` 表 + 文件系统。支持增量同步和幂等写入。

#### 实现内容

**1. Octokit 客户端 (`src/extensions/github-collector/fetcher.ts`)**

* 初始化 Octokit：`new Octokit({ auth: process.env.GITHUB_TOKEN })`
* `fetchMergedPRs(org: string, repo: string, since: Date): Promise<PRData[]>`:
  * 调用 `octokit.pulls.list({ owner: org, repo, state: "closed", sort: "updated", direction: "desc", per_page: 100 })`
  * 过滤：`merged_at !== null && merged_at > since`
  * 自动分页：翻页直到 **`updated_at < since`**（⚠️ 终止条件必须基于 `updated_at` 而非 `merged_at`。原因：排序是按 `updated` 降序，一个被 updated 的老 PR 可能出现在新 merged PR 之前，用 `merged_at` 作终止条件会导致后续页面的新 merged PR 被永久跳过）
  * 返回字段：`number, title, body, user.login, merged_at, changed_files, additions, deletions`

**2. Diff 抓取 (`src/extensions/github-collector/diff-fetcher.ts`)**

* `fetchDiff(org: string, repo: string, prNumber: number): Promise<string | null>`:
  * 调用 `octokit.pulls.get({ owner: org, repo, pull_number: prNumber, mediaType: { format: "diff" } })`
  * 返回 diff 字符串
  * **Collector 存储完整 raw diff，不做截断**（截断在 analyzer 的 `diff-truncator.ts` 中按文件优先级执行）
  * 超大 diff（>2MB）：不存储文件，设 `diff_status = 'too_large'`，`diff_path = NULL`
  * 正常 diff：设 `diff_status = 'available'`，`diff_path = '...'`
  * 获取失败：设 `diff_status = 'fetch_failed'`，`diff_path = NULL`
* 存储路径：`data/diffs/{org}-{repo}/{prNumber}.patch`
* 目录不存在时自动 `mkdirSync`

**3. Repo Metadata 获取 (`src/extensions/github-collector/fetcher.ts`)**

* `fetchRepoMetadata(org: string, repo: string): Promise<{ description: string | null, language: string | null, topics: string[] }>`:
  * 调用 `octokit.repos.get({ owner: org, repo })`
  * 返回 `{ description, language, topics }`
  * 每个项目每次 sync 调用一次（非每个 PR）
* Collect stage 在处理每个 project 时调用，写入 `projects.description`, `projects.language`, `projects.topics`

**3. Collect Stage (`src/pipeline/stages/collect.ts`)**

完整实现（替换 Issue 5 创建的空壳）：

```ts
async function execute(): Promise<StageResult> {
  const projects = getTrackedProjects();
  for (const project of projects) {
    // 1. 确定 since 时间
    const lastSynced = db.query("SELECT last_synced_at FROM projects WHERE id = ?").get(projectId);
    const since = lastSynced ?? sevenDaysAgo;

    // 2. 抓取 merged PRs
    const prs = await fetchMergedPRs(project.org, project.repo, since);

    // 3. 写入 DB (幂等: INSERT OR IGNORE)
    for (const pr of prs) {
      db.run("INSERT OR IGNORE INTO pull_requests (...) VALUES (...)", ...);
      // 4. 抓取并存储 diff（完整存储，不截断）
      const diff = await fetchDiff(project.org, project.repo, pr.number);
      if (diff && diff.length <= 2_000_000) {
        writeDiffToFile(project, pr.number, diff);
        db.run("UPDATE pull_requests SET diff_path = ?, diff_status = 'available' WHERE ...", diffPath);
      } else if (diff && diff.length > 2_000_000) {
        db.run("UPDATE pull_requests SET diff_status = 'too_large' WHERE ...");
      } else {
        db.run("UPDATE pull_requests SET diff_status = 'fetch_failed' WHERE ...");
      }
    }

    // 6. 更新 last_synced_at（推进到本次抓取的最大 merged_at，而非 wall-clock now）
    //    ⚠️ 用 wall-clock now 会跳过 since ~ now 之间延迟入库的 PR
    if (prs.length > 0) {
      const maxMergedAt = Math.max(...prs.map(pr => pr.merged_at));
      db.run("UPDATE projects SET last_synced_at = ? WHERE id = ?", maxMergedAt, projectId);
    }
  }
}
```

* 首次同步（`last_synced_at` 为 null）：抓取最近 7 天
* 单个 project 失败时 catch error，log 警告，继续下一个 project
* diff 抓取失败时 PR 记录仍正常写入（`diff_path = null`）

**4. 初始数据写入**

* 首次运行前需将 `config/projects.json` 中的项目写入 `projects` 表
* 在 collect stage 开头检查：如果 `projects` 表为空或缺少配置中的项目，执行 `INSERT OR IGNORE`

#### 技术约束

* GitHub API rate limit: 5000 req/hour (authenticated)，每次 list 返回最多 100 条
* diff 抓取额外消耗 1 次 API 调用/PR
* 10 个项目 x 5 PRs/天 ≈ 60 API calls/天，远低于限制

#### 相关文件

| 操作 | 文件 |
|------|------|
| CREATE | `src/extensions/github-collector/fetcher.ts` |
| CREATE | `src/extensions/github-collector/diff-fetcher.ts` |
| MODIFY | `src/pipeline/stages/collect.ts`（从空壳改为完整实现） |

#### 验收标准

* [ ] 对 3-5 个配置项目执行 collect，`pull_requests` 表有数据
* [ ] 重复执行不产生重复记录（`INSERT OR IGNORE` 幂等）
* [ ] `data/diffs/` 下生成 `.patch` 文件
* [ ] `projects.last_synced_at` 更新为本次抓取的最大 `merged_at`（非 wall-clock now）
* [ ] 日志输出每个项目抓取的 PR 数量
* [ ] `pull_requests.diff_status` 正确设置为 `available`/`fetch_failed`/`too_large`
* [ ] `projects.description`, `projects.language`, `projects.topics` 在 collect 后有值

---

### Issue 7: [Analyzer] Diff-aware LLM 分析器实现

**Priority:** Urgent

#### Blocked By
Issue 5（pipeline runner）, Issue 6（提供 `pull_requests` 表中的待分析数据）

#### Blocks
Issue 8, Issue 10, Issue 16, Issue 22

#### 目标

实现 Analyzer stage：读取 `analysis_status = 'pending'` 的 PR，基于 raw diff + 项目上下文调用 LLM 生成结构化分析（summary, technical_detail, direction_signal, significance），写入 `analyses` 表和 `analysis_inputs` 表。使用 `AnalysisContext` 通用接口，diff-truncator 智能截断，PROJECT CONTEXT LITE，以及月度预算硬上限。

#### 实现内容

**1. AnalysisContext 接口 (`src/extensions/analyzer/context.ts`)**

```ts
interface AnalysisContext {
  diff: TruncatedDiff | null;
  supplementaryContext: string | null;  // CRG blast-radius (post-MVP, always null)
  projectContext: ProjectContextLite;
  inputQuality: "diff_aware" | "metadata_only" | "diff_plus_graph";
}

interface ProjectContextLite {
  description: string | null;
  language: string | null;
  topics: string[];
  tags: string[];
  notes: string | null;
}
```

**2. Diff Truncator (`src/extensions/analyzer/diff-truncator.ts`)**

智能截断 diff 内容到 token budget（默认 8000 tokens）：
- 解析 diff 为 per-file hunks
- 按优先级分 tier：Skip always (lock/generated/binary) > Tier 1 signal files (package.json, Dockerfile, proto, CI, migrations, K8s) > Tier 2 source > Tier 3 tests > Tier 4 docs/config
- 每 tier 内按变更大小降序排列
- 按 tier 顺序包含文件直到 budget 耗尽
- **始终附加 file manifest**（compact 格式），>100 files 时按 tier 汇总（`settings.llm.maxManifestEntries`）

**3. LLM Reviewer (`src/extensions/analyzer/llm-reviewer.ts`)**

System prompt（完整模板，**必须使用**）：

```
You are an engineering intelligence analyst. Given a PR and its project context,
produce a structured analysis. Analyze the diff content to understand the actual
code changes, their patterns, and what they suggest about the project's
engineering direction.

PROJECT CONTEXT:
{project.description or "No description available."}
Language: {project.language or "Unknown"}
Topics: {project.topics.join(", ") or "None"}
{if project.notes: "Notes: " + project.notes}
{if project.tags.length: "Tags: " + project.tags.join(", ")}

PR INFORMATION:
Title: {pr.title}
Author: {pr.author}
Files changed: {pr.files_changed} (+{pr.additions}/-{pr.deletions})
PR Body: {pr.body (truncated to 1000 chars)}

DIFF CONTENT:
{truncated_diff.content or "Diff not available — analysis based on PR metadata only."}
{if truncated: "(Diff truncated: showing N/M files within token budget)"}
{fileManifest in compact format}

SUPPLEMENTARY CONTEXT:
{analysisContext.supplementaryContext or "Not available."}

Respond with a JSON object (no markdown fencing):
```

Required output schema（**LLM 必须返回此结构**）：

```json
{
  "summary": "1-2 sentences, what this PR does and why it matters",
  "technical_detail": "2-4 sentences, key technical changes and their implications",
  "direction_signal": "1 sentence about project direction, or null if routine",
  "significance": "routine | notable | directional_shift",
  "categories": ["architecture", "dependency", "api", "performance", "security", "testing", "docs"]
}
```

Significance 分类规则（写入 prompt）：
* **routine**: Bug fixes, minor refactors, test additions, dependency bumps, doc updates
* **notable**: New features, significant refactors (>10 files), new dependency categories, performance changes with benchmarks
* **directional_shift**: New architectural patterns (e.g., adding gRPC to REST-only), language/framework migrations, major API surface changes (>5 endpoints), new infrastructure patterns

LLM 调用：
* 使用 Vercel AI SDK（`ai` + `@ai-sdk/anthropic`，通过 AI gateway: `baseURL` + `apiKey` 从 settings 读取），model 默认 `claude-sonnet-4-6`
* 使用 `generateObject()` + Zod schema 获取结构化输出（schema 验证由 AI SDK 处理，无需手动 `JSON.parse()`）
* schema 校验失败（`NoObjectGeneratedError`）：显式重试 1 次，仍失败标记 `analysis_status = 'failed'`
* 记录 token 用量：从 `result.usage` 提取 `inputTokens` / `outputTokens`，结合 model 定价计算 `estimated_cost_usd`，写入 `analyses` 表

**2. Significance Pre-filter (`src/extensions/analyzer/significance.ts`)**

启发式规则（Week 1 仅做标记，不跳过）：

```ts
function preFilterSignificance(pr: PRData): "likely_routine" | "likely_notable" | "unknown" {
  if (pr.files_changed < 3 && pr.additions < 50 && /fix typo|bump|update deps|docs/i.test(pr.title))
    return "likely_routine";
  if (pr.files_changed > 10 || pr.additions > 500)
    return "likely_notable";
  return "unknown";
}
```

**5. Analyzer Stage (`src/pipeline/stages/analyze.ts`)**

完整实现：

* **Budget 硬上限检查（每个 PR 分析前）：**
  ```ts
  const monthlyUsage = db.query("SELECT SUM(estimated_cost_usd) as total_cost FROM analyses WHERE analyzed_at >= ?").get(monthStart);
  const estimatedCost = monthlyUsage.total_cost + estimateCallCost(prompt);
  if (estimatedCost > settings.budget.monthlyCap) {
    result.budgetExhausted = true;
    result.budgetSkippedCount = remainingPRs.length;
    break;
  }
  ```
* 查询（含重试）：
  ```sql
  SELECT pr.*, p.description, p.language, p.topics
  FROM pull_requests pr JOIN projects p ON pr.project_id = p.id
  WHERE pr.analysis_status = 'pending'
     OR (pr.analysis_status = 'failed' AND pr.retry_count < 3)
  ```
  ⚠️ 必须同时选择 `pending` 和可重试的 `failed` 行
* 对每个 PR 顺序处理（**不并发**，控制 API 负载）：
  1. 构建 `AnalysisContext`：读取 diff（检查 `diff_status === 'available'`）→ 截断 → 构建 PROJECT CONTEXT LITE
  2. 调用 LLM
  3. 持久化（三步原子性协议）：① 写截断 diff 到不依赖 `analysis_id` 的临时文件（如 `data/analysis-inputs/tmp/{pr_id}-{run_id}.diff.tmp`）② 同一 SQLite 事务写入 `analyses` + `analysis_inputs`（`insertAnalysis()` 返回 `analysis_id`，`truncated_diff_path` 指向最终路径 `data/analysis-inputs/{analysis_id}.diff`）③ `rename()` 临时文件为最终路径。若 ① 失败：跳过整个持久化，标记 `failed`。若 ② 失败（DB 事务回滚）：删除临时文件，无残留。若 ③ 失败：`UPDATE analysis_inputs SET truncated_diff_path = NULL WHERE analysis_id = ?`，audit export 标记该条为 snapshot_missing
* 成功：`UPDATE pull_requests SET analysis_status = 'complete' WHERE id = ?`
* 失败：`UPDATE pull_requests SET analysis_status = 'failed', retry_count = retry_count + 1, last_error = ? WHERE id = ?`
  → `retry_count < 3` 时下次 pipeline 运行自动重试；达到 3 次后永久 `failed`，不再重试
* 单个 PR 失败不阻断其他 PR

**StageResult 扩展：**
```ts
interface StageResult {
  // ... existing fields
  budgetExhausted?: boolean;
  budgetSkippedCount?: number;
}
```

Budget 耗尽时剩余 PR 保持 `pending`，Report stage 在日报中添加预算告警行。

**6. pi-agent Extension (`src/extensions/analyzer/index.ts`)**

* 将分析功能注册为 pi-agent tool `analyze-pr`（供交互式使用）
* Pipeline 中通过 stage 直接调用，不走 pi-agent tool

#### 技术约束

* 单次 LLM 调用 timeout: 60s
* 预估 token 消耗：~6000-10000 input + ~300-400 output = ~6500-10400 tokens/PR
* 预估成本：~$0.02-0.04/PR（Claude Sonnet）
* `supplementaryContext` 在 MVP 中始终为 null（CRG 的 slot，post-MVP 填充）
* `PROJECT CONTEXT LITE` 从 `projects` 表的 `description`/`language`/`topics` + config `tags`/`notes` 构建

#### 相关文件

| 操作 | 文件 |
|------|------|
| CREATE | `src/extensions/analyzer/context.ts`（AnalysisContext 接口 + builders） |
| CREATE | `src/extensions/analyzer/diff-truncator.ts`（智能 diff 截断） |
| CREATE | `src/extensions/analyzer/llm-reviewer.ts` |
| CREATE | `src/extensions/analyzer/significance.ts` |
| CREATE | `src/extensions/analyzer/index.ts` |
| MODIFY | `src/pipeline/stages/analyze.ts`（从空壳改为完整实现） |

#### 验收标准

* [ ] 对 pending PR 生成分析，`analyses` 表写入 summary/technical_detail/significance/categories
* [ ] `analysis_inputs` 表在同一事务中写入，包含 prompt_version/input_quality/file_manifest/rendered_project_context
* [ ] 截断 diff 快照保存到 `data/analysis-inputs/{analysis_id}.diff`
* [ ] diff-truncator 按 signal > source > tests > docs 优先级截断
* [ ] file manifest 附加到 prompt，>100 files 时按 tier 汇总
* [ ] `diff_status = 'too_large'` 或 `'missing'` 的 PR 以 metadata_only 模式分析
* [ ] `generateObject()` Zod schema 校验通过（必须包含 summary, technical_detail, direction_signal, significance, categories）
* [ ] `input_tokens`, `output_tokens`, `estimated_cost_usd` 正确记录（>0）
* [ ] 分析完成后 `pull_requests.analysis_status` = `'complete'`
* [ ] LLM 调用失败时标记 `'failed'`，`retry_count` 递增，`last_error` 记录错误信息
* [ ] `retry_count < 3` 的 `failed` PR 在下次 pipeline 运行时被自动重试
* [ ] `retry_count >= 3` 的 `failed` PR 不再被选取
* [ ] 单个 PR 失败不阻断其他 PR 的分析
* [ ] 月度 budget 硬上限：超限时 `StageResult.budgetExhausted = true`，日志输出跳过的 PR 数

---

### Issue 8: [Reporter] Daily report 生成器实现

**Priority:** High

#### Blocked By
Issue 7（需要 `analyses` 表中有分析数据）

#### Blocks
Issue 10, Issue 15

#### 目标

实现 Report Generator stage 的 daily report：聚合当天各项目的 PR 分析结果，生成结构化 JSON 报告，写入 `reports` 表 + 本地 JSON 文件（`data/reports/`）。M1 阶段通过本地文件验证分析质量，Lark 推送延迟到 M2。

#### 实现内容

**1. Daily Report 组装 (`src/extensions/report-generator/daily.ts`)**

* 查询：`SELECT a.*, pr.title, pr.pr_number, pr.project_id FROM analyses a JOIN pull_requests pr ON a.pr_id = pr.id WHERE a.analyzed_at >= ?`（今天 00:00 UTC）
* 按 `project_id` 分组
* 每个 project 生成：
  * Summary 行：`Project A: 3 PRs, 1 directional shift — migrating auth to OAuth2`
  * Detail 列表：每个 PR 的 `summary + significance + direction_signal`
* 排序规则：directional_shift 的 project 排最前 > notable > routine-only

**2. Lark Card 模板 (`src/extensions/report-generator/templates/daily-card.ts`)**

必须使用 Lark Message Card v2 格式：

```json
{
  "config": { "wide_screen_mode": true },
  "header": {
    "title": { "tag": "plain_text", "content": "Counterpart Monitor · Daily Digest · 2026-06-05" },
    "template": "blue"
  },
  "elements": [
    {
      "tag": "markdown",
      "content": "**Summary**\n* Project A: 3 PRs, 1 directional shift...\n* Project B: 5 PRs, routine"
    },
    { "tag": "hr" },
    {
      "tag": "collapsible_panel",
      "expanded": false,
      "header": { "title": { "tag": "plain_text", "content": "Technical Details" } },
      "elements": [
        { "tag": "markdown", "content": "**[Project A]**\n\nPR #1234: ...\nSignificance: NOTABLE\n..." }
      ]
    }
  ]
}
```

* 导出 `buildDailyCard(date: string, projectAnalyses: GroupedAnalyses): LarkCard`

**3. 本地 JSON 输出 (`src/extensions/report-generator/file-writer.ts`)**

* 每次生成报告后，同时写入本地 JSON 文件：`data/reports/daily-YYYY-MM-DD.json`
* JSON 结构：包含 `{ date, card, analyses, completeness }` — 完整的报告内容 + 原始分析数据
* 用于 M1 阶段本地验证分析质量，无需 Lark 即可审查输出
* 目录不存在时自动 `mkdirSync`

**4. Report Stage (`src/pipeline/stages/report.ts`)**

* 接收 `PipelineContext`，从中提取 collect/analyze stage 的 `failedProjects`
* 调用 `buildDailyReport()` 获取分析数据
* 如果当天无新分析数据：跳过，返回 `{ success: true, itemsProcessed: 0 }`
* 构建 completeness 元数据：
  ```ts
  const completeness = {
    total: trackedProjects.length,
    success: trackedProjects.length - failedProjects.length,
    failed: failedProjects  // e.g. ["vercel/next.js"]
  };
  ```
* 调用 `buildDailyCard()` 生成 card JSON
* 如果有 `failedProjects`：在 card summary 顶部添加 `"⚠ Partial report: {N} project(s) failed collection/analysis"` 标记
* **幂等写入**（同一周期不重复生成）：
  ```sql
  INSERT INTO reports (type, period_start, period_end, project_ids, content, completeness)
  VALUES ('daily', ?, ?, ?, ?, ?)
  ON CONFLICT(type, period_start, period_end)
  DO UPDATE SET content = excluded.content, completeness = excluded.completeness
  ```
* `period_start` = 今天 00:00 UTC, `period_end` = 今天 23:59:59 UTC
* ⚠️ 重复运行（手动触发、scheduler retry、进程重启）只更新同一行，不产生重复报告

#### 相关文件

| 操作 | 文件 |
|------|------|
| CREATE | `src/extensions/report-generator/daily.ts` |
| CREATE | `src/extensions/report-generator/templates/daily-card.ts` |
| CREATE | `src/extensions/report-generator/file-writer.ts` |
| MODIFY | `src/pipeline/stages/report.ts`（从空壳改为完整实现） |

#### 验收标准

* [ ] 生成的 card JSON 结构包含 `config`, `header`, `elements` 三层
* [ ] Summary section 列出每个项目的 PR 数 + 重要变化
* [ ] Technical detail 在 `collapsible_panel` 中
* [ ] 无分析数据时不生成报告（`itemsProcessed = 0`）
* [ ] `reports` 表正确写入 `type='daily'` 记录，含 `period_start`/`period_end`
* [ ] 重复运行 pipeline 不产生重复报告（upsert 覆盖同一行）
* [ ] 上游 stage 部分失败时，报告卡片中包含 partial report 标记
* [ ] `reports.completeness` 字段正确记录成功/失败项目数
* [ ] `data/reports/daily-YYYY-MM-DD.json` 本地文件正确生成，内容可读

---

### Issue 10: [Pipeline] 端到端集成联调与首份日报验证

**Priority:** Urgent

#### Blocked By
Issue 6, Issue 7, Issue 8, Issue 15, Issue 16（所有 M1 deliverables 完成）

#### Blocks
Issue 9（M2 Lark 推送）, Issue 17, Issue 18（M2 入口）

#### 目标

M1 最终验证：完整 pipeline 端到端执行成功（collect → analyze → report），本地 JSON 报告验证分析质量。Lark 推送延迟到 M2。

#### 实现内容

**1. 端到端执行（手动触发）**

* 确保 `config/projects.json` 配置了 3-5 个近期有活跃 PR 的项目
* 确保 `.env` 中环境变量已设置（`GITHUB_TOKEN`, `LLM_BASE_URL`, `LLM_API_KEY`）
* 执行 `runNow()` 或直接调用 `runPipeline([collect, analyze, report])`
* 预期数据流：GitHub API → `pull_requests` 表 → LLM → `analyses` 表 → card JSON → `reports` 表 + `data/reports/daily-YYYY-MM-DD.json`

**2. 验证检查清单**

逐项验证并记录结果：

* [ ] `pull_requests` 表中有 pending PR（collect 成功）
* [ ] `analyses` 表中有 complete 分析（analyze 成功）
* [ ] `reports` 表中有 daily report（report 成功）
* [ ] `data/reports/daily-YYYY-MM-DD.json` 本地文件生成，内容可读
* [ ] 报告 summary 准确描述了 PR 内容（审查本地 JSON）
* [ ] significance 分类基本合理（抽查 5 个 PR）
* [ ] `analysis_inputs` 表有数据，`prompt_version` 和 `file_manifest` 非空
* [ ] Audit export CLI 能导出 JSONL（Issue 16 验证）
* [ ] Weekly report 格式正确（Issue 15 验证）
* [ ] 单次 pipeline 总耗时 < 10 分钟（5 个项目）

**3. Scheduler 验证**

* 临时改 croner 为 5 分钟间隔，验证自动触发
* 确认第二次运行不重复分析已完成的 PR（增量语义）
* 确认第二次运行不产生重复 daily report（幂等 upsert）
* 恢复正常调度

**4. 已知限制与改进方向记录**

在 issue comment 中记录：
* 分析质量观察（哪些 PR 分类不准？）
* 无 CRG 上下文时的分析盲区
* Prompt 改进方向
* 性能数据：pipeline 耗时、API quota 消耗

#### 交付物

* `data/reports/` 中至少一份真实 daily digest JSON
* Issue comment 中的质量观察和改进方向记录

#### 验收标准

* [ ] 完整 pipeline collect → analyze → report 执行成功
* [ ] 本地 JSON 报告内容可读，分析质量基本达标
* [ ] 第二次运行为增量（不重复分析）
* [ ] Scheduler 自动触发验证通过

---

### Issue 15: [Reporter] Weekly report 聚合与趋势分析

**Priority:** High

#### Blocked By
Issue 8（daily report 模板机制复用）

#### Blocks
Issue 10（M1 end-to-end 验证包含 weekly 验证）

#### 目标

实现 Weekly report：聚合过去 7 天的 PR 分析数据，提取方向性变化和跨项目趋势，生成周报 card JSON（M1 本地验证，M2 经 Lark Dispatcher 发送）。

#### 实现内容

**1. Weekly Report 组装 (`src/extensions/report-generator/weekly.ts`)**

* 查询：`SELECT a.*, pr.*, p.id as project_id FROM analyses a JOIN pull_requests pr ... WHERE a.analyzed_at >= {7_days_ago}`
* 聚合三个维度：
  * **Direction Changes**: 所有 `significance = 'directional_shift'` 的 PR，按项目分组
  * **Activity Summary**: 各项目 PR 总数 + notable 数 + directional_shift 数
  * **Per-project Highlights**: 每个项目最重要的 1-2 个分析（取 significance 最高的）

**2. Weekly Card Template (`src/extensions/report-generator/templates/weekly-card.ts`)**

```json
{
  "config": { "wide_screen_mode": true },
  "header": {
    "title": { "tag": "plain_text", "content": "Weekly Intelligence · May 19-25" },
    "template": "purple"
  },
  "elements": [
    { "tag": "markdown", "content": "**Direction Changes This Week**\n* Project A: migrating auth (3 PRs)\n* Project C: added gRPC proto files" },
    { "tag": "hr" },
    { "tag": "markdown", "content": "**Activity Summary**\n* 23 PRs across 5 projects\n* 2 directional shifts\n* 8 notable changes" },
    { "tag": "hr" },
    { "tag": "collapsible_panel", "expanded": false,
      "header": { "title": { "tag": "plain_text", "content": "Per-project Highlights" } },
      "elements": [{ "tag": "markdown", "content": "..." }] }
  ]
}
```

**3. 集成到 Pipeline**

* 修改 `src/pipeline/stages/report.ts`：判断当前是否为 weekly report 日（默认周一）
* 周一时：生成 daily report + weekly report（两条 `reports` 记录）
* dispatch stage 无需修改（它发送所有 `sent_at IS NULL` 的报告）

**4. Scheduler 集成**

* 修改 `src/scheduler/cron.ts`：weekly cron 触发时设置 flag，report stage 读取此 flag 决定是否生成 weekly

#### 相关文件

| 操作 | 文件 |
|------|------|
| CREATE | `src/extensions/report-generator/weekly.ts` |
| CREATE | `src/extensions/report-generator/templates/weekly-card.ts` |
| MODIFY | `src/pipeline/stages/report.ts`（增加 weekly report 逻辑） |
| MODIFY | `src/scheduler/cron.ts`（增加 weekly 触发逻辑） |

#### 验收标准

* [ ] Weekly report 聚合了 7 天的分析数据
* [ ] Directional shift 在报告中被重点展示（排在最前面）
* [ ] Activity summary 数字准确
* [ ] 周一自动触发 weekly report 生成
* [ ] Lark 卡片格式清晰，与 daily 卡片风格一致但结构不同

---

### Issue 16: [Pipeline] Prompt Baseline + Audit Export

**Priority:** High

#### Blocked By
Issue 7（analyzer 实现完成）

#### Blocks
Issue 10（M1 end-to-end 验证）, Issue 17（数据驱动调优以此为基础）

#### 目标

建立 prompt 版本管理和审计导出基础设施。Prompt 有版本标签，`analysis_inputs` 表在分析时持久化完整输入快照，CLI 可导出 JSONL 供人工审计和 A/B 比较。

#### 实现内容

**1. Prompt 版本管理**

* 在 `src/extensions/analyzer/llm-reviewer.ts` 中定义 `PROMPT_VERSION` 常量（hash 或语义版本，如 `"v1.0-diff-aware"`）
* 每次分析时写入 `analysis_inputs.prompt_version`
* Prompt 变更时更新版本标签

**2. Audit Export CLI (`src/utils/audit-export.ts`)**

```ts
async function exportAnalyses(since: Date, until: Date, outputPath: string): Promise<number>;
// JSONL 格式，每行一个 { analysis, analysis_inputs, pr_metadata } 对象
// 包含 truncated diff 快照路径（data/analysis-inputs/{id}.diff）
```

* 可通过 `bun run src/utils/audit-export.ts --since 2026-06-10 --until 2026-06-17 --output data/audit/export.jsonl` 调用
* 输出包含完整的 prompt 重建所需信息

**3. 集成到 `src/index.ts`**

* 注册 `export-audit` 子命令（或 CLI flag `--export-audit`）

#### 相关文件

| 操作 | 文件 |
|------|------|
| MODIFY | `src/extensions/analyzer/llm-reviewer.ts`（添加 PROMPT_VERSION 常量） |
| CREATE | `src/utils/audit-export.ts`（JSONL 导出） |
| MODIFY | `src/index.ts`（注册 export-audit 子命令） |

#### 验收标准

* [ ] `analysis_inputs.prompt_version` 在每次分析时写入，非空
* [ ] `bun run src/utils/audit-export.ts --since ... --until ... --output ...` 输出有效 JSONL
* [ ] JSONL 每行包含 analysis + analysis_inputs + PR metadata
* [ ] 导出数据足够重建分析时的完整 prompt（rendered_project_context + file_manifest + truncated_diff_path）

---

## M2: Harden

> Target: 2026-06-25 (7 working days)
> Goal: 生产化就绪。Lark 推送上线，完善错误处理、速率限制、预算管控、数据管理，使系统可无人值守稳定运行。Prompt 调优基于 M1 真实数据。

---

### Issue 9: [Dispatcher] Lark webhook 推送实现

**Priority:** High

#### Blocked By
Issue 10（M1 验证通过后再接入 Lark）

#### Blocks
Issue 20（Lark 消息体积降级策略以此为基础）

#### 目标

实现 Lark Dispatcher stage：读取 `reports WHERE sent_at IS NULL`，通过 webhook 发送 Lark 消息卡片。M2 首个 issue — M1 本地验证通过后立即接入。

#### 实现内容

**1. Webhook 客户端 (`src/extensions/lark-dispatcher/webhook.ts`)**

```ts
interface LarkWebhookResponse {
  code: number;        // 0 = success
  msg: string;
  data?: { message_id: string };
}

async function sendCard(webhookUrl: string, card: object): Promise<LarkWebhookResponse> {
  const resp = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      msg_type: "interactive",
      card: card
    })
  });
  return resp.json();
}
```

* HTTP 非 200 或 `code !== 0` 时：重试 1 次（间隔 2s）
* 仍失败时返回错误，不 throw

**2. Formatter (`src/extensions/lark-dispatcher/formatter.ts`)**

* 接收 `reports.content`（card JSON string），解析为 object
* 体积检查（基本版，Issue 20 会增强）：
  * `Buffer.byteLength(JSON.stringify(card)) > 28000` 时 log 警告
  * 简单截断：移除 routine PR 的 detail

**3. Dispatch Stage (`src/pipeline/stages/dispatch.ts`)**

完整实现（通过 `report_deliveries` 表追踪每张卡片的发送状态）：

```ts
async function execute(): Promise<StageResult> {
  const unsent = db.query("SELECT * FROM reports WHERE sent_at IS NULL").all();
  for (const report of unsent) {
    db.run(
      "INSERT OR IGNORE INTO report_deliveries (report_id, card_index, content) VALUES (?, 0, ?)",
      report.id, report.content
    );

    const pendingDeliveries = db.query(
      "SELECT * FROM report_deliveries WHERE report_id = ? AND status != 'sent'"
    ).all(report.id);

    for (const delivery of pendingDeliveries) {
      const card = JSON.parse(delivery.content);
      const result = await sendCard(webhookUrl, card);
      if (result.code === 0) {
        db.run(
          "UPDATE report_deliveries SET status = 'sent', lark_message_id = ?, sent_at = ? WHERE id = ?",
          result.data?.message_id, unixNow(), delivery.id
        );
      } else {
        db.run("UPDATE report_deliveries SET status = 'failed' WHERE id = ?", delivery.id);
      }
    }

    const remaining = db.query(
      "SELECT COUNT(*) as cnt FROM report_deliveries WHERE report_id = ? AND status != 'sent'"
    ).get(report.id);
    if (remaining.cnt === 0) {
      db.run("UPDATE reports SET sent_at = ? WHERE id = ?", unixNow(), report.id);
    }
  }
}
```

**4. 环境变量校验**

* Lark 推送上线后，`LARK_WEBHOOK_URL` 变为必填
* 在 dispatch stage 启动时校验，缺失时 skip dispatch + log 警告（不 crash pipeline）

#### 相关文件

| 操作 | 文件 |
|------|------|
| CREATE | `src/extensions/lark-dispatcher/webhook.ts` |
| CREATE | `src/extensions/lark-dispatcher/formatter.ts` |
| CREATE | `src/extensions/lark-dispatcher/index.ts` |
| MODIFY | `src/pipeline/stages/dispatch.ts`（从空壳改为完整实现） |

#### 验收标准

* [ ] Lark 群组收到格式正确的消息卡片
* [ ] 卡片包含 summary + 可折叠 technical detail
* [ ] `report_deliveries` 记录正确创建，`status` 随发送结果更新
* [ ] 所有 delivery 成功后 `reports.sent_at` 才更新
* [ ] 发送失败时不 crash，`report_deliveries.status = 'failed'`，report 保持 `sent_at IS NULL` 等待下次重试
* [ ] 重复运行 dispatch 不重复发送已成功的 delivery（`status = 'sent'` 被跳过）
* [ ] `LARK_WEBHOOK_URL` 缺失时 dispatch stage 优雅跳过

---

### Issue 17: [Pipeline] 数据驱动 Prompt 调优

**Priority:** Medium

#### Blocked By
Issue 16, Issue 10（需要真实数据积累）

#### Blocks
Issue 23（significance 精细化以此为基础）

#### 目标

基于 M1 运行 5+ 天的真实数据，系统性调优 LLM prompt，提升 significance 分类准确率和 summary 可读性。

#### 实现内容

**1. 分析质量审计**

* 使用 Issue 16 的 audit export CLI 导出最近 7 天全部分析结果（含 `analysis_inputs`）
* 人工标注明显误分类的案例（routine 被标为 notable / directional_shift 被漏标）
* 统计分布：routine/notable/directional_shift 的比例是否合理（预期 ~70/25/5）

**2. Prompt 迭代**

* 调整 significance rubric 中的判断标准（基于误分类案例）
* 优化 diff 截断策略（是否 signal files 优先级需要调整）
* 调整 summary 的要求（"什么样的 summary 对 strategy 读者最有价值"）
* A/B 对比：对同一批 PR 用新旧 prompt 分别分析（使用 `analysis_inputs` 中保存的原始输入），对比结果

**3. 文档化**

* 最终 prompt 版本记录在 `src/extensions/analyzer/llm-reviewer.ts`
* 关键调优决策记录为 issue comment

#### 相关文件

| 操作 | 文件 |
|------|------|
| MODIFY | `src/extensions/analyzer/llm-reviewer.ts`（prompt 内容调整） |
| MODIFY | `src/extensions/analyzer/significance.ts`（pre-filter 规则可能调整） |
| MODIFY | `src/extensions/analyzer/diff-truncator.ts`（截断策略可能调整） |

#### 验收标准

* [ ] 对同一批 PR，新 prompt 的 significance 分类更准确
* [ ] Summary 可读性提升（strategy 读者无需技术背景即可理解）
* [ ] Directional shift 的检出率 > 70%（基于人工标注的已知案例）

---

### Issue 18: [Infra] 错误处理与重试逻辑

**Priority:** Urgent

#### Blocked By
Issue 10（M1 完成，所有 stage 已有基本实现）

#### Blocks
Issue 19, Issue 24

#### 目标

为整个 pipeline 补齐生产级错误处理和重试机制，覆盖所有外部 API 调用（GitHub, LLM, Lark）的 failure mode。

#### 实现内容

**1. 通用重试工具 (`src/utils/retry.ts`)**

```ts
interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryOn?: (error: Error) => boolean;  // 自定义重试条件
}

async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T>;
// 指数退避: delay = min(baseDelay * 2^attempt, maxDelay)
```

**2. GitHub API 错误处理**

修改 `src/extensions/github-collector/fetcher.ts`：

| Error | Detection | Recovery |
|-------|-----------|----------|
| 403 Rate Limit | HTTP 403 + `X-RateLimit-Remaining: 0` | 等待 `X-RateLimit-Reset` 时间后重试 |
| 404 Repo Deleted/Renamed | HTTP 404 | 标记 project inactive（`UPDATE projects SET ...`），log 告警 |
| 5xx Server Error | HTTP 500/502/503 | 指数退避重试，最多 3 次 |

**3. LLM API 错误处理**

修改 `src/extensions/analyzer/llm-reviewer.ts`：

| Error | Detection | Recovery |
|-------|-----------|----------|
| Timeout (>60s) | AbortController timeout | 标记 `failed` + `retry_count++`，下次 pipeline 自动重试（Issue 7 的重试机制） |
| 429 Rate Limit | HTTP 429 | 同一次运行内指数退避（5s, 10s, 20s） |
| Schema Validation Error | `generateObject()` 抛出 `NoObjectGeneratedError` | 通过 `retry()` 显式重试 1 次，仍失败则标记 `failed` + `retry_count++` |
| API Error | HTTP 500/overloaded | 同一次运行内指数退避，最多 2 次 |

单次运行内每个 PR 最多重试 2 次。跨运行重试由 `retry_count < 3` 控制（Issue 7 已实现）。

**4. Lark Webhook 错误处理**

修改 `src/extensions/lark-dispatcher/webhook.ts`：

| Error | Detection | Recovery |
|-------|-----------|----------|
| HTTP 非 200 | HTTP status | 重试 3 次（间隔 2s, 4s, 8s） |
| 全部失败 | 3 次重试后仍失败 | `report_deliveries.status = 'failed'`，report 保持 `sent_at IS NULL`，下次 pipeline 自动重试（Issue 9 机制） |

**5. Pipeline 韧性（已有，强化）**

确认以下行为（Issue 5 的 runner 应已实现）：
* 单个 project 失败不阻断其他 project
* 单个 PR 失败不阻断同项目其他 PR
* Pipeline crash 后重启自动恢复：`analysis_status = 'pending'` 或 `'failed' + retry_count < 3` 的 PR 被重新处理；`report_deliveries.status != 'sent'` 的卡片被重新发送

#### 相关文件

| 操作 | 文件 |
|------|------|
| CREATE | `src/utils/retry.ts` |
| MODIFY | `src/extensions/github-collector/fetcher.ts` |
| MODIFY | `src/extensions/github-collector/diff-fetcher.ts` |
| MODIFY | `src/extensions/analyzer/llm-reviewer.ts` |
| MODIFY | `src/extensions/lark-dispatcher/webhook.ts` |

#### 验收标准

* [ ] 模拟 GitHub 403：程序等待 reset 时间后自动重试（不 crash）
* [ ] 模拟 LLM timeout：PR 标记 `failed` + `retry_count++`，其他 PR 继续分析
* [ ] Lark 发送 3 次失败后：`report_deliveries.status = 'failed'`，下次 pipeline 重试
* [ ] Pipeline 中断后重启：不重复分析 `analysis_status = 'complete'` 的 PR，自动重试 `failed + retry_count < 3` 的 PR

---

### Issue 19: [Infra] GitHub API 速率限制主动管理

**Priority:** High

#### Blocked By
Issue 18（重试基础设施）

#### Blocks
无（独立增强）

#### 目标

在 Issue 18 的被动重试基础上，增加主动 rate limit 管理：追踪 quota 使用、预分配请求预算、低 quota 时自动降级。

#### 实现内容

**1. Rate Limit Tracker (`src/utils/rate-limiter.ts`)**

```ts
class GitHubRateLimiter {
  // 每次 Octokit 调用后更新
  updateFromHeaders(headers: { "x-ratelimit-remaining": string; "x-ratelimit-reset": string }): void;

  // 请求前检查
  async waitIfNeeded(): Promise<void>;  // remaining < 100 时等待 reset

  // 状态查询
  getStatus(): { remaining: number; resetAt: Date; usedThisRun: number };
}
```

* 当 `remaining < 500`：在每次请求之间增加 1s 间隔
* 当 `remaining < 100`：暂停所有请求，等待 reset 时间
* Pipeline 结束时 log 输出 quota 使用情况

**2. Request Budget 分配**

* Pipeline 开始时预估所需 API 调用数：`projects.length * (1 list call + avg_prs * 1 diff call)`
* 如果预估需求 > 可用 quota * 0.7：优先处理最近有活跃 PR 的项目，跳过低优先级项目

**3. 集成到 Collector**

* `fetcher.ts` 中每次 Octokit 调用前 `await rateLimiter.waitIfNeeded()`
* 每次调用后 `rateLimiter.updateFromHeaders(response.headers)`

#### 相关文件

| 操作 | 文件 |
|------|------|
| CREATE | `src/utils/rate-limiter.ts` |
| MODIFY | `src/extensions/github-collector/fetcher.ts` |
| MODIFY | `src/extensions/github-collector/diff-fetcher.ts` |

#### 验收标准

* [ ] 连续运行多次 pipeline 不触发 GitHub 403
* [ ] Quota 不足时自动降级（日志显示跳过了低优先级项目）
* [ ] Pipeline 结束时日志输出 API quota 使用情况（remaining/total/used_this_run）

---

### Issue 20: [Dispatcher] Lark 消息体积三级降级策略

**Priority:** High

#### Blocked By
Issue 9（Lark Dispatcher 基本实现）

#### Blocks
无（独立增强）

#### 目标

完善 Lark 消息卡片体积管理，实现三级降级策略，确保任何报告都能成功发送（不因体积超限而失败）。

#### 实现内容

**1. 三级降级策略（修改 `src/extensions/lark-dispatcher/formatter.ts`）**

```ts
function formatReport(report: Report): LarkCard | LarkCard[] {
  const fullCard = buildFullCard(report);
  const size = Buffer.byteLength(JSON.stringify(fullCard), "utf-8");

  if (size <= 20_000) return fullCard;                    // Level 1: 正常
  
  const trimmedCard = buildTrimmedCard(report);           // Level 2: 精简
  // 仅保留 notable + directional_shift PR
  // 添加 "N routine PRs omitted" 行
  const trimmedSize = Buffer.byteLength(JSON.stringify(trimmedCard), "utf-8");
  
  if (trimmedSize <= 28_000) return trimmedCard;
  
  return splitByProject(report);                          // Level 3: 按项目拆分
  // 每个项目一张卡片
}
```

* 体积计算使用 `Buffer.byteLength(str, "utf-8")`（不是 `str.length`，因为中文 3 bytes/char）
* 预留 2KB 安全边际（Lark 硬限制 ~30KB）

**2. 修改 Dispatch Stage — 通过 `report_deliveries` 追踪多卡片**

* `formatReport()` 返回 `LarkCard | LarkCard[]`
* Level 1/2（单卡片）：写入一条 `report_deliveries (card_index=0)`
* Level 3（拆分）：写入 N 条 `report_deliveries (card_index=0,1,2,...)`
* dispatch 逻辑只发送 `status != 'sent'` 的 delivery，不重复发送已成功的
* 部分发送失败时：已成功的 delivery 保持 `status='sent'`，失败的保持 `status='failed'`，下次 pipeline 运行仅重试失败的 card
* **report.sent_at 仅在所有 delivery 都成功后设置**（Issue 9 已建立此机制）

```ts
// Report Stage (report.ts) 在写入 reports 行后，立即创建 delivery 行：
const cards = formatReport(report);
const cardArray = Array.isArray(cards) ? cards : [cards];
for (let i = 0; i < cardArray.length; i++) {
  db.run(
    "INSERT OR IGNORE INTO report_deliveries (report_id, card_index, content) VALUES (?, ?, ?)",
    reportId, i, JSON.stringify(cardArray[i])
  );
}
```

#### 相关文件

| 操作 | 文件 |
|------|------|
| MODIFY | `src/extensions/lark-dispatcher/formatter.ts` |
| MODIFY | `src/pipeline/stages/dispatch.ts`（读取 report_deliveries 逐张发送） |
| MODIFY | `src/pipeline/stages/report.ts`（写入 report_deliveries 行） |

#### 验收标准

* [ ] 构造 <20KB 报告：完整发送，`report_deliveries` 一行 `card_index=0`
* [ ] 构造 20-30KB 报告：自动精简 routine PR，发送成功
* [ ] 构造 >30KB 报告：拆分为多张卡片，`report_deliveries` 多行
* [ ] 拆分后各卡片独立可读（有自己的 header 和 context）
* [ ] Card 1 发送成功 + Card 2 失败时：Card 1 保持 `status='sent'`，下次运行仅重试 Card 2
* [ ] 所有 card 发送成功后 `reports.sent_at` 才被设置

---

### Issue 21: [Infra] 数据留存自动化（diff 清理 + 报告归档 + VACUUM）

**Priority:** Medium

#### Blocked By
Issue 10（M1 完成，pipeline 已运行）

#### Blocks
无（独立维护任务）

#### 目标

实现数据留存策略，防止磁盘空间无限增长。三个维护任务：diff 文件清理、报告归档到 JSONL、SQLite VACUUM。

#### 实现内容

**1. 维护模块 (`src/pipeline/maintenance.ts`)**

```ts
// 每次 pipeline 运行结束后调用
async function cleanupDiffs(): Promise<number>;  // 返回删除文件数
// 逻辑: analysis_status = 'complete' 且 analyzed_at < 30 天前的 PR，删除其 diff_path 文件
// 30 天留存：Issue 17 的 prompt tuning A/B 比较需要原始 diff

// 月度执行
async function archiveReports(): Promise<number>;  // 返回归档报告数
// 逻辑: created_at < 90 天前的 reports，导出为 data/archive/YYYY-MM/reports.jsonl，然后 DELETE

// 月度执行，在 archiveReports 之后
async function vacuumDb(): Promise<void>;
// 逻辑: db.exec("VACUUM")
```

**2. 集成到 Scheduler**

* `cleanupDiffs()`: 每次 pipeline 运行后调用（在 dispatch 之后）
* `archiveReports()` + `vacuumDb()`: 月度 croner 任务（每月 1 号 03:00）

**3. 归档格式**

`data/archive/YYYY-MM/reports.jsonl`：每行一个 JSON 对象，包含 report 的全部字段。

#### 相关文件

| 操作 | 文件 |
|------|------|
| CREATE | `src/pipeline/maintenance.ts` |
| MODIFY | `src/scheduler/cron.ts`（注册月度维护任务） |
| MODIFY | `src/pipeline/runner.ts` 或 `src/index.ts`（pipeline 结束后调用 cleanupDiffs） |

#### 验收标准

* [ ] `analysis_status = 'complete'` 且超过 30 天的 PR 的 diff 文件被删除
* [ ] 90 天前的报告被导出到 `data/archive/YYYY-MM/reports.jsonl`
* [ ] 归档后 `reports` 表中对应记录被删除
* [ ] VACUUM 后 `monitor.db` 文件大小减小

---

### Issue 22: [Infra] LLM 预算监控与告警

**Priority:** Urgent

#### Blocked By
Issue 7（LLM 分析器已有 token 用量 + 成本记录）

#### Blocks
无（独立增强）

#### 目标

实现 LLM token 使用量追踪和预算管控：80% 时降级（跳过 routine PR），100% 时熔断（暂停分析 + Lark 告警）。

#### 实现内容

**1. Budget Tracker (`src/utils/budget-tracker.ts`)**

```ts
interface BudgetStatus {
  tokensUsedThisMonth: number;
  estimatedCostUSD: number;    // 基于 model 定价
  budgetCapUSD: number;        // 从 settings.budget.monthlyCap 读取
  usagePercent: number;        // estimatedCost / budgetCap
  action: "normal" | "skip_routine" | "pause";
}

function getBudgetStatus(): BudgetStatus {
  // 查询: SELECT SUM(input_tokens), SUM(output_tokens), SUM(estimated_cost_usd)
  //        FROM analyses WHERE analyzed_at >= {month_start}
  // 直接使用 SUM(estimated_cost_usd)（分析时已按 model 定价计算）
}
```

**2. 预算策略执行（修改 `src/pipeline/stages/analyze.ts`）**

在分析每个 PR 前检查 budget：

* `action = "normal"`: 正常分析
* `action = "skip_routine"` (80%-100%):
  * 使用 `significance.ts` 的 pre-filter 判断
  * `likely_routine` 的 PR 标记 `analysis_status = 'budget_skipped'`（需在 schema 的 CHECK 约束中增加此值）
  * `likely_notable` 和 `unknown` 的 PR 继续分析
  * 特例：>10 files OR >500 additions 的 PR **无论 budget 都分析**
* `action = "pause"` (100%):
  * 跳过全部分析
  * 发送 Lark 告警卡片：`"Budget alert: ${estimatedCost}/${budgetCap} used. Analysis paused."`

**3. Budget Dashboard（daily report 附加信息）**

修改 `src/extensions/report-generator/daily.ts`：在 card 末尾添加：
```
Budget: $23.50 / $50.00 (47%)
```
* 超过 60% 时显示
* 超过 80% 时标记 warning

**4. Schema 扩展**

`pull_requests.analysis_status` CHECK 约束需增加 `'budget_skipped'` 值。需要新的 migration 或修改 001_init.sql（如果还未上生产）。

#### 相关文件

| 操作 | 文件 |
|------|------|
| CREATE | `src/utils/budget-tracker.ts` |
| MODIFY | `src/pipeline/stages/analyze.ts`（budget 检查） |
| MODIFY | `src/extensions/report-generator/daily.ts`（budget dashboard） |
| MODIFY | `src/storage/schema.ts` 或新增 migration（增加 `budget_skipped` 状态） |

#### 验收标准

* [ ] `getBudgetStatus()` 返回准确的 token 统计和费用估算
* [ ] 模拟 80% budget：`likely_routine` PR 被跳过，标记为 `budget_skipped`
* [ ] 模拟 100% budget：全部分析暂停，Lark 收到告警卡片
* [ ] Daily report 末尾显示 budget usage

---

### Issue 23: [Analyzer] Significance 评分精细化调优

**Priority:** Medium

#### Blocked By
Issue 17（prompt 调优完成）

#### Blocks
无（独立优化）

#### 目标

基于至少两周的运行数据，精细化 significance 评分规则，减少误分类。

**注意：此 issue 需要至少两周的真实分析数据积累。建议在 M3 最后执行。**

#### 实现内容

**1. 误分类分析**

* 导出 `analyses` 表全部记录，人工标注 20-30 个明显误分类案例
* 分析模式：
  * 哪类 PR 容易被高估？（routine 被标为 notable）
  * 哪类 PR 容易被低估？（directional_shift 被标为 routine）
  * 是否存在项目特定 pattern？（如某项目 docs/ 更新被误标为 notable）

**2. 规则调优**

* 调整 LLM prompt 中的 significance rubric（基于误分类案例增加/修改示例）
* 调整 `significance.ts` 中的 pre-filter 规则
* 考虑项目级规则（如：已知文档密集型项目的 docs/ PR 降级为 routine）

**3. 回归验证**

* 对最近一周的 PR 用新规则重跑分析
* 对比新旧结果，确保调优不引入新误分类

#### 相关文件

| 操作 | 文件 |
|------|------|
| MODIFY | `src/extensions/analyzer/llm-reviewer.ts`（prompt rubric） |
| MODIFY | `src/extensions/analyzer/significance.ts`（pre-filter 规则） |

#### 验收标准

* [ ] 人工标注的误分类案例在新规则下分类正确（>80%）
* [ ] Directional shift 检出率 > 70%
* [ ] Routine PR 的 false positive rate 降低

---

### Issue 24: [Pipeline] 生产部署配置

**Priority:** Medium

#### Blocked By
Issue 18（错误处理完善，生产稳定性基础）

#### Blocks
无（M3 收尾）

#### 目标

配置生产环境部署，使系统可长期无人值守运行。

#### 实现内容

**1. 进程管理（pm2）**

创建 `ecosystem.config.js`：
```js
module.exports = {
  apps: [{
    name: "counterpart-monitor",
    script: "src/index.ts",
    interpreter: "bun",
    max_restarts: 10,
    restart_delay: 5000,
    env: {
      NODE_ENV: "production"
    }
  }]
};
```

**2. 环境配置**

* `.env.production.example`：包含所有必要环境变量模板
* 启动时配置校验已在 Issue 4 实现，此处确认生产环境下行为正确

**3. 健康检查**

* Pipeline 运行结果记录到 `data/health.json`：`{ lastRun, success, prsProcessed, errors }`
* 连续 3 次 pipeline 全部 stage 失败时：发送 Lark 告警

**4. 部署文档**

在项目 README 中添加 Deployment 章节：
* 环境要求：Bun >= 1.x, git
* 一键部署：`git clone && bun install && cp .env.production.example .env && pm2 start`
* 更新：`git pull && bun install && pm2 restart counterpart-monitor`

#### 相关文件

| 操作 | 文件 |
|------|------|
| CREATE | `ecosystem.config.js` |
| CREATE | `.env.production.example` |
| MODIFY | `src/index.ts` 或 `src/pipeline/runner.ts`（健康检查写入） |

#### 验收标准

* [ ] `pm2 start ecosystem.config.js` 后进程稳定运行
* [ ] 进程 crash 后 pm2 自动重启
* [ ] `data/health.json` 在每次 pipeline 运行后更新
* [ ] 连续 3 次失败时 Lark 收到告警

---

## M3 (Post-MVP): Deep Analysis + Evolution

> Target: TBD
> Goal: CRG 集成 + 完整 Project Overview + 演化功能。Gated by M2 完成。
> **Design change (2026-05-29):** Issues 11-14 从 MVP 移到此里程碑。See `docs/spark/2026-05-29-remove-crg-from-mvp-design.md`.

---

### Issue 11: [Infra] 本地仓库克隆管理模块

**Priority:** Urgent

#### Blocked By
M2 complete

#### Blocks
Issue 12, Issue 14

#### 目标

实现 tracked repos 的本地 shallow clone 管理：初始 clone、增量 fetch、stale 检测。这是 code-review-graph 的前提 — CRG 分析 working tree，必须有本地 clone。

#### 实现内容

**1. Clone Manager (`src/pipeline/clone-manager.ts`)**

```ts
// 核心 API
async function ensureClone(project: ProjectConfig): Promise<string>;  // 返回 clone path
async function updateClone(clonePath: string, project: ProjectConfig): Promise<void>;
function isStale(project: { last_synced_at: number | null }): boolean;
```

* `ensureClone(project)`:
  * 检查 `projects.clone_path` 是否已存在且有效
  * 不存在时：`git clone --depth=100 {project.url} ./repos/{org}-{repo}`
  * 更新 `projects.clone_path` 字段
  * 返回 clone 路径

* `updateClone(clonePath, project)`:
  * **`git fetch origin`（不带 `--depth` 参数！）** — 这是 eng review 的硬性要求
  * **原因：`git fetch --depth=N` 在 shallow clone 上会截断历史到 N commits from tip，不是扩展历史**
  * `git merge origin/{defaultBranch}`（通常是 `main` 或 `master`）
  * merge 失败时（force-push 场景）：`git reset --hard origin/{defaultBranch}`

* `isStale(project)`:
  * `last_synced_at` 超过 30 天前 → return true（跳过 fetch）

**2. 集成到 Pipeline**

* 在 collect stage **之前**执行 clone/fetch
* 修改 pipeline runner 或在 collect stage 开头调用
* 单个 repo clone 失败时 log error，继续下一个

**3. 磁盘空间管理**

* Clone 前检查：`df -k` 获取可用空间
* 预估：~500MB/repo，10 repos ≈ 5GB
* 空间不足（<1GB 可用）时 log 告警，不自动删除

#### 相关文件

| 操作 | 文件 |
|------|------|
| CREATE | `src/pipeline/clone-manager.ts` |
| MODIFY | `src/pipeline/stages/collect.ts`（在采集前调用 ensureClone + updateClone） |

#### 验收标准

* [ ] 首次运行后 `repos/` 下出现 shallow clone 目录
* [ ] `git -C repos/{org}-{repo} log --oneline -5` 能显示最近 commit
* [ ] 重复运行执行 `git fetch + merge`，不重新 clone
* [ ] `projects.clone_path` 字段正确指向 `repos/{org}-{repo}`
* [ ] 30+ 天未活跃的项目被 `isStale` 跳过

---

### Issue 12: [Analyzer] code-review-graph 集成桥接

**Priority:** Urgent

#### Blocked By
Issue 11（需要本地 clone 存在）

#### Blocks
Issue 13

#### 目标

实现 code-review-graph (CRG) Python CLI 的 TypeScript 桥接模块。CRG 提供 AST 级代码分析，输出 blast-radius 上下文供 LLM Analyzer 使用。

**前提：运行环境需安装 Python 3.10+ 和 `pip install code-review-graph`。**

#### 实现内容

**1. CRG Bridge (`src/extensions/analyzer/crg-bridge.ts`)**

封装四个 CLI 命令，通过 `Bun.spawn()` 或 `child_process.exec()` 执行：

```ts
// 首次 clone 后建立索引
async function buildGraph(repoPath: string): Promise<boolean>;
// CLI: cd {repoPath} && code-review-graph build
// 产出: {repoPath}/.code-review-graph/ 目录

// fetch+merge 后增量更新
async function updateGraph(repoPath: string): Promise<boolean>;
// CLI: cd {repoPath} && code-review-graph update

// 检测变更文件的影响范围
async function detectChanges(repoPath: string): Promise<ChangeDetection | null>;
// CLI: cd {repoPath} && code-review-graph detect-changes --brief --json
// 返回: { "changes": [{ "file": "src/auth.ts", "risk": 0.8, "affected": ["src/api.ts", ...] }] }

// 获取 token-budget-aware 的 review 上下文
async function getReviewContext(repoPath: string, changedFiles: string[], tokenBudget?: number): Promise<string | null>;
// CLI: cd {repoPath} && code-review-graph review-context --changed-files "file1.ts,file2.ts" --token-budget 4000
// 返回: 结构化文本，包含 callers, dependents, tests 信息
```

**2. 错误处理与降级**

* CRG 命令非零退出码：log 警告 `[CRG] build failed for {repo}: {stderr}`，返回 `null`
* CRG 未安装：启动时 `which code-review-graph` 检测，未找到时设置全局 flag `CRG_AVAILABLE = false`，所有调用直接返回 `null`
* 单次命令超时：120s，超时 kill 进程并返回 `null`
* **所有降级路径都不 throw**，返回 null 让调用方 fallback 到无 CRG 分析

**3. Graph 生命周期管理**

在 clone-manager 中调用（修改 `clone-manager.ts`）：
* `ensureClone` 成功后 → `buildGraph(clonePath)`
* `updateClone` 成功后 → `updateGraph(clonePath)`
* force-push reset 后 → `buildGraph(clonePath)`（全量 rebuild）

#### 相关文件

| 操作 | 文件 |
|------|------|
| CREATE | `src/extensions/analyzer/crg-bridge.ts` |
| MODIFY | `src/pipeline/clone-manager.ts`（clone/fetch 后调用 build/update） |

#### 验收标准

* [ ] 对已 clone 的 repo 执行 `buildGraph()`，`repos/{org}-{repo}/.code-review-graph/` 目录生成
* [ ] `detectChanges()` 返回有效 JSON（至少包含 `changes` 数组）
* [ ] `getReviewContext()` 返回文本，长度不超过 token budget 对应的字符数
* [ ] CRG 未安装时所有方法返回 `null`，不 crash
* [ ] 单个命令超时时返回 `null`，不阻塞进程

---

### Issue 13: [Analyzer] 增强 LLM 分析 — 集成 CRG blast-radius 上下文

**Priority:** High

#### Blocked By
Issue 12（CRG 桥接）

#### Blocks
无（M3 leaf issue）

#### 目标

将 code-review-graph 的 blast-radius 上下文注入 LLM 分析。通过 `AnalysisContext.supplementaryContext` 字段传递（MVP 中此字段为 `null`，M3 启用后填充 CRG 输出）。CRG 可用时 `inputQuality` 升级为 `"diff_plus_graph"`。

#### 实现内容

**1. 修改 AnalysisContext 构建逻辑 (`src/extensions/analyzer/context.ts`)**

在 `buildAnalysisContext()` 中增加 CRG 上下文获取：

```ts
// 在 diff truncation 之后、返回 AnalysisContext 之前：
let supplementaryContext: string | null = null;
let inputQuality: AnalysisContext["inputQuality"] = ctx.diff ? "diff_aware" : "metadata_only";

if (project.clone_path && CRG_AVAILABLE) {
  const changedFiles = await getChangedFilesFromDiff(pr);
  supplementaryContext = await getReviewContext(project.clone_path, changedFiles, 4000);
  if (supplementaryContext) inputQuality = "diff_plus_graph";
}

return { diff, supplementaryContext, projectContext, inputQuality };
```

**2. 修改 Prompt 构建 (`src/extensions/analyzer/llm-reviewer.ts`)**

* 当 `ctx.supplementaryContext !== null` 时，在 prompt 中插入 `SUPPLEMENTARY CONTEXT` 块（包含 CRG blast-radius 输出）
* 增加 prompt hint：`"If blast-radius context is provided, consider the dependency impact and affected callers when assessing significance."`
* `supplementaryContext` 为 `null` 时不插入该块（与 MVP 行为一致，无 fallback 文案）

#### 相关文件

| 操作 | 文件 |
|------|------|
| MODIFY | `src/extensions/analyzer/context.ts`（CRG 填充 supplementaryContext） |
| MODIFY | `src/extensions/analyzer/llm-reviewer.ts`（prompt 渲染 supplementaryContext） |

#### 验收标准

* [ ] CRG 可用时，`AnalysisContext.supplementaryContext` 非 null，`inputQuality` 为 `"diff_plus_graph"`
* [ ] CRG 可用时，prompt 中包含 `SUPPLEMENTARY CONTEXT` 块
* [ ] CRG 不可用时（clone 不存在或 CRG 未安装），`supplementaryContext` 为 `null`，行为与 MVP 一致
* [ ] Token usage 增加合理（+1500~2500 tokens/PR）
* [ ] 同一 PR 有 CRG vs 无 CRG 的分析结果可观察到差异（significance 或 detail 更具体）

---

### Issue 14: [Analyzer] Project Overview 自动生成

**Priority:** High

#### Blocked By
Issue 11（本地 clone 提供 README 等文件）

#### Blocks
无（M3 leaf issue）

#### 目标

LLM 读取项目 README + 最近 PR + manifest，生成项目概述，存入 `projects.overview`。此 overview 作为所有 PR 分析 prompt 的 `PROJECT CONTEXT`，让 LLM 理解项目背景。

#### 实现内容

**1. Overview Generator (`src/extensions/analyzer/overview-generator.ts`)**

```ts
async function generateOverview(project: ProjectConfig, clonePath: string): Promise<{
  overview: string;    // 200 words 以内的项目概述
  techStack: string[]; // e.g. ["TypeScript", "React", "PostgreSQL"]
}>;
```

* 收集输入：
  * `README.md` 前 3000 字符（从 clone 路径读取）
  * 包管理文件：`package.json` / `Cargo.toml` / `go.mod` / `pyproject.toml`（技术栈检测）
  * 最近 10 个 merged PR 的 title（从 `pull_requests` 表查询）
* 调用 LLM 生成 overview：
  * Prompt: `"Based on the README, package manifest, and recent PR titles, write a concise project overview (under 200 words) and list the detected tech stack as a JSON array."`
  * 输出格式: `{ "overview": "...", "tech_stack": ["TypeScript", ...] }`
* 写入 `projects.overview` 和 `projects.tech_stack`

**2. 触发逻辑**

* 在 collect stage 中：如果 `projects.overview IS NULL` 且 `clone_path` 存在 → 调用 `generateOverview()`
* 已有 overview 的项目不重复生成（未来在 TODOS.md 中有 30 天刷新的 P2 任务）

**3. 集成到分析 prompt**

修改 `llm-reviewer.ts`：查询 `projects.overview` 填充到 prompt 的 `PROJECT CONTEXT` 部分（替换当前的 fallback text）。

#### 相关文件

| 操作 | 文件 |
|------|------|
| CREATE | `src/extensions/analyzer/overview-generator.ts` |
| MODIFY | `src/pipeline/stages/collect.ts`（添加 overview 生成触发） |
| MODIFY | `src/extensions/analyzer/llm-reviewer.ts`（读取 overview 填充 prompt） |

#### 验收标准

* [ ] 对有 clone 的项目自动生成 overview（`projects.overview` 非空）
* [ ] Overview 内容准确描述项目（与 README 一致）
* [ ] `projects.tech_stack` 为有效 JSON array
* [ ] PR 分析 prompt 中 `PROJECT CONTEXT` 包含生成的 overview
* [ ] 已有 overview 的项目不重复调用 LLM

---

## Issue 依赖关系图

```
M0 (Scaffold):
  1 ─┬── 2 ──┐
     ├── 3 ──┼── 5
     └── 4 ──┘

M1 (Core Pipeline):
  5 ── 6* ── 7* ── 8
     └───────────────── (stage skeletons)
  8 ── 15 (weekly report, absorbed from old M2)
  7 ── 16 (prompt baseline + audit export)
  6 + 7 + 8 + 15 + 16 ── 10 (end-to-end validation)

M2 (Harden):
  10 ── 9 (Lark dispatcher)
  10 ── 18 ── 19
         │
    18 ── 24*
   7 ── 22
   9 ── 20
  10 ── 21
  16 + 10 ── 17 (data-driven prompt tuning)
  17 ── 23

M3 (Post-MVP, gated by M2 complete):
  M2 ── 11 ── 12 ── 13
         │
         └── 14
```

## 明确的 Blocking 关系（用于 Linear 的 blockedBy 字段）

| Issue | Blocked By |
|-------|------------|
| 1 | (none) |
| 2 | 1 |
| 3 | 1 |
| 4 | 1 |
| 5 | 2, 3, 4 |
| 6 | 2, 4, 5 |
| 7 | 5, 6 |
| 8 | 7 |
| 15 | 8 |
| 16 | 7 |
| 10 | 6, 7, 8, 15, 16 |
| 9 | 10 |
| 17 | 16, 10 |
| 18 | 10 |
| 19 | 18 |
| 20 | 9 |
| 21 | 10 |
| 22 | 7 |
| 23 | 17 |
| 24 | 18 |
| 11 | M2 complete |
| 12 | 11 |
| 13 | 12 |
| 14 | 11 |

## Priority 分布

| Priority | Count | Issues |
|----------|-------|--------|
| Urgent | 7 | 1, 2, 5, 6, 7, 10, 18 |
| High | 9 | 3, 4, 8, 9, 11, 12, 15, 16, 19, 20 |
| Medium | 7 | 13, 14, 17, 21, 22, 23, 24 |
