-- Recreate pull_requests with 'budget_skipped' added to analysis_status CHECK constraint.
-- SQLite does not support ALTER COLUMN — table must be rebuilt.
PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS pull_requests_new (
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
  analysis_status TEXT CHECK(analysis_status IN ('pending', 'complete', 'failed', 'budget_skipped')) DEFAULT 'pending',
  retry_count INTEGER DEFAULT 0,
  last_error TEXT,
  fetched_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(project_id, pr_number)
);

INSERT OR IGNORE INTO pull_requests_new SELECT * FROM pull_requests;
DROP TABLE pull_requests;
ALTER TABLE pull_requests_new RENAME TO pull_requests;

PRAGMA foreign_keys = ON;
