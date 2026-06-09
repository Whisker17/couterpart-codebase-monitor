ALTER TABLE projects ADD COLUMN source TEXT NOT NULL DEFAULT 'local';
ALTER TABLE projects ADD COLUMN inactive_reason TEXT;
ALTER TABLE projects ADD COLUMN subscription_synced_at INTEGER;
ALTER TABLE projects ADD COLUMN tags TEXT;
ALTER TABLE projects ADD COLUMN notes TEXT;

-- Backfill existing inactive rows
UPDATE projects SET inactive_reason = 'repo_not_found' WHERE active = 0 AND inactive_reason IS NULL;
