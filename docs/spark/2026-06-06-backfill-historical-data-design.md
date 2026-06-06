# Backfill Historical Data

## Context

Weekly reports aggregate from daily digests stored in the `reports` table. The weekly cron runs every Monday at 9:30 AM CST and covers the previous Mon–Sun. For this to produce a complete report, each day in the window needs a daily report with `digest_json`.

Currently, daily reports only exist for sporadic days (e.g. Jun 1, Jun 3). Missing days fall back to querying the `analyses` table directly, which works but bypasses the digest aggregation path. Additionally, 112 PRs have `analysis_status = 'failed'`, leaving gaps in coverage.

A backfill tool is needed to retroactively run the full pipeline for a date range — collecting any missing PRs, re-analyzing failed ones, and generating daily reports — so that the weekly report has complete data to aggregate from.

## Usage

```bash
bun run scripts/backfill.ts --since 2026-06-01 --until 2026-06-05
```

- `--since`: start date (inclusive), format `YYYY-MM-DD`
- `--until`: end date (inclusive), format `YYYY-MM-DD`
- Dates interpreted in the timezone from `config/settings.json` (`schedule.timezone`)
- No Lark dispatch — reports are generated and stored in DB but not sent

## Execution Flow

Three sequential phases. Each phase completes fully before the next starts.

### Phase 1: Collect

Run once for the entire date range.

- Call `collect.execute()` with `sinceOverride = since date` and `skipSyncUpdate = true`
- This fetches merged PRs from GitHub for each tracked project starting from the since date
- `INSERT OR IGNORE` on `pull_requests` ensures idempotency — already-collected PRs are skipped
- `last_synced_at` is not updated, so the next scheduled pipeline run is unaffected

### Phase 2: Analyze

Run once for the entire date range.

1. Reset eligible PRs in the date range:
   ```sql
   UPDATE pull_requests
   SET analysis_status = 'pending', retry_count = 0
   WHERE merged_at >= :startUnix AND merged_at <= :endUnix
     AND analysis_status IN ('failed', 'budget_skipped')
   ```
2. Call `analyze.execute()` with `dateRange = { startUnix, endUnix }`
3. The analyze stage queries only PRs with `merged_at` in the range that are `pending` or `failed`
4. Budget controls still apply — if the budget is exhausted, remaining PRs are skipped with a warning
5. PRs that already have a completed analysis are auto-detected and skipped (existing behavior)

### Phase 3: Report

Run per-day, iterating from `since` to `until`.

For each day:
1. Compute `fakeNow` as noon UTC of `day + 1` (e.g. for Jun 1, use `new Date('2026-06-02T12:00:00Z')`). Noon UTC is safely within "day + 1" for any timezone up to UTC+12, so `getLocalDateParts(timezone, fakeNow)` will return `day + 1` and `getYesterdayPeriod` will correctly resolve to the target day.
2. Call `buildDailyReport(timezone, fakeNow)` to build the report data and digest
3. Upsert into the `reports` table:
   ```sql
   INSERT INTO reports (type, period_start, period_end, project_ids, content, completeness, digest_json)
   VALUES ('daily', ?, ?, ?, ?, ?, ?)
   ON CONFLICT(type, period_start, period_end)
   DO UPDATE SET content = excluded.content,
                 completeness = excluded.completeness,
                 project_ids = excluded.project_ids,
                 digest_json = excluded.digest_json
   ```
4. Do NOT create `report_deliveries` rows (no Lark dispatch)
5. Write report JSON to `data/reports/` via `writeReportFile()` for local inspection

After all days are processed, print a summary table showing each day's PR count and significance breakdown.

## Code Changes

### `src/pipeline/stages/collect.ts`

Add an options interface and a third parameter to `execute()`:

```typescript
export interface CollectOptions {
  sinceOverride?: Date;
  skipSyncUpdate?: boolean;
}

export async function execute(
  _ctx: PipelineContext,
  deps: CollectDeps = defaultDeps,
  options: CollectOptions = {}
): Promise<StageResult>
```

Inside the per-project loop:
- If `options.sinceOverride` is set, use it instead of reading `last_synced_at` from DB
- If `options.skipSyncUpdate` is true, skip the `UPDATE projects SET last_synced_at = ?` statement

The `stage` object keeps its existing direct assignment (`{ name: "collect", execute }`). When the pipeline runner calls `stage.execute(ctx)`, the extra optional params use their defaults — production behavior is unchanged.

### `src/pipeline/stages/analyze.ts`

Add an options interface and a second parameter to `execute()`:

```typescript
export interface AnalyzeOptions {
  dateRange?: { startUnix: number; endUnix: number };
}

export async function execute(
  _ctx: PipelineContext,
  options: AnalyzeOptions = {}
): Promise<StageResult>
```

In the pending PR query:
- If `options.dateRange` is set, append `AND pr.merged_at >= ? AND pr.merged_at <= ?` to the WHERE clause

The `stage` object keeps its existing direct assignment (`{ name: "analyze", execute }`) — same reasoning as collect.

### `scripts/backfill.ts` (new file)

Standalone script. Imports:
- `execute` from `src/pipeline/stages/collect.ts`
- `execute` from `src/pipeline/stages/analyze.ts`
- `buildDailyReport` from `src/extensions/report-generator/daily.ts`
- `writeReportFile` from `src/extensions/report-generator/file-writer.ts`
- `getDb` from `src/storage/db.ts`
- `getSettings` from `src/config/settings.ts`

Argument parsing: simple `process.argv` scan (consistent with existing `src/index.ts` pattern, no external arg-parsing library).

## Idempotency

The entire script is safe to re-run for the same date range:

| Stage | Mechanism | Effect of re-run |
|-------|-----------|-----------------|
| Collect | `INSERT OR IGNORE` on `UNIQUE(project_id, pr_number)` | Skips existing PRs |
| Analyze | Checks for existing analysis before LLM call (line 131-143 in analyze.ts) | Marks as complete without re-calling LLM |
| Report | `ON CONFLICT(type, period_start, period_end) DO UPDATE` | Overwrites with latest data |

## Verification

1. Run backfill for a known date range:
   ```bash
   bun run scripts/backfill.ts --since 2026-06-01 --until 2026-06-05
   ```
2. Verify daily reports were created:
   ```bash
   sqlite3 data/monitor.db "SELECT date(period_start, 'unixepoch', '+8 hours'), length(digest_json) FROM reports WHERE type='daily' ORDER BY period_start DESC LIMIT 7"
   ```
3. Verify report files exist in `data/reports/`
4. Test weekly report using the backfilled data:
   ```bash
   # Quick test: call buildWeeklyReport and inspect output
   bun run scripts/test-weekly.ts
   ```
   Or wait for the next Monday cron trigger.
