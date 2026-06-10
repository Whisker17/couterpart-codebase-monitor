import { Database } from "bun:sqlite";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import type { StageResult } from "../src/pipeline/runner";
import type { CollectDeps, CollectOptions } from "../src/pipeline/stages/collect";
import type { DailyReportData, DailyDigest } from "../src/extensions/report-generator/daily";
import type { DailyPromptReportResult } from "../src/extensions/report-generator/daily-prompt-report";
import { getDayPeriod } from "../src/utils/time-window";
import { runBackfill } from "./backfill";
import type { BackfillDeps } from "./backfill";

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
const DAY_MID = DAY_START + 3600;

function makeTestDeps(db: Database, overrides?: Partial<BackfillDeps>): BackfillDeps {
  const defaultReportData = (startUnix: number, endUnix: number): DailyReportData => {
    const digest: DailyDigest = {
      periodStart: startUnix,
      periodEnd: endUnix,
      projects: [],
      activitySummary: { totalPrs: 0, directionalShiftCount: 0, notableCount: 0 },
    };
    return { analyses: [], grouped: [], periodStartUnix: startUnix, periodEndUnix: endUnix, digest };
  };

  const defaultPromptReport = async (
    _db: Database,
    timezone: string,
    startUnix: number,
    endUnix: number
  ): Promise<DailyPromptReportResult> => ({
    markdown: "## 总览\n\nBackfill prompt report.",
    promptPath: "prompts/reports/daily/structured-table.md",
    promptName: "structured-table",
    usage: { inputTokens: 1, outputTokens: 2 },
    input: {
      period: {
        startUnix,
        endUnix,
        date: DAY,
        label: DAY,
        timezone,
      },
      activitySummary: {
        totalPrs: 1,
        projectCount: 1,
        directionalShiftCount: 0,
        notableCount: 0,
        routineCount: 1,
      },
      projects: [
        {
          projectId: "org/repo",
          prCount: 1,
          directionalShiftCount: 0,
          notableCount: 0,
          routineCount: 1,
          topSignals: [],
          prs: [
            {
              prNumber: 1,
              title: "Complete PR",
              htmlUrl: "https://github.com/org/repo/pull/1",
              mergedAt: startUnix + 3600,
              filesChanged: null,
              additions: null,
              deletions: null,
              summary: "Backfill prompt summary",
              technicalDetail: null,
              directionSignal: null,
              significance: "routine",
              categories: [],
            },
          ],
        },
      ],
    },
  });

  return {
    timezone: "UTC",
    db,
    collectExecute: async (_ctx, _deps, _options): Promise<StageResult> => ({
      success: true,
      itemsProcessed: 0,
      errors: [],
      durationMs: 0,
      failedProjects: [],
    }),
    analyzeExecute: async (_ctx, _options): Promise<StageResult> => ({
      success: true,
      itemsProcessed: 0,
      errors: [],
      durationMs: 0,
    }),
    collectDeps: {} as unknown as CollectDeps,
    getTrackedProjects: () => [{ org: "org", repo: "repo", url: "https://github.com/org/repo" }],
    buildDailyReportForPeriod: defaultReportData,
    generateDailyPromptReportForPeriod: defaultPromptReport,
    buildDailyPromptCard: (input) => ({
      config: { wide_screen_mode: true },
      header: { title: { tag: "plain_text", content: `Counterpart 日报 · ${input.date}` }, template: "blue" },
      elements: [{ tag: "markdown", content: input.markdown }],
    }),
    writeReportFile: () => "data/reports/test.json",
    ...overrides,
  };
}

