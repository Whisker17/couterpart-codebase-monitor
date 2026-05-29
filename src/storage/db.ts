import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { MIGRATION_001 } from "./schema";

const DB_PATH = "data/monitor.db";
const MIGRATION_VERSION = "001_init";

let db: Database | null = null;

function applyPragmas(database: Database): void {
  database.exec("PRAGMA journal_mode=WAL");
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

  if (!applied.includes(MIGRATION_VERSION)) {
    database.exec(MIGRATION_001);
    database
      .query("INSERT OR IGNORE INTO migrations (version) VALUES (?)")
      .run(MIGRATION_VERSION);
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

  // macOS WAL cleanup: try fileControl first, fall back to checkpoint pragma
  try {
    // SQLITE_FCNTL_PERSIST_WAL = 10
    (db as any).fileControl(10, 0);
  } catch {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  db.close();
  db = null;
}

process.on("SIGTERM", () => {
  closeDb();
  process.exit(0);
});
