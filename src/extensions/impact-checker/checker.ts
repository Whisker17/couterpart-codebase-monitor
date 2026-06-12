import { generateText, generateObject, stopWhen, stepCountIs } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { readFileSync, mkdirSync, existsSync, appendFileSync } from "fs";
import { join } from "path";
import { getSettings } from "../../config/settings";
import type { MantleTarget, CounterpartRelationship } from "../../config/projects";
import { withLLMRetry } from "../analyzer/llm-retry";
import { truncateDiff } from "../analyzer/diff-truncator";
import { makeAgentTools } from "./agent-tools";
import { getCheckInstructions } from "./strategies";

const PROMPT_VERSION = "v1.0-fork-forensic";
const AUDIT_DIR = "data/impact-checks";

// Cost estimates matching llm-reviewer.ts (claude-sonnet-4-6)
const INPUT_COST_PER_TOKEN = 3 / 1_000_000;
const OUTPUT_COST_PER_TOKEN = 15 / 1_000_000;

function resolveAnthropicBaseUrl(rawUrl: string): string | undefined {
  if (!rawUrl) return undefined;
  const trimmed = rawUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

export const VerdictSchema = z.object({
  affected: z.enum(["yes", "no", "uncertain"]),
  impactType: z.enum([
    "bug_also_present",
    "breaking_change",
    "downtime_risk",
    "behavior_change",
    "not_affected",
  ]),
  evidenceKind: z.enum(["code_evidence", "manifest_evidence", "reasoning_based"]),
  evidence: z.array(
    z.object({
      file: z.string(),
      lines: z.string(),
      snippet: z.string(),
      note: z.string(),
    })
  ),
  confidence: z.enum(["high", "medium", "low"]),
  summary: z.string(),
  recommendedAction: z.string(),
});

export type Verdict = z.infer<typeof VerdictSchema>;

export interface ImpactCheckVerdict extends Verdict {
  tokensUsed: number;
  cost: number;
  toolSteps: number;
  truncatedByStepCount: boolean;
  truncatedByCost: boolean;
  evidenceVerificationFailed: boolean;
}

export interface UpstreamPRInfo {
  title: string;
  body: string | null;
  diffRaw: string | null;
  diffStatus: "available" | "unavailable" | "too_large";
}

export interface AnalyzerSummary {
  summary: string;
  technicalDetail: string;
}

export interface CheckerInput {
  checkId: string;
  target: MantleTarget;
  relationship: CounterpartRelationship;
  cloneState: {
    cloneDir: string;
    commitHash: string;
    lastFetchAt: string;
  };
  upstreamPR: UpstreamPRInfo;
  analyzerSummary: AnalyzerSummary | null;
}

// Exported for testing
export type GenerateTextFn = typeof generateText;
export type GenerateObjectFn = typeof generateObject;

interface CheckerDeps {
  generateTextFn?: GenerateTextFn;
  generateObjectFn?: GenerateObjectFn;
  // Injectable for testing — avoids dependency on module-level settings state
  settings?: {
    llm: { model: string; baseUrl: string; apiKey: string; maxTokensPerCall: number; diffTokenBudget: number; maxManifestEntries: number };
    impactCheck?: { maxStepsPerCheck?: number; maxCostPerCheck?: number };
  };
}

function loadSystemPromptTemplate(): string {
  const promptPath = join(process.cwd(), "prompts", "impact-check", "fork.md");
  try {
    return readFileSync(promptPath, "utf-8");
  } catch {
    throw new Error(`Failed to load fork prompt template at ${promptPath}`);
  }
}

function buildSystemPrompt(
  input: CheckerInput,
  checkInstructions: string,
  settings: { llm: { diffTokenBudget: number; maxManifestEntries: number } }
): string {
  const template = loadSystemPromptTemplate();

  const { upstreamPR, target, analyzerSummary, cloneState } = input;

  let diffSection: string;
  let diffUnavailable = false;

  if (upstreamPR.diffStatus === "available" && upstreamPR.diffRaw) {
    const truncated = truncateDiff(
      upstreamPR.diffRaw,
      settings.llm.diffTokenBudget,
      settings.llm.maxManifestEntries
    );
    diffSection = truncated.content;
  } else {
    diffSection =
      "Diff not available — use grep_repo to search for function names and identifiers from the PR title and body.";
    diffUnavailable = true;
  }

  return template
    .replace("{{upstream_pr_title}}", upstreamPR.title)
    .replace("{{upstream_pr_body}}", upstreamPR.body?.slice(0, 2000) ?? "(no description)")
    .replace("{{upstream_diff}}", diffSection)
    .replace(
      "{{#if diff_unavailable}}\n> ⚠️ **Diff unavailable** — proceeding without a full diff. Confidence is capped at `medium` regardless of evidence quality. Use the PR title and body to identify what changed.\n{{/if}}",
      diffUnavailable
        ? "> ⚠️ **Diff unavailable** — proceeding without a full diff. Confidence is capped at `medium` regardless of evidence quality. Use the PR title and body to identify what changed."
        : ""
    )
    .replace("{{analyzer_summary}}", analyzerSummary?.summary ?? "Not available.")
    .replace("{{analyzer_technical_detail}}", analyzerSummary?.technicalDetail ?? "Not available.")
    .replace("{{architecture_notes}}", target.architectureNotes ?? "Not available.")
    .replace("{{clone_commit_hash}}", cloneState.commitHash)
    .replace("{{clone_sync_time}}", cloneState.lastFetchAt)
    .replace("{{prompt_version}}", PROMPT_VERSION)
    .replace("{{check_instructions}}", checkInstructions);
}

function estimateStepCost(inputTokens: number, outputTokens: number): number {
  return inputTokens * INPUT_COST_PER_TOKEN + outputTokens * OUTPUT_COST_PER_TOKEN;
}

function verifyEvidence(
  verdict: Verdict,
  cloneDir: string
): { verified: boolean; failures: string[] } {
  if (verdict.evidenceKind !== "code_evidence") {
    return { verified: true, failures: [] };
  }

  const failures: string[] = [];

  for (const ev of verdict.evidence) {
    if (!ev.file) continue;

    const filePath = join(cloneDir, ev.file);
    if (!existsSync(filePath)) {
      failures.push(`File does not exist in clone: ${ev.file}`);
      continue;
    }

    if (ev.snippet && ev.snippet.trim()) {
      try {
        const content = readFileSync(filePath, "utf-8");
        const snippetLines = ev.snippet
          .trim()
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);

        // Check if at least one non-trivial snippet line appears in the file
        const significantLines = snippetLines.filter((l) => l.length > 5);
        if (significantLines.length > 0) {
          const anyFound = significantLines.some((line) => content.includes(line));
          if (!anyFound) {
            failures.push(
              `Snippet not found in file '${ev.file}': "${snippetLines[0]?.slice(0, 60)}..."`
            );
          }
        }
      } catch {
        failures.push(`Could not read file for snippet verification: ${ev.file}`);
      }
    }
  }

  return { verified: failures.length === 0, failures };
}

