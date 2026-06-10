import { closeDb } from "../../storage/db";
import { runBackfill } from "../../../scripts/backfill";
import { flagBool, flagString, type FlagValue, type GlobalFlags } from "../args";

export interface BackfillCommandOptions {
  since: string;
  until: string;
  allowPartial: boolean;
  timezone: string;
}

function validateDay(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} is required`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid ${flag} "${value}". Expected YYYY-MM-DD.`);
  }
  return value;
}

export function resolveBackfillOptions(
  flags: Record<string, FlagValue>,
  global: GlobalFlags,
  defaultTimezone: string
): BackfillCommandOptions {
  const since = validateDay(flagString(flags, "since"), "--since");
  const until = validateDay(flagString(flags, "until"), "--until");
  if (since > until) throw new Error("--since must not be after --until");
  return {
    since,
    until,
    allowPartial: flagBool(flags, "allow-partial"),
    timezone: global.timezone ?? defaultTimezone,
  };
}

export async function backfillCommand(
  flags: Record<string, FlagValue>,
  global: GlobalFlags = { json: false, verbose: false }
): Promise<number> {
  const { getSettings } = await import("../../config/settings");
  const { getDb } = await import("../../storage/db");
  const { execute: collectExecute } = await import("../../pipeline/stages/collect");
  const { execute: analyzeExecute } = await import("../../pipeline/stages/analyze");
  const { buildDailyReportForPeriod } = await import("../../extensions/report-generator/daily");
  const { generateDailyPromptReportForPeriod } = await import("../../extensions/report-generator/daily-prompt-report");
  const { buildDailyPromptCard } = await import("../../extensions/report-generator/templates/daily-prompt-card");
  const { writeReportFile } = await import("../../extensions/report-generator/file-writer");
  const { getTrackedProjects } = await import("../../config/projects");
  const { fetchMergedPRs, fetchRepoMetadata, fetchPRStats } = await import("../../extensions/github-collector/fetcher");
  const { fetchAndStoreDiff } = await import("../../extensions/github-collector/diff-fetcher");
  const options = resolveBackfillOptions(flags, global, getSettings().schedule.timezone);

  const result = await runBackfill(options.since, options.until, options.allowPartial, {
    timezone: options.timezone,
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

  console.log(`[backfill] processed ${result.days.length} day(s)`);
  closeDb();
  return result.anySkipped ? 1 : 0;
}
