CREATE TABLE IF NOT EXISTS migrations (
  version TEXT PRIMARY KEY,
  applied_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  org TEXT NOT NULL,
  repo TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT,
  language TEXT,
  topics TEXT,
  overview TEXT,
  tech_stack TEXT,
  clone_path TEXT,
  last_synced_at INTEGER,
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS pull_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id),
  pr_number INTEGER NOT NULL,
  github_node_id TEXT,
  title TEXT NOT NULL,
  body TEXT,
  author TEXT,
  merged_at INTEGER,
  files_changed INTEGER,
  additions INTEGER,
  deletions INTEGER,
  diff_path TEXT,
  diff_status TEXT CHECK(diff_status IN ('available', 'missing', 'fetch_failed', 'too_large')) DEFAULT 'missing',
  analysis_status TEXT CHECK(analysis_status IN ('pending', 'complete', 'failed')) DEFAULT 'pending',
  retry_count INTEGER DEFAULT 0,
  last_error TEXT,
  fetched_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(project_id, pr_number)
);

CREATE TABLE IF NOT EXISTS analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_id INTEGER NOT NULL REFERENCES pull_requests(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  summary TEXT NOT NULL,
  technical_detail TEXT,
  direction_signal TEXT,
  significance TEXT CHECK(significance IN ('routine', 'notable', 'directional_shift')),
  categories TEXT,
  model_id TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  estimated_cost_usd REAL,
  analyzed_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT CHECK(type IN ('daily', 'weekly', 'monthly')),
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  project_ids TEXT,
  content TEXT NOT NULL,
  completeness TEXT,
  sent_at INTEGER,
  created_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(type, period_start, period_end)
);

CREATE TABLE IF NOT EXISTS report_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL REFERENCES reports(id),
  card_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  lark_message_id TEXT,
  status TEXT CHECK(status IN ('pending', 'sent', 'failed')) DEFAULT 'pending',
  sent_at INTEGER,
  UNIQUE(report_id, card_index)
);

CREATE TABLE IF NOT EXISTS analysis_inputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  analysis_id INTEGER NOT NULL REFERENCES analyses(id),
  prompt_version TEXT NOT NULL,
  input_quality TEXT NOT NULL,
  rendered_project_context TEXT,
  file_manifest TEXT,
  diff_included_files INTEGER,
  diff_total_files INTEGER,
  diff_truncated BOOLEAN NOT NULL,
  truncated_diff_path TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);
