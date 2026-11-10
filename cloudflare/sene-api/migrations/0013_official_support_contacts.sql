-- SENE official support contacts.
-- The singleton row is created only during the first real operator registration.
-- Runtime writes must go through the authenticated Worker admin flow, which
-- records each approved change in official_support_contacts_audit.
CREATE TABLE IF NOT EXISTS official_support_contacts (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  official_email TEXT NOT NULL CHECK (length(trim(official_email)) BETWEEN 3 AND 254),
  help_phone_1 TEXT NOT NULL CHECK (length(help_phone_1) BETWEEN 8 AND 20),
  help_phone_2 TEXT NOT NULL CHECK (length(help_phone_2) BETWEEN 8 AND 20),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  registered_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL CHECK (length(trim(updated_by)) BETWEEN 1 AND 128),
  CHECK (help_phone_1 <> help_phone_2)
);

CREATE TABLE IF NOT EXISTS official_support_contacts_audit (
  revision INTEGER PRIMARY KEY CHECK (revision >= 1),
  action TEXT NOT NULL CHECK (action IN ('INITIAL_REGISTRATION', 'AUTHORIZED_UPDATE')),
  official_email TEXT NOT NULL,
  help_phone_1 TEXT NOT NULL,
  help_phone_2 TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Never allow deletion of the master contact record through ordinary SQL.
-- Authorized changes are updates through the Worker and must append an audit row.
CREATE TRIGGER IF NOT EXISTS prevent_official_support_contacts_delete
BEFORE DELETE ON official_support_contacts
BEGIN
  SELECT RAISE(ABORT, 'OFFICIAL_SUPPORT_CONTACTS_CANNOT_BE_DELETED');
END;
