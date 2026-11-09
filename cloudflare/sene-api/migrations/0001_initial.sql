PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS licenses (
  id TEXT PRIMARY KEY,
  label TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'expired', 'suspended', 'revoked')),
  max_devices INTEGER NOT NULL DEFAULT 3 CHECK (max_devices = 3),
  activation_code_hash TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  expires_at INTEGER
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  license_id TEXT NOT NULL REFERENCES licenses(id),
  device_type TEXT NOT NULL CHECK (device_type IN ('PATRON', 'VENTAS')),
  installation_id TEXT NOT NULL,
  continuity_id TEXT NOT NULL,
  public_key BLOB NOT NULL,
  fingerprint TEXT NOT NULL,
  slot_number INTEGER NOT NULL CHECK (slot_number BETWEEN 1 AND 3),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'replacement_pending')),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  UNIQUE (license_id, slot_number),
  UNIQUE (license_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS pairing_tokens (
  token_hash TEXT PRIMARY KEY,
  license_id TEXT NOT NULL REFERENCES licenses(id),
  patron_device_id TEXT NOT NULL REFERENCES devices(id),
  remaining_uses INTEGER NOT NULL DEFAULT 2 CHECK (remaining_uses BETWEEN 0 AND 2),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  purpose TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE TABLE IF NOT EXISTS correction_requests (
  id TEXT PRIMARY KEY,
  license_id TEXT NOT NULL REFERENCES licenses(id),
  ventas_device_id TEXT NOT NULL REFERENCES devices(id),
  sale_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'consumed', 'cancelled')),
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);

CREATE TABLE IF NOT EXISTS correction_grants (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES correction_requests(id),
  license_id TEXT NOT NULL REFERENCES licenses(id),
  ventas_device_id TEXT NOT NULL REFERENCES devices(id),
  sale_id TEXT NOT NULL,
  uses_allowed INTEGER NOT NULL DEFAULT 1 CHECK (uses_allowed = 1),
  uses_consumed INTEGER NOT NULL DEFAULT 0 CHECK (uses_consumed BETWEEN 0 AND 1),
  created_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_devices_license_status ON devices(license_id, status);
CREATE INDEX IF NOT EXISTS idx_requests_license_status ON correction_requests(license_id, status);
CREATE INDEX IF NOT EXISTS idx_grants_device_sale ON correction_grants(ventas_device_id, sale_id, uses_consumed);
