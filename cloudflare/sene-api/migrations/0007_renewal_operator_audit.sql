-- Metadata for the private operator who issued/reissued a renewal code.
ALTER TABLE renewal_requests ADD COLUMN authorized_by TEXT;
