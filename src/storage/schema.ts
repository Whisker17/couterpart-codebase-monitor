import { readFileSync } from "fs";
import { join } from "path";

// Re-export migration SQL for use by db.ts
export const MIGRATION_001 = readFileSync(
  join(import.meta.dir, "migrations/001_init.sql"),
  "utf-8"
);
