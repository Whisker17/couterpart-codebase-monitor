import { getDb } from "../../storage/db";
import { getSettings } from "../../config/settings";
import { getTrackedProjects } from "../../config/projects";
import { getDayPeriod } from "../../utils/time-window";
import { flagString, type GlobalFlags, type FlagValue } from "../args";
import { printJson, printRows } from "../output";

interface ProjectRow {
  id: string;
  org: string;
  repo: string;
  url: string;
  active: number | null;
  source: string | null;
  last_synced_at: number | null;
}

export async function projectListCommand(
  flags: Record<string, FlagValue>,
  global: GlobalFlags
): Promise<number> {
  const db = getDb();
  const settings = getSettings();
  const timezone = global.timezone ?? settings.schedule.timezone;
  let rows: ProjectRow[];
  try {
    rows = db
      .query<ProjectRow, []>(
        "SELECT id, org, repo, url, active, source, last_synced_at FROM projects ORDER BY id"
      )
      .all();
  } catch {
    rows = getTrackedProjects().map((p) => ({
      id: `${p.org}/${p.repo}`,
      org: p.org,
      repo: p.repo,
      url: p.url,
      active: 1,
      source: "config",
      last_synced_at: null,
    }));
  }

  const date = flagString(flags, "date");
  let payload: Array<Record<string, unknown>> = rows.map((r) => ({
    id: r.id,
    org: r.org,
    repo: r.repo,
    active: r.active ?? 1,
    source: r.source ?? "unknown",
    lastSyncedAt: r.last_synced_at,
  }));

  if (date) {
    const period = getDayPeriod(timezone, date);
    payload = payload.map((row) => {
      const counts = db
        .query<{ total: number; complete: number; failed: number; pending: number; budget_skipped: number }, [string, number, number]>(
          `SELECT COUNT(*) as total,
                  SUM(CASE WHEN analysis_status = 'complete' THEN 1 ELSE 0 END) as complete,
                  SUM(CASE WHEN analysis_status = 'failed' THEN 1 ELSE 0 END) as failed,
                  SUM(CASE WHEN analysis_status = 'pending' THEN 1 ELSE 0 END) as pending,
                  SUM(CASE WHEN analysis_status = 'budget_skipped' THEN 1 ELSE 0 END) as budget_skipped
           FROM pull_requests
           WHERE project_id = ? AND merged_at BETWEEN ? AND ?`
        )
        .get(String(row.id), period.startUnix, period.endUnix);
      return {
        ...row,
        date,
        prCount: counts?.total ?? 0,
        complete: counts?.complete ?? 0,
        failed: counts?.failed ?? 0,
        pending: counts?.pending ?? 0,
        budgetSkipped: counts?.budget_skipped ?? 0,
      };
    });
  }

  if (global.json) printJson(payload);
  else printRows(payload);
  return 0;
}
