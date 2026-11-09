-- SENE turn reports, payroll summaries and worker requests.
-- Additive only: existing licensing/correction data is preserved.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS work_requests (
  id TEXT PRIMARY KEY,
  license_id TEXT NOT NULL REFERENCES licenses(id),
  ventas_device_id TEXT NOT NULL REFERENCES devices(id),
  request_type TEXT NOT NULL CHECK (request_type IN (
    'LOAN','CONSUMPTION','ABSENCE_PERMISSION','LATE_ARRIVAL',
    'SCHEDULE_CHANGE','VACATION','INCIDENT','SHORTAGE',
    'REST_DAY_CHANGE','SALARY_ADVANCE','DAMAGED_EQUIPMENT','SUGGESTION'
  )),
  details_json TEXT NOT NULL CHECK (length(details_json) <= 8192),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','cancelled')),
  decision_json TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by_device_id TEXT REFERENCES devices(id),
  idempotency_key TEXT NOT NULL,
  UNIQUE (ventas_device_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_work_requests_team_status
  ON work_requests(license_id, ventas_device_id, status, created_at);

CREATE TABLE IF NOT EXISTS shift_reports (
  id TEXT PRIMARY KEY,
  license_id TEXT NOT NULL REFERENCES licenses(id),
  ventas_device_id TEXT NOT NULL REFERENCES devices(id),
  shift_key TEXT NOT NULL,
  report_json TEXT NOT NULL CHECK (length(report_json) <= 16384),
  created_at INTEGER NOT NULL,
  UNIQUE (ventas_device_id, shift_key)
);

CREATE INDEX IF NOT EXISTS idx_shift_reports_team_date
  ON shift_reports(license_id, ventas_device_id, created_at);

CREATE TABLE IF NOT EXISTS payroll_reports (
  id TEXT PRIMARY KEY,
  license_id TEXT NOT NULL REFERENCES licenses(id),
  ventas_device_id TEXT NOT NULL REFERENCES devices(id),
  period_key TEXT NOT NULL,
  report_json TEXT NOT NULL CHECK (length(report_json) <= 16384),
  created_at INTEGER NOT NULL,
  UNIQUE (ventas_device_id, period_key)
);

CREATE INDEX IF NOT EXISTS idx_payroll_reports_team_period
  ON payroll_reports(license_id, ventas_device_id, period_key);

CREATE INDEX IF NOT EXISTS idx_work_requests_notifications
  ON work_requests(license_id, ventas_device_id, status, created_at);
