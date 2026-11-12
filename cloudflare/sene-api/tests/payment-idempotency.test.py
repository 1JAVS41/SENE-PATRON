from pathlib import Path
import sqlite3

db = sqlite3.connect(":memory:")
db.execute("PRAGMA foreign_keys=ON")
for migration in sorted(Path("cloudflare/sene-api/migrations").glob("*.sql")):
    db.executescript(migration.read_text())

db.execute("""INSERT INTO licenses (id,business_name,status,max_devices,created_at)
    VALUES ('lic-payment-test','TIENDA PAGOS','pending',3,1)""")
db.execute("""INSERT INTO devices
    (id,license_id,device_type,installation_id,continuity_id,public_key,fingerprint,slot_number,status,created_at)
    VALUES ('patron-payment-test','lic-payment-test','PATRON','install','continuity',x'01','fp',1,'active',1)""")

def insert_payment(payment_id, payment_type, amount, key, created_at):
    db.execute("""INSERT INTO payments
        (id,license_id,payment_type,amount_cents,currency,status,reference,idempotency_key,
         created_at,confirmed_at,confirmed_by)
        VALUES (?,?,?,?,'MXN','CONFIRMED','TRANSFER-REF',?,?,?,'operator')""",
        (payment_id,'lic-payment-test',payment_type,amount,'MXN',key,created_at,created_at))

insert_payment('setup-payment','SETUP',50000,'initial-setup:lic-payment-test',10)
insert_payment('first-rent-payment','FIRST_RENT',8000,'initial-rent:lic-payment-test',10)
try:
    insert_payment('setup-payment-duplicate','SETUP',50000,'initial-setup:lic-payment-test',11)
    raise AssertionError("El pago inicial duplicado no debe insertarse")
except sqlite3.IntegrityError:
    pass

db.execute("""INSERT INTO renewal_requests
    (id,license_id,patron_device_id,business_name,status,created_at)
    VALUES ('renewal-payment-test','lic-payment-test','patron-payment-test',
            'TIENDA PAGOS','pending_payment',12)""")
db.execute("""UPDATE renewal_requests SET status='authorized',code_hash='renewal-hash',
    payment_reference='TRANSFER-80',authorized_at=13,authorized_by='operator'
    WHERE id='renewal-payment-test' AND status='pending_payment'""")
insert_payment('renewal-payment','MONTHLY_RENT',8000,'renewal:renewal-payment-test',13)
try:
    insert_payment('renewal-payment-duplicate','MONTHLY_RENT',8000,
                   'renewal:renewal-payment-test',14)
    raise AssertionError("La renovación duplicada no debe cobrarse dos veces")
except sqlite3.IntegrityError:
    pass

# A one-time authorization can be consumed once; retries cannot consume it again.
first = db.execute("""UPDATE renewal_requests SET status='consumed',consumed_at=20
    WHERE id='renewal-payment-test' AND status='authorized' AND code_hash='renewal-hash'""")
second = db.execute("""UPDATE renewal_requests SET status='consumed',consumed_at=21
    WHERE id='renewal-payment-test' AND status='authorized' AND code_hash='renewal-hash'""")
assert first.rowcount == 1 and second.rowcount == 0
assert db.execute("SELECT COUNT(*) FROM payments WHERE license_id='lic-payment-test'").fetchone()[0] == 3
assert db.execute("SELECT COUNT(*) FROM payments WHERE idempotency_key='initial-setup:lic-payment-test'").fetchone()[0] == 1
assert db.execute("SELECT COUNT(*) FROM payments WHERE idempotency_key='renewal:renewal-payment-test'").fetchone()[0] == 1
assert db.execute("PRAGMA integrity_check").fetchone()[0] == 'ok'
assert not db.execute("PRAGMA foreign_key_check").fetchall()
print("PASS: alta $580 separada en $500+$80, renovación $80 y códigos de un solo uso sin cobros duplicados")
