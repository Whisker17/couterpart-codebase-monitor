/**
 * Backfill script — retroactively runs the full pipeline (Collect → Analyze → Report)
 * for a --since/--until date range.
 *
 * Usage:
 *   bun run scripts/backfill.ts --since YYYY-MM-DD --until YYYY-MM-DD [--allow-partial]
 */
import { getSettings } from "../src/config/settings";
import { getDb, closeDb } from "../src/storage/db";
import { getDayPeriod } from "../src/utils/time-window";
import { execute as collectExecute, type CollectDeps } from "../src/pipeline/stages/collect";
import type { CollectOptions } from "../src/pipeline/stages/collect";
import { execute as analyzeExecute } from "../src/pipeline/stages/analyze";
import type { AnalyzeOptions } from "../src/pipeline/stages/analyze";
import { buildDailyReportForPeriod } from "../src/extensions/report-generator/daily";
import type { DailyReportData } from "../src/extensions/report-generator/daily";
import { buildDailyPromptCard } from "../src/extensions/report-generator/templates/daily-prompt-card";
import { generateDailyPromptReportForPeriod } from "../src/extensions/report-generator/daily-prompt-report";
import type { DailyPromptReportResult } from "../src/extensions/report-generator/daily-prompt-report";
import { writeReportFile, type ReportCompleteness, type ReportFileContent } from "../src/extensions/report-generator/file-writer";
import { getTrackedProjects } from "../src/config/projects";
import type { TrackedProject } from "../src/config/projects";
import { fetchMergedPRs, fetchRepoMetadata, fetchPRStats } from "../src/extensions/github-collector/fetcher";
import { fetchAndStoreDiff } from "../src/extensions/github-collector/diff-fetcher";
import type { PipelineContext, StageResult } from "../src/pipeline/runner";
import { Database } from "bun:sqlite";

export interface DaySummary {
  date: string;
  status: "complete" | "partial" | "skipped";
  prTotal: number;
  prComplete: number;
  prIncomplete: number;
}

export interface BackfillResult {
  days: DaySummary[];
  anySkipped: boolean;
}

export interface BackfillDeps {
  timezone: string;
  db: Database;
  collectExecute: (ctx: PipelineContext, deps: CollectDeps, options: CollectOptions) => Promise<StageResult>;
  analyzeExecute: (ctx: PipelineContext, options: AnalyzeOptions) => Promise<StageResult>;
  collectDeps: CollectDeps;
  getTrackedProjects: () => TrackedProject[];
  buildDailyReportForPeriod: (startUnix: number, endUnix: number) => DailyReportData;
  generateDailyPromptReportForPeriod: (
    db: Database,
    timezone: string,
    startUnix: number,
    endUnix: number
  ) => Promise<DailyPromptReportResult>;
  buildDailyPromptCard: typeof buildDailyPromptCard;
  writeReportFile: (content: ReportFileContent) => string;
}

const realCollectDeps: CollectDeps = {
  fetchMergedPRs,
  fetchRepoMetadata,
  fetchPRStats,
  fetchAndStoreDiff,
};

function makeProductionDeps(): BackfillDeps {
  return {
    timezone: getSettings().schedule.timezone,
    db: getDb(),
    collectExecute,
    analyzeExecute,
    collectDeps: realCollectDeps,
    getTrackedProjects,
    buildDailyReportForPeriod,
    generateDailyPromptReportForPeriod,
    buildDailyPromptCard,
    writeReportFile,
  };
}

