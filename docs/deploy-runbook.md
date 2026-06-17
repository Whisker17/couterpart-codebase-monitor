# 部署 Runbook — Counterpart Monitor

面向运维：在一台 Linux 服务器（VPS）上从零部署、配置、验证、升级、回滚 Counterpart Monitor 服务。

> 本文是**部署手册**。服务跑起来之后的日常排查（查 PR、查分析、查投递、重发报告、回填数据）见 [`docs/ops-runbook.md`](./ops-runbook.md)。

---

## 0. 这个服务是什么

一个常驻进程，按 cron 定时跑四阶段流水线：**采集 GitHub PR → LLM 分析 diff → 生成日报/周报/月报 → 投递到 Lark**。

关键事实，部署前先了解：

- **运行方式**：Docker Compose 单容器常驻（容器名 `counterpart-monitor`，compose service 名 `monitor`），`restart: unless-stopped` 自动拉起。
- **不需要数据库服务**：状态存在容器内 `data/monitor.db`（SQLite 文件），通过卷挂载到宿主机 `./data`。
- **没有 CI/CD**：发布和部署都是手动的，部署即"把 `origin/main` 拉到服务器并重建容器"。
- **出站网络依赖**：服务器必须能访问 **GitHub API**、**LLM 网关（你自己的 AI gateway）**、**Lark webhook**。没有入站端口，不对外提供 HTTP 服务。
- **时区**：默认 `Asia/Shanghai`（在 `docker-compose.yml` 里设了 `TZ`，且 `config/settings.json` 的 `schedule.timezone` 也是 `Asia/Shanghai`）。所有 cron 时间按这个时区解释。

---

## 1. 前置条件

### 1.1 服务器

- Linux x86_64，建议 2 vCPU / 2GB 内存以上，磁盘 ≥ 10GB（diff 和报告会持续累积在 `data/`）。
- 已安装：
  - **Docker Engine**（含 `docker compose` v2 插件，注意是 `docker compose` 不是老的 `docker-compose`）
  - **git**
- 能正常出站访问：
  - `https://api.github.com`
  - 你的 LLM 网关地址（`LLM_BASE_URL`，Anthropic 兼容网关）
  - `https://open.larksuite.com`（或你企业对应的 Lark/飞书 webhook 域名）

快速自检：

```bash
docker --version
docker compose version
git --version
curl -sS -o /dev/null -w '%{http_code}\n' https://api.github.com
```

### 1.2 需要提前准备好的凭证

| 凭证 | 用途 | 怎么拿 |
|------|------|--------|
| GitHub Token | 采集 PR / 仓库元数据 | GitHub → Settings → Developer settings → **Fine-grained PAT**，权限只需 **Metadata: Read-only** + **Pull requests: Read-only**（公开仓库给只读权限即可）。也兼容 classic token。 |
| LLM 网关地址 + Key | 分析 diff | 你们的 Anthropic 兼容 AI gateway 的 `baseURL` 和 `apiKey`。 |
| Lark Webhook URL | 投递报告 | Lark/飞书群机器人的自定义 webhook 地址。**可选**：不填则流水线照常跑，只是不发卡片（dispatch 阶段优雅跳过）。 |

---

## 2. 获取代码

```bash
# 选一个持久目录，例如 /opt
cd /opt
git clone https://github.com/your-org/counterpart-monitor.git
cd counterpart-monitor
git checkout main
git pull origin main
```

后续所有命令都在这个仓库根目录执行。

> 建议直接部署在 `main` 的最新 tag 上。查看可用版本：`git tag | sort -V | tail`。要部署某个具体版本：`git checkout vX.Y.Z`（注意这会进入 detached HEAD，升级时再切回 `main`）。

---

## 3. 配置（最关键的一步）

配置分两类：**密钥放 `.env`**，**业务参数放 `config/*.json`**。`docker-compose.yml` 把宿主机的 `./data` 和 `./config` 挂载进容器，所以你在宿主机改 `config/` 下的文件就是改运行时配置。

### 3.1 `.env` —— 密钥（必填项在这里）

从模板创建：

```bash
cp .env.production.example .env
```

编辑 `.env`，填入真实值：

