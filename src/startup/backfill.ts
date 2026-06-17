import type { Database } from "bun:sqlite";
import { getSettings } from "../config/settings";
import { getTrackedProjects } from "../config/projects";
import type { TrackedProject } from "../config/projects";
import { getDb } from "../storage/db";
import { getDayPeriod } from "../utils/time-window";
import { runBackfill } from "../../scripts/backfill";
import type { BackfillResult } from "../../scripts/backfill";

function getLocalDateParts(timezone: string, date: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  const get = (type: string): number => parseInt(parts.find((p) => p.type === type)!.value, 10);
  return { year: get("year"), month: get("month"), day: get("day") };
}

function formatDay(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export interface StartupBackfillRange {
  since: string;
  until: string;
}

export function getStartupBackfillRange(
  timezone: string,
  now: Date = new Date()
): StartupBackfillRange | null {
  const { year, month, day } = getLocalDateParts(timezone, now);
  if (day <= 1) return null;
  return {
    since: formatDay(year, month, 1),
    until: formatDay(year, month, day - 1),
  };
}

export interface StartupBackfillInspectionOptions extends StartupBackfillRange {
  timezone: string;
}

export interface StartupBackfillInspection {
  needed: boolean;
  reasons: string[];
}

function enumerateDays(since: string, until: string): string[] {
  const days: string[] = [];
  const current = new Date(`${since}T00:00:00Z`);
  const end = new Date(`${until}T00:00:00Z`);
  while (current <= end) {
    days.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return days;
}

export function inspectStartupBackfillNeeds(
  db: Database,
  projects: TrackedProject[],
  options: StartupBackfillInspectionOptions
): StartupBackfillInspection {
  const reasons: string[] = [];

  for (const project of projects) {
    const id = `${project.org}/${project.repo}`;
    const row = db.query<{ active: number }, [string]>("SELECT active FROM projects WHERE id = ?").get(id);
    if (!row || row.active !== 1) {
      reasons.push(`missing_repo:${id}`);
    }
  }

  for (const day of enumerateDays(options.since, options.until)) {
    const { startUnix, endUnix } = getDayPeriod(options.timezone, day);
    const report = db
      .query<{ digest_json: string | null }, [number, number]>(
        "SELECT digest_json FROM reports WHERE type = 'daily' AND period_start = ? AND period_end = ? LIMIT 1"
      )
      .get(startUnix, endUnix);

    if (!report) {
      reasons.push(`missing_digest:${day}`);
    } else if (report.digest_json === null) {
      reasons.push(`null_digest:${day}`);
    }

    const incomplete =
      db
        .query<{ count: number }, [number, number]>(
          `SELECT COUNT(*) AS count
           FROM pull_requests
           WHERE merged_at >= ? AND merged_at <= ?
             AND analysis_status != 'complete'`
        )
        .get(startUnix, endUnix)?.count ?? 0;
    if (incomplete > 0) {
      reasons.push(`incomplete_prs:${day}:${incomplete}`);
    }
  }

  return { needed: reasons.length > 0, reasons };
}

export interface StartupBackfillLog {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface StartupBackfillDeps {
  now?: Date;
  timezone?: string;
  db?: Database;
  getTrackedProjects?: () => TrackedProject[];
  runBackfill?: (since: string, until: string, allowPartial: boolean) => Promise<BackfillResult>;
  log?: StartupBackfillLog;
}

async function runProductionBackfill(
  since: string,
  until: string,
  allowPartial: boolean
): Promise<BackfillResult> {
  const { execute: collectExecute } = await import("../pipeline/stages/collect");
  const { execute: analyzeExecute } = await import("../pipeline/stages/analyze");
  const { buildDailyReportForPeriod } = await import("../extensions/report-generator/daily");
  const { generateDailyPromptReportForPeriod } = await import(
    "../extensions/report-generator/daily-prompt-report"
  );
  const { buildDailyPromptCard } = await import(
    "../extensions/report-generator/templates/daily-prompt-card"
  );
  const { writeReportFile } = await import("../extensions/report-generator/file-writer");
  const { fetchMergedPRs, fetchRepoMetadata, fetchPRStats } = await import(
    "../extensions/github-collector/fetcher"
  );
  const { fetchAndStoreDiff } = await import("../extensions/github-collector/diff-fetcher");

  return runBackfill(since, until, allowPartial, {
    timezone: getSettings().schedule.timezone,
    db: getDb(),
    collectExecute,
    analyzeExecute,
    collectDeps: { fetchMergedPRs, fetchRepoMetadata, fetchPRStats, fetchAndStoreDiff },
    getTrackedProjects,
    buildDailyReportForPeriod,
    generateDailyPromptReportForPeriod,
    buildDailyPromptCard,
    writeReportFile,
  });
}

export async function runStartupBackfillIfNeeded(deps: StartupBackfillDeps = {}): Promise<void> {
  const log = deps.log ?? console;
  const timezone = deps.timezone ?? getSettings().schedule.timezone;
  const range = getStartupBackfillRange(timezone, deps.now ?? new Date());
  if (!range) {
    log.info("[startup-backfill] No completed local days in current month; skipping.");
    return;
  }

  const db = deps.db ?? getDb();
  const projects = (deps.getTrackedProjects ?? getTrackedProjects)();
  const inspection = inspectStartupBackfillNeeds(db, projects, { timezone, ...range });
  if (!inspection.needed) {
    log.info(`[startup-backfill] Month-to-date data complete (${range.since}..${range.until}); skipping.`);
    return;
  }

  log.info(`[startup-backfill] Backfill needed for ${range.since}..${range.until}: ${inspection.reasons.join(", ")}`);

  try {
    const result = await (deps.runBackfill ?? runProductionBackfill)(range.since, range.until, false);
    if (result.anySkipped) {
      log.warn("[startup-backfill] Backfill completed with skipped days; startup will continue.");
    } else {
      log.info(`[startup-backfill] Backfill completed (${result.days.length} day(s)).`);
    }
  } catch (err) {
    log.error(
      `[startup-backfill] Backfill failed; startup will continue: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
