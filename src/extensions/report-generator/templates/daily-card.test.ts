import { describe, it, expect } from "bun:test";
import { buildDailyCard, buildSummaryContent, buildRepoPanels, stripCounterpartRecommendations, buildPrHtmlUrl, formatMarkdownLink, resolveHeaderTemplate, truncateAtSentenceBoundary } from "./daily-card";
import type { GroupedAnalyses, LarkCollapsiblePanel, LarkMarkdownElement } from "./daily-card";

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

  it("elements include a markdown summary element with metric line", () => {
    const card = buildDailyCard("2026-06-05", sampleAnalyses);
    const markdown = card.elements.find((e) => e.tag === "markdown");
    expect(markdown).toBeDefined();
    const content = (markdown as { tag: "markdown"; content: string }).content;
    expect(content).toContain("repos");
    expect(content).toContain("PR");
  });

  it("summary metric line and signal table list all projects with new format", () => {
    const card = buildDailyCard("2026-06-05", sampleAnalyses);
    const markdown = card.elements.find((e) => e.tag === "markdown") as {
      tag: "markdown";
      content: string;
    };
    // Metric line: 2 repos, 3 PRs (1 directional + 2 routine)
    expect(markdown.content).toContain("2 repos");
    expect(markdown.content).toContain("3 PR");
    expect(markdown.content).toContain("🔴 ×1");
    // Signal table: directional project bold, routine project plain
    expect(markdown.content).toContain("**org/repo-a**");
    expect(markdown.content).toContain("migrating auth to OAuth2");
    expect(markdown.content).toContain("org/repo-b");
    expect(markdown.content).toContain("routine PR");
  });

  it("elements include an hr divider", () => {
    const card = buildDailyCard("2026-06-05", sampleAnalyses);
    const hr = card.elements.find((e) => e.tag === "hr");
    expect(hr).toBeDefined();
  });

  it("per-project panel generated for directional project with correct emoji and header", () => {
    const card = buildDailyCard("2026-06-05", sampleAnalyses);
    const panel = card.elements.find(
      (e) => e.tag === "collapsible_panel"
    ) as LarkCollapsiblePanel;
    expect(panel).toBeDefined();
    expect(panel.header.title.content).toContain("🔴");
    expect(panel.header.title.content).toContain("org/repo-a");
    expect(panel.header.title.content).toContain("2 PR");
  });

  it("no panel generated for routine-only project", () => {
    const card = buildDailyCard("2026-06-05", sampleAnalyses);
    const panels = card.elements.filter((e) => e.tag === "collapsible_panel") as LarkCollapsiblePanel[];
    const repoBPanel = panels.find((p) => p.header.title.content.includes("org/repo-b"));
    expect(repoBPanel).toBeUndefined();
  });

  it("all-routine analyses: no collapsible panels, fallback markdown present", () => {
    const card = buildDailyCard("2026-06-05", routineOnlyAnalyses);
    const panels = card.elements.filter((e) => e.tag === "collapsible_panel");
    expect(panels).toHaveLength(0);
    const fallback = card.elements.find(
      (e): e is LarkMarkdownElement =>
        e.tag === "markdown" && (e as LarkMarkdownElement).content.includes("All PRs are routine today")
    );
    expect(fallback).toBeDefined();
  });

  it("directional panel starts expanded", () => {
    const card = buildDailyCard("2026-06-05", sampleAnalyses);
    const panel = card.elements.find(
      (e) => e.tag === "collapsible_panel"
    ) as LarkCollapsiblePanel;
    expect(panel.expanded).toBe(true);
  });

  it("shows significant PRs in detail panel; routine PR shown as hint", () => {
    const card = buildDailyCard("2026-06-05", sampleAnalyses);
    const panel = card.elements.find((e) => e.tag === "collapsible_panel") as LarkCollapsiblePanel;
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
    const panel = card.elements.find((e) => e.tag === "collapsible_panel") as LarkCollapsiblePanel;
    const detail = panel.elements[0]!.content;
    expect(detail).toContain("[#101 Add OAuth2 support](https://github.com/org/repo-a/pull/101)");
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

// Shared fixture for buildSummaryContent tests
const mixedAnalyses: GroupedAnalyses = [
  {
    projectId: "reth",
    prCount: 2,
    directionalShiftCount: 2,
    notableCount: 0,
    topDirectionSignal: null,
    prs: [
      {
        prNumber: 1,
        title: "Async executor migration",
        htmlUrl: "https://github.com/paradigmxyz/reth/pull/1",
        summary: "async executor migration summary",
        technicalDetail: null,
        significance: "directional_shift",
        directionSignal: "async executor 架构迁移，下游兼容性风险",
      },
      {
        prNumber: 2,
        title: "Remove legacy sync path",
        htmlUrl: "https://github.com/paradigmxyz/reth/pull/2",
        summary: "removes legacy sync path",
        technicalDetail: null,
        significance: "directional_shift",
        directionSignal: "removes legacy sync executor",
      },
    ],
  },
  {
    projectId: "geth",
    prCount: 3,
    directionalShiftCount: 0,
    notableCount: 3,
    topDirectionSignal: null,
    prs: [
      {
        prNumber: 10,
        title: "EIP-7702 support",
        htmlUrl: "https://github.com/ethereum/go-ethereum/pull/10",
        summary: "EIP-7702 支持新增",
        technicalDetail: null,
        significance: "notable",
        directionSignal: null,
      },
      {
        prNumber: 11,
        title: "Another notable",
        htmlUrl: "https://github.com/ethereum/go-ethereum/pull/11",
        summary: "Second notable PR",
        technicalDetail: null,
        significance: "notable",
        directionSignal: "second direction signal",
      },
      {
        prNumber: 12,
        title: "Third notable",
        htmlUrl: "https://github.com/ethereum/go-ethereum/pull/12",
        summary: "Third notable PR",
        technicalDetail: null,
        significance: "notable",
        directionSignal: null,
      },
    ],
  },
  {
    projectId: "revm",
    prCount: 2,
    directionalShiftCount: 0,
    notableCount: 0,
    topDirectionSignal: null,
    prs: [
      {
        prNumber: 20,
        title: "Bump deps",
        htmlUrl: "https://github.com/bluealloy/revm/pull/20",
        summary: "Routine update",
        technicalDetail: null,
        significance: "routine",
        directionSignal: null,
      },
      {
        prNumber: 21,
        title: "Fix lint",
        htmlUrl: "https://github.com/bluealloy/revm/pull/21",
        summary: "Routine fix",
        technicalDetail: null,
        significance: "routine",
        directionSignal: null,
      },
    ],
  },
];

describe("buildSummaryContent", () => {
  it("metric line: correct repo count, PR count, per-level counts", () => {
    // 3 repos, 7 PRs: 2 directional + 3 notable + 2 routine
    const content = buildSummaryContent(mixedAnalyses);
    expect(content).toContain("3 repos");
    expect(content).toContain("7 PR");
    expect(content).toContain("🔴 ×2");
    expect(content).toContain("🟡 ×3");
    expect(content).toContain("⚪ ×2");
  });

  it("zero count omission: all-routine → no 🔴 or 🟡 in metric line", () => {
    const content = buildSummaryContent(routineOnlyAnalyses);
    expect(content).not.toContain("🔴 ×");
    expect(content).not.toContain("🟡 ×");
    expect(content).toContain("⚪ ×4");
  });

  it("signal table sorts: directional > notable > routine", () => {
    const content = buildSummaryContent(mixedAnalyses);
    const rethPos = content.indexOf("reth");
    const gethPos = content.indexOf("geth");
    const revmPos = content.indexOf("revm");
    expect(rethPos).toBeLessThan(gethPos);
    expect(gethPos).toBeLessThan(revmPos);
  });

  it("notable/directional rows use bold project id", () => {
    const content = buildSummaryContent(mixedAnalyses);
    expect(content).toContain("**reth**");
    expect(content).toContain("**geth**");
  });

  it("routine-only rows use plain project id without bold", () => {
    const content = buildSummaryContent(mixedAnalyses);
    expect(content).not.toContain("**revm**");
    expect(content).toContain("⚪ revm — 2 routine PR");
  });

  it("signal text determinism: same-level multi-PR → first in array is used", () => {
    // geth has 3 notable PRs; first (pr 10) has no directionSignal → uses summary "EIP-7702 支持新增"
    // second PR (pr 11) has directionSignal "second direction signal" — must NOT appear
    const content = buildSummaryContent(mixedAnalyses);
    expect(content).toContain("EIP-7702 支持新增");
    expect(content).not.toContain("second direction signal");
  });

  it("signal text uses directionSignal over summary when directionSignal is set", () => {
    // reth PR #1: directionSignal has "下游兼容性风险" which is absent from summary
    const content = buildSummaryContent(mixedAnalyses);
    expect(content).toContain("下游兼容性风险");
  });

  it("long signal text (> 500 bytes) is truncated with ellipsis", () => {
    const longSignalAnalyses: GroupedAnalyses = [
      {
        projectId: "longrepo",
        prCount: 1,
        directionalShiftCount: 1,
        notableCount: 0,
        topDirectionSignal: null,
        prs: [
          {
            prNumber: 1,
            title: "Long signal PR",
            htmlUrl: "https://github.com/org/longrepo/pull/1",
            summary: "not used",
            technicalDetail: null,
            significance: "directional_shift",
            directionSignal: "A".repeat(600),
          },
        ],
      },
    ];
    const content = buildSummaryContent(longSignalAnalyses);
    expect(content).toContain("A".repeat(500) + "…");
    expect(content).not.toContain("A".repeat(501));
  });

  it("short signal text (< 500 bytes) is preserved unchanged", () => {
    const content = buildSummaryContent(mixedAnalyses);
    // reth signal "async executor 架构迁移，下游兼容性风险" is well under 500 bytes — no ellipsis
    expect(content).toContain("async executor 架构迁移，下游兼容性风险");
    expect(content).not.toContain("async executor 架构迁移，下游兼容性风险…");
  });

  it("partial warning appears at top before metric line", () => {
    const content = buildSummaryContent(routineOnlyAnalyses, {
      partialWarning: "2 projects failed",
    });
    const warnPos = content.indexOf("⚠");
    const metricPos = content.indexOf("repos");
    expect(warnPos).toBeGreaterThanOrEqual(0);
    expect(warnPos).toBeLessThan(metricPos);
    expect(content).toContain("2 projects failed");
  });

  it("empty analyses: metric shows 0 repos and 0 PR, signal table shows placeholder", () => {
    const content = buildSummaryContent([]);
    expect(content).toContain("0 repos");
    expect(content).toContain("0 PR");
    expect(content).not.toContain("🔴 ×");
    expect(content).not.toContain("🟡 ×");
    expect(content).not.toContain("⚪ ×");
    expect(content).toContain("_No projects to display._");
  });

  it("⚠ budget line appears after metric line and before signal table", () => {
    const warnBudget = "⚠ Budget exceeded: $95.00 / $80.00 (119%)";
    const content = buildSummaryContent(mixedAnalyses, { budgetLine: warnBudget });
    const metricPos = content.indexOf("repos");
    const budgetPos = content.indexOf("Budget exceeded");
    const signalPos = content.indexOf("reth");
    expect(metricPos).toBeLessThan(budgetPos);
    expect(budgetPos).toBeLessThan(signalPos);
  });

  it("non-⚠ budget line does not appear in summary content", () => {
    const normalBudget = "Budget: $5.00 / $80.00 (6%)";
    const content = buildSummaryContent(mixedAnalyses, { budgetLine: normalBudget });
    expect(content).not.toContain(normalBudget);
  });

  it("mobile readability: 10-repo sample with long names and Chinese signals — no table syntax, no fake pills, no column alignment", () => {
    const mobileAnalyses: GroupedAnalyses = [
      {
        projectId: "ethereum-optimism/op-geth",
        prCount: 2,
        directionalShiftCount: 1,
        notableCount: 0,
        topDirectionSignal: null,
        prs: [
          {
            prNumber: 1,
            title: "New consensus API",
            htmlUrl: "https://github.com/ethereum-optimism/op-geth/pull/1",
            summary: "新 consensus API 接口引入",
            technicalDetail: null,
            significance: "directional_shift",
            directionSignal: "新 consensus API 接口引入，需要下游适配",
          },
          {
            prNumber: 2,
            title: "Routine bump",
            htmlUrl: "https://github.com/ethereum-optimism/op-geth/pull/2",
            summary: "Routine dependency bump",
            technicalDetail: null,
            significance: "routine",
            directionSignal: null,
          },
        ],
      },
      ...Array.from({ length: 9 }, (_, i) => ({
        projectId: `ethereum-optimism/long-repo-name-${i + 1}`,
        prCount: 3,
        directionalShiftCount: 0,
        notableCount: 0,
        topDirectionSignal: null,
        prs: Array.from({ length: 3 }, (__, j) => ({
          prNumber: 100 + i * 3 + j,
          title: `Routine PR ${i + 1}-${j + 1}`,
          htmlUrl: `https://github.com/org/repo/pull/${100 + i * 3 + j}`,
          summary: `例行维护 PR ${i + 1}，更新依赖项版本`,
          technicalDetail: null,
          significance: "routine" as const,
          directionSignal: null,
        })),
      })),
    ];

    const content = buildSummaryContent(mobileAnalyses);

    // No markdown table syntax (pipes)
    expect(content).not.toContain("|");
    // No fake pill buttons (backtick-wrapped emoji)
    expect(content).not.toContain("`🔴`");
    expect(content).not.toContain("`🟡`");
    expect(content).not.toContain("`⚪`");
    // No 3+ consecutive spaces for column alignment
    expect(content).not.toMatch(/   /);
    // All 10 projects appear
    expect(content).toContain("ethereum-optimism/op-geth");
    for (let i = 1; i <= 9; i++) {
      expect(content).toContain(`ethereum-optimism/long-repo-name-${i}`);
    }
    // Chinese signal appears naturally
    expect(content).toContain("新 consensus API 接口引入");
  });
});

describe("buildDailyCard budget line dedup", () => {
  it("⚠ budget line appears in summary only, not at card bottom", () => {
    const warnBudget = "⚠ Budget exceeded: $95.00 / $80.00 (119%)";
    const card = buildDailyCard("2026-06-05", sampleAnalyses, undefined, warnBudget);
    const firstMarkdown = card.elements.find((e) => e.tag === "markdown") as {
      tag: "markdown";
      content: string;
    };
    expect(firstMarkdown.content).toContain("Budget exceeded");
    // Budget must appear exactly once across the whole card
    const cardJson = JSON.stringify(card);
    const occurrences = (cardJson.match(/Budget exceeded/g) || []).length;
    expect(occurrences).toBe(1);
  });

  it("non-⚠ budget line appears at card bottom only, not in summary", () => {
    const normalBudget = "Budget: $5.00 / $80.00 (6%)";
    const card = buildDailyCard("2026-06-05", sampleAnalyses, undefined, normalBudget);
    const firstMarkdown = card.elements.find((e) => e.tag === "markdown") as {
      tag: "markdown";
      content: string;
    };
    expect(firstMarkdown.content).not.toContain(normalBudget);
    const lastElement = card.elements[card.elements.length - 1] as { tag: string; content: string };
    expect(lastElement.tag).toBe("markdown");
    expect(lastElement.content).toBe(normalBudget);
  });
});

describe("buildDailyCard summary element order", () => {
  it("partial warning appears before metric line", () => {
    const card = buildDailyCard("2026-06-05", sampleAnalyses, "2 projects failed");
    const firstMarkdown = card.elements.find((e) => e.tag === "markdown") as {
      tag: "markdown";
      content: string;
    };
    const warnPos = firstMarkdown.content.indexOf("⚠");
    const metricPos = firstMarkdown.content.indexOf("repos");
    expect(warnPos).toBeLessThan(metricPos);
  });

  it("⚠ budget warning appears after metric line and before signal table", () => {
    const warnBudget = "⚠ Budget critical";
    const card = buildDailyCard("2026-06-05", sampleAnalyses, undefined, warnBudget);
    const firstMarkdown = card.elements.find((e) => e.tag === "markdown") as {
      tag: "markdown";
      content: string;
    };
    const content = firstMarkdown.content;
    const metricPos = content.indexOf("repos");
    const budgetPos = content.indexOf("Budget critical");
    // Signal table contains the project name
    const signalPos = content.indexOf("org/repo-a");
    expect(metricPos).toBeLessThan(budgetPos);
    expect(budgetPos).toBeLessThan(signalPos);
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

describe("resolveHeaderTemplate", () => {
  it("returns 'blue' for all routine analyses", () => {
    expect(resolveHeaderTemplate(routineOnlyAnalyses)).toBe("blue");
  });

  it("returns 'blue' for empty analyses", () => {
    expect(resolveHeaderTemplate([])).toBe("blue");
  });

  it("returns 'yellow' when only notable PRs are present (no directional_shift)", () => {
    const notableAnalyses: GroupedAnalyses = [
      {
        projectId: "org/repo-n",
        prCount: 1,
        directionalShiftCount: 0,
        notableCount: 1,
        topDirectionSignal: null,
        prs: [
          {
            prNumber: 600,
            title: "Notable change",
            htmlUrl: "https://github.com/org/repo-n/pull/600",
            summary: "A notable improvement",
            technicalDetail: null,
            significance: "notable",
            directionSignal: null,
          },
        ],
      },
    ];
    expect(resolveHeaderTemplate(notableAnalyses)).toBe("yellow");
  });

  it("returns 'orange' when any PR has directional_shift", () => {
    expect(resolveHeaderTemplate(sampleAnalyses)).toBe("orange");
  });

  it("returns 'orange' even if there are also notable and routine PRs", () => {
    const mixed: GroupedAnalyses = [
      {
        projectId: "org/repo-m",
        prCount: 3,
        directionalShiftCount: 1,
        notableCount: 1,
        topDirectionSignal: "major shift",
        prs: [
          {
            prNumber: 700,
            title: "Routine fix",
            htmlUrl: "https://github.com/org/repo-m/pull/700",
            summary: "Routine",
            technicalDetail: null,
            significance: "routine",
            directionSignal: null,
          },
          {
            prNumber: 701,
            title: "Notable feature",
            htmlUrl: "https://github.com/org/repo-m/pull/701",
            summary: "Notable",
            technicalDetail: null,
            significance: "notable",
            directionSignal: null,
          },
          {
            prNumber: 702,
            title: "Breaking change",
            htmlUrl: "https://github.com/org/repo-m/pull/702",
            summary: "Directional",
            technicalDetail: null,
            significance: "directional_shift",
            directionSignal: "major shift",
          },
        ],
      },
    ];
    expect(resolveHeaderTemplate(mixed)).toBe("orange");
  });
});

describe("buildDailyCard header.template", () => {
  it("uses 'blue' header for routine-only analyses", () => {
    const card = buildDailyCard("2026-06-05", routineOnlyAnalyses);
    expect(card.header.template).toBe("blue");
  });

  it("uses 'orange' header when directional_shift PRs are present", () => {
    const card = buildDailyCard("2026-06-05", sampleAnalyses);
    expect(card.header.template).toBe("orange");
  });

  it("uses 'yellow' header when only notable PRs are present", () => {
    const notableAnalyses: GroupedAnalyses = [
      {
        projectId: "org/repo-n2",
        prCount: 1,
        directionalShiftCount: 0,
        notableCount: 1,
        topDirectionSignal: null,
        prs: [
          {
            prNumber: 800,
            title: "Notable",
            htmlUrl: "https://github.com/org/repo-n2/pull/800",
            summary: "Notable change",
            technicalDetail: null,
            significance: "notable",
            directionSignal: null,
          },
        ],
      },
    ];
    const card = buildDailyCard("2026-06-05", notableAnalyses);
    expect(card.header.template).toBe("yellow");
  });

  it("uses 'blue' header for empty analyses", () => {
    const card = buildDailyCard("2026-06-05", []);
    expect(card.header.template).toBe("blue");
  });
});

describe("truncateAtSentenceBoundary", () => {
  it("under cap passthrough: text < 500 bytes returned unchanged", () => {
    const short = "hello world";
    expect(truncateAtSentenceBoundary(short, 500)).toBe(short);
  });

  it("exact cap: text == 500 bytes returned unchanged", () => {
    const exact = "A".repeat(500);
    expect(truncateAtSentenceBoundary(exact, 500)).toBe(exact);
  });

  it("chinese-heavy: full Chinese text (3 bytes/char) truncated at ~166 chars", () => {
    // 200 Chinese chars = 600 bytes — exceeds 500-byte cap
    const chinese = "测".repeat(200);
    const result = truncateAtSentenceBoundary(chinese, 500);
    // charLimit = 166 (166 * 3 = 498 <= 500, 167 * 3 = 501 > 500); no boundary → hard cut
    expect(result).toBe("测".repeat(166) + "…");
  });

  it("english-heavy: full English text truncated at ~500 chars", () => {
    // 600 ASCII chars = 600 bytes — exceeds 500-byte cap; no boundary → hard cut
    const english = "x".repeat(600);
    const result = truncateAtSentenceBoundary(english, 500);
    expect(result).toBe("x".repeat(500) + "…");
  });

  it("mixed: Chinese/English mixed, byte calculation is byte-aware not char-aware", () => {
    // 100 Chinese (300 bytes) + 250 English (250 bytes) = 550 bytes total
    const mixed = "中".repeat(100) + "a".repeat(250);
    // 500 bytes = 100 Chinese (300) + 200 English (200)
    const result = truncateAtSentenceBoundary(mixed, 500);
    // charLimit: 100 Chinese (300 bytes) + 200 ASCII (200 bytes) = 500 bytes → charLimit = 300
    // no boundary → hard cut at 300 chars
    expect(result).toBe("中".repeat(100) + "a".repeat(200) + "…");
  });

  it("sentence boundary found: 。 within cap → truncate at boundary", () => {
    // 100 Chinese + 。+ 80 Chinese = 181 chars = 543 bytes; charLimit = 166; 。at index 100
    const text = "你".repeat(100) + "。" + "好".repeat(80);
    const result = truncateAtSentenceBoundary(text, 500);
    // boundary at index 101 (after 。); 101 > 166 * 0.4 = 66.4 → truncate at boundary
    expect(result).toBe("你".repeat(100) + "。");
  });

  it("sentence boundary found: '. ' within cap → truncate at boundary (trailing space trimmed)", () => {
    // 250 + '. ' + 300 = 552 bytes total; charLimit = 500
    // Boundary at 252; 252 > 500 * 0.4 = 200 → truncate; trailing space trimmed
    const text2 = "a".repeat(250) + ". " + "b".repeat(300);
    const result2 = truncateAtSentenceBoundary(text2, 500);
    expect(result2).toBe("a".repeat(250) + ".");
  });

  it("no boundary found (< 40%): boundary too early → hard cut + …", () => {
    // Put 。 at position 10, charLimit = 166 Chinese chars, threshold = 66
    // 10 + 1 = 11 < 66.4 → hard cut
    const text = "你".repeat(10) + "。" + "好".repeat(190); // 201 chars = 603 bytes
    const result = truncateAtSentenceBoundary(text, 500);
    // charLimit = 166; boundary at pos 11; 11 <= 66.4 → hard cut
    expect(result).toBe("你".repeat(10) + "。" + "好".repeat(155) + "…");
  });

  it("no boundary at all → hard cut + …", () => {
    const text = "a".repeat(600);
    const result = truncateAtSentenceBoundary(text, 500);
    expect(result).toBe("a".repeat(500) + "…");
  });

  it("multiple boundaries: last one is taken", () => {
    // Three 。 at positions 70, 100, 140 (all > 40% of charLimit=166 → last wins)
    const text =
      "你".repeat(70) + "。" + "好".repeat(30) + "。" + "啊".repeat(40) + "。" + "吧".repeat(30);
    // 172 chars = 516 bytes; charLimit = 166
    // boundaries at 71, 102, 143; all > 66.4; last is 143
    const result = truncateAtSentenceBoundary(text, 500);
    expect(result).toBe("你".repeat(70) + "。" + "好".repeat(30) + "。" + "啊".repeat(40) + "。");
  });

  it("中文句号 recognized as boundary", () => {
    const text = "一二三四五六七八九十".repeat(15) + "。" + "a".repeat(200);
    // 150 Chinese + 。 + 200 ASCII = 651 bytes; charLimit ≈ 166 (498 bytes)
    // 。at pos 150; 151 > 66.4 → use boundary
    const result = truncateAtSentenceBoundary(text, 500);
    expect(result).toBe("一二三四五六七八九十".repeat(15) + "。");
  });

  it("英文句号 ('. ') recognized as boundary (trailing space trimmed)", () => {
    const text = "a".repeat(300) + ". " + "b".repeat(300);
    // charLimit = 500; boundary at 302; 302 > 200 → use boundary; trailing space trimmed
    const result = truncateAtSentenceBoundary(text, 500);
    expect(result).toBe("a".repeat(300) + ".");
  });

  it("exclamation mark ！ recognized as boundary", () => {
    const text = "你".repeat(100) + "！" + "好".repeat(80);
    // charLimit = 166; boundary at 101 > 66.4 → truncate
    const result = truncateAtSentenceBoundary(text, 500);
    expect(result).toBe("你".repeat(100) + "！");
  });

  it("exclamation mark '! ' recognized as boundary (trailing space trimmed)", () => {
    const text = "a".repeat(300) + "! " + "b".repeat(300);
    const result = truncateAtSentenceBoundary(text, 500);
    expect(result).toBe("a".repeat(300) + "!");
  });

  it("question mark ？ recognized as boundary", () => {
    const text = "你".repeat(100) + "？" + "好".repeat(80);
    const result = truncateAtSentenceBoundary(text, 500);
    expect(result).toBe("你".repeat(100) + "？");
  });

  it("question mark '? ' recognized as boundary (trailing space trimmed)", () => {
    const text = "a".repeat(300) + "? " + "b".repeat(300);
    const result = truncateAtSentenceBoundary(text, 500);
    expect(result).toBe("a".repeat(300) + "?");
  });

  it("trailing whitespace removed: '. ' boundary trims the trailing space", () => {
    // Place '. ' at a valid boundary position; the trailing space must be trimmed
    const text = "a".repeat(300) + ". " + "b".repeat(300);
    const result = truncateAtSentenceBoundary(text, 500);
    expect(result).not.toMatch(/\s$/);
    expect(result).toMatch(/\.$/);
  });

  it("hard-cut result has no trailing whitespace", () => {
    // Spaces before the cut point should not appear after trim()
    const text = "a".repeat(495) + "     " + "b".repeat(100);
    const result = truncateAtSentenceBoundary(text, 500);
    expect(result).not.toMatch(/\s+…$/);
    expect(result).toMatch(/…$/);
  });

  it("astral character (🙂) fits exactly within cap → included in full, no truncation", () => {
    // 🙂 is U+1F642: 4 UTF-8 bytes, 2 UTF-16 code units; 496 + 4 = 500 exactly
    const text = "a".repeat(496) + "🙂";
    expect(truncateAtSentenceBoundary(text, 500)).toBe(text);
  });

  it("astral character would push byte count over cap → excluded entirely, no unpaired surrogates", () => {
    // 🙂 starts at byte offset 498; 498 + 4 = 502 > 500 → excluded; hard cut
    const text = "a".repeat(498) + "🙂" + "b";
    const result = truncateAtSentenceBoundary(text, 500);
    expect(result).toBe("a".repeat(498) + "…");
    const hasUnpairedSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(result);
    expect(hasUnpairedSurrogate).toBe(false);
  });

  it("repro: a.repeat(498) + 🙂 + b with cap 500 → clean output, no surrogate in truncated result", () => {
    const text = "a".repeat(498) + "🙂" + "b";
    const result = truncateAtSentenceBoundary(text, 500);
    const hasUnpairedSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(result);
    expect(hasUnpairedSurrogate).toBe(false);
    expect(result).toMatch(/…$/);
    expect(result).not.toContain("🙂");
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

describe("buildRepoPanels", () => {
  it("returns fallback markdown for all-routine analyses", () => {
    const panels = buildRepoPanels(routineOnlyAnalyses);
    expect(panels).toHaveLength(1);
    expect(panels[0]!.tag).toBe("markdown");
    expect((panels[0] as LarkMarkdownElement).content).toBe("_All PRs are routine today._");
  });

  it("returns fallback markdown for empty analyses", () => {
    const panels = buildRepoPanels([]);
    expect(panels).toHaveLength(1);
    expect((panels[0] as LarkMarkdownElement).content).toBe("_All PRs are routine today._");
  });

  it("generates one panel per significant project, skipping routine-only", () => {
    const panels = buildRepoPanels(sampleAnalyses);
    // org/repo-a has directional → 1 panel; org/repo-b is routine-only → no panel
    expect(panels).toHaveLength(1);
    expect(panels[0]!.tag).toBe("collapsible_panel");
  });

  it("directional panel has 🔴 emoji in header", () => {
    const panels = buildRepoPanels(sampleAnalyses);
    const panel = panels[0] as LarkCollapsiblePanel;
    expect(panel.header.title.content).toContain("🔴");
    expect(panel.header.title.content).toContain("org/repo-a");
    expect(panel.header.title.content).toContain("2 PR");
  });

  it("directional panel is expanded: true", () => {
    const panels = buildRepoPanels(sampleAnalyses);
    const panel = panels[0] as LarkCollapsiblePanel;
    expect(panel.expanded).toBe(true);
  });

  it("notable-only panel has 🟡 emoji in header", () => {
    const notableAnalyses: GroupedAnalyses = [
      {
        projectId: "org/notable-repo",
        prCount: 1,
        directionalShiftCount: 0,
        notableCount: 1,
        topDirectionSignal: null,
        prs: [
          {
            prNumber: 10,
            title: "Notable feature",
            htmlUrl: "https://github.com/org/notable-repo/pull/10",
            summary: "A notable improvement",
            technicalDetail: null,
            significance: "notable",
            directionSignal: null,
          },
        ],
      },
    ];
    const panels = buildRepoPanels(notableAnalyses);
    const panel = panels[0] as LarkCollapsiblePanel;
    expect(panel.header.title.content).toContain("🟡");
    expect(panel.header.title.content).toContain("org/notable-repo");
  });

  it("notable panel expanded: false when directional panels exist", () => {
    const mixed: GroupedAnalyses = [
      {
        projectId: "org/directional",
        prCount: 1,
        directionalShiftCount: 1,
        notableCount: 0,
        topDirectionSignal: null,
        prs: [
          {
            prNumber: 1,
            title: "Directional PR",
            htmlUrl: "https://github.com/org/directional/pull/1",
            summary: "Directional change",
            technicalDetail: null,
            significance: "directional_shift",
            directionSignal: "big shift",
          },
        ],
      },
      {
        projectId: "org/notable",
        prCount: 1,
        directionalShiftCount: 0,
        notableCount: 1,
        topDirectionSignal: null,
        prs: [
          {
            prNumber: 2,
            title: "Notable PR",
            htmlUrl: "https://github.com/org/notable/pull/2",
            summary: "Notable change",
            technicalDetail: null,
            significance: "notable",
            directionSignal: null,
          },
        ],
      },
    ];
    const panels = buildRepoPanels(mixed);
    expect(panels).toHaveLength(2);
    const directionalPanel = panels.find(
      (p) => p.tag === "collapsible_panel" && (p as LarkCollapsiblePanel).header.title.content.includes("org/directional")
    ) as LarkCollapsiblePanel;
    const notablePanel = panels.find(
      (p) => p.tag === "collapsible_panel" && (p as LarkCollapsiblePanel).header.title.content.includes("org/notable")
    ) as LarkCollapsiblePanel;
    expect(directionalPanel.expanded).toBe(true);
    expect(notablePanel.expanded).toBe(false);
  });

  it("notable panel expanded: true (top 2) when no directional panels exist — single notable", () => {
    const notableOnly: GroupedAnalyses = [
      {
        projectId: "org/notable-a",
        prCount: 1,
        directionalShiftCount: 0,
        notableCount: 1,
        topDirectionSignal: null,
        prs: [
          {
            prNumber: 1,
            title: "Notable A",
            htmlUrl: "https://github.com/org/notable-a/pull/1",
            summary: "Notable",
            technicalDetail: null,
            significance: "notable",
            directionSignal: null,
          },
        ],
      },
    ];
    const panels = buildRepoPanels(notableOnly);
    expect(panels).toHaveLength(1);
    expect((panels[0] as LarkCollapsiblePanel).expanded).toBe(true);
  });

  it("expand rule determinism: no directional panels — sorts by notableCount desc then expands top min(2, n)", () => {
    // 3 notable-only repos: repo-b has most notable PRs → should be expanded first
    const notableOnly: GroupedAnalyses = [
      {
        projectId: "org/repo-a",
        prCount: 2,
        directionalShiftCount: 0,
        notableCount: 1,
        topDirectionSignal: null,
        prs: [
          {
            prNumber: 1,
            title: "Notable A",
            htmlUrl: "https://github.com/org/repo-a/pull/1",
            summary: "Notable",
            technicalDetail: null,
            significance: "notable",
            directionSignal: null,
          },
          {
            prNumber: 2,
            title: "Routine A",
            htmlUrl: "https://github.com/org/repo-a/pull/2",
            summary: "Routine",
            technicalDetail: null,
            significance: "routine",
            directionSignal: null,
          },
        ],
      },
      {
        projectId: "org/repo-b",
        prCount: 3,
        directionalShiftCount: 0,
        notableCount: 3,
        topDirectionSignal: null,
        prs: [
          {
            prNumber: 10,
            title: "Notable B1",
            htmlUrl: "https://github.com/org/repo-b/pull/10",
            summary: "Notable",
            technicalDetail: null,
            significance: "notable",
            directionSignal: null,
          },
          {
            prNumber: 11,
            title: "Notable B2",
            htmlUrl: "https://github.com/org/repo-b/pull/11",
            summary: "Notable",
            technicalDetail: null,
            significance: "notable",
            directionSignal: null,
          },
          {
            prNumber: 12,
            title: "Notable B3",
            htmlUrl: "https://github.com/org/repo-b/pull/12",
            summary: "Notable",
            technicalDetail: null,
            significance: "notable",
            directionSignal: null,
          },
        ],
      },
      {
        projectId: "org/repo-c",
        prCount: 2,
        directionalShiftCount: 0,
        notableCount: 2,
        topDirectionSignal: null,
        prs: [
          {
            prNumber: 20,
            title: "Notable C1",
            htmlUrl: "https://github.com/org/repo-c/pull/20",
            summary: "Notable",
            technicalDetail: null,
            significance: "notable",
            directionSignal: null,
          },
          {
            prNumber: 21,
            title: "Notable C2",
            htmlUrl: "https://github.com/org/repo-c/pull/21",
            summary: "Notable",
            technicalDetail: null,
            significance: "notable",
            directionSignal: null,
          },
        ],
      },
    ];
    const panels = buildRepoPanels(notableOnly);
    expect(panels).toHaveLength(3);
    const panelA = panels.find(
      (p) => p.tag === "collapsible_panel" && (p as LarkCollapsiblePanel).header.title.content.includes("org/repo-a")
    ) as LarkCollapsiblePanel;
    const panelB = panels.find(
      (p) => p.tag === "collapsible_panel" && (p as LarkCollapsiblePanel).header.title.content.includes("org/repo-b")
    ) as LarkCollapsiblePanel;
    const panelC = panels.find(
      (p) => p.tag === "collapsible_panel" && (p as LarkCollapsiblePanel).header.title.content.includes("org/repo-c")
    ) as LarkCollapsiblePanel;
    // repo-b (3 notable) and repo-c (2 notable) are the top 2 by notableCount
    expect(panelB.expanded).toBe(true);
    expect(panelC.expanded).toBe(true);
    // repo-a (1 notable) is outside top 2
    expect(panelA.expanded).toBe(false);
  });

  it("panel body: significant PRs shown with link, badge, summary; routine appended as hint", () => {
    const panels = buildRepoPanels(sampleAnalyses);
    const panel = panels[0] as LarkCollapsiblePanel;
    const body = panel.elements[0]!.content;
    expect(body).toContain("[#101 Add OAuth2 support](https://github.com/org/repo-a/pull/101)");
    expect(body).toContain("🔴 DIRECTIONAL");
    expect(body).toContain("Adds OAuth2 authentication flow");
    expect(body).toContain("Direction: migrating auth to OAuth2");
    expect(body).toContain("1 routine PR not expanded");
    expect(body).not.toContain("#102");
  });

  it("panel body: direction signal stripped of counterpart recommendations", () => {
    const analyses: GroupedAnalyses = [
      {
        projectId: "org/reth",
        prCount: 1,
        directionalShiftCount: 1,
        notableCount: 0,
        topDirectionSignal: null,
        prs: [
          {
            prNumber: 1,
            title: "Migration",
            htmlUrl: "https://github.com/org/reth/pull/1",
            summary: "Executor migrated",
            technicalDetail: null,
            significance: "directional_shift",
            directionSignal: "switching to async; Mantle should update its adapter",
          },
        ],
      },
    ];
    const panels = buildRepoPanels(analyses);
    const body = (panels[0] as LarkCollapsiblePanel).elements[0]!.content;
    expect(body).not.toContain("Mantle should");
    expect(body).toContain("switching to async");
  });

  it("mobile readability: long repo name and Chinese signal in panel header and body do not use table syntax", () => {
    const analyses: GroupedAnalyses = [
      {
        projectId: "ethereum-optimism/op-geth",
        prCount: 2,
        directionalShiftCount: 1,
        notableCount: 0,
        topDirectionSignal: null,
        prs: [
          {
            prNumber: 1,
            title: "New consensus API",
            htmlUrl: "https://github.com/ethereum-optimism/op-geth/pull/1",
            summary: "新 consensus API 接口引入",
            technicalDetail: null,
            significance: "directional_shift",
            directionSignal: "新 consensus API 接口引入，需要下游适配",
          },
          {
            prNumber: 2,
            title: "Routine bump",
            htmlUrl: "https://github.com/ethereum-optimism/op-geth/pull/2",
            summary: "Routine dependency bump",
            technicalDetail: null,
            significance: "routine",
            directionSignal: null,
          },
        ],
      },
    ];
    const panels = buildRepoPanels(analyses);
    const panel = panels[0] as LarkCollapsiblePanel;
    expect(panel.header.title.content).toContain("ethereum-optimism/op-geth");
    const body = panel.elements[0]!.content;
    expect(body).toContain("新 consensus API 接口引入");
    // No pipe characters (no table syntax)
    expect(body).not.toContain("|");
    expect(panel.header.title.content).not.toContain("|");
  });

  it("formatter.ts Level 3 single-project mode: notable project gets one panel", () => {
    const singleNotable: GroupedAnalyses = [
      {
        projectId: "org/single",
        prCount: 1,
        directionalShiftCount: 0,
        notableCount: 1,
        topDirectionSignal: null,
        prs: [
          {
            prNumber: 1,
            title: "Notable",
            htmlUrl: "https://github.com/org/single/pull/1",
            summary: "Notable change",
            technicalDetail: null,
            significance: "notable",
            directionSignal: null,
          },
        ],
      },
    ];
    const card = buildDailyCard("2026-06-05", singleNotable);
    const panels = card.elements.filter((e) => e.tag === "collapsible_panel") as LarkCollapsiblePanel[];
    expect(panels).toHaveLength(1);
    expect(panels[0]!.header.title.content).toContain("🟡");
    expect(panels[0]!.header.title.content).toContain("org/single");
  });

  it("formatter.ts Level 3 single-project mode: routine-only project gets fallback markdown, no panel", () => {
    const singleRoutine: GroupedAnalyses = [
      {
        projectId: "org/routine-only",
        prCount: 1,
        directionalShiftCount: 0,
        notableCount: 0,
        topDirectionSignal: null,
        prs: [
          {
            prNumber: 1,
            title: "Routine",
            htmlUrl: "https://github.com/org/routine-only/pull/1",
            summary: "Routine change",
            technicalDetail: null,
            significance: "routine",
            directionSignal: null,
          },
        ],
      },
    ];
    const card = buildDailyCard("2026-06-05", singleRoutine);
    const panels = card.elements.filter((e) => e.tag === "collapsible_panel");
    expect(panels).toHaveLength(0);
    const fallback = card.elements.find(
      (e): e is LarkMarkdownElement =>
        e.tag === "markdown" && (e as LarkMarkdownElement).content.includes("All PRs are routine today")
    );
    expect(fallback).toBeDefined();
  });
});
