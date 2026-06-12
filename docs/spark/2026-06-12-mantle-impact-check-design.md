# Design: Mantle Codebase 级影响检查（Impact Checker）

Date: 2026-06-12
Status: APPROVED (rev4 — GPT round-2 review 修复)
Affects: pipeline 阶段结构、`analyses` schema、`config/mantle-config.json`、`config/settings.json`、`src/config/projects.ts`、`budget-tracker`、Dockerfile、weekly counterpart-check

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
- **codegraph 是可降级增强，不是地基**（rev3）：Phase 1 仅用 grep/read 工具端到端打通；codegraph 的确切 npm 包名、安装方式、CLI 子命令与版本号**未经验证**，必须在其集成 Phase 开始时实测后写死，整个系统在 codegraph 不可用时以 grep-only 模式照常工作。

## 架构总览

在现有四阶段流水线中插入新阶段 **Impact Checker**，成为五阶段：

```
GitHub Collector → Analyzer → Impact Checker → Report Generator → Lark Dispatcher
                      │            │
                      │            ├─ 读 Mantle 本地 clone (+ codegraph 索引)
                      │            └─ 告警卡在本阶段内直接发送(见下)
                      └─ 输出新增预筛字段 downstream_impact_hint
```

阶段间仍通过 SQLite 状态列通信（保持可恢复、可调试），新增 `impact_checks` 表。新阶段实现为 `src/pipeline/stages/impact-check.ts`，遵循现有 `PipelineStage` 接口。

### 告警发送时机（rev3 修正）

原 rev2 写"Dispatch 阶段发卡、不等日报组装"——与阶段顺序自相矛盾：dispatch 排在 report generator **之后**，告警必然等完报告生成。修正为：

- **首发在 Impact Checker 阶段内**：每条检查裁决写回后，若通过发卡门槛，立即调用 `sendCard()`（复用 `lark-dispatcher/webhook.ts`，与 runner 的 health alert 同模式）发送告警卡，成功写 `alert_dispatched_at` 与 `lark_message_id`。
- **Dispatch 阶段作为重试兜底**：dispatch 增加一个扫描——`alert_card_json IS NOT NULL AND alert_dispatched_at IS NULL AND alert_attempt_count < 5` 的行重试发送。首发失败的告警最迟在同一次 pipeline 运行的 dispatch 阶段重试，仍失败则下次运行再试。
- 现有 dispatch 对 `report_deliveries` 的扫描逻辑不变。

**必须尊重 `--no-dispatch`（rev4）**：当前 `--no-dispatch` 的实现只是把 dispatch 从 stage 列表移除（`getRunStages()`），阶段内直发会绕过它，导致本地验证/回放时误发真告警。修正：`PipelineContext` 增加 `dispatchEnabled: boolean`（`--no-dispatch` 置 false），**Impact Checker 的首发与 dispatch 兜底扫描都必须检查该标志**。抑制状态下（`dispatchEnabled = false` 或 webhook 未配置）：跳过发送、不消耗 `alert_attempt_count`、`alert_dispatched_at` 保持 NULL——卡片留在表里，恢复正常 dispatch 的下一次运行自然补发。

**投递语义：显式选择 at-least-once（rev4）**：发送成功与 `alert_dispatched_at` 写回是两步，进程在两步之间崩溃会导致下次重发——这无法靠事务消除（Lark webhook 不可回滚）。本设计**接受重复、不接受漏发**（告警漏发的代价远高于偶发重复），卡片 footer 固定携带稳定的 `check #id` 作为人工去重线索。不选 at-most-once（先写 DB 再发送）——那会把崩溃窗口变成静默漏发，与"高置信度告警必达"的定位冲突。

### 数据流（单次 pipeline 运行内）

1. **Analyzer 预筛**：PR 分析输出 schema 增加 `downstream_impact_hint`（`none | possible | likely`）和 `downstream_impact_reason`（一句话理由）。搭现有 LLM 调用便车，增量成本仅几十个输出 token。
2. **闸门判断**（纯代码，无 LLM）。源 repo 在 mantle-config 中存在至少一条到 mantleTarget 的关系、PR 合并时间在 `maxAgeDays` 内，**且**满足以下任一条件的 PR，为每个 (PR × target) 组合 upsert 一行 `impact_checks`（upsert 策略见队列语义）：
   - `downstream_impact_hint != 'none'`，**或**
   - `significance in ('notable', 'directional_shift')`（防预筛漏报兜底：显著 PR 即使 hint=none 也入队）

   **分期口径（rev4 消除矛盾）**：`analyses` 的两个预筛列随 007 migration 在 Phase 1 一并建好（避免二次 migration），但 analyzer 的 prompt/schema **到 Phase 2 才开始填写**——Phase 1 期间所有行都是默认值 `'none'`，hint 条件结构上存在但永远不命中，闸门实际只由 significance 兜底条件驱动。这就是"Phase 1 临时闸门"的准确含义：不是另一套逻辑，而是同一闸门在 hint 全为 none 时的自然退化。回放校准脚本在 Phase 1 也只按 significance 分桶，Phase 2 后可加 hint 维度重跑。
