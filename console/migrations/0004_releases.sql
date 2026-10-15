CREATE TABLE IF NOT EXISTS remix_releases (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
 payload_json TEXT NOT NULL, visibility TEXT NOT NULL DEFAULT 'private', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS remix_releases_project ON remix_releases(project_id, created_at DESC);
CREATE TABLE IF NOT EXISTS remix_publications (project_id TEXT PRIMARY KEY, release_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agent_wakes (agent_id TEXT PRIMARY KEY, attempted_at INTEGER NOT NULL);
