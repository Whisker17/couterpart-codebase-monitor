import { Database, constants } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { MIGRATION_001, MIGRATION_002, MIGRATION_003, MIGRATION_004 } from "./schema";

const DB_PATH = "data/monitor.db";

let db: Database | null = null;

function applyPragmas(database: Database): void {
  database.exec("PRAGMA journal_mode=WAL");
  database.exec("PRAGMA foreign_keys=ON");
  database.exec("PRAGMA temp_store=MEMORY");
  database.exec("PRAGMA cache_size=-64000");
  database.exec("PRAGMA mmap_size=268435456");
  database.exec("PRAGMA busy_timeout=5000");
}

function runMigrations(database: Database): void {
  // Ensure migrations table exists first
  database.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      version TEXT PRIMARY KEY,
      applied_at INTEGER DEFAULT (unixepoch())
    )
  `);

  const applied = database
    .query<{ version: string }, []>("SELECT version FROM migrations")
    .all()
    .map((r) => r.version);

  if (!applied.includes("001_init")) {
    database.exec(MIGRATION_001);
    database.query("INSERT OR IGNORE INTO migrations (version) VALUES (?)").run("001_init");
  }

  if (!applied.includes("002_add_active")) {
    database.exec(MIGRATION_002);
    database.query("INSERT OR IGNORE INTO migrations (version) VALUES (?)").run("002_add_active");
  }

  if (!applied.includes("003_budget_skipped")) {
    database.exec(MIGRATION_003);
    database.query("INSERT OR IGNORE INTO migrations (version) VALUES (?)").run("003_budget_skipped");
  }

  if (!applied.includes("004_add_report_digest")) {
    database.exec(MIGRATION_004);
    database.query("INSERT OR IGNORE INTO migrations (version) VALUES (?)").run("004_add_report_digest");
  }
}

export function getDb(): Database {
  if (db) return db;

  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);

  applyPragmas(db);
  runMigrations(db);

  return db;
}

export function closeDb(): void {
  if (!db) return;

  try {
    db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0);
  } catch {
    // fileControl not available on this platform — continue to checkpoint
  }
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  db = null;
}

process.on("SIGTERM", () => {
  closeDb();
  process.exit(0);
});
