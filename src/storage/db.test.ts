import { describe, it, expect, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { closeDatabaseHandle } from "./db";
import { MIGRATION_001, MIGRATION_002, MIGRATION_003, MIGRATION_004, MIGRATION_005, MIGRATION_006 } from "./schema";
import { syncSubscriptionProjects } from "../config/projects";
import type { TrackedProject } from "../config/projects";

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

function buildTestDbWithAll(): Database {
  const db = buildTestDb();
  db.exec(MIGRATION_004);
  db.query("INSERT OR IGNORE INTO migrations (version) VALUES (?)").run("004_add_report_digest");
  db.exec(MIGRATION_005);
  db.query("INSERT OR IGNORE INTO migrations (version) VALUES (?)").run("005_add_subscription_fields");
  return db;
}

describe("MIGRATION_006 — last_collected_at column", () => {
  let db: Database;

  afterEach(() => {
    db?.close();
  });

  it("adds last_collected_at column to projects", () => {
    db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(`
      CREATE TABLE IF NOT EXISTS migrations (
        version TEXT PRIMARY KEY,
        applied_at INTEGER DEFAULT (unixepoch())
      )
    `);
    db.exec(MIGRATION_001);
    db.exec(MIGRATION_002);
    db.exec(MIGRATION_003);
    db.exec(MIGRATION_004);
    db.exec(MIGRATION_005);
    db.exec(MIGRATION_006);

    const cols = db
      .query<{ name: string }, []>("PRAGMA table_info(projects)")
      .all()
      .map((r) => r.name);

    expect(cols).toContain("last_collected_at");
  });
});

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

describe("MIGRATION_005 — subscription fields", () => {
  let db: Database;

  afterEach(() => {
    db?.close();
  });

  it("adds source, inactive_reason, subscription_synced_at, tags, notes columns to projects", () => {
    db = buildTestDb();
    db.exec(MIGRATION_004);
    db.exec(MIGRATION_005);

    const cols = db
      .query<{ name: string }, []>("PRAGMA table_info(projects)")
      .all()
      .map((r) => r.name);

    expect(cols).toContain("source");
    expect(cols).toContain("inactive_reason");
    expect(cols).toContain("subscription_synced_at");
    expect(cols).toContain("tags");
    expect(cols).toContain("notes");
  });

  it("source column defaults to 'local' for existing rows", () => {
    db = buildTestDb();
    db.exec(MIGRATION_004);

    db.query("INSERT INTO projects (id, org, repo, url) VALUES (?, ?, ?, ?)").run(
      "base/base", "base", "base", "https://github.com/base/base"
    );

    db.exec(MIGRATION_005);

    const row = db
      .query<{ source: string }, []>("SELECT source FROM projects WHERE id = 'base/base'")
      .get()!;
    expect(row.source).toBe("local");
  });

  it("backfills inactive_reason = 'repo_not_found' for existing inactive rows", () => {
    db = buildTestDb();
    db.exec(MIGRATION_004);

    db.query("INSERT INTO projects (id, org, repo, url, active) VALUES (?, ?, ?, ?, ?)").run(
      "gone/proj", "gone", "proj", "https://github.com/gone/proj", 0
    );

    db.exec(MIGRATION_005);

    const row = db
      .query<{ inactive_reason: string | null }, []>(
        "SELECT inactive_reason FROM projects WHERE id = 'gone/proj'"
      )
      .get()!;
    expect(row.inactive_reason).toBe("repo_not_found");
  });

  it("does not set inactive_reason for active rows", () => {
    db = buildTestDb();
    db.exec(MIGRATION_004);

    db.query("INSERT INTO projects (id, org, repo, url, active) VALUES (?, ?, ?, ?, ?)").run(
      "active/proj", "active", "proj", "https://github.com/active/proj", 1
    );

    db.exec(MIGRATION_005);

    const row = db
      .query<{ inactive_reason: string | null }, []>(
        "SELECT inactive_reason FROM projects WHERE id = 'active/proj'"
      )
      .get()!;
    expect(row.inactive_reason).toBeNull();
  });

  it("records 005_add_subscription_fields in migrations table", () => {
    db = buildTestDb();
    db.exec(MIGRATION_004);
    db.exec(MIGRATION_005);
    db.query("INSERT OR IGNORE INTO migrations (version) VALUES (?)").run("005_add_subscription_fields");

    const versions = db
      .query<{ version: string }, []>("SELECT version FROM migrations")
      .all()
      .map((r) => r.version);

    expect(versions).toContain("005_add_subscription_fields");
  });
});

// ---- syncSubscriptionProjects ----

describe("syncSubscriptionProjects — insert new subscription projects", () => {
  let db: Database;

  afterEach(() => {
    db?.close();
  });

  it("inserts new projects as active with source=subscription", () => {
    db = buildTestDbWithAll();

    const incoming: TrackedProject[] = [
      { org: "base", repo: "base", url: "https://github.com/base/base", tags: ["l2"] },
    ];

    const result = syncSubscriptionProjects(incoming, db);

    expect(result.activated).toContain("base/base");
    expect(result.deactivated).toHaveLength(0);

    const row = db
      .query<{ active: number; source: string }, []>(
        "SELECT active, source FROM projects WHERE id = 'base/base'"
      )
      .get()!;
    expect(row.active).toBe(1);
    expect(row.source).toBe("subscription");
  });

  it("stores tags as JSON and notes", () => {
    db = buildTestDbWithAll();

    const incoming: TrackedProject[] = [
      {
        org: "base",
        repo: "base",
        url: "https://github.com/base/base",
        tags: ["blockchain", "l2"],
        notes: "analyst note",
      },
    ];

    syncSubscriptionProjects(incoming, db);

    const row = db
      .query<{ tags: string; notes: string }, []>(
        "SELECT tags, notes FROM projects WHERE id = 'base/base'"
      )
      .get()!;
    expect(JSON.parse(row.tags)).toEqual(["blockchain", "l2"]);
    expect(row.notes).toBe("analyst note");
  });

  it("sets subscription_synced_at to a recent timestamp", () => {
    db = buildTestDbWithAll();

    const before = Math.floor(Date.now() / 1000) - 2;
    const incoming: TrackedProject[] = [
      { org: "base", repo: "base", url: "https://github.com/base/base", tags: [] },
    ];
    syncSubscriptionProjects(incoming, db);

    const row = db
      .query<{ subscription_synced_at: number }, []>(
        "SELECT subscription_synced_at FROM projects WHERE id = 'base/base'"
      )
      .get()!;
    expect(row.subscription_synced_at).toBeGreaterThanOrEqual(before);
  });
});

describe("syncSubscriptionProjects — reactivate previously deactivated subscription projects", () => {
  let db: Database;

  afterEach(() => {
    db?.close();
  });

  it("reactivates a subscription row that was previously inactive", () => {
    db = buildTestDbWithAll();

    // Insert an inactive subscription row
    db.query(
      `INSERT INTO projects (id, org, repo, url, source, active, inactive_reason) VALUES (?, ?, ?, ?, 'subscription', 0, 'subscription_removed')`
    ).run("base/base", "base", "base", "https://github.com/base/base");

    const incoming: TrackedProject[] = [
      { org: "base", repo: "base", url: "https://github.com/base/base", tags: [] },
    ];

    const result = syncSubscriptionProjects(incoming, db);

    expect(result.activated).toContain("base/base");

    const row = db
      .query<{ active: number; inactive_reason: string | null }, []>(
        "SELECT active, inactive_reason FROM projects WHERE id = 'base/base'"
      )
      .get()!;
    expect(row.active).toBe(1);
    expect(row.inactive_reason).toBeNull();
  });
});

describe("syncSubscriptionProjects — deactivate subscription rows absent from new source", () => {
  let db: Database;

  afterEach(() => {
    db?.close();
  });

  it("deactivates subscription projects absent from incoming set", () => {
    db = buildTestDbWithAll();

    // Insert two subscription projects
    db.query(
      `INSERT INTO projects (id, org, repo, url, source, active) VALUES (?, ?, ?, ?, 'subscription', 1)`
    ).run("base/base", "base", "base", "https://github.com/base/base");
    db.query(
      `INSERT INTO projects (id, org, repo, url, source, active) VALUES (?, ?, ?, ?, 'subscription', 1)`
    ).run("foo/bar", "foo", "bar", "https://github.com/foo/bar");

    // Sync with only base/base
    const incoming: TrackedProject[] = [
      { org: "base", repo: "base", url: "https://github.com/base/base", tags: [] },
    ];

    const result = syncSubscriptionProjects(incoming, db);

    expect(result.deactivated).toContain("foo/bar");
    expect(result.activated).not.toContain("base/base"); // already active → unchanged

    const fooRow = db
      .query<{ active: number; inactive_reason: string }, []>(
        "SELECT active, inactive_reason FROM projects WHERE id = 'foo/bar'"
      )
      .get()!;
    expect(fooRow.active).toBe(0);
    expect(fooRow.inactive_reason).toBe("subscription_removed");
  });

  it("unchanged list includes projects that were already active", () => {
    db = buildTestDbWithAll();

    db.query(
      `INSERT INTO projects (id, org, repo, url, source, active) VALUES (?, ?, ?, ?, 'subscription', 1)`
    ).run("base/base", "base", "base", "https://github.com/base/base");

    const incoming: TrackedProject[] = [
      { org: "base", repo: "base", url: "https://github.com/base/base", tags: [] },
    ];

    const result = syncSubscriptionProjects(incoming, db);

    expect(result.unchanged).toContain("base/base");
    expect(result.activated).toHaveLength(0);
    expect(result.deactivated).toHaveLength(0);
  });
});

describe("syncSubscriptionProjects — stale local rows", () => {
  let db: Database;

  afterEach(() => {
    db?.close();
  });

  // Local mode no longer exists: rows left with source='local' (old local mode or
  // migration default) are deactivated when absent from the projects file, so they
  // cannot linger as active in CLI/status/report-count queries.
  it("deactivates source=local rows absent from the projects file", () => {
    db = buildTestDbWithAll();

    // Insert a stale local row
    db.query(
      `INSERT INTO projects (id, org, repo, url, source, active) VALUES (?, ?, ?, ?, 'local', 1)`
    ).run("local/proj", "local", "proj", "https://github.com/local/proj");

    // Sync with completely different projects
    const incoming: TrackedProject[] = [
      { org: "base", repo: "base", url: "https://github.com/base/base", tags: [] },
    ];

    const result = syncSubscriptionProjects(incoming, db);

    expect(result.deactivated).toContain("local/proj");

    const localRow = db
      .query<{ active: number; inactive_reason: string | null }, []>(
        "SELECT active, inactive_reason FROM projects WHERE id = 'local/proj'"
      )
      .get()!;
    expect(localRow.active).toBe(0);
    expect(localRow.inactive_reason).toBe("subscription_removed");
  });
});

describe("syncSubscriptionProjects — historical rows unaffected", () => {
  let db: Database;

  afterEach(() => {
    db?.close();
  });

  it("does not delete pull_requests when a subscription project is deactivated", () => {
    db = buildTestDbWithAll();

    // Insert subscription project and a PR for it
    db.query(
      `INSERT INTO projects (id, org, repo, url, source, active) VALUES (?, ?, ?, ?, 'subscription', 1)`
    ).run("foo/bar", "foo", "bar", "https://github.com/foo/bar");
    db.query(
      "INSERT INTO pull_requests (project_id, pr_number, title) VALUES (?, ?, ?)"
    ).run("foo/bar", 42, "some PR");

    // Sync with empty — deactivates foo/bar
    const result = syncSubscriptionProjects([], db);

    expect(result.deactivated).toContain("foo/bar");

    // PR row must still exist
    const prRow = db
      .query<{ pr_number: number }, []>(
        "SELECT pr_number FROM pull_requests WHERE project_id = 'foo/bar'"
      )
      .get();
    expect(prRow?.pr_number).toBe(42);
  });
});

describe("syncSubscriptionProjects — transactionality", () => {
  let db: Database;

  afterEach(() => {
    db?.close();
  });

  it("rolls back all changes if sync throws mid-transaction", () => {
    db = buildTestDbWithAll();

    // Insert an existing active subscription row
    db.query(
      `INSERT INTO projects (id, org, repo, url, source, active) VALUES (?, ?, ?, ?, 'subscription', 1)`
    ).run("existing/proj", "existing", "proj", "https://github.com/existing/proj");

    // Patch db.transaction to run fn but throw after first upsert by using a deliberate constraint violation.
    // We simulate this by passing a project with a null org/repo that would cause an SQL error.
    // Easiest: override the query for the second insert by temporarily replacing exec.
    let callCount = 0;
    const origQuery = db.query.bind(db);
    // @ts-ignore - patching for test
    db.query = (sql: string) => {
      const stmt = origQuery(sql);
      if (sql.includes("INSERT INTO projects") && sql.includes("subscription")) {
        callCount++;
        if (callCount >= 2) {
          // Force a constraint violation on the second insert by making run throw
          return {
            run: (..._args: unknown[]) => {
              throw new Error("simulated mid-sync failure");
            },
            get: stmt.get?.bind(stmt),
            all: stmt.all?.bind(stmt),
          };
        }
      }
      return stmt;
    };

    const incoming: TrackedProject[] = [
      { org: "new", repo: "a", url: "https://github.com/new/a", tags: [] },
      { org: "new", repo: "b", url: "https://github.com/new/b", tags: [] },
    ];

    expect(() => syncSubscriptionProjects(incoming, db)).toThrow("simulated mid-sync failure");

    // Restore
    // @ts-ignore
    db.query = origQuery;

    // existing/proj must still be active; new/a must not exist
    const existingRow = db
      .query<{ active: number }, []>("SELECT active FROM projects WHERE id = 'existing/proj'")
      .get();
    expect(existingRow?.active).toBe(1);

    const newARow = db
      .query<{ id: string }, []>("SELECT id FROM projects WHERE id = 'new/a'")
      .get();
    expect(newARow).toBeNull();
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
