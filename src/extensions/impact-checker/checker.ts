import { generateText, generateObject, stepCountIs } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { readFileSync, mkdirSync, existsSync, appendFileSync } from "fs";
import { join } from "path";
import { getSettings } from "../../config/settings";
import type { MantleTarget, CounterpartRelationship } from "../../config/projects";
import { withLLMRetry } from "../analyzer/llm-retry";
import { truncateDiff } from "../analyzer/diff-truncator";
import { makeAgentTools, fencePathToCloneDir } from "./agent-tools";
import { getCheckInstructions } from "./strategies";
import { extractContractDeltas, findLocalContractMirrors, enrichDeltaFromSource, verifyContractDrift, languageForFile } from "./contract-drift";
import type { ContractDelta, MirrorMatch } from "./contract-drift";

const PROMPT_VERSION = "v1.0-fork-forensic";
const AUDIT_DIR = "data/impact-checks";
const VERDICT_INVESTIGATION_TEXT_LIMIT = 12000;
const VERDICT_TRACE_RESULT_LIMIT = 1200;
const VERDICT_TRACE_TOTAL_LIMIT = 12000;

// Cost estimates matching llm-reviewer.ts (claude-sonnet-4-6)
const INPUT_COST_PER_TOKEN = 3 / 1_000_000;
const OUTPUT_COST_PER_TOKEN = 15 / 1_000_000;

// Sentinel error thrown from onStepFinish to abort the agentic loop when the
// per-check cost cap is reached. Caught in the outer try/catch and treated as
// a graceful early-exit rather than an unexpected failure.
class CostLimitExceededError extends Error {
  readonly isCostLimit = true;
  constructor() {
    super("maxCostPerCheck exceeded — aborting agentic loop");
    this.name = "CostLimitExceededError";
  }
}

