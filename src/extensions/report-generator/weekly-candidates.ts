import { getDb } from "../../storage/db";
import { getMantleConfig, getTrackedProjects } from "../../config/projects";
import { getWeekPeriod } from "../../utils/time-window";
import { scoreCandidate, type WeeklyCandidate } from "./weekly-relevance";

interface CandidateAnalysisRow {
  project_id: string;
  pr_number: number;
  title: string;
  summary: string;
  significance: "routine" | "notable" | "directional_shift";
  categories: string | null;
  direction_signal: string | null;
}

export function selectWeeklyCandidates(timezone: string, now?: Date): WeeklyCandidate[] {
  const db = getDb();
  const { startUnix: periodStartUnix, endUnix: periodEndUnix } = getWeekPeriod(timezone, now);

  const rows = db
    .query<CandidateAnalysisRow, [number, number]>(
      `SELECT a.project_id, pr.pr_number, pr.title, a.summary,
              a.significance, a.categories, a.direction_signal
       FROM analyses a
       JOIN (
         SELECT pr_id, MAX(id) AS analysis_id
         FROM analyses
         GROUP BY pr_id
       ) latest ON latest.analysis_id = a.id
       JOIN pull_requests pr ON a.pr_id = pr.id
       WHERE pr.merged_at >= ? AND pr.merged_at <= ?`
    )
    .all(periodStartUnix, periodEndUnix);

  if (rows.length === 0) return [];

  const mantleConfig = getMantleConfig();
  const trackedProjects = getTrackedProjects();

  const routineCountByProject = new Map<string, number>();
  for (const row of rows) {
    if (row.significance === "routine") {
      routineCountByProject.set(
        row.project_id,
        (routineCountByProject.get(row.project_id) ?? 0) + 1
      );
    }
  }

  const candidates: WeeklyCandidate[] = [];

  for (const row of rows) {
    let categories: string[] = [];
    if (row.categories) {
      try {
        categories = JSON.parse(row.categories) as string[];
      } catch {
        categories = [];
      }
    }
    const sourceTags =
      trackedProjects.find((p) => `${p.org}/${p.repo}` === row.project_id)
        ?.tags ?? [];
    const isPartOfPattern =
      row.significance === "routine" &&
      (routineCountByProject.get(row.project_id) ?? 0) >= 3;

    const candidate = scoreCandidate(
      {
        sourceProjectId: row.project_id,
        prNumber: row.pr_number,
        title: row.title,
        summary: row.summary,
        significance: row.significance,
        categories,
        directionSignal: row.direction_signal,
        isPartOfPattern,
      },
      mantleConfig,
      sourceTags
    );

    if (candidate.mantleRelevanceScore > 0) {
      candidates.push(candidate);
    }
  }

  candidates.sort((a, b) => b.mantleRelevanceScore - a.mantleRelevanceScore);

  return candidates;
}