3. **Impact Checker 阶段**：
   - 先 clone 同步：`git fetch + reset` 更新 Mantle 目标 repo 的 shallow clone（`data/mantle-repos/`，gitignored），随后增量 codegraph 索引（如启用）
   - 按优先级排序处理 `pending` 行，逐个执行 agentic 取证检查，直到当日配额（`maxChecksPerDay`）或预算触线
   - 裁决写回后立即发送通过门槛的告警卡（见上）；未轮到的行保持 `pending`，下次运行继续
4. **Dispatch 阶段**：照常处理 `report_deliveries`，外加告警卡重试兜底扫描。
5. **Weekly 升级**：`counterpart-check.ts` 证据等级新增 `code_verified`（最高级），周报 counterpart 环节优先引用 7 天窗口内的 `impact_checks` 结果（含 medium/uncertain 作为 worth-checking 候选）。

### 队列语义（upsert、配额、优先级、过期）

- **Upsert 而非 insert-once（rev3 修正）**：`analyses` 表对同一 PR 允许多行（报告侧一律取 latest），re-analysis、关系类型修正、配置变更都会让已有 impact 行的 `analysis_id`/`relationship` 过时。闸门写入采用：

  ```sql
  INSERT INTO impact_checks (pr_id, analysis_id, target_project_id, relationship, config_hash, ...)
  VALUES (...)
  ON CONFLICT(pr_id, target_project_id) DO UPDATE SET
    analysis_id = excluded.analysis_id,
    relationship = excluded.relationship,
    config_hash = excluded.config_hash,
    status = 'pending',
    retry_count = 0
  WHERE impact_checks.status IN ('pending','failed','skipped_budget','expired')
    AND (impact_checks.analysis_id != excluded.analysis_id
         OR impact_checks.config_hash != excluded.config_hash);
  ```

  即：**非终态行跟随 latest analysis 与当前配置刷新并复活**；`complete` 行不动（已裁决的结论不因 re-analysis 静默改变——需要重查时人工 requeue）。
- **config_hash（rev4 扩面）**：覆盖**所有影响 clone、prompt 或裁决的配置**的稳定哈希——`counterpartRelationships` 中该 source→target 关系条目（relationship/reason）+ target 的 `repoUrl`、`branch`、`architectureNotes`、`notes`、`tags`。任何一项修正后，旧的非终态行自动按新配置重查；prompt 模板本身的版本由独立的 `prompt_version` 列追踪，不进 config_hash。
- **处理优先级**：`significance`（directional_shift > notable > routine）→ `downstream_impact_hint`（likely > possible > none）→ PR 合并时间倒序。
- **配额**：每日最多处理 `maxChecksPerDay`（默认 5，上线校准后调整）条；配额按当日已写回裁决的行数计算。
- **预算停机**：月度子上限（`monthlySubCap`）触线时，剩余 `pending` 行标 `skipped_budget`；总池（`monthlyCap`）触线同理。CLI `bun run cli impact-check requeue` 将 `skipped_budget` 行重置为 `pending`（预算恢复后人工触发；同时重置 `retry_count`）。
- **过期**：`pending` 行对应的 PR 合并时间超过 `maxAgeDays`（默认 7 天）时标 `expired`，不再检查——过期告警弊大于利（信息已 stale，且会在积压后造成告警风暴）。闸门同样不为超龄 PR 创建新行。周报仍可统计 expired 数量作为"覆盖缺口"信号。
- **失败重试**：检查失败 `status='failed'`、`retry_count += 1`、`last_error` 记录原因；下次运行将 `retry_count < 3` 的 failed 行重置为 `pending` 捞起，达到 3 次保持 `failed` 终态。

### 设计边界

- **放在 Analyzer 之后**：闸门依赖预筛字段；深度检查需要 diff 已落盘。
- **失败不阻塞**：impact check 失败不影响 report/dispatch，日报照发。
- **串行处理**：检查逐个执行（无并发），单次 pipeline 运行内成本和 CPU 占用可预测；clone 同步每次运行只做一次。
- **"立即告警"的边界**：告警在检查裁决写回后立即发出（同一阶段内，先于 report 生成）；但系统仍是每日 cron 批处理，"立即" = 检查完成后几秒，而非 PR 合并后几分钟。未来要更快可提高 collector+impact-check 的 cron 频率（如每 4 小时），架构不变。

