import { readFileSync } from "fs";
import { join } from "path";

// Re-export migration SQL for use by db.ts
export const MIGRATION_001 = readFileSync(
  join(import.meta.dir, "migrations/001_init.sql"),
  "utf-8"
);

export const MIGRATION_002 = readFileSync(
  join(import.meta.dir, "migrations/002_add_active.sql"),
  "utf-8"
);

export const MIGRATION_003 = readFileSync(
  join(import.meta.dir, "migrations/003_budget_skipped.sql"),
  "utf-8"
);

export const MIGRATION_004 = readFileSync(
  join(import.meta.dir, "migrations/004_add_report_digest.sql"),
  "utf-8"
);

export const MIGRATION_005 = readFileSync(
  join(import.meta.dir, "migrations/005_add_subscription_fields.sql"),
  "utf-8"
);
