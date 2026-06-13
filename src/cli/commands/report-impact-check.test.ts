import { describe, it, expect, mock, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";

// --- mock db ---
let testDb: Database;
mock.module("../../storage/db", () => ({
  getDb: () => testDb,
}));

// --- mock settings ---
let mockWebhookUrl: string | undefined = "https://open.larksuite.com/test";
mock.module("../../config/settings", () => ({
  getSettings: () => ({
    lark: { webhookUrl: mockWebhookUrl },
    schedule: { timezone: "UTC" },
  }),
}));

// --- mock LLM-dependent report-generator modules (transitively import 'ai' which is not installed) ---
mock.module("../../extensions/report-generator/daily-prompt-report", () => ({
  DEFAULT_DAILY_PROMPT_PATH: "prompts/reports/daily/structured-table.md",
  generateDailyPromptReportForPeriod: mock(async () => { throw new Error("not mocked"); }),
  generateDailyPromptReport: mock(async () => { throw new Error("not mocked"); }),
}));
mock.module("../../extensions/report-generator/weekly-prompt-report", () => ({
  generateWeeklyPromptReport: mock(async () => { throw new Error("not mocked"); }),
}));
mock.module("../../extensions/report-generator/monthly-prompt-report", () => ({
  generateMonthlyPromptReport: mock(async () => { throw new Error("not mocked"); }),
}));

// --- mock sendCard via a stable wrapper so we can change behaviour per-test ---
interface MockLarkResponse {
  code: number;
  msg: string;
  data?: { message_id: string };
}
const sendCardImpl = mock(async (_url: string, _card: object): Promise<MockLarkResponse> => ({
  code: 0,
  msg: "success",
  data: { message_id: "redispatch-msg-001" },
}));

mock.module("../../extensions/lark-dispatcher/webhook", () => ({
  sendCard: (...args: Parameters<typeof sendCardImpl>) => sendCardImpl(...args),
}));

const { redispatchCommand } = await import("./report");

const CARD_JSON = JSON.stringify({ config: { wide_screen_mode: true }, header: { template: "red" }, elements: [] });

function createDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE impact_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_id INTEGER NOT NULL DEFAULT 0,
      target_project_id TEXT NOT NULL DEFAULT 'test/repo',
      affected TEXT,
      confidence TEXT,
      alert_card_json TEXT,
      alert_dispatched_at INTEGER,
      alert_attempt_count INTEGER NOT NULL DEFAULT 0,
      lark_message_id TEXT,
      checked_at INTEGER,
      status TEXT NOT NULL DEFAULT 'complete'
    );
  `);
  return db;
}

function insertCheck(
  db: Database,
  opts: {
    alertCardJson?: string | null;
    alertAttemptCount?: number;
    alertDispatchedAt?: number | null;
    affected?: string;
    confidence?: string;
  } = {}
): number {
  db.run(
    `INSERT INTO impact_checks (alert_card_json, alert_attempt_count, alert_dispatched_at, affected, confidence)
     VALUES (?, ?, ?, ?, ?)`,
    [
      opts.alertCardJson === undefined ? CARD_JSON : opts.alertCardJson,
      opts.alertAttemptCount ?? 0,
      opts.alertDispatchedAt ?? null,
      opts.affected ?? "yes",
      opts.confidence ?? "high",
    ]
  );
  const row = testDb.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!;
  return row.id;
}

beforeEach(() => {
  testDb = createDb();
  mockWebhookUrl = "https://open.larksuite.com/test";
  sendCardImpl.mockRestore?.();
  sendCardImpl.mockImplementation(async () => ({
    code: 0,
    msg: "success",
    data: { message_id: "redispatch-msg-001" },
  }));
});

describe("redispatchCommand --impact-check", () => {
  it("dry-run returns 0 without mutating the DB or sending", async () => {
    const id = insertCheck(testDb, { alertAttemptCount: 3, alertDispatchedAt: 1000 });
    const code = await redispatchCommand(
      [],
      { "impact-check": String(id) },
      { json: false, verbose: false }
    );
    expect(code).toBe(0);
    expect(sendCardImpl).not.toHaveBeenCalled();

    const row = testDb
      .query<{ alert_attempt_count: number; alert_dispatched_at: number | null }, [number]>(
        "SELECT alert_attempt_count, alert_dispatched_at FROM impact_checks WHERE id = ?"
      )
      .get(id)!;
    // unchanged
    expect(row.alert_attempt_count).toBe(3);
    expect(row.alert_dispatched_at).toBe(1000);
  });

  it("--yes resets state, sends card, writes dispatched_at and lark_message_id", async () => {
    const id = insertCheck(testDb, { alertAttemptCount: 2, alertDispatchedAt: null });
    const code = await redispatchCommand(
      [],
      { "impact-check": String(id), yes: true },
      { json: false, verbose: false }
    );
    expect(code).toBe(0);
    expect(sendCardImpl).toHaveBeenCalledTimes(1);

    const row = testDb
      .query<{
        alert_dispatched_at: number | null;
        lark_message_id: string | null;
        alert_attempt_count: number;
      }, [number]>(
        "SELECT alert_dispatched_at, lark_message_id, alert_attempt_count FROM impact_checks WHERE id = ?"
      )
      .get(id)!;

    expect(row.alert_dispatched_at).not.toBeNull();
    expect(row.lark_message_id).toBe("redispatch-msg-001");
    expect(row.alert_attempt_count).toBe(1);
  });

  it("--yes with Lark failure returns 1 and does not set dispatched_at", async () => {
    sendCardImpl.mockImplementation(async () => ({ code: 99, msg: "webhook error" }));
    const id = insertCheck(testDb);
    const code = await redispatchCommand(
      [],
      { "impact-check": String(id), yes: true },
      { json: false, verbose: false }
    );
    expect(code).toBe(1);

    const row = testDb
      .query<{ alert_dispatched_at: number | null }, [number]>(
        "SELECT alert_dispatched_at FROM impact_checks WHERE id = ?"
      )
      .get(id)!;
    expect(row.alert_dispatched_at).toBeNull();
  });

  it("returns 1 when webhook is not configured (no DB touch, no send)", async () => {
    mockWebhookUrl = undefined;
    const id = insertCheck(testDb);
    const code = await redispatchCommand(
      [],
      { "impact-check": String(id) },
      { json: false, verbose: false }
    );
    expect(code).toBe(1);
    expect(sendCardImpl).not.toHaveBeenCalled();
  });

  it("returns 1 when the impact_check is not found", async () => {
    const code = await redispatchCommand(
      [],
      { "impact-check": "9999", yes: true },
      { json: false, verbose: false }
    );
    expect(code).toBe(1);
    expect(sendCardImpl).not.toHaveBeenCalled();
  });

  it("returns 1 when alert_card_json is null (nothing to send)", async () => {
    const id = insertCheck(testDb, { alertCardJson: null });
    const code = await redispatchCommand(
      [],
      { "impact-check": String(id), yes: true },
      { json: false, verbose: false }
    );
    expect(code).toBe(1);
    expect(sendCardImpl).not.toHaveBeenCalled();
  });
});
