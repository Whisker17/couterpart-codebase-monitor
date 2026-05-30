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

const { execute } = await import("./report");

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
    const ctx = { stageResults: new Map() };
    const result = await execute(ctx);
    expect(result.success).toBe(true);
    expect(result.itemsProcessed).toBe(0);
  });

  it("returns itemsProcessed > 0 when analyses exist", async () => {
    insertTestData(testDb);
    const ctx = { stageResults: new Map() };
    const result = await execute(ctx);
    expect(result.success).toBe(true);
    expect(result.itemsProcessed).toBeGreaterThan(0);
  });

  it("writes the report row to the reports table", async () => {
    insertTestData(testDb);
    const ctx = { stageResults: new Map() };
    await execute(ctx);
    const row = testDb.query<{ id: number; type: string }, []>("SELECT * FROM reports").get();
    expect(row).toBeDefined();
    expect(row!.type).toBe("daily");
  });

  it("is idempotent — running twice doesn't create duplicate rows", async () => {
    insertTestData(testDb);
    const ctx = { stageResults: new Map() };
    await execute(ctx);
    await execute(ctx);
    const count = testDb.query<{ n: number }, []>("SELECT COUNT(*) as n FROM reports").get()!;
    expect(count.n).toBe(1);
  });

  it("calls writeReportFile when analyses exist", async () => {
    insertTestData(testDb);
    const ctx = { stageResults: new Map() };
    await execute(ctx);
    expect(mockWriteReportFile).toHaveBeenCalledTimes(1);
  });

  it("includes partial warning when upstream stages had failedProjects", async () => {
    insertTestData(testDb);
    const ctx = {
      stageResults: new Map([
        ["collect", { success: false, itemsProcessed: 0, errors: [], durationMs: 0, failedProjects: ["org/repo-b"] }],
      ]),
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
    const ctx = { stageResults: new Map() };
    await execute(ctx);
    const row = testDb.query<{ completeness: string }, []>("SELECT completeness FROM reports").get()!;
    const completeness = JSON.parse(row.completeness);
    expect(completeness).toHaveProperty("total");
    expect(completeness).toHaveProperty("success");
    expect(completeness).toHaveProperty("failed");
  });
});
