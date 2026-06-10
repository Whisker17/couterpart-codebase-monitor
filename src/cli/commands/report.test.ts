import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import {
  findReportByPeriod,
  markDeliveryStatus,
  parseRedispatchMode,
  prepareRedispatch,
  resolveReportPeriod,
} from "./report";

function createDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      period_start INTEGER NOT NULL,
      period_end INTEGER NOT NULL,
      content TEXT NOT NULL,
      sent_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch()),
      UNIQUE(type, period_start, period_end)
    );
    CREATE TABLE report_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id INTEGER NOT NULL,
      card_index INTEGER NOT NULL,
      content TEXT NOT NULL,
      lark_message_id TEXT,
      status TEXT DEFAULT 'pending',
      sent_at INTEGER,
      UNIQUE(report_id, card_index)
    );
  `);
  return db;
}

describe("report CLI helpers", () => {
  let db: Database;

  beforeEach(() => {
    db = createDb();
  });

  it("resolves daily and monthly report periods", () => {
    const daily = resolveReportPeriod("daily", { date: "2026-06-09" }, "UTC");
    expect(daily.type).toBe("daily");
    expect(daily.label).toBe("2026-06-09");

    const monthly = resolveReportPeriod("monthly", { month: "2026-06" }, "UTC", new Date("2026-06-10T12:00:00Z"));
    expect(monthly.type).toBe("monthly");
    expect(monthly.label).toContain("2026-06");
  });

  it("requires explicit monthly period for mark-delivery", () => {
    expect(() => resolveReportPeriod("monthly", {}, "UTC")).toThrow("--month is required");
  });

  it("dry-run mark-delivery does not mutate delivery rows", () => {
    db.run("INSERT INTO reports (type, period_start, period_end, content, sent_at) VALUES ('daily', 1, 2, '{}', 123)");
    db.run(
      "INSERT INTO report_deliveries (report_id, card_index, content, status, lark_message_id, sent_at) VALUES (1, 0, '{}', 'sent', 'msg', 123)"
    );

    const result = markDeliveryStatus(db, {
      reportId: 1,
      status: "pending",
      yes: false,
    });

    expect(result.mutated).toBe(false);
    const row = db
      .query<{ status: string; lark_message_id: string | null; sent_at: number | null }, []>(
        "SELECT status, lark_message_id, sent_at FROM report_deliveries WHERE id = 1"
      )
      .get()!;
    expect(row).toEqual({ status: "sent", lark_message_id: "msg", sent_at: 123 });
  });

  it("confirmed mark-delivery scopes updates and clears sent metadata", () => {
    db.run("INSERT INTO reports (type, period_start, period_end, content, sent_at) VALUES ('daily', 1, 2, '{}', 123)");
    db.run(
      "INSERT INTO report_deliveries (report_id, card_index, content, status, lark_message_id, sent_at) VALUES (1, 0, '{}', 'sent', 'msg0', 123)"
    );
    db.run(
      "INSERT INTO report_deliveries (report_id, card_index, content, status, lark_message_id, sent_at) VALUES (1, 1, '{}', 'sent', 'msg1', 123)"
    );

    const result = markDeliveryStatus(db, {
      reportId: 1,
      status: "pending",
      cardIndex: 0,
      yes: true,
    });

    expect(result.mutated).toBe(true);
    expect(result.after.filter((row) => row.status === "pending")).toHaveLength(1);
    const first = db
      .query<{ status: string; lark_message_id: string | null; sent_at: number | null }, []>(
        "SELECT status, lark_message_id, sent_at FROM report_deliveries WHERE card_index = 0"
      )
      .get()!;
    const second = db
      .query<{ status: string; lark_message_id: string | null; sent_at: number | null }, []>(
        "SELECT status, lark_message_id, sent_at FROM report_deliveries WHERE card_index = 1"
      )
      .get()!;
    const report = db.query<{ sent_at: number | null }, []>("SELECT sent_at FROM reports WHERE id = 1").get()!;

    expect(first).toEqual({ status: "pending", lark_message_id: null, sent_at: null });
    expect(second.status).toBe("sent");
    expect(report.sent_at).toBeNull();
  });

  it("finds reports by resolved period", () => {
    db.run("INSERT INTO reports (type, period_start, period_end, content) VALUES ('monthly', 10, 20, '{}')");

    const found = findReportByPeriod(db, { type: "monthly", startUnix: 10, endUnix: 20, label: "2026-06" });
    expect(found?.id).toBe(1);
  });

  it("parses redispatch mode and rejects legacy mutually exclusive flags", () => {
    expect(parseRedispatchMode({})).toBe("full");
    expect(parseRedispatchMode({ mode: "dispatch-only" })).toBe("dispatch-only");
    expect(() => parseRedispatchMode({ "dispatch-only": true })).toThrow("Use --mode dispatch-only");
    expect(() => parseRedispatchMode({ mode: "invalid" })).toThrow("Invalid --mode");
  });

  it("dry-run redispatch does not mutate delivery rows", () => {
    db.run("INSERT INTO reports (type, period_start, period_end, content, sent_at) VALUES ('daily', 1, 2, '{}', 123)");
    db.run(
      "INSERT INTO report_deliveries (report_id, card_index, content, status, lark_message_id, sent_at) VALUES (1, 0, '{}', 'sent', 'msg', 123)"
    );

    const result = prepareRedispatch(db, {
      reportId: 1,
      mode: "dispatch-only",
      yes: false,
    });

    expect(result.mutated).toBe(false);
    expect(result.before).toHaveLength(1);
    const row = db
      .query<{ status: string; lark_message_id: string | null; sent_at: number | null }, []>(
        "SELECT status, lark_message_id, sent_at FROM report_deliveries WHERE id = 1"
      )
      .get()!;
    expect(row).toEqual({ status: "sent", lark_message_id: "msg", sent_at: 123 });
  });

  it("confirmed redispatch only resets the targeted report deliveries", () => {
    db.run("INSERT INTO reports (type, period_start, period_end, content, sent_at) VALUES ('daily', 1, 2, '{}', 123)");
    db.run("INSERT INTO reports (type, period_start, period_end, content, sent_at) VALUES ('daily', 3, 4, '{}', 456)");
    db.run(
      "INSERT INTO report_deliveries (report_id, card_index, content, status, lark_message_id, sent_at) VALUES (1, 0, '{}', 'sent', 'msg0', 123)"
    );
    db.run(
      "INSERT INTO report_deliveries (report_id, card_index, content, status, lark_message_id, sent_at) VALUES (2, 0, '{}', 'sent', 'msg1', 456)"
    );

    const result = prepareRedispatch(db, {
      reportId: 1,
      mode: "dispatch-only",
      yes: true,
    });

    expect(result.mutated).toBe(true);
    const targeted = db
      .query<{ status: string; lark_message_id: string | null; sent_at: number | null }, []>(
        "SELECT status, lark_message_id, sent_at FROM report_deliveries WHERE report_id = 1"
      )
      .get()!;
    const untouched = db
      .query<{ status: string; lark_message_id: string | null; sent_at: number | null }, []>(
        "SELECT status, lark_message_id, sent_at FROM report_deliveries WHERE report_id = 2"
      )
      .get()!;

    expect(targeted).toEqual({ status: "pending", lark_message_id: null, sent_at: null });
    expect(untouched).toEqual({ status: "sent", lark_message_id: "msg1", sent_at: 456 });
  });

});
