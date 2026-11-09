-- SENE API v1: additive tables/columns for payments, signed challenges,
-- weekly quotas, replacements and minimal audit. Apply once after 0001_initial.sql.

PRAGMA foreign_keys = ON;

ALTER TABLE licenses ADD COLUMN business_name TEXT;
ALTER TABLE licenses ADD COLUMN setup_paid_at INTEGER;
ALTER TABLE licenses ADD COLUMN first_rent_paid_at INTEGER;

ALTER TABLE challenges ADD COLUMN device_id TEXT REFERENCES devices(id);
ALTER TABLE challenges ADD COLUMN fingerprint TEXT;
ALTER TABLE challenges ADD COLUMN target_method TEXT;
ALTER TABLE challenges ADD COLUMN target_path TEXT;
ALTER TABLE challenges ADD COLUMN body_sha256 TEXT;
ALTER TABLE challenges ADD COLUMN signing_message TEXT;

ALTER TABLE correction_requests ADD COLUMN idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_correction_idempotency
  ON correction_requests(ventas_device_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  license_id TEXT NOT NULL REFERENCES licenses(id),
  payment_type TEXT NOT NULL CHECK (payment_type IN ('SETUP', 'FIRST_RENT', 'MONTHLY_RENT')),
  amount_cents INTEGER NOT NULL CHECK (
    (payment_type = 'SETUP' AND amount_cents = 50000) OR
    (payment_type IN ('FIRST_RENT', 'MONTHLY_RENT') AND amount_cents = 8000)
  ),
  currency TEXT NOT NULL DEFAULT 'MXN' CHECK (currency = 'MXN'),
  status TEXT NOT NULL CHECK (status IN ('PENDING_VERIFICATION', 'CONFIRMED', 'REJECTED')),
  reference TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  confirmed_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_payments_license_status
  ON payments(license_id, status, payment_type);

CREATE TABLE IF NOT EXISTS weekly_usage (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id),
  week_key TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0 CHECK (used BETWEEN 0 AND 20),
  updated_at INTEGER NOT NULL,
  UNIQUE(device_id, week_key)
);

CREATE INDEX IF NOT EXISTS idx_weekly_usage_device_week
  ON weekly_usage(device_id, week_key);

CREATE TABLE IF NOT EXISTS replacement_requests (
  id TEXT PRIMARY KEY,
  license_id TEXT NOT NULL REFERENCES licenses(id),
  old_device_id TEXT NOT NULL REFERENCES devices(id),
  slot_number INTEGER NOT NULL CHECK (slot_number BETWEEN 1 AND 3),
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_replacements_license_status
  ON replacement_requests(license_id, status);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  license_id TEXT REFERENCES licenses(id),
  device_id TEXT REFERENCES devices(id),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('operator', 'patron', 'ventas', 'system')),
  actor_id TEXT,
  event_type TEXT NOT NULL,
  details_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_license_created
  ON audit_log(license_id, created_at);
