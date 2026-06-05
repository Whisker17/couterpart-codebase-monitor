import { getDb } from "../../storage/db";
import { buildPrHtmlUrl } from "./templates/daily-card";
import { getWeekPeriod } from "../../utils/time-window";
import type { DailyDigest } from "./daily";
import { getMantleConfig, getTrackedProjects } from "../../config/projects";
import { scoreCandidate } from "./weekly-relevance";
import type { WeeklyCandidate } from "./weekly-relevance";

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
  project_url: string;
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
    htmlUrl: string;
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

interface DigestRow {
  digest_json: string | null;
  period_start: number;
  period_end: number;
}

interface AccProject {
  prCount: number;
  notableCount: number;
  directionalShiftCount: number;
  signals: Set<string>;
  highlights: WeeklyProjectSummary["highlights"];
}

function signRank(s: "routine" | "notable" | "directional_shift"): number {
  return s === "directional_shift" ? 2 : s === "notable" ? 1 : 0;
}

function queryWeeklyFromAnalyses(
  db: ReturnType<typeof getDb>,
  periodStartUnix: number,
  periodEndUnix: number
): WeeklyReportData {
  const rows = db
    .query<WeeklyAnalysisRow, [number, number]>(
      `SELECT a.id, a.pr_id, a.project_id, a.summary, a.technical_detail,
              a.direction_signal, a.significance,
              pr.title, pr.pr_number,
              p.url AS project_url
       FROM analyses a
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
      htmlUrl: buildPrHtmlUrl(p.project_url, p.pr_number),
    }));

    projectHighlights.push({
      projectId,
      prCount: prs.length,
      notableCount: notablePrs.length,
      directionalShiftCount: directionalPrs.length,
      highlights,
    });
  }

  directionChanges.sort((a, b) => b.prCount - a.prCount);

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

// Exported for testing. Fills in synthetic null entries for daily windows with no reports row.
export function fillAbsentDays(
  rows: DigestRow[],
  periodStartUnix: number,
  periodEndUnix: number
): DigestRow[] {
  const result: DigestRow[] = [];
  for (let i = 0; i < 7; i++) {
    const windowStart = periodStartUnix + i * 86400;
    const windowEnd = i < 6 ? windowStart + 86400 - 1 : periodEndUnix;
    const matchingRow = rows.find(
      (r) => r.period_start >= windowStart && r.period_start <= windowEnd
    );
    result.push(matchingRow ?? { digest_json: null, period_start: windowStart, period_end: windowEnd });
  }
  return result;
}

function isEmptyDigest(digestJson: string | null): boolean {
  if (digestJson === null) return true;
  try {
    const d = JSON.parse(digestJson) as DailyDigest;
    return d.projects.length === 0;
  } catch {
    return true;
  }
}

export function aggregateFromDigests(
  rows: DigestRow[],
  periodStartUnix: number,
  periodEndUnix: number,
  fallback: (start: number, end: number) => WeeklyReportData
): WeeklyReportData {
  if (rows.length === 0) {
    return fallback(periodStartUnix, periodEndUnix);
  }

  const nullCount = rows.filter((r) => r.digest_json === null).length;

  if (nullCount === rows.length) {
    console.log(`[Report] Weekly: ${nullCount}/${rows.length} daily digests missing, falling back to analyses query`);
    return fallback(periodStartUnix, periodEndUnix);
  }

  // If all rows are effectively empty (null or zero-project digests), fall back to analyses.
  // This handles the migration window where daily reports ran but found nothing, and PRs from
  // earlier days were never captured in any digest.
  const effectivelyEmptyCount = rows.filter((r) => isEmptyDigest(r.digest_json)).length;
  if (effectivelyEmptyCount === rows.length) {
    return fallback(periodStartUnix, periodEndUnix);
  }

  // Mixed mode: at least one digest present
  const projectMap = new Map<string, AccProject>();

  function mergeIntoMap(
    projectId: string,
    prCount: number,
    notableCount: number,
    directionalShiftCount: number,
    signals: string[],
    highlights: WeeklyProjectSummary["highlights"]
  ): void {
    const acc = projectMap.get(projectId) ?? {
      prCount: 0,
      notableCount: 0,
      directionalShiftCount: 0,
      signals: new Set<string>(),
      highlights: [],
    };
    acc.prCount += prCount;
    acc.notableCount += notableCount;
    acc.directionalShiftCount += directionalShiftCount;
    for (const s of signals) acc.signals.add(s);
    acc.highlights.push(...highlights);
    projectMap.set(projectId, acc);
  }

  for (const row of rows) {
    if (row.digest_json !== null) {
      const digest: DailyDigest = JSON.parse(row.digest_json);
      for (const proj of digest.projects) {
        mergeIntoMap(
          proj.projectId,
          proj.prCount,
          proj.notableCount,
          proj.directionalShiftCount,
          proj.topSignals,
          proj.prs.map((p) => ({
            prNumber: p.prNumber,
            title: p.title,
            summary: p.summary,
            significance: p.significance,
            directionSignal: p.directionSignal,
            htmlUrl: p.htmlUrl,
          }))
        );
      }
    } else {
      const dayData = fallback(row.period_start, row.period_end);
      // Build a map of projectId → full signals from directionChanges (not truncated by highlights cap)
      const daySignalMap = new Map<string, string[]>();
      for (const dc of dayData.directionChanges) {
        daySignalMap.set(dc.projectId, dc.signals);
      }
      for (const proj of dayData.projectHighlights) {
        mergeIntoMap(
          proj.projectId,
          proj.prCount,
          proj.notableCount,
          proj.directionalShiftCount,
          daySignalMap.get(proj.projectId) ?? [],
          proj.highlights
        );
      }
    }
  }

  let totalPrs = 0;
  let totalNotable = 0;
  let totalDirectionalShifts = 0;
  const directionChanges: WeeklyDirectionChange[] = [];
  const projectHighlights: WeeklyProjectSummary[] = [];

  for (const [projectId, acc] of projectMap.entries()) {
    totalPrs += acc.prCount;
    totalNotable += acc.notableCount;
    totalDirectionalShifts += acc.directionalShiftCount;

    if (acc.directionalShiftCount > 0) {
      directionChanges.push({
        projectId,
        prCount: acc.directionalShiftCount,
        signals: Array.from(acc.signals),
      });
    }

    const sortedHighlights = acc.highlights
      .sort((a, b) => signRank(b.significance) - signRank(a.significance))
      .slice(0, 2);

    projectHighlights.push({
      projectId,
      prCount: acc.prCount,
      notableCount: acc.notableCount,
      directionalShiftCount: acc.directionalShiftCount,
      highlights: sortedHighlights,
    });
  }

  directionChanges.sort((a, b) => b.prCount - a.prCount);

  projectHighlights.sort((a, b) => {
    const aRank = a.directionalShiftCount > 0 ? 2 : a.notableCount > 0 ? 1 : 0;
    const bRank = b.directionalShiftCount > 0 ? 2 : b.notableCount > 0 ? 1 : 0;
    return bRank - aRank;
  });

  return {
    directionChanges,
    activitySummary: {
      totalPrs,
      directionalShiftCount: totalDirectionalShifts,
      notableCount: totalNotable,
      projectCount: projectMap.size,
    },
    projectHighlights,
    periodStartUnix,
    periodEndUnix,
  };
}

export function buildWeeklyReport(timezone: string, now?: Date): WeeklyReportData {
  const db = getDb();
  const { startUnix: periodStartUnix, endUnix: periodEndUnix } = getWeekPeriod(timezone, now);

  const dailyRows = db
    .query<DigestRow, [number, number]>(
      `SELECT digest_json, period_start, period_end FROM reports
       WHERE type = 'daily' AND period_start >= ? AND period_end <= ?`
    )
    .all(periodStartUnix, periodEndUnix);

  // Inject synthetic null entries for daily windows with no reports row so absent days
  // trigger the per-day fallback rather than being silently dropped.
  const augmentedRows = fillAbsentDays(dailyRows, periodStartUnix, periodEndUnix);

  return aggregateFromDigests(
    augmentedRows,
    periodStartUnix,
    periodEndUnix,
    (start, end) => queryWeeklyFromAnalyses(db, start, end)
  );
}

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
       JOIN pull_requests pr ON a.pr_id = pr.id
       WHERE pr.merged_at >= ? AND pr.merged_at <= ?`
    )
    .all(periodStartUnix, periodEndUnix);

  if (rows.length === 0) return [];

  const mantleConfig = getMantleConfig();
  const trackedProjects = getTrackedProjects();

  // Count routine PRs per project to detect weekly patterns (≥3 routine PRs = pattern)
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
    const categories = row.categories
      ? (JSON.parse(row.categories) as string[])
      : [];
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
