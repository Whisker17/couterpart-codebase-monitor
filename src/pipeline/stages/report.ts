import type { Database } from "bun:sqlite";
import type { PipelineContext, PipelineStage, StageResult } from "../runner";
import { getDb } from "../../storage/db";
import { getTrackedProjects } from "../../config/projects";
import { buildDailyReport } from "../../extensions/report-generator/daily";
import { type GroupedAnalyses, type LarkCard } from "../../extensions/report-generator/templates/daily-card";
import { buildWeeklyReport } from "../../extensions/report-generator/weekly";
import { buildWeeklyCard } from "../../extensions/report-generator/templates/weekly-card";
import { writeReportFile } from "../../extensions/report-generator/file-writer";
import { formatReport } from "../../extensions/lark-dispatcher/formatter";

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
  const { cards, errors } = formatReport(date, analyses, partialWarning);
  const card = cards.length === 1 ? cards[0] : cards;
  return { content: JSON.stringify(card), card, errors };
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

  const { cards, errors: cardErrors } = formatReport(date, reportData.grouped, partialWarning);
  if (cardErrors.length > 0) {
    for (const e of cardErrors) console.warn(`[Report] ⚠ ${e}`);
    errors.push(...cardErrors);
  }

  const finalCard = cards.length === 1 ? cards[0] : cards;
  const cardContent = JSON.stringify(finalCard);
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

    const reportRow = db
      .query<{ id: number }, [string, number, number]>(
        "SELECT id FROM reports WHERE type = ? AND period_start = ? AND period_end = ?"
      )
      .get("daily", reportData.periodStartUnix, reportData.periodEndUnix)!;
    for (let i = 0; i < cards.length; i++) {
      db.run(
        "INSERT OR IGNORE INTO report_deliveries (report_id, card_index, content) VALUES (?, ?, ?)",
        [reportRow.id, i, JSON.stringify(cards[i])]
      );
    }
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
    const weeklyErrors = generateWeeklyReport(db, completeness);
    // Weekly errors are non-fatal: they don't affect the daily success flag
    if (weeklyErrors.length > 0) {
      console.error(`[Report] Weekly report had ${weeklyErrors.length} error(s):`, weeklyErrors);
    }
  }

  return {
    success: errors.length === 0,
    itemsProcessed: reportData.grouped.length,
    errors,
    durationMs: 0,
  };
}

function generateWeeklyReport(
  db: Database,
  completeness: { total: number; success: number; failed: string[] }
): string[] {
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

  const weeklyBytes = Buffer.byteLength(weeklyJson, "utf-8");
  if (weeklyBytes > 30_000) {
    console.warn(`[Report] Weekly card exceeds 30KB hard limit (${weeklyBytes} bytes) — sending anyway`);
  } else if (weeklyBytes > 20_000) {
    console.warn(`[Report] Weekly card exceeds 20KB warn threshold (${weeklyBytes} bytes)`);
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

    const weeklyRow = db
      .query<{ id: number }, [string, number, number]>(
        "SELECT id FROM reports WHERE type = ? AND period_start = ? AND period_end = ?"
      )
      .get("weekly", weeklyData.periodStartUnix, weeklyData.periodEndUnix)!;
    db.run(
      "INSERT OR IGNORE INTO report_deliveries (report_id, card_index, content) VALUES (?, 0, ?)",
      [weeklyRow.id, weeklyJson]
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
