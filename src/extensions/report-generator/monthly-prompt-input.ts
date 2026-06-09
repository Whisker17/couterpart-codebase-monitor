import type { Database } from "bun:sqlite";
import { getMonthPeriod } from "../../utils/time-window";

type Significance = "routine" | "notable" | "directional_shift";

export interface MonthlyPromptInput {
  period: {
    startUnix: number;
    endUnix: number;
    startDate: string;
    endDate: string;
    month: string;
    label: string;
    timezone: string;
    isPartial: boolean;
    completedDays: number;
  };
  activitySummary: {
    totalPrs: number;
    projectCount: number;
    directionalShiftCount: number;
    notableCount: number;
    routineCount: number;
  };
  coverage: {
    dailyReports: {
      present: number;
      nullDigest: number;
      missing: number;
    };
    weeklyReports: {
      present: number;
      nullDigest: number;
    };
  };
  monthlyShape: {
    categoryCounts: Array<{ category: string; count: number }>;
    narrativeSignals: Array<{ signal: string; count: number; projects: string[] }>;
    timeBuckets: Array<{
      label: string;
      startDate: string;
      endDate: string;
      totalPrs: number;
      directionalShiftCount: number;
      notableCount: number;
      routineCount: number;
      projectCounts: Array<{ projectId: string; prCount: number }>;
    }>;
  };
  projects: Array<{
    projectId: string;
    organization: string;
    repository: string;
    prCount: number;
    directionalShiftCount: number;
    notableCount: number;
    routineCount: number;
    activeDays: number;
    firstHalfPrs: number;
    secondHalfPrs: number;
    topCategories: Array<{ category: string; count: number }>;
    topSignals: string[];
    representativePrs: Array<{
      prNumber: number;
      title: string;
      htmlUrl: string;
      mergedDate: string;
      summary: string;
      directionSignal: string | null;
      significance: Significance;
      categories: string[];
    }>;
  }>;
}

interface AnalysisRow {
  project_id: string;
  org: string;
  repo: string;
  pr_number: number;
  title: string;
  project_url: string;
  merged_at: number;
  summary: string;
  direction_signal: string | null;
  significance: Significance;
  categories: string | null;
}

interface ReportCoverageRow {
  digest_json: string | null;
}

interface MonthlyPromptBuildOptions {
  month?: string;
  now?: Date;
}

const MAX_TOP_SIGNALS_PER_PROJECT = 8;
const MAX_REPRESENTATIVE_PRS_PER_PROJECT = 12;
const MAX_GLOBAL_SIGNALS = 12;
const MAX_CATEGORIES = 12;

function formatDate(unixSeconds: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(unixSeconds * 1000));
}

function defaultMonth(timezone: string, now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
  }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")!.value);
  const month = Number(parts.find((part) => part.type === "month")!.value);
  return `${year}-${String(month).padStart(2, "0")}`;
}

