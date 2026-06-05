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
