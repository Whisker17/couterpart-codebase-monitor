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
- `--allow-partial`: (optional) write daily reports even when some PRs in that day's range are not yet analyzed. Without this flag, days with incomplete analyses are skipped and the script exits with code 1.
- Dates interpreted in the timezone from `config/settings.json` (`schedule.timezone`)
- No Lark dispatch — reports are generated and stored in DB but not sent

## Execution Flow

Three sequential phases. Each phase completes fully before the next starts.

### Phase 1: Collect

Run once for the entire date range.

- Compute range boundaries using `getDayPeriod`: `startUnix` from `since` date, `endUnix` from `until` date
- Call `collect.execute()` with `dateRangeOverride = { startUnix, endUnix }` and `skipSyncUpdate = true`
- Collect passes `new Date((startUnix - 1) * 1000)` as the `since` parameter to `fetchMergedPRs` (subtracting 1 second compensates for the fetcher's exclusive lower bound: `mergedAt <= since` is skipped). After fetch, results are post-filtered to `mergedAtUnix >= startUnix && mergedAtUnix <= endUnix` to ensure exact boundary alignment with the analyze and report phases.
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
3. The analyze stage queries only PRs with `merged_at` in the range that are `pending` or `failed`. **The date range filter must wrap the entire status condition** (see Code Changes for the exact query).
4. Budget controls still apply — if the budget is exhausted, remaining PRs are skipped with a warning
5. PRs that already have a completed analysis are auto-detected and skipped (existing behavior)
6. After `analyze.execute()` returns, backfill checks per-day completeness (see Phase 3 gate)

### Phase 3: Report

Run per-day, iterating from `since` to `until`.

#### Collect failure guard

Before entering the per-day loop, check the result from Phase 1. If `collect.execute()` returned `success === false` or `failedProjects` is non-empty:

- Print an error listing the failed projects.
- Without `--allow-partial`: before exiting, null out existing digests and clean up stale deliveries for the entire backfill date range to prevent weekly from trusting stale data:
  ```sql
  UPDATE reports SET digest_json = NULL
  WHERE type = 'daily' AND period_start >= :rangeStartUnix AND period_end <= :rangeEndUnix
    AND digest_json IS NOT NULL;

  DELETE FROM report_deliveries
  WHERE report_id IN (
    SELECT id FROM reports
    WHERE type = 'daily' AND period_start >= :rangeStartUnix AND period_end <= :rangeEndUnix
  ) AND status != 'sent';
  ```
  Then exit with code 1. Do NOT proceed to report generation — the PR set in the DB is known-incomplete, and the per-day completeness gate below cannot detect PRs that were never collected.
- With `--allow-partial`: proceed, but treat all days as partial (write `digest_json = NULL` for every day). Log which projects failed collection.

This is necessary because the per-day completeness gate only counts PRs already in the DB. If a project's collect failed, its PRs are simply absent — the gate would see zero incomplete PRs and incorrectly judge the day as complete.

#### Completeness gate

Before generating each day's report, count PRs that are NOT fully analyzed:

```sql
SELECT COUNT(*) AS incomplete FROM pull_requests
WHERE merged_at >= :dayStartUnix AND merged_at <= :dayEndUnix
  AND analysis_status != 'complete'
```

`budget_skipped` counts as incomplete — the analyzer does not write an `analyses` row for these PRs, so they would be absent from the daily digest. Including them in "complete" would produce a digest that silently undercounts PRs.

Three cases:

- **`incomplete == 0`**: all PRs analyzed. Proceed with full report generation and write `digest_json`.
- **`incomplete > 0` without `--allow-partial`**: skip report generation for this day. However, if the DB already has a report row for this day, **null out the digest and clean up stale deliveries** to prevent weekly from trusting stale data and dispatcher from sending old cards:
  ```sql
  UPDATE reports SET digest_json = NULL
  WHERE type = 'daily' AND period_start = :dayStartUnix AND period_end = :dayEndUnix
    AND digest_json IS NOT NULL;

  DELETE FROM report_deliveries
  WHERE report_id = (SELECT id FROM reports WHERE type = 'daily' AND period_start = :dayStartUnix AND period_end = :dayEndUnix)
    AND status != 'sent';
  ```
  Print a warning: `Day YYYY-MM-DD: N PRs incomplete (pending/failed/budget_skipped), skipping report`. Continue to the next day.
- **`incomplete > 0` with `--allow-partial`**: generate the report and write the file to disk for local inspection, but set `digest_json = NULL` in the report row. This forces the weekly aggregator to fall back to the `analyses` table query for this day, which will pick up whatever analyses exist at weekly-build time (possibly more than at backfill time). Store completeness metadata with `status: "partial"` for debugging.

This prevents backfill from writing an incomplete daily digest that the weekly report would silently trust as complete. The weekly aggregator's existing per-day fallback (weekly.ts:286–303) handles `NULL` digests correctly.

#### Per-day report generation

For each day that passes the gate (i.e. `incomplete == 0`, or `--allow-partial`):

1. Compute the day's period using `getDayPeriod(timezone, dayString)` — a new helper that takes a `YYYY-MM-DD` string and returns `{ startUnix, endUnix }` directly, without relying on `fakeNow` + `getYesterdayPeriod`. This avoids timezone-edge-case bugs (the previous `fakeNow = day+1 noon UTC` approach only works for positive UTC offsets). `dayString` must be parsed as numeric year/month/day from the literal string, not via `new Date(dayString)` or `Date.parse()`, because JavaScript parses bare `YYYY-MM-DD` dates as UTC and would reintroduce timezone ambiguity.
2. Call `buildDailyReportForPeriod(periodStartUnix, periodEndUnix)` — a new function extracted from `buildDailyReport` that takes explicit unix timestamps instead of computing them from `now`. `buildDailyReport` is refactored to call this internally so production behavior is unchanged.
3. If the day has no deliverable PRs (`reportData.grouped.length === 0`), use the same empty-daily semantics as production `report.ts`: upsert a daily report with `content = 'null'`, `project_ids = '[]'`, `digest_json = JSON.stringify(reportData.digest)` for complete days or `NULL` for partial days, clean up unsent deliveries, and skip `buildFinalCard()`/`writeReportFile()` for that day. A day with zero analyzed PRs should not produce an empty Lark card file; the digest is still useful for weekly aggregation when the day is complete.
4. Otherwise, generate Lark card JSON for `reports.content` by reusing `buildFinalCard()` from `report.ts` (which calls `formatReport` internally). Note: this produces **unlocalized** card content — production's `report.ts` additionally runs `localizeDailyDelivery()` before formatting and passes `budgetLine` to the card. Backfill skips both because: (a) localization is a delivery concern, not a storage concern; (b) budget state at backfill time doesn't reflect the original day's budget. The stored `content` is structurally valid Lark card JSON suitable for local inspection, but not byte-identical to what production would have dispatched.
5. Build the `completeness` JSON object. The existing schema uses project-level fields (`total`/`success`/`failed` refer to tracked projects, not PRs). Backfill preserves this and adds PR-level fields under separate keys:
   ```typescript
   // Complete day:
   { total: trackedProjects.length, success: trackedProjects.length, failed: [] }
   // Partial day (--allow-partial):
   {
     total: trackedProjects.length,
     success: trackedProjects.length - collectFailedProjects.length,
     failed: collectFailedProjects,
     status: "partial",
     prTotal: N,        // PRs in DB for that day (lower bound if collection was incomplete)
     prComplete: M,     // PRs with analysis_status = 'complete'
     prIncomplete: N-M, // pending + failed + budget_skipped
     collectionIncomplete: true  // only set when collect had failedProjects; signals prTotal is a lower bound
   }
   ```
   `collectionIncomplete` is only set when `collect.execute()` returned failed projects — it tells debuggers that `prTotal` may undercount because some repos' PRs were never fetched. Existing code reads only `total`/`success`/`failed` — the additive fields are ignored by current consumers.
6. Upsert into the `reports` table:
   ```sql
   INSERT INTO reports (type, period_start, period_end, project_ids, content, completeness, digest_json)
   VALUES ('daily', ?, ?, ?, ?, ?, ?)
   ON CONFLICT(type, period_start, period_end)
   DO UPDATE SET content = excluded.content,
                 completeness = excluded.completeness,
                 project_ids = excluded.project_ids,
                 digest_json = excluded.digest_json
   ```
   - For complete days: `digest_json` = the full digest JSON.
   - For partial days (`--allow-partial`): `digest_json = NULL` — forces weekly to use per-day analyses fallback.
7. After upsert, clean up any stale pending/failed deliveries for the affected report:
   ```sql
   DELETE FROM report_deliveries
   WHERE report_id = (SELECT id FROM reports WHERE type = 'daily' AND period_start = ? AND period_end = ?)
     AND status != 'sent'
   ```
   Already-sent deliveries are preserved. This prevents the dispatcher from re-sending stale card content after backfill overwrites a report.
8. Do NOT create new `report_deliveries` rows (no Lark dispatch)
9. For non-empty days only, write report JSON to `data/reports/` via `writeReportFile()` for local inspection

After all days are processed, print a summary table showing each day's PR count, significance breakdown, and completeness status. If any days were skipped due to incomplete analysis, exit with code 1.

## Code Changes

### `src/pipeline/stages/collect.ts`

Add an options interface and a third parameter to `execute()`:

```typescript
export interface CollectOptions {
  dateRangeOverride?: { startUnix: number; endUnix: number };
  skipSyncUpdate?: boolean;
}

export async function execute(
  _ctx: PipelineContext,
  deps: CollectDeps = defaultDeps,
  options: CollectOptions = {}
): Promise<StageResult>
```

Inside the per-project loop, when `options.dateRangeOverride` is set:
- Use `new Date((startUnix - 1) * 1000)` as the `since` parameter to `deps.fetchMergedPRs` instead of reading `last_synced_at`. The `-1s` compensates for the fetcher's exclusive lower bound (`mergedAt <= since` is skipped), making the range effectively inclusive at `startUnix`.
- After `fetchMergedPRs` returns, post-filter: `const mergedAtUnix = Math.floor(pr.merged_at.getTime() / 1000); if (mergedAtUnix < startUnix || mergedAtUnix > endUnix) continue;`. This ensures exact boundary alignment regardless of fetcher semantics.
- If `options.skipSyncUpdate` is true, skip the `UPDATE projects SET last_synced_at = ?` statement

No changes to `CollectDeps` or `fetchMergedPRs` signature — the collect stage handles boundary translation internally.

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

In the pending PR query, if `options.dateRange` is set, the date filter must wrap the **entire** status condition to avoid SQL operator precedence bugs. The modified query:

```sql
SELECT pr.*, p.description, p.language, p.topics, p.overview
FROM pull_requests pr JOIN projects p ON pr.project_id = p.id
WHERE (pr.analysis_status = 'pending'
   OR (pr.analysis_status = 'failed' AND pr.retry_count < 3))
  AND pr.merged_at >= ?
  AND pr.merged_at <= ?
```

Without the outer parentheses around the `OR`, SQL's precedence (`AND` binds tighter than `OR`) would cause `pr.analysis_status = 'pending'` to match **all** pending PRs regardless of date — defeating the date range filter.

When `dateRange` is not set (production path), the query remains unchanged: no parentheses needed since there's no trailing `AND` clause.

The `stage` object keeps its existing direct assignment (`{ name: "analyze", execute }`) — same reasoning as collect.

### `src/utils/time-window.ts`

Add a new exported helper:

```typescript
export function getDayPeriod(
  timezone: string,
  dayString: string  // "YYYY-MM-DD"
): { startUnix: number; endUnix: number }
```

Validate `dayString` with `/^\d{4}-\d{2}-\d{2}$/`, parse year/month/day as numbers from the matched string, compute local midnight→midnight for that day using the existing `localMidnightToUTC` helper, and return `{ startUnix, endUnix }`. Do not use `new Date(dayString)` or `Date.parse(dayString)` for parsing — JavaScript treats bare `YYYY-MM-DD` strings as UTC, not as the configured schedule timezone. This replaces the fragile `fakeNow` approach with no assumptions about UTC offset sign.

Refactor `buildDailyReport` in `daily.ts` to delegate to a new `buildDailyReportForPeriod(startUnix, endUnix)` that takes explicit timestamps. `buildDailyReport(timezone, now?)` calls `getYesterdayPeriod` then delegates — production behavior unchanged.

### `src/extensions/report-generator/file-writer.ts`

Extract a shared `ReportCompleteness` type from the inline `completeness` field in `ReportFileContent`:

```typescript
export interface ReportCompleteness {
  total: number;
  success: number;
  failed: string[];
  // Backfill-only additive fields (ignored by existing consumers):
  status?: "partial";
  prTotal?: number;
  prComplete?: number;
  prIncomplete?: number;
  collectionIncomplete?: boolean;
}

export interface ReportFileContent {
  date: string;
  card: LarkCard | LarkCard[];
  analyses: GroupedAnalyses;
  completeness: ReportCompleteness;
}
```

This prevents TS excess-property errors when backfill passes the extended completeness object. Production code continues to work — the optional fields are never set by `report.ts`.

### `scripts/backfill.ts` (new file)

Standalone script. Imports:
- `execute` from `src/pipeline/stages/collect.ts`
- `execute` from `src/pipeline/stages/analyze.ts`
- `buildDailyReportForPeriod` from `src/extensions/report-generator/daily.ts`
- `buildFinalCard` from `src/pipeline/stages/report.ts` (reuse Lark card generation for `reports.content`)
- `getDayPeriod` from `src/utils/time-window.ts`
- `writeReportFile` from `src/extensions/report-generator/file-writer.ts`
- `getDb` from `src/storage/db.ts`
- `getSettings` from `src/config/settings.ts`
- `getTrackedProjects` from `src/config/projects.ts`

Argument parsing: simple `process.argv` scan (consistent with existing `src/index.ts` pattern, no external arg-parsing library). Supports `--since`, `--until`, and `--allow-partial`.

## Idempotency

The entire script is safe to re-run for the same date range:

| Stage | Mechanism | Effect of re-run |
|-------|-----------|-----------------|
| Collect | `INSERT OR IGNORE` on `UNIQUE(project_id, pr_number)` | Skips existing PRs |
| Collect | `dateRangeOverride` post-filters results to exact unix boundaries | No out-of-range PRs inserted |
| Analyze | Checks for existing analysis before LLM call (line 131-143 in analyze.ts) | Marks as complete without re-calling LLM |
| Analyze | Date range wraps entire WHERE clause with parentheses | Only scans PRs in target range |
| Report | `ON CONFLICT(type, period_start, period_end) DO UPDATE` | Overwrites with latest data |
| Report | `DELETE FROM report_deliveries WHERE ... AND status != 'sent'` | Clears stale pending deliveries |
| Report | Collect failure guard: aborts if projects failed collection | Prevents gate from misjudging absent PRs as complete |
| Report | Completeness gate: only `analysis_status = 'complete'` passes | Won't write misleading digest |
| Report | Incomplete days: existing `digest_json` nulled + stale deliveries deleted | Prevents weekly from trusting stale data and dispatcher from sending old cards |
| Report | `--allow-partial`: writes `digest_json = NULL` | Weekly falls back to analyses query |
| Report | Empty complete days use `content='null'`, `project_ids='[]'`, and an empty digest | Matches production empty-daily behavior without creating empty card files |

## Verification

1. Run backfill for a known date range:
   ```bash
   bun run scripts/backfill.ts --since 2026-06-01 --until 2026-06-05
   ```
2. Verify complete days have non-null digests, partial/skipped days have null:
   ```bash
   sqlite3 data/monitor.db "
     SELECT date(period_start, 'unixepoch', '+8 hours') AS day,
            CASE WHEN digest_json IS NOT NULL THEN length(digest_json) ELSE 'NULL' END AS digest_len,
            json_extract(completeness, '$.status') AS status
     FROM reports WHERE type='daily'
     ORDER BY period_start DESC LIMIT 7
   "
   ```
3. Verify no stale deliveries remain for backfilled date range:
   ```bash
   # Replace :startUnix/:endUnix with the actual unix timestamps for your backfill range
   sqlite3 data/monitor.db "
     SELECT r.period_start, rd.status, rd.id
     FROM report_deliveries rd
     JOIN reports r ON r.id = rd.report_id
     WHERE r.type = 'daily'
       AND r.period_start >= :startUnix AND r.period_end <= :endUnix
       AND rd.status != 'sent'
     ORDER BY r.period_start DESC
   "
   ```
   Expected: empty result (no pending/failed deliveries for backfilled days).
4. Verify non-empty report files exist in `data/reports/`, and empty complete days do not create empty card files:
   ```bash
   sqlite3 data/monitor.db "
     SELECT date(period_start, 'unixepoch', '+8 hours') AS day,
            content,
            project_ids,
            json_extract(digest_json, '$.activitySummary.totalPrs') AS digest_prs
     FROM reports
     WHERE type='daily'
       AND period_start >= :startUnix AND period_end <= :endUnix
       AND content = 'null'
     ORDER BY period_start
   "
   ```
   Expected for empty complete days: `content = 'null'`, `project_ids = '[]'`, `digest_prs = 0`.
5. Test weekly report using the backfilled data:
   ```bash
   # Quick test: call buildWeeklyReport and inspect output
   bun run scripts/test-weekly.ts
   ```
   Or wait for the next Monday cron trigger.
6. Test partial mode produces null digest (deterministic setup):
   ```bash
   # Manually mark a PR as incomplete to simulate budget_skipped/failed state
   sqlite3 data/monitor.db "
     UPDATE pull_requests SET analysis_status = 'budget_skipped'
     WHERE id = (
       SELECT id FROM pull_requests
       WHERE merged_at >= $(date -j -f '%Y-%m-%d' '2026-06-01' '+%s')
         AND merged_at <= $(date -j -f '%Y-%m-%d' '2026-06-02' '+%s')
       LIMIT 1
     )
   "
   # Run backfill in partial mode for that day
   bun run scripts/backfill.ts --since 2026-06-01 --until 2026-06-01 --allow-partial
   # Verify: digest should be NULL, status should be partial
   sqlite3 data/monitor.db "
     SELECT digest_json IS NULL AS is_null,
            json_extract(completeness, '$.status') AS status
     FROM reports WHERE type='daily'
     ORDER BY period_start DESC LIMIT 1
   "
   ```
   Expected: `is_null = 1`, `status = partial`.