## Impact Checker 组件设计

### 目录结构

```
src/extensions/impact-checker/
├── index.ts              # 阶段逻辑：闸门 + 队列处理（由 stages/impact-check.ts 调用）
├── clone-manager.ts      # Mantle repo shallow clone 同步 + codegraph 索引
├── codegraph-cli.ts      # codegraph CLI 子进程封装（Phase 2,可降级）
├── agent-tools.ts        # 注册给 LLM 的工具集定义（含路径围栏）
├── checker.ts            # agentic 取证循环 + 最终结构化裁决
└── strategies.ts         # 按关系类型生成检查指令
prompts/impact-check/
├── fork.md               # fork 关系检查 prompt
├── dependency.md         # 依赖关系检查 prompt
└── protocol.md           # 协议关系检查 prompt
```

### 配置层改造（rev3 补全）

现状不只是"加 JSON 字段"，有三处既有代码要动：

1. **`src/config/projects.ts`**：`MantleConfig` 的 `relationship: "manual"` 是字面量类型，需扩为 `"fork_of" | "depends_on" | "protocol_dependency" | "manual"`（`manual` 兼容读取、按 `protocol_dependency` 处理）；`mantleTargets` 类型增加 `repoUrl`/`branch`/`architectureNotes` 可选字段。
2. **模块缓存**：`getMantleConfig()` 有模块级缓存 `_mantleConfig`，新增 `reloadMantleConfig()`（对齐 `reloadTrackedProjects()` 模式），pipeline 每次运行开头重载，配置修正不需重启进程。
3. **`src/config/settings.ts`**：`SettingsConfig`/`Settings` 接口增加 `impactCheck` 配置节（含默认值，配置缺节时整体禁用并打 info 日志——老配置文件直接兼容）；`SafeConfigSnapshot`/`reloadSafeConfig()` 纳入 `impactCheck`，使配额、预算等参数支持热重载（与 budget 参数同等待遇）。

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

- 启动校验：`source` 必须是 projects.json 中被跟踪的 repo，否则打 warning（关系永远不会触发）；`repoUrl` 必须是 `https://github.com/` 前缀（clone 地址只来自配置，不来自任何运行时输入）；`architectureNotes` 为空的 target 上的 `protocol_dependency` 关系打 warning（推理无知识底座，质量不可靠）。
- 同一对 source→target 配置多条关系时，按强度取最高一条执行检查（`fork_of` > `depends_on` > `protocol_dependency`），与 `impact_checks` 的 `UNIQUE(pr_id, target_project_id)` 约束一致——每个 PR×target 只做一次检查，检查指令中可附带次要关系作为补充上下文。

### Clone 管理（clone-manager.ts）

- **Clone 方式**：`git clone --depth 1 --single-branch --branch <branch>`；更新用 `git fetch --depth 1 origin <branch>` + `git reset --hard FETCH_HEAD`。不用 blobless partial clone（lazy blob fetch 会让 grep/read 隐式发起网络请求，破坏取证的确定性与速度）。
- **超时**：clone/fetch 120s，超时标记该 target 本轮不可用。codegraph 索引（启用后）首次全量 10min 上限，增量 60s；超时降级为 grep-only 模式。
- **磁盘护栏**：每次同步后检查 `clonesDir` 总占用，超过 `maxCloneDiskGB`(默认 10) 打 warning 并跳过新 target 的 clone（已有 clone 继续工作）。shallow clone 无需周期性 gc。
- **索引位置**：codegraph 索引（`.codegraph/`）位于各 clone 目录内，随 `data/` volume 持久化，容器重启不需重建。
- **记录同步状态**：每个 target 的最近 fetch 时间与 commit hash 写入检查行（`target_commit` 列）与审计轨迹头部（证据可追溯到 Mantle 代码的具体 commit）。

### Agentic 取证循环（checker.ts）

用现有技术栈实现：Vercel AI SDK（项目锁定 `ai@^6`）`generateText` + tools + **`stopWhen: stepCountIs(N)`**（步数上限，默认 12——注意 v5+ 已无 `maxSteps` 参数，rev3 修正 API 名），结束后 `generateObject` 产出结构化裁决。不引入新框架，符合"pi-agent 仅用于 LLM 工具注册"的架构决策。LLM 调用复用现有 `llm-retry.ts` 与 `resolveAnthropicBaseUrl` 网关接入方式。

