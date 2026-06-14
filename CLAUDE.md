# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Counterpart Monitor is an engineering intelligence agent that tracks open-source projects and produces opinionated directional analysis of their engineering activity. It reads merged PRs, performs diff-aware LLM analysis with intelligent truncation, and delivers layered reports (summary for strategy readers + technical details for engineers) to Lark.

## Tech Stack

- **Runtime**: Bun (TypeScript)
- **Orchestration**: pi-agent extensions (used for LLM tool registration and lifecycle hooks — NOT for pipeline orchestration; see architectural note below)
- **Database**: SQLite via `bun:sqlite`
- **GitHub API**: Octokit
- **LLM**: Vercel AI SDK (`ai` + `@ai-sdk/anthropic`) with Anthropic-compatible AI gateway (`baseURL` + `apiKey`), `generateObject()` + Zod for structured output, diff-aware analysis with intelligent truncation (`diff-truncator.ts`, `context.ts`)
- **Messaging**: Lark webhook (Message Card v2, ~30KB limit per card)
- **Scheduling**: croner

> code-review-graph deferred to post-MVP M3. See `docs/spark/2026-05-29-remove-crg-from-mvp-design.md`.

## Architecture

Four-stage sequential pipeline: **GitHub Collector → Analyzer → Report Generator → Lark Dispatcher**. Stages communicate via SQLite (status columns: `pending`/`complete`/`failed`), not direct function calls. This makes the pipeline resumable and debuggable.

### Critical architectural decision (from eng review)

pi-agent's extension system is designed for LLM tool registration and lifecycle hooks, not batch data pipeline orchestration. Use **plain TS modules with direct function calls** for the sequential pipeline (`src/pipeline/runner.ts`), and reserve pi-agent for the LLM analysis step only.

### Planned directory structure

```
src/
├── index.ts                    # Entry point, pi-agent setup
├── config/                     # Project registry + settings
├── extensions/                 # pi-agent extensions (LLM analysis only)
│   ├── github-collector/       # Octokit PR fetching + diff storage
│   ├── analyzer/               # Diff-aware LLM reviewer (diff-truncator, context, significance)
│   ├── report-generator/       # Daily/weekly report assembly
│   └── lark-dispatcher/        # Lark webhook delivery
├── pipeline/                   # Pipeline runner + stages
│   └── stages/
├── storage/                    # SQLite schema, migrations, db setup
├── scheduler/                  # croner-based scheduling
└── utils/                      # Shared utilities (retry, rate-limiter, budget-tracker)
data/                           # SQLite db + diffs + analysis-inputs (gitignored)
config/                         # JSON config files
```

## Key Technical Constraints

### bun:sqlite production pragmas
WAL mode alone is insufficient. Required pragma suite:
- `temp_store=MEMORY`
- `cache_size=-64000`
- `mmap_size=268435456`
On macOS: use `fileControl(SQLITE_FCNTL_PERSIST_WAL, 0)` + `wal_checkpoint(TRUNCATE)` for clean shutdown.

### Diff truncation
Collector stores raw diffs (>2MB → `diff_status = 'too_large'`, no file stored). Truncation happens at prompt construction time in `diff-truncator.ts` using a 5-tier priority system: Skip always (lock/generated/binary) > Tier 1 signal files (package.json, Dockerfile, proto, CI, migrations, K8s) > Tier 2 source > Tier 3 tests > Tier 4 docs/config. File manifest always appended (>100 files: aggregate by tier). Token budget default 8000.

### Lark message size
Cards have a ~30KB limit. If a daily report exceeds 20KB: include only `notable`/`directional_shift` PRs, add "N routine PRs omitted" line. If still over, split into one card per project.

### LLM budget
~$35-65/month for 10 repos at ~5 PRs/day (~$0.02-0.04/PR). Budget cap configurable in settings (default $80). M1 has a hard budget cap safety net. M2 adds: at 80% skip likely-routine PRs, at 100% pause analysis + Lark alert. Track `input_tokens`, `output_tokens`, `model_id`, `estimated_cost_usd` in analyses table.

## Data Model

SQLite tables: `projects` (tracked repos + GitHub metadata: description, language, topics), `pull_requests` (fetched PR metadata + diff path + diff_status), `analyses` (LLM output: summary, technical_detail, direction_signal, significance), `analysis_inputs` (persisted LLM inputs at analysis time for audit/replay), `reports` (generated reports), `report_deliveries` (per-card delivery tracking). Full schema in `docs/design.md`.

PR significance levels: `routine`, `notable`, `directional_shift`.

## Report Scope Contract

Reports must stay layered: a concise summary for strategy readers, with expandable or linked technical detail for engineers. Do not turn reports into raw changelogs. Each report type has a distinct job:

### Daily report

