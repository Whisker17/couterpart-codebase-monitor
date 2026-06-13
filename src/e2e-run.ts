/**
 * E2E integration runner — manually triggers the full pipeline.
 *
 * Usage:
 *   bun run src/e2e-run.ts                     # daily (default)
 *   bun run src/e2e-run.ts --mode weekly        # weekly (daily + weekly reports)
 *   bun run src/e2e-run.ts --mode monthly       # monthly (daily + monthly reports)
 *   bun run src/e2e-run.ts --mode monthly --month 2026-06
 *   bun run src/e2e-run.ts --mode all           # daily + weekly + monthly reports
 *   bun run src/e2e-run.ts --mode weekly --no-dispatch  # skip Lark delivery
 */
import type { Database } from "bun:sqlite";
import { validateEnv, getSettings } from "./config/settings.ts";
import { getDb, closeDb } from "./storage/db";
import { runPipeline, type PipelineStage, type StageResult, type ReportMode } from "./pipeline/runner";
import { stage as collect } from "./pipeline/stages/collect";
import { stage as analyze } from "./pipeline/stages/analyze";
import { stage as impactCheck } from "./pipeline/stages/impact-check";
import { stage as report } from "./pipeline/stages/report";
import { stage as dispatch } from "./pipeline/stages/dispatch";
import { getMonthPeriod, getPreviousMonthString, getYesterdayPeriod, getWeekPeriod } from "./utils/time-window";

export type RunMode = "daily" | "weekly" | "monthly" | "all";

export interface E2EOptions {
  mode: RunMode;
  noDispatch: boolean;
  month?: string;
  timezone?: string;
}

const VALID_MODES: RunMode[] = ["daily", "weekly", "monthly", "all"];

function parseMonth(value: string): string | undefined {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return undefined;
  return value;
}

export function parseOptions(argv: string[]): E2EOptions {
  let mode: RunMode = "daily";
  let noDispatch = false;
  let month: string | undefined;
  let timezone: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--mode" && i + 1 < argv.length) {
      const val = argv[i + 1] as RunMode;
      if (VALID_MODES.includes(val)) {
        mode = val;
        i++;
      }
    } else if (argv[i] === "--no-dispatch") {
      noDispatch = true;
    } else if (argv[i] === "--month" && i + 1 < argv.length) {
      const value = argv[i + 1];
      if (value !== undefined) month = parseMonth(value);
      i++;
    } else if (argv[i] === "--timezone" && i + 1 < argv.length) {
      const value = argv[i + 1];
      if (value !== undefined) timezone = value;
      i++;
    }
  }

  return {
    mode,
    noDispatch,
    ...(month ? { month } : {}),
    ...(timezone ? { timezone } : {}),
  };
}

export function getRunStages(noDispatch: boolean): PipelineStage[] {
  const stages: PipelineStage[] = [collect, analyze, impactCheck, report];
  if (!noDispatch) stages.push(dispatch);
  return stages;
}

export function getE2EStages(): PipelineStage[] {
  return [collect, analyze, impactCheck, report, dispatch];
}

export function getExitCode(results: Map<string, StageResult>): 0 | 1 {
  return [...results.values()].some((result) => !result.success) ? 1 : 0;
}

interface ReportRow {
  id: number;
  type: string;
  period_start: number;
  period_end: number;
  created_at: number;
}

interface DeliveryRow {
  status: string;
  lark_message_id: string | null;
}

interface AnalysisRow {
  id: number;
  project_id: string;
  summary: string;
  significance: string | null;
  direction_signal: string | null;
  pr_title: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  estimated_cost_usd: number | null;
}

function formatUnixDate(unixSeconds: number, timezone?: string): string {
  if (timezone) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(unixSeconds * 1000));
  }
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

