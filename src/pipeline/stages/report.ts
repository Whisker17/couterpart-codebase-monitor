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
import {
  localizeDailyDelivery as defaultLocalizeDailyDelivery,
  localizeWeeklyDelivery as defaultLocalizeWeeklyDelivery,
} from "../../extensions/report-generator/delivery-localizer";

export interface FinalCardResult {
  content: string;
  card: LarkCard | LarkCard[];
  errors: string[];
}

export interface ReportStageDeps {
  localizeDailyDelivery?: typeof defaultLocalizeDailyDelivery;
  localizeWeeklyDelivery?: typeof defaultLocalizeWeeklyDelivery;
}

export function buildFinalCard(
  date: string,
  analyses: GroupedAnalyses,
  partialWarning: string | undefined
): FinalCardResult {
  const { cards, errors } = formatReport(date, analyses, partialWarning);
  const card = cards.length === 1 ? cards[0]! : cards;
  return { content: JSON.stringify(card), card, errors };
}

function formatDate(unixSeconds: number, timezone: string): string {
  const d = new Date(unixSeconds * 1000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function formatShortDate(unixSeconds: number, timezone: string): string {
  const d = new Date(unixSeconds * 1000);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: timezone });
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

export async function execute(ctx: PipelineContext, deps: ReportStageDeps = {}): Promise<StageResult> {
  const db = getDb();
  const errors: string[] = [];
  const localizeDailyDelivery = deps.localizeDailyDelivery ?? defaultLocalizeDailyDelivery;
  const localizeWeeklyDelivery = deps.localizeWeeklyDelivery ?? defaultLocalizeWeeklyDelivery;
  const timezone = ctx.timezone ?? "UTC";

  const reportData = buildDailyReport(timezone);

  const failedProjects = collectFailedProjects(ctx);
  const trackedProjects = getTrackedProjects();

  const completeness = {
    total: trackedProjects.length,
    success: trackedProjects.length - failedProjects.length,
    failed: failedProjects,
  };

  const deliverableGrouped = reportData.grouped.filter((g) => g.prs.length > 0);
  if (deliverableGrouped.length === 0) {
    console.log("[Report] Daily: no deliverable PRs for this period, skipping report and delivery");
    if (ctx.reportMode === "weekly") {
      const weeklyErrors = await generateWeeklyReport(db, completeness, localizeWeeklyDelivery, timezone);
      if (weeklyErrors.length > 0) {
        console.error(`[Report] Weekly report had ${weeklyErrors.length} error(s):`, weeklyErrors);
      }
      return { success: weeklyErrors.length === 0, itemsProcessed: 0, errors: weeklyErrors, durationMs: 0 };
    }
    return { success: true, itemsProcessed: 0, errors: [], durationMs: 0 };
  }

  const date = formatDate(reportData.periodStartUnix, timezone);

  const partialWarning =
    failedProjects.length > 0
      ? `Partial report: ${failedProjects.length} project(s) failed collection/analysis`
      : undefined;

  const localizedGrouped = await localizeDailyDelivery(deliverableGrouped);
  const { cards, errors: cardErrors } = formatReport(date, localizedGrouped, partialWarning, reportData.budgetLine);
  if (cardErrors.length > 0) {
    for (const e of cardErrors) console.warn(`[Report] ⚠ ${e}`);
    errors.push(...cardErrors);
  }

  const finalCard = cards.length === 1 ? cards[0]! : cards;
  const cardContent = JSON.stringify(finalCard);
  const completenessJson = JSON.stringify(completeness);
  const projectIds = JSON.stringify(localizedGrouped.map((g) => g.projectId));

  try {
    db.run(
      `INSERT INTO reports (type, period_start, period_end, project_ids, content, completeness, digest_json)
       VALUES ('daily', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(type, period_start, period_end)
       DO UPDATE SET content = excluded.content,
                     completeness = excluded.completeness,
                     project_ids = excluded.project_ids,
                     digest_json = excluded.digest_json`,
      [reportData.periodStartUnix, reportData.periodEndUnix, projectIds, cardContent, completenessJson, JSON.stringify(reportData.digest)]
    );

    const reportRow = db
      .query<{ id: number }, [string, number, number]>(
        "SELECT id FROM reports WHERE type = ? AND period_start = ? AND period_end = ?"
      )
      .get("daily", reportData.periodStartUnix, reportData.periodEndUnix)!;
    for (let i = 0; i < cards.length; i++) {
      db.run(
        `INSERT INTO report_deliveries (report_id, card_index, content) VALUES (?, ?, ?)
         ON CONFLICT(report_id, card_index)
         DO UPDATE SET content = excluded.content
         WHERE report_deliveries.status != 'sent'`,
        [reportRow.id, i, JSON.stringify(cards[i])]
      );
    }
    db.run(
      "DELETE FROM report_deliveries WHERE report_id = ? AND card_index >= ? AND status != 'sent'",
      [reportRow.id, cards.length]
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
      analyses: localizedGrouped,
      completeness,
    });
    console.log(`[Report] Written to ${filePath}`);
  } catch (err) {
    const msg = `File write failed: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[Report] ${msg}`);
    errors.push(msg);
  }

  if (ctx.reportMode === "weekly") {
    const weeklyErrors = await generateWeeklyReport(db, completeness, localizeWeeklyDelivery, timezone);
    if (weeklyErrors.length > 0) {
      console.error(`[Report] Weekly report had ${weeklyErrors.length} error(s):`, weeklyErrors);
      errors.push(...weeklyErrors);
    }
  }

  return {
    success: errors.length === 0,
    itemsProcessed: deliverableGrouped.length,
    errors,
    durationMs: 0,
  };
}

async function generateWeeklyReport(
  db: Database,
  completeness: { total: number; success: number; failed: string[] },
  localizeWeeklyDelivery: typeof defaultLocalizeWeeklyDelivery,
  timezone: string
): Promise<string[]> {
  const errors: string[] = [];
  const weeklyData = await localizeWeeklyDelivery(buildWeeklyReport(timezone));

  if (weeklyData.projectHighlights.length === 0) {
    console.log("[Report] Weekly: no analyses found for the past 7 days, skipping");
    return errors;
  }

  const startLabel = formatShortDate(weeklyData.periodStartUnix, timezone);
  const endLabel = formatShortDate(weeklyData.periodEndUnix, timezone);
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
      `INSERT INTO report_deliveries (report_id, card_index, content) VALUES (?, 0, ?)
       ON CONFLICT(report_id, card_index)
       DO UPDATE SET content = excluded.content
       WHERE report_deliveries.status != 'sent'`,
      [weeklyRow.id, weeklyJson]
    );
    db.run(
      "DELETE FROM report_deliveries WHERE report_id = ? AND card_index >= 1 AND status != 'sent'",
      [weeklyRow.id]
    );
  } catch (err) {
    const msg = `Weekly DB upsert failed: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[Report] ${msg}`);
    errors.push(msg);
  }

  try {
    const weeklyDate = `weekly-${formatDate(weeklyData.periodEndUnix, timezone)}`;
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
