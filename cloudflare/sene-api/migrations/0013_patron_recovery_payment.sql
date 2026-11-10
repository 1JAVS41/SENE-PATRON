-- Store the registered owner contacts and support paid recovery of a lost PATRON device.
PRAGMA foreign_keys = ON;

ALTER TABLE licenses ADD COLUMN registered_email TEXT;
ALTER TABLE licenses ADD COLUMN registered_phone TEXT;
ALTER TABLE registration_requests ADD COLUMN registered_email TEXT;
ALTER TABLE registration_requests ADD COLUMN registered_phone TEXT;

CREATE TABLE IF NOT EXISTS patron_recovery_payment_requests (
  id TEXT PRIMARY KEY,
  license_id TEXT NOT NULL REFERENCES licenses(id),
  old_patron_device_id TEXT NOT NULL REFERENCES devices(id),
  installation_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  registered_email TEXT NOT NULL,
  registered_phone TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_payment','authorized','consumed','cancelled')),
  code_hash TEXT UNIQUE,
  payment_reference TEXT,
  created_at INTEGER NOT NULL,
  authorized_at INTEGER,
  consumed_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_open_patron_recovery_payment
  ON patron_recovery_payment_requests(license_id)
  WHERE status IN ('pending_payment','authorized');
CREATE INDEX IF NOT EXISTS idx_patron_recovery_payment_status
  ON patron_recovery_payment_requests(status,created_at);
