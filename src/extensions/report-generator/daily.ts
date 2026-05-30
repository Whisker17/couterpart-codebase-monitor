import { getDb } from "../../storage/db";
import type { ProjectAnalysis, GroupedAnalyses } from "./templates/daily-card";

interface AnalysisRow {
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

function getTodayStartUtcUnix(): number {
  const now = new Date();
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000);
}

function significanceRank(sig: string): number {
  if (sig === "directional_shift") return 2;
  if (sig === "notable") return 1;
  return 0;
}

export interface DailyReportData {
  analyses: AnalysisRow[];
  grouped: GroupedAnalyses;
  periodStartUnix: number;
  periodEndUnix: number;
}

export function buildDailyReport(): DailyReportData {
  const db = getDb();
  const periodStartUnix = getTodayStartUtcUnix();
  const periodEndUnix = periodStartUnix + 86399; // 23:59:59

  const rows = db
    .query<AnalysisRow, [number]>(
      `SELECT a.id, a.pr_id, a.project_id, a.summary, a.technical_detail,
              a.direction_signal, a.significance,
              pr.title, pr.pr_number
       FROM analyses a
       JOIN pull_requests pr ON a.pr_id = pr.id
       WHERE a.analyzed_at >= ?
       ORDER BY a.project_id, a.significance DESC`
    )
    .all(periodStartUnix);

  if (rows.length === 0) {
    return { analyses: [], grouped: [], periodStartUnix, periodEndUnix };
  }

  const projectMap = new Map<string, AnalysisRow[]>();
  for (const row of rows) {
    const list = projectMap.get(row.project_id) ?? [];
    list.push(row);
    projectMap.set(row.project_id, list);
  }

  const grouped: GroupedAnalyses = Array.from(projectMap.entries()).map(
    ([projectId, prs]) => {
      const directionalShiftCount = prs.filter((p) => p.significance === "directional_shift").length;
      const notableCount = prs.filter((p) => p.significance === "notable").length;
      const topDirectionSignal =
        prs.find((p) => p.significance === "directional_shift")?.direction_signal ??
        prs.find((p) => p.significance === "notable")?.direction_signal ??
        null;

      return {
        projectId,
        prCount: prs.length,
        directionalShiftCount,
        notableCount,
        topDirectionSignal,
        prs: prs.map((p) => ({
          prNumber: p.pr_number,
          title: p.title,
          summary: p.summary,
          technicalDetail: p.technical_detail,
          significance: p.significance,
          directionSignal: p.direction_signal,
        })),
      } satisfies ProjectAnalysis;
    }
  );

  // Sort: directional_shift projects first > notable > routine-only
  grouped.sort((a, b) => {
    const aRank =
      a.directionalShiftCount > 0 ? 2 : a.notableCount > 0 ? 1 : 0;
    const bRank =
      b.directionalShiftCount > 0 ? 2 : b.notableCount > 0 ? 1 : 0;
    return bRank - aRank;
  });

  return { analyses: rows, grouped, periodStartUnix, periodEndUnix };
}
