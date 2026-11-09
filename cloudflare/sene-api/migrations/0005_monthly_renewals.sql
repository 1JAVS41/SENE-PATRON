-- SENE monthly renewal requests and one-time operator-issued authorization codes.
-- The code never expires by time; it is bound to one request, license and PATRON device.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS renewal_requests (
  id TEXT PRIMARY KEY,
  license_id TEXT NOT NULL REFERENCES licenses(id),
  patron_device_id TEXT NOT NULL REFERENCES devices(id),
  business_name TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'pending_payment','authorized','consumed','cancelled'
  )),
  code_hash TEXT UNIQUE,
  payment_reference TEXT,
  created_at INTEGER NOT NULL,
  authorized_at INTEGER,
  consumed_at INTEGER,
  cancelled_at INTEGER,
  CHECK (
    (status = 'pending_payment' AND code_hash IS NULL AND authorized_at IS NULL AND consumed_at IS NULL) OR
    (status = 'authorized' AND code_hash IS NOT NULL AND authorized_at IS NOT NULL AND consumed_at IS NULL) OR
    (status = 'consumed' AND code_hash IS NOT NULL AND authorized_at IS NOT NULL AND consumed_at IS NOT NULL) OR
    (status = 'cancelled')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_open_renewal_per_license
  ON renewal_requests(license_id)
  WHERE status IN ('pending_payment','authorized');

CREATE INDEX IF NOT EXISTS idx_renewals_status_created
  ON renewal_requests(status, created_at);

CREATE INDEX IF NOT EXISTS idx_renewals_license_history
  ON renewal_requests(license_id, created_at DESC);
