import type { Database } from "bun:sqlite";
import type { PipelineContext, PipelineStage, StageResult } from "../runner";
import { getDb } from "../../storage/db";
import { getTrackedProjects } from "../../config/projects";
import { buildDailyReport } from "../../extensions/report-generator/daily";
import { buildDailyCard, type GroupedAnalyses, type LarkCard } from "../../extensions/report-generator/templates/daily-card";
import { buildWeeklyReport } from "../../extensions/report-generator/weekly";
import { buildWeeklyCard } from "../../extensions/report-generator/templates/weekly-card";
import { writeReportFile } from "../../extensions/report-generator/file-writer";

const WARN_BYTES = 20 * 1024;
const HARD_BYTES = 30 * 1024;

function filterRoutinePRs(analyses: GroupedAnalyses): { filtered: GroupedAnalyses; omittedCount: number } {
  let omittedCount = 0;
  const filtered = analyses
    .map((p) => {
      const significant = p.prs.filter((pr) => pr.significance !== "routine");
      omittedCount += p.prs.length - significant.length;
      return { ...p, prs: significant, prCount: significant.length };
    })
    .filter((p) => p.prs.length > 0);
  return { filtered, omittedCount };
}

export interface FinalCardResult {
  content: string;
  card: LarkCard | LarkCard[];
  errors: string[];
}

export function buildFinalCard(
  date: string,
  analyses: GroupedAnalyses,
  partialWarning: string | undefined
): FinalCardResult {
  // Level 0: full card
  const card = buildDailyCard(date, analyses, partialWarning);
  const cardJson = JSON.stringify(card);
  if (cardJson.length <= WARN_BYTES) {
    return { content: cardJson, card, errors: [] };
  }

  // Level 1: filter to notable/directional_shift only
  const { filtered, omittedCount } = filterRoutinePRs(analyses);
  const level1Card = buildDailyCard(date, filtered, partialWarning);
  const summaryEl = level1Card.elements[0] as { tag: "markdown"; content: string };
  summaryEl.content += `\n_${omittedCount} routine PR${omittedCount !== 1 ? "s" : ""} omitted_`;
  const level1Json = JSON.stringify(level1Card);
  if (level1Json.length <= WARN_BYTES) {
    console.warn(`[Report] Card truncated to notable/directional PRs (${omittedCount} routine omitted)`);
    return { content: level1Json, card: level1Card, errors: [] };
  }

  // Level 2: one card per project
  console.warn(`[Report] Card still ${level1Json.length} bytes after filtering — splitting per project`);
  const perProjectCards = analyses.map((p) => buildDailyCard(date, [p], partialWarning));
  const errors: string[] = [];
  for (const pc of perProjectCards) {
    const pcJson = JSON.stringify(pc);
    if (pcJson.length > HARD_BYTES) {
      errors.push(`Card for "${(pc.header.title as { content: string }).content}" exceeds 30KB hard limit (${pcJson.length} bytes)`);
    }
  }
  return { content: JSON.stringify(perProjectCards), card: perProjectCards, errors };
}

function formatDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatShortDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function collectFailedProjects(ctx: PipelineContext): string[] {
  const failed = new Set<string>();
  for (const result of ctx.stageResults.values()) {
    if (result.failedProjects) {
      for (const p of result.failedProjects) failed.add(p);
    }
  }
  return Array.from(failed);
}

