from pathlib import Path
import sqlite3

db = sqlite3.connect(":memory:")
db.execute("PRAGMA foreign_keys=ON")
for migration in sorted(Path("cloudflare/sene-api/migrations").glob("*.sql")):
    db.executescript(migration.read_text())

db.execute("""INSERT INTO licenses
    (id,business_name,status,max_devices,created_at,expires_at,registered_email,registered_phone)
    VALUES ('lic-admin-events','TIENDA EVENTOS','active',3,1,9999999999,'owner@example.invalid','5211111111111')""")
db.executemany("""INSERT INTO devices
    (id,license_id,device_type,installation_id,continuity_id,public_key,fingerprint,slot_number,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)""", [
    ('patron-admin-events','lic-admin-events','PATRON','install-p','continuity-p',b'patron','fp-p',1,'active',1),
    ('ventas-admin-events','lic-admin-events','VENTAS','install-v','continuity-v',b'ventas','fp-v',2,'active',1)
])

db.execute("""INSERT INTO registration_requests
    (id,business_name,normalized_name,installation_id,fingerprint,status,created_at,registered_email,registered_phone)
    VALUES ('reg-admin-events','TIENDA EVENTOS','tienda eventos','install-reg','fp-reg','pending_payment',10,'owner@example.invalid','5211111111111')""")
db.execute("""INSERT INTO renewal_requests
    (id,license_id,patron_device_id,business_name,status,created_at)
    VALUES ('renew-admin-events','lic-admin-events','patron-admin-events','TIENDA EVENTOS','pending_payment',11)""")
db.execute("""INSERT INTO replacement_requests
    (id,license_id,old_device_id,slot_number,reason,status,created_at)
    VALUES ('replace-admin-events','lic-admin-events','ventas-admin-events',2,'equipo perdido','pending',12)""")
db.execute("""INSERT INTO replacement_payment_requests
    (id,replacement_request_id,license_id,old_device_id,slot_number,status,created_at)
    VALUES ('replace-payment-admin-events','replace-admin-events','lic-admin-events','ventas-admin-events',2,'pending_payment',13)""")
db.execute("""INSERT INTO patron_recovery_payment_requests
    (id,license_id,old_patron_device_id,installation_id,fingerprint,registered_email,registered_phone,status,created_at)
    VALUES ('recovery-admin-events','lic-admin-events','patron-admin-events','install-new','fp-new','owner@example.invalid','5211111111111','pending_payment',14)""")

counts = dict(db.execute(
    "SELECT event_type,COUNT(*) FROM admin_event_outbox GROUP BY event_type"
).fetchall())
expected = {
    "registration_requested": 1,
    "renewal_requested": 1,
    "replacement_payment_requested": 1,
    "patron_recovery_payment_requested": 1
}
assert counts == expected, (counts, expected)

# Lifecycle transitions must notify ADMIN only after the durable state changes.
db.execute("""INSERT INTO payments
    (id,license_id,payment_type,amount_cents,currency,status,reference,idempotency_key,created_at,confirmed_at,confirmed_by)
    VALUES ('payment-admin-events','lic-admin-events','MONTHLY_RENT',8000,'MXN','CONFIRMED',
            'PAY-8000','payment-admin-events-key',20,20,'operator')""")
db.execute("""UPDATE registration_requests SET status='authorized',license_id='lic-admin-events',
    code_hash='registration-code-hash',payment_reference='PAY-580',authorized_at=21
    WHERE id='reg-admin-events' AND status='pending_payment'""")
db.execute("""UPDATE renewal_requests SET status='authorized',code_hash='renewal-code-hash',
    payment_reference='PAY-80',authorized_at=22,authorized_by='operator'
    WHERE id='renew-admin-events' AND status='pending_payment'""")
db.execute("""UPDATE replacement_payment_requests SET status='authorized',code_hash='replacement-code-hash',
    encrypted_code='encrypted-code',delivery_phone='5211111111111',
    payment_reference='PAY-500',authorized_at=23
    WHERE id='replace-payment-admin-events' AND status='pending_payment'""")
db.execute("""UPDATE patron_recovery_payment_requests SET status='authorized',code_hash='recovery-code-hash',
    encrypted_code='encrypted-recovery-code',delivery_phone='5211111111111',
    payment_reference='PAY-500-P',authorized_at=24
    WHERE id='recovery-admin-events' AND status='pending_payment'""")
db.execute("""UPDATE replacement_requests SET status='approved',decided_at=25,decided_by='operator'
    WHERE id='replace-admin-events' AND status='pending'""")
db.execute("""UPDATE licenses SET status='expired',expires_at=8888
    WHERE id='lic-admin-events' AND status='active'""")
db.execute("""INSERT INTO audit_log
    (id,license_id,device_id,actor_type,actor_id,event_type,details_json,created_at)
    VALUES ('audit-admin-events','lic-admin-events',NULL,'operator','operator',
            'manual_review_completed','{}',26)""")
db.execute("""INSERT INTO official_support_contacts
    (id,official_email,help_phone_1,help_phone_2,revision,registered_at,updated_at,updated_by)
    VALUES (1,'ayuda@example.invalid','+5211111111111','+5222222222222',1,30,30,'operator-bootstrap')""")
db.execute("""UPDATE official_support_contacts SET official_email='ayuda2@example.invalid',
    revision=2,updated_at=31,updated_by='operator-approved' WHERE id=1 AND revision=1""")

lifecycle_counts = dict(db.execute(
    "SELECT event_type,COUNT(*) FROM admin_event_outbox GROUP BY event_type"
).fetchall())
expected_lifecycle = {
    "payment_status_changed": 1,
    "registration_status_changed": 1,
    "renewal_status_changed": 1,
    "replacement_payment_status_changed": 1,
    "patron_recovery_status_changed": 1,
    "replacement_status_changed": 1,
    "license_status_changed": 1,
    "license_period_changed": 1,
    "audit_recorded": 1,
    "official_support_configuration_changed": 2
}
for event_type, count in expected_lifecycle.items():
    assert lifecycle_counts.get(event_type, 0) == count, (event_type, lifecycle_counts)
rows = db.execute("SELECT payload_json FROM admin_event_outbox").fetchall()
assert all(row[0] and len(row[0]) > 2 for row in rows)
issued_columns = {row[1] for row in db.execute("PRAGMA table_info(delivery_issued)")}
assert {"device_id", "license_id", "stream", "delivery_id", "payload_sha256", "cursor", "issued_at", "acknowledged_at"} <= issued_columns
issued_indexes = {row[1] for row in db.execute("PRAGMA index_list(delivery_issued)")}
assert "idx_delivery_issued_unacked" in issued_indexes
assert "idx_delivery_issued_ack_retention" in issued_indexes
assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
assert not db.execute("PRAGMA foreign_key_check").fetchall()
print("PASS: altas, pagos, renovaciones, reposiciones, recuperaciones, vencimientos, auditoría y configuración generan eventos ADMIN durables")