Daily reports are the factual PR-level digest for the previous local day. They answer "what changed yesterday, and which PRs matter?"

Include:
- Coverage/completeness: tracked project count, failed projects, and budget warning when relevant.
- Per-project activity counts: total PRs plus `directional_shift`, `notable`, and routine counts.
- The highest-signal project/PR summary for the visible overview.
- Significant PR details (`directional_shift` and `notable`) with PR links, summary, technical detail when available, direction signal, and significance badge.
- Routine PRs only as counts or digest data unless the card has enough room and the routine item is needed for context.
- A persisted `digest_json` containing all PRs, including routine PRs, so weekly/monthly aggregation can reuse daily facts without reparsing Lark card text.

Do not include:
- Cross-repo action recommendations such as "Mantle should..." or target-project advice. Those belong in weekly/monthly synthesis.
- Broad trend claims unless they are directly supported by that day's analyzed PRs.

### Weekly report

Weekly reports are the 7-day engineering intelligence synthesis. They answer "what direction changed this week, what pattern is emerging, and what should we check next?"

Include:
- Activity summary across the 7-day window: total PRs, project count, directional shifts, notable changes.
- Direction changes by project, combining related PR-level signals into a readable weekly narrative.
- Per-project highlights capped to the most important PRs, favoring `directional_shift` over `notable` over routine patterns.
- Cross-project or counterpart checks: risk signals, transferable optimizations, architecture directions, and target projects worth checking.
- Interpretation: why the week matters, not just what merged.
- Source links back to the underlying PRs for claims that need engineering verification.

Weekly reports should aggregate from daily `digest_json` when available and fall back to raw `analyses` only for missing or partial days. Weekly quality should be driven by a report-level prompt, not only by stitching together PR summaries. Keep weekly prompt text in a dedicated prompt file and make it easy to A/B test on the same stored inputs.

### Monthly report

Monthly reports are post-MVP/post-v1 scope until `buildMonthlyReport` and monthly cards are implemented. They should reuse the same report-prompt infrastructure as weekly reports once enough historical data exists.

Monthly reports answer "how did the tracked ecosystem move this month, and what does it imply strategically?"

Include:
- Executive narrative: the top 3-5 engineering themes across the month.
- Project trajectory: which projects accelerated, shifted architecture, changed API/infrastructure direction, or became quieter.
- Cross-project trends: repeated adoption of technologies, shared risk fixes, performance work, protocol/API shifts, dependency migrations.
- Strategic implications for Mantle or the configured target context, clearly separated from raw source-project facts.
- Evidence appendix or compact source map: representative PRs, weekly reports, and direction signals backing each theme.
- Open questions and recommended follow-up checks for the next month.

Do not use monthly reports as a larger weekly report. They should compress the month into durable themes, trajectory changes, and strategic implications.

### Prompt management

PR analysis prompts and report synthesis prompts have different responsibilities:
- PR analysis prompt: inspect one PR/diff and produce structured `analyses` rows.
- Daily report: mostly deterministic assembly from analyzed PR facts; keep report-level LLM use minimal.
- Weekly/monthly report prompts: synthesize across time windows, identify themes, rank importance, and produce structured report data for card rendering.

Keep report prompts in a dedicated prompt directory (for example `prompts/reports/weekly.md` and `prompts/reports/monthly.md`) and provide a reusable prompt-lab script that can run different prompt files against the same stored daily digests/analyses without dispatching to Lark or mutating production report rows.

## Development Status

Greenfield — currently in Week 0 (scaffold + pi-agent learning). The design is approved and reviewed. See `docs/design.md` for full architecture, `docs/eng-review-learnings.md` for review findings, and `TODOS.md` for backlog.

Multica project: **Counterpart-Codebase-Monitor** (WHI-107 ~ WHI-130, 24 issues, 3 MVP milestones + post-MVP M3). Issue details and blocking relationships in `docs/linear-design.md`.

### Issue management

All issue-related work for this repository is managed in **Multica**, not Linear. The active Multica project is **Counterpart-Codebase-Monitor**. When creating, reading, updating, commenting on, or checking issue status, use the `multica` CLI (`multica issue ...`) against this project and do not use Linear tools. Treat `docs/linear-design.md` as historical/reference documentation despite the filename; Multica is the source of truth for active issues.

## Git Workflow

Issues are developed in parallel via **git worktrees** — each active issue runs in its own worktree with an independent Claude Code session.

### Branch naming

`feat/WHI-{id}-{short-slug}` — one branch per Multica issue.

Examples: `feat/WHI-108-sqlite-schema`, `feat/WHI-111-pipeline-runner`

### Worktree lifecycle

