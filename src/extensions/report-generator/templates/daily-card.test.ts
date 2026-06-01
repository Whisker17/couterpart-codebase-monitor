import { describe, it, expect } from "bun:test";
import { buildDailyCard, stripCounterpartRecommendations } from "./daily-card";
import type { GroupedAnalyses } from "./daily-card";

const sampleAnalyses: GroupedAnalyses = [
  {
    projectId: "org/repo-a",
    prCount: 2,
    directionalShiftCount: 1,
    notableCount: 0,
    topDirectionSignal: "migrating auth to OAuth2",
    prs: [
      {
        prNumber: 101,
        title: "Add OAuth2 support",
        summary: "Adds OAuth2 authentication flow",
        technicalDetail: "Changed auth middleware to use passport-oauth2",
        significance: "directional_shift",
        directionSignal: "migrating auth to OAuth2",
      },
      {
        prNumber: 102,
        title: "Fix typo in README",
        summary: "Fixes documentation typo",
        technicalDetail: null,
        significance: "routine",
        directionSignal: null,
      },
    ],
  },
  {
    projectId: "org/repo-b",
    prCount: 1,
    directionalShiftCount: 0,
    notableCount: 0,
    topDirectionSignal: null,
    prs: [
      {
        prNumber: 200,
        title: "Bump dependencies",
        summary: "Routine dependency update",
        technicalDetail: null,
        significance: "routine",
        directionSignal: null,
      },
    ],
  },
];

const routineOnlyAnalyses: GroupedAnalyses = [
  {
    projectId: "org/repo-c",
    prCount: 4,
    directionalShiftCount: 0,
    notableCount: 0,
    topDirectionSignal: null,
    prs: [
      {
        prNumber: 300,
        title: "Bump lodash",
        summary: "Update lodash to 4.17.21",
        technicalDetail: null,
        significance: "routine",
        directionSignal: null,
      },
      {
        prNumber: 301,
        title: "Fix lint warnings",
        summary: "Address eslint warnings",
        technicalDetail: null,
        significance: "routine",
        directionSignal: null,
      },
      {
        prNumber: 302,
        title: "Update README",
        summary: "Docs update",
        technicalDetail: null,
        significance: "routine",
        directionSignal: null,
      },
      {
        prNumber: 303,
        title: "Version bump",
        summary: "Bump to 1.2.3",
        technicalDetail: null,
        significance: "routine",
        directionSignal: null,
      },
    ],
  },
];

