import { describe, it, expect, mock, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  MIGRATION_001,
  MIGRATION_002,
  MIGRATION_003,
  MIGRATION_004,
} from "../../storage/schema";
import type { MantleConfig } from "../../config/projects";

// ---------------------------------------------------------------------------
// Test DB setup
// ---------------------------------------------------------------------------

let testDb: Database;

function buildTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (version TEXT PRIMARY KEY, applied_at INTEGER DEFAULT (unixepoch()))`);
  db.exec(MIGRATION_001);
  db.exec(MIGRATION_002);
  db.exec(MIGRATION_003);
  db.exec(MIGRATION_004);
  return db;
}

function insertProject(db: Database, projectId: string): void {
  const [org, repo] = projectId.split("/");
  db.query(
    "INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES (?, ?, ?, ?)"
  ).run(projectId, org!, repo!, `https://github.com/${projectId}`);
}

function insertPr(
  db: Database,
  id: number,
  projectId: string,
  prNumber: number,
  mergedAt: number,
  title = "Test PR"
): void {
  db.query(
    `INSERT INTO pull_requests (id, project_id, pr_number, title, merged_at, analysis_status)
     VALUES (?, ?, ?, ?, ?, 'complete')`
  ).run(id, projectId, prNumber, title, mergedAt);
}

function insertAnalysis(
  db: Database,
  prId: number,
  projectId: string,
  significance: "routine" | "notable" | "directional_shift",
  categories: string | null,
  summary = "Test summary"
): void {
  db.query(
    `INSERT INTO analyses (pr_id, project_id, summary, significance, categories)
     VALUES (?, ?, ?, ?, ?)`
  ).run(prId, projectId, summary, significance, categories);
}

// ---------------------------------------------------------------------------
// Module mocks (set up before imports so Bun hoists them correctly)
// ---------------------------------------------------------------------------

const TEST_MANTLE_CONFIG: MantleConfig = {
  mantleTargets: [{ projectId: "mantle/reth", tags: ["reth"], notes: "" }],
  counterpartRelationships: [
    {
      source: "base/base",
      targets: ["mantle/reth"],
      relationship: "manual",
      reason: "test reason",
    },
  ],
};

mock.module("../../storage/db", () => ({
  getDb: () => testDb,
}));

mock.module("../../config/projects", () => ({
  getTrackedProjects: () => [
    { org: "base", repo: "base", url: "https://github.com/base/base", tags: ["reth", "l2"] },
  ],
  getMantleConfig: () => TEST_MANTLE_CONFIG,
}));

const { selectWeeklyCandidates } = await import("./weekly-candidates");

