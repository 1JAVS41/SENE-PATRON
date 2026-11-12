-- Keep ADMIN's audit feed strictly administrative.
-- Worker/PATRON operational events (corrections, payroll settings, device use)
-- must never be copied into the ADMIN notification stream.
DROP TRIGGER IF EXISTS trg_admin_event_audit_record;

CREATE TRIGGER trg_admin_event_audit_record
AFTER INSERT ON audit_log
WHEN NEW.actor_type IN ('operator','system')
BEGIN
  INSERT INTO admin_event_outbox (event_id,event_type,license_id,payload_json,created_at)
  VALUES (lower(hex(randomblob(16))),'audit_recorded',NEW.license_id,
    json_object('auditId',NEW.id,'actorType',NEW.actor_type,'eventType',NEW.event_type,
      'deviceId',NEW.device_id,'createdAt',NEW.created_at),NEW.created_at);
END;
