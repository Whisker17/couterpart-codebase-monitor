import type { PipelineContext, PipelineStage, StageResult } from "../runner";
import { getDb } from "../../storage/db";
import { getSettings } from "../../config/settings";
import { sendCard } from "../../extensions/lark-dispatcher/webhook";
import { parseAndTrimCard } from "../../extensions/lark-dispatcher/formatter";

interface ReportRow {
  id: number;
  content: string;
}

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

  const unsent = db
    .query<ReportRow, []>("SELECT id, content FROM reports WHERE sent_at IS NULL")
    .all();

  for (const report of unsent) {
    // Ensure a delivery row exists — one card per report (card_index = 0)
    db.run(
      "INSERT OR IGNORE INTO report_deliveries (report_id, card_index, content) VALUES (?, 0, ?)",
      [report.id, report.content]
    );

    const pending = db
      .query<DeliveryRow, [number]>(
        "SELECT id, report_id, card_index, content, status FROM report_deliveries WHERE report_id = ? AND status != 'sent'"
      )
      .all(report.id);

    for (const delivery of pending) {
      let card: object;
      try {
        card = parseAndTrimCard(delivery.content);
      } catch (err) {
        const msg = `Report ${report.id} delivery ${delivery.id}: failed to parse card — ${err instanceof Error ? err.message : String(err)}`;
        console.error(`[Dispatcher] ${msg}`);
        errors.push(msg);
        db.run("UPDATE report_deliveries SET status = 'failed' WHERE id = ?", [delivery.id]);
        continue;
      }

      const result = await sendCard(webhookUrl, card);

      if (result.code === 0) {
        db.run(
          "UPDATE report_deliveries SET status = 'sent', lark_message_id = ?, sent_at = ? WHERE id = ?",
          [result.data?.message_id ?? null, unixNow(), delivery.id]
        );
        itemsProcessed++;
      } else {
        const msg = `Report ${report.id} delivery ${delivery.id}: Lark error code=${result.code} msg=${result.msg}`;
        console.error(`[Dispatcher] ${msg}`);
        errors.push(msg);
        db.run("UPDATE report_deliveries SET status = 'failed' WHERE id = ?", [delivery.id]);
      }
    }

    // Mark report sent only when ALL deliveries for it are sent
    const remaining = db
      .query<CountRow, [number]>(
        "SELECT COUNT(*) as cnt FROM report_deliveries WHERE report_id = ? AND status != 'sent'"
      )
      .get(report.id);

    if (remaining && remaining.cnt === 0) {
      db.run("UPDATE reports SET sent_at = ? WHERE id = ?", [unixNow(), report.id]);
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
