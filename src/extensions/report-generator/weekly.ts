import { getDb } from "../../storage/db";
import { getWeekPeriod } from "../../utils/time-window";

interface WeeklyAnalysisRow {
  id: number;
  pr_id: number;
  project_id: string;
  summary: string;
  technical_detail: string | null;
  direction_signal: string | null;
  significance: "routine" | "notable" | "directional_shift";
  title: string;
  pr_number: number;
}

export interface WeeklyProjectSummary {
  projectId: string;
  prCount: number;
  notableCount: number;
  directionalShiftCount: number;
  highlights: Array<{
    prNumber: number;
    title: string;
    summary: string;
    significance: "routine" | "notable" | "directional_shift";
    directionSignal: string | null;
  }>;
}

export interface WeeklyDirectionChange {
  projectId: string;
  prCount: number;
  signals: string[];
}

export interface WeeklyReportData {
  directionChanges: WeeklyDirectionChange[];
  activitySummary: {
    totalPrs: number;
    directionalShiftCount: number;
    notableCount: number;
    projectCount: number;
  };
  projectHighlights: WeeklyProjectSummary[];
  periodStartUnix: number;
  periodEndUnix: number;
}

export function buildWeeklyReport(timezone: string, now?: Date): WeeklyReportData {
  const db = getDb();
  const { startUnix: periodStartUnix, endUnix: periodEndUnix } = getWeekPeriod(timezone, now);

  const rows = db
    .query<WeeklyAnalysisRow, [number, number]>(
      `SELECT a.id, a.pr_id, a.project_id, a.summary, a.technical_detail,
              a.direction_signal, a.significance,
              pr.title, pr.pr_number
       FROM analyses a
       JOIN pull_requests pr ON a.pr_id = pr.id
       WHERE pr.merged_at >= ? AND pr.merged_at <= ?
       ORDER BY a.project_id,
                CASE a.significance
                  WHEN 'directional_shift' THEN 2
                  WHEN 'notable' THEN 1
                  ELSE 0
                END DESC,
                pr.merged_at DESC`
    )
    .all(periodStartUnix, periodEndUnix);

  if (rows.length === 0) {
    return {
      directionChanges: [],
      activitySummary: { totalPrs: 0, directionalShiftCount: 0, notableCount: 0, projectCount: 0 },
      projectHighlights: [],
      periodStartUnix,
      periodEndUnix,
    };
  }

  const projectMap = new Map<string, WeeklyAnalysisRow[]>();
  for (const row of rows) {
    const list = projectMap.get(row.project_id) ?? [];
    list.push(row);
    projectMap.set(row.project_id, list);
  }

  let totalDirectionalShifts = 0;
  let totalNotable = 0;
  const directionChanges: WeeklyDirectionChange[] = [];
  const projectHighlights: WeeklyProjectSummary[] = [];

  for (const [projectId, prs] of projectMap.entries()) {
    const directionalPrs = prs.filter((p) => p.significance === "directional_shift");
    const notablePrs = prs.filter((p) => p.significance === "notable");

    totalDirectionalShifts += directionalPrs.length;
    totalNotable += notablePrs.length;

    if (directionalPrs.length > 0) {
      const signals = directionalPrs
        .map((p) => p.direction_signal)
        .filter((s): s is string => s !== null);
      directionChanges.push({ projectId, prCount: directionalPrs.length, signals });
    }

    const highlights = prs.slice(0, 2).map((p) => ({
      prNumber: p.pr_number,
      title: p.title,
      summary: p.summary,
      significance: p.significance,
      directionSignal: p.direction_signal,
    }));

    projectHighlights.push({
      projectId,
      prCount: prs.length,
      notableCount: notablePrs.length,
      directionalShiftCount: directionalPrs.length,
      highlights,
    });
  }

  // Sort direction changes: most PRs first
  directionChanges.sort((a, b) => b.prCount - a.prCount);

  // Sort highlights: directional_shift projects first, then notable, then routine-only
  projectHighlights.sort((a, b) => {
    const aRank = a.directionalShiftCount > 0 ? 2 : a.notableCount > 0 ? 1 : 0;
    const bRank = b.directionalShiftCount > 0 ? 2 : b.notableCount > 0 ? 1 : 0;
    return bRank - aRank;
  });

  return {
    directionChanges,
    activitySummary: {
      totalPrs: rows.length,
      directionalShiftCount: totalDirectionalShifts,
      notableCount: totalNotable,
      projectCount: projectMap.size,
    },
    projectHighlights,
    periodStartUnix,
    periodEndUnix,
  };
}
