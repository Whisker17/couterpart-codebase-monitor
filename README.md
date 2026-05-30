# Counterpart Monitor

Counterpart Monitor is an engineering intelligence pipeline for tracking open-source projects. It collects recently merged GitHub pull requests, stores raw diffs, runs diff-aware LLM analysis, and generates daily or weekly report cards for local review.

The current M1 scope is local-first: collect PR data, analyze it, and write report JSON files. Lark delivery and production operations are planned for the next milestone.

## What It Does

- Tracks repositories from `config/projects.json`.
- Fetches merged GitHub PR metadata and repository metadata.
- Stores raw patch files under `data/diffs/`.
- Persists pipeline state in SQLite at `data/monitor.db`.
- Analyzes PRs with an LLM using raw diff content when available.
- Falls back to metadata-only analysis when a diff is missing or too large.
- Records prompt inputs in `analysis_inputs` for audit and replay.
- Generates daily reports and weekly trend reports as Lark card JSON.
- Exports analysis audit data as JSONL.

## Requirements

- Bun
- A GitHub personal access token
- An LLM gateway compatible with the configured Anthropic model

Install dependencies:

```bash
bun install
```

## Configuration

Create a local `.env` file from the example:

```bash
cp .env.example .env
```

Set these variables:

```bash
GITHUB_TOKEN=github_pat_or_classic_token
LLM_BASE_URL=https://your-gateway.example.com/v1
LLM_API_KEY=your_llm_api_key
LARK_WEBHOOK_URL=
```

`GITHUB_TOKEN`, `LLM_BASE_URL`, and `LLM_API_KEY` are required for the M1 pipeline. `LARK_WEBHOOK_URL` is optional for now because M1 does not send reports to Lark.

The default settings live in `config/settings.json`:

- `llm.model`: model name used for analysis.
- `llm.diffTokenBudget`: approximate diff budget for prompt construction.
- `llm.maxManifestEntries`: maximum detailed file manifest entries before aggregation.
- `schedule.dailyCron`: daily pipeline schedule.
- `schedule.weeklyCron`: weekly pipeline schedule.
- `budget.monthlyCap`: hard monthly analysis cost cap.

Tracked projects live in `config/projects.json`. Each project needs:

```json
{
  "org": "vercel",
  "repo": "next.js",
  "url": "https://github.com/vercel/next.js",
  "tags": ["frontend", "framework", "react"]
}
```

## Local M1 Run

Run the local end-to-end pipeline once:

```bash
set -a
source .env
set +a

bun run src/e2e-run.ts
```

This runs:

```text
collect -> analyze -> report
```

It intentionally does not run the Lark dispatcher. The run writes local runtime data under `data/`.

Expected outputs:

- `data/monitor.db`
- `data/diffs/<org>-<repo>/<pr-number>.patch`
- `data/analysis-inputs/<analysis-id>.diff`
- `data/reports/daily-YYYY-MM-DD.json`
- optional weekly report JSON when the weekly path is triggered

## Scheduled Run

Start the app entrypoint:

```bash
bun run dev
```

This validates required environment variables, initializes SQLite, registers the pi-agent hello-world tool, and starts the scheduler. Daily and weekly schedules are configured in `config/settings.json`.

## Audit Export

Export analysis records and their prompt inputs as JSONL:

```bash
bun run src/utils/audit-export.ts \
  --since 2026-06-10 \
  --until 2026-06-17 \
  --output data/audit/export.jsonl
```

The export includes analysis output, prompt input metadata, file manifests, truncated diff paths, and PR metadata.

## Data Model

The SQLite database is created automatically at `data/monitor.db`. Main tables:

- `projects`: tracked repositories and GitHub metadata.
- `pull_requests`: PR metadata, diff location, diff status, and analysis status.
- `analyses`: LLM summaries, technical details, categories, significance, token usage, and estimated cost.
- `analysis_inputs`: prompt version, input quality, rendered project context, file manifest, and diff snapshot path.
- `reports`: generated daily, weekly, or monthly report content.
- `report_deliveries`: reserved for Lark delivery tracking.

The database uses WAL mode and production-oriented SQLite pragmas from `src/storage/db.ts`.

## Pipeline Stages

### Collect

`src/pipeline/stages/collect.ts`

- Loads tracked projects.
- Fetches repository metadata.
- Fetches merged PRs using `updated_at` pagination.
- Inserts PR records idempotently.
- Fetches per-PR size metadata.
- Stores patch files unless the diff is larger than 2 MB.
- Advances `projects.last_synced_at` to the maximum `merged_at` from the fetched batch.
- Isolates failures per project.

### Analyze

`src/pipeline/stages/analyze.ts`

- Selects pending PRs and retryable failed PRs.
- Builds project context from GitHub metadata and local project tags.
- Uses raw diffs when available.
- Uses metadata-only analysis for missing, failed, or too-large diffs.
- Truncates diffs by file priority before prompting.
- Calls the LLM for structured output.
- Writes `analyses` and `analysis_inputs`.
- Records token usage and estimated cost.
- Applies a hard monthly budget cap.

### Report

`src/pipeline/stages/report.ts`

- Builds daily report cards from current analyses.
- Marks reports partial when upstream project failures occurred.
- Upserts reports by period to avoid duplicates.
- Writes local report JSON files.
- Generates weekly reports when the pipeline context is marked as a weekly run.

### Dispatch

`src/pipeline/stages/dispatch.ts`

Lark delivery is not part of M1. The stage exists for the M2 dispatcher work.

## Development

Run tests:

```bash
bun test
```

Type-check:

```bash
bunx tsc --noEmit
```

The repository keeps runtime outputs out of git. Do not commit `.env`, database files, diff files, analysis snapshots, or generated reports.

## Current Milestone Status

M1 is implemented for local validation:

- Pipeline runner and scheduler.
- GitHub collector and diff storage.
- Diff-aware LLM analyzer.
- Daily report generator.
- Weekly report generator.
- Prompt baseline and audit export.
- Local end-to-end runner for `collect -> analyze -> report`.

M2 should add the launch essentials: Lark delivery, stronger retry/error handling, operational health checks, budget alerting behavior, and production deployment configuration.
