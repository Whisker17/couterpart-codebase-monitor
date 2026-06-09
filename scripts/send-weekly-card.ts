/**
 * Generate and send the weekly prompt card to Lark.
 *
 * Usage:
 *   bun run scripts/send-weekly-card.ts
 *   bun run scripts/send-weekly-card.ts --dry-run          # generate only, don't send
 *   bun run scripts/send-weekly-card.ts --date 2026-06-08  # anchor to a specific week
 */
import { getDb, closeDb } from "../src/storage/db";
import { getSettings } from "../src/config/settings";
import { generateWeeklyPromptReport } from "../src/extensions/report-generator/weekly-prompt-report";
import { buildWeeklyPromptCard } from "../src/extensions/report-generator/templates/weekly-prompt-card";
import { sendCard } from "../src/extensions/lark-dispatcher/webhook";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dateIdx = args.indexOf("--date");
const dateArg = dateIdx !== -1 ? args[dateIdx + 1] : undefined;

const db = getDb();
const settings = getSettings();
const tz = settings.schedule.timezone;

try {
  const now = dateArg ? new Date(`${dateArg}T12:00:00Z`) : undefined;
  console.log(`[send-weekly-card] Generating weekly report (tz=${tz}${dateArg ? `, date=${dateArg}` : ""})...`);

  const result = await generateWeeklyPromptReport(db, tz, { now });

  const fmt = (unix: number) =>
    new Date(unix * 1000).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric", timeZone: tz });
  const dateRange = `${fmt(result.input.period.startUnix)}-${fmt(result.input.period.endUnix)}`;

  const card = buildWeeklyPromptCard({
    dateRange,
    markdown: result.markdown,
    totalPrs: result.input.activitySummary.totalPrs,
    projectCount: result.input.activitySummary.projectCount,
  });

  const json = JSON.stringify(card, null, 2);
  const bytes = Buffer.byteLength(json, "utf-8");
  const outPath = "data/reports/prompt-lab/weekly-card-test.json";
  await Bun.write(outPath, json);

  console.log(`[send-weekly-card] Card: ${bytes} bytes, ${card.elements.filter((e) => e.tag === "collapsible_panel").length} panels`);
  console.log(`[send-weekly-card] Usage: input=${result.usage.inputTokens}, output=${result.usage.outputTokens}`);
  console.log(`[send-weekly-card] Saved to ${outPath}`);

  if (dryRun) {
    console.log("[send-weekly-card] Dry run — skipping Lark send.");
  } else {
    const webhookUrl = process.env.LARK_WEBHOOK_URL;
    if (!webhookUrl) {
      console.error("[send-weekly-card] LARK_WEBHOOK_URL not set in environment.");
      process.exit(1);
    }
    const resp = await sendCard(webhookUrl, card);
    if (resp.code === 0) {
      console.log("[send-weekly-card] Sent to Lark successfully.");
    } else {
      console.error(`[send-weekly-card] Lark error: ${JSON.stringify(resp)}`);
      process.exit(1);
    }
  }
} finally {
  closeDb();
}
