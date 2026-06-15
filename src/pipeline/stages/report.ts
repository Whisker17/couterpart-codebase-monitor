import type { Database } from "bun:sqlite";
import type { PipelineContext, PipelineStage, StageResult } from "../runner";
import type { SyncResult } from "../../config/projects";
import { getDb } from "../../storage/db";
import {
  buildDailyReport,
  buildImpactCheckSummaryLine,
  buildImpactCheckDeadLetterLine,
  buildImpactCheckBudgetLine,
  buildSubThresholdDigestLine,
  buildImpactOpsCard,
} from "../../extensions/report-generator/daily";
import type { SubThresholdFinding } from "../../extensions/report-generator/daily";
import { buildWeeklyPromptCard } from "../../extensions/report-generator/templates/weekly-prompt-card";
import { generateWeeklyPromptReport } from "../../extensions/report-generator/weekly-prompt-report";
import { buildMonthlyPromptCard } from "../../extensions/report-generator/templates/monthly-prompt-card";
import { generateMonthlyPromptReport } from "../../extensions/report-generator/monthly-prompt-report";
import { buildDailyPromptCard } from "../../extensions/report-generator/templates/daily-prompt-card";
import { generateDailyPromptReport } from "../../extensions/report-generator/daily-prompt-report";
import { writeReportFile } from "../../extensions/report-generator/file-writer";
import { getPreviousMonthString } from "../../utils/time-window";

