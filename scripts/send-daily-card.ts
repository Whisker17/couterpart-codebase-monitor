/**
 * Generate and send a daily prompt card to Lark.
 *
 * Usage:
 *   bun run scripts/send-daily-card.ts
 *   bun run scripts/send-daily-card.ts --dry-run
 *   bun run scripts/send-daily-card.ts --date 2026-06-07
 *   bun run scripts/send-daily-card.ts --prompt prompts/reports/daily/significance-first.md
 */
import { readFile } from "fs/promises";
import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { getDb, closeDb } from "../src/storage/db";
import { getSettings } from "../src/config/settings";
import { buildDailyPromptInput, renderDailyPrompt } from "../src/extensions/report-generator/daily-prompt-input";
import { buildDailyPromptCard } from "../src/extensions/report-generator/templates/daily-prompt-card";
import { sendCard } from "../src/extensions/lark-dispatcher/webhook";

const DEFAULT_PROMPT = "prompts/reports/daily/structured-table.md";
const MAX_OUTPUT_TOKENS = 4096;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dateIdx = args.indexOf("--date");
const dateArg = dateIdx !== -1 ? args[dateIdx + 1] : undefined;
const promptIdx = args.indexOf("--prompt");
const promptPath = promptIdx !== -1 ? args[promptIdx + 1]! : DEFAULT_PROMPT;

function resolveBaseUrl(rawUrl: string): string | undefined {
  if (!rawUrl) return undefined;
  const trimmed = rawUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

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

  const template = await readFile(promptPath, "utf-8");
  const prompt = renderDailyPrompt(template, input);

  let markdown: string;
  let usage = { inputTokens: 0, outputTokens: 0 };

  if (dryRun) {
    markdown = `## 总览\n\nDry run — ${input.activitySummary.totalPrs} PRs across ${input.activitySummary.projectCount} projects.\nReview the rendered prompt at data/reports/prompt-lab/daily-card-test-prompt.md`;
    await Bun.write("data/reports/prompt-lab/daily-card-test-prompt.md", prompt);
    console.log("[send-daily-card] Prompt written to data/reports/prompt-lab/daily-card-test-prompt.md");
  } else {
    if (!settings.llm.apiKey || !settings.llm.baseUrl) {
      console.error("[send-daily-card] LLM credentials missing. Set LLM_BASE_URL and LLM_API_KEY, or use --dry-run.");
      process.exit(1);
    }
    const anthropic = createAnthropic({
      baseURL: resolveBaseUrl(settings.llm.baseUrl),
      apiKey: settings.llm.apiKey,
    });
    const result = await generateText({
      model: anthropic(settings.llm.model),
      prompt,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      maxRetries: 2,
    });
    markdown = result.text;
    usage = { inputTokens: result.usage.inputTokens ?? 0, outputTokens: result.usage.outputTokens ?? 0 };
  }

  const card = buildDailyPromptCard({
    date: input.period.date,
    markdown,
    totalPrs: input.activitySummary.totalPrs,
    projectCount: input.activitySummary.projectCount,
    directionalShiftCount: input.activitySummary.directionalShiftCount,
    notableCount: input.activitySummary.notableCount,
    routineCount: input.activitySummary.routineCount,
    projects: input.projects,
  });

  const json = JSON.stringify(card, null, 2);
  const bytes = Buffer.byteLength(json, "utf-8");
  const outPath = "data/reports/prompt-lab/daily-card-test.json";
  await Bun.write(outPath, json);

  console.log(`[send-daily-card] Card: ${bytes} bytes, ${input.period.date}`);
  console.log(`[send-daily-card] PRs: ${input.activitySummary.totalPrs} (🔴${input.activitySummary.directionalShiftCount} 🟡${input.activitySummary.notableCount} ⚪${input.activitySummary.routineCount})`);
  if (!dryRun) console.log(`[send-daily-card] Usage: input=${usage.inputTokens}, output=${usage.outputTokens}`);
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
