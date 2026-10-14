CREATE TABLE IF NOT EXISTS console_sessions (
  token_hash TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS console_sessions_expiry ON console_sessions(expires_at);
CREATE TABLE IF NOT EXISTS console_login_attempts (
  limiter_key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
