-- Per-worker payroll settings, scoped to the two VENTAS license slots.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS payroll_settings (
  license_id TEXT NOT NULL REFERENCES licenses(id) ON DELETE CASCADE,
  slot_number INTEGER NOT NULL CHECK (slot_number IN (2, 3)),
  salary_cents INTEGER NOT NULL DEFAULT 0 CHECK (salary_cents >= 0 AND salary_cents <= 1000000000),
  payment_day INTEGER CHECK (payment_day IS NULL OR payment_day BETWEEN 1 AND 31),
  payment_dates_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL,
  updated_by_device_id TEXT REFERENCES devices(id),
  PRIMARY KEY (license_id, slot_number)
);

CREATE INDEX IF NOT EXISTS idx_payroll_settings_license
  ON payroll_settings(license_id, slot_number);
