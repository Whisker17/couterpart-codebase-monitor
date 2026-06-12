# Design: Mantle Codebase 级影响检查（Impact Checker）

Date: 2026-06-12
Status: APPROVED (rev2 — 健壮性 review 后修订)
Affects: pipeline 阶段结构、`analyses` schema、`config/mantle-config.json`、`config/settings.json`、`budget-tracker`、Dockerfile、weekly counterpart-check

## 背景与目标

同事反馈：希望知道被监控的上游项目的 PR **是否会对 Mantle 对应的 codebase 产生实际影响**。Mantle 的很多 codebase 是上游 repo 的 fork 或依赖方，而监控名单正是这些上游 repo。需要回答的问题包括：

- 上游的 bug fix，对应的 bug 代码在 Mantle 的 fork 中是否也存在？fix 是否已被 cherry-pick？
- 上游的 feature/变更，是否影响 Mantle 当前代码？是否带来宕机类风险（例如 L1 引入新 EIP 改变区块头结构，影响 L2 derivation）？

现有的 weekly `counterpart-check.ts` 只基于元数据启发式（tag 重叠、关键词），证据等级最高 `metadata_supported`，从未真正读过 Mantle 代码。本设计将其升级为**基于真实代码证据的高置信度告警**。

### 需求决策记录

| 决策点 | 结论 |
|--------|------|
| Mantle 代码访问方式 | 全部为公开 GitHub repo，可 clone |
| 产出定位 | 高置信度告警：必须有真实代码证据，宁漏报不误报滥报 |
| 触发方式 | PR 分析中增加廉价预筛字段，命中才触发深度检查（可捕获被归为 routine 但对 fork 重要的 PR） |
| 关系类型 | 三类全支持：fork / 依赖 / 协议规范 |
| 送达形式 | 独立 Lark 告警卡片，立即发送，不混入日报 |
| 预算 | 月上限从 $80 上调到 $150，深度检查独立软上限 $50 |

### 关于 code-review-graph 与 codegraph 的定位