describe("buildDailyCard", () => {
  it("has correct three-level structure: config, header, elements", () => {
    const card = buildDailyCard("2026-06-05", sampleAnalyses);
    expect(card.config).toBeDefined();
    expect(card.header).toBeDefined();
    expect(card.elements).toBeDefined();
    expect(card.config.wide_screen_mode).toBe(true);
  });

  it("header title contains the date", () => {
    const card = buildDailyCard("2026-06-05", sampleAnalyses);
    expect(card.header.title.content).toContain("2026-06-05");
  });

  it("elements include a markdown summary element", () => {
    const card = buildDailyCard("2026-06-05", sampleAnalyses);
    const markdown = card.elements.find((e) => e.tag === "markdown");
    expect(markdown).toBeDefined();
    expect((markdown as { tag: "markdown"; content: string }).content).toContain("Summary");
  });

  it("summary lists each project's PR count and notable changes", () => {
    const card = buildDailyCard("2026-06-05", sampleAnalyses);
    const markdown = card.elements.find((e) => e.tag === "markdown") as {
      tag: "markdown";
      content: string;
    };
    expect(markdown.content).toContain("org/repo-a");
    expect(markdown.content).toContain("2 PRs");
    expect(markdown.content).toContain("directional shift");
    expect(markdown.content).toContain("migrating auth to OAuth2");
    expect(markdown.content).toContain("org/repo-b");
    expect(markdown.content).toContain("routine");
  });

  it("elements include an hr divider", () => {
    const card = buildDailyCard("2026-06-05", sampleAnalyses);
    const hr = card.elements.find((e) => e.tag === "hr");
    expect(hr).toBeDefined();
  });

  it("detail panel is inside a collapsible_panel labeled 'Notable PRs'", () => {
    const card = buildDailyCard("2026-06-05", sampleAnalyses);
    const panel = card.elements.find((e) => e.tag === "collapsible_panel") as {
      tag: "collapsible_panel";
      expanded: boolean;
      header: { title: { tag: string; content: string } };
      elements: Array<{ tag: string; content: string }>;
    };
    expect(panel).toBeDefined();
    expect(panel.header.title.content).toContain("Notable PRs");
    expect(panel.elements[0]!.content).toContain("org/repo-a");
    expect(panel.elements[0]!.content).toContain("#101");
  });

  it("panel starts expanded when significant (notable/directional_shift) PRs are present", () => {
    const card = buildDailyCard("2026-06-05", sampleAnalyses);
    const panel = card.elements.find((e) => e.tag === "collapsible_panel") as {
      tag: "collapsible_panel";
      expanded: boolean;
    };
    expect(panel.expanded).toBe(true);
  });

  it("panel starts collapsed when only routine PRs are present", () => {
    const card = buildDailyCard("2026-06-05", routineOnlyAnalyses);
    const panel = card.elements.find((e) => e.tag === "collapsible_panel") as {
      tag: "collapsible_panel";
      expanded: boolean;
    };
    expect(panel.expanded).toBe(false);
  });

  it("shows significant PRs in detail; routine PRs in same project are not expanded", () => {
    const card = buildDailyCard("2026-06-05", sampleAnalyses);
    const panel = card.elements.find((e) => e.tag === "collapsible_panel") as {
      tag: "collapsible_panel";
      elements: Array<{ content: string }>;
    };
    const detail = panel.elements[0]!.content;
    // The directional_shift PR for org/repo-a should appear
    expect(detail).toContain("#101");
    expect(detail).toContain("Add OAuth2 support");
    // The routine PR #102 should NOT appear by title
    expect(detail).not.toContain("#102");
    expect(detail).not.toContain("Fix typo");
    // An omit note should be shown for the skipped routine PR
    expect(detail).toContain("routine");
    expect(detail).toContain("not expanded");
  });

  it("routine-only project shows exactly one representative PR in detail", () => {
    const card = buildDailyCard("2026-06-05", routineOnlyAnalyses);
    const panel = card.elements.find((e) => e.tag === "collapsible_panel") as {
      tag: "collapsible_panel";
      elements: Array<{ content: string }>;
    };
    const detail = panel.elements[0]!.content;
    // First routine PR shown as representative
    expect(detail).toContain("#300");
    expect(detail).toContain("Bump lodash");
    // The other 3 routine PRs are not expanded
    expect(detail).not.toContain("#301");
    expect(detail).not.toContain("#302");
    expect(detail).not.toContain("#303");
    // A count note for the remaining routine PRs
    expect(detail).toContain("3 more routine PR");
  });

  it("daily report does not output counterpart action recommendations", () => {
    const analysesWithCounterpart: GroupedAnalyses = [
      {
        projectId: "org/reth",
        prCount: 1,
        directionalShiftCount: 1,
        notableCount: 0,
        topDirectionSignal: "switching to async executor",
        prs: [
          {
            prNumber: 500,
            title: "Async executor migration",
            summary: "Migrates the executor to async runtime",
            technicalDetail: null,
            significance: "directional_shift",
            directionSignal: "switching to async executor; Mantle should update its runtime adapter to remain compatible",
          },
        ],
      },
    ];

    const card = buildDailyCard("2026-06-05", analysesWithCounterpart);
    const content = JSON.stringify(card);
    // No "Mantle should ..." recommendations in the delivered Lark card
    expect(content).not.toContain("Mantle should");
    expect(content).not.toContain("mantle should");
  });

  it("weekly candidate fields on PR are accepted by the type but not rendered in Lark card", () => {
    const analysesWithCandidateFields: GroupedAnalyses = [
      {
        projectId: "org/repo-d",
        prCount: 1,
        directionalShiftCount: 1,
        notableCount: 0,
        topDirectionSignal: "major refactor",
        prs: [
          {
            prNumber: 999,
            title: "Refactor core module",
            summary: "Core module refactored for extensibility",
            technicalDetail: null,
            significance: "directional_shift",
            directionSignal: "major architectural refactor",
            weeklyCandidateReason: "significant architectural change",
            candidateTags: ["architecture", "breaking"],
          },
        ],
      },
    ];

    const card = buildDailyCard("2026-06-05", analysesWithCandidateFields);
    const content = JSON.stringify(card);
    // Internal weekly scoring fields must not appear in the Lark delivery
    expect(content).not.toContain("weeklyCandidateReason");
    expect(content).not.toContain("significant architectural change");
    expect(content).not.toContain("candidateTags");
    // But the PR itself should be shown
    expect(content).toContain("#999");
  });

  it("includes partial warning when partialWarning is provided", () => {
    const card = buildDailyCard("2026-06-05", sampleAnalyses, "Partial report: 2 project(s) failed collection/analysis");
    const markdown = card.elements.find((e) => e.tag === "markdown") as {
      tag: "markdown";
      content: string;
    };
    expect(markdown.content).toContain("⚠");
    expect(markdown.content).toContain("Partial report");
  });

  it("no partial warning when not provided", () => {
    const card = buildDailyCard("2026-06-05", sampleAnalyses);
    const markdown = card.elements.find((e) => e.tag === "markdown") as {
      tag: "markdown";
      content: string;
    };
    expect(markdown.content).not.toContain("⚠");
  });

  it("budget line is appended as a separate markdown element when provided", () => {
    const card = buildDailyCard("2026-06-05", sampleAnalyses, undefined, "Budget: $5.00 / $80.00 (6%)");
    const lastElement = card.elements[card.elements.length - 1] as { tag: string; content: string };
    expect(lastElement.tag).toBe("markdown");
    expect(lastElement.content).toContain("Budget:");
  });
});

describe("stripCounterpartRecommendations", () => {
  it("removes 'Mantle should ...' phrases", () => {
    const result = stripCounterpartRecommendations(
      "switching to async executor; Mantle should update its runtime adapter"
    );
    expect(result).not.toContain("Mantle should");
    expect(result).toContain("switching to async executor");
  });

  it("removes 'mantle/reth may need ...' phrases", () => {
    const result = stripCounterpartRecommendations(
      "adds new ABI; mantle/reth may need to update its ABI decoder");
    expect(result).not.toContain("may need");
    expect(result).toContain("adds new ABI");
  });

  it("removes 'mantle needs to ...' phrases", () => {
    const result = stripCounterpartRecommendations(
      "deprecates old API; mantle needs to migrate before next release"
    );
    expect(result).not.toContain("mantle needs to");
    expect(result).toContain("deprecates old API");
  });

  it("leaves non-counterpart text unchanged", () => {
    const text = "migrates executor to async runtime for better throughput";
    expect(stripCounterpartRecommendations(text)).toBe(text);
  });

  it("collapses extra whitespace left by removal", () => {
    const result = stripCounterpartRecommendations(
      "signal; Mantle should act on this; end of signal"
    );
    expect(result).not.toMatch(/\s{2,}/);
  });
});
