# Counterpart Monitor

Counterpart Monitor is an engineering intelligence pipeline for tracking open-source projects. It collects recently merged GitHub pull requests, stores raw diffs, runs diff-aware LLM analysis, generates daily or weekly report cards, and dispatches them to Lark.

## What It Does

- Tracks repositories from `config/projects.json`.
- Fetches merged GitHub PR metadata and repository metadata.
- Stores raw patch files under `data/diffs/`.
- Persists pipeline state in SQLite at `data/monitor.db`.
- Analyzes PRs with an LLM using raw diff content when available.
- Falls back to metadata-only analysis when a diff is missing or too large.
- Records prompt inputs in `analysis_inputs` for audit and replay.
- Generates daily reports and weekly trend reports as Lark card JSON.
- Dispatches report cards to Lark and tracks per-card delivery state.
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

Create a local `.env` file from the template:

```bash
cp .env.template .env
```

Set these variables:

```bash
GITHUB_TOKEN=github_pat_or_classic_token
LLM_BASE_URL=https://your-gateway.example.com/v1
LLM_API_KEY=your_llm_api_key
LARK_WEBHOOK_URL=
```

`GITHUB_TOKEN`, `LLM_BASE_URL`, and `LLM_API_KEY` are required for collection and analysis. `LARK_WEBHOOK_URL` is required for a full E2E run with Lark delivery; if it is unset, the dispatch stage skips gracefully after report generation.

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

## Local E2E Run

The E2E runner is a manual validation tool that drives the full pipeline against real external services.

```bash
set -a
source .env
set +a

# Daily report (default) — collect → analyze → report → dispatch
bun run src/e2e-run.ts
bun run src/e2e-run.ts --mode daily

# Weekly report — collect → analyze → report(daily+weekly) → dispatch
bun run src/e2e-run.ts --mode weekly

# Same as weekly; also prints "[SKIPPED] monthly: not implemented"
bun run src/e2e-run.ts --mode all

# Monthly — exits 1 (not implemented yet)
bun run src/e2e-run.ts --mode monthly

# Skip Lark delivery — useful to inspect report JSON before sending
bun run src/e2e-run.ts --mode weekly --no-dispatch
bun run src/e2e-run.ts --mode all --no-dispatch
```

After the pipeline, the runner prints a structured summary: stage results, report IDs and delivery status, a sample of new analyses, cost estimate, and Lark message IDs.

When to use each mode:

- **daily**: validate today's collect/analyze/report/dispatch end-to-end
- **weekly**: validate weekly aggregation in addition to daily (use on Sundays or before a weekly release)
- **all**: comprehensive check — equivalent to weekly with a monthly-skipped note; exit 0 as long as daily+weekly pass
- **monthly**: reserved for after `buildMonthlyReport` is implemented
- **`--no-dispatch`**: generate and inspect reports in DB without sending to Lark

Expected runtime outputs:

- `data/monitor.db`
- `data/diffs/<org>-<repo>/<pr-number>.patch`
- `data/analysis-inputs/<analysis-id>.diff`
- `data/reports/daily-YYYY-MM-DD.json`
- `data/reports/weekly-YYYY-MM-DD.json` (weekly/all modes)
- `report_deliveries` rows updated to `sent` after successful Lark delivery

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
- `report_deliveries`: per-card Lark delivery content, status, message ID, and sent timestamp.

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

- Reads unsent or failed `report_deliveries` rows.
- Sends each card to the configured Lark webhook.
- Marks successful deliveries as `sent` with message ID and timestamp.
- Leaves failed deliveries retryable for the next run.
- Skips gracefully when `LARK_WEBHOOK_URL` is unset.

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

## Deployment

### Requirements

- Bun >= 1.x
- git
- pm2 (`npm install -g pm2`)

### Install

```bash
git clone https://github.com/your-org/counterpart-monitor
cd counterpart-monitor
bun install
cp .env.production.example .env
# Edit .env and fill in GITHUB_TOKEN, LLM_BASE_URL, LLM_API_KEY, LARK_WEBHOOK_URL
pm2 start ecosystem.config.js
```

### Update

```bash
git pull
bun install
pm2 restart counterpart-monitor
```

### Health

After each pipeline run, `data/health.json` is updated with the last run timestamp, success status, PR count, and errors. If 3 consecutive runs all fail, an alert is sent to the configured Lark webhook.

```bash
cat data/health.json
pm2 logs counterpart-monitor
```

## Current Milestone Status

M1 is implemented and M2 Lark delivery is wired into the local E2E path:

- Pipeline runner and scheduler.
- GitHub collector and diff storage.
- Diff-aware LLM analyzer.
- Daily report generator.
- Weekly report generator.
- Lark dispatcher with delivery tracking.
- Prompt baseline and audit export.
- Local end-to-end runner for `collect -> analyze -> report -> dispatch`.

Remaining launch essentials include budget alerting behavior and production hardening.
