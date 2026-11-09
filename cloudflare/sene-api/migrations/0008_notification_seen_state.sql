-- Track whether each pending request notification has been seen by PATRON.
-- The business request remains pending until an explicit approve/reject decision.
ALTER TABLE work_requests ADD COLUMN seen_at INTEGER;
ALTER TABLE correction_requests ADD COLUMN seen_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_work_requests_unseen
  ON work_requests(license_id, ventas_device_id, status, seen_at);

CREATE INDEX IF NOT EXISTS idx_correction_requests_unseen
  ON correction_requests(license_id, ventas_device_id, status, seen_at);
