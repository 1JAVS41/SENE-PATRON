-- Rebuild devices to retain revoked installations while allowing one active device per slot.
-- D1 runs each migration in a transaction; defer FK checks while the parent table is rebuilt.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE devices_new (
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
  UNIQUE (license_id, fingerprint)
);

INSERT INTO devices_new (
  id, license_id, device_type, installation_id, continuity_id,
  public_key, fingerprint, slot_number, status, created_at, last_seen_at
)
SELECT
  id, license_id, device_type, installation_id, continuity_id,
  public_key, fingerprint, slot_number, status, created_at, last_seen_at
FROM devices;

DROP TABLE devices;
ALTER TABLE devices_new RENAME TO devices;

CREATE INDEX idx_devices_license_status ON devices(license_id, status);
CREATE UNIQUE INDEX idx_devices_one_active_per_slot
  ON devices(license_id, slot_number)
  WHERE status = 'active';
