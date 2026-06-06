import { getDb } from "../../storage/db";
import type { ProjectAnalysis, GroupedAnalyses } from "./templates/daily-card";
import { buildPrHtmlUrl } from "./templates/daily-card";
import { getBudgetStatus } from "../../utils/budget-tracker";
import { getYesterdayPeriod } from "../../utils/time-window";

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
  project_url: string;
}

export interface DigestPrSummary {
  prNumber: number;
  title: string;
  summary: string;
  significance: "routine" | "notable" | "directional_shift";
  directionSignal: string | null;
  htmlUrl: string;
}

export interface DailyDigest {
  periodStart: number;
  periodEnd: number;
  projects: Array<{
    projectId: string;
    prCount: number;
    notableCount: number;
    directionalShiftCount: number;
    topSignals: string[];
    prs: DigestPrSummary[];
  }>;
  activitySummary: {
    totalPrs: number;
    directionalShiftCount: number;
    notableCount: number;
  };
}

export interface DailyReportData {
  analyses: AnalysisRow[];
  grouped: GroupedAnalyses;
  periodStartUnix: number;
  periodEndUnix: number;
  budgetLine?: string;
  digest: DailyDigest;
}

export function buildDailyReport(timezone: string, now?: Date): DailyReportData {
  const db = getDb();
  const { startUnix: periodStartUnix, endUnix: periodEndUnix } = getYesterdayPeriod(timezone, now);

  const rows = db
    .query<AnalysisRow, [number, number]>(
      `SELECT a.id, a.pr_id, a.project_id, a.summary, a.technical_detail,
              a.direction_signal, a.significance,
              pr.title, pr.pr_number,
              p.url AS project_url
       FROM analyses a
       JOIN (
         SELECT pr_id, MAX(id) AS analysis_id
         FROM analyses
         GROUP BY pr_id
       ) latest ON latest.analysis_id = a.id
       JOIN pull_requests pr ON a.pr_id = pr.id
       JOIN projects p ON p.id = pr.project_id
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

  const budget = getBudgetStatus();
  let budgetLine: string | undefined;
  if (budget.usagePercent > 0.6) {
    const warningMarker = budget.usagePercent > 0.8 ? " ⚠" : "";
    budgetLine = `Budget: $${budget.estimatedCostUSD.toFixed(2)} / $${budget.budgetCapUSD.toFixed(2)} (${(budget.usagePercent * 100).toFixed(0)}%)${warningMarker}`;
  }

  if (rows.length === 0) {
    const digest: DailyDigest = {
      periodStart: periodStartUnix,
      periodEnd: periodEndUnix,
      projects: [],
      activitySummary: { totalPrs: 0, directionalShiftCount: 0, notableCount: 0 },
    };
    return { analyses: [], grouped: [], periodStartUnix, periodEndUnix, budgetLine, digest };
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
          htmlUrl: buildPrHtmlUrl(p.project_url, p.pr_number),
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

  const digest: DailyDigest = {
    periodStart: periodStartUnix,
    periodEnd: periodEndUnix,
    projects: grouped.map((g) => ({
      projectId: g.projectId,
      prCount: g.prCount,
      notableCount: g.notableCount,
      directionalShiftCount: g.directionalShiftCount,
      topSignals: [...new Set(g.prs.map((p) => p.directionSignal).filter((s): s is string => s !== null))],
      prs: g.prs.map((p) => ({
        prNumber: p.prNumber,
        title: p.title,
        summary: p.summary,
        significance: p.significance,
        directionSignal: p.directionSignal,
        htmlUrl: p.htmlUrl,
      })),
    })),
    activitySummary: {
      totalPrs: grouped.reduce((sum, g) => sum + g.prCount, 0),
      directionalShiftCount: grouped.reduce((sum, g) => sum + g.directionalShiftCount, 0),
      notableCount: grouped.reduce((sum, g) => sum + g.notableCount, 0),
    },
  };

  return { analyses: rows, grouped, periodStartUnix, periodEndUnix, budgetLine, digest };
}
