import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "fs";

const TEST_DB_PATH = "data/test-dispatch-stage.db";
let testDb: Database;

interface MockLarkResponse {
  code: number;
  msg: string;
  data?: { message_id: string };
}

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
const sendCardImpl = mock(async (_url: string, _card: object): Promise<MockLarkResponse> => ({
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
    CREATE TABLE IF NOT EXISTS impact_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_id INTEGER NOT NULL DEFAULT 0,
      analysis_id INTEGER NOT NULL DEFAULT 0,
      target_project_id TEXT NOT NULL DEFAULT 'test/repo',
      relationship TEXT NOT NULL DEFAULT 'fork_of',
      status TEXT NOT NULL DEFAULT 'complete',
      alert_card_json TEXT,
      alert_attempt_count INTEGER NOT NULL DEFAULT 0,
      alert_dispatched_at INTEGER,
      lark_message_id TEXT,
      prompt_version TEXT NOT NULL DEFAULT 'v1',
      config_hash TEXT NOT NULL DEFAULT 'hash'
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
  // report_deliveries are created by report.ts; pre-create here to simulate that contract
  db.run(
    "INSERT INTO report_deliveries (report_id, card_index, content) VALUES (?, 0, ?)",
    [row.id, content]
  );
  return row.id;
}

const ctx = { stageResults: new Map(), reportMode: "daily" as const };

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

  it("marks delivery sent on success and sets report.sent_at", async () => {
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

  it("marks delivery failed when sendCard throws (network error)", async () => {
    sendCardImpl.mockImplementation(async () => { throw new Error("DNS resolution failed"); });
    const reportId = insertReport(testDb);
    const result = await execute(ctx);

    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain("DNS resolution failed");

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

  it("continues processing remaining deliveries after a network throw", async () => {
    let callCount = 0;
    sendCardImpl.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error("timeout");
      return { code: 0, msg: "success", data: { message_id: "msg-002" } };
    });
    const reportId1 = insertReport(testDb);
    const reportId2 = insertReport(testDb);
    const result = await execute(ctx);

    // Second report's delivery should succeed despite first throwing
    const d2 = testDb
      .query<{ status: string }, [number]>(
        "SELECT status FROM report_deliveries WHERE report_id = ?"
      )
      .get(reportId2)!;
    expect(d2.status).toBe("sent");
    expect(result.itemsProcessed).toBe(1);
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

  it("does not re-send deliveries that are already status=sent", async () => {
    const reportId = insertReport(testDb);
    // Simulate a fully-sent state (consistent: delivery=sent + reports.sent_at set)
    testDb.run("UPDATE report_deliveries SET status = 'sent' WHERE report_id = ?", [reportId]);
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

  it("partial multi-card failure: sent card stays sent, failed card keeps report unsent", async () => {
    let callCount = 0;
    sendCardImpl.mockImplementation(async () => {
      callCount++;
      if (callCount === 2) return { code: 99, msg: "webhook error" };
      return { code: 0, msg: "success", data: { message_id: `msg-00${callCount}` } };
    });

    // Insert a report with two delivery rows (simulating a split card scenario)
    const start = ++reportCounter * 1000;
    testDb.run(
      "INSERT INTO reports (type, period_start, period_end, content) VALUES ('daily', ?, ?, ?)",
      [start, start + 86400, '{"header":{}}']
    );
    const row = testDb.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!;
    const reportId = row.id;
    testDb.run(
      "INSERT INTO report_deliveries (report_id, card_index, content) VALUES (?, 0, ?)",
      [reportId, '{"card":0}']
    );
    testDb.run(
      "INSERT INTO report_deliveries (report_id, card_index, content) VALUES (?, 1, ?)",
      [reportId, '{"card":1}']
    );

    const result = await execute(ctx);

    const d0 = testDb
      .query<{ status: string }, [number, number]>(
        "SELECT status FROM report_deliveries WHERE report_id = ? AND card_index = ?"
      )
      .get(reportId, 0)!;
    const d1 = testDb
      .query<{ status: string }, [number, number]>(
        "SELECT status FROM report_deliveries WHERE report_id = ? AND card_index = ?"
      )
      .get(reportId, 1)!;

    expect(d0.status).toBe("sent");
    expect(d1.status).toBe("failed");

    const report = testDb
      .query<{ sent_at: number | null }, [number]>("SELECT sent_at FROM reports WHERE id = ?")
      .get(reportId)!;
    expect(report.sent_at).toBeNull();

    expect(result.success).toBe(false);
    expect(result.itemsProcessed).toBe(1);
  });
});

describe("dispatch stage — alert card retry", () => {
  const CARD_JSON = JSON.stringify({ config: { wide_screen_mode: true }, header: { title: { tag: "plain_text", content: "Test" }, template: "red" }, elements: [] });

  function insertAlertCheck(db: Database, opts: {
    alertCardJson?: string | null;
    alertAttemptCount?: number;
    alertDispatchedAt?: number | null;
  } = {}): number {
    db.run(
      `INSERT INTO impact_checks (alert_card_json, alert_attempt_count, alert_dispatched_at)
       VALUES (?, ?, ?)`,
      [
        opts.alertCardJson === undefined ? CARD_JSON : opts.alertCardJson,
        opts.alertAttemptCount ?? 0,
        opts.alertDispatchedAt ?? null,
      ]
    );
    const row = testDb.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!;
    return row.id;
  }

  beforeEach(() => {
    testDb = makeDb();
    mockWebhookUrl = "https://open.larksuite.com/test";
    sendCardImpl.mockRestore?.();
    sendCardImpl.mockImplementation(async () => ({
      code: 0,
      msg: "success",
      data: { message_id: "alert-msg-001" },
    }));
  });

  afterEach(() => {
    testDb.close();
    try { rmSync(TEST_DB_PATH); } catch { /* ignore */ }
  });

  it("retries a pending alert card and writes alert_dispatched_at", async () => {
    const checkId = insertAlertCheck(testDb, { alertAttemptCount: 0 });
    const result = await execute(ctx);

    expect(result.success).toBe(true);
    expect(result.itemsProcessed).toBe(1);

    const row = testDb.query<{
      alert_dispatched_at: number | null;
      lark_message_id: string | null;
      alert_attempt_count: number;
    }, [number]>(
      "SELECT alert_dispatched_at, lark_message_id, alert_attempt_count FROM impact_checks WHERE id = ?"
    ).get(checkId)!;

    expect(row.alert_dispatched_at).not.toBeNull();
    expect(row.lark_message_id).toBe("alert-msg-001");
    expect(row.alert_attempt_count).toBe(1);
  });

  it("does not retry when alert_attempt_count >= 5 (dead-letter)", async () => {
    insertAlertCheck(testDb, { alertAttemptCount: 5 });
    const result = await execute(ctx);

    expect(result.itemsProcessed).toBe(0);
    expect(sendCardImpl).not.toHaveBeenCalled();
  });

  it("increments attempt_count on Lark error response without setting dispatched_at", async () => {
    sendCardImpl.mockImplementation(async () => ({ code: 99, msg: "webhook error" }));
    const checkId = insertAlertCheck(testDb, { alertAttemptCount: 2 });
    const result = await execute(ctx);

    expect(result.success).toBe(false);

    const row = testDb.query<{
      alert_dispatched_at: number | null;
      alert_attempt_count: number;
    }, [number]>(
      "SELECT alert_dispatched_at, alert_attempt_count FROM impact_checks WHERE id = ?"
    ).get(checkId)!;

    expect(row.alert_dispatched_at).toBeNull();
    expect(row.alert_attempt_count).toBe(3);
  });

  it("increments attempt_count when sendCard throws (network error)", async () => {
    sendCardImpl.mockImplementation(async () => { throw new Error("DNS failed"); });
    const checkId = insertAlertCheck(testDb, { alertAttemptCount: 1 });
    const result = await execute(ctx);

    expect(result.success).toBe(false);

    const row = testDb.query<{ alert_attempt_count: number }, [number]>(
      "SELECT alert_attempt_count FROM impact_checks WHERE id = ?"
    ).get(checkId)!;

    expect(row.alert_attempt_count).toBe(2);
  });

  it("does not retry and does not increment when dispatchEnabled=false", async () => {
    const checkId = insertAlertCheck(testDb, { alertAttemptCount: 0 });
    const suppressedCtx = { stageResults: new Map(), reportMode: "daily" as const, dispatchEnabled: false };
    await execute(suppressedCtx);

    expect(sendCardImpl).not.toHaveBeenCalled();

    const row = testDb.query<{ alert_attempt_count: number; alert_dispatched_at: number | null }, [number]>(
      "SELECT alert_attempt_count, alert_dispatched_at FROM impact_checks WHERE id = ?"
    ).get(checkId)!;

    expect(row.alert_attempt_count).toBe(0);
    expect(row.alert_dispatched_at).toBeNull();
  });

  it("skips all alert retries when webhook is not configured", async () => {
    mockWebhookUrl = undefined;
    const checkId = insertAlertCheck(testDb, { alertAttemptCount: 0 });
    const result = await execute(ctx);

    expect(result.itemsProcessed).toBe(0);
    expect(sendCardImpl).not.toHaveBeenCalled();

    const row = testDb.query<{ alert_attempt_count: number; alert_dispatched_at: number | null }, [number]>(
      "SELECT alert_attempt_count, alert_dispatched_at FROM impact_checks WHERE id = ?"
    ).get(checkId)!;
    expect(row.alert_attempt_count).toBe(0);
    expect(row.alert_dispatched_at).toBeNull();
  });

  it("does not retry already-dispatched alerts", async () => {
    insertAlertCheck(testDb, {
      alertAttemptCount: 1,
      alertDispatchedAt: Math.floor(Date.now() / 1000),
    });
    const result = await execute(ctx);

    expect(result.itemsProcessed).toBe(0);
    expect(sendCardImpl).not.toHaveBeenCalled();
  });

  it("does not retry rows without alert_card_json", async () => {
    insertAlertCheck(testDb, { alertCardJson: null });
    const result = await execute(ctx);

    expect(result.itemsProcessed).toBe(0);
    expect(sendCardImpl).not.toHaveBeenCalled();
  });

  it("surfaces non-legacy scan errors in stage result", async () => {
    // Recreate the table with the PK named `check_id` instead of `id`.
    // The query does `SELECT id, ...` → "no such column: id" is NOT in the
    // legacy-schema suppression list, so the stage result must reflect failure.
    testDb.exec("DROP TABLE impact_checks");
    testDb.exec(`
      CREATE TABLE impact_checks (
        check_id INTEGER PRIMARY KEY AUTOINCREMENT,
        alert_card_json TEXT,
        alert_dispatched_at INTEGER,
        alert_attempt_count INTEGER NOT NULL DEFAULT 0
      )
    `);

    const result = await execute(ctx);

    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.includes("Alert scan failed"))).toBe(true);
    expect(sendCardImpl).not.toHaveBeenCalled();
  });
});