- 设计文档中原被推迟到 M3 的 **code-review-graph**（Python 3.10、图构建生命周期、~500MB/repo）与本设计无关，维持 deferred。
- 本设计采用 [colbymchenry/codegraph](https://github.com/colbymchenry/codegraph)（TypeScript + tree-sitter + 本地 SQLite，零外部依赖，支持 Go/Rust，CLI/MCP/库三态，MIT）作为 **agent 的检索加速工具层**。
- 核心原则：**codegraph 是给 agent 的工具，不是判断者**。fork 偏离处符号匹配会断，图查询不能直接产出结论；最终判断永远由 LLM agent 基于读到的真实代码做出，符号查不到时回退 grep。

## 架构总览

在现有四阶段流水线中插入新阶段 **Impact Checker**，成为五阶段：

```
GitHub Collector → Analyzer → Impact Checker → Report Generator → Lark Dispatcher
                      │            │
                      │            └─ 读 Mantle 本地 clone + codegraph 索引
                      └─ 输出新增预筛字段 downstream_impact_hint
```

阶段间仍通过 SQLite 状态列通信（保持可恢复、可调试），新增 `impact_checks` 表。新阶段实现为 `src/pipeline/stages/impact-check.ts`，遵循现有 `PipelineStage` 接口，`StageResult` 扩展见"可观测性"小节。

### 数据流（单次 pipeline 运行内）

1. **Analyzer 预筛**：PR 分析输出 schema 增加 `downstream_impact_hint`（`none | possible | likely`）和 `downstream_impact_reason`（一句话理由）。搭现有 LLM 调用便车，增量成本仅几十个输出 token。
2. **闸门判断**（纯代码，无 LLM）。源 repo 在 mantle-config 中存在至少一条到 mantleTarget 的关系，**且**满足以下任一条件的 PR，为每个 (PR × target) 组合插入一行 `impact_checks(status='pending')`：
   - `downstream_impact_hint != 'none'`，**或**
   - `significance in ('notable', 'directional_shift')`（防预筛漏报兜底：显著 PR 即使 hint=none 也入队）
3. **Impact Checker 阶段**：
   - 先 clone 同步：`git fetch + reset` 更新 Mantle 目标 repo 的 shallow clone（`data/mantle-repos/`，gitignored），随后增量 `codegraph index`
   - 按优先级排序处理 `pending` 行（排序规则见下），逐个执行 agentic 取证检查，直到当日配额（`maxChecksPerDay`）或预算触线
   - 处理完成写回裁决；未轮到的行保持 `pending`，下次运行继续
4. **Dispatch 阶段**：扫描 `status='complete'` 且通过发卡门槛（`affected = yes && confidence = high && evidence_kind != reasoning_based`）且 `alert_dispatched_at IS NULL` 的检查，每条发一张**独立 Lark 告警卡片**；发送成功写 `alert_dispatched_at`，失败留空下次运行自动重试。低于门槛的结果只入库不发卡。
5. **Weekly 升级**：`counterpart-check.ts` 证据等级新增 `code_verified`（最高级），周报 counterpart 环节优先引用 7 天窗口内的 `impact_checks` 结果（含 medium/uncertain 作为 worth-checking 候选）。

### 队列语义（配额、优先级、过期）

- **行创建时机**：闸门在 analyzer 完成后立即为命中的 (PR × target) 插入 `pending` 行（`UNIQUE(pr_id, target_project_id)` 幂等去重，重复运行不重复插入）。
- **处理优先级**：`significance`（directional_shift > notable > routine）→ `downstream_impact_hint`（likely > possible > none）→ PR 合并时间倒序。
- **配额**：每日最多处理 `maxChecksPerDay`（默认 5）条；配额按当日已写回裁决的行数计算，不含失败重试。
- **预算停机**：月度子上限（`monthlySubCap`）触线时，剩余 `pending` 行标 `skipped_budget`；总池（`monthlyCap`）触线同理。提供 CLI `bun run cli impact-check requeue` 将 `skipped_budget` 行重置为 `pending`（预算恢复后人工触发）。
- **过期**：`pending` 行对应的 PR 合并时间超过 `maxAgeDays`（默认 7 天）时标 `expired`，不再检查——过期告警弊大于利（信息已 stale，且会在积压后造成告警风暴）。周报仍可统计 expired 数量作为"覆盖缺口"信号。

### 设计边界

- **放在 Analyzer 之后**：闸门依赖预筛字段；深度检查需要 diff 已落盘。
- **失败不阻塞**：impact check 失败不影响 report/dispatch，日报照发；失败项留状态供下次运行重试。
- **串行处理**：检查逐个执行（无并发），单次 pipeline 运行内成本和 CPU 占用可预测；clone 同步每次运行只做一次。
- **"立即告警"的边界**：告警在 pipeline 运行内紧随检查完成发出，不等日报组装；但系统仍是每日 cron 批处理，"立即" = 检查完成后几秒，而非 PR 合并后几分钟。未来要更快可提高 collector+impact-check 的 cron 频率（如每 4 小时），架构不变。

## Impact Checker 组件设计

### 目录结构

```
src/extensions/impact-checker/
├── index.ts              # 阶段逻辑：闸门 + 队列处理（由 stages/impact-check.ts 调用）
├── clone-manager.ts      # Mantle repo shallow clone 同步 + codegraph 索引
├── codegraph-cli.ts      # codegraph CLI 子进程封装（search/callers/impact/node）
├── agent-tools.ts        # 注册给 LLM 的工具集定义（含路径围栏）
├── checker.ts            # agentic 取证循环 + 最终结构化裁决
└── strategies.ts         # 按关系类型生成检查指令
prompts/impact-check/
├── fork.md               # fork 关系检查 prompt
├── dependency.md         # 依赖关系检查 prompt
└── protocol.md           # 协议关系检查 prompt
```

### mantle-config.json 扩展

```jsonc
{
  "mantleTargets": [
    {
      "projectId": "mantle/reth",
      "repoUrl": "https://github.com/mantle/reth",   // 新增:可 clone 的公开地址
      "branch": "main",                               // 新增(可选):默认取 remote HEAD
      "tags": ["..."],
      "notes": "...",
      "architectureNotes": "Mantle reth fork 作为 L2 执行客户端。L2 derivation 依赖 L1 区块头结构与 blob 格式。改造点集中在 gas 计费 (MNT) 与 DA 层..."  // 新增:协议推理知识底座,人工维护
    }
  ],
  "counterpartRelationships": [
    {
      "source": "ethereum-optimism/op-geth",
      "targets": ["mantle/reth"],
      "relationship": "fork_of",
      "reason": "..."
    },
    {
      "source": "ethereum/go-ethereum",
      "targets": ["mantle/reth"],
      "relationship": "protocol_dependency",
      "reason": "L1 共识/区块结构变更影响 L2 derivation"
    }
  ]
}
```

- `relationship` 取值：`fork_of` / `depends_on` / `protocol_dependency`。
- 启动校验：`source` 必须是 projects.json 中被跟踪的 repo，否则打 warning（关系永远不会触发）；`repoUrl` 必须是 `https://github.com/` 前缀（clone 地址只来自配置，不来自任何运行时输入）；`architectureNotes` 为空的 target 上的 `protocol_dependency` 关系打 warning（推理无知识底座，质量不可靠）。
- 兼容：历史值 `"manual"` 按 `protocol_dependency` 处理（仅推理，不取证）。
- 同一对 source→target 配置多条关系时，按强度取最高一条执行检查（`fork_of` > `depends_on` > `protocol_dependency`），与 `impact_checks` 的 `UNIQUE(pr_id, target_project_id)` 约束一致——每个 PR×target 只做一次检查，检查指令中可附带次要关系作为补充上下文。

### Clone 管理（clone-manager.ts）

- **Clone 方式**：`git clone --depth 1 --single-branch --branch <branch>`；更新用 `git fetch --depth 1 origin <branch>` + `git reset --hard FETCH_HEAD`。不用 blobless partial clone（lazy blob fetch 会让 grep/read 隐式发起网络请求，破坏取证的确定性与速度）。
- **超时**：clone/fetch 120s，超时标记该 target 本轮不可用。`codegraph index` 首次全量给 10min 上限（reth 体量），增量 60s；超时降级为 grep-only 模式（见错误处理）。
- **磁盘护栏**：每次同步后检查 `clonesDir` 总占用，超过 `maxCloneDiskGB`(默认 10) 打 warning 并跳过新 target 的 clone（已有 clone 继续工作）。shallow clone 无需周期性 gc。
- **索引位置**：codegraph 索引（`.codegraph/`）位于各 clone 目录内，随 `data/` volume 持久化，容器重启不需重建。
- **记录同步状态**：每个 target 的最近 fetch 时间与 commit hash 写入 `impact_checks` 检查行的审计轨迹头部（证据可追溯到 Mantle 代码的具体 commit）。

### Agentic 取证循环（checker.ts）

用现有技术栈实现：Vercel AI SDK `generateText` + tools + `maxSteps`（上限 12 步），结束后 `generateObject` 产出结构化裁决。不引入新框架，符合"pi-agent 仅用于 LLM 工具注册"的架构决策。LLM 调用复用现有 `llm-retry.ts` 与 `resolveAnthropicBaseUrl` 网关接入方式。

**注册工具**（全部限定在对应 target repo 的 clone 目录内，只读）：

| 工具 | 实现 | 用途 |
|------|------|------|
| `codegraph_search` | CLI 子进程 | 符号/全文搜索，定位上游变更代码在 fork 中的对应物 |
| `codegraph_callers` | CLI 子进程 | 查 Mantle 内谁调用受影响代码 → 宕机风险面 |
| `codegraph_impact` | CLI 子进程 | 受影响符号的传递影响范围 |
| `grep_repo` | `rg` 子进程 | codegraph 未命中时的回退（改名/偏离场景） |
| `read_file` | Bun.file，带行号范围 | 读真实代码做最终比对 |
| `read_manifest` | 读 go.mod/Cargo.toml/lock | 依赖关系的版本取证 |

**工具硬化（安全与成本边界）**：

- **路径围栏**：`read_file`/`grep_repo` 对路径做 `realpath` 解析后强制校验在 clone 目录内，拒绝 `..`、绝对路径逃逸与符号链接逃逸。上游 PR 的 title/body/diff 是**不可信输入**（可能包含针对 agent 的注入文本）——工具全部只读、无 shell 字符串拼接（子进程一律 argv 数组传参）、无网络访问，即使 agent 被注入误导，影响面也只是"读错了文件、得出 uncertain 结论"。
- **输出上限**：每次工具调用结果截断到 8KB / 200 行（截断时注明）；`read_file` 单次最多 250 行；`grep_repo` 默认 `-g '!.codegraph'` 排除索引目录、最多返回 50 个匹配。
- **子进程超时**：codegraph/rg 单次调用 30s，超时作为工具错误返回给 agent（agent 可换策略），不中断整个检查。
- **单次检查成本上限**：`maxCostPerCheck`（默认 $1.0）。每步累计估算成本，超限强制跳到 generateObject 裁决（多半产出 uncertain）。与 `maxSteps` 双保险。

**上下文注入**：上游 PR 标题/body/截断 diff（复用 `diff-truncator`）、analyzer 的 summary 与 technical_detail、关系类型对应检查指令、target 的 `architectureNotes`、本次 Mantle clone 的 commit hash 与同步时间。

**diff 不可用的降级**：`diff_status != 'available'`（`too_large`/`missing`/`fetch_failed`）时检查仍执行，但 prompt 注明"无 diff，仅基于 PR 元数据与 analyzer 结论"，且**confidence 上限 medium**——没有上游变更细节就不可能有 high 置信度的代码级证据，自然不会发卡，但结果仍进周报候选。

### 按关系类型的检查策略

- **fork_of**：① codegraph/grep 在 fork 中定位上游被改函数/文件的对应位置 ② read_file 比对——bug 代码是否同样存在？fix 是否已 cherry-pick？是否已偏离 ③ 确认存在则用 callers/impact 评估 Mantle 侧影响面。证据类型 `code_evidence`，必须含文件路径 + 行号 + 代码片段。
- **depends_on**：① read_manifest 找 Mantle 锁定的上游版本 ② 判断变更是否落入实际使用的模块与升级路径 ③ 如为 breaking change，用 codegraph 查 Mantle 对该 API 的使用点。证据类型 `manifest_evidence` 或 `code_evidence`。
- **protocol_dependency**：无共享代码，基于 `architectureNotes` + diff 推理；可用工具在 Mantle 代码中查找处理对应协议结构的代码作佐证。证据类型 `reasoning_based`，**confidence 上限 medium**——纯推理永远不发 high 告警；若 agent 找到代码级佐证则升级为 `code_evidence`（可达 high）。

### 裁决输出 schema（Zod，generateObject）

```ts
{
  affected: "yes" | "no" | "uncertain",
  impactType: "bug_also_present" | "breaking_change" | "downtime_risk"
            | "behavior_change" | "not_affected",
  evidenceKind: "code_evidence" | "manifest_evidence" | "reasoning_based",
  evidence: [{ file: string, lines: string, snippet: string, note: string }],
  confidence: "high" | "medium" | "low",
  summary: string,            // 什么变更、为何影响 Mantle、影响什么
  recommendedAction: string,  // 工程师下一步（如"检查 fork 的 x.go 是否需要 cherry-pick #1234"）
}
// tokensUsed / cost / toolSteps 由程序填入，非 LLM 输出
```

**裁决后校验（程序侧，非 LLM）**：`evidenceKind = code_evidence` 时 `evidence[].file` 必须真实存在于 clone 中且 snippet 与文件内容匹配（防幻觉证据）；校验失败将 confidence 降为 low 并在审计轨迹标记。**发卡门槛**：`affected = yes && confidence = high && evidenceKind != reasoning_based`。`uncertain` 与 medium 结果入库、进周报候选，不单独打扰人。

## 数据模型

新 migration：`src/storage/migrations/007_impact_check.sql`。

### `analyses` 表新增两列

```sql
ALTER TABLE analyses ADD COLUMN downstream_impact_hint TEXT
  CHECK(downstream_impact_hint IN ('none','possible','likely')) DEFAULT 'none';
ALTER TABLE analyses ADD COLUMN downstream_impact_reason TEXT;
```

### 新表 `impact_checks`

```sql
CREATE TABLE impact_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_id INTEGER NOT NULL REFERENCES pull_requests(id),
  analysis_id INTEGER NOT NULL REFERENCES analyses(id),
  target_project_id TEXT NOT NULL,        -- 如 "mantle/reth"
  relationship TEXT NOT NULL CHECK(relationship IN ('fork_of','depends_on','protocol_dependency')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','complete','failed','skipped_budget','expired')),
  affected TEXT CHECK(affected IN ('yes','no','uncertain')),
  impact_type TEXT,
  evidence_kind TEXT,
  evidence TEXT,                          -- JSON array
  confidence TEXT,
  summary TEXT,
  recommended_action TEXT,
  target_commit TEXT,                     -- 检查时 Mantle clone 的 commit hash
  input_tokens INTEGER, output_tokens INTEGER,
  model_id TEXT, estimated_cost_usd REAL,
  tool_steps INTEGER,                     -- agentic 循环实际步数，用于成本调优
  alert_card_json TEXT,                   -- 渲染后的告警卡片(通过发卡门槛才生成)
  alert_dispatched_at INTEGER,            -- 发卡时间，NULL = 未发/待重试
  checked_at INTEGER,                     -- 裁决写回时间
  created_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(pr_id, target_project_id)        -- 每个 PR×target 只检查一次
);
CREATE INDEX idx_impact_checks_status ON impact_checks(status);
CREATE INDEX idx_impact_checks_alert ON impact_checks(alert_dispatched_at)
  WHERE alert_card_json IS NOT NULL;
```

**审计轨迹**：完整 agent 轨迹（每步工具调用与结果、clone commit、prompt 版本）写入 `data/impact-checks/{id}.jsonl`，沿用 `analysis_inputs` 思路：DB 存元数据 + 文件存大体积内容，30 天保留（维护任务与现有 diff 清理一并处理）。

## 告警卡片与发送跟踪

独立 Lark 卡片模板，红色 header：

```
🚨 Mantle 影响告警: [impact_type 中文标签]
上游: ethereum-optimism/op-geth#1234 — PR 标题（链接）
影响: mantle/reth (fork) @ [target_commit 短哈希]
─────
[summary]
证据:
  • path/to/file.go:120-135 — [note]
    [snippet，截断到 ~10 行]
建议动作: [recommendedAction]
─────
confidence: high · evidence: code_evidence · check #42 · 2026-06-12
```

**发送跟踪不复用 `report_deliveries`**——该表的 `report_id NOT NULL` 外键与 `reports.type` 的 CHECK 约束（`daily|weekly|monthly`）都与告警卡不匹配，硬塞需要造合成 report 行。改为 `impact_checks` 表内自跟踪：

- 通过发卡门槛的检查在裁决写回时同步渲染卡片存入 `alert_card_json`（卡片内容与裁决同事务持久化，崩溃后可恢复）。
- Dispatch 阶段扫描 `alert_card_json IS NOT NULL AND alert_dispatched_at IS NULL` 发送，成功写 `alert_dispatched_at`。失败留空，下次 pipeline 运行自动重试（与 `report_deliveries` 的重试语义一致）。
- 现有 redispatch CLI 增加 `--impact-check <id>` 标志：将指定行的 `alert_dispatched_at` 置空触发重发。
- 单卡单告警，snippet 逐条截断 ~10 行、整卡超 20KB 时丢弃多余 evidence 条目只留前两条，体积远低于 30KB 限制。

## 预算与 settings 变更

```jsonc
{
  "budget": { "monthlyCap": 150 },          // 80 → 150
  "impactCheck": {                          // 新增配置节
    "enabled": true,
    "maxChecksPerDay": 5,
    "maxStepsPerCheck": 12,
    "maxCostPerCheck": 1.0,                 // 单次检查成本上限(美元)
    "monthlySubCap": 50,                    // 深度检查独立软上限(美元)
    "maxAgeDays": 7,                        // pending 超龄过期
    "clonesDir": "data/mantle-repos",
    "maxCloneDiskGB": 10
  }
}
```

**`budget-tracker.ts` 必须修改**（现状只 SUM `analyses` 表，不改则深度检查花费对预算系统不可见）：

- `getBudgetStatus()` 的月度花费改为 `analyses` + `impact_checks` 两表之和。
- 新增 `getImpactCheckBudgetStatus()`：单独 SUM `impact_checks.estimated_cost_usd` 对照 `monthlySubCap`。
- 闸门顺序：先查子上限再查总池，任一触线即停止深度检查、剩余标 `skipped_budget`——**保 PR 分析基础盘**。日报加一行 "⚠ N 个影响检查因预算暂停"。

成本估算：预筛后每天 1-3 次深度检查 × $0.1-0.5/次 ≈ 月增量 $5-45，叠加现有 $35-65，总量在 $150 上限内；`maxCostPerCheck` 与 `maxChecksPerDay` 双重防失控。

## 部署变更（Dockerfile / compose）

生产运行在 `oven/bun:1` 容器内，本设计新增三个运行时依赖，全部进镜像：

```dockerfile
# Dockerfile 追加
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep \
    && rm -rf /var/lib/apt/lists/*
RUN bun install -g codegraph@<pinned-version>   # 版本锁定,升级走镜像重建
COPY prompts/ ./prompts/
RUN mkdir -p data/mantle-repos data/impact-checks
```

- **codegraph 版本锁定**：pre-1.0 项目，CLI 行为可能变化；启动时 `codegraph --version` 自检，版本不符打 warning。
- **clone 持久化**：`data/mantle-repos/` 在现有 `./data:/app/data` volume 内，容器重建不丢 clone 与索引。
- **存量问题（顺带修复）**：现 Dockerfile 未 COPY `prompts/`，compose 也未挂载——意味着 weekly/monthly prompt report 在容器内读不到 `prompts/reports/*.md`。本变更的 `COPY prompts/` 一并修复该问题（应单独验证 weekly 在容器内恢复正常）。
- 镜像增量：git + ripgrep + codegraph ≈ 100-150MB，可接受。

## 错误处理

| 故障 | 行为 |
|------|------|
| clone fetch 失败/超时 | 该 target 本轮检查全部跳过（保持 `pending`，旧 clone 不可信不强行检查）；日报加降级提示，下次运行重试 |
| codegraph index 失败/超时 | 降级运行：agent 只用 grep/read 工具，prompt 注明索引不可用；裁决照常 |
| codegraph/rg 单次调用超时 | 作为工具错误返回 agent（可换策略重试），不中断检查 |
| agent 超 maxSteps / maxCostPerCheck | 强制进入 generateObject 裁决，通常 affected = uncertain，不发卡，入库 |
| LLM 调用失败 | 复用 `llm-retry.ts`，重试耗尽标 `failed`；`failed` 行下次 pipeline 重置为 `pending` 捞起，最多重试 3 轮后保持 `failed` 终态 |
| 证据校验失败（幻觉防护） | confidence 降为 low，不发卡，审计轨迹标记 `evidence_verification_failed` |
| 告警卡发送失败 | `alert_dispatched_at` 留空，下次运行自动重试；可 CLI 手动重发 |
| codegraph CLI 缺失/版本不符 | 启动检测：缺失则 impact-check 阶段以 grep-only 降级运行 + 日志告警；不影响其他阶段 |
| pending 积压超龄 | `maxAgeDays` 过期机制防告警风暴（见队列语义） |

## 可观测性

- `StageResult` 扩展：`impactChecksRun`、`impactAlertsSent`、`impactChecksSkipped`（按原因分桶：budget/quota/clone_failure）、`impactChecksExpired`。
- 日报追加一行摘要："Mantle 影响检查：今日 N 检查 / M 告警 / K 待处理"（仅在有活动时显示）。
- 现有 `db status` operator CLI 增加 `impact_checks` 各状态计数。

## 测试策略

- **单元**：闸门逻辑（hint × significance × 关系 × 配额 × 预算组合）、队列优先级与过期、strategies prompt 组装、codegraph CLI 封装（mock 子进程）、**路径围栏**（`..`/绝对路径/符号链接逃逸用例）、工具输出截断、裁决 schema 校验、证据存在性校验、预算双上限触线顺序。
- **集成**：fixture 放一对迷你 repo（fake-upstream + fake-fork，fork 含一个已知共同 bug 和一处偏离），mock LLM 走完整 agentic 循环，验证工具调用与取证路径；clone-manager 用本地 bare repo 测 fetch/reset/超时；budget-tracker 两表合算。
- **e2e**：`e2e-run.ts` 增加 `--with-impact-check`，真实 LLM 跑一个历史已知案例（如上游某真实 bug fix），人工核对证据质量与告警卡渲染。

## 分期落地

| Phase | 内容 | 说明 |
|-------|------|------|
| 1 | clone-manager + codegraph 集成 + `fork_of` 策略 + 告警卡片 + budget-tracker 两表合算 + Dockerfile 变更 | 端到端打通，价值最高的关系类型。闸门临时用 "significance ≥ notable + 有关系映射" 代替预筛字段 |
| 2 | `depends_on` + `protocol_dependency` 策略 + analyzer 预筛字段 + requeue/过期 CLI | 补全三类关系与正式闸门 |
| 3 | 周报 counterpart-check 升级为消费 `impact_checks` | 新增 `code_verified` 证据等级 |

版本影响：schema migration + 新增配置节 + 新 env 无（凭据复用现有），按发布规范属 **MINOR** 升级；Dockerfile 变更使部署需要镜像重建（`deploy.sh` 已含 `--build`，无额外手工步骤）。

## 被否决的备选方案

- **方案 B（CRG 索引 + 符号映射作为判断者）**：fork 偏离处符号匹配最脆弱，覆盖不了依赖/协议两类关系，原 code-review-graph 运维成本高。codegraph 仅作为 agent 工具层被采纳。
- **方案 C（无 clone，GitHub API 按需取码）**：GitHub code search 对 fork 索引不全、不支持灵活 grep、rate limit 紧，取证能力弱，与高置信度告警定位冲突。

## Rev2 修订记录（健壮性 review，2026-06-12）

对照真实代码库核对后修正：

1. **[硬伤] 告警发送跟踪重设计**：原方案"复用 `report_deliveries` + `report_type = 'mantle_alert'`"与真实 DDL 不符（无 `report_type` 列、`report_id NOT NULL` 指向带 CHECK 约束的 `reports` 表）。改为 `impact_checks` 内 `alert_card_json` + `alert_dispatched_at` 自跟踪。
2. **[硬伤] budget-tracker 集成**：现有 `getBudgetStatus()` 只 SUM `analyses` 表，必须改为两表合算，否则深度检查花费对预算系统不可见。
3. **[硬伤] 部署依赖补全**：生产为 `oven/bun:1` 容器，新增 git/ripgrep/codegraph 进镜像；发现并顺带修复存量问题——Dockerfile 未 COPY `prompts/`，weekly/monthly prompt report 在容器内读不到 prompt 文件。
4. **闸门兜底**：significance ≥ notable 的 PR 即使预筛 hint=none 也入队，防预筛漏报。
5. **队列语义补全**：行创建时机、优先级排序、配额计算、`skipped_budget` requeue CLI、`maxAgeDays` 过期防告警风暴。
6. **工具硬化**：路径围栏（上游 PR 内容视为不可信输入）、argv 数组传参禁 shell 拼接、输出截断上限、子进程超时、`maxCostPerCheck` 单检查成本上限。
7. **幻觉防护**：裁决后程序侧校验 `code_evidence` 的文件存在性与 snippet 匹配，失败降级 confidence。
8. **diff 不可用降级**：`too_large`/`missing` 时仍检查但 confidence 上限 medium，不可能发 high 告警。
9. **clone 细节**：depth-1 single-branch、不用 blobless partial clone（lazy fetch 破坏取证确定性）、超时与磁盘护栏、`target_commit` 入库保证证据可追溯。
10. **可观测性**：StageResult 扩展、日报摘要行、`db status` CLI 计数。