export async function execute(ctx: PipelineContext): Promise<StageResult> {
  const db = getDb();
  const errors: string[] = [];

  const reportData = buildDailyReport();

  if (reportData.grouped.length === 0) {
    return { success: true, itemsProcessed: 0, errors: [], durationMs: 0 };
  }

  const failedProjects = collectFailedProjects(ctx);
  const trackedProjects = getTrackedProjects();

  const completeness = {
    total: trackedProjects.length,
    success: trackedProjects.length - failedProjects.length,
    failed: failedProjects,
  };

  const date = formatDate(reportData.periodStartUnix);

  const partialWarning =
    failedProjects.length > 0
      ? `Partial report: ${failedProjects.length} project(s) failed collection/analysis`
      : undefined;

  const { content: cardContent, card: finalCard, errors: cardErrors } = buildFinalCard(
    date,
    reportData.grouped,
    partialWarning
  );
  errors.push(...cardErrors);

  if (cardErrors.length > 0) {
    return { success: false, itemsProcessed: 0, errors, durationMs: 0 };
  }

  const completenessJson = JSON.stringify(completeness);
  const projectIds = JSON.stringify(reportData.grouped.map((g) => g.projectId));

  try {
    db.run(
      `INSERT INTO reports (type, period_start, period_end, project_ids, content, completeness)
       VALUES ('daily', ?, ?, ?, ?, ?)
       ON CONFLICT(type, period_start, period_end)
       DO UPDATE SET content = excluded.content,
                     completeness = excluded.completeness,
                     project_ids = excluded.project_ids`,
      [reportData.periodStartUnix, reportData.periodEndUnix, projectIds, cardContent, completenessJson]
    );
  } catch (err) {
    const msg = `DB upsert failed: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[Report] ${msg}`);
    errors.push(msg);
  }

  try {
    const filePath = writeReportFile({
      date: `daily-${date}`,
      card: finalCard,
      analyses: reportData.grouped,
      completeness,
    });
    console.log(`[Report] Written to ${filePath}`);
  } catch (err) {
    const msg = `File write failed: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[Report] ${msg}`);
    errors.push(msg);
  }

  // Weekly report — only when this run was triggered by the weekly cron
  if (ctx.isWeeklyRun) {
    const weeklyErrors = await generateWeeklyReport(db, completeness);
    errors.push(...weeklyErrors);
  }

  return {
    success: errors.length === 0,
    itemsProcessed: reportData.grouped.length,
    errors,
    durationMs: 0,
  };
}

async function generateWeeklyReport(
  db: Database,
  completeness: { total: number; success: number; failed: string[] }
): Promise<string[]> {
  const errors: string[] = [];
  const weeklyData = buildWeeklyReport();

  if (weeklyData.projectHighlights.length === 0) {
    console.log("[Report] Weekly: no analyses found for the past 7 days, skipping");
    return errors;
  }

  const startLabel = formatShortDate(weeklyData.periodStartUnix);
  const endLabel = formatShortDate(weeklyData.periodEndUnix);
  const dateRange = `${startLabel}–${endLabel}`;
  const weeklyCard = buildWeeklyCard(dateRange, weeklyData);
  const weeklyJson = JSON.stringify(weeklyCard);

  if (weeklyJson.length > HARD_BYTES) {
    console.warn(`[Report] Weekly card exceeds 30KB hard limit (${weeklyJson.length} bytes) — sending anyway`);
  } else if (weeklyJson.length > WARN_BYTES) {
    console.warn(`[Report] Weekly card exceeds 20KB warn threshold (${weeklyJson.length} bytes)`);
  }

  const weeklyProjectIds = JSON.stringify(
    weeklyData.projectHighlights.map((p) => p.projectId)
  );
  const weeklyCompletenessJson = JSON.stringify(completeness);

  try {
    db.run(
      `INSERT INTO reports (type, period_start, period_end, project_ids, content, completeness)
       VALUES ('weekly', ?, ?, ?, ?, ?)
       ON CONFLICT(type, period_start, period_end)
       DO UPDATE SET content = excluded.content,
                     completeness = excluded.completeness,
                     project_ids = excluded.project_ids`,
      [
        weeklyData.periodStartUnix,
        weeklyData.periodEndUnix,
        weeklyProjectIds,
        weeklyJson,
        weeklyCompletenessJson,
      ]
    );
  } catch (err) {
    const msg = `Weekly DB upsert failed: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[Report] ${msg}`);
    errors.push(msg);
  }

  try {
    const weeklyDate = `weekly-${formatDate(weeklyData.periodEndUnix)}`;
    const filePath = writeReportFile({
      date: weeklyDate,
      card: weeklyCard,
      analyses: [],
      completeness,
    });
    console.log(`[Report] Weekly written to ${filePath}`);
  } catch (err) {
    const msg = `Weekly file write failed: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[Report] ${msg}`);
    errors.push(msg);
  }

  return errors;
}

export const stage: PipelineStage = {
  name: "report",
  execute,
};
