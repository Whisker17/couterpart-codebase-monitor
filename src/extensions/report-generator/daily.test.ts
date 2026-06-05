import { describe, it, expect, mock, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";

const PERIOD_START = 1748736000; // fixed unix timestamps for test determinism
const PERIOD_END = 1748822399;

mock.module("../../utils/time-window", () => ({
  getYesterdayPeriod: () => ({ startUnix: PERIOD_START, endUnix: PERIOD_END }),
}));

mock.module("../../utils/budget-tracker", () => ({
  getBudgetStatus: () => ({ usagePercent: 0, estimatedCostUSD: 0, budgetCapUSD: 100 }),
}));

let testDb: Database;

mock.module("../../storage/db", () => ({
  getDb: () => testDb,
}));

const { buildDailyReport } = await import("./daily");

function createSchema(db: Database): void {
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
      title TEXT NOT NULL,
      merged_at INTEGER,
      analysis_status TEXT DEFAULT 'pending',
      UNIQUE(project_id, pr_number)
    );
    CREATE TABLE IF NOT EXISTS analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_id INTEGER NOT NULL,
      project_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      technical_detail TEXT,
      direction_signal TEXT,
      significance TEXT NOT NULL,
      analyzed_at INTEGER DEFAULT (unixepoch())
    );
  `);
  db.run(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org/repo-a', 'org', 'repo-a', 'https://github.com/org/repo-a')`);
}

function insertPr(
  db: Database,
  prNumber: number,
  title: string,
  significance: "routine" | "notable" | "directional_shift",
  directionSignal: string | null,
  summary = "test summary"
): void {
  const mergedAt = PERIOD_START + 3600;
  db.run(
    `INSERT INTO pull_requests (project_id, pr_number, title, merged_at, analysis_status) VALUES ('org/repo-a', ?, ?, ?, 'complete')`,
    [prNumber, title, mergedAt]
  );
  const pr = db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!;
  db.run(
    `INSERT INTO analyses (pr_id, project_id, summary, direction_signal, significance) VALUES (?, 'org/repo-a', ?, ?, ?)`,
    [pr.id, summary, directionSignal, significance]
  );
}

describe("buildDailyReport digest", () => {
  beforeEach(() => {
    testDb = new Database(":memory:");
    createSchema(testDb);
  });

  it("returns a valid empty digest when no PRs exist", () => {
    const result = buildDailyReport("UTC");
    expect(result.digest).toBeDefined();
    expect(result.digest.periodStart).toBe(PERIOD_START);
    expect(result.digest.periodEnd).toBe(PERIOD_END);
    expect(result.digest.projects).toHaveLength(0);
    expect(result.digest.activitySummary.totalPrs).toBe(0);
    expect(result.digest.activitySummary.directionalShiftCount).toBe(0);
    expect(result.digest.activitySummary.notableCount).toBe(0);
  });

  it("digest includes all PRs including routine ones", () => {
    insertPr(testDb, 1, "Directional PR", "directional_shift", "big signal");
    insertPr(testDb, 2, "Routine PR", "routine", null);

    const result = buildDailyReport("UTC");
    const project = result.digest.projects[0]!;
    expect(project.prs).toHaveLength(2);
  });

  it("digest.projects[].prs contains DigestPrSummary with htmlUrl", () => {
    insertPr(testDb, 42, "My PR", "notable", "improving throughput");

    const result = buildDailyReport("UTC");
    const project = result.digest.projects[0]!;
    const pr = project.prs[0]!;
    expect(pr.prNumber).toBe(42);
    expect(pr.title).toBe("My PR");
    expect(pr.significance).toBe("notable");
    expect(pr.directionSignal).toBe("improving throughput");
    expect(pr.htmlUrl).toBe("https://github.com/org/repo-a/pull/42");
  });

  it("topSignals is a deduplicated list of non-null direction_signal values", () => {
    insertPr(testDb, 1, "PR 1", "directional_shift", "signal A");
    insertPr(testDb, 2, "PR 2", "notable", "signal A"); // duplicate
    insertPr(testDb, 3, "PR 3", "notable", "signal B");
    insertPr(testDb, 4, "PR 4", "routine", null); // null excluded

    const result = buildDailyReport("UTC");
    const project = result.digest.projects[0]!;
    expect(project.topSignals).toHaveLength(2);
    expect(project.topSignals).toContain("signal A");
    expect(project.topSignals).toContain("signal B");
  });

  it("activitySummary totals are correct", () => {
    insertPr(testDb, 1, "DS PR", "directional_shift", "shift");
    insertPr(testDb, 2, "Notable PR", "notable", "noteworthy");
    insertPr(testDb, 3, "Routine PR", "routine", null);

    const result = buildDailyReport("UTC");
    expect(result.digest.activitySummary.totalPrs).toBe(3);
    expect(result.digest.activitySummary.directionalShiftCount).toBe(1);
    expect(result.digest.activitySummary.notableCount).toBe(1);
  });

  it("digest.periodStart and periodEnd match period window", () => {
    insertPr(testDb, 1, "PR", "routine", null);

    const result = buildDailyReport("UTC");
    expect(result.digest.periodStart).toBe(PERIOD_START);
    expect(result.digest.periodEnd).toBe(PERIOD_END);
  });

  it("digest project prCount matches grouped prCount", () => {
    insertPr(testDb, 1, "PR 1", "routine", null);
    insertPr(testDb, 2, "PR 2", "notable", "signal");
    insertPr(testDb, 3, "PR 3", "directional_shift", "big signal");

    const result = buildDailyReport("UTC");
    const project = result.digest.projects[0]!;
    expect(project.prCount).toBe(3);
    expect(project.notableCount).toBe(1);
    expect(project.directionalShiftCount).toBe(1);
  });

  it("digest does not break existing grouped return value", () => {
    insertPr(testDb, 1, "PR", "routine", null);

    const result = buildDailyReport("UTC");
    expect(result.analyses).toBeDefined();
    expect(result.grouped).toBeDefined();
    expect(result.periodStartUnix).toBe(PERIOD_START);
    expect(result.periodEndUnix).toBe(PERIOD_END);
  });
});
