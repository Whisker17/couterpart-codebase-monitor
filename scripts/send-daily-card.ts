/**
 * Generate and send a daily prompt card to Lark.
 *
 * Usage:
 *   bun run scripts/send-daily-card.ts
 *   bun run scripts/send-daily-card.ts --dry-run
 *   bun run scripts/send-daily-card.ts --date 2026-06-07
 *   bun run scripts/send-daily-card.ts --prompt prompts/reports/daily/significance-first.md
 */
import { getDb, closeDb } from "../src/storage/db";
import { getSettings } from "../src/config/settings";
import { buildDailyPromptInput } from "../src/extensions/report-generator/daily-prompt-input";
import {
  DEFAULT_DAILY_PROMPT_PATH,
  generateDailyPromptReport,
} from "../src/extensions/report-generator/daily-prompt-report";
import { buildDailyPromptCard } from "../src/extensions/report-generator/templates/daily-prompt-card";
import { sendCard } from "../src/extensions/lark-dispatcher/webhook";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dateIdx = args.indexOf("--date");
const dateArg = dateIdx !== -1 ? args[dateIdx + 1] : undefined;
const promptIdx = args.indexOf("--prompt");
const promptPath = promptIdx !== -1 ? args[promptIdx + 1]! : DEFAULT_DAILY_PROMPT_PATH;

const db = getDb();
const settings = getSettings();
const tz = settings.schedule.timezone;

try {
  const now = dateArg ? new Date(`${dateArg}T12:00:00Z`) : undefined;
  console.log(`[send-daily-card] Generating (tz=${tz}${dateArg ? `, date=${dateArg}` : ""}, prompt=${promptPath})...`);

  const input = buildDailyPromptInput(db, tz, now);
  if (input.activitySummary.totalPrs === 0) {
    console.log(`[send-daily-card] No PRs for ${input.period.date}. Nothing to send.`);
    process.exit(0);
  }

  const report = await generateDailyPromptReport(db, tz, {
    promptPath,
    now,
    ...(dryRun
      ? {
          generateFn: async ({ prompt }) => {
            await Bun.write("data/reports/prompt-lab/daily-card-test-prompt.md", prompt);
            console.log("[send-daily-card] Prompt written to data/reports/prompt-lab/daily-card-test-prompt.md");
            return {
              text: `## 总览\n\nDry run — ${input.activitySummary.totalPrs} PRs across ${input.activitySummary.projectCount} projects.\nReview the rendered prompt at data/reports/prompt-lab/daily-card-test-prompt.md`,
              usage: { inputTokens: 0, outputTokens: 0 },
            };
          },
        }
      : {}),
  });

  const card = buildDailyPromptCard({
    date: report.input.period.date,
    markdown: report.markdown,
    totalPrs: report.input.activitySummary.totalPrs,
    projectCount: report.input.activitySummary.projectCount,
    directionalShiftCount: report.input.activitySummary.directionalShiftCount,
    notableCount: report.input.activitySummary.notableCount,
    routineCount: report.input.activitySummary.routineCount,
    projects: report.input.projects,
  });

  const json = JSON.stringify(card, null, 2);
  const bytes = Buffer.byteLength(json, "utf-8");
  const outPath = "data/reports/prompt-lab/daily-card-test.json";
  await Bun.write(outPath, json);

  console.log(`[send-daily-card] Card: ${bytes} bytes, ${input.period.date}`);
  console.log(`[send-daily-card] PRs: ${input.activitySummary.totalPrs} (🔴${input.activitySummary.directionalShiftCount} 🟡${input.activitySummary.notableCount} ⚪${input.activitySummary.routineCount})`);
  if (!dryRun) console.log(`[send-daily-card] Usage: input=${report.usage.inputTokens}, output=${report.usage.outputTokens}`);
  console.log(`[send-daily-card] Saved to ${outPath}`);

  if (dryRun) {
    console.log("[send-daily-card] Dry run — skipping Lark send.");
  } else {
    const webhookUrl = process.env.LARK_WEBHOOK_URL;
    if (!webhookUrl) {
      console.error("[send-daily-card] LARK_WEBHOOK_URL not set in environment.");
      process.exit(1);
    }
    const resp = await sendCard(webhookUrl, card);
    if (resp.code === 0) {
      console.log("[send-daily-card] Sent to Lark successfully.");
    } else {
      console.error(`[send-daily-card] Lark error: ${JSON.stringify(resp)}`);
      process.exit(1);
    }
  }
} finally {
  closeDb();
}
