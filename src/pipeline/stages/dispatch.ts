import type { PipelineContext, PipelineStage, StageResult } from "../runner";
import { getDb } from "../../storage/db";
import { getSettings } from "../../config/settings";
import { sendCard } from "../../extensions/lark-dispatcher/webhook";

interface DeliveryRow {
  id: number;
  report_id: number;
  card_index: number;
  content: string;
  status: string;
}

interface CountRow {
  cnt: number;
}

interface AlertPendingRow {
  id: number;
  alert_card_json: string;
  alert_attempt_count: number;
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

export async function execute(ctx: PipelineContext): Promise<StageResult> {
  const settings = getSettings();
  const webhookUrl = settings.lark.webhookUrl;

  if (!webhookUrl) {
    console.warn("[Dispatcher] LARK_WEBHOOK_URL not set — skipping dispatch");
    return { success: true, itemsProcessed: 0, errors: [], durationMs: 0 };
  }

  const db = getDb();
  const errors: string[] = [];
  let itemsProcessed = 0;

  const pending = db
    .query<DeliveryRow, []>(
      "SELECT id, report_id, card_index, content, status FROM report_deliveries WHERE status != 'sent'"
    )
    .all();

  const affectedReportIds = new Set<number>();

  for (const delivery of pending) {
    affectedReportIds.add(delivery.report_id);

    let card: object;
    try {
      card = JSON.parse(delivery.content) as object;
    } catch (err) {
      const msg = `Delivery ${delivery.id}: failed to parse card — ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[Dispatcher] ${msg}`);
      errors.push(msg);
      db.run("UPDATE report_deliveries SET status = 'failed' WHERE id = ?", [delivery.id]);
      continue;
    }

    let result: Awaited<ReturnType<typeof sendCard>>;
    try {
      result = await sendCard(webhookUrl, card);
    } catch (err) {
      const msg = `Delivery ${delivery.id}: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[Dispatcher] ${msg}`);
      errors.push(msg);
      db.run("UPDATE report_deliveries SET status = 'failed' WHERE id = ?", [delivery.id]);
      continue;
    }

    if (result.code === 0) {
      db.run(
        "UPDATE report_deliveries SET status = 'sent', lark_message_id = ?, sent_at = ? WHERE id = ?",
        [result.data?.message_id ?? null, unixNow(), delivery.id]
      );
      itemsProcessed++;
    } else {
      const msg = `Delivery ${delivery.id}: Lark error code=${result.code} msg=${result.msg}`;
      console.error(`[Dispatcher] ${msg}`);
      errors.push(msg);
      db.run("UPDATE report_deliveries SET status = 'failed' WHERE id = ?", [delivery.id]);
    }
  }

  // Mark reports.sent_at only when ALL deliveries for that report are sent
  for (const reportId of affectedReportIds) {
    const remaining = db
      .query<CountRow, [number]>(
        "SELECT COUNT(*) as cnt FROM report_deliveries WHERE report_id = ? AND status != 'sent'"
      )
      .get(reportId);

    if (remaining && remaining.cnt === 0) {
      db.run("UPDATE reports SET sent_at = ? WHERE id = ?", [unixNow(), reportId]);
    }
  }

  // Alert card fallback retry scan
  // Rows with attempt_count >= 5 are dead-lettered and not retried automatically
  const dispatchEnabled = ctx.dispatchEnabled !== false;
  let alertRows: AlertPendingRow[] = [];
  try {
    alertRows = db
      .query<AlertPendingRow, []>(`
        SELECT id, alert_card_json, alert_attempt_count
        FROM impact_checks
        WHERE alert_card_json IS NOT NULL
          AND alert_dispatched_at IS NULL
          AND alert_attempt_count < 5
      `)
      .all();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Only suppress errors that indicate a pre-migration schema (table or column does not exist yet).
    // Any other failure (corrupt DB, bad migration, etc.) must surface so alert cards are not silently skipped.
    const isLegacySchema =
      msg.includes("no such table: impact_checks") ||
      msg.includes("no such column: alert_card_json") ||
      msg.includes("no such column: alert_dispatched_at") ||
      msg.includes("no such column: alert_attempt_count");
    if (!isLegacySchema) {
      const surfaced = `Alert scan failed: ${msg}`;
      console.error(`[Dispatcher] ${surfaced}`);
      errors.push(surfaced);
    }
  }

  for (const alertRow of alertRows) {
    if (!dispatchEnabled) {
      // Suppressed — card stays in table, attempt count not incremented
      continue;
    }

    let card: object;
    try {
      card = JSON.parse(alertRow.alert_card_json) as object;
    } catch (err) {
      const msg = `Alert check ${alertRow.id}: failed to parse alert_card_json — ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[Dispatcher] ${msg}`);
      errors.push(msg);
      continue;
    }

    let result: Awaited<ReturnType<typeof sendCard>>;
    try {
      result = await sendCard(webhookUrl, card);
    } catch (err) {
      db.run(
        "UPDATE impact_checks SET alert_attempt_count = alert_attempt_count + 1 WHERE id = ?",
        [alertRow.id]
      );
      const msg = `Alert check ${alertRow.id}: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[Dispatcher] ${msg}`);
      errors.push(msg);
      continue;
    }

    if (result.code === 0) {
      db.run(
        "UPDATE impact_checks SET alert_dispatched_at = ?, lark_message_id = ?, alert_attempt_count = alert_attempt_count + 1 WHERE id = ?",
        [unixNow(), result.data?.message_id ?? null, alertRow.id]
      );
      itemsProcessed++;
    } else {
      db.run(
        "UPDATE impact_checks SET alert_attempt_count = alert_attempt_count + 1 WHERE id = ?",
        [alertRow.id]
      );
      const msg = `Alert check ${alertRow.id}: Lark error code=${result.code} msg=${result.msg}`;
      console.error(`[Dispatcher] ${msg}`);
      errors.push(msg);
    }
  }

  return {
    success: errors.length === 0,
    itemsProcessed,
    errors,
    durationMs: 0,
  };
}

export const stage: PipelineStage = {
  name: "dispatch",
  execute,
};
