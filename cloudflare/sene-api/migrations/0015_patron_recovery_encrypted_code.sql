-- Recoverable one-time code delivery for paid PATRON device replacement.
ALTER TABLE patron_recovery_payment_requests ADD COLUMN encrypted_code TEXT;
ALTER TABLE patron_recovery_payment_requests ADD COLUMN delivery_phone TEXT;
