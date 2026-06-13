import { Database } from "bun:sqlite";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { runBacktest } from "./impact-check-backtest";
import type { BacktestDeps } from "./impact-check-backtest";
import type { MantleConfig } from "../src/config/projects";
import type { ImpactCheckConfig } from "../src/config/settings";

// ---- In-memory schema ----

function applySchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      org TEXT NOT NULL,
      repo TEXT NOT NULL,
      url TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pull_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      merged_at INTEGER,
      UNIQUE(project_id, pr_number)
    );
    CREATE TABLE IF NOT EXISTS analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_id INTEGER NOT NULL,
      project_id TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      significance TEXT,
      downstream_impact_hint TEXT DEFAULT 'none',
      analyzed_at INTEGER NOT NULL
    );
  `);
  db.run(
    "INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org/source', 'org', 'source', 'https://github.com/org/source')"
  );
}

// ---- Fixture helpers ----

function insertPr(
  db: Database,
  prNumber: number,
  mergedAt: number
): number {
  db.run(
    "INSERT INTO pull_requests (project_id, pr_number, merged_at) VALUES ('org/source', ?, ?)",
    [prNumber, mergedAt]
  );
  return db.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()!.id;
}

function insertAnalysis(
  db: Database,
  prId: number,
  significance: string | null,
  analyzedAt: number,
  projectId = "org/source"
): void {
  db.run(
    "INSERT INTO analyses (pr_id, project_id, significance, downstream_impact_hint, analyzed_at) VALUES (?, ?, ?, 'none', ?)",
    [prId, projectId, significance, analyzedAt]
  );
}

// ---- Fixture config ----

const MANTLE_CONFIG: MantleConfig = {
  mantleTargets: [
    { projectId: "mantle/target-a", tags: [], repoUrl: "https://github.com/mantle/target-a" },
  ],
  counterpartRelationships: [
    {
      source: "org/source",
      targets: ["mantle/target-a"],
      relationship: "fork_of",
      reason: "test fixture",
    },
  ],
};

const IMPACT_CONFIG: ImpactCheckConfig = {
  enabled: false,
  maxChecksPerDay: 2,
  maxStepsPerCheck: 12,
  maxCostPerCheck: 1.0,
  monthlySubCap: 50,
  maxAgeDays: 7,
  clonesDir: "data/test-repos",
  maxCloneDiskGB: 10,
  codegraphEnabled: false,
};

// ---- Date helper (mirrors the impl) ----

function toDateStr(timezone: string, unixSecs: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(unixSecs * 1000));
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

const TZ = "Asia/Shanghai";

// ---- Tests ----

describe("runBacktest", () => {
  let db: Database;
  // Timestamps: use 1-day-ago merged_at so PRs are within maxAgeDays=7
  const now = Math.floor(Date.now() / 1000);
  const MERGED_RECENT = now - 86400;          // 1 day ago — within maxAgeDays=7

  // Use 5-day gaps to avoid timezone day-boundary ambiguity
  const ANALYZED_A = now - 9 * 86400;        // ~9 days ago
  const ANALYZED_B = now - 5 * 86400;        // ~5 days ago
  const ANALYZED_C = now - 1 * 86400;        // ~1 day ago

  function makeDeps(overrides?: Partial<BacktestDeps>): BacktestDeps {
    return {
      db,
      mantleConfig: MANTLE_CONFIG,
      impactCheckConfig: IMPACT_CONFIG,
      timezone: TZ,
      ...overrides,
    };
  }

  beforeEach(() => {
    db = new Database(":memory:");
    applySchema(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns empty result when no analyses exist", () => {
    const result = runBacktest(30, makeDeps());
    expect(result.totalCandidates).toBe(0);
    expect(result.daysWithCandidates).toBe(0);
    expect(result.overQuotaDays).toBe(0);
    expect(result.dailyCounts).toHaveLength(0);
  });

  it("excludes analyses outside the lookback window", () => {
    const oldTs = now - 31 * 86400;  // 31 days ago, outside 30-day window
    const prId = insertPr(db, 1, MERGED_RECENT);
    insertAnalysis(db, prId, "notable", oldTs);

    const result = runBacktest(30, makeDeps());
    expect(result.totalCandidates).toBe(0);
  });

  it("excludes analyses whose project_id has no counterpart relationship", () => {
    // Insert a PR and analysis for a project not in MANTLE_CONFIG
    db.run(
      "INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('other/proj', 'other', 'proj', 'https://github.com/other/proj')"
    );
    db.run(
      "INSERT INTO pull_requests (project_id, pr_number, merged_at) VALUES ('other/proj', 99, ?)",
      [MERGED_RECENT]
    );
    const prId = db
      .query<{ id: number }, []>("SELECT last_insert_rowid() AS id")
      .get()!.id;
    insertAnalysis(db, prId, "notable", ANALYZED_B, "other/proj");

    const result = runBacktest(30, makeDeps());
    expect(result.totalCandidates).toBe(0);
  });

  it("skips manual relationships", () => {
    const manualConfig: MantleConfig = {
      mantleTargets: MANTLE_CONFIG.mantleTargets,
      counterpartRelationships: [
        {
          source: "org/source",
          targets: ["mantle/target-a"],
          relationship: "manual",
          reason: "manual test",
        },
      ],
    };
    const prId = insertPr(db, 1, MERGED_RECENT);
    insertAnalysis(db, prId, "notable", ANALYZED_B);

    const result = runBacktest(30, makeDeps({ mantleConfig: manualConfig }));
    expect(result.totalCandidates).toBe(0);
  });

  it("excludes routine significance (hint=none, Phase 1 gate)", () => {
    const prId = insertPr(db, 1, MERGED_RECENT);
    insertAnalysis(db, prId, "routine", ANALYZED_B);

    const result = runBacktest(30, makeDeps());
    expect(result.totalCandidates).toBe(0);
    expect(result.significanceDist.routine).toBe(0);
  });

  it("excludes null significance (hint=none, Phase 1 gate)", () => {
    const prId = insertPr(db, 1, MERGED_RECENT);
    insertAnalysis(db, prId, null, ANALYZED_B);

    const result = runBacktest(30, makeDeps());
    expect(result.totalCandidates).toBe(0);
  });

  it("counts daily distribution, significance distribution, and over-quota correctly", () => {
    // Day A: 2 routine analyses → 0 candidates (no candidates day)
    const prA1 = insertPr(db, 1, MERGED_RECENT);
    insertAnalysis(db, prA1, "routine", ANALYZED_A);
    const prA2 = insertPr(db, 2, MERGED_RECENT);
    insertAnalysis(db, prA2, "routine", ANALYZED_A);

    // Day B: 1 notable + 1 directional_shift → 2 candidates (at quota, not over)
    const prB1 = insertPr(db, 3, MERGED_RECENT);
    insertAnalysis(db, prB1, "notable", ANALYZED_B);
    const prB2 = insertPr(db, 4, MERGED_RECENT);
    insertAnalysis(db, prB2, "directional_shift", ANALYZED_B);

    // Day C: 2 notable + 1 directional_shift → 3 candidates (over quota of 2)
    const prC1 = insertPr(db, 5, MERGED_RECENT);
    insertAnalysis(db, prC1, "notable", ANALYZED_C);
    const prC2 = insertPr(db, 6, MERGED_RECENT);
    insertAnalysis(db, prC2, "notable", ANALYZED_C);
    const prC3 = insertPr(db, 7, MERGED_RECENT);
    insertAnalysis(db, prC3, "directional_shift", ANALYZED_C);

    const result = runBacktest(30, makeDeps());

    expect(result.totalCandidates).toBe(5);
    expect(result.daysWithCandidates).toBe(2);
    expect(result.overQuotaDays).toBe(1);

    // Significance distribution over passing candidates
    expect(result.significanceDist.notable).toBe(3);
    expect(result.significanceDist.directional_shift).toBe(2);
    expect(result.significanceDist.routine).toBe(0);
    expect(result.significanceDist["null"]).toBe(0);

    // Daily counts
    expect(result.dailyCounts).toHaveLength(2);
    const dateB = toDateStr(TZ, ANALYZED_B);
    const dateC = toDateStr(TZ, ANALYZED_C);
    expect(result.dailyCounts.find((d) => d.date === dateB)?.count).toBe(2);
    expect(result.dailyCounts.find((d) => d.date === dateC)?.count).toBe(3);

    // Sorted ascending by date
    if (result.dailyCounts.length === 2) {
      expect(result.dailyCounts[0]!.date <= result.dailyCounts[1]!.date).toBe(true);
    }
  });

  it("multiplies candidate count by number of targets per analysis", () => {
    const twoTargetConfig: MantleConfig = {
      mantleTargets: [
        { projectId: "mantle/target-a", tags: [] },
        { projectId: "mantle/target-b", tags: [] },
      ],
      counterpartRelationships: [
        {
          source: "org/source",
          targets: ["mantle/target-a", "mantle/target-b"],
          relationship: "depends_on",
          reason: "two-target test",
        },
      ],
    };
    const prId = insertPr(db, 1, MERGED_RECENT);
    insertAnalysis(db, prId, "notable", ANALYZED_B);

    const result = runBacktest(30, makeDeps({ mantleConfig: twoTargetConfig }));
    expect(result.totalCandidates).toBe(2);
    expect(result.significanceDist.notable).toBe(2);
  });

  it("over-quota percentage is expressed relative to days with candidates", () => {
    // All three analyses on different days, all passing
    const prA = insertPr(db, 1, MERGED_RECENT);
    insertAnalysis(db, prA, "notable", ANALYZED_A);
    const prB = insertPr(db, 2, MERGED_RECENT);
    insertAnalysis(db, prB, "notable", ANALYZED_B);
    // Day C: 3 analyses → over quota
    for (let i = 3; i <= 5; i++) {
      const prId = insertPr(db, i, MERGED_RECENT);
      insertAnalysis(db, prId, "notable", ANALYZED_C);
    }

    const result = runBacktest(30, makeDeps());
    expect(result.daysWithCandidates).toBe(3);
    expect(result.overQuotaDays).toBe(1);
    // 1/3 over quota
    const pct = (result.overQuotaDays / result.daysWithCandidates) * 100;
    expect(Math.abs(pct - 33.33)).toBeLessThan(0.1);
  });

  it("daily counts are sorted ascending by date", () => {
    const prA = insertPr(db, 1, MERGED_RECENT);
    insertAnalysis(db, prA, "notable", ANALYZED_C);  // most recent first in insert order
    const prB = insertPr(db, 2, MERGED_RECENT);
    insertAnalysis(db, prB, "notable", ANALYZED_A);  // oldest last

    const result = runBacktest(30, makeDeps());
    expect(result.dailyCounts.length).toBe(2);
    expect(result.dailyCounts[0]!.date <= result.dailyCounts[1]!.date).toBe(true);
  });
});
