import { generateObject } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { getSettings } from "../../config/settings";
import type { AnalysisContext } from "./context";

const PROMPT_VERSION = "v1";

const AnalysisSchema = z.object({
  summary: z.string(),
  technical_detail: z.string(),
  direction_signal: z.string().nullable(),
  significance: z.enum(["routine", "notable", "directional_shift"]),
  categories: z.array(
    z.enum(["architecture", "dependency", "api", "performance", "security", "testing", "docs"])
  ),
});

export type AnalysisOutput = z.infer<typeof AnalysisSchema>;

export interface PRInfo {
  id: number;
  title: string;
  author: string | null;
  body: string | null;
  files_changed: number | null;
  additions: number | null;
  deletions: number | null;
}

export interface ReviewResult {
  output: AnalysisOutput;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  promptVersion: string;
  renderedProjectContext: string;
  fileManifest: string;
  diffIncludedFiles: number;
  diffTotalFiles: number;
  diffTruncated: boolean;
  inputQuality: string;
}

// Rough cost estimate for claude-sonnet-4-6: $3/MTok input, $15/MTok output
const INPUT_COST_PER_TOKEN = 3 / 1_000_000;
const OUTPUT_COST_PER_TOKEN = 15 / 1_000_000;

function buildSystemPrompt(ctx: AnalysisContext, pr: PRInfo): string {
  const p = ctx.projectContext;

  const projectSection = [
    p.description ?? "No description available.",
    `Language: ${p.language ?? "Unknown"}`,
    `Topics: ${p.topics.length > 0 ? p.topics.join(", ") : "None"}`,
    p.notes ? `Notes: ${p.notes}` : null,
    p.tags.length > 0 ? `Tags: ${p.tags.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const prBody = pr.body ? pr.body.slice(0, 1000) : "No description provided.";

  let diffSection: string;
  if (ctx.diff) {
    diffSection = ctx.diff.content;
  } else {
    diffSection = "Diff not available — analysis based on PR metadata only.";
  }

  const supplementary = ctx.supplementaryContext ?? "Not available.";

  return `You are an engineering intelligence analyst. Given a PR and its project context,
produce a structured analysis. Analyze the diff content to understand the actual
code changes, their patterns, and what they suggest about the project's
engineering direction.

PROJECT CONTEXT:
${projectSection}

PR INFORMATION:
Title: ${pr.title}
Author: ${pr.author ?? "Unknown"}
Files changed: ${pr.files_changed ?? 0} (+${pr.additions ?? 0}/-${pr.deletions ?? 0})
PR Body: ${prBody}

DIFF CONTENT:
${diffSection}

SUPPLEMENTARY CONTEXT:
${supplementary}

Significance classification rules:
* routine: Bug fixes, minor refactors, test additions, dependency bumps, doc updates
* notable: New features, significant refactors (>10 files), new dependency categories, performance changes with benchmarks
* directional_shift: New architectural patterns (e.g., adding gRPC to REST-only), language/framework migrations, major API surface changes (>5 endpoints), new infrastructure patterns

Respond with a JSON object matching the required schema.`;
}

export async function reviewPR(ctx: AnalysisContext, pr: PRInfo): Promise<ReviewResult> {
  const settings = getSettings();

  const anthropic = createAnthropic({
    baseURL: settings.llm.baseUrl,
    apiKey: settings.llm.apiKey,
  });

  const systemPrompt = buildSystemPrompt(ctx, pr);

  async function callLLM(): Promise<ReviewResult> {
    const result = await generateObject({
      model: anthropic(settings.llm.model),
      schema: AnalysisSchema,
      prompt: systemPrompt,
      maxOutputTokens: settings.llm.maxTokensPerCall,
    });

    const inputTokens = result.usage.inputTokens ?? 0;
    const outputTokens = result.usage.outputTokens ?? 0;
    const estimatedCostUsd =
      inputTokens * INPUT_COST_PER_TOKEN + outputTokens * OUTPUT_COST_PER_TOKEN;

    return {
      output: result.object,
      inputTokens,
      outputTokens,
      estimatedCostUsd,
      promptVersion: PROMPT_VERSION,
      renderedProjectContext: systemPrompt,
      fileManifest: ctx.diff?.fileManifest ?? "",
      diffIncludedFiles: ctx.diff?.includedFiles ?? 0,
      diffTotalFiles: ctx.diff?.totalFiles ?? 0,
      diffTruncated: ctx.diff?.truncated ?? false,
      inputQuality: ctx.inputQuality,
    };
  }

  // One retry on failure
  try {
    return await Promise.race([
      callLLM(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("LLM call timed out after 60s")), 60_000)
      ),
    ]);
  } catch (firstErr) {
    // Single retry
    try {
      return await Promise.race([
        callLLM(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("LLM call timed out after 60s")), 60_000)
        ),
      ]);
    } catch (retryErr) {
      const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
      throw new Error(`LLM analysis failed after retry: ${msg}`);
    }
  }
}

export { PROMPT_VERSION };
