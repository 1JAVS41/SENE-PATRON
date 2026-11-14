-- One-time email-confirmed password reset for SENE ADMIN.
-- Passwords are stored only as PBKDF2-SHA256 hashes with random salts.
CREATE TABLE IF NOT EXISTS admin_password_credentials (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL CHECK (length(password_hash) = 64),
  password_salt TEXT NOT NULL,
  iterations INTEGER NOT NULL CHECK (iterations BETWEEN 10000 AND 100000),
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_password_reset_requests (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL CHECK (length(password_hash) = 64),
  password_salt TEXT NOT NULL,
  iterations INTEGER NOT NULL CHECK (iterations BETWEEN 10000 AND 100000),
  token_sha256 TEXT NOT NULL CHECK (length(token_sha256) = 64),
  ip_hash TEXT NOT NULL CHECK (length(ip_hash) = 64),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_admin_password_reset_email_created
  ON admin_password_reset_requests(email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_password_reset_expiry
  ON admin_password_reset_requests(expires_at);
