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

export const MIGRATION_006 = readFileSync(
  join(import.meta.dir, "migrations/006_add_last_collected_at.sql"),
  "utf-8"
);

export const MIGRATION_007 = readFileSync(
  join(import.meta.dir, "migrations/007_impact_check.sql"),
  "utf-8"
);

export const MIGRATION_008 = readFileSync(
  join(import.meta.dir, "migrations/008_impact_check_severity.sql"),
  "utf-8"
);

// Row types

export interface Analysis {
  id: number;
  pr_id: number;
  project_id: string;
  summary: string;
  technical_detail: string | null;
  direction_signal: string | null;
  significance: "routine" | "notable" | "directional_shift" | null;
  categories: string | null;
  model_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  estimated_cost_usd: number | null;
  analyzed_at: number;
  downstream_impact_hint: "none" | "possible" | "likely" | null;
  downstream_impact_reason: string | null;
}

export interface ImpactCheck {
  id: number;
  pr_id: number;
  analysis_id: number;
  target_project_id: string;
  relationship: "fork_of" | "depends_on" | "protocol_dependency";
  status: "pending" | "complete" | "failed" | "skipped_budget" | "expired";
  affected: "yes" | "no" | "uncertain" | null;
  severity: "critical" | "high" | "medium" | "low" | null;
  impact_type: string | null;
  evidence_kind: string | null;
  evidence: string | null;
  confidence: string | null;
  summary: string | null;
  recommended_action: string | null;
  target_commit: string | null;
  prompt_version: string;
  config_hash: string;
  input_tokens: number | null;
  output_tokens: number | null;
  model_id: string | null;
  estimated_cost_usd: number | null;
  tool_steps: number | null;
  retry_count: number;
  last_error: string | null;
  alert_card_json: string | null;
  alert_attempt_count: number;
  alert_dispatched_at: number | null;
  lark_message_id: string | null;
  checked_at: number | null;
  created_at: number;
}
