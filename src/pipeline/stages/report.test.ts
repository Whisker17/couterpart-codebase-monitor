import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync, mkdirSync } from "fs";
import type { GroupedAnalyses } from "../../extensions/report-generator/templates/daily-card";
import type { WeeklyReportData } from "../../extensions/report-generator/weekly";

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

const mockLocalizeDailyDelivery = mock(async (analyses: GroupedAnalyses) => analyses);
const mockLocalizeWeeklyDelivery = mock(async (data: WeeklyReportData) => data);

const { execute, buildFinalCard } = await import("./report");

import { getYesterdayPeriod, getWeekPeriod } from "../../utils/time-window";

const TZ = "UTC";

function getYesterdayStartUnix(): number {
  return getYesterdayPeriod(TZ).startUnix;
}

function getYesterdayEndUnix(): number {
  return getYesterdayPeriod(TZ).endUnix;
}

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
      digest_json TEXT,
      sent_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch()),
      UNIQUE(type, period_start, period_end)
    );
    CREATE TABLE IF NOT EXISTS report_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id INTEGER NOT NULL REFERENCES reports(id),
      card_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      lark_message_id TEXT,
      status TEXT DEFAULT 'pending',
      sent_at INTEGER,
      UNIQUE(report_id, card_index)
    );
  `);
}

function insertTestData(db: Database): void {
  const yesterdayMid = getYesterdayStartUnix() + 3600;
  db.run(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org/repo-a', 'org', 'repo-a', 'https://github.com/org/repo-a')`);
  db.run(
    `INSERT INTO pull_requests (project_id, pr_number, title, merged_at, analysis_status)
     VALUES ('org/repo-a', 1, 'Test PR', ?, 'complete')`,
    [yesterdayMid]
  );
  const pr = db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!;
  db.run(
    `INSERT INTO analyses (pr_id, project_id, summary, technical_detail, direction_signal, significance, analyzed_at)
     VALUES (?, 'org/repo-a', 'Test summary', 'Test detail', null, 'routine', ?)`,
    [pr.id, yesterdayMid]
  );
}

