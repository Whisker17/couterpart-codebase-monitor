import { readFile } from "fs/promises";
import type { Database } from "bun:sqlite";
import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { basename, extname } from "path";
import { getSettings } from "../../config/settings";
import {
  buildDailyPromptInput,
  buildDailyPromptInputForPeriod,
  renderDailyPrompt,
  type DailyPromptInput,
} from "./daily-prompt-input";

export const DEFAULT_DAILY_PROMPT_PATH = "prompts/reports/daily/structured-table.md";
const MAX_OUTPUT_TOKENS = 4096;

interface GenerateDailyPromptOptions {
  prompt: string;
  maxOutputTokens: number;
}

interface GeneratedDailyPromptText {
  text: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

type GenerateDailyPromptTextFn = (
  options: GenerateDailyPromptOptions
) => Promise<GeneratedDailyPromptText>;

export interface DailyPromptReportResult {
  markdown: string;
  input: DailyPromptInput;
  promptPath: string;
  promptName: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface DailyPromptReportDeps {
  generateFn?: GenerateDailyPromptTextFn;
  promptPath?: string;
  now?: Date;
}

function resolveAnthropicBaseUrl(rawUrl: string): string | undefined {
  if (!rawUrl) return undefined;
  const trimmed = rawUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function promptName(path: string): string {
  const raw = basename(path, extname(path)).toLowerCase();
  return raw.replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "prompt";
}

async function defaultGenerateText({
  prompt,
  maxOutputTokens,
}: GenerateDailyPromptOptions): Promise<GeneratedDailyPromptText> {
  const settings = getSettings();
  if (!settings.llm.apiKey || !settings.llm.baseUrl) {
    throw new Error("LLM credentials missing for daily prompt report");
  }

  const anthropic = createAnthropic({
    baseURL: resolveAnthropicBaseUrl(settings.llm.baseUrl),
    apiKey: settings.llm.apiKey,
  });

  const result = await generateText({
    model: anthropic(settings.llm.model),
    prompt,
    maxOutputTokens,
    maxRetries: 2,
  });

  return {
    text: result.text,
    usage: {
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
    },
  };
}

export async function generateDailyPromptReport(
  db: Database,
  timezone: string,
  deps: DailyPromptReportDeps = {}
): Promise<DailyPromptReportResult> {
  const input = buildDailyPromptInput(db, timezone, deps.now);
  return generateDailyPromptReportFromInput(input, deps);
}

export async function generateDailyPromptReportForPeriod(
  db: Database,
  timezone: string,
  startUnix: number,
  endUnix: number,
  deps: Omit<DailyPromptReportDeps, "now"> = {}
): Promise<DailyPromptReportResult> {
  const input = buildDailyPromptInputForPeriod(db, timezone, startUnix, endUnix);
  return generateDailyPromptReportFromInput(input, deps);
}

async function generateDailyPromptReportFromInput(
  input: DailyPromptInput,
  deps: Omit<DailyPromptReportDeps, "now"> = {}
): Promise<DailyPromptReportResult> {
  if (input.activitySummary.totalPrs === 0) {
    throw new Error("No daily analyses available for prompt report");
  }

  const promptPath = deps.promptPath ?? DEFAULT_DAILY_PROMPT_PATH;
  const promptTemplate = await readFile(promptPath, "utf-8");
  const prompt = renderDailyPrompt(promptTemplate, input);
  const generateFn = deps.generateFn ?? defaultGenerateText;
  const generated = await generateFn({ prompt, maxOutputTokens: MAX_OUTPUT_TOKENS });

  return {
    markdown: generated.text,
    input,
    promptPath,
    promptName: promptName(promptPath),
    usage: {
      inputTokens: generated.usage?.inputTokens ?? 0,
      outputTokens: generated.usage?.outputTokens ?? 0,
    },
  };
}
