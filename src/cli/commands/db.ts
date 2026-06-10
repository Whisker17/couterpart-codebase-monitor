import { existsSync, readFileSync } from "node:fs";
import { getDb } from "../../storage/db";
import { getSettings } from "../../config/settings";
import { getDayPeriod, getWeekPeriod, getYesterdayPeriod } from "../../utils/time-window";
import { flagString, type GlobalFlags, type FlagValue } from "../args";
import { printJson, printRows } from "../output";

function formatUtc(unix: number): string {
  return new Date(unix * 1000).toISOString();
}

function formatUnixDate(unix: number | null, timezone: string): string | null {
  if (unix === null) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(unix * 1000));
}

function dayWindow(flags: Record<string, FlagValue>, timezone: string): { startUnix: number; endUnix: number; label: string } {
  const date = flagString(flags, "date");
  if (date) {
    const period = getDayPeriod(timezone, date);
    return { ...period, label: date };
  }
  const period = getYesterdayPeriod(timezone);
  const label = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(period.startUnix * 1000));
  return { ...period, label };
}

export interface PrCountRow {
  project_id: string;
  pr_count: number;
  analyzed: number;
  failed: number;
  pending: number;
  budget_skipped: number;
  last_pr_at: number | null;
  last_pr_date: string | null;
  last_collected_at: number | null;
  last_collected_date: string | null;
}

interface InactiveProjectRow {
  id: string;
  inactiveReason: string | null;
}

export function queryPrCounts(
  db: ReturnType<typeof getDb>,
  startUnix: number,
  endUnix: number,
  timezone: string
): PrCountRow[] {
  const raw = db
    .query<{
      project_id: string;
      last_pr_at: number | null;
      last_collected_at: number | null;
      pr_count: number;
      analyzed: number;
      failed: number;
      pending: number;
      budget_skipped: number;
    }, [number, number]>(
      `SELECT p.id AS project_id,
              p.last_synced_at AS last_pr_at,
              p.last_collected_at,
              COUNT(pr.id) AS pr_count,
              SUM(CASE WHEN pr.analysis_status = 'complete' THEN 1 ELSE 0 END) AS analyzed,
              SUM(CASE WHEN pr.analysis_status = 'failed' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN pr.analysis_status = 'pending' THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN pr.analysis_status = 'budget_skipped' THEN 1 ELSE 0 END) AS budget_skipped
       FROM projects p
       LEFT JOIN pull_requests pr
         ON pr.project_id = p.id
         AND pr.merged_at BETWEEN ? AND ?
       WHERE p.active = 1
       GROUP BY p.id
       ORDER BY p.id`
    )
    .all(startUnix, endUnix);

  return raw.map((r) => ({
    ...r,
    last_pr_date: formatUnixDate(r.last_pr_at, timezone),
    last_collected_date: formatUnixDate(r.last_collected_at, timezone),
  }));
}

export function queryInactiveProjects(db: ReturnType<typeof getDb>): InactiveProjectRow[] {
  return db
    .query<{ id: string; inactive_reason: string | null }, []>(
      `SELECT id, inactive_reason FROM projects WHERE active = 0 ORDER BY id`
    )
    .all()
    .map((r) => ({ id: r.id, inactiveReason: r.inactive_reason }));
}

