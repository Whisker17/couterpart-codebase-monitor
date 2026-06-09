import { readFile } from "fs/promises";
import type { Database } from "bun:sqlite";
import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { getSettings } from "../../config/settings";
import {
  buildWeeklyPromptInput,
  renderWeeklyPrompt,
  type WeeklyPromptInput,
} from "./weekly-prompt-input";

const ACTION_ORIENTED_PROMPT_PATH = "prompts/reports/weekly/action-oriented.md";
const MAX_OUTPUT_TOKENS = 4096;

interface GenerateWeeklyPromptOptions {
  prompt: string;
  maxOutputTokens: number;
}

interface GeneratedWeeklyPromptText {
  text: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

type GenerateWeeklyPromptTextFn = (
  options: GenerateWeeklyPromptOptions
) => Promise<GeneratedWeeklyPromptText>;

export interface WeeklyPromptReportResult {
  markdown: string;
  input: WeeklyPromptInput;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface WeeklyPromptReportDeps {
  generateFn?: GenerateWeeklyPromptTextFn;
  promptPath?: string;
  now?: Date;
}

function resolveAnthropicBaseUrl(rawUrl: string): string | undefined {
  if (!rawUrl) return undefined;
  const trimmed = rawUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

async function defaultGenerateText({
  prompt,
  maxOutputTokens,
}: GenerateWeeklyPromptOptions): Promise<GeneratedWeeklyPromptText> {
  const settings = getSettings();
  if (!settings.llm.apiKey || !settings.llm.baseUrl) {
    throw new Error("LLM credentials missing for weekly prompt report");
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

export async function generateWeeklyPromptReport(
  db: Database,
  timezone: string,
  deps: WeeklyPromptReportDeps = {}
): Promise<WeeklyPromptReportResult> {
  const input = buildWeeklyPromptInput(db, timezone, deps.now);
  if (input.activitySummary.totalPrs === 0) {
    throw new Error("No weekly analyses available for prompt report");
  }

  const promptTemplate = await readFile(deps.promptPath ?? ACTION_ORIENTED_PROMPT_PATH, "utf-8");
  const prompt = renderWeeklyPrompt(promptTemplate, input);
  const generateFn = deps.generateFn ?? defaultGenerateText;
  const generated = await generateFn({ prompt, maxOutputTokens: MAX_OUTPUT_TOKENS });

  return {
    markdown: generated.text,
    input,
    usage: {
      inputTokens: generated.usage?.inputTokens ?? 0,
      outputTokens: generated.usage?.outputTokens ?? 0,
    },
  };
}
