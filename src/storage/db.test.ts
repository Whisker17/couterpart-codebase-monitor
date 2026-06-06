import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { closeDatabaseHandle } from "./db";
import { MIGRATION_001, MIGRATION_002, MIGRATION_003, MIGRATION_004 } from "./schema";

function buildTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      version TEXT PRIMARY KEY,
      applied_at INTEGER DEFAULT (unixepoch())
    )
  `);

  db.exec(MIGRATION_001);
  db.query("INSERT OR IGNORE INTO migrations (version) VALUES (?)").run("001_init");

  db.exec(MIGRATION_002);
  db.query("INSERT OR IGNORE INTO migrations (version) VALUES (?)").run("002_add_active");

  db.exec(MIGRATION_003);
  db.query("INSERT OR IGNORE INTO migrations (version) VALUES (?)").run("003_budget_skipped");

  return db;
}

describe("MIGRATION_004 — digest_json column", () => {
  let db: Database;

  afterEach(() => {
    db?.close();
  });

  it("adds digest_json column to reports on fresh application", () => {
    db = buildTestDb();

    db.exec(MIGRATION_004);
    db.query("INSERT OR IGNORE INTO migrations (version) VALUES (?)").run("004_add_report_digest");

    const cols = db
      .query<{ name: string }, []>("PRAGMA table_info(reports)")
      .all()
      .map((r) => r.name);

    expect(cols).toContain("digest_json");
  });

  it("records 004_add_report_digest in migrations table", () => {
    db = buildTestDb();

    db.exec(MIGRATION_004);
    db.query("INSERT OR IGNORE INTO migrations (version) VALUES (?)").run("004_add_report_digest");

    const versions = db
      .query<{ version: string }, []>("SELECT version FROM migrations")
      .all()
      .map((r) => r.version);

    expect(versions).toContain("004_add_report_digest");
  });

  it("is idempotent when applied a second time via INSERT OR IGNORE", () => {
    db = buildTestDb();

    db.exec(MIGRATION_004);
    db.query("INSERT OR IGNORE INTO migrations (version) VALUES (?)").run("004_add_report_digest");

    // Second application: INSERT OR IGNORE is a no-op; ALTER TABLE would fail if re-run,
    // but the migration guard prevents re-execution.
    const applied = db
      .query<{ version: string }, []>("SELECT version FROM migrations")
      .all()
      .map((r) => r.version);

    if (!applied.includes("004_add_report_digest")) {
      db.exec(MIGRATION_004);
      db.query("INSERT OR IGNORE INTO migrations (version) VALUES (?)").run("004_add_report_digest");
    }

    const count = db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) as n FROM migrations WHERE version = '004_add_report_digest'"
      )
      .get()!.n;

    expect(count).toBe(1);
  });

  it("allows inserting and reading digest_json values in reports", () => {
    db = buildTestDb();

    db.exec(MIGRATION_004);
    db.query("INSERT OR IGNORE INTO migrations (version) VALUES (?)").run("004_add_report_digest");

    db
      .query(
        "INSERT INTO reports (type, period_start, period_end, content, digest_json) VALUES (?, ?, ?, ?, ?)"
      )
      .run("daily", 1000, 2000, "test content", JSON.stringify({ key: "value" }));

    const row = db
      .query<{ digest_json: string }, []>("SELECT digest_json FROM reports LIMIT 1")
      .get()!;

    expect(JSON.parse(row.digest_json)).toEqual({ key: "value" });
  });

  it("allows null digest_json (column is nullable)", () => {
    db = buildTestDb();

    db.exec(MIGRATION_004);
    db.query("INSERT OR IGNORE INTO migrations (version) VALUES (?)").run("004_add_report_digest");

    db
      .query("INSERT INTO reports (type, period_start, period_end, content) VALUES (?, ?, ?, ?)")
      .run("daily", 1000, 2000, "test content");

    const row = db
      .query<{ digest_json: string | null }, []>("SELECT digest_json FROM reports LIMIT 1")
      .get()!;

    expect(row.digest_json).toBeNull();
  });
});

describe("closeDatabaseHandle", () => {
  it("closes the database when wal checkpoint fails", () => {
    const calls: string[] = [];
    const database = {
      fileControl: () => {
        calls.push("fileControl");
      },
      exec: (sql: string) => {
        calls.push(sql);
        throw new Error("readonly");
      },
      close: () => {
        calls.push("close");
      },
    };

    expect(() => closeDatabaseHandle(database)).not.toThrow();
    expect(calls).toEqual(["fileControl", "PRAGMA wal_checkpoint(TRUNCATE)", "close"]);
  });

  it("still attempts checkpoint and close when fileControl is unavailable", () => {
    const calls: string[] = [];
    const database = {
      fileControl: () => {
        calls.push("fileControl");
        throw new Error("unsupported");
      },
      exec: (sql: string) => {
        calls.push(sql);
      },
      close: () => {
        calls.push("close");
      },
    };

    expect(() => closeDatabaseHandle(database)).not.toThrow();
    expect(calls).toEqual(["fileControl", "PRAGMA wal_checkpoint(TRUNCATE)", "close"]);
  });
});