// ---------------------------------------------------------------------------
// Fixed time reference
// A Wednesday at noon UTC. getWeekPeriod("UTC", now) gives:
//   yesterday = 2024-01-14, weekStart = 2024-01-08
//   period: [1704672000, 1705276799]  (7 full days ending yesterday midnight)
// ---------------------------------------------------------------------------
const NOW = new Date("2024-01-15T12:00:00Z");
const PERIOD_MID = 1704900000; // 2024-01-10 18:00 UTC — safely inside the period

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("selectWeeklyCandidates — integration", () => {
  afterEach(() => {
    testDb?.close();
  });

  // -------------------------------------------------------------------------
  // Routine pattern detection threshold
  // -------------------------------------------------------------------------

  it("routine PRs below threshold (< 3) are suppressed (score = 0, excluded from results)", () => {
    testDb = buildTestDb();
    insertProject(testDb, "base/base");

    // Insert 2 routine PRs — below the ≥3 threshold
    for (let i = 1; i <= 2; i++) {
      insertPr(testDb, i, "base/base", i, PERIOD_MID + i);
      insertAnalysis(testDb, i, "base/base", "routine", JSON.stringify(["testing"]));
    }

    const results = selectWeeklyCandidates("UTC", NOW);
    // All suppressed → filtered out → empty list
    expect(results).toHaveLength(0);
  });

  it("routine PRs at threshold (≥ 3) for the same project are promoted (isPartOfPattern = true)", () => {
    testDb = buildTestDb();
    insertProject(testDb, "base/base");

    // Insert exactly 3 routine PRs → pattern threshold met
    for (let i = 1; i <= 3; i++) {
      insertPr(testDb, i, "base/base", i, PERIOD_MID + i);
      insertAnalysis(testDb, i, "base/base", "routine", JSON.stringify(["testing"]));
    }

    const results = selectWeeklyCandidates("UTC", NOW);
    // All three should have non-zero scores
    expect(results.length).toBe(3);
    for (const r of results) {
      expect(r.mantleRelevanceScore).toBeGreaterThan(0);
      expect(r.candidateType).toBe("routine_pattern");
    }
  });

  it("routine PRs across different projects are counted separately (each project has independent threshold)", () => {
    testDb = buildTestDb();
    insertProject(testDb, "base/base");
    insertProject(testDb, "ethereum-optimism/op-geth");

    // base/base: 2 routine PRs (below threshold) — should be suppressed
    for (let i = 1; i <= 2; i++) {
      insertPr(testDb, i, "base/base", i, PERIOD_MID + i);
      insertAnalysis(testDb, i, "base/base", "routine", null);
    }
    // ethereum-optimism/op-geth: 3 routine PRs (at threshold) — should be promoted
    for (let i = 3; i <= 5; i++) {
      insertPr(testDb, i, "ethereum-optimism/op-geth", i, PERIOD_MID + i);
      insertAnalysis(testDb, i, "ethereum-optimism/op-geth", "routine", null);
    }

    const results = selectWeeklyCandidates("UTC", NOW);
    const fromBase = results.filter((r) => r.sourceProjectId === "base/base");
    const fromOpGeth = results.filter((r) => r.sourceProjectId === "ethereum-optimism/op-geth");

    expect(fromBase).toHaveLength(0); // suppressed
    expect(fromOpGeth).toHaveLength(3); // promoted
  });

  // -------------------------------------------------------------------------
  // Categories JSON.parse — valid and malformed input
  // -------------------------------------------------------------------------

  it("parses valid JSON categories and classifies the PR correctly", () => {
    testDb = buildTestDb();
    insertProject(testDb, "base/base");
    insertPr(testDb, 1, "base/base", 1, PERIOD_MID);
    insertAnalysis(testDb, 1, "base/base", "notable", JSON.stringify(["security"]));

    const results = selectWeeklyCandidates("UTC", NOW);
    expect(results).toHaveLength(1);
    expect(results[0]!.candidateType).toBe("risk_fix");
    expect(results[0]!.categories).toEqual(["security"]);
  });

  it("falls back to empty categories on malformed JSON — PR is still scored using significance", () => {
    testDb = buildTestDb();
    insertProject(testDb, "base/base");
    insertPr(testDb, 1, "base/base", 1, PERIOD_MID);
    // Store intentionally malformed JSON in categories
    insertAnalysis(testDb, 1, "base/base", "notable", "not-valid-json[");

    const results = selectWeeklyCandidates("UTC", NOW);
    // notable significance + empty categories → large_technical_change
    expect(results).toHaveLength(1);
    expect(results[0]!.categories).toEqual([]);
    expect(results[0]!.candidateType).toBe("large_technical_change");
    expect(results[0]!.mantleRelevanceScore).toBeGreaterThan(0);
  });

  it("treats null categories as empty array (no error thrown)", () => {
    testDb = buildTestDb();
    insertProject(testDb, "base/base");
    insertPr(testDb, 1, "base/base", 1, PERIOD_MID);
    insertAnalysis(testDb, 1, "base/base", "directional_shift", null);

    const results = selectWeeklyCandidates("UTC", NOW);
    expect(results).toHaveLength(1);
    expect(results[0]!.categories).toEqual([]);
    expect(results[0]!.candidateType).toBe("architecture_direction");
  });

  // -------------------------------------------------------------------------
  // Sorted descending by mantleRelevanceScore
  // -------------------------------------------------------------------------

  it("results are sorted descending by mantleRelevanceScore", () => {
    testDb = buildTestDb();
    insertProject(testDb, "base/base");

    // PR 1: routine (suppressed, should not appear)
    insertPr(testDb, 1, "base/base", 1, PERIOD_MID);
    insertAnalysis(testDb, 1, "base/base", "routine", null);

    // PR 2: large_technical_change (score 50)
    insertPr(testDb, 2, "base/base", 2, PERIOD_MID + 1);
    insertAnalysis(testDb, 2, "base/base", "notable", JSON.stringify(["docs"]));

    // PR 3: risk_fix (score 90)
    insertPr(testDb, 3, "base/base", 3, PERIOD_MID + 2);
    insertAnalysis(testDb, 3, "base/base", "notable", JSON.stringify(["security"]));

    // PR 4: transferable_optimization (score 75)
    insertPr(testDb, 4, "base/base", 4, PERIOD_MID + 3);
    insertAnalysis(testDb, 4, "base/base", "notable", JSON.stringify(["performance"]));

    const results = selectWeeklyCandidates("UTC", NOW);

    // Expect 3 results (routine suppressed), sorted risk_fix > transferable_optimization > large_technical_change
    expect(results).toHaveLength(3);
    expect(results[0]!.candidateType).toBe("risk_fix");
    expect(results[1]!.candidateType).toBe("transferable_optimization");
    expect(results[2]!.candidateType).toBe("large_technical_change");

    // Strict descending order
    for (let i = 0; i < results.length - 1; i++) {
      expect(results[i]!.mantleRelevanceScore).toBeGreaterThanOrEqual(
        results[i + 1]!.mantleRelevanceScore
      );
    }
  });

  // -------------------------------------------------------------------------
  // Empty period
  // -------------------------------------------------------------------------

  it("returns empty array when no analyses exist in the period", () => {
    testDb = buildTestDb();
    const results = selectWeeklyCandidates("UTC", NOW);
    expect(results).toHaveLength(0);
  });

  it("uses only the latest analysis row per PR", () => {
    testDb = buildTestDb();
    insertProject(testDb, "base/base");
    insertPr(testDb, 1, "base/base", 3219, PERIOD_MID, "Duplicate analysis PR");
    insertAnalysis(testDb, 1, "base/base", "notable", JSON.stringify(["performance"]), "old performance summary");
    insertAnalysis(testDb, 1, "base/base", "notable", JSON.stringify(["security"]), "new security summary");

    const results = selectWeeklyCandidates("UTC", NOW);

    expect(results).toHaveLength(1);
    expect(results[0]!.prNumber).toBe(3219);
    expect(results[0]!.summary).toBe("new security summary");
    expect(results[0]!.candidateType).toBe("risk_fix");
  });
});
