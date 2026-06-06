import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "fs";
import type { StageResult } from "../src/pipeline/runner";
import { getDayPeriod } from "../src/utils/time-window";

const TEST_DB_PATH = "data/test-backfill.db";
let testDb: Database;

// --- Module mocks (must be declared before await import) ---

const defaultSettings = {
  schedule: { timezone: "UTC", dailyCron: "0 0 * * *", weeklyCron: "0 0 * * 0" },
  llm: { model: "test", baseUrl: "", apiKey: "", maxTokensPerCall: 1000, diffTokenBudget: 1000, maxManifestEntries: 10 },
  lark: { webhookUrl: undefined },
  github: { token: "" },
  budget: { monthlyCap: 10, warningThreshold: 0.8, cutoffThreshold: 1.0 },
};

const mockGetSettings = mock(() => ({ ...defaultSettings }));

mock.module("../src/config/settings", () => ({
  getSettings: mockGetSettings,
  validateEnv: () => {},
  _resetSettingsCache: () => {},
  _setSettingsConfigPath: () => {},
}));

mock.module("../src/storage/db", () => ({
  getDb: () => testDb,
  closeDb: () => {},
}));

const mockCollectExecute = mock(
  async (_ctx: unknown, _deps: unknown, _options: unknown): Promise<StageResult> => ({
    success: true,
    itemsProcessed: 0,
    errors: [],
    durationMs: 0,
    failedProjects: [],
  })
);

mock.module("../src/pipeline/stages/collect", () => ({
  execute: mockCollectExecute,
}));

const mockAnalyzeExecute = mock(
  async (_ctx: unknown, _options: unknown): Promise<StageResult> => ({
    success: true,
    itemsProcessed: 0,
    errors: [],
    durationMs: 0,
  })
);

mock.module("../src/pipeline/stages/analyze", () => ({
  execute: mockAnalyzeExecute,
}));

const mockWriteReportFile = mock((_content: unknown) => "data/reports/test.json");
mock.module("../src/extensions/report-generator/file-writer", () => ({
  writeReportFile: mockWriteReportFile,
}));

mock.module("../src/config/projects", () => ({
  getTrackedProjects: () => [
    { org: "org", repo: "repo", url: "https://github.com/org/repo" },
  ],
  getMantleConfig: () => ({ mantleTargets: [], counterpartRelationships: [] }),
  reloadTrackedProjects: () => ({ projects: [], prevProjects: null }),
}));

// Import after all mocks are registered
const { runBackfill } = await import("./backfill");

// --- DB schema helpers ---

function applySchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, org TEXT NOT NULL, repo TEXT NOT NULL, url TEXT NOT NULL,
      description TEXT, language TEXT, topics TEXT, overview TEXT,
      active INTEGER NOT NULL DEFAULT 1, last_synced_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS pull_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL, pr_number INTEGER NOT NULL, title TEXT NOT NULL,
      body TEXT, author TEXT, merged_at INTEGER,
      files_changed INTEGER, additions INTEGER, deletions INTEGER,
      diff_path TEXT, diff_status TEXT DEFAULT 'missing',
      analysis_status TEXT DEFAULT 'pending',
      retry_count INTEGER DEFAULT 0, last_error TEXT,
      fetched_at INTEGER DEFAULT (unixepoch()),
      UNIQUE(project_id, pr_number)
    );
    CREATE TABLE IF NOT EXISTS analyses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_id INTEGER NOT NULL, project_id TEXT NOT NULL,
      summary TEXT NOT NULL, technical_detail TEXT, direction_signal TEXT,
      significance TEXT, categories TEXT, model_id TEXT,
      input_tokens INTEGER, output_tokens INTEGER, estimated_cost_usd REAL,
      analyzed_at INTEGER DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT, period_start INTEGER NOT NULL, period_end INTEGER NOT NULL,
      project_ids TEXT, content TEXT NOT NULL, completeness TEXT,
      digest_json TEXT, sent_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch()),
      UNIQUE(type, period_start, period_end)
    );
    CREATE TABLE IF NOT EXISTS report_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id INTEGER NOT NULL, card_index INTEGER NOT NULL,
      content TEXT NOT NULL, lark_message_id TEXT,
      status TEXT DEFAULT 'pending', sent_at INTEGER,
      UNIQUE(report_id, card_index)
    );
  `);
  db.run(
    "INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES ('org/repo', 'org', 'repo', 'https://github.com/org/repo')"
  );
}

// 2026-05-15 UTC boundaries (pre-computed for test clarity)
const DAY = "2026-05-15";
const { startUnix: DAY_START, endUnix: DAY_END } = getDayPeriod("UTC", DAY);
const DAY_MID = DAY_START + 3600; // one hour into the day

describe("backfill script", () => {
  beforeEach(() => {
    testDb = new Database(TEST_DB_PATH);
    applySchema(testDb);

    mockCollectExecute.mockClear();
    mockAnalyzeExecute.mockClear();
    mockWriteReportFile.mockClear();

    mockGetSettings.mockImplementation(() => ({
      ...defaultSettings,
      schedule: { ...defaultSettings.schedule, timezone: "UTC" },
    }));
    mockCollectExecute.mockImplementation(
      async (_ctx, _deps, _options): Promise<StageResult> => ({
        success: true, itemsProcessed: 0, errors: [], durationMs: 0, failedProjects: [],
      })
    );
    mockAnalyzeExecute.mockImplementation(
      async (_ctx, _options): Promise<StageResult> => ({
        success: true, itemsProcessed: 0, errors: [], durationMs: 0,
      })
    );
  });

  afterEach(() => {
    testDb.close();
    try { rmSync(TEST_DB_PATH); } catch { /* ignore */ }
  });

  // --- Timezone source ---

  it("uses timezone from getSettings().schedule.timezone for day boundary computation", async () => {
    const tz = "America/New_York";
    mockGetSettings.mockImplementation(() => ({
      ...defaultSettings,
      schedule: { ...defaultSettings.schedule, timezone: tz },
    }));

    await runBackfill("2026-01-01", "2026-01-01", false);

    expect(mockCollectExecute).toHaveBeenCalledTimes(1);
    const collectCall = mockCollectExecute.mock.calls[0]!;
    const opts = collectCall[2] as { dateRangeOverride: { startUnix: number; endUnix: number } };

    const { startUnix: expectedStart } = getDayPeriod(tz, "2026-01-01");
    const { startUnix: utcStart } = getDayPeriod("UTC", "2026-01-01");

    // The collect call should use the timezone-correct boundary, not UTC
    expect(opts.dateRangeOverride.startUnix).toBe(expectedStart);
    expect(opts.dateRangeOverride.startUnix).not.toBe(utcStart);
  });

  // --- Phase 2: reset step ---

  it("resets failed and budget_skipped PRs in range to pending before analyze", async () => {
    const outsideDay = DAY_START - 86400; // previous day
    const outsideMid = outsideDay + 3600;

    testDb.run(
      `INSERT INTO pull_requests (project_id, pr_number, title, merged_at, analysis_status, retry_count)
       VALUES ('org/repo', 1, 'Failed PR', ${DAY_MID}, 'failed', 3)`
    );
    testDb.run(
      `INSERT INTO pull_requests (project_id, pr_number, title, merged_at, analysis_status, retry_count)
       VALUES ('org/repo', 2, 'Budget skipped PR', ${DAY_MID}, 'budget_skipped', 0)`
    );
    testDb.run(
      `INSERT INTO pull_requests (project_id, pr_number, title, merged_at, analysis_status, retry_count)
       VALUES ('org/repo', 3, 'Out-of-range failed PR', ${outsideMid}, 'failed', 1)`
    );

    await runBackfill(DAY, DAY, true); // allow-partial so we don't bail on analyze

    const pr1 = testDb
      .query<{ analysis_status: string; retry_count: number }, []>(
        "SELECT analysis_status, retry_count FROM pull_requests WHERE pr_number = 1"
      )
      .get()!;
    expect(pr1.analysis_status).toBe("pending");
    expect(pr1.retry_count).toBe(0);

    const pr2 = testDb
      .query<{ analysis_status: string; retry_count: number }, []>(
        "SELECT analysis_status, retry_count FROM pull_requests WHERE pr_number = 2"
      )
      .get()!;
    expect(pr2.analysis_status).toBe("pending");
    expect(pr2.retry_count).toBe(0);

    // Out-of-range PR must remain unchanged
    const pr3 = testDb
      .query<{ analysis_status: string; retry_count: number }, []>(
        "SELECT analysis_status, retry_count FROM pull_requests WHERE pr_number = 3"
      )
      .get()!;
    expect(pr3.analysis_status).toBe("failed");
    expect(pr3.retry_count).toBe(1);
  });

  // --- Partial NULL digest ---

  it("writes NULL digest_json when allow-partial and day has incomplete PRs", async () => {
    testDb.run(
      `INSERT INTO pull_requests (project_id, pr_number, title, merged_at, analysis_status)
       VALUES ('org/repo', 1, 'Pending PR', ${DAY_MID}, 'pending')`
    );

    await runBackfill(DAY, DAY, true);

    const report = testDb
      .query<{ digest_json: string | null }, []>(
        "SELECT digest_json FROM reports WHERE type = 'daily'"
      )
      .get();
    expect(report).not.toBeNull();
    expect(report!.digest_json).toBeNull();
  });

  // --- Collect failure cleanup ---

  it("nullifies all day digests and deletes unsent deliveries on collect failure (no allow-partial)", async () => {
    mockCollectExecute.mockImplementation(async () => ({
      success: false,
      itemsProcessed: 0,
      errors: ["GitHub API error"],
      durationMs: 0,
      failedProjects: ["org/repo"],
    }));

    // Pre-existing report with pending and sent deliveries
    testDb.run(
      `INSERT INTO reports (type, period_start, period_end, content, digest_json)
       VALUES ('daily', ${DAY_START}, ${DAY_END}, 'null', '{"old":true}')`
    );
    const reportRow = testDb
      .query<{ id: number }, []>("SELECT last_insert_rowid() as id")
      .get()!;
    testDb.run(
      `INSERT INTO report_deliveries (report_id, card_index, content, status)
       VALUES (${reportRow.id}, 0, 'pending-card', 'pending')`
    );
    testDb.run(
      `INSERT INTO report_deliveries (report_id, card_index, content, status)
       VALUES (${reportRow.id}, 1, 'sent-card', 'sent')`
    );

    const result = await runBackfill(DAY, DAY, false);

    expect(result.anySkipped).toBe(true);

    const report = testDb
      .query<{ digest_json: string | null }, []>(
        "SELECT digest_json FROM reports WHERE type = 'daily'"
      )
      .get()!;
    expect(report.digest_json).toBeNull();

    const pendingCnt = testDb
      .query<{ cnt: number }, []>(
        "SELECT COUNT(*) as cnt FROM report_deliveries WHERE status = 'pending'"
      )
      .get()!;
    expect(pendingCnt.cnt).toBe(0);

    // sent delivery preserved
    const sentCnt = testDb
      .query<{ cnt: number }, []>(
        "SELECT COUNT(*) as cnt FROM report_deliveries WHERE status = 'sent'"
      )
      .get()!;
    expect(sentCnt.cnt).toBe(1);
  });

  // --- Stale delivery cleanup ---

  it("deletes pending and failed deliveries but preserves sent after report generation", async () => {
    // Complete PR so the day passes the completeness gate
    testDb.run(
      `INSERT INTO pull_requests (project_id, pr_number, title, merged_at, analysis_status)
       VALUES ('org/repo', 1, 'Complete PR', ${DAY_MID}, 'complete')`
    );
    const prRow = testDb.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!;
    testDb.run(
      `INSERT INTO analyses (pr_id, project_id, summary, significance)
       VALUES (${prRow.id}, 'org/repo', 'Test summary', 'routine')`
    );

    // Pre-existing report with all three delivery statuses
    testDb.run(
      `INSERT INTO reports (type, period_start, period_end, content, project_ids, completeness)
       VALUES ('daily', ${DAY_START}, ${DAY_END}, 'null', '[]', '{}')`
    );
    const reportRow = testDb.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!;
    testDb.run(
      `INSERT INTO report_deliveries (report_id, card_index, content, status)
       VALUES (${reportRow.id}, 0, 'pending-card', 'pending')`
    );
    testDb.run(
      `INSERT INTO report_deliveries (report_id, card_index, content, status)
       VALUES (${reportRow.id}, 1, 'failed-card', 'failed')`
    );
    testDb.run(
      `INSERT INTO report_deliveries (report_id, card_index, content, status)
       VALUES (${reportRow.id}, 2, 'sent-card', 'sent')`
    );

    await runBackfill(DAY, DAY, false);

    const unsent = testDb
      .query<{ cnt: number }, []>(
        "SELECT COUNT(*) as cnt FROM report_deliveries WHERE status IN ('pending', 'failed')"
      )
      .get()!;
    expect(unsent.cnt).toBe(0);

    const sent = testDb
      .query<{ cnt: number }, []>(
        "SELECT COUNT(*) as cnt FROM report_deliveries WHERE status = 'sent'"
      )
      .get()!;
    expect(sent.cnt).toBe(1);
  });

  // --- Empty day behaviour ---

  it("writes null content and non-null empty digest for complete empty day", async () => {
    // No PRs inserted → empty day, complete
    await runBackfill(DAY, DAY, false);

    const report = testDb
      .query<{ content: string; project_ids: string; digest_json: string | null }, []>(
        "SELECT content, project_ids, digest_json FROM reports WHERE type = 'daily'"
      )
      .get();
    expect(report).not.toBeNull();
    expect(report!.content).toBe("null");
    expect(report!.project_ids).toBe("[]");
    // digest_json must be a non-null JSON string with empty projects array
    expect(report!.digest_json).not.toBeNull();
    const digest = JSON.parse(report!.digest_json!);
    expect(digest.projects).toEqual([]);
    expect(digest.activitySummary.totalPrs).toBe(0);
  });

  it("writes null content and NULL digest_json for partial empty day", async () => {
    // PR in range but pending (no analysis) → empty grouped, incomplete
    testDb.run(
      `INSERT INTO pull_requests (project_id, pr_number, title, merged_at, analysis_status)
       VALUES ('org/repo', 1, 'Pending PR', ${DAY_MID}, 'pending')`
    );

    await runBackfill(DAY, DAY, true);

    const report = testDb
      .query<{ content: string; project_ids: string; digest_json: string | null }, []>(
        "SELECT content, project_ids, digest_json FROM reports WHERE type = 'daily'"
      )
      .get();
    expect(report).not.toBeNull();
    expect(report!.content).toBe("null");
    expect(report!.project_ids).toBe("[]");
    expect(report!.digest_json).toBeNull();
  });

  // --- Collect failure + allow-partial ---

  it("marks collectionIncomplete in completeness and proceeds when collect fails with allow-partial", async () => {
    mockCollectExecute.mockImplementation(async () => ({
      success: false,
      itemsProcessed: 0,
      errors: ["API error"],
      durationMs: 0,
      failedProjects: [],
    }));

    await runBackfill(DAY, DAY, true);

    const report = testDb
      .query<{ completeness: string }, []>(
        "SELECT completeness FROM reports WHERE type = 'daily'"
      )
      .get();
    expect(report).not.toBeNull();
    const completeness = JSON.parse(report!.completeness);
    expect(completeness.collectionIncomplete).toBe(true);
    expect(completeness.status).toBe("partial");
  });

  // --- skipSyncUpdate is passed to collect ---

  it("calls collect with skipSyncUpdate=true and the full date range", async () => {
    await runBackfill(DAY, DAY, false);

    expect(mockCollectExecute).toHaveBeenCalledTimes(1);
    const opts = mockCollectExecute.mock.calls[0]![2] as {
      dateRangeOverride: { startUnix: number; endUnix: number };
      skipSyncUpdate: boolean;
    };
    expect(opts.skipSyncUpdate).toBe(true);
    expect(opts.dateRangeOverride.startUnix).toBe(DAY_START);
    expect(opts.dateRangeOverride.endUnix).toBe(DAY_END);
  });
});