**注册工具**（全部限定在对应 target repo 的 clone 目录内，只读）：

| 工具 | 实现 | Phase | 用途 |
|------|------|-------|------|
| `grep_repo` | `rg` 子进程 | 1 | 在 fork 中检索上游变更代码的对应物（Phase 1 主力，之后作为 codegraph 回退） |
| `read_file` | Bun.file，带行号范围 | 1 | 读真实代码做最终比对 |
| `read_manifest` | 读 go.mod/Cargo.toml/lock | 3 | 依赖关系的版本取证 |
| `codegraph_search` | CLI 子进程 | 2 | 符号/全文搜索，比 grep 更准地定位对应物 |
| `codegraph_callers` | CLI 子进程 | 2 | 查 Mantle 内谁调用受影响代码 → 宕机风险面 |
| `codegraph_impact` | CLI 子进程 | 2 | 受影响符号的传递影响范围 |

**工具硬化（安全与成本边界）**：

- **路径围栏**：`read_file`/`grep_repo` 对路径做 `realpath` 解析后强制校验在 clone 目录内，拒绝 `..`、绝对路径逃逸与符号链接逃逸。上游 PR 的 title/body/diff 是**不可信输入**（可能包含针对 agent 的注入文本）——工具全部只读、无 shell 字符串拼接（子进程一律 argv 数组传参）、无网络访问，即使 agent 被注入误导，影响面也只是"读错了文件、得出 uncertain 结论"。
- **输出上限**：每次工具调用结果截断到 8KB / 200 行（截断时注明）；`read_file` 单次最多 250 行；`grep_repo` 默认 `-g '!.codegraph'` 排除索引目录、最多返回 50 个匹配。
- **子进程超时**：codegraph/rg 单次调用 30s，超时作为工具错误返回给 agent（agent 可换策略），不中断整个检查。
- **单次检查成本上限**：`maxCostPerCheck`（默认 $1.0）。每步累计估算成本，超限强制跳到 generateObject 裁决（多半产出 uncertain）。与步数上限双保险。

**上下文注入**：上游 PR 标题/body/截断 diff（复用 `diff-truncator`）、analyzer 的 summary 与 technical_detail（取 latest analysis）、关系类型对应检查指令、target 的 `architectureNotes`、本次 Mantle clone 的 commit hash 与同步时间。

**diff 不可用的降级**：`diff_status != 'available'`（`too_large`/`missing`/`fetch_failed`）时检查仍执行，但 prompt 注明"无 diff，仅基于 PR 元数据与 analyzer 结论"，且**confidence 上限 medium**——没有上游变更细节就不可能有 high 置信度的代码级证据，自然不会发卡，但结果仍进周报候选。

### 按关系类型的检查策略

- **fork_of**：① grep/codegraph 在 fork 中定位上游被改函数/文件的对应位置 ② read_file 比对——bug 代码是否同样存在？fix 是否已 cherry-pick？是否已偏离 ③ 确认存在则评估 Mantle 侧影响面（Phase 2 起可用 callers/impact）。证据类型 `code_evidence`，必须含文件路径 + 行号 + 代码片段。
- **depends_on**：① read_manifest 找 Mantle 锁定的上游版本/commit ② 判断变更是否落入实际使用的模块与升级路径 ③ 如为 breaking change，检索 Mantle 对该 API 的使用点。**置信度规则（rev3 收紧）**：仅凭 manifest 锁定版本**不能**断言"PR 变更会进入 Mantle 使用的版本"——版本包含性（该 PR 落在哪个 release/tag、Mantle 锁定版本是否包含）在没有上游 release 信息的情况下只是推测，证据为 `manifest_evidence` 时 confidence 上限 **medium**。要给 high，必须在 Mantle 代码中找到对受影响 API 的实际使用点（升级为 `code_evidence`）。
- **protocol_dependency**：无共享代码，基于 `architectureNotes` + diff 推理；可用工具在 Mantle 代码中查找处理对应协议结构的代码作佐证。证据类型 `reasoning_based`，**confidence 上限 medium**——纯推理永远不发 high 告警；若 agent 找到代码级佐证则升级为 `code_evidence`（可达 high）。

> 统一规则：**high confidence 当且仅当 `code_evidence`**。`manifest_evidence` 与 `reasoning_based` 一律封顶 medium。发卡门槛随之简化。

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

**裁决后校验（程序侧，非 LLM）**：① `evidenceKind = code_evidence` 时 `evidence[].file` 必须真实存在于 clone 中且 snippet 与文件内容匹配（防幻觉证据），校验失败将 confidence 降为 low 并在审计轨迹标记；② 程序侧强制执行置信度封顶规则（非 code_evidence 的 high 一律降为 medium）。**发卡门槛**：`affected = yes && confidence = high`（结合封顶规则即蕴含 `code_evidence`）。`uncertain` 与 medium 结果入库、进周报候选，不单独打扰人。

