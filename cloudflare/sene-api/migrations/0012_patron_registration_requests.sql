-- Initial customer-side registration and one-time paid activation.
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS registration_requests (
  id TEXT PRIMARY KEY,
  business_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_payment','authorized','consumed','cancelled')),
  license_id TEXT REFERENCES licenses(id),
  code_hash TEXT UNIQUE,
  payment_reference TEXT,
  created_at INTEGER NOT NULL,
  authorized_at INTEGER,
  consumed_at INTEGER,
  cancelled_at INTEGER,
  CHECK (
    (status='pending_payment' AND license_id IS NULL AND code_hash IS NULL AND authorized_at IS NULL AND consumed_at IS NULL) OR
    (status='authorized' AND license_id IS NOT NULL AND code_hash IS NOT NULL AND authorized_at IS NOT NULL AND consumed_at IS NULL) OR
    (status='consumed' AND license_id IS NOT NULL AND code_hash IS NOT NULL AND authorized_at IS NOT NULL AND consumed_at IS NOT NULL) OR
    status='cancelled'
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_registration_open_business
  ON registration_requests(normalized_name)
  WHERE status IN ('pending_payment','authorized');
CREATE UNIQUE INDEX IF NOT EXISTS idx_registration_open_device
  ON registration_requests(installation_id,fingerprint)
  WHERE status IN ('pending_payment','authorized');
CREATE INDEX IF NOT EXISTS idx_registration_status_created
  ON registration_requests(status,created_at);
