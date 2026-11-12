-- Efficiently prune only acknowledged universal delivery issue receipts.
-- Unacknowledged deliveries remain available for delayed/offline clients.
CREATE INDEX IF NOT EXISTS idx_delivery_issued_ack_retention
  ON delivery_issued(acknowledged_at, issued_at);
