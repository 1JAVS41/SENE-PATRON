-- Extend the durable ADMIN outbox to confirmed payments, lifecycle decisions,
-- expirations, audit records and official support configuration changes.
PRAGMA foreign_keys = ON;

CREATE TRIGGER IF NOT EXISTS trg_admin_event_payment_insert
AFTER INSERT ON payments
WHEN NEW.status IN ('CONFIRMED','REJECTED')
BEGIN
  INSERT INTO admin_event_outbox (event_id,event_type,license_id,payload_json,created_at)
  VALUES (lower(hex(randomblob(16))),'payment_status_changed',NEW.license_id,
    json_object('paymentId',NEW.id,'paymentType',NEW.payment_type,'amountCents',NEW.amount_cents,
      'currency',NEW.currency,'status',NEW.status,'reference',NEW.reference,
      'confirmedAt',NEW.confirmed_at),COALESCE(NEW.confirmed_at,NEW.created_at));
END;

CREATE TRIGGER IF NOT EXISTS trg_admin_event_payment_update
AFTER UPDATE OF status ON payments
WHEN OLD.status <> NEW.status
BEGIN
  INSERT INTO admin_event_outbox (event_id,event_type,license_id,payload_json,created_at)
  VALUES (lower(hex(randomblob(16))),'payment_status_changed',NEW.license_id,
    json_object('paymentId',NEW.id,'paymentType',NEW.payment_type,'amountCents',NEW.amount_cents,
      'currency',NEW.currency,'status',NEW.status,'reference',NEW.reference,
      'confirmedAt',NEW.confirmed_at),COALESCE(NEW.confirmed_at,NEW.created_at));
END;

CREATE TRIGGER IF NOT EXISTS trg_admin_event_registration_transition
AFTER UPDATE OF status ON registration_requests
WHEN OLD.status <> NEW.status AND NEW.status IN ('authorized','consumed','cancelled')
BEGIN
  INSERT INTO admin_event_outbox (event_id,event_type,license_id,payload_json,created_at)
  VALUES (lower(hex(randomblob(16))),'registration_status_changed',NEW.license_id,
    json_object('requestId',NEW.id,'businessName',NEW.business_name,
      'status',NEW.status,'paymentReference',NEW.payment_reference,'updatedAt',
      COALESCE(NEW.consumed_at,NEW.authorized_at,NEW.cancelled_at)), 
    COALESCE(NEW.consumed_at,NEW.authorized_at,NEW.cancelled_at,NEW.created_at));
END;

CREATE TRIGGER IF NOT EXISTS trg_admin_event_renewal_transition
AFTER UPDATE OF status ON renewal_requests
WHEN OLD.status <> NEW.status AND NEW.status IN ('authorized','consumed','cancelled')
BEGIN
  INSERT INTO admin_event_outbox (event_id,event_type,license_id,payload_json,created_at)
  VALUES (lower(hex(randomblob(16))),'renewal_status_changed',NEW.license_id,
    json_object('requestId',NEW.id,'status',NEW.status,'paymentReference',NEW.payment_reference,
      'updatedAt',COALESCE(NEW.consumed_at,NEW.authorized_at,NEW.cancelled_at)),
    COALESCE(NEW.consumed_at,NEW.authorized_at,NEW.cancelled_at,NEW.created_at));
END;

CREATE TRIGGER IF NOT EXISTS trg_admin_event_replacement_transition
AFTER UPDATE OF status ON replacement_requests
WHEN OLD.status <> NEW.status AND NEW.status IN ('approved','rejected')
BEGIN
  INSERT INTO admin_event_outbox (event_id,event_type,license_id,payload_json,created_at)
  VALUES (lower(hex(randomblob(16))),'replacement_status_changed',NEW.license_id,
    json_object('requestId',NEW.id,'slotNumber',NEW.slot_number,
      'status',NEW.status,'decidedAt',NEW.decided_at,'decidedBy',NEW.decided_by),
    COALESCE(NEW.decided_at,NEW.created_at));
