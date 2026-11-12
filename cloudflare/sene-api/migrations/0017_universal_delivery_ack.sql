-- Durable, idempotent recipient receipts for all SENE delivery streams.
-- This table stores compact receipts only; it deliberately does not delete
-- source payloads. Payload cleanup is enabled only after each delivery
-- producer/consumer has been wired to this receipt and its retention policy.
CREATE TABLE IF NOT EXISTS delivery_acknowledgements (
  ack_id TEXT PRIMARY KEY,
  license_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  stream TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  cursor INTEGER NOT NULL CHECK (cursor >= 0),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
  acknowledged_at INTEGER NOT NULL,
  UNIQUE (device_id, stream, delivery_id),
  FOREIGN KEY (license_id) REFERENCES licenses(id),
  FOREIGN KEY (device_id) REFERENCES devices(id)
);

CREATE INDEX IF NOT EXISTS idx_delivery_ack_license_time
  ON delivery_acknowledgements(license_id, acknowledged_at);

CREATE INDEX IF NOT EXISTS idx_delivery_ack_device_stream_cursor
  ON delivery_acknowledgements(device_id, stream, cursor);
