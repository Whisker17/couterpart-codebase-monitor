import { describe, it, expect } from "bun:test";
import { buildDailyCard, stripCounterpartRecommendations, buildPrHtmlUrl, formatMarkdownLink } from "./daily-card";
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
        htmlUrl: "https://github.com/org/repo-a/pull/101",
        summary: "Adds OAuth2 authentication flow",
        technicalDetail: "Changed auth middleware to use passport-oauth2",
        significance: "directional_shift",
        directionSignal: "migrating auth to OAuth2",
      },
      {
        prNumber: 102,
        title: "Fix typo in README",
        htmlUrl: "https://github.com/org/repo-a/pull/102",
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
        htmlUrl: "https://github.com/org/repo-b/pull/200",
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
        htmlUrl: "https://github.com/org/repo-c/pull/300",
        summary: "Update lodash to 4.17.21",
        technicalDetail: null,
        significance: "routine",
        directionSignal: null,
      },
      {
        prNumber: 301,
        title: "Fix lint warnings",
        htmlUrl: "https://github.com/org/repo-c/pull/301",
        summary: "Address eslint warnings",
        technicalDetail: null,
        significance: "routine",
        directionSignal: null,
      },
      {
        prNumber: 302,
        title: "Update README",
        htmlUrl: "https://github.com/org/repo-c/pull/302",
        summary: "Docs update",
        technicalDetail: null,
        significance: "routine",
        directionSignal: null,
      },
      {
        prNumber: 303,
        title: "Version bump",
        htmlUrl: "https://github.com/org/repo-c/pull/303",
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

  it("detail panel is labeled 'Notable PRs' when significant PRs exist", () => {
    const card = buildDailyCard("2026-06-05", sampleAnalyses);
    const panel = card.elements.find((e) => e.tag === "collapsible_panel") as {
      tag: "collapsible_panel";
      expanded: boolean;
      header: { title: { tag: string; content: string } };
      elements: Array<{ tag: string; content: string }>;
    };
    expect(panel).toBeDefined();
    expect(panel.header.title.content).toBe("Notable PRs");
    expect(panel.elements[0]!.content).toContain("org/repo-a");
    expect(panel.elements[0]!.content).toContain("#101");
  });

  it("detail panel is labeled 'PR Details' when only routine PRs exist", () => {
    const card = buildDailyCard("2026-06-05", routineOnlyAnalyses);
    const panel = card.elements.find((e) => e.tag === "collapsible_panel") as {
      tag: "collapsible_panel";
      header: { title: { tag: string; content: string } };
    };
    expect(panel.header.title.content).toBe("PR Details");
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
    expect(detail).toContain("#101");
    expect(detail).toContain("Add OAuth2 support");
    expect(detail).not.toContain("#102");
    expect(detail).not.toContain("Fix typo");
    expect(detail).toContain("routine");
    expect(detail).toContain("not expanded");
  });

  it("PR title is rendered as a markdown link in detail panel", () => {
    const card = buildDailyCard("2026-06-05", sampleAnalyses);
    const panel = card.elements.find((e) => e.tag === "collapsible_panel") as {
      tag: "collapsible_panel";
      elements: Array<{ content: string }>;
    };
    const detail = panel.elements[0]!.content;
    expect(detail).toContain("[#101 Add OAuth2 support](https://github.com/org/repo-a/pull/101)");
  });

  it("routine-only project shows exactly one representative PR in detail", () => {
    const card = buildDailyCard("2026-06-05", routineOnlyAnalyses);
    const panel = card.elements.find((e) => e.tag === "collapsible_panel") as {
      tag: "collapsible_panel";
      elements: Array<{ content: string }>;
    };
    const detail = panel.elements[0]!.content;
    expect(detail).toContain("#300");
    expect(detail).toContain("Bump lodash");
    expect(detail).not.toContain("#301");
    expect(detail).not.toContain("#302");
    expect(detail).not.toContain("#303");
    expect(detail).toContain("3 more routine PR");
  });

  it("routine-only project with exactly 1 PR shows no 'N more' count note", () => {
    const singleRoutineAnalyses: GroupedAnalyses = [
      {
        projectId: "org/repo-e",
        prCount: 1,
        directionalShiftCount: 0,
        notableCount: 0,
        topDirectionSignal: null,
        prs: [
          {
            prNumber: 400,
            title: "Only routine PR",
            htmlUrl: "https://github.com/org/repo-e/pull/400",
            summary: "Single routine change",
            technicalDetail: null,
            significance: "routine",
            directionSignal: null,
          },
        ],
      },
    ];

    const card = buildDailyCard("2026-06-05", singleRoutineAnalyses);
    const panel = card.elements.find((e) => e.tag === "collapsible_panel") as {
      tag: "collapsible_panel";
      elements: Array<{ content: string }>;
    };
    const detail = panel.elements[0]!.content;
    expect(detail).toContain("#400");
    expect(detail).not.toContain("more routine");
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
            htmlUrl: "https://github.com/org/reth/pull/500",
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
            htmlUrl: "https://github.com/org/repo-d/pull/999",
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
    expect(content).not.toContain("weeklyCandidateReason");
    expect(content).not.toContain("significant architectural change");
    expect(content).not.toContain("candidateTags");
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

describe("buildPrHtmlUrl", () => {
  it("builds URL from project URL and PR number", () => {
    expect(buildPrHtmlUrl("https://github.com/org/repo", 42)).toBe("https://github.com/org/repo/pull/42");
  });

  it("strips trailing slash before appending /pull/", () => {
    expect(buildPrHtmlUrl("https://github.com/org/repo/", 1)).toBe("https://github.com/org/repo/pull/1");
  });

  it("strips multiple trailing slashes", () => {
    expect(buildPrHtmlUrl("https://github.com/org/repo//", 5)).toBe("https://github.com/org/repo/pull/5");
  });
});

describe("formatMarkdownLink", () => {
  it("formats a simple label and URL as a markdown link", () => {
    expect(formatMarkdownLink("#101 Add OAuth2 support", "https://github.com/org/repo/pull/101")).toBe(
      "[#101 Add OAuth2 support](https://github.com/org/repo/pull/101)"
    );
  });

  it("escapes [ and ] in the label", () => {
    expect(formatMarkdownLink("[breaking] Fix", "https://example.com")).toBe(
      "[\\[breaking\\] Fix](https://example.com)"
    );
  });

  it("collapses whitespace and trims the label", () => {
    expect(formatMarkdownLink("  Fix   typo  ", "https://example.com")).toBe(
      "[Fix typo](https://example.com)"
    );
  });

  it("collapses newlines in label into a single space", () => {
    expect(formatMarkdownLink("title\nwith\nnewlines", "https://example.com")).toBe(
      "[title with newlines](https://example.com)"
    );
  });

  it("returns plain label when URL is empty string", () => {
    expect(formatMarkdownLink("#42 Some PR", "")).toBe("#42 Some PR");
  });

  it("returns plain label when URL is whitespace-only", () => {
    expect(formatMarkdownLink("#42 Some PR", "   ")).toBe("#42 Some PR");
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

  it("does not consume text after a semicolon following a stripped clause", () => {
    const input =
      "switching to async executor; Mantle should update its runtime adapter; source repo also removes legacy sync path.";
    const result = stripCounterpartRecommendations(input);
    expect(result).toBe(
      "switching to async executor; source repo also removes legacy sync path."
    );
    expect(result).not.toContain("Mantle should");
    expect(result).toContain("source repo also removes legacy sync path");
  });
});