END;

CREATE TRIGGER IF NOT EXISTS trg_admin_event_replacement_payment_transition
AFTER UPDATE OF status ON replacement_payment_requests
WHEN OLD.status <> NEW.status AND NEW.status IN ('authorized','consumed','cancelled')
BEGIN
  INSERT INTO admin_event_outbox (event_id,event_type,license_id,payload_json,created_at)
  VALUES (lower(hex(randomblob(16))),'replacement_payment_status_changed',NEW.license_id,
    json_object('paymentRequestId',NEW.id,'requestId',NEW.replacement_request_id,
      'slotNumber',NEW.slot_number,'status',NEW.status,'paymentReference',NEW.payment_reference,
      'updatedAt',COALESCE(NEW.consumed_at,NEW.authorized_at)),
    COALESCE(NEW.consumed_at,NEW.authorized_at,NEW.created_at));
END;

CREATE TRIGGER IF NOT EXISTS trg_admin_event_patron_recovery_transition
AFTER UPDATE OF status ON patron_recovery_payment_requests
WHEN OLD.status <> NEW.status AND NEW.status IN ('authorized','consumed','cancelled')
BEGIN
  INSERT INTO admin_event_outbox (event_id,event_type,license_id,payload_json,created_at)
  VALUES (lower(hex(randomblob(16))),'patron_recovery_status_changed',NEW.license_id,
    json_object('requestId',NEW.id,'status',NEW.status,'paymentReference',NEW.payment_reference,
      'updatedAt',COALESCE(NEW.consumed_at,NEW.authorized_at)),
    COALESCE(NEW.consumed_at,NEW.authorized_at,NEW.created_at));
END;

CREATE TRIGGER IF NOT EXISTS trg_admin_event_license_status
AFTER UPDATE OF status ON licenses
WHEN OLD.status <> NEW.status AND NEW.status IN ('active','expired','suspended','revoked')
BEGIN
  INSERT INTO admin_event_outbox (event_id,event_type,license_id,payload_json,created_at)
  VALUES (lower(hex(randomblob(16))),'license_status_changed',NEW.id,
    json_object('businessName',NEW.business_name,'status',NEW.status,
      'expiresAt',NEW.expires_at,'updatedAt',unixepoch()),unixepoch());
END;

CREATE TRIGGER IF NOT EXISTS trg_admin_event_license_expiry
AFTER UPDATE OF expires_at ON licenses
WHEN NEW.expires_at IS NOT NULL AND (OLD.expires_at IS NULL OR NEW.expires_at <> OLD.expires_at)
BEGIN
  INSERT INTO admin_event_outbox (event_id,event_type,license_id,payload_json,created_at)
  VALUES (lower(hex(randomblob(16))),'license_period_changed',NEW.id,
    json_object('businessName',NEW.business_name,'status',NEW.status,
      'expiresAt',NEW.expires_at,'updatedAt',unixepoch()),unixepoch());
END;

CREATE TRIGGER IF NOT EXISTS trg_admin_event_audit_record
AFTER INSERT ON audit_log
BEGIN
  INSERT INTO admin_event_outbox (event_id,event_type,license_id,payload_json,created_at)
  VALUES (lower(hex(randomblob(16))),'audit_recorded',NEW.license_id,
    json_object('auditId',NEW.id,'actorType',NEW.actor_type,'eventType',NEW.event_type,
      'deviceId',NEW.device_id,'createdAt',NEW.created_at),NEW.created_at);
END;

CREATE TRIGGER IF NOT EXISTS trg_admin_event_support_configuration
AFTER INSERT ON official_support_contacts_audit
BEGIN
  INSERT INTO admin_event_outbox (event_id,event_type,license_id,payload_json,created_at)
  VALUES (lower(hex(randomblob(16))),'official_support_configuration_changed',NULL,
    json_object('revision',NEW.revision,'action',NEW.action,'actor',NEW.actor,
      'createdAt',NEW.created_at),NEW.created_at);
END;
