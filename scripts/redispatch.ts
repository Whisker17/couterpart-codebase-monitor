/**
 * Debug script — reset latest daily report delivery status and re-send to Lark.
 *
 * Usage:
 *   bun run scripts/redispatch.ts                        # dry-run: show what would be reset
 *   bun run scripts/redispatch.ts --yes                   # reset + full daily E2E
 *   bun run scripts/redispatch.ts --yes --dispatch-only   # reset + dispatch only (re-send existing card)
 */
import { validateEnv, getSettings } from "../src/config/settings";
import { getDb, closeDb } from "../src/storage/db";
import { runPipeline, type PipelineStage } from "../src/pipeline/runner";
import { stage as collect } from "../src/pipeline/stages/collect";
import { stage as analyze } from "../src/pipeline/stages/analyze";
import { stage as report } from "../src/pipeline/stages/report";
import { sendCard } from "../src/extensions/lark-dispatcher/webhook";
import { printPostRunSummary } from "../src/e2e-run";
import { getYesterdayPeriod } from "../src/utils/time-window";

interface ReportRow {
  id: number;
  type: string;
  period_start: number;
  sent_at: number | null;
}

interface DeliveryRow {
  id: number;
  card_index: number;
  status: string;
  content: string;
}

function findLatestDailyReport(): { report: ReportRow; deliveries: DeliveryRow[] } | null {
  const db = getDb();

  const latestReport = db
    .query<ReportRow, []>(
      "SELECT id, type, period_start, sent_at FROM reports WHERE type = 'daily' ORDER BY period_start DESC LIMIT 1"
    )
    .get();

  if (!latestReport) {
    console.log("[Redispatch] No daily reports found in database.");
    return null;
  }

  const deliveries = db
    .query<DeliveryRow, [number]>(
      "SELECT id, card_index, status, content FROM report_deliveries WHERE report_id = ?"
    )
    .all(latestReport.id);

  return { report: latestReport, deliveries };
}

function findReportByPeriod(periodStart: number): { report: ReportRow; deliveries: DeliveryRow[] } | null {
  const db = getDb();

  const row = db
    .query<ReportRow, [number]>(
      "SELECT id, type, period_start, sent_at FROM reports WHERE type = 'daily' AND period_start = ? LIMIT 1"
    )
    .get(periodStart);

  if (!row) return null;

  const deliveries = db
    .query<DeliveryRow, [number]>(
      "SELECT id, card_index, status, content FROM report_deliveries WHERE report_id = ?"
    )
    .all(row.id);

  return { report: row, deliveries };
}

function printDryRun(report: ReportRow, deliveries: DeliveryRow[], webhookUrl: string | undefined): void {
  const date = new Date(report.period_start * 1000).toISOString().slice(0, 10);
  console.log(`[Dry-run] Target report: #${report.id} (${date}), sent_at=${report.sent_at ? "yes" : "no"}`);
  console.log(`[Dry-run] Deliveries (${deliveries.length}):`);
  for (const d of deliveries) {
    const bytes = Buffer.byteLength(d.content, "utf-8");
    console.log(`  card_${d.card_index}: status=${d.status}, ${bytes} bytes`);
  }
  const toReset = deliveries.filter((d) => d.status !== "pending");
  if (toReset.length === 0) {
    console.log("[Dry-run] All deliveries already pending — nothing to reset.");
  } else {
    console.log(`[Dry-run] Would reset ${toReset.length} delivery(ies) to pending.`);
  }
  if (!webhookUrl) {
    console.warn("[Dry-run] ⚠ LARK_WEBHOOK_URL is not set — execution would fail.");
  }
  console.log("\nRe-run with --yes to execute.");
}

function resetDeliveries(reportId: number, deliveries: DeliveryRow[]): number {
  const db = getDb();
  const nonPending = deliveries.filter((d) => d.status !== "pending");

  if (nonPending.length === 0) return 0;

  db.run(
    "UPDATE report_deliveries SET status = 'pending', lark_message_id = NULL, sent_at = NULL WHERE report_id = ?",
    [reportId]
  );
  db.run("UPDATE reports SET sent_at = NULL WHERE id = ?", [reportId]);

  console.log(`[Redispatch] Reset ${nonPending.length} delivery(ies) to pending, cleared reports.sent_at`);
  return nonPending.length;
}