export function printPostRunSummary(
  mode: RunMode,
  noDispatch: boolean,
  results: Map<string, StageResult>,
  maxAnalysisIdBefore: number,
  injectedDb?: Database,
  injectedTimezone?: string,
  injectedNow?: Date,
  monthlyMonth?: string
): 0 | 1 {
  const db = injectedDb ?? getDb();
  const timezone = injectedTimezone ?? getSettings().schedule.timezone;
  const now = injectedNow ?? new Date();

  console.log("\nStage results:");
  for (const [name, r] of results) {
    const status = r.success ? "success" : "FAILED";
    console.log(`  ${name}: ${status}, processed=${r.itemsProcessed}`);
    if (r.errors.length > 0) {
      for (const err of r.errors) {
        console.error(`    error: ${err}`);
      }
    }
    if (r.budgetExhausted) {
      console.warn(`    ⚠ Budget exhausted — skipped ${r.budgetSkippedCount} PRs`);
    }
  }

  const anyFailed = [...results.values()].some((r) => !r.success);

  const expectedTypes: string[] =
    mode === "daily"
      ? ["daily"]
      : mode === "weekly"
        ? ["daily", "weekly"]
        : mode === "monthly"
          ? ["daily", "monthly"]
          : ["daily", "weekly", "monthly"];

  const { startUnix: dailyStart, endUnix: dailyEnd } = getYesterdayPeriod(timezone, now);
  const { startUnix: weeklyStart, endUnix: weeklyEnd } = getWeekPeriod(timezone, now);
  const monthlyPeriod = getMonthPeriod(timezone, monthlyMonth ?? getPreviousMonthString(timezone, now), now);

  console.log("\nReports:");
  let reportsMissing = false;

  for (const reportType of expectedTypes) {
    const periodStart =
      reportType === "weekly" ? weeklyStart : reportType === "monthly" ? monthlyPeriod.startUnix : dailyStart;
    const periodEnd =
      reportType === "weekly" ? weeklyEnd : reportType === "monthly" ? monthlyPeriod.endUnix : dailyEnd;
    const row = db
      .query<ReportRow, [string, number]>(
        "SELECT id, type, period_start, period_end, created_at FROM reports WHERE type = ? AND period_start >= ? ORDER BY period_start DESC LIMIT 1"
      )
      .get(reportType, periodStart);

    if (!row) {
      const analysisCount = db
        .query<{ count: number }, [number, number]>(
          `SELECT COUNT(*) as count
           FROM analyses a
           JOIN (
             SELECT pr_id, MAX(id) AS analysis_id
             FROM analyses
             GROUP BY pr_id
           ) latest ON latest.analysis_id = a.id
           JOIN pull_requests p ON a.pr_id = p.id
           WHERE p.merged_at >= ? AND p.merged_at <= ?`
        )
        .get(periodStart, periodEnd);

      if (analysisCount && analysisCount.count > 0) {
        console.log(`  ${reportType}: MISSING (analyses exist — failure)`);
        reportsMissing = true;
      } else {
        console.log(`  ${reportType}: [NO_DATA] report skipped — no data for this period`);
      }
      continue;
    }

    const deliveries = db
      .query<DeliveryRow, [number]>(
        "SELECT status, lark_message_id FROM report_deliveries WHERE report_id = ?"
      )
      .all(row.id);

    const sent = deliveries.filter((d) => d.status === "sent").length;
    const failed = deliveries.filter((d) => d.status === "failed").length;
    const pending = deliveries.filter((d) => d.status === "pending").length;
    const periodStr =
      reportType === "daily"
        ? formatUnixDate(row.period_start, timezone)
        : `${formatUnixDate(row.period_start, timezone)}..${formatUnixDate(row.period_end, timezone)}`;

    console.log(
      `  ${reportType}  #${row.id} ${periodStr} cards=${deliveries.length} deliveries=sent:${sent} failed:${failed} pending:${pending}`
    );

    if (!noDispatch && failed > 0) {
      console.error(`  ERROR: ${failed} delivery(ies) failed`);
    }
  }

  // Analysis sample and cost from this run
  const newAnalyses = db
    .query<AnalysisRow, [number]>(
      `SELECT a.id, a.project_id, a.summary, a.significance, a.direction_signal,
              p.title as pr_title, a.input_tokens, a.output_tokens, a.estimated_cost_usd
       FROM analyses a
       JOIN (
         SELECT pr_id, MAX(id) AS analysis_id
         FROM analyses
         GROUP BY pr_id
       ) latest ON latest.analysis_id = a.id
       JOIN pull_requests p ON a.pr_id = p.id
       WHERE a.id > ?
       ORDER BY a.id DESC`
    )
    .all(maxAnalysisIdBefore);

  if (newAnalyses.length > 0) {
    const totalInput = newAnalyses.reduce((s, a) => s + (a.input_tokens ?? 0), 0);
    const totalOutput = newAnalyses.reduce((s, a) => s + (a.output_tokens ?? 0), 0);
    const totalCost = newAnalyses.reduce((s, a) => s + (a.estimated_cost_usd ?? 0), 0);

    console.log("\nAnalysis sample:");
    for (const a of newAnalyses.slice(0, 5)) {
      console.log(
        `  ${a.project_id} ${a.significance ?? "unknown"} - ${a.pr_title ?? "(no title)"}`
      );
      if (a.direction_signal) console.log(`    direction: ${a.direction_signal}`);
      if (a.summary) console.log(`    ${a.summary.slice(0, 120)}${a.summary.length > 120 ? "…" : ""}`);
    }

    console.log("\nCost:");
    console.log(
      `  new analyses: ${newAnalyses.length}, input=${totalInput}, output=${totalOutput}, estimated=$${totalCost.toFixed(4)}`
    );
  } else {
    console.log("\nCost:");
    console.log("  new analyses: 0");
  }

  const messageIds: string[] = [];
  if (!noDispatch) {
    for (const reportType of expectedTypes) {
      const lookupStart =
        reportType === "weekly" ? weeklyStart : reportType === "monthly" ? monthlyPeriod.startUnix : dailyStart;
      const row = db
        .query<ReportRow, [string, number]>(
          "SELECT id FROM reports WHERE type = ? AND period_start >= ? ORDER BY period_start DESC LIMIT 1"
        )
        .get(reportType, lookupStart);

      if (row) {
        const ids = db
          .query<{ lark_message_id: string }, [number]>(
            "SELECT lark_message_id FROM report_deliveries WHERE report_id = ? AND status = 'sent' AND lark_message_id IS NOT NULL"
          )
          .all(row.id)
          .map((d) => d.lark_message_id);
        messageIds.push(...ids);
      }
    }

    if (messageIds.length > 0) {
      console.log("\nLark:");
      console.log(`  sent message ids: ${messageIds.join(", ")}`);
    }
  }

  if (anyFailed || reportsMissing) return 1;
  return 0;
}

