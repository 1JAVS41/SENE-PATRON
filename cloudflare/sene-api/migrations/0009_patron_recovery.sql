-- Operator-approved recovery of a lost PATRON installation.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS patron_recovery_requests (
  id TEXT PRIMARY KEY,
  license_id TEXT NOT NULL REFERENCES licenses(id),
  old_patron_device_id TEXT NOT NULL REFERENCES devices(id),
  code_hash TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','consumed','cancelled')),
  created_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_by TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_pending_patron_recovery
  ON patron_recovery_requests(license_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_patron_recovery_status
  ON patron_recovery_requests(status, created_at);
