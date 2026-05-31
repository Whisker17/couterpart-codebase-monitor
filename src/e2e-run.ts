/**
 * E2E integration runner — manually triggers the full pipeline.
 *
 * Usage:
 *   bun run src/e2e-run.ts                     # daily (default)
 *   bun run src/e2e-run.ts --mode weekly        # weekly (daily + weekly reports)
 *   bun run src/e2e-run.ts --mode all           # same as weekly, monthly skipped
 *   bun run src/e2e-run.ts --mode monthly       # exits 1 — not implemented yet
 *   bun run src/e2e-run.ts --mode weekly --no-dispatch  # skip Lark delivery
 */
import { validateEnv } from "./config/settings.ts";
import { getDb, closeDb } from "./storage/db";
import { runPipeline, type PipelineStage, type StageResult, type ReportMode } from "./pipeline/runner";
import { stage as collect } from "./pipeline/stages/collect";
import { stage as analyze } from "./pipeline/stages/analyze";
import { stage as report } from "./pipeline/stages/report";
import { stage as dispatch } from "./pipeline/stages/dispatch";

export type RunMode = "daily" | "weekly" | "monthly" | "all";

export interface E2EOptions {
  mode: RunMode;
  noDispatch: boolean;
}

const VALID_MODES: RunMode[] = ["daily", "weekly", "monthly", "all"];

export function parseOptions(argv: string[]): E2EOptions {
  let mode: RunMode = "daily";
  let noDispatch = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--mode" && i + 1 < argv.length) {
      const val = argv[i + 1] as RunMode;
      if (VALID_MODES.includes(val)) {
        mode = val;
        i++;
      }
    } else if (argv[i] === "--no-dispatch") {
      noDispatch = true;
    }
  }

  return { mode, noDispatch };
}

export function getRunStages(noDispatch: boolean): PipelineStage[] {
  const stages: PipelineStage[] = [collect, analyze, report];
  if (!noDispatch) stages.push(dispatch);
  return stages;
}

export function getPipelineReportMode(mode: RunMode): ReportMode {
  if (mode === "all") return "weekly";
  return mode as ReportMode;
}

export function getModeNotImplementedMessage(mode: RunMode): string | null {
  if (mode === "monthly") {
    return "[E2E] Monthly mode is not implemented yet. Implement buildMonthlyReport/monthly card before enabling this scenario.";
  }
  return null;
}

export function getE2EStages(): PipelineStage[] {
  return [collect, analyze, report, dispatch];
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

function formatUnixDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

function printPostRunSummary(
  mode: RunMode,
  noDispatch: boolean,
  results: Map<string, StageResult>,
  maxAnalysisIdBefore: number
): 0 | 1 {
  const db = getDb();

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

  // Determine which report types to check based on mode
  const expectedTypes: string[] = mode === "daily" ? ["daily"] : ["daily", "weekly"];

  // Today's window: midnight UTC to now
  const nowUnix = Math.floor(Date.now() / 1000);
  const todayMidnightUnix = nowUnix - (nowUnix % 86400);

  console.log("\nReports:");
  let reportsMissing = false;

  for (const reportType of expectedTypes) {
    const row = db
      .query<ReportRow, [string, number]>(
        "SELECT id, type, period_start, period_end, created_at FROM reports WHERE type = ? AND period_start >= ? ORDER BY period_start DESC LIMIT 1"
      )
      .get(reportType, reportType === "weekly" ? todayMidnightUnix - 6 * 86400 : todayMidnightUnix);

    if (!row) {
      // Check if there's any data — if analyses exist for today, missing report is a failure
      const analysisCount = db
        .query<{ count: number }, [number]>(
          "SELECT COUNT(*) as count FROM analyses a JOIN pull_requests p ON a.pr_id = p.id WHERE p.fetched_at >= ?"
        )
        .get(todayMidnightUnix);

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
      reportType === "weekly"
        ? `${formatUnixDate(row.period_start)}..${formatUnixDate(row.period_end)}`
        : formatUnixDate(row.period_start);

    console.log(
      `  ${reportType}  #${row.id} ${periodStr} cards=${deliveries.length} deliveries=sent:${sent} failed:${failed} pending:${pending}`
    );

    if (!noDispatch && failed > 0) {
      console.error(`  ERROR: ${failed} delivery(ies) failed`);
    }
  }

  if (mode === "all") {
    console.log("  [SKIPPED] monthly: not implemented");
  }

  // Analysis sample and cost from this run
  const newAnalyses = db
    .query<AnalysisRow, [number]>(
      `SELECT a.id, a.project_id, a.summary, a.significance, a.direction_signal,
              p.title as pr_title, a.input_tokens, a.output_tokens, a.estimated_cost_usd
       FROM analyses a
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

  // Lark message IDs from this run (sent deliveries for expected reports)
  const messageIds: string[] = [];
  if (!noDispatch) {
    for (const reportType of expectedTypes) {
      const row = db
        .query<ReportRow, [string, number]>(
          "SELECT id FROM reports WHERE type = ? AND period_start >= ? ORDER BY period_start DESC LIMIT 1"
        )
        .get(reportType, reportType === "weekly" ? todayMidnightUnix - 6 * 86400 : todayMidnightUnix);

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
  const { mode, noDispatch } = parseOptions(argv);

  const notImplemented = getModeNotImplementedMessage(mode);
  if (notImplemented) {
    console.error(notImplemented);
    return 1;
  }

  validateEnv();
  const db = getDb();

  const maxIdRow = db.query<{ maxId: number }, []>("SELECT COALESCE(MAX(id), 0) as maxId FROM analyses").get()!;
  const maxAnalysisIdBefore = maxIdRow.maxId;

  const reportMode = getPipelineReportMode(mode);
  const stages = getRunStages(noDispatch);

  console.log(`[E2E] Mode: ${mode}${noDispatch ? " (no-dispatch)" : ""}`);
  const stageNames = stages.map((s) => s.name).join(" → ");
  console.log(`[E2E] Stages: ${stageNames}`);

  const start = Date.now();
  const results = await runPipeline(stages, { reportMode });
  const totalMs = Date.now() - start;

  console.log(`\n[E2E] Pipeline complete in ${(totalMs / 1000).toFixed(1)}s`);

  return printPostRunSummary(mode, noDispatch, results, maxAnalysisIdBefore);
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