function formatDate(unixSeconds: number, timezone: string): string {
  const d = new Date(unixSeconds * 1000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function formatChineseShortDate(unixSeconds: number, timezone: string): string {
  const d = new Date(unixSeconds * 1000);
  return `${d.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric", timeZone: timezone })}`;
}

// The month string is already resolved in the configured timezone by the caller.
function formatMonthLabel(month: string): string {
  const [year, rawMonth] = month.split("-");
  return `${year}年${Number(rawMonth)}月`;
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

function buildSubscriptionNote(syncResult?: SyncResult): string | undefined {
  if (!syncResult) return undefined;
  const parts: string[] = [];
  if (syncResult.activated.length > 0) {
    parts.push(`${syncResult.activated.length} project${syncResult.activated.length > 1 ? "s" : ""} added from subscription: ${syncResult.activated.join(", ")}`);
  }
  if (syncResult.deactivated.length > 0) {
    parts.push(`${syncResult.deactivated.length} project${syncResult.deactivated.length > 1 ? "s" : ""} removed from subscription: ${syncResult.deactivated.join(", ")}`);
  }
  return parts.length > 0 ? parts.join("; ") : undefined;
}

export async function execute(ctx: PipelineContext): Promise<StageResult> {
  const db = getDb();
  const errors: string[] = [];
  const timezone = ctx.timezone ?? "UTC";
  const shouldGenerateDailyReport = !ctx.skipDailyReport;

  const maybeReportData = shouldGenerateDailyReport ? buildDailyReport(timezone) : null;
  const collectResult = ctx.stageResults.get("collect");
  const resolvedProjectCount = collectResult?.resolvedProjectCount ?? 0;
  const syncResult = collectResult?.syncResult;
  const subscriptionNote = buildSubscriptionNote(syncResult);

  const failedProjects = collectFailedProjects(ctx);

  const completeness = {
    total: resolvedProjectCount,
    success: resolvedProjectCount - failedProjects.length,
    failed: failedProjects,
    ...(subscriptionNote ? { subscriptionNote } : {}),
  };

  if (!shouldGenerateDailyReport) {
    const extraErrors = await generateExtraReportForMode(ctx, db, completeness, timezone);
    return {
      success: extraErrors.length === 0,
      itemsProcessed: 0,
      errors: extraErrors,
      durationMs: 0,
    };
  }

  const reportData = maybeReportData!;
  const deliverableGrouped = reportData.grouped.filter((g) => g.prs.length > 0);
  if (deliverableGrouped.length === 0) {
    const deadLetterCount = (() => {
      try {
        return db.query<{ cnt: number }, []>(
          "SELECT COUNT(*) as cnt FROM impact_checks WHERE alert_card_json IS NOT NULL AND alert_dispatched_at IS NULL AND alert_attempt_count >= 5"
        ).get()!.cnt;
      } catch {
        return 0;
      }
    })();

    if (deadLetterCount > 0) {
      console.log(`[Report] Daily: no deliverable PRs but ${deadLetterCount} dead-letter impact alert(s) — generating ops card`);
      const recentIds = (() => {
        try {
          return db.query<{ id: number }, []>(
            "SELECT id FROM impact_checks WHERE alert_card_json IS NOT NULL AND alert_dispatched_at IS NULL AND alert_attempt_count >= 5 ORDER BY created_at DESC LIMIT 5"
          ).all().map((r) => r.id);
        } catch {
          return [];
        }
      })();
      const opsCard = buildImpactOpsCard(deadLetterCount, recentIds);
      const opsCardJson = JSON.stringify(opsCard);
      try {
        db.run(
          `INSERT INTO reports (type, period_start, period_end, project_ids, content, completeness, digest_json)
           VALUES ('daily', ?, ?, '[]', ?, ?, ?)
           ON CONFLICT(type, period_start, period_end)
           DO UPDATE SET content = excluded.content,
                         project_ids = excluded.project_ids,
                         completeness = excluded.completeness,
                         digest_json = excluded.digest_json`,
          [reportData.periodStartUnix, reportData.periodEndUnix, opsCardJson, JSON.stringify(completeness), JSON.stringify(reportData.digest)]
        );
        const opsReportRow = db
          .query<{ id: number }, [string, number, number]>(
            "SELECT id FROM reports WHERE type = ? AND period_start = ? AND period_end = ?"
          )
          .get("daily", reportData.periodStartUnix, reportData.periodEndUnix);
        if (opsReportRow) {
          db.run(
            `INSERT INTO report_deliveries (report_id, card_index, content) VALUES (?, 0, ?)
             ON CONFLICT(report_id, card_index)
             DO UPDATE SET content = excluded.content
             WHERE report_deliveries.status != 'sent'`,
            [opsReportRow.id, opsCardJson]
          );
          db.run(
            "DELETE FROM report_deliveries WHERE report_id = ? AND card_index >= 1 AND status != 'sent'",
            [opsReportRow.id]
          );
        }
      } catch (err) {
        console.error(`[Report] Ops card upsert failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      const extraErrors = await generateExtraReportForMode(ctx, db, completeness, timezone);
      if (extraErrors.length > 0) {
        return { success: false, itemsProcessed: 0, errors: extraErrors, durationMs: 0 };
      }
      return { success: true, itemsProcessed: 0, errors: [], durationMs: 0 };
    }

    console.log("[Report] Daily: no deliverable PRs for this period, skipping report and delivery");
    try {
      db.run(
        `INSERT INTO reports (type, period_start, period_end, project_ids, content, completeness, digest_json)
         VALUES ('daily', ?, ?, '[]', 'null', ?, ?)
         ON CONFLICT(type, period_start, period_end)
         DO UPDATE SET content = excluded.content,
                       project_ids = excluded.project_ids,
                       completeness = excluded.completeness,
                       digest_json = excluded.digest_json`,
        [reportData.periodStartUnix, reportData.periodEndUnix, JSON.stringify(completeness), JSON.stringify(reportData.digest)]
      );
      const emptyReportRow = db
        .query<{ id: number }, [string, number, number]>(
          "SELECT id FROM reports WHERE type = ? AND period_start = ? AND period_end = ?"
        )
        .get("daily", reportData.periodStartUnix, reportData.periodEndUnix);
      if (emptyReportRow) {
        db.run(
          "DELETE FROM report_deliveries WHERE report_id = ? AND status != 'sent'",
          [emptyReportRow.id]
        );
      }
    } catch (err) {
      console.error(`[Report] Empty digest upsert failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const extraErrors = await generateExtraReportForMode(ctx, db, completeness, timezone);
    if (extraErrors.length > 0) {
      return { success: false, itemsProcessed: 0, errors: extraErrors, durationMs: 0 };
    }
    return { success: true, itemsProcessed: 0, errors: [], durationMs: 0 };
  }

  const date = formatDate(reportData.periodStartUnix, timezone);

  const partialWarning =
    failedProjects.length > 0
      ? `Partial report: ${failedProjects.length} project(s) failed collection/analysis`
      : undefined;

  const combinedNote = [partialWarning, subscriptionNote].filter(Boolean).join(" | ") || undefined;

  let promptReport: Awaited<ReturnType<typeof generateDailyPromptReport>>;
  try {
    promptReport = await generateDailyPromptReport(db, timezone);
  } catch (err) {
    const msg = `Daily prompt report failed: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[Report] ${msg}`);
    errors.push(msg);
    return {
      success: false,
      itemsProcessed: deliverableGrouped.length,
      errors,
      durationMs: 0,
    };
  }

  const notices = [combinedNote, reportData.budgetLine].filter((line): line is string => Boolean(line));

  const impactCheckResult = ctx.stageResults.get("impact-check");
  const impactSummaryLine = buildImpactCheckSummaryLine({
    checksRun: impactCheckResult?.impactChecksRun ?? 0,
    alertsSent: impactCheckResult?.impactAlertsSent ?? 0,
    deadLettered: impactCheckResult?.impactAlertsDeadLettered ?? 0,
    budgetSkipped: impactCheckResult?.impactChecksSkipped?.budget ?? 0,
  });
  const impactDeadLetterLine = buildImpactCheckDeadLetterLine(impactCheckResult?.impactAlertsDeadLettered ?? 0);
  const impactBudgetLine = buildImpactCheckBudgetLine(impactCheckResult?.impactChecksSkipped?.budget ?? 0);

  // Sub-threshold findings (affected=yes but severity medium/low): recorded, not pushed —
  // digested here for the day's merged PRs. See impact-alert-severity-bar.
  const subThresholdFindings = db
    .query<SubThresholdFinding, [number, number]>(
      `SELECT pr.project_id AS sourceProjectId, pr.pr_number AS prNumber,
              ic.target_project_id AS targetProjectId, ic.severity AS severity, ic.summary AS summary
       FROM impact_checks ic
       JOIN pull_requests pr ON ic.pr_id = pr.id
       WHERE ic.status = 'complete' AND ic.affected = 'yes'
         AND ic.severity IN ('medium','low')
         AND pr.merged_at >= ? AND pr.merged_at < ?
       ORDER BY CASE ic.severity WHEN 'medium' THEN 0 ELSE 1 END, pr.merged_at DESC`
    )
    .all(reportData.periodStartUnix, reportData.periodEndUnix);
  const impactSubThresholdLine = buildSubThresholdDigestLine(subThresholdFindings);

  const rawNotices = [impactSummaryLine, impactDeadLetterLine, impactBudgetLine, impactSubThresholdLine].filter(
    (l): l is string => Boolean(l)
  );

  const finalCard = buildDailyPromptCard({
    date: promptReport.input.period.date,
    markdown: promptReport.markdown,
    totalPrs: promptReport.input.activitySummary.totalPrs,
    projectCount: promptReport.input.activitySummary.projectCount,
    directionalShiftCount: promptReport.input.activitySummary.directionalShiftCount,
    notableCount: promptReport.input.activitySummary.notableCount,
    routineCount: promptReport.input.activitySummary.routineCount,
    projects: promptReport.input.projects,
    notices,
    rawNotices,
  });
  const cards = [finalCard];
  const cardContent = JSON.stringify(finalCard);
  const completenessJson = JSON.stringify({
    ...completeness,
    prompt: promptReport.promptName,
    usage: promptReport.usage,
  });
  const projectIds = JSON.stringify(promptReport.input.projects.map((g) => g.projectId));

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
        analyses: deliverableGrouped,
        completeness,
      });
    console.log(`[Report] Written to ${filePath}`);
  } catch (err) {
    const msg = `File write failed: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[Report] ${msg}`);
    errors.push(msg);
  }

  errors.push(...await generateExtraReportForMode(ctx, db, completeness, timezone));

  return {
    success: errors.length === 0,
    itemsProcessed: deliverableGrouped.length,
    errors,
    durationMs: 0,
  };
}

async function generateExtraReportForMode(
  ctx: PipelineContext,
  db: Database,
  completeness: { total: number; success: number; failed: string[] },
  timezone: string
): Promise<string[]> {
  const { reportMode } = ctx;

  if (reportMode === "weekly") {
    const weeklyErrors = await generateWeeklyReport(db, completeness, timezone);
    if (weeklyErrors.length > 0) {
      console.error(`[Report] Weekly report had ${weeklyErrors.length} error(s):`, weeklyErrors);
    }
    return weeklyErrors;
  }

  if (reportMode === "monthly") {
    const monthlyErrors = await generateMonthlyReport(db, completeness, timezone, ctx.monthlyMonth);
    if (monthlyErrors.length > 0) {
      console.error(`[Report] Monthly report had ${monthlyErrors.length} error(s):`, monthlyErrors);
    }
    return monthlyErrors;
  }

  if (reportMode === "all") {
    const weeklyErrors = await generateWeeklyReport(db, completeness, timezone);
    if (weeklyErrors.length > 0) {
      console.error(`[Report] Weekly report had ${weeklyErrors.length} error(s):`, weeklyErrors);
    }

    const monthlyErrors = await generateMonthlyReport(db, completeness, timezone, ctx.monthlyMonth);
    if (monthlyErrors.length > 0) {
      console.error(`[Report] Monthly report had ${monthlyErrors.length} error(s):`, monthlyErrors);
    }

    return [...weeklyErrors, ...monthlyErrors];
  }

  return [];
}

async function generateWeeklyReport(
  db: Database,
  completeness: { total: number; success: number; failed: string[] },
  timezone: string
): Promise<string[]> {
  const errors: string[] = [];
  try {
    const promptReport = await generateWeeklyPromptReport(db, timezone);
    const startLabel = formatChineseShortDate(promptReport.input.period.startUnix, timezone);
    const endLabel = formatChineseShortDate(promptReport.input.period.endUnix, timezone);
    const dateRange = `${startLabel}-${endLabel}`;
    const weeklyCard = buildWeeklyPromptCard({
      dateRange,
      markdown: promptReport.markdown,
      totalPrs: promptReport.input.activitySummary.totalPrs,
      projectCount: promptReport.input.activitySummary.projectCount,
      dailyCoverage: {
        present: promptReport.input.dailyDigestCoverage.present,
        missing: promptReport.input.dailyDigestCoverage.missing,
      },
    });
    const weeklyJson = JSON.stringify(weeklyCard);

    const weeklyBytes = Buffer.byteLength(weeklyJson, "utf-8");
    if (weeklyBytes > 30_000) {
      console.warn(`[Report] Weekly card exceeds 30KB hard limit (${weeklyBytes} bytes) — sending anyway`);
    } else if (weeklyBytes > 20_000) {
      console.warn(`[Report] Weekly card exceeds 20KB warn threshold (${weeklyBytes} bytes)`);
    }

    const weeklyProjectIds = JSON.stringify(
      promptReport.input.projects.map((p) => p.projectId)
    );
    const weeklyCompletenessJson = JSON.stringify({
      ...completeness,
      prompt: "action-oriented",
      usage: promptReport.usage,
    });
    const weeklyDigestJson = JSON.stringify(promptReport.input);

    try {
      db.run(
        `INSERT INTO reports (type, period_start, period_end, project_ids, content, completeness, digest_json)
         VALUES ('weekly', ?, ?, ?, ?, ?, ?)
         ON CONFLICT(type, period_start, period_end)
         DO UPDATE SET content = excluded.content,
                       completeness = excluded.completeness,
                       project_ids = excluded.project_ids,
                       digest_json = excluded.digest_json`,
        [
          promptReport.input.period.startUnix,
          promptReport.input.period.endUnix,
          weeklyProjectIds,
          weeklyJson,
          weeklyCompletenessJson,
          weeklyDigestJson,
        ]
      );

      const weeklyRow = db
        .query<{ id: number }, [string, number, number]>(
          "SELECT id FROM reports WHERE type = ? AND period_start = ? AND period_end = ?"
        )
        .get("weekly", promptReport.input.period.startUnix, promptReport.input.period.endUnix)!;
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
      const weeklyDate = `weekly-${formatDate(promptReport.input.period.endUnix, timezone)}`;
      const filePath = writeReportFile({
        date: weeklyDate,
        card: weeklyCard,
        analyses: [],
        completeness: {
          ...completeness,
          status: "prompt-action-oriented",
          prTotal: promptReport.input.activitySummary.totalPrs,
        },
      });
      console.log(`[Report] Weekly written to ${filePath}`);
    } catch (err) {
      const msg = `Weekly file write failed: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[Report] ${msg}`);
      errors.push(msg);
    }

    return errors;
  } catch (err) {
    errors.push(`Weekly prompt report failed: ${err instanceof Error ? err.message : String(err)}`);
    return errors;
  }
}

