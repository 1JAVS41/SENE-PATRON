-- Fixed-slot, single-use QR pairing with encrypted recovery.
PRAGMA foreign_keys = ON;
ALTER TABLE pairing_tokens ADD COLUMN slot_number INTEGER CHECK (slot_number IN (2,3));
ALTER TABLE pairing_tokens ADD COLUMN operation TEXT CHECK (operation IN ('NEW','REPLACEMENT'));
ALTER TABLE pairing_tokens ADD COLUMN encrypted_token TEXT;
ALTER TABLE pairing_tokens ADD COLUMN consumed_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_pairing_pending_slot
  ON pairing_tokens(license_id, patron_device_id, slot_number, operation, created_at DESC)
  WHERE remaining_uses = 1 AND revoked_at IS NULL AND consumed_at IS NULL;