```bash
# ---- 必填（缺任意一个，容器启动时会校验失败并退出）----
GITHUB_TOKEN=github_pat_xxx
LLM_BASE_URL=https://your-gateway.example.com/v1
LLM_API_KEY=sk-xxx

# ---- 可选 ----
# 不填则不投递 Lark，流水线其余阶段正常运行
LARK_WEBHOOK_URL=https://open.larksuite.com/open-apis/bot/v2/hook/xxxxxxxx
```

**必填校验**：进程启动时会检查 `GITHUB_TOKEN`、`LLM_BASE_URL`、`LLM_API_KEY` 三个变量，任何一个缺失会打印 `Missing required environment variables` 并以非 0 退出（容器会因此变 unhealthy）。

> ⚠️ **重要 —— 不要在 `.env` 里改排程或预算。**
> 模板里残留的注释行（`# DAILY_CRON=...`、`# SCHEDULE_DAILY_CRON=...`、`# BUDGET_MONTHLY_CAP=...`）**当前代码并不读取**，写了也不会生效。排程和预算只认 `config/settings.json`（见 3.2）。这些注释项是历史遗留，按未实现处理。

> 安全：`.env` 已在 `.gitignore` 中，**绝不要提交**。文件权限建议 `chmod 600 .env`。

### 3.2 `config/settings.json` —— 业务参数

这是排程、模型、预算的唯一真实来源。默认内容：

```json
{
  "llm": {
    "model": "claude-opus-4-6",          // 分析用的模型名（需你的网关支持）
    "baseUrlEnvVar": "LLM_BASE_URL",      // 指向哪个 env 变量取 baseURL（一般不动）
    "apiKeyEnvVar": "LLM_API_KEY",        // 指向哪个 env 变量取 key（一般不动）
    "maxTokensPerCall": 4096,             // 单次 LLM 调用最大输出 token
    "diffTokenBudget": 8000,              // diff 进 prompt 的 token 预算，超了按优先级截断
    "maxManifestEntries": 100             // 文件清单详列上限，超过按 tier 聚合
  },
  "lark": { "webhookUrlEnvVar": "LARK_WEBHOOK_URL" },
  "github": { "tokenEnvVar": "GITHUB_TOKEN" },
  "schedule": {
    "dailyCron": "0 9 * * *",             // 每天 09:00 跑日报（采集+分析+报告+投递）
    "weeklyCron": "30 9 * * 1",           // 每周一 09:30 跑周报
    "monthlyCron": "0 10 1 * *",          // 每月 1 号 10:00 跑月报（只 report+dispatch，不重新采集）
    "timezone": "Asia/Shanghai"           // 必须是合法 IANA 时区，cron 按此解释
  },
  "budget": {
    "monthlyCap": 80,                     // 月度 LLM 成本硬上限（美元）
    "warningThreshold": 0.8,              // 用到 80% 时告警
    "cutoffThreshold": 1.0                // 用到 100% 暂停分析
  }
}
```

部署默认值通常**无需改动**。常见需要调整的场景：

- 换分析模型 → 改 `llm.model`（确认你的网关支持该模型名）。
- 改跑报时间 → 改 `schedule.*Cron`。`timezone` 改了要确保是合法 IANA 标识（非法值会导致 scheduler 启动报错）。
- 调整成本上限 → 改 `budget.monthlyCap`。

> `settings.json` 里的 `budget.*`、`llm.diffTokenBudget`、`llm.maxManifestEntries` 这几个"安全字段"支持运行时热加载（下次流水线触发时重读）。但 **`schedule.*` 和 `llm.model` 的变更需要重启容器才生效**（见第 7 节）。

### 3.3 `config/projects.json` —— 追踪哪些仓库

JSON 数组，每个对象 `url` 必填，`tags` / `notes` 可选：

```json
[
  {
    "url": "https://github.com/base/base",
    "tags": ["blockchain", "l2", "op-stack"],
    "notes": "高信号区域说明，会进入 LLM 的项目上下文"
  }
]
```

- 文件在**每次流水线运行开始时**重新读取并同步进 SQLite——**增删项目不需要重启**，下次跑就生效。
- 从文件移除的项目会在 SQLite 里标记为 `inactive`，历史 PR 和分析保留。
- 文件缺失或 JSON 非法时，流水线回退到上次成功的快照并记录错误。

### 3.4 `config/mantle-config.json` —— 对标关系（可选）

定义目标项目（如 `mantle/reth`）与被追踪上游仓库的对标关系，用于跨项目分析。默认已配置，无特殊需求不用改。