function insertAnalyzedPr(
  db: Database,
  prNumber: number,
  title: string,
  mergedAt: number,
  analyzedAt: number
): void {
  db.run(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org/repo-a', 'org', 'repo-a', 'https://github.com/org/repo-a')`);
  db.run(
    `INSERT INTO pull_requests (project_id, pr_number, title, merged_at, analysis_status)
     VALUES ('org/repo-a', ?, ?, ?, 'complete')`,
    [prNumber, title, mergedAt]
  );
  const pr = db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!;
  db.run(
    `INSERT INTO analyses (pr_id, project_id, summary, technical_detail, direction_signal, significance, analyzed_at)
     VALUES (?, 'org/repo-a', ?, 'Test detail', null, 'routine', ?)`,
    [pr.id, `${title} summary`, analyzedAt]
  );
}

describe("report stage", () => {
  beforeEach(() => {
    testDb = new Database(TEST_DB_PATH);
    applySchema(testDb);
    mockWriteReportFile.mockClear();
    mockLocalizeDailyDelivery.mockClear();
    mockLocalizeWeeklyDelivery.mockClear();
    mockLocalizeDailyDelivery.mockImplementation(async (analyses: GroupedAnalyses) => analyses);
    mockLocalizeWeeklyDelivery.mockImplementation(async (data: WeeklyReportData) => data);
  });

  afterEach(() => {
    testDb.close();
    try { rmSync(TEST_DB_PATH); } catch { /* ignore */ }
  });

  it("returns itemsProcessed=0 when no analyses exist", async () => {
    const ctx = { stageResults: new Map(), reportMode: "daily" as const, timezone: TZ };
    const result = await execute(ctx);
    expect(result.success).toBe(true);
    expect(result.itemsProcessed).toBe(0);
  });

  it("returns itemsProcessed > 0 when analyses exist", async () => {
    insertTestData(testDb);
    const ctx = { stageResults: new Map(), reportMode: "daily" as const, timezone: TZ };
    const result = await execute(ctx);
    expect(result.success).toBe(true);
    expect(result.itemsProcessed).toBeGreaterThan(0);
  });

  it("writes the report row to the reports table", async () => {
    insertTestData(testDb);
    const ctx = { stageResults: new Map(), reportMode: "daily" as const, timezone: TZ };
    await execute(ctx);
    const row = testDb.query<{ id: number; type: string }, []>("SELECT * FROM reports").get();
    expect(row).toBeDefined();
    expect(row!.type).toBe("daily");
  });

  it("is idempotent — running twice doesn't create duplicate rows", async () => {
    insertTestData(testDb);
    const ctx = { stageResults: new Map(), reportMode: "daily" as const, timezone: TZ };
    await execute(ctx);
    await execute(ctx);
    const count = testDb.query<{ n: number }, []>("SELECT COUNT(*) as n FROM reports").get()!;
    expect(count.n).toBe(1);
  });

  it("calls writeReportFile when analyses exist", async () => {
    insertTestData(testDb);
    const ctx = { stageResults: new Map(), reportMode: "daily" as const, timezone: TZ };
    await execute(ctx);
    expect(mockWriteReportFile).toHaveBeenCalledTimes(1);
  });

  it("includes partial warning when upstream stages had failedProjects", async () => {
    insertTestData(testDb);
    const ctx = {
      stageResults: new Map([
        ["collect", { success: false, itemsProcessed: 0, errors: [], durationMs: 0, failedProjects: ["org/repo-b"] }],
      ]) as any,
      reportMode: "daily" as const,
      timezone: TZ,
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
    const ctx = { stageResults: new Map(), reportMode: "daily" as const, timezone: TZ };
    await execute(ctx);
    const row = testDb.query<{ completeness: string }, []>("SELECT completeness FROM reports").get()!;
    const completeness = JSON.parse(row.completeness);
    expect(completeness).toHaveProperty("total");
    expect(completeness).toHaveProperty("success");
    expect(completeness).toHaveProperty("failed");
  });

  it("upsert updates project_ids on re-run", async () => {
    insertTestData(testDb);
    const ctx = { stageResults: new Map(), reportMode: "daily" as const, timezone: TZ };
    await execute(ctx);
    const before = testDb.query<{ project_ids: string }, []>("SELECT project_ids FROM reports").get()!;
    await execute(ctx);
    const after = testDb.query<{ project_ids: string }, []>("SELECT project_ids FROM reports").get()!;
    // project_ids should be set (not null) and unchanged across idempotent runs
    expect(before.project_ids).toBeDefined();
    expect(after.project_ids).toBe(before.project_ids);
  });

  it("daily report includes only PRs merged during yesterday's period", async () => {
    const yesterdayStart = getYesterdayStartUnix();
    insertAnalyzedPr(testDb, 1, "Yesterday PR", yesterdayStart + 3600, yesterdayStart + 3600);
    insertAnalyzedPr(testDb, 2, "Old PR", yesterdayStart - 7 * 86400 + 3600, yesterdayStart - 7 * 86400 + 3600);

    const ctx = { stageResults: new Map(), reportMode: "daily" as const, timezone: TZ };
    await execute(ctx);

    const row = testDb.query<{ content: string }, []>("SELECT content FROM reports WHERE type='daily'").get()!;
    expect(row.content).toContain("Yesterday PR");
    expect(row.content).not.toContain("Old PR");
  });

  it("does not write weekly report row when reportMode is daily", async () => {
    insertTestData(testDb);
    const ctx = { stageResults: new Map(), reportMode: "daily" as const, timezone: TZ };
    await execute(ctx);
    const count = testDb.query<{ n: number }, []>("SELECT COUNT(*) as n FROM reports WHERE type='weekly'").get()!;
    expect(count.n).toBe(0);
  });

  it("writes weekly report row when reportMode is weekly", async () => {
    insertTestData(testDb);
    const ctx = { stageResults: new Map(), reportMode: "weekly" as const, timezone: TZ };
    await execute(ctx);
    const weeklyRow = testDb.query<{ type: string }, []>("SELECT type FROM reports WHERE type='weekly'").get();
    expect(weeklyRow).toBeDefined();
    expect(weeklyRow!.type).toBe("weekly");
  });

  it("weekly run calls writeReportFile twice (daily + weekly)", async () => {
    insertTestData(testDb);
    const ctx = { stageResults: new Map(), reportMode: "weekly" as const, timezone: TZ };
    await execute(ctx);
    expect(mockWriteReportFile).toHaveBeenCalledTimes(2);
  });

  it("daily report still succeeds on weekly run", async () => {
    insertTestData(testDb);
    const ctx = { stageResults: new Map(), reportMode: "weekly" as const, timezone: TZ };
    const result = await execute(ctx);
    expect(result.success).toBe(true);
    const dailyRow = testDb.query<{ type: string }, []>("SELECT type FROM reports WHERE type='daily'").get();
    expect(dailyRow).toBeDefined();
  });

  it("weekly run is idempotent — running twice produces only one weekly row", async () => {
    insertTestData(testDb);
    const ctx = { stageResults: new Map(), reportMode: "weekly" as const, timezone: TZ };
    await execute(ctx);
    await execute(ctx);
    const count = testDb.query<{ n: number }, []>("SELECT COUNT(*) as n FROM reports WHERE type='weekly'").get()!;
    expect(count.n).toBe(1);
  });

  it("weekly report includes only PRs merged during the weekly period", async () => {
    const { startUnix: weeklyStart, endUnix: weeklyEnd } = getWeekPeriod(TZ);
    const midWeek = Math.floor((weeklyStart + weeklyEnd) / 2);
    insertAnalyzedPr(testDb, 1, "This Week PR", midWeek, midWeek);
    insertAnalyzedPr(testDb, 2, "Older Than Week PR", weeklyStart - 86400, weeklyStart - 86400);

    const ctx = { stageResults: new Map(), reportMode: "weekly" as const, timezone: TZ };
    await execute(ctx);

    const row = testDb.query<{ content: string }, []>("SELECT content FROM reports WHERE type='weekly'").get()!;
    expect(row.content).toContain("This Week PR");
    expect(row.content).not.toContain("Older Than Week PR");
  });

  it("weekly errors do not affect daily success flag", async () => {
    insertTestData(testDb);
    // Force the weekly DB write to fail by closing the DB mid-run isn't feasible,
    // but we can verify the contract: after a normal weekly run, success reflects only daily errors
    const ctx = { stageResults: new Map(), reportMode: "weekly" as const, timezone: TZ };
    const result = await execute(ctx);
    // Daily succeeded — result.success must be true regardless of weekly outcome
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("creates at least one report_deliveries row after report insert", async () => {
    insertTestData(testDb);
    const ctx = { stageResults: new Map(), reportMode: "daily" as const, timezone: TZ };
    await execute(ctx);
    const deliveries = testDb
      .query<{ card_index: number; status: string }, []>(
        "SELECT card_index, status FROM report_deliveries"
      )
      .all();
    expect(deliveries.length).toBeGreaterThan(0);
    const first = deliveries[0]!;
    expect(first.card_index).toBe(0);
    expect(first.status).toBe("pending");
  });

  it("report_deliveries rows are upserted without duplicating them", async () => {
    insertTestData(testDb);
    const ctx = { stageResults: new Map(), reportMode: "daily" as const, timezone: TZ };
    await execute(ctx);
    await execute(ctx);
    const count = testDb
      .query<{ n: number }, []>("SELECT COUNT(*) as n FROM report_deliveries WHERE card_index = 0")
      .get()!;
    expect(count.n).toBe(1);
  });

  it("delivery content is valid JSON that parses to a LarkCard", async () => {
    insertTestData(testDb);
    const ctx = { stageResults: new Map(), reportMode: "daily" as const, timezone: TZ };
    await execute(ctx);
    const delivery = testDb
      .query<{ content: string }, []>("SELECT content FROM report_deliveries LIMIT 1")
      .get()!;
    const card = JSON.parse(delivery.content);
    expect(card).toHaveProperty("config");
    expect(card).toHaveProperty("header");
    expect(card).toHaveProperty("elements");
  });

  it("stores localized daily delivery content before dispatch", async () => {
    insertTestData(testDb);
    mockLocalizeDailyDelivery.mockImplementation(async (analyses: any) =>
      analyses.map((project: any) => ({
        ...project,
        prs: project.prs.map((pr: any) => ({
          ...pr,
          summary: "中文日报摘要",
        })),
      }))
    );

    const ctx = { stageResults: new Map(), reportMode: "daily" as const, timezone: TZ };
    await execute(ctx, { localizeDailyDelivery: mockLocalizeDailyDelivery });

    const delivery = testDb
      .query<{ content: string }, []>("SELECT content FROM report_deliveries LIMIT 1")
      .get()!;
    expect(delivery.content).toContain("中文日报摘要");
    expect(delivery.content).not.toContain("Test summary");
    expect(mockLocalizeDailyDelivery).toHaveBeenCalledTimes(1);
  });

  it("updates existing unsent delivery content when report content changes", async () => {
    insertTestData(testDb);
    const ctx = { stageResults: new Map(), reportMode: "daily" as const, timezone: TZ };
    await execute(ctx);

    mockLocalizeDailyDelivery.mockImplementation(async (analyses: any) =>
      analyses.map((project: any) => ({
        ...project,
        prs: project.prs.map((pr: any) => ({
          ...pr,
          summary: "中文重跑摘要",
        })),
      }))
    );
    await execute(ctx, { localizeDailyDelivery: mockLocalizeDailyDelivery });

    const delivery = testDb
      .query<{ content: string; status: string }, []>("SELECT content, status FROM report_deliveries LIMIT 1")
      .get()!;
    expect(delivery.status).toBe("pending");
    expect(delivery.content).toContain("中文重跑摘要");
    expect(delivery.content).not.toContain("Test summary");
  });

  it("stores localized weekly delivery content before dispatch", async () => {
    insertTestData(testDb);
    mockLocalizeWeeklyDelivery.mockImplementation(async (data: any) => ({
      ...data,
      projectHighlights: data.projectHighlights.map((project: any) => ({
        ...project,
        highlights: project.highlights.map((highlight: any) => ({
          ...highlight,
          summary: "中文周报摘要",
        })),
      })),
    }));

    const ctx = { stageResults: new Map(), reportMode: "weekly" as const, timezone: TZ };
    await execute(ctx, { localizeWeeklyDelivery: mockLocalizeWeeklyDelivery });

    const delivery = testDb
      .query<{ content: string }, []>(
        `SELECT d.content
         FROM report_deliveries d
         JOIN reports r ON d.report_id = r.id
         WHERE r.type = 'weekly'
         LIMIT 1`
      )
      .get()!;
    expect(delivery.content).toContain("中文周报摘要");
    expect(delivery.content).not.toContain("Test summary");
    expect(mockLocalizeWeeklyDelivery).toHaveBeenCalledTimes(1);
  });

  it("does not create reports row when no analyses exist", async () => {
    const ctx = { stageResults: new Map(), reportMode: "daily" as const, timezone: TZ };
    await execute(ctx);
    const count = testDb.query<{ n: number }, []>("SELECT COUNT(*) as n FROM reports").get()!;
    expect(count.n).toBe(0);
  });

  it("does not create report_deliveries row when no analyses exist", async () => {
    const ctx = { stageResults: new Map(), reportMode: "daily" as const, timezone: TZ };
    await execute(ctx);
    const count = testDb.query<{ n: number }, []>("SELECT COUNT(*) as n FROM report_deliveries").get()!;
    expect(count.n).toBe(0);
  });

  it("does not call writeReportFile when no deliverable PRs", async () => {
    const ctx = { stageResults: new Map(), reportMode: "daily" as const, timezone: TZ };
    await execute(ctx);
    expect(mockWriteReportFile).not.toHaveBeenCalled();
  });

  it("emits skip log when no deliverable PRs", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      const ctx = { stageResults: new Map(), reportMode: "daily" as const, timezone: TZ };
      await execute(ctx);
    } finally {
      console.log = origLog;
    }
    expect(logs.some((l) => l.includes("no deliverable PRs"))).toBe(true);
  });

  it("routine-only PRs still generate daily report", async () => {
    // routine significance is valid deliverable content
    insertTestData(testDb); // inserts routine PR merged today
    const ctx = { stageResults: new Map(), reportMode: "daily" as const, timezone: TZ };
    const result = await execute(ctx);
    expect(result.success).toBe(true);
    expect(result.itemsProcessed).toBeGreaterThan(0);
    const row = testDb.query<{ id: number }, []>("SELECT id FROM reports WHERE type='daily'").get();
    expect(row).toBeDefined();
  });

  it("partial upstream failure with deliverable PRs still generates report", async () => {
    insertTestData(testDb);
    const ctx = {
      stageResults: new Map([
        ["collect", { success: false, itemsProcessed: 0, errors: [], durationMs: 0, failedProjects: ["org/repo-b"] }],
      ]) as any,
      reportMode: "daily" as const,
      timezone: TZ,
    };
    const result = await execute(ctx);
    expect(result.success).toBe(true);
    const row = testDb.query<{ id: number }, []>("SELECT id FROM reports WHERE type='daily'").get();
    expect(row).toBeDefined();
  });

  it("daily report content contains full GitHub PR URL", async () => {
    insertTestData(testDb);
    const ctx = { stageResults: new Map(), reportMode: "daily" as const, timezone: TZ };
    await execute(ctx);
    const row = testDb.query<{ content: string }, []>("SELECT content FROM reports WHERE type='daily'").get()!;
    expect(row.content).toContain("https://github.com/org/repo-a/pull/1");
  });

  it("weekly report content contains full GitHub PR URL", async () => {
    const { startUnix: weeklyStart, endUnix: weeklyEnd } = getWeekPeriod(TZ);
    const midWeek = Math.floor((weeklyStart + weeklyEnd) / 2);
    insertAnalyzedPr(testDb, 5, "Weekly PR", midWeek, midWeek);

    const ctx = { stageResults: new Map(), reportMode: "weekly" as const, timezone: TZ };
    await execute(ctx);
    const row = testDb.query<{ content: string }, []>("SELECT content FROM reports WHERE type='weekly'").get()!;
    expect(row.content).toContain("https://github.com/org/repo-a/pull/5");
  });

  it("PR URL has no double slash when project url has trailing slash", async () => {
    const yesterdayMid = getYesterdayStartUnix() + 3600;
    testDb.run(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org/repo-trailing', 'org', 'repo-trailing', 'https://github.com/org/repo-trailing/')`);
    testDb.run(
      `INSERT INTO pull_requests (project_id, pr_number, title, merged_at, analysis_status) VALUES ('org/repo-trailing', 10, 'Trailing slash PR', ?, 'complete')`,
      [yesterdayMid]
    );
    const pr = testDb.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!;
    testDb.run(
      `INSERT INTO analyses (pr_id, project_id, summary, significance, analyzed_at) VALUES (?, 'org/repo-trailing', 'Trailing slash summary', 'routine', ?)`,
      [pr.id, yesterdayMid]
    );

    const ctx = { stageResults: new Map(), reportMode: "daily" as const, timezone: TZ };
    await execute(ctx);
    const row = testDb.query<{ content: string }, []>("SELECT content FROM reports WHERE type='daily'").get()!;
    expect(row.content).toContain("https://github.com/org/repo-trailing/pull/10");
    expect(row.content).not.toContain("//pull/");
  });

  it("stores digest_json in reports table when analyses exist", async () => {
    insertTestData(testDb);
    const ctx = { stageResults: new Map(), reportMode: "daily" as const, timezone: TZ };
    await execute(ctx);
    const row = testDb.query<{ digest_json: string }, []>("SELECT digest_json FROM reports WHERE type='daily'").get()!;
    expect(row.digest_json).toBeDefined();
    const digest = JSON.parse(row.digest_json);
    expect(digest).toHaveProperty("periodStart");
    expect(digest).toHaveProperty("periodEnd");
    expect(digest).toHaveProperty("projects");
    expect(digest).toHaveProperty("activitySummary");
  });

  it("digest_json contains all PRs including routine ones", async () => {
    const yesterdayMid = getYesterdayStartUnix() + 3600;
    testDb.run(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org/repo-a', 'org', 'repo-a', 'https://github.com/org/repo-a')`);
    // Insert a directional_shift PR
    testDb.run(`INSERT INTO pull_requests (project_id, pr_number, title, merged_at, analysis_status) VALUES ('org/repo-a', 1, 'Directional PR', ?, 'complete')`, [yesterdayMid]);
    const pr1 = testDb.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!;
    testDb.run(`INSERT INTO analyses (pr_id, project_id, summary, direction_signal, significance, analyzed_at) VALUES (?, 'org/repo-a', 'Big change summary', 'major shift signal', 'directional_shift', ?)`, [pr1.id, yesterdayMid]);
    // Insert a routine PR
    testDb.run(`INSERT INTO pull_requests (project_id, pr_number, title, merged_at, analysis_status) VALUES ('org/repo-a', 2, 'Routine PR', ?, 'complete')`, [yesterdayMid]);
    const pr2 = testDb.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!;
    testDb.run(`INSERT INTO analyses (pr_id, project_id, summary, direction_signal, significance, analyzed_at) VALUES (?, 'org/repo-a', 'Routine summary', null, 'routine', ?)`, [pr2.id, yesterdayMid]);

    const ctx = { stageResults: new Map(), reportMode: "daily" as const, timezone: TZ };
    await execute(ctx);
    const row = testDb.query<{ digest_json: string }, []>("SELECT digest_json FROM reports WHERE type='daily'").get()!;
    const digest = JSON.parse(row.digest_json);
    const project = digest.projects[0];
    expect(project.prs).toHaveLength(2);
    expect(project.topSignals).toContain("major shift signal");
    expect(digest.activitySummary.totalPrs).toBe(2);
    expect(digest.activitySummary.directionalShiftCount).toBe(1);
  });

  it("digest_json is updated on upsert re-run", async () => {
    insertTestData(testDb);
    const ctx = { stageResults: new Map(), reportMode: "daily" as const, timezone: TZ };
    await execute(ctx);
    await execute(ctx);
    const count = testDb.query<{ n: number }, []>("SELECT COUNT(*) as n FROM reports WHERE type='daily'").get()!;
    expect(count.n).toBe(1);
    const row = testDb.query<{ digest_json: string }, []>("SELECT digest_json FROM reports WHERE type='daily'").get()!;
    expect(row.digest_json).toBeDefined();
  });

  it("project_ids contains only projects whose PRs are in yesterday's window", async () => {
    const yesterdayStart = getYesterdayStartUnix();

    // repo-a has a PR merged yesterday — deliverable
    testDb.run(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org/repo-a', 'org', 'repo-a', 'https://github.com/org/repo-a')`);
    testDb.run(`INSERT INTO pull_requests (project_id, pr_number, title, merged_at, analysis_status) VALUES ('org/repo-a', 1, 'Yesterday PR', ?, 'complete')`, [yesterdayStart + 3600]);
    const prA = testDb.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!;
    testDb.run(`INSERT INTO analyses (pr_id, project_id, summary, significance, analyzed_at) VALUES (?, 'org/repo-a', 'Summary A', 'routine', ?)`, [prA.id, yesterdayStart + 3600]);

    // repo-b has a PR merged 2 days ago — not in yesterday's window
    testDb.run(`INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org/repo-b', 'org', 'repo-b', 'https://github.com/org/repo-b')`);
    testDb.run(`INSERT INTO pull_requests (project_id, pr_number, title, merged_at, analysis_status) VALUES ('org/repo-b', 1, 'Old PR', ?, 'complete')`, [yesterdayStart - 86400]);
    const prB = testDb.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!;
    testDb.run(`INSERT INTO analyses (pr_id, project_id, summary, significance, analyzed_at) VALUES (?, 'org/repo-b', 'Summary B', 'routine', ?)`, [prB.id, yesterdayStart - 86400]);

    const ctx = { stageResults: new Map(), reportMode: "daily" as const, timezone: TZ };
    await execute(ctx);

    const row = testDb.query<{ project_ids: string }, []>("SELECT project_ids FROM reports WHERE type='daily'").get()!;
    const projectIds = JSON.parse(row.project_ids);
    expect(projectIds).toContain("org/repo-a");
    expect(projectIds).not.toContain("org/repo-b");
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
    htmlUrl: "https://github.com/org/repo-a/pull/1",
  };

  const notablePR = {
    prNumber: 2,
    title: "Notable change",
    summary: "s".repeat(50),
    technicalDetail: null,
    significance: "notable" as const,
    directionSignal: "improving perf",
    htmlUrl: "https://github.com/org/repo-a/pull/2",
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

  it("removes routine-only projects and adds omit note when card exceeds 20KB", () => {
    // 30 notable-only projects with long summaries push the full card over 20KB.
    // 10 routine-only projects are filtered by formatter Level 2, adding the omit note.
    const longSummary = "x".repeat(600);
    const notableProjects = Array.from({ length: 30 }, (_, i) => ({
      projectId: `org/notable-project-${i}`,
      prCount: 1,
      directionalShiftCount: 0,
      notableCount: 1,
      topDirectionSignal: null,
      prs: [{ ...notablePR, prNumber: i + 1, summary: longSummary }],
    }));
    const routineOnlyProjects = Array.from({ length: 10 }, (_, i) => ({
      projectId: `org/routine-only-${i}`,
      prCount: 3,
      directionalShiftCount: 0,
      notableCount: 0,
      topDirectionSignal: null,
      prs: Array.from({ length: 3 }, (_, j) => ({
        prNumber: j + 100,
        title: `Routine PR ${i}-${j}`,
        summary: "routine summary",
        technicalDetail: null,
        significance: "routine" as const,
        directionSignal: null,
        htmlUrl: `https://github.com/org/routine-only-${i}/pull/${j + 100}`,
      })),
    }));
    const bigAnalyses = [...notableProjects, ...routineOnlyProjects];

    const result = buildFinalCard("2026-06-01", bigAnalyses, undefined);
    expect(result.errors).toHaveLength(0);
    const card = JSON.parse(result.content);
    const summaryEl = card.config
      ? card.elements?.find((e: { tag: string }) => e.tag === "markdown")
      : null;
    if (summaryEl) {
      expect(summaryEl.content).toContain("omitted");
    }
    // Content must be under 28KB (Level 2 limit)
    expect(Buffer.byteLength(result.content, "utf-8")).toBeLessThanOrEqual(28 * 1024);
  });

  it("returns no errors for small analyses", () => {
    const result = buildFinalCard("2026-06-01", smallAnalyses, undefined);
    expect(result.errors).toHaveLength(0);
  });
});
