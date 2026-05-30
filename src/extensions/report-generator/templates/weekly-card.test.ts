import { describe, it, expect } from "bun:test";
import { buildWeeklyCard } from "./weekly-card";
import type { WeeklyReportData } from "../weekly";

const sampleData: WeeklyReportData = {
  directionChanges: [
    { projectId: "org/repo-a", prCount: 2, signals: ["migrating auth to OAuth2", "switching to Postgres"] },
    { projectId: "org/repo-c", prCount: 1, signals: ["adding gRPC proto files"] },
  ],
  activitySummary: {
    totalPrs: 8,
    directionalShiftCount: 3,
    notableCount: 2,
    projectCount: 3,
  },
  projectHighlights: [
    {
      projectId: "org/repo-a",
      prCount: 4,
      notableCount: 1,
      directionalShiftCount: 2,
      highlights: [
        {
          prNumber: 101,
          title: "Add OAuth2 support",
          summary: "Adds OAuth2 authentication flow",
          significance: "directional_shift",
          directionSignal: "migrating auth to OAuth2",
        },
        {
          prNumber: 102,
          title: "Switch to Postgres",
          summary: "Migrates DB from SQLite to Postgres",
          significance: "directional_shift",
          directionSignal: "switching to Postgres",
        },
      ],
    },
    {
      projectId: "org/repo-b",
      prCount: 3,
      notableCount: 1,
      directionalShiftCount: 0,
      highlights: [
        {
          prNumber: 200,
          title: "Improve cache layer",
          summary: "Adds Redis caching for hot paths",
          significance: "notable",
          directionSignal: null,
        },
      ],
    },
  ],
  periodStartUnix: 1747008000, // ~2025-05-12
  periodEndUnix: 1747612800,   // ~2025-05-19
};

const emptyData: WeeklyReportData = {
  directionChanges: [],
  activitySummary: { totalPrs: 0, directionalShiftCount: 0, notableCount: 0, projectCount: 0 },
  projectHighlights: [],
  periodStartUnix: 1747008000,
  periodEndUnix: 1747612800,
};

describe("buildWeeklyCard", () => {
  it("has correct top-level structure: config, header, elements", () => {
    const card = buildWeeklyCard("May 12–19", sampleData);
    expect(card.config).toBeDefined();
    expect(card.header).toBeDefined();
    expect(card.elements).toBeDefined();
    expect(card.config.wide_screen_mode).toBe(true);
  });

  it("header uses purple template and contains dateRange", () => {
    const card = buildWeeklyCard("May 12–19", sampleData);
    expect(card.header.template).toBe("purple");
    expect(card.header.title.content).toContain("May 12–19");
    expect(card.header.title.content).toContain("Weekly Intelligence");
  });

  it("elements include Direction Changes markdown as first element", () => {
    const card = buildWeeklyCard("May 12–19", sampleData);
    const first = card.elements[0]!;
    expect(first.tag).toBe("markdown");
    const el = first as { tag: "markdown"; content: string };
    expect(el.content).toContain("Direction Changes This Week");
    expect(el.content).toContain("org/repo-a");
    expect(el.content).toContain("migrating auth to OAuth2");
  });

  it("direction changes section lists each project with PR count", () => {
    const card = buildWeeklyCard("May 12–19", sampleData);
    const dirEl = card.elements[0] as { tag: "markdown"; content: string };
    expect(dirEl.content).toContain("org/repo-c");
    expect(dirEl.content).toContain("1 PR");
    expect(dirEl.content).toContain("2 PRs");
  });

  it("shows 'No directional shifts' when directionChanges is empty", () => {
    const card = buildWeeklyCard("May 12–19", emptyData);
    const dirEl = card.elements[0] as { tag: "markdown"; content: string };
    expect(dirEl.content).toContain("No directional shifts");
  });

  it("elements include an hr after direction changes", () => {
    const card = buildWeeklyCard("May 12–19", sampleData);
    expect(card.elements[1]!.tag).toBe("hr");
  });

  it("elements include Activity Summary markdown", () => {
    const card = buildWeeklyCard("May 12–19", sampleData);
    const actEl = card.elements[2] as { tag: "markdown"; content: string };
    expect(actEl.tag).toBe("markdown");
    expect(actEl.content).toContain("Activity Summary");
    expect(actEl.content).toContain("8 PRs");
    expect(actEl.content).toContain("3 projects");
    expect(actEl.content).toContain("3 directional shifts");
    expect(actEl.content).toContain("2 notable changes");
  });

  it("elements include an hr before per-project highlights", () => {
    const card = buildWeeklyCard("May 12–19", sampleData);
    expect(card.elements[3]!.tag).toBe("hr");
  });

  it("per-project highlights are in a collapsed collapsible_panel", () => {
    const card = buildWeeklyCard("May 12–19", sampleData);
    const panel = card.elements[4] as {
      tag: "collapsible_panel";
      expanded: boolean;
      header: { title: { content: string } };
      elements: Array<{ tag: string; content: string }>;
    };
    expect(panel.tag).toBe("collapsible_panel");
    expect(panel.expanded).toBe(false);
    expect(panel.header.title.content).toContain("Per-project Highlights");
  });

  it("per-project highlights contain project IDs and PR numbers", () => {
    const card = buildWeeklyCard("May 12–19", sampleData);
    const panel = card.elements[4] as {
      tag: "collapsible_panel";
      elements: Array<{ tag: string; content: string }>;
    };
    const content = panel.elements[0]!.content;
    expect(content).toContain("org/repo-a");
    expect(content).toContain("#101");
    expect(content).toContain("org/repo-b");
  });

  it("directional shift PRs show DIRECTIONAL badge in highlights", () => {
    const card = buildWeeklyCard("May 12–19", sampleData);
    const panel = card.elements[4] as {
      tag: "collapsible_panel";
      elements: Array<{ tag: string; content: string }>;
    };
    expect(panel.elements[0]!.content).toContain("DIRECTIONAL");
  });

  it("notable PRs show NOTABLE badge in highlights", () => {
    const card = buildWeeklyCard("May 12–19", sampleData);
    const panel = card.elements[4] as {
      tag: "collapsible_panel";
      elements: Array<{ tag: string; content: string }>;
    };
    expect(panel.elements[0]!.content).toContain("NOTABLE");
  });

  it("card has exactly 5 elements: direction, hr, activity, hr, highlights", () => {
    const card = buildWeeklyCard("May 12–19", sampleData);
    expect(card.elements).toHaveLength(5);
  });

  it("serializes to valid JSON", () => {
    const card = buildWeeklyCard("May 12–19", sampleData);
    expect(() => JSON.stringify(card)).not.toThrow();
  });
});