async function generateMonthlyReport(
  db: Database,
  completeness: { total: number; success: number; failed: string[] },
  timezone: string,
  month?: string
): Promise<string[]> {
  const errors: string[] = [];
  try {
    const promptReport = await generateMonthlyPromptReport(db, timezone, {
      month: month ?? getPreviousMonthString(timezone),
    });
    const dailyCov = promptReport.input.coverage.dailyReports;
    const monthlyCard = buildMonthlyPromptCard({
      monthLabel: formatMonthLabel(promptReport.input.period.month),
      periodLabel: promptReport.input.period.label,
      markdown: promptReport.markdown,
      totalPrs: promptReport.input.activitySummary.totalPrs,
      projectCount: promptReport.input.activitySummary.projectCount,
      isPartial: promptReport.input.period.isPartial,
      dailyCoverage: {
        present: dailyCov.present,
        missing: dailyCov.missing,
        total: dailyCov.present + dailyCov.nullDigest + dailyCov.missing,
      },
    });
    const monthlyJson = JSON.stringify(monthlyCard);

    const monthlyBytes = Buffer.byteLength(monthlyJson, "utf-8");
    if (monthlyBytes > 30_000) {
      console.warn(`[Report] Monthly card exceeds 30KB hard limit (${monthlyBytes} bytes) — sending anyway`);
    } else if (monthlyBytes > 20_000) {
      console.warn(`[Report] Monthly card exceeds 20KB warn threshold (${monthlyBytes} bytes)`);
    }

    const monthlyProjectIds = JSON.stringify(
      promptReport.input.projects.map((p) => p.projectId)
    );
    const monthlyCompletenessJson = JSON.stringify({
      ...completeness,
      prompt: "executive-trajectory",
      usage: promptReport.usage,
    });
    const monthlyDigestJson = JSON.stringify(promptReport.input);

    try {
      db.run(
        `INSERT INTO reports (type, period_start, period_end, project_ids, content, completeness, digest_json)
         VALUES ('monthly', ?, ?, ?, ?, ?, ?)
         ON CONFLICT(type, period_start, period_end)
         DO UPDATE SET content = excluded.content,
                       completeness = excluded.completeness,
                       project_ids = excluded.project_ids,
                       digest_json = excluded.digest_json`,
        [
          promptReport.input.period.startUnix,
          promptReport.input.period.endUnix,
          monthlyProjectIds,
          monthlyJson,
          monthlyCompletenessJson,
          monthlyDigestJson,
        ]
      );

      const monthlyRow = db
        .query<{ id: number }, [string, number, number]>(
          "SELECT id FROM reports WHERE type = ? AND period_start = ? AND period_end = ?"
        )
        .get("monthly", promptReport.input.period.startUnix, promptReport.input.period.endUnix)!;
      db.run(
        `INSERT INTO report_deliveries (report_id, card_index, content) VALUES (?, 0, ?)
         ON CONFLICT(report_id, card_index)
         DO UPDATE SET content = excluded.content
         WHERE report_deliveries.status != 'sent'`,
        [monthlyRow.id, monthlyJson]
      );
      db.run(
        "DELETE FROM report_deliveries WHERE report_id = ? AND card_index >= 1 AND status != 'sent'",
        [monthlyRow.id]
      );
    } catch (err) {
      const msg = `Monthly DB upsert failed: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[Report] ${msg}`);
      errors.push(msg);
    }

    try {
      const monthlyDate = `monthly-${promptReport.input.period.month}`;
      const filePath = writeReportFile({
        date: monthlyDate,
        card: monthlyCard,
        analyses: [],
        completeness: {
          ...completeness,
          status: "prompt-executive-trajectory",
          prTotal: promptReport.input.activitySummary.totalPrs,
        },
      });
      console.log(`[Report] Monthly written to ${filePath}`);
    } catch (err) {
      const msg = `Monthly file write failed: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[Report] ${msg}`);
      errors.push(msg);
    }

    return errors;
  } catch (err) {
    errors.push(`Monthly prompt report failed: ${err instanceof Error ? err.message : String(err)}`);
    return errors;
  }
}

export const stage: PipelineStage = {
  name: "report",
  execute,
};
