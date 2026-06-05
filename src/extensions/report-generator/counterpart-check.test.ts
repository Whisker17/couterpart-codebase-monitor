import { describe, it, expect } from "bun:test";
import { buildCounterpartChecks } from "./counterpart-check";
import type { WeeklyCandidate } from "./weekly-relevance";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeCandidate(overrides: Partial<WeeklyCandidate> = {}): WeeklyCandidate {
  return {
    sourceProjectId: "base/base",
    prNumber: 1234,
    title: "Fix network handler",
    summary: "Patches a reliability issue in the network handler",
    significance: "notable",
    categories: [],
    candidateType: "large_technical_change",
    mantleRelevanceScore: 50,
    selectionReason: "Notable refactor or migration",
    targetCandidates: [
      {
        projectId: "mantle/reth",
        matchType: "manual",
        matchReason: "Base and Mantle both track reth / OP Stack execution-client evolution",
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildCounterpartChecks — empty input", () => {
  it("returns empty array when given no candidates", () => {
    expect(buildCounterpartChecks([])).toEqual([]);
  });

  it("returns empty array when candidate has no targetCandidates", () => {
    const candidate = makeCandidate({ targetCandidates: [] });
    expect(buildCounterpartChecks([candidate])).toEqual([]);
  });

  it("skips candidates with mantleRelevanceScore of 0", () => {
    const candidate = makeCandidate({ mantleRelevanceScore: 0 });
    expect(buildCounterpartChecks([candidate])).toEqual([]);
  });
});

describe("buildCounterpartChecks — risk_fix + manual relationship", () => {
  const riskCandidate = makeCandidate({
    candidateType: "risk_fix",
    categories: ["security"],
    mantleRelevanceScore: 90,
    significance: "directional_shift",
    selectionReason: "Security/reliability fix: critical vulnerability",
  });

  it("produces a risk_signal item", () => {
    const items = buildCounterpartChecks([riskCandidate]);
    expect(items).toHaveLength(1);
    expect(items[0]!.signalType).toBe("risk_signal");
  });

  it("assigns high confidence for risk_fix with manual relationship", () => {
    const items = buildCounterpartChecks([riskCandidate]);
    expect(items[0]!.confidence).toBe("high");
  });

  it("assigns metadata_supported evidence label for manual relationship", () => {
    const items = buildCounterpartChecks([riskCandidate]);
    expect(items[0]!.evidenceLabel).toBe("metadata_supported");
  });

  it("populates source fields correctly", () => {
    const items = buildCounterpartChecks([riskCandidate]);
    expect(items[0]!.source.projectId).toBe("base/base");
    expect(items[0]!.source.prNumber).toBe(1234);
    expect(items[0]!.source.title).toBe("Fix network handler");
  });

  it("populates targetProjectId correctly", () => {
    const items = buildCounterpartChecks([riskCandidate]);
    expect(items[0]!.targetProjectId).toBe("mantle/reth");
  });

  it("populates whyItMatters with non-empty content", () => {
    const items = buildCounterpartChecks([riskCandidate]);
    expect(items[0]!.whyItMatters.length).toBeGreaterThan(0);
  });

  it("populates evidence with content from selectionReason and matchReason", () => {
    const items = buildCounterpartChecks([riskCandidate]);
    expect(items[0]!.evidence.length).toBeGreaterThan(0);
  });

  it("suggestedAction for high-confidence risk signal asks to check for similar issue", () => {
    const items = buildCounterpartChecks([riskCandidate]);
    expect(items[0]!.suggestedAction.toLowerCase()).toContain("check");
    expect(items[0]!.suggestedAction.toLowerCase()).not.toContain("worth checking");
  });
});

describe("buildCounterpartChecks — transferable_optimization + manual relationship", () => {
  const optCandidate = makeCandidate({
    candidateType: "transferable_optimization",
    categories: ["performance"],
    mantleRelevanceScore: 75,
    selectionReason: "Performance optimization: caching layer improvement",
  });

  it("produces an optimization_opportunity item", () => {
    const items = buildCounterpartChecks([optCandidate]);
    expect(items[0]!.signalType).toBe("optimization_opportunity");
  });

  it("assigns high confidence for transferable_optimization with manual relationship", () => {
    const items = buildCounterpartChecks([optCandidate]);
    expect(items[0]!.confidence).toBe("high");
  });

  it("assigns metadata_supported evidence label", () => {
    const items = buildCounterpartChecks([optCandidate]);
    expect(items[0]!.evidenceLabel).toBe("metadata_supported");
  });

  it("suggestedAction for optimization opportunity asks to evaluate adoption", () => {
    const items = buildCounterpartChecks([optCandidate]);
    expect(items[0]!.suggestedAction.toLowerCase()).toContain("evaluat");
  });
});

describe("buildCounterpartChecks — architecture_direction + manual relationship", () => {
  const archCandidate = makeCandidate({
    candidateType: "architecture_direction",
    categories: ["architecture"],
    mantleRelevanceScore: 65,
    selectionReason: "Architectural direction change: refactoring execution layer",
  });

  it("produces an optimization_opportunity item", () => {
    const items = buildCounterpartChecks([archCandidate]);
    expect(items[0]!.signalType).toBe("optimization_opportunity");
  });

  it("assigns medium confidence for architecture_direction with manual relationship", () => {
    const items = buildCounterpartChecks([archCandidate]);
    expect(items[0]!.confidence).toBe("medium");
  });

  it("assigns metadata_supported evidence label", () => {
    const items = buildCounterpartChecks([archCandidate]);
    expect(items[0]!.evidenceLabel).toBe("metadata_supported");
  });
});

describe("buildCounterpartChecks — tag_fallback", () => {
  const tagFallbackMultipleCandidate = makeCandidate({
    sourceProjectId: "bnb-chain/reth-bsc",
    candidateType: "transferable_optimization",
    categories: ["performance"],
    mantleRelevanceScore: 75,
    targetCandidates: [
      {
        projectId: "mantle/reth",
        matchType: "tag_fallback",
        matchReason: "Tag overlap: reth, l2",
      },
    ],
  });

  it("produces an item for tag_fallback with multiple overlapping tags", () => {
    const items = buildCounterpartChecks([tagFallbackMultipleCandidate]);
    expect(items).toHaveLength(1);
  });

  it("assigns medium confidence for tag_fallback with multiple tag overlap", () => {
    const items = buildCounterpartChecks([tagFallbackMultipleCandidate]);
    expect(items[0]!.confidence).toBe("medium");
  });

  it("assigns metadata_supported for tag_fallback with multiple tag overlap", () => {
    const items = buildCounterpartChecks([tagFallbackMultipleCandidate]);
    expect(items[0]!.evidenceLabel).toBe("metadata_supported");
  });

  it("tag_fallback alone does not produce high confidence", () => {
    const items = buildCounterpartChecks([tagFallbackMultipleCandidate]);
    expect(items[0]!.confidence).not.toBe("high");
  });
});

describe("buildCounterpartChecks — tag_fallback single tag (risk_fix only)", () => {
  const tagFallbackSingleRisk = makeCandidate({
    sourceProjectId: "bnb-chain/reth-bsc",
    candidateType: "risk_fix",
    categories: ["security"],
    mantleRelevanceScore: 90,
    targetCandidates: [
      {
        projectId: "mantle/reth",
        matchType: "tag_fallback",
        matchReason: "Tag overlap: reth",
      },
    ],
  });

  it("produces a low-confidence item for risk_fix with single-tag fallback", () => {
    const items = buildCounterpartChecks([tagFallbackSingleRisk]);
    expect(items).toHaveLength(1);
    expect(items[0]!.confidence).toBe("low");
  });

  it("assigns worth_checking evidence label for single-tag fallback", () => {
    const items = buildCounterpartChecks([tagFallbackSingleRisk]);
    expect(items[0]!.evidenceLabel).toBe("worth_checking");
  });

  it("low-confidence suggestedAction is phrased as worth checking", () => {
    const items = buildCounterpartChecks([tagFallbackSingleRisk]);
    expect(items[0]!.suggestedAction.toLowerCase()).toContain("worth checking");
  });
});

describe("buildCounterpartChecks — low-confidence non-risk items are filtered", () => {
  it("does not produce items for tag_fallback single-tag non-risk candidates", () => {
    const candidate = makeCandidate({
      sourceProjectId: "bnb-chain/reth-bsc",
      candidateType: "architecture_direction",
      categories: ["architecture"],
      mantleRelevanceScore: 65,
      targetCandidates: [
        {
          projectId: "mantle/reth",
          matchType: "tag_fallback",
          matchReason: "Tag overlap: reth",
        },
      ],
    });
    expect(buildCounterpartChecks([candidate])).toHaveLength(0);
  });
});

describe("buildCounterpartChecks — sort order", () => {
  it("risk signals sort before optimization opportunities", () => {
    const optCandidate = makeCandidate({
      candidateType: "transferable_optimization",
      categories: ["performance"],
      mantleRelevanceScore: 75,
      selectionReason: "Performance optimization",
    });
    const riskCandidate = makeCandidate({
      prNumber: 5678,
      title: "Security fix",
      candidateType: "risk_fix",
      categories: ["security"],
      mantleRelevanceScore: 90,
      selectionReason: "Security fix",
    });

    const items = buildCounterpartChecks([optCandidate, riskCandidate]);
    expect(items).toHaveLength(2);
    expect(items[0]!.signalType).toBe("risk_signal");
    expect(items[1]!.signalType).toBe("optimization_opportunity");
  });

  it("within same signalType, higher confidence sorts first", () => {
    const highConfManual = makeCandidate({
      prNumber: 100,
      candidateType: "risk_fix",
      categories: ["security"],
      mantleRelevanceScore: 90,
    });
    const lowConfRisk = makeCandidate({
      prNumber: 200,
      title: "Low conf risk",
      candidateType: "risk_fix",
      categories: ["security"],
      mantleRelevanceScore: 90,
      targetCandidates: [
        { projectId: "mantle/reth", matchType: "tag_fallback", matchReason: "Tag overlap: reth" },
      ],
    });

    const items = buildCounterpartChecks([lowConfRisk, highConfManual]);
    expect(items[0]!.confidence).toBe("high");
    expect(items[1]!.confidence).toBe("low");
  });
});

describe("buildCounterpartChecks — produces one item per (candidate × target)", () => {
  it("produces two items when a candidate has two target candidates", () => {
    const candidate = makeCandidate({
      targetCandidates: [
        {
          projectId: "mantle/reth",
          matchType: "manual",
          matchReason: "Manual relationship to reth",
        },
        {
          projectId: "mantle/op-geth",
          matchType: "manual",
          matchReason: "Manual relationship to op-geth",
        },
      ],
    });
    const items = buildCounterpartChecks([candidate]);
    expect(items).toHaveLength(2);
    const targetIds = items.map((i) => i.targetProjectId);
    expect(targetIds).toContain("mantle/reth");
    expect(targetIds).toContain("mantle/op-geth");
  });
});
