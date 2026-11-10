-- SENE official support contacts. Singleton, server-managed and append-only audited.
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
CREATE TRIGGER IF NOT EXISTS audit_official_support_contacts_insert
AFTER INSERT ON official_support_contacts
BEGIN
  INSERT INTO official_support_contacts_audit
    (revision, action, official_email, help_phone_1, help_phone_2, actor, created_at)
  VALUES (NEW.revision, 'INITIAL_REGISTRATION', NEW.official_email, NEW.help_phone_1,
    NEW.help_phone_2, NEW.updated_by, NEW.updated_at);
END;
CREATE TRIGGER IF NOT EXISTS validate_official_support_contacts_update
BEFORE UPDATE ON official_support_contacts
BEGIN
  SELECT CASE WHEN OLD.id <> 1 OR NEW.id <> 1 OR NEW.revision <> OLD.revision + 1
    OR NEW.registered_at <> OLD.registered_at OR NEW.updated_at <= OLD.updated_at
    OR length(trim(NEW.updated_by)) NOT BETWEEN 1 AND 128
    THEN RAISE(ABORT, 'OFFICIAL_SUPPORT_CONTACTS_INVALID_REVISION') END;
END;
CREATE TRIGGER IF NOT EXISTS audit_official_support_contacts_update
AFTER UPDATE ON official_support_contacts
BEGIN
  INSERT INTO official_support_contacts_audit
    (revision, action, official_email, help_phone_1, help_phone_2, actor, created_at)
  VALUES (NEW.revision, 'AUTHORIZED_UPDATE', NEW.official_email, NEW.help_phone_1,
    NEW.help_phone_2, NEW.updated_by, NEW.updated_at);
END;
CREATE TRIGGER IF NOT EXISTS prevent_official_support_contacts_delete
BEFORE DELETE ON official_support_contacts
BEGIN SELECT RAISE(ABORT, 'OFFICIAL_SUPPORT_CONTACTS_CANNOT_BE_DELETED'); END;
CREATE TRIGGER IF NOT EXISTS prevent_official_support_contacts_audit_update
BEFORE UPDATE ON official_support_contacts_audit
BEGIN SELECT RAISE(ABORT, 'OFFICIAL_SUPPORT_CONTACTS_AUDIT_IS_APPEND_ONLY'); END;
CREATE TRIGGER IF NOT EXISTS prevent_official_support_contacts_audit_delete
BEFORE DELETE ON official_support_contacts_audit
BEGIN SELECT RAISE(ABORT, 'OFFICIAL_SUPPORT_CONTACTS_AUDIT_IS_APPEND_ONLY'); END;