## 数据模型

新 migration：`src/storage/migrations/007_impact_check.sql`。

### `analyses` 表新增两列

```sql
ALTER TABLE analyses ADD COLUMN downstream_impact_hint TEXT
  CHECK(downstream_impact_hint IN ('none','possible','likely')) DEFAULT 'none';
ALTER TABLE analyses ADD COLUMN downstream_impact_reason TEXT;
```

### 新表 `impact_checks`（rev3 补全 retry/审计字段）

```sql
CREATE TABLE impact_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_id INTEGER NOT NULL REFERENCES pull_requests(id),
  analysis_id INTEGER NOT NULL REFERENCES analyses(id),  -- 闸门 upsert 保持指向 latest
  target_project_id TEXT NOT NULL,        -- 如 "mantle/reth"
  relationship TEXT NOT NULL CHECK(relationship IN ('fork_of','depends_on','protocol_dependency')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','complete','failed','skipped_budget','expired')),
  -- 裁决
  affected TEXT CHECK(affected IN ('yes','no','uncertain')),
  impact_type TEXT,
  evidence_kind TEXT,
  evidence TEXT,                          -- JSON array
  confidence TEXT,
  summary TEXT,
  recommended_action TEXT,
  -- 审计与可复现性
  target_commit TEXT,                     -- 检查时 Mantle clone 的 commit hash
  prompt_version TEXT,                    -- 策略 prompt 文件的版本哈希
  config_hash TEXT,                       -- 关系条目 + architectureNotes 的稳定哈希
  input_tokens INTEGER, output_tokens INTEGER,
  model_id TEXT, estimated_cost_usd REAL,
  tool_steps INTEGER,
  -- 重试与告警投递
  retry_count INTEGER NOT NULL DEFAULT 0, -- 检查失败重试计数(上限 3)
  last_error TEXT,                        -- 最近一次失败原因
  alert_card_json TEXT,                   -- 渲染后的告警卡片(通过发卡门槛才生成)
  alert_attempt_count INTEGER NOT NULL DEFAULT 0,
  alert_dispatched_at INTEGER,            -- 发卡成功时间，NULL = 未发/待重试
  lark_message_id TEXT,                   -- webhook 返回的消息 ID(如有)
  checked_at INTEGER,                     -- 裁决写回时间
  created_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(pr_id, target_project_id)
);
CREATE INDEX idx_impact_checks_status ON impact_checks(status);
CREATE INDEX idx_impact_checks_alert ON impact_checks(alert_dispatched_at)
  WHERE alert_card_json IS NOT NULL;
```

**审计轨迹**：完整 agent 轨迹（每步工具调用与结果、clone commit、prompt 版本）写入 `data/impact-checks/{id}.jsonl`——路径由 `id` 推导，不需要列。沿用 `analysis_inputs` 思路：DB 存元数据 + 文件存大体积内容，30 天保留（维护任务与现有 diff 清理一并处理）。

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

- 通过发卡门槛的检查在裁决写回时同步渲染卡片存入 `alert_card_json`（卡片内容与裁决同事务持久化，崩溃后可恢复），随即在 Impact Checker 阶段内首发（见"告警发送时机"）。
- 每次发送尝试 `alert_attempt_count += 1`；成功写 `alert_dispatched_at` 与 `lark_message_id`。失败留空，dispatch 阶段及后续 pipeline 运行重试，`alert_attempt_count >= 5` 后停止自动重试（防 webhook 长期故障下的无限重试）。
- 现有 redispatch CLI 增加 `--impact-check <id>` 标志：将指定行的 `alert_dispatched_at` 置空、`alert_attempt_count` 归零，触发重发。
- 单卡单告警，snippet 逐条截断 ~10 行、整卡超 20KB 时丢弃多余 evidence 条目只留前两条，体积远低于 30KB 限制。

## 预算与 settings 变更

```jsonc
{
  "budget": { "monthlyCap": 150 },          // 80 → 150
  "impactCheck": {                          // 新增配置节(缺节 = 整体禁用,兼容老配置)
    "enabled": true,
    "maxChecksPerDay": 5,                   // 初始值,以回放校准结果为准
    "maxStepsPerCheck": 12,
    "maxCostPerCheck": 1.0,                 // 单次检查成本上限(美元)
    "monthlySubCap": 50,                    // 深度检查独立软上限(美元)
    "maxAgeDays": 7,                        // pending 超龄过期
    "clonesDir": "data/mantle-repos",
    "maxCloneDiskGB": 10,
    "codegraphEnabled": false               // Phase 2 验证后打开
  }
}
```

