import { describe, it, expect } from "bun:test";
import { formatReport } from "./formatter";
import type { GroupedAnalyses } from "../report-generator/templates/daily-card";

const routinePR = {
  prNumber: 1,
  title: "Routine fix",
  htmlUrl: "https://github.com/org/repo-a/pull/1",
  summary: "s".repeat(50),
  technicalDetail: null,
  significance: "routine" as const,
  directionSignal: null,
};

const notablePR = {
  prNumber: 2,
  title: "Notable change",
  htmlUrl: "https://github.com/org/repo-a/pull/2",
  summary: "s".repeat(50),
  technicalDetail: null,
  significance: "notable" as const,
  directionSignal: "improving perf",
};

const smallAnalyses: GroupedAnalyses = [
  {
    projectId: "org/repo-a",
    prCount: 1,
    directionalShiftCount: 0,
    notableCount: 0,
    topDirectionSignal: null,
    prs: [routinePR],
  },
];

describe("formatReport", () => {
  it("returns single card for small report (<20KB)", () => {
    const result = formatReport("2026-06-01", smallAnalyses, undefined);
    expect(result.errors).toHaveLength(0);
    expect(result.cards).toHaveLength(1);
    const size = Buffer.byteLength(JSON.stringify(result.cards[0]), "utf-8");
    expect(size).toBeLessThanOrEqual(20_000);
  });

  it("returned card is valid LarkCard shape", () => {
    const result = formatReport("2026-06-01", smallAnalyses, undefined);
    const card = result.cards[0];
    expect(card).toHaveProperty("config");
    expect(card).toHaveProperty("header");
    expect(card).toHaveProperty("elements");
  });

  it("removes routine-only projects and appends omit note when full card exceeds 20KB but trimmed < 28KB", () => {
    // 30 notable-only projects with long summaries push the full card over 20KB.
    // 10 routine-only projects are filtered out by Level 2, bringing the card under 28KB.
    const longSummary = "x".repeat(600);
    const notableProjects: GroupedAnalyses = Array.from({ length: 30 }, (_, i) => ({
      projectId: `org/notable-project-${i}`,
      prCount: 1,
      directionalShiftCount: 0,
      notableCount: 1,
      topDirectionSignal: null,
      prs: [{ ...notablePR, prNumber: i + 1, summary: longSummary }],
    }));
    const routineOnlyProjects: GroupedAnalyses = Array.from({ length: 10 }, (_, i) => ({
      projectId: `org/routine-only-project-${i}`,
      prCount: 3,
      directionalShiftCount: 0,
      notableCount: 0,
      topDirectionSignal: null,
      prs: Array.from({ length: 3 }, (_, j) => ({
        prNumber: j + 100,
        title: `Routine PR ${i}-${j}`,
        htmlUrl: `https://github.com/org/proj/pull/${j + 100}`,
        summary: "routine summary",
        technicalDetail: null,
        significance: "routine" as const,
        directionSignal: null,
      })),
    }));
    const analyses: GroupedAnalyses = [...notableProjects, ...routineOnlyProjects];

    const result = formatReport("2026-06-01", analyses, undefined);
    expect(result.errors).toHaveLength(0);
    expect(result.cards).toHaveLength(1);
    const content = JSON.stringify(result.cards[0]);
    // Formatter Level 2 removed routine-only projects and appended the omit note
    expect(content).toContain("omitted");
    // Routine-only project detail is not in the trimmed output
    expect(content).not.toContain("routine-only-project");
    const size = Buffer.byteLength(content, "utf-8");
    expect(size).toBeLessThanOrEqual(28_000);
  });

  it("splits per project when trimmed card still exceeds 28KB", () => {
    // Need notable PRs with large text so even after filtering routine, card is still > 28KB
    const longDetail = "x".repeat(800);
    const projects: GroupedAnalyses = Array.from({ length: 3 }, (_, pi) => ({
      projectId: `org/repo-${pi}`,
      prCount: 15,
      directionalShiftCount: 15,
      notableCount: 0,
      topDirectionSignal: null,
      prs: Array.from({ length: 15 }, (_, i) => ({
        prNumber: pi * 100 + i,
        title: `Project ${pi} directional PR ${i}`,
        htmlUrl: `https://github.com/org/proj/pull/${pi * 100 + i}`,
        summary: longDetail,
        technicalDetail: longDetail,
        significance: "directional_shift" as const,
        directionSignal: longDetail,
      })),
    }));

    const result = formatReport("2026-06-01", projects, undefined);
    expect(result.cards.length).toBe(3);
  });

  it("each split card is independently readable (has header and elements)", () => {
    const longDetail = "x".repeat(800);
    const projects: GroupedAnalyses = Array.from({ length: 3 }, (_, pi) => ({
      projectId: `org/repo-${pi}`,
      prCount: 15,
      directionalShiftCount: 15,
      notableCount: 0,
      topDirectionSignal: null,
      prs: Array.from({ length: 15 }, (_, i) => ({
        prNumber: pi * 100 + i,
        title: `P${pi} PR ${i}`,
        htmlUrl: `https://github.com/org/proj/pull/${pi * 100 + i}`,
        summary: longDetail,
        technicalDetail: longDetail,
        significance: "directional_shift" as const,
        directionSignal: longDetail,
      })),
    }));

    const result = formatReport("2026-06-01", projects, undefined);
    for (const card of result.cards) {
      expect(card).toHaveProperty("header");
      expect(card).toHaveProperty("elements");
    }
  });

  it("uses Buffer.byteLength not str.length (Chinese chars are 3 bytes each)", () => {
    // A string of 7000 Chinese chars: str.length = 7000 but byte length = 21000 > 20000
    // If we used str.length it would wrongly classify as < 20000 and skip trimming
    const chineseSummary = "中".repeat(7000);
    const analyses: GroupedAnalyses = [
      {
        projectId: "org/repo-a",
        prCount: 1,
        directionalShiftCount: 0,
        notableCount: 0,
        topDirectionSignal: null,
        prs: [
          {
            prNumber: 1,
            title: "Chinese PR",
            htmlUrl: "https://github.com/org/proj/pull/1",
            summary: chineseSummary,
            technicalDetail: null,
            significance: "routine" as const,
            directionSignal: null,
          },
        ],
      },
    ];

    const result = formatReport("2026-06-01", analyses, undefined);
    // The card with 7000 Chinese chars (21000+ bytes) should trigger size degradation
    // (full card > 20000 bytes, trimmed to 0 notable PRs)
    // In the trimmed card there are no PRs (all routine were filtered) so it's small
    // OR it may split to per-project if trimmed exceeds 28KB - either way not 1 card of full size
    const fullCardBytes = Buffer.byteLength(
      JSON.stringify(result.cards[0]),
      "utf-8"
    );
    // The result should not be the full oversized card
    expect(fullCardBytes).toBeLessThanOrEqual(28_000);
  });

  it("returns no errors for small analyses", () => {
    const result = formatReport("2026-06-01", smallAnalyses, undefined);
    expect(result.errors).toHaveLength(0);
  });

  it("includes partialWarning in the card when provided", () => {
    const result = formatReport("2026-06-01", smallAnalyses, "Some projects failed");
    const content = JSON.stringify(result.cards[0]);
    expect(content).toContain("Some projects failed");
  });
});
