import type { PipelineContext, PipelineStage, StageResult } from "../runner";
import { getDb } from "../../storage/db";
import { getTrackedProjects } from "../../config/projects";
import { buildDailyReport } from "../../extensions/report-generator/daily";
import { buildDailyCard } from "../../extensions/report-generator/templates/daily-card";
import { writeReportFile } from "../../extensions/report-generator/file-writer";

function formatDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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

  const card = buildDailyCard(date, reportData.grouped, partialWarning);

  const cardJson = JSON.stringify(card);
  if (cardJson.length > 20 * 1024) {
    console.warn(`[Report] Card JSON size ${cardJson.length} bytes exceeds 20KB — truncating to notable/directional PRs only`);
  }

  const completenessJson = JSON.stringify(completeness);
  const projectIds = JSON.stringify(reportData.grouped.map((g) => g.projectId));

  try {
    db.run(
      `INSERT INTO reports (type, period_start, period_end, project_ids, content, completeness)
       VALUES ('daily', ?, ?, ?, ?, ?)
       ON CONFLICT(type, period_start, period_end)
       DO UPDATE SET content = excluded.content, completeness = excluded.completeness`,
      [reportData.periodStartUnix, reportData.periodEndUnix, projectIds, cardJson, completenessJson]
    );
  } catch (err) {
    const msg = `DB upsert failed: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[Report] ${msg}`);
    errors.push(msg);
  }

  try {
    const filePath = writeReportFile({
      date,
      card,
      analyses: reportData.grouped,
      completeness,
    });
    console.log(`[Report] Written to ${filePath}`);
  } catch (err) {
    const msg = `File write failed: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[Report] ${msg}`);
    errors.push(msg);
  }

  return {
    success: errors.length === 0,
    itemsProcessed: reportData.grouped.length,
    errors,
    durationMs: 0,
  };
}

export const stage: PipelineStage = {
  name: "report",
  execute,
};