**`budget-tracker.ts` 必须修改**（现状只 SUM `analyses` 表，不改则深度检查花费对预算系统不可见）：

- `getBudgetStatus()` 的月度花费改为 `analyses` + `impact_checks` 两表之和。
- 新增 `getImpactCheckBudgetStatus()`：单独 SUM `impact_checks.estimated_cost_usd` 对照 `monthlySubCap`。
- 闸门顺序：先查子上限再查总池，任一触线即停止深度检查、剩余标 `skipped_budget`——**保 PR 分析基础盘**。日报加一行 "⚠ N 个影响检查因预算暂停"。

成本估算：预筛后每天 1-3 次深度检查 × $0.1-0.5/次 ≈ 月增量 $5-45，叠加现有 $35-65，总量在 $150 上限内；`maxCostPerCheck` 与 `maxChecksPerDay` 双重防失控。

### 上线校准（rev3 新增，Phase 1 交付物）

`maxChecksPerDay=5` 与 `monthlySubCap=$50` 是拍脑袋初值，启用前必须用真实数据校准：提供回放脚本 `scripts/impact-check-backtest.ts`，对**最近 30 天已有的 `analyses` 数据 × 当前 mantle relationships** 运行闸门逻辑（不调 LLM），输出：每日 (PR × target) 候选量分布、按 significance/hint 的分桶、超配额天数占比。据此调整配额与子预算，再打开 `enabled`。该脚本保留为常驻工具——关系配置变更后可重新评估候选量。

## 部署变更（Dockerfile / compose）

生产运行在 `oven/bun:1` 容器内，新增运行时依赖进镜像：

```dockerfile
# Dockerfile 追加(Phase 1)
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep \
    && rm -rf /var/lib/apt/lists/*
COPY prompts/ ./prompts/
RUN mkdir -p data/mantle-repos data/impact-checks

# Phase 2(codegraph 集成时,包名/安装方式实测后写死)
# RUN <verified install command for codegraph, pinned version>
```

- **codegraph 安装方式待验证（rev3 改口）**：其 npm 包名、是否提供独立二进制、CLI 子命令集都需要在 Phase 2 开工时实测确认，本文档不预设 `bun install -g codegraph` 可行。确认后在 Dockerfile 写死版本，启动时 `--version` 自检，版本不符打 warning 并降级 grep-only。
- **clone 持久化**：`data/mantle-repos/` 在现有 `./data:/app/data` volume 内，容器重建不丢 clone 与索引。
- **存量问题（顺带修复）**：现 Dockerfile 未 COPY `prompts/`，compose 也未挂载——意味着 weekly/monthly prompt report 在容器内读不到 `prompts/reports/*.md`。本变更的 `COPY prompts/` 一并修复该问题（应单独验证 weekly 在容器内恢复正常）。
- 镜像增量：git + ripgrep ≈ 50MB（codegraph 另计），可接受。

## 错误处理

| 故障 | 行为 |
|------|------|
| clone fetch 失败/超时 | 该 target 本轮检查全部跳过（保持 `pending`，旧 clone 不可信不强行检查）；日报加降级提示，下次运行重试 |
| codegraph index 失败/超时 | 降级运行：agent 只用 grep/read 工具，prompt 注明索引不可用；裁决照常 |
| codegraph/rg 单次调用超时 | 作为工具错误返回 agent（可换策略重试），不中断检查 |
| agent 超步数上限 / maxCostPerCheck | 强制进入 generateObject 裁决，通常 affected = uncertain，不发卡，入库 |
| LLM 调用失败 | 复用 `llm-retry.ts`；耗尽后 `status='failed'`、`retry_count += 1`、`last_error` 记录；`retry_count < 3` 下次运行自动复活，达 3 次保持终态 |
| 证据校验失败（幻觉防护） | confidence 降为 low，不发卡，审计轨迹标记 `evidence_verification_failed` |
| 告警卡发送失败 | 阶段内首发失败 → dispatch 兜底重试 → 后续运行重试，`alert_attempt_count >= 5` 停止；CLI 可手动重发 |
| codegraph CLI 缺失/版本不符 | 启动检测：grep-only 降级运行 + 日志告警；不影响其他阶段 |
| pending 积压超龄 | `maxAgeDays` 过期机制防告警风暴（见队列语义） |

## 可观测性

