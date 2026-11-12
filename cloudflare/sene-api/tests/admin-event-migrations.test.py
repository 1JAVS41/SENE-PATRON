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
rows = db.execute("SELECT payload_json FROM admin_event_outbox").fetchall()
assert all(row[0] and len(row[0]) > 2 for row in rows)
assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
assert not db.execute("PRAGMA foreign_key_check").fetchall()
print("PASS: los cuatro flujos comerciales generan eventos administrativos durables, sin datos operativos de VENTAS")