export async function dbStatusCommand(
  flags: Record<string, FlagValue>,
  global: GlobalFlags
): Promise<number> {
  const db = getDb();
  const settings = getSettings();
  const timezone = global.timezone ?? settings.schedule.timezone;
  const daily = dayWindow(flags, timezone);
  const weekAnchor = flagString(flags, "week-date");
  const weekly = getWeekPeriod(
    timezone,
    weekAnchor ? new Date(`${weekAnchor}T12:00:00Z`) : new Date()
  );

  const health = existsSync("data/health.json")
    ? JSON.parse(readFileSync("data/health.json", "utf-8")) as unknown
    : null;
  const prCounts = queryPrCounts(db, daily.startUnix, daily.endUnix, timezone);
  const inactiveProjects = queryInactiveProjects(db);
  const analysisStatus = db
    .query<{ analysis_status: string; count: number }, [number, number]>(
      `SELECT analysis_status, COUNT(*) as count
       FROM pull_requests
       WHERE merged_at BETWEEN ? AND ?
       GROUP BY analysis_status
       ORDER BY analysis_status`
    )
    .all(daily.startUnix, daily.endUnix);
  const diffStatus = db
    .query<{ diff_status: string; count: number }, [number, number]>(
      `SELECT diff_status, COUNT(*) as count
       FROM pull_requests
       WHERE merged_at BETWEEN ? AND ?
       GROUP BY diff_status
       ORDER BY diff_status`
    )
    .all(daily.startUnix, daily.endUnix);
  const significance = db
    .query<{ significance: string | null; count: number }, [number, number]>(
      `SELECT a.significance, COUNT(*) as count
       FROM analyses a
       JOIN (
         SELECT pr_id, MAX(id) AS analysis_id
         FROM analyses
         GROUP BY pr_id
       ) latest ON latest.analysis_id = a.id
       JOIN pull_requests p ON a.pr_id = p.id
       WHERE p.merged_at BETWEEN ? AND ?
       GROUP BY a.significance
       ORDER BY CASE a.significance
         WHEN 'directional_shift' THEN 0
         WHEN 'notable' THEN 1
         WHEN 'routine' THEN 2
         ELSE 3
       END`
    )
    .all(daily.startUnix, daily.endUnix);
  const inputQuality = db
    .query<{ input_quality: string; count: number; truncated_count: number | null }, [number, number]>(
      `SELECT ai.input_quality,
              COUNT(*) as count,
              SUM(CASE WHEN ai.diff_truncated = 1 THEN 1 ELSE 0 END) as truncated_count
       FROM analysis_inputs ai
       JOIN analyses a ON ai.analysis_id = a.id
       JOIN (
         SELECT pr_id, MAX(id) AS analysis_id
         FROM analyses
         GROUP BY pr_id
       ) latest ON latest.analysis_id = a.id
       JOIN pull_requests p ON a.pr_id = p.id
       WHERE p.merged_at BETWEEN ? AND ?
       GROUP BY ai.input_quality
       ORDER BY ai.input_quality`
    )
    .all(daily.startUnix, daily.endUnix);
  const digestCoverage = db
    .query<{ type: string; present: number; null_digest: number; total: number }, [number, number]>(
      `SELECT type,
              SUM(CASE WHEN digest_json IS NOT NULL THEN 1 ELSE 0 END) as present,
              SUM(CASE WHEN digest_json IS NULL THEN 1 ELSE 0 END) as null_digest,
              COUNT(*) as total
       FROM reports
       WHERE period_start >= ? AND period_end <= ?
       GROUP BY type
       ORDER BY type`
    )
    .all(weekly.startUnix, weekly.endUnix);
  const recentReports = db
    .query<{ id: number; type: string; period_start: number; period_end: number; sent_at: number | null }, []>(
      "SELECT id, type, period_start, period_end, sent_at FROM reports ORDER BY created_at DESC LIMIT 10"
    )
    .all();
  const deliveries = db
    .query<{ report_id: number; card_index: number; status: string; lark_message_id: string | null }, []>(
      `SELECT report_id, card_index, status, lark_message_id
       FROM report_deliveries
       ORDER BY id DESC
       LIMIT 10`
    )
    .all();
  const cost = db
    .query<{ analyses: number; input_tokens: number | null; output_tokens: number | null; total_cost: number | null }, []>(
      `SELECT COUNT(*) as analyses,
              SUM(input_tokens) as input_tokens,
              SUM(output_tokens) as output_tokens,
              SUM(estimated_cost_usd) as total_cost
       FROM analyses
       WHERE analyzed_at >= unixepoch('now', 'start of month')`
    )
    .get();

  const payload = {
    timezone,
    health,
    windows: {
      daily: {
        label: daily.label,
        startUnix: daily.startUnix,
        endUnix: daily.endUnix,
        startUtc: formatUtc(daily.startUnix),
        endUtc: formatUtc(daily.endUnix),
      },
      weekly: {
        startUnix: weekly.startUnix,
        endUnix: weekly.endUnix,
        startUtc: formatUtc(weekly.startUnix),
        endUtc: formatUtc(weekly.endUnix),
      },
    },
    prCounts,
    inactiveProjects,
    analysisStatus,
    diffStatus,
    significance,
    inputQuality,
    digestCoverage,
    recentReports,
    deliveries,
    cost,
  };

  if (global.json) {
    printJson(payload);
  } else {
    console.log(`Timezone: ${timezone}`);
    console.log(`Daily: ${payload.windows.daily.label} ${payload.windows.daily.startUtc}..${payload.windows.daily.endUtc}`);
    console.log(`Weekly: ${payload.windows.weekly.startUtc}..${payload.windows.weekly.endUtc}`);
    console.log("\nPR counts:");
    printRows(
      prCounts.map((r) => ({
        project_id: r.project_id,
        pr_count: r.pr_count,
        analyzed: r.analyzed,
        failed: r.failed,
        pending: r.pending,
        budget_skipped: r.budget_skipped,
        last_pr_at: r.last_pr_date ?? "N/A",
        collected: r.last_collected_date ?? "N/A",
      })) as unknown as Array<Record<string, unknown>>
    );
    if (inactiveProjects.length > 0) {
      console.log("\nInactive projects:");
      for (const p of inactiveProjects) {
        console.log(`  ${p.id} — ${p.inactiveReason ?? "unknown"}`);
      }
    }
    console.log("\nAnalysis status:");
    printRows(analysisStatus as unknown as Array<Record<string, unknown>>);
    console.log("\nDiff status:");
    printRows(diffStatus as unknown as Array<Record<string, unknown>>);
    console.log("\nSignificance:");
    printRows(significance as unknown as Array<Record<string, unknown>>);
    console.log("\nAnalysis input quality:");
    printRows(inputQuality as unknown as Array<Record<string, unknown>>);
    console.log("\nDigest coverage in weekly window:");
    printRows(digestCoverage as unknown as Array<Record<string, unknown>>);
    console.log("\nRecent reports:");
    printRows(recentReports as unknown as Array<Record<string, unknown>>);
    console.log("\nRecent deliveries:");
    printRows(deliveries as unknown as Array<Record<string, unknown>>);
    console.log("\nCost:");
    printRows([cost ?? {}] as Array<Record<string, unknown>>);
  }
  return 0;
}
