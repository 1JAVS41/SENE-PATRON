CREATE TABLE IF NOT EXISTS admin_event_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  license_id TEXT,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admin_event_outbox_created
  ON admin_event_outbox(id, created_at);

CREATE TABLE IF NOT EXISTS admin_event_cursors (
  session_id TEXT PRIMARY KEY,
  last_cursor INTEGER NOT NULL DEFAULT 0 CHECK (last_cursor >= 0),
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES admin_sessions(session_id)
);

CREATE TABLE IF NOT EXISTS admin_event_acknowledgements (
  ack_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  from_cursor INTEGER NOT NULL,
  through_cursor INTEGER NOT NULL,
  delivery_id TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
  request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
  acknowledged_at INTEGER NOT NULL,
  UNIQUE (session_id, through_cursor),
  FOREIGN KEY (session_id) REFERENCES admin_sessions(session_id)
);

CREATE TRIGGER IF NOT EXISTS trg_admin_event_registration
AFTER INSERT ON registration_requests
WHEN NEW.status = 'pending_payment'
BEGIN
  INSERT INTO admin_event_outbox (event_id,event_type,license_id,payload_json,created_at)
  VALUES (
    lower(hex(randomblob(16))),
    'registration_requested',
    NULL,
    json_object(
      'requestId',NEW.id,'businessName',NEW.business_name,
      'registeredEmail',NEW.registered_email,'registeredPhone',NEW.registered_phone,
      'status',NEW.status,'createdAt',NEW.created_at
    ),
    NEW.created_at
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_admin_event_renewal
AFTER INSERT ON renewal_requests
WHEN NEW.status = 'pending_payment'
BEGIN
  INSERT INTO admin_event_outbox (event_id,event_type,license_id,payload_json,created_at)
  VALUES (
    lower(hex(randomblob(16))),
    'renewal_requested',
    NEW.license_id,
    json_object(
      'requestId',NEW.id,'licenseId',NEW.license_id,
      'businessName',(SELECT business_name FROM licenses WHERE id=NEW.license_id),
      'status',NEW.status,'createdAt',NEW.created_at
    ),
    NEW.created_at
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_admin_event_replacement
AFTER INSERT ON replacement_payment_requests
WHEN NEW.status = 'pending_payment'
BEGIN
  INSERT INTO admin_event_outbox (event_id,event_type,license_id,payload_json,created_at)
  VALUES (
    lower(hex(randomblob(16))),
    'replacement_payment_requested',
    (SELECT license_id FROM replacement_requests WHERE id=NEW.replacement_request_id),
    json_object(
      'requestId',NEW.replacement_request_id,'paymentRequestId',NEW.id,
      'licenseId',(SELECT license_id FROM replacement_requests WHERE id=NEW.replacement_request_id),
      'status',NEW.status,'createdAt',NEW.created_at
    ),
    NEW.created_at
  );
END;

CREATE TRIGGER IF NOT EXISTS trg_admin_event_patron_recovery
AFTER INSERT ON patron_recovery_payment_requests
WHEN NEW.status = 'pending_payment'
BEGIN
  INSERT INTO admin_event_outbox (event_id,event_type,license_id,payload_json,created_at)
  VALUES (
    lower(hex(randomblob(16))),
    'patron_recovery_payment_requested',
    NEW.license_id,
    json_object(
      'requestId',NEW.id,'licenseId',NEW.license_id,
      'businessName',(SELECT business_name FROM licenses WHERE id=NEW.license_id),
      'status',NEW.status,'createdAt',NEW.created_at
    ),
    NEW.created_at
  );
END;
