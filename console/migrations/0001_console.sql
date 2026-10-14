PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  settings_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  version TEXT NOT NULL DEFAULT '',
  last_seen_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  payload_json TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  action TEXT NOT NULL,
  args_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  lease_until TEXT,
  result_json TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS jobs_agent_queue ON jobs(agent_id, status, created_at);
CREATE INDEX IF NOT EXISTS jobs_active_leases ON jobs(status, lease_until);
CREATE INDEX IF NOT EXISTS jobs_recent ON jobs(created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_running_per_agent ON jobs(agent_id) WHERE status = 'running';
