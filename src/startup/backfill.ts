import type { Database } from "bun:sqlite";
import { getSettings } from "../config/settings";
import type { StartupBackfillRangeMode } from "../config/settings";
import { getTrackedProjects } from "../config/projects";
import type { TrackedProject } from "../config/projects";
import { getDb } from "../storage/db";
import {
  enumerateDays,
  getDayPeriod,
  getLocalDateParts,
  getMonthPeriod,
  getPreviousMonthString,
} from "../utils/time-window";
import { runBackfill } from "../../scripts/backfill";
import type { BackfillRunOptions } from "../../scripts/backfill";
import type { BackfillResult } from "../../scripts/backfill";

function formatDay(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export interface StartupBackfillRange {
  since: string;
  until: string;
}

export function getStartupBackfillRange(
  timezone: string,
  now: Date = new Date(),
  mode: StartupBackfillRangeMode = "last7"
): StartupBackfillRange {
  if (mode === "month") {
    const { year, month, day } = getLocalDateParts(timezone, now);
    const monthString = day <= 1 ? getPreviousMonthString(timezone, now) : formatDay(year, month, 1).slice(0, 7);
    const period = getMonthPeriod(timezone, monthString, now);
    return { since: period.startDate, until: period.endDate };
  }

  // last7: the 7 most recent completed local days, ending yesterday.
  const { year, month, day } = getLocalDateParts(timezone, now);
  const yesterday = new Date(Date.UTC(year, month - 1, day - 1));
  const weekStart = new Date(Date.UTC(year, month - 1, day - 7));
  return {
    since: weekStart.toISOString().slice(0, 10),
    until: yesterday.toISOString().slice(0, 10),
  };
}

export interface StartupBackfillInspectionOptions extends StartupBackfillRange {
  timezone: string;
}

export interface StartupBackfillInspection {
  needed: boolean;
  reasons: string[];
}

export function inspectStartupBackfillNeeds(
  db: Database,
  projects: TrackedProject[],
  options: StartupBackfillInspectionOptions
): StartupBackfillInspection {
  const reasons: string[] = [];
  const configuredProjectIds = projects.map((project) => `${project.org}/${project.repo}`);

  for (const id of configuredProjectIds) {
    const row = db.query<{ active: number }, [string]>("SELECT active FROM projects WHERE id = ?").get(id);
    if (!row || row.active !== 1) {
      reasons.push(`missing_repo:${id}`);
    }
  }

  const projectPlaceholders = configuredProjectIds.map(() => "?").join(", ");

  for (const day of enumerateDays(options.since, options.until)) {
    const { startUnix, endUnix } = getDayPeriod(options.timezone, day);
    let actionableIncomplete = 0;
    let terminalIncomplete = 0;
    if (configuredProjectIds.length > 0) {
      const counts = db
        .query<
          { actionable_incomplete: number; terminal_incomplete: number },
          [number, number, ...string[]]
        >(
          `SELECT
             COALESCE(SUM(CASE WHEN analysis_status = 'pending'
                                 OR (analysis_status = 'failed' AND retry_count < 3)
                                THEN 1 ELSE 0 END), 0) AS actionable_incomplete,
             COALESCE(SUM(CASE WHEN analysis_status = 'budget_skipped'
                                 OR (analysis_status = 'failed' AND retry_count >= 3)
                                THEN 1 ELSE 0 END), 0) AS terminal_incomplete
           FROM pull_requests
           WHERE merged_at >= ? AND merged_at <= ?
             AND project_id IN (${projectPlaceholders})`
        )
        .get(startUnix, endUnix, ...configuredProjectIds);
      actionableIncomplete = counts?.actionable_incomplete ?? 0;
      terminalIncomplete = counts?.terminal_incomplete ?? 0;
    }
    const onlyBlockedByTerminalPrs = terminalIncomplete > 0 && actionableIncomplete === 0;

    const report = db
      .query<{ digest_json: string | null }, [number, number]>(
        "SELECT digest_json FROM reports WHERE type = 'daily' AND period_start = ? AND period_end = ? LIMIT 1"
      )
      .get(startUnix, endUnix);

    if (!report) {
      if (!onlyBlockedByTerminalPrs) {
        reasons.push(`missing_digest:${day}`);
      }
    } else if (
      report.digest_json === null &&
      !onlyBlockedByTerminalPrs
    ) {
      reasons.push(`null_digest:${day}`);
    }

    if (actionableIncomplete > 0) {
      reasons.push(`incomplete_prs:${day}:${actionableIncomplete}`);
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
  enabled?: boolean;
  rangeMode?: StartupBackfillRangeMode;
  now?: Date;
  timezone?: string;
  db?: Database;
  getTrackedProjects?: () => TrackedProject[];
  runBackfill?: (
    since: string,
    until: string,
    allowPartial: boolean,
    options: BackfillRunOptions
  ) => Promise<BackfillResult>;
  log?: StartupBackfillLog;
}

async function runProductionBackfill(
  since: string,
  until: string,
  allowPartial: boolean,
  options: BackfillRunOptions
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
  }, options);
}

export async function runStartupBackfillIfNeeded(deps: StartupBackfillDeps = {}): Promise<void> {
  const log = deps.log ?? console;
  const enabled = deps.enabled ?? getSettings().startup?.backfill?.enabled ?? false;
  if (!enabled) {
    log.info("[startup-backfill] Startup backfill disabled (startup.backfill.enabled=false); skipping.");
    return;
  }

  const timezone = deps.timezone ?? getSettings().schedule.timezone;
  const rangeMode = deps.rangeMode ?? getSettings().startup?.backfill?.range ?? "last7";
  const range = getStartupBackfillRange(timezone, deps.now ?? new Date(), rangeMode);
  const db = deps.db ?? getDb();
  const projects = (deps.getTrackedProjects ?? getTrackedProjects)();
  const inspection = inspectStartupBackfillNeeds(db, projects, { timezone, ...range });
  if (!inspection.needed) {
    log.info(`[startup-backfill] No actionable gaps for ${range.since}..${range.until}; skipping.`);
    return;
  }

  log.info(`[startup-backfill] Backfill needed (${rangeMode}) for ${range.since}..${range.until}: ${inspection.reasons.join(", ")}`);

  try {
    // allowPartial: true — a few unreachable/PR-disabled repos must not abort
    // analysis of everything else. Failed projects just make the day partial.
    const result = await (deps.runBackfill ?? runProductionBackfill)(range.since, range.until, true, {
      resetAnalysisStatus: false,
    });
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