### 3.5 时区

容器时区在 `docker-compose.yml` 里设为 `TZ=Asia/Shanghai`。**它必须和 `config/settings.json` 的 `schedule.timezone` 一致**，否则日志时间和 cron 触发时间会对不上。要改时区，两处一起改。

---

## 4. 首次部署

确认 `.env` 和 `config/` 都配好后：

```bash
cd /opt/counterpart-monitor

# 构建镜像并后台启动
docker compose up -d --build
```

首次构建会拉取 `oven/bun:1` 基础镜像并 `bun install`，需要几分钟。

> 也可以用项目自带的 `scripts/deploy.sh`（它会先 `git pull origin main` 再 `docker compose up -d --build`，然后轮询健康状态最多 180s）。**首次部署**手动跑上面的命令更直观；**后续升级**推荐用 `deploy.sh`（见第 6 节）。

---

## 5. 验证部署

### 5.1 容器状态

```bash
docker compose ps
```

期望看到 `counterpart-monitor` 状态为 `Up` 且 health 为 `healthy`。

健康检查逻辑：容器每 30s 检查 `data/readiness.json` 是否存在、`status` 是否为 `ready`、且更新时间在 120s 以内。心跳由进程在就绪后持续写入。

### 5.2 启动日志

```bash
docker compose logs -f --tail=80 monitor
```

健康启动应能看到类似：

- `pi-agent initialized. Registered tools: [ "hello-world" ]`
- `hello-world result: ...`
- `Session ready.`
- `[Scheduler] Registered daily (...), weekly (...), and monthly (...) jobs, timezone=Asia/Shanghai`

如果看到 `Missing required environment variables` → 回到 3.1 检查 `.env`。
如果看到 `Invalid IANA timezone` → 检查 `config/settings.json` 的 `schedule.timezone`。

### 5.3 就绪文件

```bash
docker compose exec monitor cat data/readiness.json
```

`status` 应为 `ready`，`updatedAt` 是新鲜的时间戳。

### 5.4 端到端冒烟测试（强烈建议）

不要干等到第二天 9 点才知道配置对不对。手动触发一次日报，**先不发 Lark**：

```bash
# 仅生成报告写入 DB / 文件，不投递 Lark
docker compose exec monitor bun run src/e2e-run.ts --mode daily --no-dispatch
```

观察日志里 collect / analyze / report 各阶段是否报错。然后确认产物：

```bash
docker compose exec monitor ls -la data/reports/
docker compose exec monitor cat data/health.json   # 最近一次运行的成功/失败、PR 数、错误
```

确认无误后，再跑一次带投递的（会真的往 Lark 群发一张卡片）：

```bash
docker compose exec monitor bun run src/e2e-run.ts --mode daily
```

去 Lark 群确认收到卡片即部署成功。

> 注意：已存在的 PR 不会重复分析（按 PR 去重），所以重复跑 e2e 不会重复烧 LLM 预算，只有真正缺分析的 PR 才会调用 LLM。

---

## 6. 升级 / 重新部署

服务器上的部署是 pull-based，部署的永远是 `origin/main`。**所以先确保要发布的 PR 已合入 main 并打好 tag**（发布流程见 `CLAUDE.md` 的 Release Process）。

标准升级：

```bash
cd /opt/counterpart-monitor
./scripts/deploy.sh
```

`deploy.sh` 会：`git pull origin main` → `docker compose up -d --build` → 轮询容器健康，最多 180s。容器健康则退出 0；不健康或超时则退出非 0 并打印最后 200 行日志。

依赖（`package.json` / `bun.lock`）有变更时，`--build` 会自动重装。如需彻底重建（极少数情况）：

```bash
docker compose down
docker compose up -d --build
```

磁盘紧张、要清理旧镜像时：

```bash
docker compose down
docker system prune -a -f    # 谨慎：会删除所有未使用的镜像
docker compose up -d --build
```

---

## 7. 改完配置后如何生效

| 改动 | 生效方式 |
|------|----------|
| `config/projects.json`（增删追踪仓库） | **无需重启**，下次流水线运行自动重读 |
| `config/settings.json` 的 `budget.*` / `diffTokenBudget` / `maxManifestEntries` | 运行时热加载，下次流水线触发生效 |
| `config/settings.json` 的 `schedule.*` / `llm.model` | **需要重启容器**：`docker compose restart monitor` |
| `.env`（任何密钥变更） | **需要重启容器**：`docker compose up -d`（compose 会因 env 变化重建）或 `docker compose down && docker compose up -d` |
| 时区（`docker-compose.yml` 的 `TZ` + `settings.json` 的 timezone） | 改完 `docker compose up -d` |

