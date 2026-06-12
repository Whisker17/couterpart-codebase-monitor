# Design: Mantle Codebase 级影响检查（Impact Checker）

Date: 2026-06-12
Status: APPROVED (spark 讨论定稿)
Affects: pipeline 阶段结构、`analyses` schema、`config/mantle-config.json`、`config/settings.json`、weekly counterpart-check

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

阶段间仍通过 SQLite 状态列通信（保持可恢复、可调试），新增 `impact_checks` 表。

### 数据流（单次 pipeline 运行内）

1. **Analyzer 预筛**：PR 分析输出 schema 增加 `downstream_impact_hint`（`none | possible | likely`）和 `downstream_impact_reason`（一句话理由）。搭现有 LLM 调用便车，增量成本仅几十个输出 token。
2. **闸门判断**（纯代码，无 LLM）。同时满足才进入深度检查队列：
   - `downstream_impact_hint != 'none'`
   - 源 repo 在 mantle-config 中存在至少一条到 mantleTarget 的关系
   - 当日深度检查次数未超 `maxChecksPerDay`（默认 5）
   - 预算未触线（总池 + 子上限）
3. **Impact Checker 阶段**：
   - 先 clone 同步：`git fetch + reset` 更新 Mantle 目标 repo 的 shallow clone（`data/mantle-repos/`，gitignored），随后增量 `codegraph index`
   - 对队列中每个 (PR × 关系) 组合跑一次 agentic 取证检查，结果写入 `impact_checks`
4. **Dispatch 阶段**：本次运行新产生的 `affected = yes && confidence = high && evidence_kind != reasoning_based` 的检查结果，每条发一张**独立 Lark 告警卡片**；低于门槛的结果只入库不发卡。
5. **Weekly 升级**：`counterpart-check.ts` 证据等级新增 `code_verified`（最高级），周报 counterpart 环节优先引用 `impact_checks` 的真实代码证据。

### 设计边界

- **放在 Analyzer 之后**：闸门依赖预筛字段；深度检查需要 diff 已落盘。
- **失败不阻塞**：impact check 失败不影响 report/dispatch，日报照发；失败项留状态供下次运行重试或人工 redispatch。
- **"立即告警"的边界**：告警在 pipeline 运行内紧随检查完成发出，不等日报组装；但系统仍是每日 cron 批处理，"立即" = 检查完成后几秒，而非 PR 合并后几分钟。未来要更快可提高 collector+impact-check 的 cron 频率（如每 4 小时），架构不变。

## Impact Checker 组件设计

### 目录结构

```
src/extensions/impact-checker/
├── index.ts              # 阶段入口：闸门过滤 + 队列处理
├── clone-manager.ts      # Mantle repo shallow clone 同步 + codegraph 索引
├── codegraph-cli.ts      # codegraph CLI 子进程封装（search/callers/impact/node）
├── agent-tools.ts        # 注册给 LLM 的工具集定义
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
      "repoUrl": "https://github.com/mantle/reth",   // 新增：可 clone 的公开地址
      "tags": ["..."],
      "notes": "...",
      "architectureNotes": "Mantle reth fork 作为 L2 执行客户端。L2 derivation 依赖 L1 区块头结构与 blob 格式。改造点集中在 gas 计费 (MNT) 与 DA 层..."  // 新增：协议推理知识底座，人工维护
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
- 启动校验：`source` 必须是 projects.json 中被跟踪的 repo，否则打 warning（关系永远不会触发）。
- 兼容：历史值 `"manual"` 按 `protocol_dependency` 处理（仅推理，不取证）。
- 同一对 source→target 配置多条关系时，按强度取最高一条执行检查（`fork_of` > `depends_on` > `protocol_dependency`），与 `impact_checks` 的 `UNIQUE(pr_id, target_project_id)` 约束一致——每个 PR×target 只做一次检查，检查指令中可附带次要关系作为补充上下文。

### Agentic 取证循环（checker.ts）

用现有技术栈实现：Vercel AI SDK `generateText` + tools + `maxSteps`（上限 12 步），结束后 `generateObject` 产出结构化裁决。不引入新框架，符合"pi-agent 仅用于 LLM 工具注册"的架构决策。

**注册工具**（全部限定在对应 target repo 的 clone 目录内，只读）：

| 工具 | 实现 | 用途 |
|------|------|------|
| `codegraph_search` | CLI 子进程 | 符号/全文搜索，定位上游变更代码在 fork 中的对应物 |
| `codegraph_callers` | CLI 子进程 | 查 Mantle 内谁调用受影响代码 → 宕机风险面 |
| `codegraph_impact` | CLI 子进程 | 受影响符号的传递影响范围 |
| `grep_repo` | `rg` 子进程 | codegraph 未命中时的回退（改名/偏离场景） |
| `read_file` | Bun.file，带行号范围 | 读真实代码做最终比对 |
| `read_manifest` | 读 go.mod/Cargo.toml/lock | 依赖关系的版本取证 |

**上下文注入**：上游 PR 标题/body/截断 diff（复用 `diff-truncator`）、analyzer 的 summary 与 technical_detail、关系类型对应检查指令、target 的 `architectureNotes`。

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
// tokensUsed / cost 由程序填入，非 LLM 输出
```

