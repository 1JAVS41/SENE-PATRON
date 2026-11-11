-- Contact details required for initial business registration and owner recovery.
ALTER TABLE registration_requests ADD COLUMN registered_email TEXT;
ALTER TABLE registration_requests ADD COLUMN registered_phone TEXT;