describe("backfill script", () => {
  let testDb: Database;

  beforeEach(() => {
    testDb = new Database(":memory:");
    applySchema(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  // --- Timezone source ---

  it("uses timezone from getSettings().schedule.timezone for day boundary computation", async () => {
    const tz = "America/New_York";
    let capturedOpts: CollectOptions | undefined;

    const deps = makeTestDeps(testDb, {
      timezone: tz,
      collectExecute: async (_ctx, _deps, options): Promise<StageResult> => {
        capturedOpts = options;
        return { success: true, itemsProcessed: 0, errors: [], durationMs: 0, failedProjects: [] };
      },
    });

    await runBackfill("2026-01-01", "2026-01-01", false, deps);

    const { startUnix: expectedStart } = getDayPeriod(tz, "2026-01-01");
    const { startUnix: utcStart } = getDayPeriod("UTC", "2026-01-01");

    expect(capturedOpts?.dateRangeOverride?.startUnix).toBe(expectedStart);
    expect(capturedOpts?.dateRangeOverride?.startUnix).not.toBe(utcStart);
  });

  // --- Phase 2: reset step ---

  it("resets failed and budget_skipped PRs in range to pending before analyze", async () => {
    const outsideDay = DAY_START - 86400;
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

    await runBackfill(DAY, DAY, true, makeTestDeps(testDb));

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

    await runBackfill(DAY, DAY, true, makeTestDeps(testDb));

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
    const deps = makeTestDeps(testDb, {
      collectExecute: async (): Promise<StageResult> => ({
        success: false,
        itemsProcessed: 0,
        errors: ["GitHub API error"],
        durationMs: 0,
        failedProjects: ["org/repo"],
      }),
    });

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

    const result = await runBackfill(DAY, DAY, false, deps);

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

    const sentCnt = testDb
      .query<{ cnt: number }, []>(
        "SELECT COUNT(*) as cnt FROM report_deliveries WHERE status = 'sent'"
      )
      .get()!;
    expect(sentCnt.cnt).toBe(1);
  });

  // --- Stale delivery cleanup ---

  it("deletes pending and failed deliveries but preserves sent after report generation", async () => {
    testDb.run(
      `INSERT INTO pull_requests (project_id, pr_number, title, merged_at, analysis_status)
       VALUES ('org/repo', 1, 'Complete PR', ${DAY_MID}, 'complete')`
    );
    const prRow = testDb.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!;
    testDb.run(
      `INSERT INTO analyses (pr_id, project_id, summary, significance)
       VALUES (${prRow.id}, 'org/repo', 'Test summary', 'routine')`
    );

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

    await runBackfill(DAY, DAY, false, makeTestDeps(testDb));

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
    await runBackfill(DAY, DAY, false, makeTestDeps(testDb));

    const report = testDb
      .query<{ content: string; project_ids: string; digest_json: string | null }, []>(
        "SELECT content, project_ids, digest_json FROM reports WHERE type = 'daily'"
      )
      .get();
    expect(report).not.toBeNull();
    expect(report!.content).toBe("null");
    expect(report!.project_ids).toBe("[]");
    expect(report!.digest_json).not.toBeNull();
    const digest = JSON.parse(report!.digest_json!);
    expect(digest.projects).toEqual([]);
    expect(digest.activitySummary.totalPrs).toBe(0);
  });

  it("writes null content and NULL digest_json for partial empty day", async () => {
    testDb.run(
      `INSERT INTO pull_requests (project_id, pr_number, title, merged_at, analysis_status)
       VALUES ('org/repo', 1, 'Pending PR', ${DAY_MID}, 'pending')`
    );

    await runBackfill(DAY, DAY, true, makeTestDeps(testDb));

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
    const deps = makeTestDeps(testDb, {
      collectExecute: async (): Promise<StageResult> => ({
        success: false,
        itemsProcessed: 0,
        errors: ["API error"],
        durationMs: 0,
        failedProjects: [],
      }),
    });

    await runBackfill(DAY, DAY, true, deps);

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
    let capturedOpts: CollectOptions | undefined;

    const deps = makeTestDeps(testDb, {
      collectExecute: async (_ctx, _deps, options): Promise<StageResult> => {
        capturedOpts = options;
        return { success: true, itemsProcessed: 0, errors: [], durationMs: 0, failedProjects: [] };
      },
    });

    await runBackfill(DAY, DAY, false, deps);

    expect(capturedOpts?.skipSyncUpdate).toBe(true);
    expect(capturedOpts?.dateRangeOverride?.startUnix).toBe(DAY_START);
    expect(capturedOpts?.dateRangeOverride?.endUnix).toBe(DAY_END);
  });
});
