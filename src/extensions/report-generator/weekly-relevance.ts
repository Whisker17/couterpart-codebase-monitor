import { getMantleConfig } from "../../config/projects";
import type { MantleConfig } from "../../config/projects";

export interface WeeklyCandidate {
  sourceProjectId: string;
  prNumber: number;
  title: string;
  summary: string;
  significance: "routine" | "notable" | "directional_shift";
  categories: string[];
  candidateType:
    | "risk_fix"
    | "transferable_optimization"
    | "architecture_direction"
    | "large_technical_change"
    | "routine_pattern";
  mantleRelevanceScore: number;
  selectionReason: string;
  targetCandidates: Array<{
    projectId: string;
    matchType: "manual" | "tag_fallback";
    matchReason: string;
  }>;
}

export interface ScoringInput {
  sourceProjectId: string;
  prNumber: number;
  title: string;
  summary: string;
  significance: "routine" | "notable" | "directional_shift";
  categories: string[];
  directionSignal: string | null;
  isPartOfPattern?: boolean;
}

// Base scores per candidateType (0–100). routine_pattern base is non-zero;
// suppression to 0 is applied after for PRs not part of a pattern.
const BASE_SCORES: Record<WeeklyCandidate["candidateType"], number> = {
  risk_fix: 90,
  architecture_direction: 75,
  transferable_optimization: 65,
  large_technical_change: 50,
  routine_pattern: 20,
};

function determineCandidateType(
  significance: ScoringInput["significance"],
  categories: string[]
): WeeklyCandidate["candidateType"] {
  // Priority 1: risk_fix — security category always wins
  if (categories.includes("security")) return "risk_fix";

  // Priority 3: architecture_direction — directional_shift or arch/dep/api categories
  if (
    significance === "directional_shift" ||
    categories.some((c) => ["architecture", "dependency", "api"].includes(c))
  ) {
    return "architecture_direction";
  }

  // Priority 2: transferable_optimization — performance
  if (categories.includes("performance")) return "transferable_optimization";

  // Priority 4: large_technical_change — notable but not already classified
  if (significance === "notable") return "large_technical_change";

  // Priority 5: routine_pattern
  return "routine_pattern";
}

function buildSelectionReason(
  candidateType: WeeklyCandidate["candidateType"],
  categories: string[],
  directionSignal: string | null
): string {
  const catStr = categories.length > 0 ? ` (${categories.join(", ")})` : "";
  switch (candidateType) {
    case "risk_fix":
      return directionSignal
        ? `Security/reliability fix: ${directionSignal}`
        : `Security-category change${catStr}`;
    case "transferable_optimization":
      return directionSignal
        ? `Performance optimization: ${directionSignal}`
        : `Performance improvement${catStr}`;
    case "architecture_direction":
      return directionSignal
        ? `Architectural direction change: ${directionSignal}`
        : `Architecture/API/dependency change${catStr}`;
    case "large_technical_change":
      return directionSignal
        ? `Large technical change: ${directionSignal}`
        : `Notable refactor or migration${catStr}`;
    case "routine_pattern":
      return "Routine PR supporting a larger weekly pattern";
  }
}

export function resolveTargetCandidates(
  sourceProjectId: string,
  sourceTags: string[],
  config: MantleConfig
): WeeklyCandidate["targetCandidates"] {
  const results: WeeklyCandidate["targetCandidates"] = [];
  const manualTargets = new Set<string>();

  // Manual relationships take priority — check all manual entries first
  for (const rel of config.counterpartRelationships) {
    if (rel.source === sourceProjectId && rel.relationship === "manual") {
      for (const targetId of rel.targets) {
        manualTargets.add(targetId);
        results.push({
          projectId: targetId,
          matchType: "manual",
          matchReason: rel.reason,
        });
      }
    }
  }

  // Tag fallback: advisory only — skip any target already covered by a manual relationship
  for (const target of config.mantleTargets) {
    if (manualTargets.has(target.projectId)) continue;
    const overlap = sourceTags.filter((t) => target.tags.includes(t));
    if (overlap.length > 0) {
      results.push({
        projectId: target.projectId,
        matchType: "tag_fallback",
        matchReason: `Tag overlap: ${overlap.join(", ")}`,
      });
    }
  }

  return results;
}

export function scoreCandidate(
  input: ScoringInput,
  config?: MantleConfig,
  sourceTags?: string[]
): WeeklyCandidate {
  const candidateType = determineCandidateType(input.significance, input.categories);

  let mantleRelevanceScore = BASE_SCORES[candidateType];

  // Boost for directional_shift significance on non-routine types
  if (input.significance === "directional_shift" && candidateType !== "routine_pattern") {
    mantleRelevanceScore = Math.min(100, mantleRelevanceScore + 10);
  }

  // Suppress routine PRs unless they support a larger weekly pattern
  if (candidateType === "routine_pattern" && !input.isPartOfPattern) {
    mantleRelevanceScore = 0;
  }

  const selectionReason = buildSelectionReason(
    candidateType,
    input.categories,
    input.directionSignal
  );

  const resolvedConfig = config ?? getMantleConfig();
  const targetCandidates = resolveTargetCandidates(
    input.sourceProjectId,
    sourceTags ?? [],
    resolvedConfig
  );

  return {
    sourceProjectId: input.sourceProjectId,
    prNumber: input.prNumber,
    title: input.title,
    summary: input.summary,
    significance: input.significance,
    categories: input.categories,
    candidateType,
    mantleRelevanceScore,
    selectionReason,
    targetCandidates,
  };
}