export async function runE2E(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { mode, noDispatch, month, timezone: timezoneOverride } = parseOptions(argv);

  validateEnv();
  const db = getDb();

  const maxIdRow = db.query<{ maxId: number }, []>("SELECT COALESCE(MAX(id), 0) as maxId FROM analyses").get()!;
  const maxAnalysisIdBefore = maxIdRow.maxId;

  const reportMode = mode as ReportMode;
  const stages = getRunStages(noDispatch);

  console.log(`[E2E] Mode: ${mode}${month ? ` (${month})` : ""}${noDispatch ? " (no-dispatch)" : ""}`);
  const stageNames = stages.map((s) => s.name).join(" → ");
  console.log(`[E2E] Stages: ${stageNames}`);

  const timezone = timezoneOverride ?? getSettings().schedule.timezone;

  const start = Date.now();
  const results = await runPipeline(stages, { reportMode, timezone, monthlyMonth: month, dispatchEnabled: !noDispatch });
  const totalMs = Date.now() - start;

  console.log(`\n[E2E] Pipeline complete in ${(totalMs / 1000).toFixed(1)}s`);

  return printPostRunSummary(mode, noDispatch, results, maxAnalysisIdBefore, undefined, undefined, undefined, month);
}

if (import.meta.main) {
  runE2E(process.argv.slice(2))
    .then((exitCode) => {
      closeDb();
      process.exit(exitCode);
    })
    .catch((err) => {
      console.error("[E2E] Fatal error:", err);
      closeDb();
      process.exit(1);
    });
}