function parseDateParts(date: string): { year: number; month: number; day: number } {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid date format from monthly period: "${date}"`);
  }
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

function completedDays(startDate: string, endDate: string): number {
  const start = parseDateParts(startDate);
  const end = parseDateParts(endDate);
  const startMs = Date.UTC(start.year, start.month - 1, start.day);
  const endMs = Date.UTC(end.year, end.month - 1, end.day);
  return Math.floor((endMs - startMs) / 86_400_000) + 1;
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

function normalizeText(value: string | null): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized || null;
}

function increment(map: Map<string, number>, key: string, amount = 1): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function topCounts(map: Map<string, number>, limit: number): Array<{ category: string; count: number }> {
  return Array.from(map.entries())
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .slice(0, limit)
    .map(([category, count]) => ({ category, count }));
}

function getReportCoverage(
  db: Database,
  type: "daily" | "weekly",
  startUnix: number,
  endUnix: number,
  expectedMissing?: number
): { present: number; nullDigest: number; missing?: number } {
  try {
    const rows = db
      .query<ReportCoverageRow, [string, number, number]>(
        `SELECT digest_json FROM reports
         WHERE type = ? AND period_start >= ? AND period_end <= ?`
      )
      .all(type, startUnix, endUnix);
    const present = rows.filter((row) => row.digest_json !== null).length;
    const nullDigest = rows.filter((row) => row.digest_json === null).length;
    return {
      present,
      nullDigest,
      missing: expectedMissing === undefined ? undefined : Math.max(0, expectedMissing - rows.length),
    };
  } catch {
    return {
      present: 0,
      nullDigest: 0,
      missing: expectedMissing,
    };
  }
}

function bucketStartDates(startDate: string, totalDays: number): string[] {
  const start = parseDateParts(startDate);
  const dates: string[] = [];
  for (let offset = 0; offset < totalDays; offset += 7) {
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day + offset));
    dates.push(date.toISOString().slice(0, 10));
  }
  return dates;
}

export function buildMonthlyPromptInput(
  db: Database,
  timezone: string,
  options: MonthlyPromptBuildOptions = {}
): MonthlyPromptInput {
  const now = options.now ?? new Date();
  const month = options.month ?? defaultMonth(timezone, now);
  const period = getMonthPeriod(timezone, month, now);
  const days = completedDays(period.startDate, period.endDate);

  const rows = db
    .query<AnalysisRow, [number, number]>(
      `SELECT a.project_id, p.org, p.repo, pr.pr_number, pr.title, p.url AS project_url,
              pr.merged_at, a.summary, a.direction_signal, a.significance, a.categories
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
    .all(period.startUnix, period.endUnix);

  const projectMap = new Map<
    string,
    {
      organization: string;
      repository: string;
      prs: Array<MonthlyPromptInput["projects"][number]["representativePrs"][number] & {
        mergedAt: number;
      }>;
      activeDays: Set<string>;
      categoryCounts: Map<string, number>;
    }
  >();
  const globalCategoryCounts = new Map<string, number>();
  const signalProjects = new Map<string, Set<string>>();
  const signalCounts = new Map<string, number>();

  for (const row of rows) {
    const categories = normalizeCategories(row.categories);
    const mergedDate = formatDate(row.merged_at, timezone);
    const entry =
      projectMap.get(row.project_id) ??
      {
        organization: row.org,
        repository: row.repo,
        prs: [],
        activeDays: new Set<string>(),
        categoryCounts: new Map<string, number>(),
      };

    entry.activeDays.add(mergedDate);
    for (const category of categories) {
      increment(entry.categoryCounts, category);
      increment(globalCategoryCounts, category);
    }

    const signal = normalizeText(row.direction_signal);
    if (signal) {
      increment(signalCounts, signal);
      const projects = signalProjects.get(signal) ?? new Set<string>();
      projects.add(row.project_id);
      signalProjects.set(signal, projects);
    }

    entry.prs.push({
      prNumber: row.pr_number,
      title: row.title,
      htmlUrl: buildPrHtmlUrl(row.project_url, row.pr_number),
      mergedDate,
      mergedAt: row.merged_at,
      summary: row.summary,
      directionSignal: signal,
      significance: row.significance,
      categories,
    });
    projectMap.set(row.project_id, entry);
  }

  let totalPrs = 0;
  let directionalShiftCount = 0;
  let notableCount = 0;
  let routineCount = 0;
  const midpointDay = Math.ceil(days / 2);

  const projects: MonthlyPromptInput["projects"] = [];
  for (const [projectId, entry] of projectMap.entries()) {
    entry.prs.sort((a, b) => {
      const rankDiff = significanceRank(b.significance) - significanceRank(a.significance);
      if (rankDiff !== 0) return rankDiff;
      return b.mergedAt - a.mergedAt;
    });

    const projectDirectional = entry.prs.filter((pr) => pr.significance === "directional_shift");
    const projectNotable = entry.prs.filter((pr) => pr.significance === "notable");
    const projectRoutine = entry.prs.filter((pr) => pr.significance === "routine");
    const firstHalfPrs = entry.prs.filter((pr) => parseDateParts(pr.mergedDate).day <= midpointDay);
    const topSignalSet = new Set<string>();
    for (const pr of entry.prs) {
      if (pr.directionSignal) topSignalSet.add(pr.directionSignal);
    }

    totalPrs += entry.prs.length;
    directionalShiftCount += projectDirectional.length;
    notableCount += projectNotable.length;
    routineCount += projectRoutine.length;

    projects.push({
      projectId,
      organization: entry.organization,
      repository: entry.repository,
      prCount: entry.prs.length,
      directionalShiftCount: projectDirectional.length,
      notableCount: projectNotable.length,
      routineCount: projectRoutine.length,
      activeDays: entry.activeDays.size,
      firstHalfPrs: firstHalfPrs.length,
      secondHalfPrs: entry.prs.length - firstHalfPrs.length,
      topCategories: topCounts(entry.categoryCounts, MAX_CATEGORIES),
      topSignals: Array.from(topSignalSet).slice(0, MAX_TOP_SIGNALS_PER_PROJECT),
      representativePrs: entry.prs
        .slice(0, MAX_REPRESENTATIVE_PRS_PER_PROJECT)
        .map(({ mergedAt: _mergedAt, ...pr }) => pr),
    });
  }

  projects.sort((a, b) => {
    const aRank = a.directionalShiftCount > 0 ? 2 : a.notableCount > 0 ? 1 : 0;
    const bRank = b.directionalShiftCount > 0 ? 2 : b.notableCount > 0 ? 1 : 0;
    if (bRank !== aRank) return bRank - aRank;
    if (b.prCount !== a.prCount) return b.prCount - a.prCount;
    return a.projectId.localeCompare(b.projectId);
  });

  const timeBuckets: MonthlyPromptInput["monthlyShape"]["timeBuckets"] = [];
  const starts = bucketStartDates(period.startDate, days);
  for (const [idx, startDate] of starts.entries()) {
    const start = parseDateParts(startDate);
    const end = new Date(Date.UTC(start.year, start.month - 1, start.day + 6));
    const cappedEndDate = end.toISOString().slice(0, 10) > period.endDate ? period.endDate : end.toISOString().slice(0, 10);
    const bucketRows = rows.filter((row) => {
      const date = formatDate(row.merged_at, timezone);
      return date >= startDate && date <= cappedEndDate;
    });
    const projectCounts = new Map<string, number>();
    for (const row of bucketRows) {
      increment(projectCounts, row.project_id);
    }
    timeBuckets.push({
      label: `W${idx + 1}`,
      startDate,
      endDate: cappedEndDate,
      totalPrs: bucketRows.length,
      directionalShiftCount: bucketRows.filter((row) => row.significance === "directional_shift").length,
      notableCount: bucketRows.filter((row) => row.significance === "notable").length,
      routineCount: bucketRows.filter((row) => row.significance === "routine").length,
      projectCounts: Array.from(projectCounts.entries())
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([projectId, prCount]) => ({ projectId, prCount })),
    });
  }

  const dailyCoverage = getReportCoverage(db, "daily", period.startUnix, period.endUnix, days);
  const weeklyCoverage = getReportCoverage(db, "weekly", period.startUnix, period.endUnix);

  return {
    period: {
      startUnix: period.startUnix,
      endUnix: period.endUnix,
      startDate: period.startDate,
      endDate: period.endDate,
      month: period.month,
      label: `${period.startDate}..${period.endDate}${period.isPartial ? " (month-to-date)" : ""}`,
      timezone,
      isPartial: period.isPartial,
      completedDays: days,
    },
    activitySummary: {
      totalPrs,
      projectCount: projects.length,
      directionalShiftCount,
      notableCount,
      routineCount,
    },
    coverage: {
      dailyReports: {
        present: dailyCoverage.present,
        nullDigest: dailyCoverage.nullDigest,
        missing: dailyCoverage.missing ?? 0,
      },
      weeklyReports: {
        present: weeklyCoverage.present,
        nullDigest: weeklyCoverage.nullDigest,
      },
    },
    monthlyShape: {
      categoryCounts: topCounts(globalCategoryCounts, MAX_CATEGORIES),
      narrativeSignals: Array.from(signalCounts.entries())
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, MAX_GLOBAL_SIGNALS)
        .map(([signal, count]) => ({
          signal,
          count,
          projects: Array.from(signalProjects.get(signal) ?? []).sort(),
        })),
      timeBuckets,
    },
    projects,
  };
}

export function renderMonthlyPrompt(template: string, input: MonthlyPromptInput): string {
  const inputJson = JSON.stringify(input, null, 2);
  const replacements: Record<string, string> = {
    MONTHLY_INPUT_JSON: inputJson,
    PERIOD_LABEL: input.period.label,
    PERIOD_MONTH: input.period.month,
    PERIOD_START_DATE: input.period.startDate,
    PERIOD_END_DATE: input.period.endDate,
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

  if (!template.includes("{{MONTHLY_INPUT_JSON}}")) {
    rendered += `\n\nMONTHLY_INPUT_JSON:\n${inputJson}`;
  }

  return rendered;
}