function writeAuditEntry(auditPath: string, entry: object): void {
  try {
    appendFileSync(auditPath, JSON.stringify(entry) + "\n", "utf-8");
  } catch (err) {
    console.warn(
      `[checker] Failed to write audit entry: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export async function runImpactCheck(
  input: CheckerInput,
  deps?: CheckerDeps
): Promise<ImpactCheckVerdict> {
  const settings = deps?.settings ?? getSettings();
  const impactCheck = settings.impactCheck ?? {
    maxStepsPerCheck: 12,
    maxCostPerCheck: 1.0,
  };

  const maxSteps = impactCheck.maxStepsPerCheck ?? 12;
  const maxCostPerCheck = impactCheck.maxCostPerCheck ?? 1.0;

  const generateTextFn = deps?.generateTextFn ?? generateText;
  const generateObjectFn = deps?.generateObjectFn ?? generateObject;

  const anthropic = createAnthropic({
    baseURL: resolveAnthropicBaseUrl(settings.llm.baseUrl),
    apiKey: settings.llm.apiKey,
  });

  const checkInstructions = getCheckInstructions(input.relationship.relationship);
  const systemPrompt = buildSystemPrompt(input, checkInstructions, settings);
  const { grep_repo, read_file } = makeAgentTools(input.cloneState.cloneDir);

  // Ensure audit directory exists
  mkdirSync(AUDIT_DIR, { recursive: true });
  const auditPath = join(AUDIT_DIR, `${input.checkId}.jsonl`);

  // Write header entry
  writeAuditEntry(auditPath, {
    type: "check_start",
    checkId: input.checkId,
    targetProjectId: input.target.projectId,
    relationship: input.relationship.relationship,
    upstreamPRTitle: input.upstreamPR.title,
    cloneCommitHash: input.cloneState.commitHash,
    promptVersion: PROMPT_VERSION,
    maxSteps,
    maxCostPerCheck,
    timestamp: new Date().toISOString(),
  });

  let accumulatedCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let toolSteps = 0;
  let truncatedByStepCount = false;
  let truncatedByCost = false;

  // Phase 1: Agentic step loop
  const stepTrace: object[] = [];

  try {
    const textResult = await generateTextFn({
      model: anthropic(settings.llm.model),
      tools: { grep_repo, read_file },
      toolChoice: "auto",
      system: systemPrompt,
      prompt:
        "Begin your forensic investigation. Use grep_repo to locate relevant code, then read_file to confirm findings. Provide a thorough analysis.",
      maxRetries: 0,
      stopWhen: [
        stepCountIs(maxSteps),
        // Cost-based stop: checked per-step via onStepFinish
      ],
      onStepFinish: (step) => {
        const stepInputTokens = step.usage?.inputTokens ?? 0;
        const stepOutputTokens = step.usage?.outputTokens ?? 0;
        const stepCost = estimateStepCost(stepInputTokens, stepOutputTokens);

        totalInputTokens += stepInputTokens;
        totalOutputTokens += stepOutputTokens;
        accumulatedCost += stepCost;
        toolSteps++;

        const stepEntry = {
          type: "step",
          stepNumber: step.stepNumber,
          toolCalls: step.toolCalls?.map((tc) => ({
            toolName: (tc as { toolName: string }).toolName,
            args: (tc as { args: unknown }).args,
          })),
          toolResults: step.toolResults?.map((tr) => ({
            toolName: (tr as { toolName: string }).toolName,
            result: (tr as { result: unknown }).result,
          })),
          inputTokens: stepInputTokens,
          outputTokens: stepOutputTokens,
          stepCost,
          accumulatedCost,
        };
        stepTrace.push(stepEntry);
        writeAuditEntry(auditPath, stepEntry);

        if (accumulatedCost >= maxCostPerCheck) {
          truncatedByCost = true;
          // Note: ai SDK v6 doesn't support aborting from onStepFinish directly.
          // The cost cap produces uncertain verdict at generateObject phase below.
        }
      },
    });

    // Check if stopped by step count
    if (textResult.steps && textResult.steps.length >= maxSteps) {
      truncatedByStepCount = true;
    }

    // Update token totals from the complete result (may include final step)
    totalInputTokens = textResult.usage?.inputTokens ?? totalInputTokens;
    totalOutputTokens = textResult.usage?.outputTokens ?? totalOutputTokens;
    accumulatedCost = estimateStepCost(totalInputTokens, totalOutputTokens);
  } catch (err) {
    writeAuditEntry(auditPath, {
      type: "step_loop_error",
      error: err instanceof Error ? err.message : String(err),
    });
    // Fall through to generateObject with uncertain verdict
    truncatedByCost = true;
  }

  const forcedUncertain = truncatedByCost || truncatedByStepCount;

  // Phase 2: Structured verdict via generateObject
  const verdictSystemPrompt = forcedUncertain
    ? `${systemPrompt}\n\n⚠️ IMPORTANT: The investigation was cut short (${truncatedByCost ? "cost limit reached" : "step limit reached"}). You MUST produce verdict with affected="uncertain". Set confidence to "low".`
    : systemPrompt;

  let rawVerdict: Verdict;

  try {
    const objectResult = await withLLMRetry(() =>
      generateObjectFn({
        model: anthropic(settings.llm.model),
        schema: VerdictSchema,
        system: verdictSystemPrompt,
        prompt: forcedUncertain
          ? 'The investigation was cut short. Produce an uncertain verdict based on what was found so far. Set affected="uncertain".'
          : "Based on your investigation above, produce the final structured verdict with all evidence.",
        maxRetries: 0,
      })
    );

    rawVerdict = objectResult.object as Verdict;

    totalInputTokens += objectResult.usage?.inputTokens ?? 0;
    totalOutputTokens += objectResult.usage?.outputTokens ?? 0;
    accumulatedCost = estimateStepCost(totalInputTokens, totalOutputTokens);
  } catch (err) {
    writeAuditEntry(auditPath, {
      type: "verdict_error",
      error: err instanceof Error ? err.message : String(err),
    });
    // Produce a safe fallback uncertain verdict
    rawVerdict = {
      affected: "uncertain",
      impactType: "not_affected",
      evidenceKind: "reasoning_based",
      evidence: [],
      confidence: "low",
      summary: `Impact check failed to produce a structured verdict: ${err instanceof Error ? err.message : String(err)}`,
      recommendedAction: "Manual review required — automated check failed.",
    };
  }

  // Phase 3: Program-side verdict validation

  // Force uncertain if truncated
  if (forcedUncertain) {
    rawVerdict.affected = "uncertain";
    if (rawVerdict.confidence === "high") rawVerdict.confidence = "medium";
  }

  // Diff unavailable → cap confidence at medium
  if (
    input.upstreamPR.diffStatus !== "available" &&
    rawVerdict.confidence === "high"
  ) {
    rawVerdict.confidence = "medium";
  }

  // Non-code_evidence cannot have high confidence
  if (rawVerdict.evidenceKind !== "code_evidence" && rawVerdict.confidence === "high") {
    rawVerdict.confidence = "medium";
  }

  // Evidence verification for code_evidence
  let evidenceVerificationFailed = false;
  if (rawVerdict.evidenceKind === "code_evidence" && rawVerdict.evidence.length > 0) {
    const { verified, failures } = verifyEvidence(rawVerdict, input.cloneState.cloneDir);
    if (!verified) {
      evidenceVerificationFailed = true;
      rawVerdict.confidence = "low";
      writeAuditEntry(auditPath, {
        type: "evidence_verification_failed",
        failures,
      });
    }
  }

  const finalVerdict: ImpactCheckVerdict = {
    ...rawVerdict,
    tokensUsed: totalInputTokens + totalOutputTokens,
    cost: accumulatedCost,
    toolSteps,
    truncatedByStepCount,
    truncatedByCost,
    evidenceVerificationFailed,
  };

  writeAuditEntry(auditPath, {
    type: "verdict",
    verdict: finalVerdict,
    timestamp: new Date().toISOString(),
  });

  return finalVerdict;
}

export { PROMPT_VERSION, AUDIT_DIR };
