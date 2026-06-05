import { describe, it, expect } from "bun:test";
import { resolveTargetCandidates, scoreCandidate } from "./weekly-relevance";
import type { MantleConfig, ScoringInput } from "./weekly-relevance";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const BASE_CONFIG: MantleConfig = {
  mantleTargets: [
    {
      projectId: "mantle/reth",
      tags: ["reth", "execution-client", "l2", "ethereum"],
      notes: "Mantle reth target",
    },
  ],
  counterpartRelationships: [
    {
      source: "base/base",
      targets: ["mantle/reth"],
      relationship: "manual",
      reason: "Base and Mantle both track reth / OP Stack execution-client evolution",
    },
    {
      source: "ethereum-optimism/op-geth",
      targets: ["mantle/reth"],
      relationship: "manual",
      reason: "OP Stack execution layer changes may affect Mantle execution-client strategy",
    },
  ],
};

function makeInput(overrides: Partial<ScoringInput> = {}): ScoringInput {
  return {
    sourceProjectId: "base/base",
    prNumber: 42,
    title: "Test PR",
    summary: "A test pull request",
    significance: "notable",
    categories: [],
    directionSignal: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveTargetCandidates
// ---------------------------------------------------------------------------

describe("resolveTargetCandidates — manual relationship lookup", () => {
  it("returns manual matchType for a configured source", () => {
    const result = resolveTargetCandidates("base/base", [], BASE_CONFIG);
    expect(result).toHaveLength(1);
    expect(result[0]!.projectId).toBe("mantle/reth");
    expect(result[0]!.matchType).toBe("manual");
    expect(result[0]!.matchReason).toContain("reth");
  });

  it("returns empty array for unknown source with no tag overlap", () => {
    const result = resolveTargetCandidates("unknown/repo", [], BASE_CONFIG);
    expect(result).toHaveLength(0);
  });

  it("includes manual reason verbatim", () => {
    const result = resolveTargetCandidates("ethereum-optimism/op-geth", [], BASE_CONFIG);
    expect(result[0]!.matchReason).toBe(
      "OP Stack execution layer changes may affect Mantle execution-client strategy"
    );
  });
});

describe("resolveTargetCandidates — tag fallback", () => {
  it("returns tag_fallback for project with tag overlap when no manual relationship", () => {
    const config: MantleConfig = {
      mantleTargets: [
        { projectId: "mantle/reth", tags: ["reth", "l2"], notes: "" },
      ],
      counterpartRelationships: [],
    };
    const result = resolveTargetCandidates("bnb-chain/reth-bsc", ["reth", "bsc"], config);
    expect(result).toHaveLength(1);
    expect(result[0]!.matchType).toBe("tag_fallback");
    expect(result[0]!.matchReason).toContain("reth");
  });

  it("does not return tag_fallback when no tag overlap", () => {
    const config: MantleConfig = {
      mantleTargets: [
        { projectId: "mantle/reth", tags: ["reth", "l2"], notes: "" },
      ],
      counterpartRelationships: [],
    };
    const result = resolveTargetCandidates("unrelated/repo", ["typescript", "frontend"], config);
    expect(result).toHaveLength(0);
  });

  it("tag_fallback matchReason lists overlapping tags", () => {
    const config: MantleConfig = {
      mantleTargets: [
        { projectId: "mantle/reth", tags: ["reth", "ethereum", "l2"], notes: "" },
      ],
      counterpartRelationships: [],
    };
    const result = resolveTargetCandidates("some/project", ["ethereum", "l2", "go"], config);
    expect(result[0]!.matchReason).toContain("ethereum");
    expect(result[0]!.matchReason).toContain("l2");
  });
});

describe("resolveTargetCandidates — manual priority over tag fallback", () => {
  it("manual relationship supersedes tag fallback for the same target — no duplicate entries", () => {
    // base/base has a manual relationship AND shares tags with mantle/reth
    const result = resolveTargetCandidates(
      "base/base",
      ["reth", "ethereum", "l2"],
      BASE_CONFIG
    );
    // Should be exactly 1 result: manual. Tag fallback must not add a second entry.
    const rethMatches = result.filter((r) => r.projectId === "mantle/reth");
    expect(rethMatches).toHaveLength(1);
    expect(rethMatches[0]!.matchType).toBe("manual");
  });
});

// ---------------------------------------------------------------------------
// scoreCandidate — candidateType determination
// ---------------------------------------------------------------------------

describe("scoreCandidate — candidateType", () => {
  it("security category → risk_fix regardless of significance", () => {
    const result = scoreCandidate(
      makeInput({ significance: "routine", categories: ["security"] }),
      BASE_CONFIG
    );
    expect(result.candidateType).toBe("risk_fix");
  });

  it("directional_shift → architecture_direction when no security", () => {
    const result = scoreCandidate(
      makeInput({ significance: "directional_shift", categories: ["architecture"] }),
      BASE_CONFIG
    );
    expect(result.candidateType).toBe("architecture_direction");
  });

  it("performance category → transferable_optimization", () => {
    const result = scoreCandidate(
      makeInput({ significance: "notable", categories: ["performance"] }),
      BASE_CONFIG
    );
    expect(result.candidateType).toBe("transferable_optimization");
  });

  it("notable with no special category → large_technical_change", () => {
    const result = scoreCandidate(
      makeInput({ significance: "notable", categories: ["testing"] }),
      BASE_CONFIG
    );
    expect(result.candidateType).toBe("large_technical_change");
  });

  it("routine with no special category → routine_pattern", () => {
    const result = scoreCandidate(
      makeInput({ significance: "routine", categories: [] }),
      BASE_CONFIG
    );
    expect(result.candidateType).toBe("routine_pattern");
  });
});

// ---------------------------------------------------------------------------
// scoreCandidate — risk_fix priority
// ---------------------------------------------------------------------------

describe("scoreCandidate — risk_fix ranks above transferable_optimization", () => {
  it("risk_fix score > transferable_optimization score", () => {
    const riskFix = scoreCandidate(
      makeInput({ significance: "notable", categories: ["security"] }),
      BASE_CONFIG
    );
    const optimization = scoreCandidate(
      makeInput({ significance: "notable", categories: ["performance"] }),
      BASE_CONFIG
    );
    expect(riskFix.mantleRelevanceScore).toBeGreaterThan(optimization.mantleRelevanceScore);
  });

  it("risk_fix score > architecture_direction score", () => {
    const riskFix = scoreCandidate(
      makeInput({ significance: "notable", categories: ["security"] }),
      BASE_CONFIG
    );
    const arch = scoreCandidate(
      makeInput({ significance: "directional_shift", categories: ["architecture"] }),
      BASE_CONFIG
    );
    expect(riskFix.mantleRelevanceScore).toBeGreaterThan(arch.mantleRelevanceScore);
  });
});

// ---------------------------------------------------------------------------
// scoreCandidate — routine suppression
// ---------------------------------------------------------------------------

describe("scoreCandidate — routine suppression", () => {
  it("routine PR gets mantleRelevanceScore = 0 by default", () => {
    const result = scoreCandidate(
      makeInput({ significance: "routine", categories: [], isPartOfPattern: false }),
      BASE_CONFIG
    );
    expect(result.mantleRelevanceScore).toBe(0);
    expect(result.candidateType).toBe("routine_pattern");
  });

  it("routine PR supporting a weekly pattern gets non-zero score", () => {
    const result = scoreCandidate(
      makeInput({ significance: "routine", categories: [], isPartOfPattern: true }),
      BASE_CONFIG
    );
    expect(result.mantleRelevanceScore).toBeGreaterThan(0);
  });

  it("non-routine PRs are not suppressed even with isPartOfPattern false", () => {
    const result = scoreCandidate(
      makeInput({ significance: "notable", categories: ["performance"], isPartOfPattern: false }),
      BASE_CONFIG
    );
    expect(result.mantleRelevanceScore).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// scoreCandidate — targetCandidates wiring
// ---------------------------------------------------------------------------

describe("scoreCandidate — targetCandidates", () => {
  it("wires manual targetCandidates for known source", () => {
    const result = scoreCandidate(
      makeInput({ sourceProjectId: "base/base" }),
      BASE_CONFIG,
      ["blockchain", "l2", "ethereum"]
    );
    expect(result.targetCandidates).toHaveLength(1);
    expect(result.targetCandidates[0]!.matchType).toBe("manual");
    expect(result.targetCandidates[0]!.projectId).toBe("mantle/reth");
  });

  it("wires tag_fallback for source with tag overlap but no manual relationship", () => {
    const config: MantleConfig = {
      mantleTargets: [{ projectId: "mantle/reth", tags: ["reth"], notes: "" }],
      counterpartRelationships: [],
    };
    const result = scoreCandidate(
      makeInput({ sourceProjectId: "bnb-chain/reth-bsc" }),
      config,
      ["reth", "bsc"]
    );
    expect(result.targetCandidates[0]!.matchType).toBe("tag_fallback");
  });

  it("returns empty targetCandidates when no match", () => {
    const config: MantleConfig = {
      mantleTargets: [{ projectId: "mantle/reth", tags: ["reth"], notes: "" }],
      counterpartRelationships: [],
    };
    const result = scoreCandidate(
      makeInput({ sourceProjectId: "unrelated/repo" }),
      config,
      ["typescript"]
    );
    expect(result.targetCandidates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// scoreCandidate — directional_shift score boost
// ---------------------------------------------------------------------------

describe("scoreCandidate — directional_shift boost", () => {
  it("directional_shift significance adds 10 points to architecture_direction base", () => {
    const boosted = scoreCandidate(
      makeInput({ significance: "directional_shift", categories: ["architecture"] }),
      BASE_CONFIG
    );
    const notBoosted = scoreCandidate(
      makeInput({ significance: "notable", categories: ["architecture"] }),
      BASE_CONFIG
    );
    expect(boosted.mantleRelevanceScore).toBeGreaterThan(notBoosted.mantleRelevanceScore);
  });
});
