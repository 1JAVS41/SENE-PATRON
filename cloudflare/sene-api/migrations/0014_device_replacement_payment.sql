-- Paid replacement authorization for a lost SENE VENTAS device.
-- The old device remains active until the one-time code is redeemed by its replacement.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS replacement_payment_requests (
  id TEXT PRIMARY KEY,
  replacement_request_id TEXT NOT NULL UNIQUE REFERENCES replacement_requests(id),
  license_id TEXT NOT NULL REFERENCES licenses(id),
  old_device_id TEXT NOT NULL REFERENCES devices(id),
  slot_number INTEGER NOT NULL CHECK (slot_number IN (2, 3)),
  status TEXT NOT NULL CHECK (status IN ('pending_payment', 'authorized', 'consumed', 'cancelled')),
  code_hash TEXT UNIQUE,
  payment_reference TEXT,
  created_at INTEGER NOT NULL,
  authorized_at INTEGER,
  consumed_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_open_replacement_payment_per_slot
  ON replacement_payment_requests(license_id, slot_number)
  WHERE status IN ('pending_payment', 'authorized');

CREATE INDEX IF NOT EXISTS idx_replacement_payment_status_created
  ON replacement_payment_requests(status, created_at);