- `StageResult` 扩展：`impactChecksRun`、`impactAlertsSent`、`impactChecksSkipped`（按原因分桶：budget/quota/clone_failure）、`impactChecksExpired`。
- 日报追加一行摘要："Mantle 影响检查：今日 N 检查 / M 告警 / K 待处理"（仅在有活动时显示）。
- 现有 `db status` operator CLI 增加 `impact_checks` 各状态计数。

## 测试策略

- **单元**：闸门逻辑（hint × significance × 关系 × 配额 × 预算组合 × 超龄）、**upsert 策略**（latest analysis 刷新、complete 行不动、config_hash 变更复活）、队列优先级与过期、失败重试计数、strategies prompt 组装、codegraph CLI 封装（mock 子进程）、**路径围栏**（`..`/绝对路径/符号链接逃逸用例）、工具输出截断、裁决 schema 校验、证据存在性校验、**置信度封顶强制执行**、预算双上限触线顺序、告警重试上限。
- **集成**：fixture 放一对迷你 repo（fake-upstream + fake-fork，fork 含一个已知共同 bug 和一处偏离），mock LLM 走完整 agentic 循环，验证工具调用与取证路径；clone-manager 用本地 bare repo 测 fetch/reset/超时；budget-tracker 两表合算；回放脚本对 fixture 数据出数。
- **e2e**：`e2e-run.ts` 增加 `--with-impact-check`，真实 LLM 跑一个历史已知案例（如上游某真实 bug fix），人工核对证据质量与告警卡渲染。

## 分期落地（rev3 重排：先窄后宽，先治理后增强）

| Phase | 内容 | 说明 |
|-------|------|------|
| 1 | `fork_of` 检查器端到端：clone-manager + grep/read 工具 + **完整队列治理**（upsert/优先级/配额/过期/requeue CLI）+ 阶段内告警发送与重试（含 `dispatchEnabled` 标志）+ budget-tracker 两表合算 + 配置层改造 + Dockerfile（git/rg/prompts）+ **回放校准脚本** | 最窄可上线版本，但队列/发送/预算语义完整——第一天起生产告警就有完整治理。无 codegraph |
| 2 | codegraph 集成（实测包名/安装/CLI 后写死版本）+ `codegraphEnabled` 开关 + analyzer 预筛 prompt（正式闸门启用 hint 条件） | 两项独立增强，验证后打开；codegraph 不可用永远可降级 grep-only |
| 3 | `depends_on` + `protocol_dependency` 策略 | 补全三类关系（含 manifest 置信度封顶规则） |
| 4 | 周报 counterpart-check 升级为消费 `impact_checks` | 新增 `code_verified` 证据等级 |

版本影响：schema migration + 新增配置节 + 新 env 无（凭据复用现有），按发布规范属 **MINOR** 升级；Dockerfile 变更使部署需要镜像重建（`deploy.sh` 已含 `--build`，无额外手工步骤）。

## 被否决的备选方案

- **方案 B（CRG 索引 + 符号映射作为判断者）**：fork 偏离处符号匹配最脆弱，覆盖不了依赖/协议两类关系，原 code-review-graph 运维成本高。codegraph 仅作为 agent 工具层被采纳。
- **方案 C（无 clone，GitHub API 按需取码）**：GitHub code search 对 fork 索引不全、不支持灵活 grep、rate limit 紧，取证能力弱，与高置信度告警定位冲突。

## Rev4 修订记录（GPT round-2 review 修复，2026-06-12）

1. **[P1] `--no-dispatch` 绕过修复**：经核实 `getRunStages()` 只移除 dispatch 阶段，阶段内直发会绕过。新增 `PipelineContext.dispatchEnabled`，Impact Checker 首发与 dispatch 兜底都必须尊重；抑制态（标志为 false 或无 webhook）不消耗 `alert_attempt_count`、卡片留表待补发。
2. **[P1] 投递语义显式化**：承认发送与 DB 写回之间的崩溃窗口不可事务化，显式选择 **at-least-once**（接受偶发重复、不接受静默漏发），卡片 footer 的 `check #id` 作为人工去重线索；明确否决 at-most-once 及其漏发风险。
3. **[P2] Phase 1 与数据流矛盾消除**：预筛列随 007 migration 在 Phase 1 建好但 analyzer 到 Phase 2 才填写；Phase 1 闸门是同一逻辑在 hint 全为 `'none'` 时的自然退化，非另一套代码；回放脚本 Phase 1 仅按 significance 分桶。
4. **[P2] `config_hash` 扩面**：从"关系条目 + architectureNotes"扩为覆盖所有影响 clone/prompt/裁决的配置（+ `repoUrl`、`branch`、`notes`、`tags`）；prompt 模板版本由 `prompt_version` 列独立追踪。