---

## 8. 回滚

部署坏了，回退到上一个 tag：

```bash
cd /opt/counterpart-monitor
git fetch --tags
git checkout vX.Y.(Z-1)     # 上一个已知正常的版本
./scripts/deploy.sh         # 注意：deploy.sh 会 git pull，见下方提醒
```

> ⚠️ `deploy.sh` 开头会 `git pull origin main`，在 detached HEAD 上可能失败或拉回 main。回滚时更稳妥的做法是手动重建：
> ```bash
> git checkout vX.Y.(Z-1)
> docker compose up -d --build
> ```
> 修复并打好新 tag 后，记得把服务器切回 `main`：`git checkout main && git pull origin main`。

数据（`data/`）不受版本回滚影响——SQLite 库和报告文件都在宿主机卷里。

---

## 9. 数据与备份

- 所有运行时数据在宿主机的 `./data`（容器内 `/app/data`），通过卷挂载持久化，重建容器不丢：
  - `data/monitor.db`（+ WAL/SHM 文件）— 全部状态
  - `data/diffs/` — 原始 patch
  - `data/reports/` — 生成的报告 JSON
  - `data/analysis-inputs/` — LLM 输入快照（审计/回放）
  - `data/health.json` / `data/readiness.json` — 运行/就绪状态
- **备份**：定期备份整个 `data/` 目录即可。备份 SQLite 前最好先停容器以保证一致性：
  ```bash
  docker compose stop monitor
  tar czf /backup/counterpart-data-$(date +%F).tar.gz data/
  docker compose start monitor
  ```
- `data/` 已 gitignore，不会进版本库。

---

## 10. 启动失败速查

| 现象 | 原因 | 处理 |
|------|------|------|
| 容器一直 unhealthy / 反复重启 | 必填 env 缺失 | `docker compose logs monitor` 看是否 `Missing required environment variables`，补 `.env` 后 `docker compose up -d` |
| 日志 `Invalid IANA timezone` | `settings.json` 时区非法 | 改成合法 IANA 标识（如 `Asia/Shanghai`、`UTC`）后重启 |
| 健康检查超时 | 进程没写出 `readiness.json` | 看启动日志有没有未捕获异常；确认 `./data` 卷可写 |
| 构建失败 | 网络拉不到 `oven/bun:1` 或依赖 | 检查服务器到 Docker Hub / npm 的网络 |
| 报告没发到 Lark | `LARK_WEBHOOK_URL` 未配或 webhook 失效 | 配置后重启；dispatch 排查见 `ops-runbook.md` |
| 分析报 `budget_skipped` | 月度 LLM 预算用满 | 见 `ops-runbook.md` 成本统计，必要时调 `settings.json` 的 `budget.monthlyCap` |

更深入的运行期排查（按时间窗口查 PR、分析结论、投递状态、成本、手动回填/重发）一律转到 [`docs/ops-runbook.md`](./ops-runbook.md)。

---

## 附：一页纸首次部署清单

```bash
# 1. 装好 docker / git，确认出站网络
# 2. 拉代码
cd /opt && git clone https://github.com/your-org/counterpart-monitor.git
cd counterpart-monitor && git checkout main

# 3. 配密钥
cp .env.production.example .env && chmod 600 .env
#    编辑 .env：填 GITHUB_TOKEN / LLM_BASE_URL / LLM_API_KEY（必填）+ LARK_WEBHOOK_URL（可选）

# 4. 核对 config/settings.json（排程/模型/预算）和 config/projects.json（追踪的仓库）

# 5. 构建启动
docker compose up -d --build

# 6. 验证
docker compose ps                                   # healthy
docker compose logs --tail=80 monitor               # 看到 Scheduler Registered
docker compose exec monitor cat data/readiness.json # status: ready
docker compose exec monitor bun run src/e2e-run.ts --mode daily --no-dispatch  # 冒烟
docker compose exec monitor bun run src/e2e-run.ts --mode daily                # 真发一张 Lark 卡
```