**发卡门槛**：`affected = yes && confidence = high && evidenceKind != reasoning_based`。`uncertain` 与 medium 结果入库、进周报候选，不单独打扰人。

## 数据模型

### `analyses` 表新增两列（migration）

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
  relationship TEXT NOT NULL,             -- fork_of | depends_on | protocol_dependency
  status TEXT NOT NULL DEFAULT 'pending', -- pending | complete | failed | skipped_budget
  affected TEXT,                          -- yes | no | uncertain
  impact_type TEXT,
  evidence_kind TEXT,
  evidence TEXT,                          -- JSON array
  confidence TEXT,
  summary TEXT,
  recommended_action TEXT,
  input_tokens INTEGER, output_tokens INTEGER,
  model_id TEXT, estimated_cost_usd REAL,
  tool_steps INTEGER,                     -- agentic 循环实际步数，用于成本调优
  alert_dispatched_at INTEGER,            -- 发卡时间，NULL = 未发卡
  created_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(pr_id, target_project_id)        -- 每个 PR×target 只检查一次
);
```

**审计轨迹**：完整 agent 轨迹（每步工具调用与结果）写入 `data/impact-checks/{id}.jsonl`，沿用 `analysis_inputs` 思路：DB 存元数据 + 文件存大体积内容，30 天保留。

## 告警卡片（mantle-alert-card）

独立 Lark 卡片模板，红色 header：

```
🚨 Mantle 影响告警: [impact_type 中文标签]
上游: ethereum-optimism/op-geth#1234 — PR 标题（链接）
影响: mantle/reth (fork)
─────
[summary]
证据:
  • path/to/file.go:120-135 — [note]
    [snippet，截断到 ~10 行]
建议动作: [recommendedAction]
─────
confidence: high · evidence: code_evidence · 来源: 日报 2026-06-12 流水线
```

- 复用 `report_deliveries` 跟踪发送状态（新增 `report_type = 'mantle_alert'`），失败用现有 redispatch CLI 重发。
- 单卡单告警，体积远低于 30KB 限制，无需拆分逻辑。

## 预算与 settings 变更

```jsonc
{
  "budget": { "monthlyCap": 150 },          // 80 → 150
  "impactCheck": {                          // 新增配置节
    "enabled": true,
    "maxChecksPerDay": 5,
    "maxStepsPerCheck": 12,
    "monthlySubCap": 50,                    // 深度检查独立软上限（美元）
    "clonesDir": "data/mantle-repos"
  }
}
```

预算策略：共享 `monthlyCap` 总池，impact check 另有 `monthlySubCap`——**触线先停深度检查，保 PR 分析基础盘**。被停的检查标 `skipped_budget`，日报加一行 "⚠ N 个影响检查因预算暂停"。

成本估算：预筛后每天 1-3 次深度检查 × $0.1-0.5/次 ≈ 月增量 $5-45，叠加现有 $35-65，总量在 $150 上限内。

## 错误处理

| 故障 | 行为 |
|------|------|
| clone fetch 失败 | 该 target 的检查全部标 `failed`（旧索引不可靠）；日报加降级提示，下次运行重试 |
| codegraph index 失败 | 降级运行：agent 只用 grep/read 工具，prompt 注明索引不可用 |
| agent 超 maxSteps 无结论 | 强制进入 generateObject 裁决，通常 affected = uncertain，不发卡，入库 |
| LLM 调用失败 | 复用 `llm-retry.ts`，重试耗尽标 `failed`，下次 pipeline 重新捞起 |
| codegraph CLI 缺失 | 启动检测，缺失则 impact-check 阶段整体禁用 + 日志告警，不影响其他阶段 |

## 测试策略

- **单元**：闸门逻辑（hint × 关系 × 配额 × 预算组合）、strategies prompt 组装、codegraph CLI 封装（mock 子进程）、裁决 schema 校验。
- **集成**：fixture 放一对迷你 repo（fake-upstream + fake-fork，fork 含一个已知共同 bug 和一处偏离），mock LLM 走完整 agentic 循环，验证工具调用与取证路径；clone-manager 用本地 bare repo 测 fetch/reset。
- **e2e**：`e2e-run.ts` 增加 `--with-impact-check`，真实 LLM 跑一个历史已知案例（如上游某真实 bug fix），人工核对证据质量。

## 分期落地

| Phase | 内容 | 说明 |
|-------|------|------|
| 1 | clone-manager + codegraph 集成 + `fork_of` 策略 + 告警卡片 | 端到端打通，价值最高的关系类型。闸门临时用 "notable 以上 + 有关系映射" 代替预筛字段 |
| 2 | `depends_on` + `protocol_dependency` 策略 + analyzer 预筛字段 | 补全三类关系与正式闸门 |
| 3 | 周报 counterpart-check 升级为消费 `impact_checks` | 新增 `code_verified` 证据等级 |

## 被否决的备选方案

- **方案 B（CRG 索引 + 符号映射作为判断者）**：fork 偏离处符号匹配最脆弱，覆盖不了依赖/协议两类关系，原 code-review-graph 运维成本高。codegraph 仅作为 agent 工具层被采纳。
- **方案 C（无 clone，GitHub API 按需取码）**：GitHub code search 对 fork 索引不全、不支持灵活 grep、rate limit 紧，取证能力弱，与高置信度告警定位冲突。
