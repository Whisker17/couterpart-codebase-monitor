import { readFile } from "fs/promises";
import type { Database } from "bun:sqlite";
import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { getSettings } from "../../config/settings";
import {
  buildMonthlyPromptInput,
  renderMonthlyPrompt,
  type MonthlyPromptInput,
} from "./monthly-prompt-input";

const EXECUTIVE_TRAJECTORY_PROMPT_PATH = "prompts/reports/monthly/executive-trajectory.md";
const MAX_OUTPUT_TOKENS = 8192;

interface GenerateMonthlyPromptOptions {
  prompt: string;
  maxOutputTokens: number;
}

interface GeneratedMonthlyPromptText {
  text: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

type GenerateMonthlyPromptTextFn = (
  options: GenerateMonthlyPromptOptions
) => Promise<GeneratedMonthlyPromptText>;

export interface MonthlyPromptReportResult {
  markdown: string;
  input: MonthlyPromptInput;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface MonthlyPromptReportDeps {
  generateFn?: GenerateMonthlyPromptTextFn;
  promptPath?: string;
  month?: string;
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
}: GenerateMonthlyPromptOptions): Promise<GeneratedMonthlyPromptText> {
  const settings = getSettings();
  if (!settings.llm.apiKey || !settings.llm.baseUrl) {
    throw new Error("LLM credentials missing for monthly prompt report");
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

export async function generateMonthlyPromptReport(
  db: Database,
  timezone: string,
  deps: MonthlyPromptReportDeps = {}
): Promise<MonthlyPromptReportResult> {
  const input = buildMonthlyPromptInput(db, timezone, {
    month: deps.month,
    now: deps.now,
  });
  if (input.activitySummary.totalPrs === 0) {
    throw new Error("No monthly analyses available for prompt report");
  }

  const promptTemplate = await readFile(
    deps.promptPath ?? EXECUTIVE_TRAJECTORY_PROMPT_PATH,
    "utf-8"
  );
  const prompt = renderMonthlyPrompt(promptTemplate, input);
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
