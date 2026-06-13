/**
 * Impact check backtest — replays gate logic against the last N days of analyses
 * to calibrate maxChecksPerDay and monthlySubCap before enabling impactCheck.enabled.
 *
 * No LLM calls, no writes to impact_checks, no Lark messages.
 *
 * Usage:
 *   bun run scripts/impact-check-backtest.ts [--days N]   (default: 30)
 */
import { Database } from "bun:sqlite";
import { getSettings } from "../src/config/settings";
import { getDb, closeDb } from "../src/storage/db";
import { getMantleConfig } from "../src/config/projects";
import type { MantleConfig, MantleTarget, CounterpartRelationship } from "../src/config/projects";
import type { ImpactCheckConfig } from "../src/config/settings";
import { shouldEnqueue } from "../src/extensions/impact-checker/index";
import type { GateInput } from "../src/extensions/impact-checker/index";

const TIMEZONE = "Asia/Shanghai";

export interface BacktestDeps {
  db: Database;
  mantleConfig: MantleConfig;
  impactCheckConfig: ImpactCheckConfig;
  timezone: string;
}

export interface DailyCount {
  date: string;
  count: number;
}

export interface BacktestResult {
  dailyCounts: DailyCount[];
  significanceDist: { routine: number; notable: number; directional_shift: number; null: number };
  overQuotaDays: number;
  daysWithCandidates: number;
  totalCandidates: number;
}

type AnalysisRow = {
  analysis_id: number;
  pr_id: number;
  project_id: string;
  significance: string | null;
  downstream_impact_hint: string | null;
  merged_at: number | null;
  analyzed_at: number;
};

function toDateStr(timezone: string, unixSecs: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(unixSecs * 1000));
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function runBacktest(lookbackDays: number, deps: BacktestDeps): BacktestResult {
  const { db, mantleConfig, impactCheckConfig, timezone } = deps;
  const cutoff = Math.floor(Date.now() / 1000) - lookbackDays * 86400;

  const rows = db
    .query<AnalysisRow, [number]>(
      `SELECT a.id AS analysis_id, a.pr_id, a.project_id, a.significance,
              a.downstream_impact_hint, pr.merged_at, a.analyzed_at
       FROM analyses a
       JOIN pull_requests pr ON a.pr_id = pr.id
       WHERE a.analyzed_at >= ?`
    )
    .all(cutoff);

  // Build source → [(rel, target)] lookup; skip "manual" relationships
  const targetById = new Map<string, MantleTarget>();
  for (const t of mantleConfig.mantleTargets) {
    targetById.set(t.projectId, t);
  }

  const relsBySource = new Map<string, Array<{ rel: CounterpartRelationship; target: MantleTarget }>>();
  for (const rel of mantleConfig.counterpartRelationships) {
    if (rel.relationship === "manual") continue;
    for (const targetId of rel.targets) {
      const target = targetById.get(targetId);
      if (!target) continue;
      const list = relsBySource.get(rel.source) ?? [];
      list.push({ rel, target });
      relsBySource.set(rel.source, list);
    }
  }

  const dailyMap = new Map<string, number>();
  const sigDist: BacktestResult["significanceDist"] = {
    routine: 0,
    notable: 0,
    directional_shift: 0,
    null: 0,
  };

  for (const row of rows) {
    const pairs = relsBySource.get(row.project_id);
    if (!pairs || pairs.length === 0) continue;

    const input: GateInput = {
      prId: row.pr_id,
      analysisId: row.analysis_id,
      projectId: row.project_id,
      significance: row.significance as "routine" | "notable" | "directional_shift" | null,
      downstreamImpactHint: row.downstream_impact_hint as "none" | "possible" | "likely" | null,
      mergedAt: row.merged_at,
    };

    if (!shouldEnqueue(input, impactCheckConfig.maxAgeDays)) continue;

    const dateStr = toDateStr(timezone, row.analyzed_at);
    dailyMap.set(dateStr, (dailyMap.get(dateStr) ?? 0) + pairs.length);

    const sig = (row.significance ?? "null") as keyof BacktestResult["significanceDist"];
    if (sig in sigDist) {
      sigDist[sig] += pairs.length;
    }
  }

  const dailyCounts = [...dailyMap.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const daysWithCandidates = dailyCounts.length;
  const overQuotaDays = dailyCounts.filter(
    (d) => d.count > impactCheckConfig.maxChecksPerDay
  ).length;
  const totalCandidates = dailyCounts.reduce((s, d) => s + d.count, 0);

  return { dailyCounts, significanceDist: sigDist, overQuotaDays, daysWithCandidates, totalCandidates };
}

function printResults(
  lookbackDays: number,
  result: BacktestResult,
  maxChecksPerDay: number
): void {
  console.log(
    `\n[Backtest] Impact Check Calibration (lookback: ${lookbackDays} days, timezone: ${TIMEZONE})`
  );
  console.log(
    `[Backtest] Total candidates: ${result.totalCandidates} across ` +
      `${result.daysWithCandidates} day(s) with activity\n`
  );

  console.log("=== Daily Candidate Distribution ===");
  if (result.dailyCounts.length === 0) {
    console.log("  (no candidates in window)");
  } else {
    console.log("  Date          Candidates");
    for (const { date, count } of result.dailyCounts) {
      const flag = count > maxChecksPerDay ? `  OVER (max: ${maxChecksPerDay})` : "";
      console.log(`  ${date}      ${String(count).padStart(4)}${flag}`);
    }
  }

  console.log("\n=== Significance Distribution (passing candidates) ===");
  for (const [sig, cnt] of Object.entries(result.significanceDist)) {
    console.log(`  ${sig.padEnd(22)} ${String(cnt).padStart(4)}`);
  }

  console.log(`\n=== Quota Analysis (maxChecksPerDay: ${maxChecksPerDay}) ===`);
  console.log(`  Days with candidates:      ${result.daysWithCandidates}`);
  const pct =
    result.daysWithCandidates > 0
      ? ((result.overQuotaDays / result.daysWithCandidates) * 100).toFixed(1)
      : "N/A";
  console.log(
    `  Days over quota (>${maxChecksPerDay}):     ${result.overQuotaDays} (${pct}%)`
  );
  console.log("");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const daysIdx = args.indexOf("--days");
  const lookbackDays = daysIdx !== -1 ? parseInt(args[daysIdx + 1] ?? "30", 10) : 30;

  if (isNaN(lookbackDays) || lookbackDays < 1) {
    console.error("[Backtest] --days must be a positive integer");
    process.exit(1);
  }

  const settings = getSettings();
  const db = getDb();
  const mantleConfig = getMantleConfig();
  const impactCheckConfig = settings.impactCheck!;

  try {
    const result = runBacktest(lookbackDays, {
      db,
      mantleConfig,
      impactCheckConfig,
      timezone: TIMEZONE,
    });
    printResults(lookbackDays, result, impactCheckConfig.maxChecksPerDay);
  } finally {
    closeDb();
  }
}
