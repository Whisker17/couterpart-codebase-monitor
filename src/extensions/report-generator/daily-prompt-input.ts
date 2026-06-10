import type { Database } from "bun:sqlite";
import { getYesterdayPeriod } from "../../utils/time-window";

type Significance = "routine" | "notable" | "directional_shift";

export interface DailyPromptInput {
  period: {
    startUnix: number;
    endUnix: number;
    date: string;
    label: string;
    timezone: string;
  };
  activitySummary: {
    totalPrs: number;
    projectCount: number;
    directionalShiftCount: number;
    notableCount: number;
    routineCount: number;
  };
  projects: Array<{
    projectId: string;
    prCount: number;
    directionalShiftCount: number;
    notableCount: number;
    routineCount: number;
    topSignals: string[];
    prs: Array<{
      prNumber: number;
      title: string;
      htmlUrl: string;
      mergedAt: number;
      filesChanged: number | null;
      additions: number | null;
      deletions: number | null;
      summary: string;
      technicalDetail: string | null;
      directionSignal: string | null;
      significance: Significance;
      categories: string[];
    }>;
  }>;
}

interface AnalysisRow {
  project_id: string;
  pr_number: number;
  title: string;
  project_url: string;
  merged_at: number;
  files_changed: number | null;
  additions: number | null;
  deletions: number | null;
  summary: string;
  technical_detail: string | null;
  direction_signal: string | null;
  significance: Significance;
  categories: string | null;
}

function formatDate(unixSeconds: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(unixSeconds * 1000));
}

function significanceRank(significance: Significance): number {
  return significance === "directional_shift" ? 2 : significance === "notable" ? 1 : 0;
}

function normalizeCategories(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === "string");
    }
  } catch {
    // Invalid legacy categories should not block prompt-lab rendering.
  }
  return [];
}

function buildPrHtmlUrl(projectUrl: string, prNumber: number): string {
  return `${projectUrl.replace(/\/+$/, "")}/pull/${prNumber}`;
}

function uniqueStrings(values: Array<string | null>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value?.replace(/\s+/g, " ").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function buildDailyPromptInput(
  db: Database,
  timezone: string,
  now: Date = new Date()
): DailyPromptInput {
  const { startUnix, endUnix } = getYesterdayPeriod(timezone, now);
  return buildDailyPromptInputForPeriod(db, timezone, startUnix, endUnix);
}

export function buildDailyPromptInputForPeriod(
  db: Database,
  timezone: string,
  startUnix: number,
  endUnix: number
): DailyPromptInput {
  const date = formatDate(startUnix, timezone);

  const rows = db
    .query<AnalysisRow, [number, number]>(
      `SELECT a.project_id, pr.pr_number, pr.title, p.url AS project_url,
              pr.merged_at, pr.files_changed, pr.additions, pr.deletions,
              a.summary, a.technical_detail, a.direction_signal,
              a.significance, a.categories
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
    .all(startUnix, endUnix);

  const projectMap = new Map<string, DailyPromptInput["projects"][number]["prs"]>();
  for (const row of rows) {
    const prs = projectMap.get(row.project_id) ?? [];
    prs.push({
      prNumber: row.pr_number,
      title: row.title,
      htmlUrl: buildPrHtmlUrl(row.project_url, row.pr_number),
      mergedAt: row.merged_at,
      filesChanged: row.files_changed,
      additions: row.additions,
      deletions: row.deletions,
      summary: row.summary,
      technicalDetail: row.technical_detail,
      directionSignal: row.direction_signal,
      significance: row.significance,
      categories: normalizeCategories(row.categories),
    });
    projectMap.set(row.project_id, prs);
  }

  let totalPrs = 0;
  let directionalShiftCount = 0;
  let notableCount = 0;
  let routineCount = 0;
  const projects: DailyPromptInput["projects"] = [];

  for (const [projectId, prs] of projectMap.entries()) {
    prs.sort((a, b) => {
      const rankDiff = significanceRank(b.significance) - significanceRank(a.significance);
      if (rankDiff !== 0) return rankDiff;
      return b.mergedAt - a.mergedAt;
    });

    const projectDirectional = prs.filter((pr) => pr.significance === "directional_shift");
    const projectNotable = prs.filter((pr) => pr.significance === "notable");
    const projectRoutine = prs.filter((pr) => pr.significance === "routine");

    totalPrs += prs.length;
    directionalShiftCount += projectDirectional.length;
    notableCount += projectNotable.length;
    routineCount += projectRoutine.length;

    projects.push({
      projectId,
      prCount: prs.length,
      directionalShiftCount: projectDirectional.length,
      notableCount: projectNotable.length,
      routineCount: projectRoutine.length,
      topSignals: uniqueStrings(prs.map((pr) => pr.directionSignal)),
      prs,
    });
  }

  projects.sort((a, b) => {
    const aRank = a.directionalShiftCount > 0 ? 2 : a.notableCount > 0 ? 1 : 0;
    const bRank = b.directionalShiftCount > 0 ? 2 : b.notableCount > 0 ? 1 : 0;
    if (bRank !== aRank) return bRank - aRank;
    if (b.prCount !== a.prCount) return b.prCount - a.prCount;
    return a.projectId.localeCompare(b.projectId);
  });

  return {
    period: {
      startUnix,
      endUnix,
      date,
      label: date,
      timezone,
    },
    activitySummary: {
      totalPrs,
      projectCount: projects.length,
      directionalShiftCount,
      notableCount,
      routineCount,
    },
    projects,
  };
}

export function renderDailyPrompt(template: string, input: DailyPromptInput): string {
  const inputJson = JSON.stringify(input, null, 2);
  const replacements: Record<string, string> = {
    DAILY_INPUT_JSON: inputJson,
    PERIOD_LABEL: input.period.label,
    PERIOD_DATE: input.period.date,
    TIMEZONE: input.period.timezone,
    TOTAL_PRS: String(input.activitySummary.totalPrs),
    PROJECT_COUNT: String(input.activitySummary.projectCount),
    DIRECTIONAL_SHIFT_COUNT: String(input.activitySummary.directionalShiftCount),
    NOTABLE_COUNT: String(input.activitySummary.notableCount),
    ROUTINE_COUNT: String(input.activitySummary.routineCount),
  };

  let rendered = template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key: string) => {
    return replacements[key] ?? match;
  });

  if (!template.includes("{{DAILY_INPUT_JSON}}")) {
    rendered += `\n\nDAILY_INPUT_JSON:\n${inputJson}`;
  }

  return rendered;
}
