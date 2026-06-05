import type { WeeklyCandidate } from "./weekly-relevance";

export interface CounterpartCheckItem {
  source: {
    projectId: string;
    prNumber: number;
    title: string;
  };
  signalType: "optimization_opportunity" | "risk_signal";
  targetProjectId: string;
  whyItMatters: string;
  evidence: string;
  evidenceLabel: "metadata_supported" | "recent_activity_supported" | "worth_checking";
  confidence: "high" | "medium" | "low";
  suggestedAction: string;
}

const RISK_SIGNAL_KEYWORDS = /\b(risk|fix|bug|vuln|compat|regression|crash|failure|consensus)/i;

function determineSignalType(
  candidateType: WeeklyCandidate["candidateType"],
  categories: string[],
  directionSignal: string | null
): CounterpartCheckItem["signalType"] {
  if (candidateType === "risk_fix" || categories.includes("security")) {
    return "risk_signal";
  }
  if (directionSignal !== null && RISK_SIGNAL_KEYWORDS.test(directionSignal)) {
    return "risk_signal";
  }
  return "optimization_opportunity";
}

function countTagOverlap(matchReason: string): number {
  const match = matchReason.match(/^Tag overlap:\s*(.+)$/);
  if (!match) return 0;
  return match[1]!.split(",").filter((t) => t.trim().length > 0).length;
}

function determineConfidence(
  candidateType: WeeklyCandidate["candidateType"],
  matchType: "manual" | "tag_fallback",
  tagOverlapCount: number
): "high" | "medium" | "low" {
  if (matchType === "manual") {
    if (candidateType === "risk_fix" || candidateType === "transferable_optimization") {
      return "high";
    }
    return "medium";
  }
  // tag_fallback: never high
  if (tagOverlapCount >= 2) return "medium";
  return "low";
}

function determineEvidenceLabel(
  matchType: "manual" | "tag_fallback",
  tagOverlapCount: number
): CounterpartCheckItem["evidenceLabel"] {
  if (matchType === "manual") return "metadata_supported";
  if (tagOverlapCount >= 2) return "metadata_supported";
  return "worth_checking";
}

function buildWhyItMatters(
  signalType: CounterpartCheckItem["signalType"],
  sourceProjectId: string,
  targetProjectId: string,
  title: string
): string {
  if (signalType === "risk_signal") {
    return `${title} in ${sourceProjectId} may expose a similar risk in ${targetProjectId}.`;
  }
  return `${title} in ${sourceProjectId} represents an optimization potentially applicable to ${targetProjectId}.`;
}

function buildEvidence(selectionReason: string, matchReason: string): string {
  return `${selectionReason}; ${matchReason}`;
}

function buildSuggestedAction(
  signalType: CounterpartCheckItem["signalType"],
  confidence: CounterpartCheckItem["confidence"],
  targetProjectId: string
): string {
  if (confidence === "low") {
    return `Worth checking whether ${targetProjectId} is affected by a similar issue.`;
  }
  if (signalType === "risk_signal") {
    return `Check whether ${targetProjectId} has the same or similar issue.`;
  }
  return `Evaluate whether ${targetProjectId} can adopt a similar approach.`;
}

function confidenceRank(c: CounterpartCheckItem["confidence"]): number {
  return c === "high" ? 3 : c === "medium" ? 2 : 1;
}

export function buildCounterpartChecks(candidates: WeeklyCandidate[]): CounterpartCheckItem[] {
  const items: CounterpartCheckItem[] = [];

  for (const candidate of candidates) {
    if (candidate.mantleRelevanceScore === 0) continue;
    if (candidate.targetCandidates.length === 0) continue;

    for (const target of candidate.targetCandidates) {
      const tagOverlapCount =
        target.matchType === "tag_fallback" ? countTagOverlap(target.matchReason) : 0;

      const confidence = determineConfidence(
        candidate.candidateType,
        target.matchType,
        tagOverlapCount
      );

      const signalType = determineSignalType(candidate.candidateType, candidate.categories, candidate.directionSignal);

      // Low-confidence items: only include for risk signals
      if (confidence === "low" && signalType !== "risk_signal") continue;

      const evidenceLabel = determineEvidenceLabel(target.matchType, tagOverlapCount);

      items.push({
        source: {
          projectId: candidate.sourceProjectId,
          prNumber: candidate.prNumber,
          title: candidate.title,
        },
        signalType,
        targetProjectId: target.projectId,
        whyItMatters: buildWhyItMatters(
          signalType,
          candidate.sourceProjectId,
          target.projectId,
          candidate.title
        ),
        evidence: buildEvidence(candidate.selectionReason, target.matchReason),
        evidenceLabel,
        confidence,
        suggestedAction: buildSuggestedAction(signalType, confidence, target.projectId),
      });
    }
  }

  // Risk signals first, then by confidence descending
  items.sort((a, b) => {
    if (a.signalType !== b.signalType) {
      return a.signalType === "risk_signal" ? -1 : 1;
    }
    return confidenceRank(b.confidence) - confidenceRank(a.confidence);
  });

  return items;
}
