import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "fs";

const TEST_DB_PATH = "data/test-dispatch-stage.db";
let testDb: Database;

// --- mock db ---
mock.module("../../storage/db", () => ({
  getDb: () => testDb,
}));

// --- mock settings ---
let mockWebhookUrl: string | undefined = "https://open.larksuite.com/test";
mock.module("../../config/settings", () => ({
  getSettings: () => ({
    lark: { webhookUrl: mockWebhookUrl },
  }),
}));

// --- mock sendCard via a stable wrapper so we can change behaviour per-test ---
const sendCardImpl = mock(async (_url: string, _card: object) => ({
  code: 0,
  msg: "success",
  data: { message_id: "msg-001" },
}));

mock.module("../../extensions/lark-dispatcher/webhook", () => ({
  sendCard: (...args: Parameters<typeof sendCardImpl>) => sendCardImpl(...args),
}));

const { execute } = await import("./dispatch");

let reportCounter = 0;

function makeDb(): Database {
  const db = new Database(TEST_DB_PATH);
  db.exec(`
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
    CREATE TABLE IF NOT EXISTS report_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id INTEGER NOT NULL REFERENCES reports(id),
      card_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      lark_message_id TEXT,
      status TEXT CHECK(status IN ('pending', 'sent', 'failed')) DEFAULT 'pending',
      sent_at INTEGER,
      UNIQUE(report_id, card_index)
    );
  `);
  return db;
}

function insertReport(db: Database, content = '{"header":{}}'): number {
  const start = ++reportCounter * 1000;
  db.run(
    "INSERT INTO reports (type, period_start, period_end, content) VALUES ('daily', ?, ?, ?)",
    [start, start + 86400, content]
  );
  const row = db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!;
  return row.id;
}

const ctx = { stageResults: new Map(), isWeeklyRun: false };

beforeEach(() => {
  testDb = makeDb();
  mockWebhookUrl = "https://open.larksuite.com/test";
  sendCardImpl.mockRestore?.();
  // reset to success default
  sendCardImpl.mockImplementation(async () => ({
    code: 0,
    msg: "success",
    data: { message_id: "msg-001" },
  }));
});

afterEach(() => {
  testDb.close();
  try { rmSync(TEST_DB_PATH); } catch { /* ignore */ }
});

describe("dispatch stage", () => {
  it("skips gracefully when LARK_WEBHOOK_URL is missing", async () => {
    mockWebhookUrl = undefined;
    insertReport(testDb);
    const result = await execute(ctx);
    expect(result.success).toBe(true);
    expect(result.itemsProcessed).toBe(0);
    expect(sendCardImpl).not.toHaveBeenCalled();
  });

  it("creates delivery row and marks sent on success", async () => {
    const reportId = insertReport(testDb);
    const result = await execute(ctx);

    expect(result.success).toBe(true);
    expect(result.itemsProcessed).toBe(1);

    const delivery = testDb
      .query<{ status: string; lark_message_id: string }, [number]>(
        "SELECT status, lark_message_id FROM report_deliveries WHERE report_id = ?"
      )
      .get(reportId)!;
    expect(delivery.status).toBe("sent");
    expect(delivery.lark_message_id).toBe("msg-001");

    const report = testDb
      .query<{ sent_at: number | null }, [number]>("SELECT sent_at FROM reports WHERE id = ?")
      .get(reportId)!;
    expect(report.sent_at).not.toBeNull();
  });

  it("marks delivery failed and keeps report unsent on Lark error", async () => {
    sendCardImpl.mockImplementation(async () => ({ code: 99, msg: "webhook error" }));
    const reportId = insertReport(testDb);
    const result = await execute(ctx);

    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);

    const delivery = testDb
      .query<{ status: string }, [number]>(
        "SELECT status FROM report_deliveries WHERE report_id = ?"
      )
      .get(reportId)!;
    expect(delivery.status).toBe("failed");

    const report = testDb
      .query<{ sent_at: number | null }, [number]>("SELECT sent_at FROM reports WHERE id = ?")
      .get(reportId)!;
    expect(report.sent_at).toBeNull();
  });

  it("does not re-send already sent deliveries (idempotent)", async () => {
    const reportId = insertReport(testDb);
    // First run
    await execute(ctx);
    const callsAfterFirst = sendCardImpl.mock.calls.length;

    // Second run — report is now sent_at IS NOT NULL, so it's skipped
    await execute(ctx);
    expect(sendCardImpl.mock.calls.length).toBe(callsAfterFirst);
  });

  it("does not process reports that already have sent_at", async () => {
    const reportId = insertReport(testDb);
    testDb.run("UPDATE reports SET sent_at = 9999 WHERE id = ?", [reportId]);

    const result = await execute(ctx);
    expect(result.itemsProcessed).toBe(0);
    expect(sendCardImpl).not.toHaveBeenCalled();
  });

  it("processes multiple unsent reports", async () => {
    insertReport(testDb, '{"header":{"a":1}}');
    insertReport(testDb, '{"header":{"b":2}}');
    const result = await execute(ctx);

    expect(result.success).toBe(true);
    expect(result.itemsProcessed).toBe(2);
  });
});
