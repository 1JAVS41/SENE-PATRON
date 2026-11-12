CREATE TABLE IF NOT EXISTS delivery_ack_cursors (
  device_id TEXT NOT NULL,
  stream TEXT NOT NULL,
  last_cursor INTEGER NOT NULL DEFAULT 0 CHECK (last_cursor >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, stream),
  FOREIGN KEY (device_id) REFERENCES devices(id)
);

CREATE INDEX IF NOT EXISTS idx_delivery_ack_cursors_updated
  ON delivery_ack_cursors(updated_at);