function resolveAnthropicBaseUrl(rawUrl: string): string | undefined {
  if (!rawUrl) return undefined;
  const trimmed = rawUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

export const VerdictSchema = z.object({
  affected: z.enum(["yes", "no", "uncertain"]),
  // Operational severity — how badly this change threatens the downstream target's
  // runtime/compatibility, ORTHOGONAL to `affected` (which only says the change is
  // present/divergent). Drives the Lark alert gate: only critical/high are pushed.
  //   critical — chain halt / liveness / safety: consensus divergence, block/tx/state
  //              parsing or encoding break (e.g. an L1 EIP changing the block header).
  //   high     — breaks the target's build/runtime/API compatibility; needs action.
  //   medium   — operationally relevant but non-breaking behavior change / has workaround.
  //   low      — non-operational: feature parity gap, CLI/tooling, docs, tests, formatting.
  severity: z.enum(["critical", "high", "medium", "low"]),
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
      // Contract-drift mirror check (present only for mirror-drift evidence). The snippet MUST be the
      // full enclosing mirror struct so the verifier can confirm presence/absence of the member.
      contractCheck: z
        .object({
          mirror: z.string(), // local struct name, e.g. "RPCHeader"
          member: z.string(), // changed upstream member, e.g. "SlotNumber"
          serializedKey: z.string().nullable(),
          expectedTag: z.string().nullable(), // upstream tag, e.g. 'json:"slotNumber,omitempty"'
          observedTag: z.string().nullable(), // tag actually on the mirror member
          actual: z.enum(["missing", "tag-diverged", "present"]),
        })
        .nullable()
        .optional(),
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
  // Optional: fetch the FULL upstream file content (at the PR head) for a changed path. Used by the
  // contract-drift pre-pass to harvest the complete sibling set of a changed struct (the diff's narrow
  // context is too thin to locate a lagging mirror). Best-effort; returns null on failure.
  getFile?: (path: string) => Promise<string | null>;
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

// Deterministic contract-drift pre-pass: extract struct/field/tag deltas from the upstream diff,
// locate any LOCAL mirror in the clone (by sibling overlap, not the new identifier), and render a
// directive block for the verdict prompt. This is what lets the checker catch "the target keeps its
// own stale copy of an upstream contract" even when the dependency source is in an unreadable repo.
export interface DriftFinding {
  delta: ContractDelta;
  mirror: MirrorMatch | null;
}

export async function buildContractDriftBlock(input: CheckerInput): Promise<{
  block: string;
  findings: DriftFinding[];
  stalePrimary: DriftFinding | null;
}> {
  if (input.upstreamPR.diffStatus !== "available" || !input.upstreamPR.diffRaw) {
    return { block: "No upstream diff available — contract-drift pre-analysis skipped.", findings: [], stalePrimary: null };
  }
  let deltas: ContractDelta[] = [];
  try {
    deltas = extractContractDeltas(input.upstreamPR.diffRaw);
  } catch {
    deltas = [];
  }
  if (deltas.length === 0) {
    return {
      block: "No structural contract deltas (Go/Rust struct field or tag changes) detected in the diff.",
      findings: [],
      stalePrimary: null,
    };
  }

  // Enrich siblings from the FULL upstream file (the diff's context is too thin to find a lagging
  // mirror). Best-effort: one fetch per unique changed file; degrade to diff-only siblings on failure.
  const getFile = input.upstreamPR.getFile;
  if (getFile) {
    const cache = new Map<string, string | null>();
    for (const d of deltas) {
      if (!cache.has(d.file)) {
        try {
          cache.set(d.file, await getFile(d.file));
        } catch {
          cache.set(d.file, null);
        }
      }
    }
    deltas = deltas.map((d) => {
      const src = cache.get(d.file);
      return src ? enrichDeltaFromSource(d, src) : d;
    });
  }

  // Find ALL qualifying mirrors per delta (not just the best) so a smaller, genuinely-stale mirror is
  // not HIDDEN behind a larger already-synced one.
  const findings: DriftFinding[] = [];
  for (const delta of deltas.slice(0, 40)) {
    let mirrors: MirrorMatch[] = [];
    try {
      mirrors = findLocalContractMirrors(input.cloneState.cloneDir, delta, {
        architectureNotes: input.target.architectureNotes,
      });
    } catch {
      mirrors = [];
    }
    if (mirrors.length === 0) findings.push({ delta, mirror: null });
    else for (const mirror of mirrors) findings.push({ delta, mirror });
  }

  // A drift is real only when the mirror MEANINGFULLY lags this PR:
  //   - field-added delta + mirror MISSING the member  -> stale
  //   - tag-changed delta + mirror has the member with a DIVERGED tag -> stale
  // A tag-changed delta whose mirror lacks the field ENTIRELY is NOT a drift for this PR (the tag
  // change doesn't apply to an absent field; the field's absence — if it matters — is a different PR).
  const isStale = (f: DriftFinding): boolean => {
    const m = f.mirror;
    if (!m) return false;
    if (f.delta.kind === "field-added") return m.actual === "missing";
    return m.actual === "tag-diverged"; // tag-changed
  };

  const withMirror = findings.filter((f) => f.mirror).sort((a, b) => b.mirror!.siblingOverlap - a.mirror!.siblingOverlap);
  const overallStrongest = withMirror[0];
  const staleFindings = withMirror.filter(isStale);

  // Which upstream contracts have a PRESENT (synced) local mirror? If a contract is provably mirrored
  // locally AND also has a stale copy, that stale copy is almost certainly a real lagging mirror.
  const contractKey = (f: DriftFinding) => `${f.delta.file}::${f.delta.enclosingContract}`;
  const syncedContracts = new Set(findings.filter((f) => f.mirror?.actual === "present").map(contractKey));

  // Deterministic force-yes applies to a stale mirror that is EITHER the overall-strongest mirror (the
  // single clearest mirror, e.g. a sole RPCHeader missing the field) OR whose contract also has a synced
  // sibling mirror locally (a same-contract copy lags — GPT's "smaller stale behind a synced bigger"
  // case). A lone stale mirror of a contract with NO synced sibling (e.g. an L2 ExecutionPayload that
  // legitimately omits an L1 field) is NOT force-yes'd — it is surfaced to the LLM for semantic judgment.
  const forceable = staleFindings.filter(
    (f) => f === overallStrongest || syncedContracts.has(contractKey(f))
  );
  const stalePrimary = forceable.sort((a, b) => b.mirror!.siblingOverlap - a.mirror!.siblingOverlap)[0] ?? null;
  const primary = overallStrongest;

  const renderStale = (f: DriftFinding): string => {
    const m = f.mirror!;
    const what =
      m.actual === "missing"
        ? `is MISSING member \`${f.delta.member}\` (key \`${f.delta.serializedKey ?? "n/a"}\`)`
        : `has \`${f.delta.member}\` but with a DIVERGED tag (observed \`${m.observedTag}\` vs expected \`${m.expectedTag}\`)`;
    return (
      `- Upstream \`${f.delta.enclosingContract}\` (${f.delta.file}) ${f.delta.kind === "tag-changed" ? "changed the tag on" : "added"} \`${f.delta.member}\`. ` +
      `Local mirror \`${m.mirror}\` (sibling overlap ${m.siblingOverlap}) at \`${m.file}:${m.lines}\` ${what}. ` +
      `contractCheck { mirror: "${m.mirror}", member: "${f.delta.member}", serializedKey: ${JSON.stringify(f.delta.serializedKey)}, expectedTag: ${JSON.stringify(m.expectedTag)}, observedTag: ${JSON.stringify(m.observedTag)}, actual: "${m.actual}" }`
    );
  };

  const lines: string[] = [];
  const secondary = staleFindings.filter((f) => f !== stalePrimary);
  if (stalePrimary) {
    lines.push(
      "⚠️ STALE LOCAL MIRROR DETECTED — the target keeps its own copy of an upstream contract that is now out of sync. This is a real adaptation gap: you MUST report `affected: \"yes\"`, describe the gap in `summary`, and emit `code_evidence` citing the FULL enclosing mirror struct with the `contractCheck` object shown. Severity for additive/optional compatibility fields is `medium` (digest), unless the field is on a consensus/parse-critical path."
    );
    lines.push(renderStale(stalePrimary) + `\nCite this struct:\n\`\`\`\n${stalePrimary.mirror!.snippet.slice(0, 1200)}\n\`\`\``);
  } else if (primary && primary.mirror!.actual === "present") {
    lines.push(
      `Primary local mirror \`${primary.mirror!.mirror}\` already contains \`${primary.delta.member}\` in sync with upstream (verified by reading the clone). The mirror adaptation for that contract is DONE.`
    );
  } else {
    lines.push(
      "No stale local mirror of the changed contract(s) was found (no high-overlap struct missing the added field or carrying a diverged tag). " +
        "Do NOT invent a mirror; fall back to dependency-boundary (consumer) reasoning for this check."
    );
  }
  if (secondary.length > 0) {
    lines.push(
      `ADDITIONAL candidate mirror(s) that also appear stale — evaluate each on its merits (a structurally-similar struct may legitimately omit the field, e.g. an L2 type omitting an L1-only field; confirm with read_file before concluding):`
    );
    for (const f of secondary.slice(0, 5)) lines.push(renderStale(f));
  }
  return { block: lines.join("\n"), findings, stalePrimary };
}

function buildSystemPrompt(
  input: CheckerInput,
  checkInstructions: string,
  contractDriftBlock: string,
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
    .replace("{{check_instructions}}", checkInstructions)
    .replace("{{contract_drift_analysis}}", contractDriftBlock);
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

  if (verdict.evidence.length === 0) {
    failures.push("code_evidence verdict has no evidence entries");
  }

  for (const ev of verdict.evidence) {
    if (!ev.file.trim()) {
      failures.push("code_evidence entry is missing file path");
      continue;
    }

    if (!ev.snippet.trim()) {
      failures.push(`code_evidence entry for '${ev.file}' is missing snippet`);
      continue;
    }

    // Fence evidence paths to the clone directory to prevent the LLM from
    // citing files outside the repo (e.g. "../escape.ts" or symlinked paths).
    const fenced = fencePathToCloneDir(ev.file, cloneDir);
    if (fenced === null) {
      failures.push(`Evidence path rejected (outside clone): ${ev.file}`);
      continue;
    }

    if (!existsSync(fenced)) {
      failures.push(`File does not exist in clone: ${ev.file}`);
      continue;
    }

    if (ev.snippet && ev.snippet.trim()) {
      try {
        const content = readFileSync(fenced, "utf-8");
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

    // Contract-drift claims (missing / tag-diverged / present) are validated against the REAL struct
    // re-parsed from the file by mirror name — NOT against the LLM-provided snippet, which could be a
    // partial copy that omits the member to fake a "missing". This is the authoritative check.
    const cc = ev.contractCheck;
    if (cc) {
      const lang = fenced ? languageForFile(ev.file) : null;
      if (!fenced || !lang) {
        failures.push(`contractCheck for ${cc.mirror} could not be verified (unreadable or unsupported file: ${ev.file})`);
      } else {
        const res = verifyContractDrift(fenced, lang, {
          mirror: cc.mirror,
          member: cc.member,
          expectedTag: cc.expectedTag,
          observedTag: cc.observedTag,
          actual: cc.actual,
        });
        if (!res.ok) failures.push(`contractCheck verification failed for ${cc.mirror}.${cc.member}: ${res.reason}`);
      }
    }
  }

  return { verified: failures.length === 0, failures };
}

function recommendsNoTargetAction(verdict: Verdict): boolean {
  const text = `${verdict.summary}\n${verdict.recommendedAction}`.toLowerCase();
  const explicitNoChange =
    /\bno action needed\b/.test(text) ||
    /\bno operator action\b/.test(text) ||
    /\boperators should not need\b/.test(text) ||
    /\bmust remain unchanged\b/.test(text) ||
    /\bshould remain\b/.test(text) ||
    /\bcorrect default\b/.test(text) ||
    /\bcorrect behavior\b/.test(text) ||
    /\bleave (the )?fork unchanged\b/.test(text);

  const forbidAdoption =
    /\bdo not (cherry-pick|apply|adopt)\b/.test(text) ||
    /\bdon't (cherry-pick|apply|adopt)\b/.test(text) ||
    /\bshould not be (cherry-picked|applied|adopted)\b/.test(text);

  return explicitNoChange || (forbidAdoption && /\b(no|not) (target|operator|configuration) action\b/.test(text));
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

function stringifyForPrompt(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return String(value);
  }
}

function clipForPrompt(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}\n[truncated]` : value;
}

function compactTraceForPrompt(stepTrace: object[]): string {
  if (stepTrace.length === 0) return "(no tool steps recorded)";

  return clipForPrompt(
    stepTrace
    .map((entry, idx) => {
      const step = entry as {
        toolCalls?: Array<{ toolName?: string; input?: unknown }>;
        toolResults?: Array<{ toolName?: string; output?: unknown }>;
      };
      const calls = (step.toolCalls ?? [])
        .map((call) => `${call.toolName ?? "tool"} ${stringifyForPrompt(call.input)}`)
        .join("; ");
      const results = (step.toolResults ?? [])
        .map(
          (result) =>
            `${result.toolName ?? "tool"} => ${clipForPrompt(stringifyForPrompt(result.output), VERDICT_TRACE_RESULT_LIMIT)}`
        )
        .join("; ");
      return `Step ${idx}: calls=[${calls || "none"}]\nresults=[${results || "none"}]`;
    })
      .join("\n\n"),
    VERDICT_TRACE_TOTAL_LIMIT
  );
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
  const { block: contractDriftBlock, stalePrimary } = await buildContractDriftBlock(input);
  const systemPrompt = buildSystemPrompt(input, checkInstructions, contractDriftBlock, settings);
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
  let investigationText = "";

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
      stopWhen: [stepCountIs(maxSteps)],
      onStepFinish: async (step) => {
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
            input: (tc as unknown as { input: unknown }).input,
          })),
          toolResults: step.toolResults?.map((tr) => ({
            toolName: (tr as { toolName: string }).toolName,
            output: (tr as unknown as { output: unknown }).output,
          })),
          inputTokens: stepInputTokens,
          outputTokens: stepOutputTokens,
          stepCost,
          accumulatedCost,
        };
        stepTrace.push(stepEntry);
        writeAuditEntry(auditPath, stepEntry);

        // Throw sentinel to immediately abort the agentic loop. The outer
        // try/catch recognises CostLimitExceededError and branches to
        // generateObject with forced uncertain verdict.
        if (accumulatedCost >= maxCostPerCheck) {
          truncatedByCost = true;
          throw new CostLimitExceededError();
        }
      },
    });

    // Check if stopped by step count
    if (textResult.steps && textResult.steps.length >= maxSteps) {
      truncatedByStepCount = true;
    }
    investigationText = textResult.text ?? "";

    // Update token totals from the complete result (may include final step)
    totalInputTokens = textResult.usage?.inputTokens ?? totalInputTokens;
    totalOutputTokens = textResult.usage?.outputTokens ?? totalOutputTokens;
    accumulatedCost = estimateStepCost(totalInputTokens, totalOutputTokens);
  } catch (err) {
    if (err instanceof CostLimitExceededError) {
      // Expected graceful exit — truncatedByCost already set, fall through to generateObject
    } else {
      writeAuditEntry(auditPath, {
        type: "step_loop_error",
        error: err instanceof Error ? err.message : String(err),
      });
      // Treat unexpected errors as cost-truncated to produce uncertain verdict
      truncatedByCost = true;
    }
  }

  const forcedUncertain = truncatedByCost || truncatedByStepCount;

  // Phase 2: Structured verdict via generateObject
  const verdictSystemPrompt = forcedUncertain
    ? `${systemPrompt}\n\n⚠️ IMPORTANT: The investigation was cut short (${truncatedByCost ? "cost limit reached" : "step limit reached"}). You MUST produce verdict with affected="uncertain". Set confidence to "low".`
    : systemPrompt;
  const compactInvestigationText = investigationText
    ? clipForPrompt(investigationText, VERDICT_INVESTIGATION_TEXT_LIMIT)
    : "(empty)";
  const compactToolTrace = compactTraceForPrompt(stepTrace);
  const verdictPrompt = forcedUncertain
    ? `The investigation was cut short. Produce an uncertain verdict based on what was found so far. Set affected="uncertain".\n\nAgent investigation text:\n${compactInvestigationText}\n\nTool trace:\n${compactToolTrace}`
    : `Based on the investigation below, produce the final structured verdict with all evidence.\n\nAgent investigation text:\n${compactInvestigationText}\n\nTool trace:\n${compactToolTrace}`;

  let rawVerdict: Verdict;

  try {
    const objectResult = await withLLMRetry(() =>
      generateObjectFn({
        model: anthropic(settings.llm.model),
        schema: VerdictSchema,
        system: verdictSystemPrompt,
        prompt: verdictPrompt,
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
      severity: "low",
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
    rawVerdict.confidence = "low";
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

  // A high-confidence alert should imply a target-side action is needed.
  // If the structured verdict says the correct action is explicitly to leave
  // the fork unchanged, keep the result for reports but prevent alerting.
  if (
    rawVerdict.affected === "yes" &&
    rawVerdict.confidence === "high" &&
    recommendsNoTargetAction(rawVerdict)
  ) {
    rawVerdict.confidence = "medium";
  }

  // Deterministic stale-mirror override (applied BEFORE evidence verification so the verifier validates
  // the ground-truth evidence). The pre-pass found, by reading the actual clone, that the target's own
  // copy of an upstream contract is stale — a FACT, not an inference. "affected" = "does the target need
  // an adaptation" = yes, regardless of when the external dependency bumps (that timing is
  // severity/recommendedAction, not affected). This wins over LLM hedging and truncation→uncertain.
  if (stalePrimary && stalePrimary.mirror) {
    const m = stalePrimary.mirror;
    rawVerdict.affected = "yes";
    if (rawVerdict.severity === "low") rawVerdict.severity = "medium";
    rawVerdict.evidenceKind = "code_evidence";
    if (rawVerdict.confidence === "low") rawVerdict.confidence = "medium";
    // Use ONLY the deterministic finding as evidence (ground truth read from the clone). Replacing the
    // LLM's evidence here means a bogus LLM-supplied contractCheck cannot ride through verification; the
    // injected item is then validated by verifyEvidence below like any other.
    rawVerdict.evidence = [
      {
        file: m.file,
        lines: m.lines,
        snippet: m.snippet,
        note: `Stale local mirror: ${m.mirror} ${m.actual === "missing" ? `is missing member ${stalePrimary.delta.member}` : `has a diverged tag on ${stalePrimary.delta.member}`} (upstream ${stalePrimary.delta.enclosingContract}).`,
        contractCheck: {
          mirror: m.mirror,
          member: stalePrimary.delta.member,
          serializedKey: stalePrimary.delta.serializedKey,
          expectedTag: m.expectedTag,
          observedTag: m.observedTag,
          actual: m.actual,
        },
      },
    ];
    // Keep impactType / summary / recommendedAction CONSISTENT with affected=yes — otherwise the verdict
    // contradicts itself (e.g. affected=yes + impactType=not_affected + summary="No action needed") and
    // could fire a misleading alert. These deterministic fields describe the mirror gap directly.
    rawVerdict.impactType = m.actual === "missing" ? "breaking_change" : "behavior_change";
    const gapDesc =
      m.actual === "missing"
        ? `local mirror struct \`${m.mirror}\` (${m.file}) is MISSING the \`${stalePrimary.delta.member}\` field that upstream \`${stalePrimary.delta.enclosingContract}\` added`
        : `local mirror struct \`${m.mirror}\` (${m.file}) carries a DIVERGED serialization tag on \`${stalePrimary.delta.member}\` (observed ${m.observedTag} vs upstream ${m.expectedTag})`;
    rawVerdict.summary = `Contract mirror drift: ${gapDesc}. Mantle maintains its own copy of upstream \`${stalePrimary.delta.enclosingContract}\` and it is now out of sync — a code adaptation is needed to re-sync.`;
    rawVerdict.recommendedAction =
      m.actual === "missing"
        ? `Add \`${stalePrimary.delta.member}\` to \`${m.mirror}\` in ${m.file} to mirror upstream \`${stalePrimary.delta.enclosingContract}\`.`
        : `Update the serialization tag on \`${m.mirror}.${stalePrimary.delta.member}\` in ${m.file} to match upstream (${m.expectedTag}).`;
    writeAuditEntry(auditPath, {
      type: "stale_mirror_override",
      mirror: m.mirror,
      file: m.file,
      member: stalePrimary.delta.member,
      actual: m.actual,
    });
  }

  // Evidence verification for code_evidence (validates the deterministic contractCheck above too — no
  // manual bypass; if it cannot be confirmed against the clone, confidence is dropped honestly).
  let evidenceVerificationFailed = false;
  if (rawVerdict.evidenceKind === "code_evidence") {
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
