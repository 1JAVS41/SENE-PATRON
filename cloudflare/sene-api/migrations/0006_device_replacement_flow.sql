-- Enforce a single pending replacement per lost installation and per license slot.
-- The device remains active until the private operator approves the request.
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_pending_replacement_device
  ON replacement_requests(old_device_id)
  WHERE status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_pending_replacement_slot
  ON replacement_requests(license_id, slot_number)
  WHERE status = 'pending';
