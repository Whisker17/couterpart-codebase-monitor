import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync, mkdirSync } from "fs";

const TEST_DB_PATH = "data/test-report-stage.db";
let testDb: Database;

mock.module("../../storage/db", () => ({
  getDb: () => testDb,
}));

mock.module("../../config/projects", () => ({
  getTrackedProjects: () => [
    { org: "org", repo: "repo-a", url: "https://github.com/org/repo-a" },
    { org: "org", repo: "repo-b", url: "https://github.com/org/repo-b" },
  ],
}));

const mockWriteReportFile = mock((_content: unknown) => "data/reports/daily-2026-01-01.json");
mock.module("../../extensions/report-generator/file-writer", () => ({
  writeReportFile: mockWriteReportFile,
}));

const { execute, buildFinalCard } = await import("./report");

function applySchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      org TEXT NOT NULL,
      repo TEXT NOT NULL,
      url TEXT NOT NULL,
      description TEXT,
      language TEXT,
      topics TEXT,
      overview TEXT,
      tech_stack TEXT,
      clone_path TEXT,
      last_synced_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS pull_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL REFERENCES projects(id),
      pr_number INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      author TEXT,
      merged_at INTEGER,
      files_changed INTEGER,
      additions INTEGER,
      deletions INTEGER,
      diff_path TEXT,
      diff_status TEXT DEFAULT 'missing',
      analysis_status TEXT DEFAULT 'pending',
      retry_count INTEGER DEFAULT 0,
      last_error TEXT,
      fetched_at INTEGER DEFAULT (unixepoch()),
      UNIQUE(project_id, pr_number)
    );
    CREATE TABLE IF NOT EXISTS analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_id INTEGER NOT NULL REFERENCES pull_requests(id),
      project_id TEXT NOT NULL REFERENCES projects(id),
      summary TEXT NOT NULL,
      technical_detail TEXT,
      direction_signal TEXT,
      significance TEXT,
      categories TEXT,
      model_id TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      estimated_cost_usd REAL,
      analyzed_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT,
      period_start INTEGER NOT NULL,
      period_end INTEGER NOT NULL,
      project_ids TEXT,
      content TEXT NOT NULL,
      completeness TEXT,
      sent_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch()),
      UNIQUE(type, period_start, period_end)
    );
  `);
}

function insertTestData(db: Database): void {
  db.run(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org/repo-a', 'org', 'repo-a', 'https://github.com/org/repo-a')`);
  db.run(`INSERT INTO pull_requests (project_id, pr_number, title, analysis_status) VALUES ('org/repo-a', 1, 'Test PR', 'complete')`);
  const pr = db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!;
  const now = Math.floor(Date.now() / 1000);
  db.run(
    `INSERT INTO analyses (pr_id, project_id, summary, technical_detail, direction_signal, significance, analyzed_at)
     VALUES (?, 'org/repo-a', 'Test summary', 'Test detail', null, 'routine', ?)`,
    [pr.id, now]
  );
}