## Rev3 修订记录（GPT review P0/P1 修复，2026-06-12）

经代码核实全部属实后修复：

1. **[P0] 告警发送时机与阶段顺序矛盾**：dispatch 排在 report 之后，"不等日报"不成立。改为 Impact Checker 阶段内裁决写回后立即首发（`sendCard` 直发，同 runner health-alert 模式），dispatch 阶段只做重试兜底。
2. **[P0] schema 补全 retry/审计字段**：新增 `retry_count`、`last_error`、`alert_attempt_count`、`lark_message_id`、`prompt_version`、`config_hash`；轨迹文件路径由 id 推导无需列。告警重试加 `alert_attempt_count >= 5` 上限防无限重试。
3. **[P0] UNIQUE 约束 vs 多次 analysis**：`analyses` 无 pr_id 唯一约束、报告侧取 latest 已是既定模式。闸门改为 upsert：非终态行（pending/failed/skipped_budget/expired）跟随 latest `analysis_id` 与 `config_hash` 刷新并复活；`complete` 行不被静默改写，需重查走人工 requeue。
4. **[P0] 外部依赖假设钉死**：`ai@^6` 实际 API 是 `stopWhen: stepCountIs(N)` 而非 `maxSteps`（已核对 package.json），文档改用正确 API 名；codegraph 的包名/安装方式/CLI 子命令明确标注"未验证，Phase 2 开工实测后写死"，Dockerfile 中注释占位。
5. **[P1] Phase 重排**：Phase 1 收窄为 `fork_of` + grep/read + 完整队列治理 + 告警发送 + 预算 + 配置层 + 回放校准（去掉 codegraph 与多关系类型）；codegraph 降为 Phase 2 可开关增强；requeue/过期 CLI 提前进 Phase 1（队列治理不能滞后于生产告警）。
6. **[P1] 配置层改造明确化**：`projects.ts` 的 `relationship` 字面量类型扩展、`reloadMantleConfig()` 对齐现有 reload 模式、`settings.ts` 的 `impactCheck` 节进 `SafeConfigSnapshot` 热重载、缺节= 禁用保证老配置兼容。
7. **[P1] depends_on 置信度收紧**：manifest 锁定版本不构成"变更落入 Mantle 使用版本"的证明，`manifest_evidence` 封顶 medium；统一规则——high 当且仅当 `code_evidence`，程序侧强制执行。
8. **[P1] 上线校准**：新增 `scripts/impact-check-backtest.ts` 回放脚本（30 天 analyses × 当前关系，无 LLM），先出候选量分布再定配额与子预算，作为 Phase 1 交付物。

## Rev2 修订记录（健壮性 review，2026-06-12）

对照真实代码库核对后修正：

1. **[硬伤] 告警发送跟踪重设计**：原方案"复用 `report_deliveries` + `report_type = 'mantle_alert'`"与真实 DDL 不符（无 `report_type` 列、`report_id NOT NULL` 指向带 CHECK 约束的 `reports` 表）。改为 `impact_checks` 内 `alert_card_json` + `alert_dispatched_at` 自跟踪。
2. **[硬伤] budget-tracker 集成**：现有 `getBudgetStatus()` 只 SUM `analyses` 表，必须改为两表合算，否则深度检查花费对预算系统不可见。
3. **[硬伤] 部署依赖补全**：生产为 `oven/bun:1` 容器，新增 git/ripgrep（codegraph 待验证）进镜像；发现并顺带修复存量问题——Dockerfile 未 COPY `prompts/`，weekly/monthly prompt report 在容器内读不到 prompt 文件。
4. **闸门兜底**：significance ≥ notable 的 PR 即使预筛 hint=none 也入队，防预筛漏报。
5. **队列语义补全**：行创建时机、优先级排序、配额计算、`skipped_budget` requeue CLI、`maxAgeDays` 过期防告警风暴。
6. **工具硬化**：路径围栏（上游 PR 内容视为不可信输入）、argv 数组传参禁 shell 拼接、输出截断上限、子进程超时、`maxCostPerCheck` 单检查成本上限。
7. **幻觉防护**：裁决后程序侧校验 `code_evidence` 的文件存在性与 snippet 匹配，失败降级 confidence。
8. **diff 不可用降级**：`too_large`/`missing` 时仍检查但 confidence 上限 medium，不可能发 high 告警。
9. **clone 细节**：depth-1 single-branch、不用 blobless partial clone（lazy fetch 破坏取证确定性）、超时与磁盘护栏、`target_commit` 入库保证证据可追溯。
10. **可观测性**：StageResult 扩展、日报摘要行、`db status` CLI 计数。
