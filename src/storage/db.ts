import { Database, constants } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { MIGRATION_001, MIGRATION_002, MIGRATION_003, MIGRATION_004, MIGRATION_005, MIGRATION_006, MIGRATION_007, MIGRATION_008 } from "./schema";

const DB_PATH = "data/monitor.db";

let db: Database | null = null;
let dbPath = DB_PATH;

interface ClosableDatabase {
  fileControl: (op: number, value: number) => unknown;
  exec: (sql: string) => unknown;
  close: () => unknown;
}

export function applyPragmas(database: Database): void {
  database.exec("PRAGMA busy_timeout=5000");
  database.exec("PRAGMA journal_mode=WAL");
  database.exec("PRAGMA foreign_keys=ON");
  database.exec("PRAGMA temp_store=MEMORY");
  database.exec("PRAGMA cache_size=-64000");
  database.exec("PRAGMA mmap_size=268435456");
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

  if (!applied.includes("005_add_subscription_fields")) {
    database.exec(MIGRATION_005);
    database.query("INSERT OR IGNORE INTO migrations (version) VALUES (?)").run("005_add_subscription_fields");
  }

  if (!applied.includes("006_add_last_collected_at")) {
    database.exec(MIGRATION_006);
    database.query("INSERT OR IGNORE INTO migrations (version) VALUES (?)").run("006_add_last_collected_at");
  }

  if (!applied.includes("007_impact_check")) {
    database.exec(MIGRATION_007);
    database.query("INSERT OR IGNORE INTO migrations (version) VALUES (?)").run("007_impact_check");
  }

  if (!applied.includes("008_impact_check_severity")) {
    database.exec(MIGRATION_008);
    database.query("INSERT OR IGNORE INTO migrations (version) VALUES (?)").run("008_impact_check_severity");
  }
}

export function getDb(): Database {
  if (db) return db;

  mkdirSync(dirname(dbPath), { recursive: true });
  db = new Database(dbPath);

  applyPragmas(db);
  runMigrations(db);

  return db;
}

export function setDbPathForProcess(path: string): void {
  if (db) {
    throw new Error("Cannot change database path after the database has been opened");
  }
  dbPath = path;
}

export function closeDb(): void {
  if (!db) return;

  closeDatabaseHandle(db);
  db = null;
}

export function closeDatabaseHandle(database: ClosableDatabase): void {
  try {
    database.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0);
  } catch {
    // fileControl not available on this platform — continue to checkpoint
  }
  try {
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    // checkpoint may fail if db is read-only or locked by another process
  }
  database.close();
}

process.on("SIGTERM", () => {
  closeDb();
  process.exit(0);
});
