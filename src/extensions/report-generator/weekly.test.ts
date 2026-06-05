import { describe, it, expect, mock, spyOn, afterEach } from "bun:test";

// aggregateFromDigests and fillAbsentDays are exported for testability
const { aggregateFromDigests, fillAbsentDays } = await import("./weekly");
import type { WeeklyReportData } from "./weekly";
import type { DailyDigest } from "./daily";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDigestJson(
  periodStart: number,
  periodEnd: number,
  entries: Array<{
    prNumber: number;
    projectId: string;
    title: string;
    summary: string;
    significance: "routine" | "notable" | "directional_shift";
    directionSignal: string | null;
    htmlUrl: string;
  }>
): string {
  const projectMap = new Map<string, typeof entries>();
  for (const e of entries) {
    const list = projectMap.get(e.projectId) ?? [];
    list.push(e);
    projectMap.set(e.projectId, list);
  }

  const digest: DailyDigest = {
    periodStart,
    periodEnd,
    projects: Array.from(projectMap.entries()).map(([projectId, prs]) => ({
      projectId,
      prCount: prs.length,
      notableCount: prs.filter((p) => p.significance === "notable").length,
      directionalShiftCount: prs.filter((p) => p.significance === "directional_shift").length,
      topSignals: prs.filter((p) => p.directionSignal !== null).map((p) => p.directionSignal!),
      prs: prs.map((p) => ({
        prNumber: p.prNumber,
        title: p.title,
        summary: p.summary,
        significance: p.significance,
        directionSignal: p.directionSignal,
        htmlUrl: p.htmlUrl,
      })),
    })),
    activitySummary: {
      totalPrs: entries.length,
      directionalShiftCount: entries.filter((e) => e.significance === "directional_shift").length,
      notableCount: entries.filter((e) => e.significance === "notable").length,
    },
  };
  return JSON.stringify(digest);
}

const PERIOD_START = 1_748_736_000; // fixed Unix timestamps
const PERIOD_END = PERIOD_START + 7 * 86_400;
const DAY = 86_400;

