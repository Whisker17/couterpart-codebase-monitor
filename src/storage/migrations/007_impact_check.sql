-- Phase 1 pre-screen columns on analyses (filled during Phase 2; default 'none' until then)
ALTER TABLE analyses ADD COLUMN downstream_impact_hint TEXT
  CHECK(downstream_impact_hint IN ('none','possible','likely')) DEFAULT 'none';
ALTER TABLE analyses ADD COLUMN downstream_impact_reason TEXT;

-- Impact checks table: one row per (pr_id, target_project_id)
CREATE TABLE impact_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_id INTEGER NOT NULL REFERENCES pull_requests(id),
  analysis_id INTEGER NOT NULL REFERENCES analyses(id),  -- gate upsert keeps this pointing at latest
  target_project_id TEXT NOT NULL,        -- e.g. "mantle/reth"
  relationship TEXT NOT NULL CHECK(relationship IN ('fork_of','depends_on','protocol_dependency')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','complete','failed','skipped_budget','expired')),
  -- verdict
  affected TEXT CHECK(affected IN ('yes','no','uncertain')),
  impact_type TEXT,
  evidence_kind TEXT,
  evidence TEXT,                          -- JSON array
  confidence TEXT,
  summary TEXT,
  recommended_action TEXT,
  -- audit and reproducibility
  target_commit TEXT,                     -- Mantle clone commit hash at check time
  prompt_version TEXT NOT NULL,           -- strategy prompt file version hash (used in upsert trigger comparison)
  config_hash TEXT NOT NULL,              -- stable hash of all config affecting clone/prompt/verdict
  input_tokens INTEGER, output_tokens INTEGER,
  model_id TEXT, estimated_cost_usd REAL,
  tool_steps INTEGER,
  -- retry and alert delivery
  retry_count INTEGER NOT NULL DEFAULT 0, -- check failure retry counter (max 3)
  last_error TEXT,                        -- most recent failure reason
  alert_card_json TEXT,                   -- rendered alert card (only generated when alert threshold is met)
  alert_attempt_count INTEGER NOT NULL DEFAULT 0,
  alert_dispatched_at INTEGER,            -- successful dispatch timestamp; NULL = not sent / pending retry
  lark_message_id TEXT,                   -- message ID returned by webhook (if available)
  checked_at INTEGER,                     -- verdict write-back timestamp
  created_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(pr_id, target_project_id)
);
CREATE INDEX idx_impact_checks_status ON impact_checks(status);
CREATE INDEX idx_impact_checks_alert ON impact_checks(alert_dispatched_at)
  WHERE alert_card_json IS NOT NULL;
