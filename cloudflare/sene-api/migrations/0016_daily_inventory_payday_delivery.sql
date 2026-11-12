-- Daily VENTAS inventory snapshots and one-time PATRON payday delivery.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS daily_inventory_snapshots (
  id TEXT PRIMARY KEY,
  license_id TEXT NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  ventas_device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  inventory_date TEXT NOT NULL CHECK (length(inventory_date) = 10),
  snapshot_json TEXT NOT NULL CHECK (length(snapshot_json) <= 32768),
  updated_at INTEGER NOT NULL,
  UNIQUE (ventas_device_id, inventory_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_inventory_license_date
  ON daily_inventory_snapshots(license_id, inventory_date, updated_at);

CREATE TABLE IF NOT EXISTS payday_deliveries (
  id TEXT PRIMARY KEY,
  license_id TEXT NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  payment_date TEXT NOT NULL CHECK (length(payment_date) = 10),
  payload_json TEXT NOT NULL CHECK (length(payload_json) <= 131072),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','acked')),
  created_at INTEGER NOT NULL,
  acked_at INTEGER,
  UNIQUE (license_id, payment_date)
);
