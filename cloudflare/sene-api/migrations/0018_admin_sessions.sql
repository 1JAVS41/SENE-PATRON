CREATE TABLE IF NOT EXISTS admin_sessions (
  session_id TEXT PRIMARY KEY,
  token_sha256 TEXT NOT NULL UNIQUE CHECK (length(token_sha256) = 64),
  role TEXT NOT NULL CHECK (role = 'admin'),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expiry
  ON admin_sessions(expires_at);

CREATE TABLE IF NOT EXISTS admin_login_attempts (
  ip_hash TEXT PRIMARY KEY CHECK (length(ip_hash) = 64),
  window_started_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  blocked_until INTEGER NOT NULL DEFAULT 0
);
