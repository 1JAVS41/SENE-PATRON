-- Register the exact response package issued to each authenticated device.
-- ACKs are accepted only for a package the Worker actually emitted.
CREATE TABLE IF NOT EXISTS delivery_issued (
  device_id TEXT NOT NULL,
  license_id TEXT NOT NULL,
  stream TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  cursor INTEGER NOT NULL,
  issued_at INTEGER NOT NULL,
  acknowledged_at INTEGER,
  PRIMARY KEY (device_id, stream, delivery_id)
);

CREATE INDEX IF NOT EXISTS idx_delivery_issued_unacked
  ON delivery_issued(device_id, stream, acknowledged_at, issued_at);
