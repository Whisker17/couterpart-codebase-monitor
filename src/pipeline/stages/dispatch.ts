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

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

export async function execute(_ctx: PipelineContext): Promise<StageResult> {
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