async function scopedDispatch(reportId: number, webhookUrl: string): Promise<{ sent: number; failed: number; errors: string[] }> {
  const db = getDb();

  const pending = db
    .query<DeliveryRow, [number]>(
      "SELECT id, card_index, status, content FROM report_deliveries WHERE report_id = ? AND status = 'pending'"
    )
    .all(reportId);

  let sent = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const delivery of pending) {
    let card: object;
    try {
      card = JSON.parse(delivery.content) as object;
    } catch (err) {
      const msg = `Delivery ${delivery.id}: failed to parse card — ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[Redispatch] ${msg}`);
      errors.push(msg);
      db.run("UPDATE report_deliveries SET status = 'failed' WHERE id = ?", [delivery.id]);
      failed++;
      continue;
    }

    let result: Awaited<ReturnType<typeof sendCard>>;
    try {
      result = await sendCard(webhookUrl, card);
    } catch (err) {
      const msg = `Delivery ${delivery.id}: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[Redispatch] ${msg}`);
      errors.push(msg);
      db.run("UPDATE report_deliveries SET status = 'failed' WHERE id = ?", [delivery.id]);
      failed++;
      continue;
    }

    const now = Math.floor(Date.now() / 1000);

    if (result.code === 0) {
      db.run(
        "UPDATE report_deliveries SET status = 'sent', lark_message_id = ?, sent_at = ? WHERE id = ?",
        [result.data?.message_id ?? null, now, delivery.id]
      );
      console.log(`[Redispatch] card_${delivery.card_index}: sent (message_id=${result.data?.message_id ?? "n/a"})`);
      sent++;
    } else {
      const msg = `Delivery ${delivery.id}: Lark error code=${result.code} msg=${result.msg}`;
      console.error(`[Redispatch] ${msg}`);
      errors.push(msg);
      db.run("UPDATE report_deliveries SET status = 'failed' WHERE id = ?", [delivery.id]);
      failed++;
    }
  }

  const remaining = db
    .query<{ cnt: number }, [number]>(
      "SELECT COUNT(*) as cnt FROM report_deliveries WHERE report_id = ? AND status != 'sent'"
    )
    .get(reportId);

  if (remaining && remaining.cnt === 0) {
    db.run("UPDATE reports SET sent_at = ? WHERE id = ?", [Math.floor(Date.now() / 1000), reportId]);
  }

  return { sent, failed, errors };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const confirmed = args.includes("--yes");
  const dispatchOnly = args.includes("--dispatch-only");

  validateEnv();

  const webhookUrl = getSettings().lark.webhookUrl;
  const db = getDb();
  const found = findLatestDailyReport();
  if (!found) return 1;

  const { report: targetReport, deliveries } = found;

  if (deliveries.length === 0) {
    console.log("[Redispatch] No deliveries found for this report.");
    return 1;
  }

  if (!confirmed) {
    printDryRun(targetReport, deliveries, webhookUrl);
    return 0;
  }

  if (!webhookUrl) {
    console.error("[Redispatch] LARK_WEBHOOK_URL is not set. Cannot dispatch.");
    return 1;
  }

  const date = new Date(targetReport.period_start * 1000).toISOString().slice(0, 10);
  console.log(`[Redispatch] Target: report #${targetReport.id} (${date})`);

  const maxIdRow = db.query<{ maxId: number }, []>("SELECT COALESCE(MAX(id), 0) as maxId FROM analyses").get()!;
  const maxAnalysisIdBefore = maxIdRow.maxId;
  const timezone = getSettings().schedule.timezone;

  if (dispatchOnly) {
    resetDeliveries(targetReport.id, deliveries);
    console.log("\n[Redispatch] Sending cards for report #" + targetReport.id + " only...\n");
    const { sent, failed, errors } = await scopedDispatch(targetReport.id, webhookUrl);
    console.log(`\n[Redispatch] Done: ${sent} sent, ${failed} failed`);
    if (errors.length > 0) {
      for (const e of errors) console.error(`  ${e}`);
    }
    return failed > 0 ? 1 : 0;
  }

  console.log("\n[Redispatch] Running full daily E2E pipeline...\n");
  const stages: PipelineStage[] = [collect, analyze, report];
  const stageNames = [...stages.map((s) => s.name), "dispatch (scoped)"].join(" → ");
  console.log(`[E2E] Stages: ${stageNames}`);

  const start = Date.now();
  const results = await runPipeline(stages, { reportMode: "daily", timezone });

  // After report stage, re-query the current daily period's report for dispatch
  const { startUnix } = getYesterdayPeriod(timezone);
  const currentPeriodReport = findReportByPeriod(startUnix);
  if (!currentPeriodReport) {
    console.error("[Redispatch] Current daily-period report was not found after report stage; aborting dispatch.");
    results.set("dispatch", {
      success: false,
      itemsProcessed: 0,
      errors: ["Current daily-period report was not found after report stage"],
      durationMs: 0,
    });
    return printPostRunSummary("daily", false, results, maxAnalysisIdBefore);
  }

  const dispatchReportId = currentPeriodReport.report.id;
  if (dispatchReportId !== targetReport.id) {
    console.log(`[Redispatch] Report stage created/updated report #${currentPeriodReport.report.id} for current period — dispatching that instead of #${targetReport.id}`);
  }
  resetDeliveries(dispatchReportId, currentPeriodReport.deliveries);

  console.log("\n[Redispatch] Running scoped dispatch for report #" + dispatchReportId + "...");
  const { sent, failed, errors } = await scopedDispatch(dispatchReportId, webhookUrl);
  results.set("dispatch", {
    success: failed === 0,
    itemsProcessed: sent,
    errors,
    durationMs: 0,
  });

  const totalMs = Date.now() - start;
  console.log(`\n[E2E] Pipeline complete in ${(totalMs / 1000).toFixed(1)}s`);
  return printPostRunSummary("daily", false, results, maxAnalysisIdBefore);
}

main()
  .then((code) => {
    closeDb();
    process.exit(code);
  })
  .catch((err) => {
    console.error("[Redispatch] Fatal error:", err);
    closeDb();
    process.exit(1);
  });