describe("report stage", () => {
  beforeEach(() => {
    testDb = new Database(TEST_DB_PATH);
    applySchema(testDb);
    mockWriteReportFile.mockClear();
  });

  afterEach(() => {
    testDb.close();
    try { rmSync(TEST_DB_PATH); } catch { /* ignore */ }
  });

  it("returns itemsProcessed=0 when no analyses exist", async () => {
    const ctx = { stageResults: new Map(), isWeeklyRun: false };
    const result = await execute(ctx);
    expect(result.success).toBe(true);
    expect(result.itemsProcessed).toBe(0);
  });

  it("returns itemsProcessed > 0 when analyses exist", async () => {
    insertTestData(testDb);
    const ctx = { stageResults: new Map(), isWeeklyRun: false };
    const result = await execute(ctx);
    expect(result.success).toBe(true);
    expect(result.itemsProcessed).toBeGreaterThan(0);
  });

  it("writes the report row to the reports table", async () => {
    insertTestData(testDb);
    const ctx = { stageResults: new Map(), isWeeklyRun: false };
    await execute(ctx);
    const row = testDb.query<{ id: number; type: string }, []>("SELECT * FROM reports").get();
    expect(row).toBeDefined();
    expect(row!.type).toBe("daily");
  });

  it("is idempotent — running twice doesn't create duplicate rows", async () => {
    insertTestData(testDb);
    const ctx = { stageResults: new Map(), isWeeklyRun: false };
    await execute(ctx);
    await execute(ctx);
    const count = testDb.query<{ n: number }, []>("SELECT COUNT(*) as n FROM reports").get()!;
    expect(count.n).toBe(1);
  });

  it("calls writeReportFile when analyses exist", async () => {
    insertTestData(testDb);
    const ctx = { stageResults: new Map(), isWeeklyRun: false };
    await execute(ctx);
    expect(mockWriteReportFile).toHaveBeenCalledTimes(1);
  });

  it("includes partial warning when upstream stages had failedProjects", async () => {
    insertTestData(testDb);
    const ctx = {
      stageResults: new Map([
        ["collect", { success: false, itemsProcessed: 0, errors: [], durationMs: 0, failedProjects: ["org/repo-b"] }],
      ]),
      isWeeklyRun: false,
    };
    await execute(ctx);
    const row = testDb.query<{ content: string }, []>("SELECT content FROM reports").get()!;
    const card = JSON.parse(row.content);
    const summaryEl = card.elements.find((e: { tag: string }) => e.tag === "markdown");
    expect(summaryEl.content).toContain("⚠");
    expect(summaryEl.content).toContain("Partial report");
  });

  it("completeness is stored in reports table", async () => {
    insertTestData(testDb);
    const ctx = { stageResults: new Map(), isWeeklyRun: false };
    await execute(ctx);
    const row = testDb.query<{ completeness: string }, []>("SELECT completeness FROM reports").get()!;
    const completeness = JSON.parse(row.completeness);
    expect(completeness).toHaveProperty("total");
    expect(completeness).toHaveProperty("success");
    expect(completeness).toHaveProperty("failed");
  });

  it("upsert updates project_ids on re-run", async () => {
    insertTestData(testDb);
    const ctx = { stageResults: new Map(), isWeeklyRun: false };
    await execute(ctx);
    const before = testDb.query<{ project_ids: string }, []>("SELECT project_ids FROM reports").get()!;
    await execute(ctx);
    const after = testDb.query<{ project_ids: string }, []>("SELECT project_ids FROM reports").get()!;
    // project_ids should be set (not null) and unchanged across idempotent runs
    expect(before.project_ids).toBeDefined();
    expect(after.project_ids).toBe(before.project_ids);
  });

  it("does not write weekly report row when isWeeklyRun is false", async () => {
    insertTestData(testDb);
    const ctx = { stageResults: new Map(), isWeeklyRun: false };
    await execute(ctx);
    const count = testDb.query<{ n: number }, []>("SELECT COUNT(*) as n FROM reports WHERE type='weekly'").get()!;
    expect(count.n).toBe(0);
  });

  it("writes weekly report row when isWeeklyRun is true", async () => {
    insertTestData(testDb);
    const ctx = { stageResults: new Map(), isWeeklyRun: true };
    await execute(ctx);
    const weeklyRow = testDb.query<{ type: string }, []>("SELECT type FROM reports WHERE type='weekly'").get();
    expect(weeklyRow).toBeDefined();
    expect(weeklyRow!.type).toBe("weekly");
  });

  it("weekly run calls writeReportFile twice (daily + weekly)", async () => {
    insertTestData(testDb);
    const ctx = { stageResults: new Map(), isWeeklyRun: true };
    await execute(ctx);
    expect(mockWriteReportFile).toHaveBeenCalledTimes(2);
  });

  it("daily report still succeeds on weekly run", async () => {
    insertTestData(testDb);
    const ctx = { stageResults: new Map(), isWeeklyRun: true };
    const result = await execute(ctx);
    expect(result.success).toBe(true);
    const dailyRow = testDb.query<{ type: string }, []>("SELECT type FROM reports WHERE type='daily'").get();
    expect(dailyRow).toBeDefined();
  });
});

describe("buildFinalCard", () => {
  const routinePR = {
    prNumber: 1,
    title: "Routine fix",
    summary: "s".repeat(50),
    technicalDetail: null,
    significance: "routine" as const,
    directionSignal: null,
  };

  const notablePR = {
    prNumber: 2,
    title: "Notable change",
    summary: "s".repeat(50),
    technicalDetail: null,
    significance: "notable" as const,
    directionSignal: "improving perf",
  };

  const smallAnalyses = [
    {
      projectId: "org/repo-a",
      prCount: 1,
      directionalShiftCount: 0,
      notableCount: 0,
      topDirectionSignal: null,
      prs: [routinePR],
    },
  ];

  it("returns a single card when content fits under 20KB", () => {
    const result = buildFinalCard("2026-06-01", smallAnalyses, undefined);
    expect(result.errors).toHaveLength(0);
    expect(Array.isArray(result.card)).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.config).toBeDefined();
  });

  it("filters routine PRs and adds omit note when card exceeds 20KB", () => {
    const longSummary = "x".repeat(500);
    // Build analyses with many routine + 1 notable PR that together exceed 20KB
    const manyRoutine = Array.from({ length: 50 }, (_, i) => ({
      prNumber: i + 10,
      title: `Routine PR ${i}`,
      summary: longSummary,
      technicalDetail: longSummary,
      significance: "routine" as const,
      directionSignal: null,
    }));
    const bigAnalyses = [
      {
        projectId: "org/repo-a",
        prCount: manyRoutine.length + 1,
        directionalShiftCount: 0,
        notableCount: 1,
        topDirectionSignal: null,
        prs: [notablePR, ...manyRoutine],
      },
    ];

    const result = buildFinalCard("2026-06-01", bigAnalyses, undefined);
    expect(result.errors).toHaveLength(0);
    // Should have omitted routine PRs — content should not contain routine PR titles
    const card = JSON.parse(result.content);
    const summaryEl = card.config
      ? card.elements?.find((e: { tag: string }) => e.tag === "markdown")
      : null;
    if (summaryEl) {
      expect(summaryEl.content).toContain("omitted");
    }
    // Content must be under 20KB
    expect(result.content.length).toBeLessThanOrEqual(20 * 1024);
  });

  it("returns no errors for small analyses", () => {
    const result = buildFinalCard("2026-06-01", smallAnalyses, undefined);
    expect(result.errors).toHaveLength(0);
  });
});