1. **Start**: create worktree via Claude Code `EnterWorktree` (or `git worktree add .claude/worktrees/WHI-{id} -b feat/WHI-{id}-slug`)
2. **Setup**: copy or symlink `.env` from the main working directory into the worktree. `data/` is gitignored — each worktree has independent runtime data.
3. **Develop**: implement the issue, commit, verify
4. **PR**: squash merge via GitHub PR
5. **Cleanup**: remove worktree (`ExitWorktree action: "remove"` or `git worktree remove`)

### Parallel development rules

**Strict wait policy: all blockers must be merged to main before starting a dependent issue.** Never branch off an unmerged feature branch.

Before starting an issue, check its "Blocked By" in Multica (or the blocking table in `docs/linear-design.md`). Parallelizable issue groups:

```
WHI-107 merged → WHI-108, WHI-109, WHI-110 can run in parallel
108+109+110 merged → WHI-111
111 merged    → WHI-112 (also M2 leaf issues like WHI-127, WHI-125 can start once their single blocker merges)
112+111 merged → WHI-113
...
M2 has several independent leaf issues (WHI-124, WHI-125, WHI-126, WHI-127) parallelizable once their single blocker merges
```

### Merge strategy

- **Base**: always branch from latest `main` (`worktree.baseRef = fresh`)
- **Squash merge**: each issue squash-merges to main via GitHub PR — one commit per issue on main
- **PR title**: `WHI-{id}: {issue title}`
- **Post-merge**: other active worktrees should pull main and rebase

### Agent worktree rules

- **File scope**: only modify files listed in the issue's "related files" table — minimizes cross-worktree conflicts
- **Commit message**: `WHI-{id}: {what changed}`
- **Verify**: run `bun run dev` (or relevant checks) in the worktree before creating a PR
- **Cleanup**: remove the worktree after PR is merged

## Release Process

A release = one annotated git tag on `main` plus a deploy of that commit to the server. There is no CI/CD; releasing and deploying are manual steps run from `main`.

### Versioning scheme

Pre-1.0 semantic versioning, `vX.Y.Z`:

- **MAJOR (`X`)**: stays `0` until v1.0. Do not bump.
- **MINOR (`Y`)**: a meaningful feature batch, a new pipeline stage/report type, or a breaking change to config (`config/settings.json`, `config/projects.json`) or the SQLite schema (a new migration that changes existing behavior).
- **PATCH (`Z`)**: incremental features, bug fixes, prompt tweaks, ops/CLI improvements that don't change config or schema contracts.

When unsure between MINOR and PATCH, prefer MINOR if a deploy requires any manual step beyond `deploy.sh` (e.g. a new required env var or a config migration).

### Version numbers to change

Two places, kept in sync, both set to the **same** value:

1. **`package.json` → `version`** — bump to the new `X.Y.Z` (no `v` prefix) in a commit on `main`.
2. **git tag** — `vX.Y.Z` (with `v` prefix) pointing at that commit.

Do **not** touch:
- `version: "3.8"` in `docker-compose.yml` — that is the Compose file-format version, not the app version.
- `migrations` rows / migration filenames — those are schema versions, independent of the app release version.

> Historical note: tags `v0.1.1`–`v0.2.5` were cut without bumping `package.json` (it sat at `0.1.0`). Going forward `package.json.version` must always equal the latest release tag.

### Cutting a release

Run from a clean `main` that has the merged PRs you want to ship:

```bash
git checkout main && git pull origin main

# 1. Bump package.json version to the new X.Y.Z, then:
git add package.json
git commit -m "chore: release vX.Y.Z"
git push origin main

# 2. Tag the release commit and push the tag
git tag -a vX.Y.Z -m "vX.Y.Z: <one-line summary of what shipped>"
git push origin vX.Y.Z
```

Use an **annotated** tag (`-a`) with a one-line summary so `git for-each-ref` and release history stay readable.

### Deploying

Deploys are pull-based on the server — they ship whatever is on `origin/main`, so always cut the tag first.

On the deployment host, from the repo root:

```bash
./scripts/deploy.sh
```

`deploy.sh` runs `git pull origin main`, rebuilds via `docker compose up -d --build`, then polls the `counterpart-monitor` container health (`data/readiness.json`, must report `ready` and be fresh within 120s) for up to 180s. It exits non-zero and dumps the last 200 log lines if the container is unhealthy or the health check times out.

### Post-deploy verification

- Confirm the container is healthy: `docker compose ps` (or watch `deploy.sh` exit 0).
- Tail logs for the first scheduled run: `docker compose logs --tail=200 -f monitor`.
- If a deploy is bad, roll back by checking out the previous tag on the server and re-running `deploy.sh`:
  ```bash
  git checkout vX.Y.(Z-1) && ./scripts/deploy.sh   # then investigate on a branch
  ```
  Note this leaves the server on a detached HEAD; return it to `main` once a fix is tagged.