function emptyFallback(start: number, end: number): WeeklyReportData {
  return {
    directionChanges: [],
    activitySummary: { totalPrs: 0, directionalShiftCount: 0, notableCount: 0, projectCount: 0 },
    projectHighlights: [],
    counterpartChecks: [],
    periodStartUnix: start,
    periodEndUnix: end,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("aggregateFromDigests", () => {
  afterEach(() => {
    mock.restore();
  });

  // --- empty-period path ---------------------------------------------------

  it("empty-period: calls fallback with full period when rows array is empty", () => {
    const fallback = mock(emptyFallback);
    const result = aggregateFromDigests([], PERIOD_START, PERIOD_END, fallback);

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledWith(PERIOD_START, PERIOD_END);
    expect(result.periodStartUnix).toBe(PERIOD_START);
    expect(result.periodEndUnix).toBe(PERIOD_END);
  });

  it("empty-period: does NOT emit the 'falling back' log", () => {
    const logs: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    aggregateFromDigests([], PERIOD_START, PERIOD_END, emptyFallback);
    spy.mockRestore();

    expect(logs.some((l) => l.includes("falling back to analyses query"))).toBe(false);
  });

  // --- all-digest path ------------------------------------------------------

  it("all-digest: does not call fallback", () => {
    const d1start = PERIOD_START;
    const d1end = PERIOD_START + DAY;
    const d2start = d1end;
    const d2end = d2start + DAY;

    const rows = [
      {
        digest_json: makeDigestJson(d1start, d1end, [
          { prNumber: 1, projectId: "org/repo-a", title: "PR 1", summary: "Sum 1", significance: "notable" as const, directionSignal: "perf boost", htmlUrl: "https://github.com/org/repo-a/pull/1" },
        ]),
        period_start: d1start,
        period_end: d1end,
      },
      {
        digest_json: makeDigestJson(d2start, d2end, [
          { prNumber: 2, projectId: "org/repo-a", title: "PR 2", summary: "Sum 2", significance: "routine" as const, directionSignal: null, htmlUrl: "https://github.com/org/repo-a/pull/2" },
        ]),
        period_start: d2start,
        period_end: d2end,
      },
    ];

    const fallback = mock(emptyFallback);
    const result = aggregateFromDigests(rows, PERIOD_START, PERIOD_END, fallback);

    expect(fallback).not.toHaveBeenCalled();
    expect(result.activitySummary.totalPrs).toBe(2);
  });

  it("all-digest: correctly aggregates pr counts across days for same project", () => {
    const d1start = PERIOD_START;
    const d1end = d1start + DAY;
    const d2start = d1end;
    const d2end = d2start + DAY;

    const rows = [
      {
        digest_json: makeDigestJson(d1start, d1end, [
          { prNumber: 1, projectId: "org/repo-a", title: "PR 1", summary: "Sum 1", significance: "notable" as const, directionSignal: "shift-a", htmlUrl: "https://g.com/1" },
          { prNumber: 2, projectId: "org/repo-b", title: "PR 2", summary: "Sum 2", significance: "routine" as const, directionSignal: null, htmlUrl: "https://g.com/2" },
        ]),
        period_start: d1start,
        period_end: d1end,
      },
      {
        digest_json: makeDigestJson(d2start, d2end, [
          { prNumber: 3, projectId: "org/repo-a", title: "PR 3", summary: "Sum 3", significance: "directional_shift" as const, directionSignal: "shift-b", htmlUrl: "https://g.com/3" },
        ]),
        period_start: d2start,
        period_end: d2end,
      },
    ];

    const result = aggregateFromDigests(rows, PERIOD_START, PERIOD_END, emptyFallback);

    const repoA = result.projectHighlights.find((p) => p.projectId === "org/repo-a")!;
    const repoB = result.projectHighlights.find((p) => p.projectId === "org/repo-b")!;

    expect(repoA).toBeDefined();
    expect(repoA.prCount).toBe(2);
    expect(repoA.notableCount).toBe(1);
    expect(repoA.directionalShiftCount).toBe(1);

    expect(repoB).toBeDefined();
    expect(repoB.prCount).toBe(1);

    expect(result.activitySummary.totalPrs).toBe(3);
    expect(result.activitySummary.notableCount).toBe(1);
    expect(result.activitySummary.directionalShiftCount).toBe(1);
    expect(result.activitySummary.projectCount).toBe(2);
  });

  it("all-digest: reconstructs highlights fields from DigestPrSummary", () => {
    const d1start = PERIOD_START;
    const d1end = d1start + DAY;

    const rows = [
      {
        digest_json: makeDigestJson(d1start, d1end, [
          {
            prNumber: 42,
            projectId: "org/repo-x",
            title: "Big Change",
            summary: "A major refactor",
            significance: "directional_shift" as const,
            directionSignal: "moving to microservices",
            htmlUrl: "https://github.com/org/repo-x/pull/42",
          },
        ]),
        period_start: d1start,
        period_end: d1end,
      },
    ];

    const result = aggregateFromDigests(rows, PERIOD_START, PERIOD_END, emptyFallback);
    const proj = result.projectHighlights[0]!;
    const h = proj.highlights[0]!;

    expect(h.prNumber).toBe(42);
    expect(h.title).toBe("Big Change");
    expect(h.summary).toBe("A major refactor");
    expect(h.significance).toBe("directional_shift");
    expect(h.directionSignal).toBe("moving to microservices");
    expect(h.htmlUrl).toBe("https://github.com/org/repo-x/pull/42");
  });

  it("all-digest: populates directionChanges for projects with directional shifts", () => {
    const d1start = PERIOD_START;
    const d1end = d1start + DAY;

    const rows = [
      {
        digest_json: makeDigestJson(d1start, d1end, [
          { prNumber: 1, projectId: "org/repo-a", title: "T1", summary: "S1", significance: "directional_shift" as const, directionSignal: "to k8s", htmlUrl: "https://g.com/1" },
        ]),
        period_start: d1start,
        period_end: d1end,
      },
    ];

    const result = aggregateFromDigests(rows, PERIOD_START, PERIOD_END, emptyFallback);

    expect(result.directionChanges).toHaveLength(1);
    expect(result.directionChanges[0]!.projectId).toBe("org/repo-a");
    expect(result.directionChanges[0]!.signals).toContain("to k8s");
  });

  it("all-digest: sets correct periodStartUnix / periodEndUnix", () => {
    const d1start = PERIOD_START;
    const d1end = d1start + DAY;

    const rows = [
      {
        digest_json: makeDigestJson(d1start, d1end, [
          { prNumber: 1, projectId: "org/repo-a", title: "T", summary: "S", significance: "routine" as const, directionSignal: null, htmlUrl: "https://g.com/1" },
        ]),
        period_start: d1start,
        period_end: d1end,
      },
    ];

    const result = aggregateFromDigests(rows, PERIOD_START, PERIOD_END, emptyFallback);
    expect(result.periodStartUnix).toBe(PERIOD_START);
    expect(result.periodEndUnix).toBe(PERIOD_END);
  });

  // --- all-fallback path ----------------------------------------------------

  it("all-fallback: calls fallback with full period when all rows have null digest_json", () => {
    const rows = [
      { digest_json: null, period_start: PERIOD_START, period_end: PERIOD_START + DAY },
      { digest_json: null, period_start: PERIOD_START + DAY, period_end: PERIOD_START + 2 * DAY },
    ];

    const fallback = mock(emptyFallback);
    aggregateFromDigests(rows, PERIOD_START, PERIOD_END, fallback);

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledWith(PERIOD_START, PERIOD_END);
  });

  it("all-fallback: emits the expected log message with null/total counts", () => {
    const rows = [
      { digest_json: null, period_start: PERIOD_START, period_end: PERIOD_START + DAY },
      { digest_json: null, period_start: PERIOD_START + DAY, period_end: PERIOD_START + 2 * DAY },
    ];

    const logs: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    aggregateFromDigests(rows, PERIOD_START, PERIOD_END, emptyFallback);
    spy.mockRestore();

    expect(logs.some((l) => l.includes("[Report] Weekly:") && l.includes("2/2") && l.includes("falling back to analyses query"))).toBe(true);
  });

  it("all-fallback: returns the fallback result unchanged", () => {
    const rows = [{ digest_json: null, period_start: PERIOD_START, period_end: PERIOD_START + DAY }];

    const expected: WeeklyReportData = {
      directionChanges: [{ projectId: "org/repo-z", prCount: 1, signals: ["signal"] }],
      activitySummary: { totalPrs: 5, directionalShiftCount: 1, notableCount: 2, projectCount: 1 },
      projectHighlights: [{ projectId: "org/repo-z", prCount: 5, notableCount: 2, directionalShiftCount: 1, highlights: [] }],
      counterpartChecks: [],
      periodStartUnix: PERIOD_START,
      periodEndUnix: PERIOD_END,
    };

    const result = aggregateFromDigests(rows, PERIOD_START, PERIOD_END, () => expected);
    expect(result).toEqual(expected);
  });

  // --- partial-digest path --------------------------------------------------

  it("partial-digest: calls fallback only for null-digest rows, with their day bounds", () => {
    const d1start = PERIOD_START;
    const d1end = d1start + DAY;
    const d2start = d1end;
    const d2end = d2start + DAY;

    const rows = [
      {
        digest_json: makeDigestJson(d1start, d1end, [
          { prNumber: 1, projectId: "org/repo-a", title: "T1", summary: "S1", significance: "routine" as const, directionSignal: null, htmlUrl: "https://g.com/1" },
        ]),
        period_start: d1start,
        period_end: d1end,
      },
      { digest_json: null, period_start: d2start, period_end: d2end },
    ];

    const fallback = mock(emptyFallback);
    aggregateFromDigests(rows, PERIOD_START, PERIOD_END, fallback);

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledWith(d2start, d2end);
  });

  it("partial-digest: merges digest projects and fallback projects into combined result", () => {
    const d1start = PERIOD_START;
    const d1end = d1start + DAY;
    const d2start = d1end;
    const d2end = d2start + DAY;

    const rows = [
      {
        digest_json: makeDigestJson(d1start, d1end, [
          { prNumber: 1, projectId: "org/repo-a", title: "T1", summary: "S1", significance: "notable" as const, directionSignal: null, htmlUrl: "https://g.com/1" },
        ]),
        period_start: d1start,
        period_end: d1end,
      },
      { digest_json: null, period_start: d2start, period_end: d2end },
    ];

    const fallbackResult: WeeklyReportData = {
      directionChanges: [],
      activitySummary: { totalPrs: 2, directionalShiftCount: 0, notableCount: 0, projectCount: 1 },
      projectHighlights: [
        {
          projectId: "org/repo-b",
          prCount: 2,
          notableCount: 0,
          directionalShiftCount: 0,
          highlights: [
            { prNumber: 5, title: "FB PR", summary: "FB Sum", significance: "routine", directionSignal: null, htmlUrl: "https://g.com/5" },
          ],
        },
      ],
      counterpartChecks: [],
      periodStartUnix: d2start,
      periodEndUnix: d2end,
    };

    const result = aggregateFromDigests(rows, PERIOD_START, PERIOD_END, () => fallbackResult);

    const projectIds = result.projectHighlights.map((p) => p.projectId);
    expect(projectIds).toContain("org/repo-a");
    expect(projectIds).toContain("org/repo-b");
    expect(result.activitySummary.totalPrs).toBe(3); // 1 from digest + 2 from fallback
    expect(result.activitySummary.notableCount).toBe(1);
    expect(result.activitySummary.projectCount).toBe(2);
  });

  it("partial-digest: accumulates pr counts when the same project appears in both digest and fallback", () => {
    const d1start = PERIOD_START;
    const d1end = d1start + DAY;
    const d2start = d1end;
    const d2end = d2start + DAY;

    const rows = [
      {
        digest_json: makeDigestJson(d1start, d1end, [
          { prNumber: 1, projectId: "org/repo-a", title: "T1", summary: "S1", significance: "routine" as const, directionSignal: null, htmlUrl: "https://g.com/1" },
        ]),
        period_start: d1start,
        period_end: d1end,
      },
      { digest_json: null, period_start: d2start, period_end: d2end },
    ];

    const fallbackResult: WeeklyReportData = {
      directionChanges: [],
      activitySummary: { totalPrs: 3, directionalShiftCount: 0, notableCount: 0, projectCount: 1 },
      projectHighlights: [
        {
          projectId: "org/repo-a", // same project as digest
          prCount: 3,
          notableCount: 0,
          directionalShiftCount: 0,
          highlights: [],
        },
      ],
      counterpartChecks: [],
      periodStartUnix: d2start,
      periodEndUnix: d2end,
    };

    const result = aggregateFromDigests(rows, PERIOD_START, PERIOD_END, () => fallbackResult);

    const repoA = result.projectHighlights.find((p) => p.projectId === "org/repo-a")!;
    expect(repoA).toBeDefined();
    expect(repoA.prCount).toBe(4); // 1 (digest) + 3 (fallback)
    expect(result.activitySummary.totalPrs).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Finding 1: fillAbsentDays — absent days (no reports row) get synthetic null entries
// ---------------------------------------------------------------------------

describe("fillAbsentDays", () => {
  it("returns 7 entries for an empty rows array (all absent)", () => {
    const result = fillAbsentDays([], PERIOD_START, PERIOD_END);
    expect(result).toHaveLength(7);
    for (const row of result) {
      expect(row.digest_json).toBeNull();
    }
  });

  it("synthetic null entries span the full week with correct period bounds", () => {
    const result = fillAbsentDays([], PERIOD_START, PERIOD_END);
    expect(result[0]!.period_start).toBe(PERIOD_START);
    expect(result[6]!.period_end).toBe(PERIOD_END);
    // Each synthetic window is contiguous
    for (let i = 0; i < 6; i++) {
      expect(result[i + 1]!.period_start).toBe(result[i]!.period_start + 86400);
    }
  });

  it("uses the real row for a covered day and null for absent days", () => {
    const d2start = PERIOD_START + DAY;
    const d2end = d2start + DAY - 1;
    const realRow = {
      digest_json: makeDigestJson(d2start, d2end, [
        { prNumber: 1, projectId: "org/repo-a", title: "T", summary: "S", significance: "routine" as const, directionSignal: null, htmlUrl: "https://g.com/1" },
      ]),
      period_start: d2start,
      period_end: d2end,
    };

    const result = fillAbsentDays([realRow], PERIOD_START, PERIOD_END);

    expect(result).toHaveLength(7);
    // Slot 1 (index 1) corresponds to PERIOD_START + DAY
    expect(result[1]).toBe(realRow);
    // All other slots are synthetic null
    for (let i = 0; i < 7; i++) {
      if (i !== 1) expect(result[i]!.digest_json).toBeNull();
    }
  });

  it("absent-day analyses are included via per-day fallback when digest row is present for another day", () => {
    // Day 1 has a real digest row; Day 2 is absent (no row in DB — synthetic null injected by fillAbsentDays)
    const d1start = PERIOD_START;
    const d1end = d1start + DAY - 1;
    const d2start = PERIOD_START + DAY;
    const d2end = d2start + DAY - 1;

    const digestRow = {
      digest_json: makeDigestJson(d1start, d1end, [
        { prNumber: 1, projectId: "org/repo-a", title: "T1", summary: "S1", significance: "routine" as const, directionSignal: null, htmlUrl: "https://g.com/1" },
      ]),
      period_start: d1start,
      period_end: d1end,
    };

    // Simulate: absent day becomes synthetic null row (as fillAbsentDays() produces)
    const absentDaySyntheticRow = { digest_json: null, period_start: d2start, period_end: d2end };

    const fallbackForAbsentDay: WeeklyReportData = {
      directionChanges: [],
      activitySummary: { totalPrs: 2, directionalShiftCount: 0, notableCount: 0, projectCount: 1 },
      projectHighlights: [{
        projectId: "org/absent-day-repo",
        prCount: 2,
        notableCount: 0,
        directionalShiftCount: 0,
        highlights: [{ prNumber: 9, title: "Absent PR", summary: "From absent day", significance: "routine", directionSignal: null, htmlUrl: "https://g.com/9" }],
      }],
      counterpartChecks: [],
      periodStartUnix: d2start,
      periodEndUnix: d2end,
    };

    const fallback = mock((start: number, end: number): WeeklyReportData => {
      if (start === d2start) return fallbackForAbsentDay;
      return emptyFallback(start, end);
    });

    // Pass the augmented rows (as buildWeeklyReport would after fillAbsentDays)
    const result = aggregateFromDigests(
      [digestRow, absentDaySyntheticRow],
      PERIOD_START, PERIOD_END, fallback
    );

    // Fallback must be called for the absent day
    expect(fallback).toHaveBeenCalledWith(d2start, d2end);

    // Analyses from the absent day are included in the weekly report
    const projectIds = result.projectHighlights.map((p) => p.projectId);
    expect(projectIds).toContain("org/repo-a");
    expect(projectIds).toContain("org/absent-day-repo");
    expect(result.activitySummary.totalPrs).toBe(3); // 1 (digest) + 2 (absent day fallback)
  });
});

// ---------------------------------------------------------------------------
// Finding 2: directionChanges signals must not be truncated by highlights cap
// ---------------------------------------------------------------------------

describe("aggregateFromDigests > mixed-mode directionChanges signals completeness", () => {
  it("includes all directional signals from a null-digest fallback day even when highlights are capped at 2", () => {
    const d1start = PERIOD_START;
    const d1end = d1start + DAY - 1;
    const d2start = PERIOD_START + DAY;
    const d2end = d2start + DAY - 1;

    const digestRow = {
      digest_json: makeDigestJson(d1start, d1end, [
        { prNumber: 1, projectId: "org/repo-a", title: "T1", summary: "S1", significance: "routine" as const, directionSignal: null, htmlUrl: "https://g.com/1" },
      ]),
      period_start: d1start,
      period_end: d1end,
    };

    const nullRow = { digest_json: null, period_start: d2start, period_end: d2end };

    // Fallback day has 3 directional-shift PRs, but highlights are capped at 2.
    // The old code reconstructed signals from highlights and would miss "signal-gamma".
    const fallbackResult: WeeklyReportData = {
      directionChanges: [{
        projectId: "org/repo-b",
        prCount: 3,
        signals: ["signal-alpha", "signal-beta", "signal-gamma"],
      }],
      activitySummary: { totalPrs: 3, directionalShiftCount: 3, notableCount: 0, projectCount: 1 },
      projectHighlights: [{
        projectId: "org/repo-b",
        prCount: 3,
        notableCount: 0,
        directionalShiftCount: 3,
        highlights: [
          // Only 2 highlights (capped) — signal-gamma is NOT present here
          { prNumber: 5, title: "PR 5", summary: "S5", significance: "directional_shift", directionSignal: "signal-alpha", htmlUrl: "https://g.com/5" },
          { prNumber: 6, title: "PR 6", summary: "S6", significance: "directional_shift", directionSignal: "signal-beta", htmlUrl: "https://g.com/6" },
        ],
      }],
      counterpartChecks: [],
      periodStartUnix: d2start,
      periodEndUnix: d2end,
    };

    const result = aggregateFromDigests([digestRow, nullRow], PERIOD_START, PERIOD_END, () => fallbackResult);

    const dc = result.directionChanges.find((d) => d.projectId === "org/repo-b")!;
    expect(dc).toBeDefined();
    expect(dc.signals).toContain("signal-alpha");
    expect(dc.signals).toContain("signal-beta");
    // This is the key assertion: signal-gamma must appear even though it's not in the capped highlights
    expect(dc.signals).toContain("signal-gamma");
  });
});
