import { describe, it, expect } from "bun:test";
import { buildDailyCard } from "./daily-card";
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

  it("technical details are inside a collapsible_panel", () => {
    const card = buildDailyCard("2026-06-05", sampleAnalyses);
    const panel = card.elements.find((e) => e.tag === "collapsible_panel") as {
      tag: "collapsible_panel";
      expanded: boolean;
      header: { title: { tag: string; content: string } };
      elements: Array<{ tag: string; content: string }>;
    };
    expect(panel).toBeDefined();
    expect(panel.expanded).toBe(false);
    expect(panel.header.title.content).toContain("Technical Details");
    expect(panel.elements[0].content).toContain("org/repo-a");
    expect(panel.elements[0].content).toContain("#101");
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
});
