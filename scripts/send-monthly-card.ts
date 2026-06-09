/**
 * Generate and send the monthly prompt card to Lark.
 *
 * Usage:
 *   bun run scripts/send-monthly-card.ts --month 2026-06
 *   bun run scripts/send-monthly-card.ts --dry-run
 */
import { getDb, closeDb } from "../src/storage/db";
import { getSettings } from "../src/config/settings";
import { generateMonthlyPromptReport } from "../src/extensions/report-generator/monthly-prompt-report";
import { buildMonthlyPromptCard } from "../src/extensions/report-generator/templates/monthly-prompt-card";
import { sendCard } from "../src/extensions/lark-dispatcher/webhook";

function parseArgValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

function formatMonthLabel(month: string): string {
  const [year, rawMonth] = month.split("-");
  return `${year}年${Number(rawMonth)}月`;
}

const dryRun = process.argv.includes("--dry-run");
const monthArg = parseArgValue("--month");

const db = getDb();
const settings = getSettings();
const tz = settings.schedule.timezone;

try {
  console.log(
    `[send-monthly-card] Generating monthly report (tz=${tz}${monthArg ? `, month=${monthArg}` : ""}, prompt=executive-trajectory)...`
  );

  const result = await generateMonthlyPromptReport(db, tz, { month: monthArg });
  const card = buildMonthlyPromptCard({
    monthLabel: formatMonthLabel(result.input.period.month),
    periodLabel: result.input.period.label,
    markdown: result.markdown,
    totalPrs: result.input.activitySummary.totalPrs,
    projectCount: result.input.activitySummary.projectCount,
    isPartial: result.input.period.isPartial,
  });

  const json = JSON.stringify(card, null, 2);
  const bytes = Buffer.byteLength(json, "utf-8");
  const outPath = "data/reports/prompt-lab/monthly-card-test.json";
  await Bun.write(outPath, json);

  console.log(
    `[send-monthly-card] Card: ${bytes} bytes, ${card.elements.filter((e) => e.tag === "collapsible_panel").length} panels`
  );
  console.log(
    `[send-monthly-card] PRs: ${result.input.activitySummary.totalPrs}, period=${result.input.period.label}`
  );
  console.log(
    `[send-monthly-card] Usage: input=${result.usage.inputTokens}, output=${result.usage.outputTokens}`
  );
  console.log(`[send-monthly-card] Saved to ${outPath}`);

  if (dryRun) {
    console.log("[send-monthly-card] Dry run — skipping Lark send.");
  } else {
    const webhookUrl = process.env.LARK_WEBHOOK_URL;
    if (!webhookUrl) {
      console.error("[send-monthly-card] LARK_WEBHOOK_URL not set in environment.");
      process.exit(1);
    }
    const resp = await sendCard(webhookUrl, card);
    if (resp.code === 0) {
      console.log("[send-monthly-card] Sent to Lark successfully.");
    } else {
      console.error(`[send-monthly-card] Lark error: ${JSON.stringify(resp)}`);
      process.exit(1);
    }
  }
} finally {
  closeDb();
}