function enumerateDays(since: string, until: string): string[] {
  const days: string[] = [];
  const current = new Date(since + "T00:00:00Z");
  const end = new Date(until + "T00:00:00Z");
  while (current <= end) {
    days.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return days;
}

function nullifyDayReports(db: Database, days: string[], timezone: string): void {
  for (const day of days) {
    const { startUnix, endUnix } = getDayPeriod(timezone, day);
    const row = db
      .query<{ id: number }, [number, number]>(
        "SELECT id FROM reports WHERE type = 'daily' AND period_start = ? AND period_end = ?"
      )
      .get(startUnix, endUnix);
    if (!row) continue;
    db.run("UPDATE reports SET digest_json = NULL WHERE id = ?", [row.id]);
    db.run(
      "DELETE FROM report_deliveries WHERE report_id = ? AND status IN ('pending', 'failed')",
      [row.id]
    );
  }
}

function upsertDailyReport(
  db: Database,
  periodStartUnix: number,
  periodEndUnix: number,
  projectIds: string,
  content: string,
  completeness: string,
  digestJson: string | null
): void {
  db.run(
    `INSERT INTO reports (type, period_start, period_end, project_ids, content, completeness, digest_json)
     VALUES ('daily', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(type, period_start, period_end)
     DO UPDATE SET content      = excluded.content,
                   project_ids  = excluded.project_ids,
                   completeness = excluded.completeness,
                   digest_json  = excluded.digest_json`,
    [periodStartUnix, periodEndUnix, projectIds, content, completeness, digestJson]
  );
}

function cleanupDeliveries(db: Database, periodStartUnix: number, periodEndUnix: number): void {
  const row = db
    .query<{ id: number }, [number, number]>(
      "SELECT id FROM reports WHERE type = 'daily' AND period_start = ? AND period_end = ?"
    )
    .get(periodStartUnix, periodEndUnix);
  if (!row) return;
  db.run(
    "DELETE FROM report_deliveries WHERE report_id = ? AND status IN ('pending', 'failed')",
    [row.id]
  );
}

function buildSkippedResult(days: string[]): BackfillResult {
  return {
    days: days.map((d) => ({
      date: d,
      status: "skipped" as const,
      prTotal: 0,
      prComplete: 0,
      prIncomplete: 0,
    })),
    anySkipped: true,
  };
}

export async function runBackfill(
  since: string,
  until: string,
  allowPartial: boolean,
  deps: BackfillDeps
): Promise<BackfillResult> {
  const { timezone, db } = deps;
  const days = enumerateDays(since, until);

  if (days.length === 0) {
    console.log("[Backfill] No days in range.");
    return { days: [], anySkipped: false };
  }

  const dayPeriods = days.map((d) => ({ day: d, ...getDayPeriod(timezone, d) }));
  const rangeStartUnix = Math.min(...dayPeriods.map((p) => p.startUnix));
  const rangeEndUnix = Math.max(...dayPeriods.map((p) => p.endUnix));

  console.log(
    `[Backfill] Range: ${since} → ${until} (${days.length} day(s)), ` +
    `timezone=${timezone}, rangeStartUnix=${rangeStartUnix}, rangeEndUnix=${rangeEndUnix}`
  );

  const ctx: PipelineContext = {
    stageResults: new Map<string, StageResult>(),
    reportMode: "daily",
    timezone,
  };

  // Phase 1: Collect (entire range as one call)
  console.log("[Backfill] Phase 1: Collect");
  let collectFailed = false;
  let collectResult: StageResult;

  try {
    collectResult = await deps.collectExecute(ctx, deps.collectDeps, {
      dateRangeOverride: { startUnix: rangeStartUnix, endUnix: rangeEndUnix },
      skipSyncUpdate: true,
    } satisfies CollectOptions);
    ctx.stageResults.set("collect", collectResult);

    const hasFailure =
      !collectResult.success || (collectResult.failedProjects?.length ?? 0) > 0;
    if (hasFailure) {
      collectFailed = true;
      console.warn(
        `[Backfill] Collect had failures: success=${collectResult.success}, ` +
        `failedProjects=${JSON.stringify(collectResult.failedProjects ?? [])}`
      );
    }
  } catch (err) {
    collectFailed = true;
    console.error(
      "[Backfill] Collect threw:", err instanceof Error ? err.message : String(err)
    );
    collectResult = {
      success: false,
      itemsProcessed: 0,
      errors: [err instanceof Error ? err.message : String(err)],
      durationMs: 0,
      failedProjects: [],
    };
    ctx.stageResults.set("collect", collectResult);
  }

  if (collectFailed && !allowPartial) {
    console.error("[Backfill] Collect failed — nullifying all day digests and cleaning deliveries.");
    nullifyDayReports(db, days, timezone);
    return buildSkippedResult(days);
  }

  // Phase 2: Reset failed/budget_skipped PRs + Analyze
  console.log("[Backfill] Phase 2: Reset + Analyze");
  db.run(
    `UPDATE pull_requests
     SET analysis_status = 'pending', retry_count = 0
     WHERE merged_at >= ? AND merged_at <= ?
       AND analysis_status IN ('failed', 'budget_skipped')`,
    [rangeStartUnix, rangeEndUnix]
  );

  try {
    const analyzeResult = await deps.analyzeExecute(ctx, {
      dateRange: { startUnix: rangeStartUnix, endUnix: rangeEndUnix },
    });
    ctx.stageResults.set("analyze", analyzeResult);
  } catch (err) {
    console.error("[Backfill] Analyze threw:", err instanceof Error ? err.message : String(err));
    ctx.stageResults.set("analyze", {
      success: false,
      itemsProcessed: 0,
      errors: [err instanceof Error ? err.message : String(err)],
      durationMs: 0,
    });
  }

  // Phase 3: Per-day report generation
  console.log("[Backfill] Phase 3: Per-day report generation");
  const trackedProjects = deps.getTrackedProjects();
  const totalProjects = trackedProjects.length;
  const collectFailedProjects = collectResult.failedProjects ?? [];

  const daySummaries: DaySummary[] = [];

  for (const { day: dayString, startUnix, endUnix } of dayPeriods) {
    const dayPrTotal =
      db
        .query<{ cnt: number }, [number, number]>(
          "SELECT COUNT(*) as cnt FROM pull_requests WHERE merged_at >= ? AND merged_at <= ?"
        )
        .get(startUnix, endUnix)?.cnt ?? 0;

    const dayPrComplete =
      db
        .query<{ cnt: number }, [number, number]>(
          `SELECT COUNT(*) as cnt FROM pull_requests
           WHERE merged_at >= ? AND merged_at <= ? AND analysis_status = 'complete'`
        )
        .get(startUnix, endUnix)?.cnt ?? 0;

    const dayPrIncomplete = dayPrTotal - dayPrComplete;
    // When collect failed, all days are forced partial regardless of individual PR completeness
    const isIncomplete = dayPrIncomplete > 0 || collectFailed;

    if (isIncomplete && !allowPartial) {
      // Completeness gate: skip this day
      console.log(`[Backfill] ${dayString}: incomplete (${dayPrIncomplete} PR(s) not done) — skipping`);
      const reportRow = db
        .query<{ id: number }, [number, number]>(
          "SELECT id FROM reports WHERE type = 'daily' AND period_start = ? AND period_end = ?"
        )
        .get(startUnix, endUnix);
      if (reportRow) {
        db.run("UPDATE reports SET digest_json = NULL WHERE id = ?", [reportRow.id]);
        db.run(
          "DELETE FROM report_deliveries WHERE report_id = ? AND status IN ('pending', 'failed')",
          [reportRow.id]
        );
      }
      daySummaries.push({
        date: dayString,
        status: "skipped",
        prTotal: dayPrTotal,
        prComplete: dayPrComplete,
        prIncomplete: dayPrIncomplete,
      });
      continue;
    }

    // Build report for this day
    const { grouped, periodStartUnix, periodEndUnix, digest } =
      deps.buildDailyReportForPeriod(startUnix, endUnix);

    const dayStatus: "complete" | "partial" = isIncomplete ? "partial" : "complete";

    const completeness: ReportCompleteness = {
      total: totalProjects,
      success: totalProjects - collectFailedProjects.length,
      failed: collectFailedProjects,
      status: dayStatus,
      prTotal: dayPrTotal,
      prComplete: dayPrComplete,
      prIncomplete: dayPrIncomplete,
      ...(collectFailed ? { collectionIncomplete: true } : {}),
    };

    // digest_json is NULL for partial days, non-null JSON for complete days
    const digestJson: string | null = isIncomplete ? null : JSON.stringify(digest);

    if (grouped.length === 0) {
      // Empty day: no card file
      upsertDailyReport(
        db,
        periodStartUnix,
        periodEndUnix,
        "[]",
        "null",
        JSON.stringify(completeness),
        digestJson
      );
      cleanupDeliveries(db, periodStartUnix, periodEndUnix);
      console.log(`[Backfill] ${dayString}: empty day (${dayStatus})`);
    } else {
      // Non-empty day: generate prompt-based card and write file
      const promptReport = await deps.generateDailyPromptReportForPeriod(
        db,
        timezone,
        periodStartUnix,
        periodEndUnix
      );
      const card = deps.buildDailyPromptCard({
        date: promptReport.input.period.date,
        markdown: promptReport.markdown,
        totalPrs: promptReport.input.activitySummary.totalPrs,
        projectCount: promptReport.input.activitySummary.projectCount,
        directionalShiftCount: promptReport.input.activitySummary.directionalShiftCount,
        notableCount: promptReport.input.activitySummary.notableCount,
        routineCount: promptReport.input.activitySummary.routineCount,
        projects: promptReport.input.projects,
      });

      const cardContent = JSON.stringify(card);
      const projectIds = JSON.stringify(promptReport.input.projects.map((g) => g.projectId));

      try {
        deps.writeReportFile({ date: dayString, card, analyses: grouped, completeness });
      } catch (err) {
        console.warn(
          `[Backfill] ${dayString}: file write failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      upsertDailyReport(
        db,
        periodStartUnix,
        periodEndUnix,
        projectIds,
        cardContent,
        JSON.stringify(completeness),
        digestJson
      );
      cleanupDeliveries(db, periodStartUnix, periodEndUnix);

      console.log(
        `[Backfill] ${dayString}: ${dayStatus}, ${grouped.length} project(s), ` +
        `${dayPrComplete}/${dayPrTotal} PRs complete`
      );
    }

    daySummaries.push({
      date: dayString,
      status: dayStatus,
      prTotal: dayPrTotal,
      prComplete: dayPrComplete,
      prIncomplete: dayPrIncomplete,
    });
  }

  return {
    days: daySummaries,
    anySkipped: daySummaries.some((d) => d.status === "skipped"),
  };
}

function printSummaryTable(days: DaySummary[]): void {
  console.log("\n[Backfill] Summary:");
  console.log("  Date         Status     PRs  Complete  Incomplete");
  console.log("  ----------  ---------  ---  --------  ----------");
  for (const d of days) {
    console.log(
      `  ${d.date}  ${d.status.padEnd(9)}  ${String(d.prTotal).padStart(3)}  ` +
      `${String(d.prComplete).padStart(8)}  ${String(d.prIncomplete).padStart(10)}`
    );
  }
  console.log("");
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const sinceIdx = args.indexOf("--since");
  const untilIdx = args.indexOf("--until");
  const allowPartial = args.includes("--allow-partial");

  if (sinceIdx === -1 || untilIdx === -1) {
    console.error(
      "Usage: bun run scripts/backfill.ts --since YYYY-MM-DD --until YYYY-MM-DD [--allow-partial]"
    );
    return 1;
  }

  const since = args[sinceIdx + 1];
  const until = args[untilIdx + 1];

  if (!since || !until) {
    console.error("[Backfill] --since and --until require date values (YYYY-MM-DD)");
    return 1;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
    console.error("[Backfill] Dates must be in YYYY-MM-DD format");
    return 1;
  }

  if (since > until) {
    console.error("[Backfill] --since must not be after --until");
    return 1;
  }

  console.log(
    `[Backfill] Starting backfill: since=${since}, until=${until}, allowPartial=${allowPartial}`
  );

  const result = await runBackfill(since, until, allowPartial, makeProductionDeps());
  printSummaryTable(result.days);

  if (result.anySkipped) {
    console.error("[Backfill] One or more days were skipped. Exit 1.");
    return 1;
  }

  console.log("[Backfill] All days processed successfully.");
  return 0;
}

if (import.meta.main) {
  main()
    .then((code) => {
      closeDb();
      process.exit(code);
    })
    .catch((err) => {
      console.error("[Backfill] Fatal error:", err);
      closeDb();
      process.exit(1);
    });
}
