from pathlib import Path
import json
import sqlite3

db = sqlite3.connect(":memory:")
db.execute("PRAGMA foreign_keys=ON")
for migration in sorted(Path("cloudflare/sene-api/migrations").glob("*.sql")):
    db.executescript(migration.read_text())

db.execute("""INSERT INTO licenses (id,business_name,status,max_devices,created_at,expires_at)
    VALUES ('lic-payday','TIENDA PAYDAY','active',3,1,9999999999)""")
db.executemany("""INSERT INTO devices
    (id,license_id,device_type,installation_id,continuity_id,public_key,fingerprint,slot_number,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)""", [
    ('patron-payday','lic-payday','PATRON','ip','cp',b'p','fp-p',1,'active',1),
    ('ventas1-payday','lic-payday','VENTAS','iv1','cv1',b'v1','fp-v1',2,'active',1),
    ('ventas2-payday','lic-payday','VENTAS','iv2','cv2',b'v2','fp-v2',3,'active',1)
])
db.executemany("""INSERT INTO daily_inventory_snapshots
    (id,license_id,ventas_device_id,inventory_date,snapshot_json,updated_at)
    VALUES (?,?,?,?,?,?)""", [
    ('v1-old','lic-payday','ventas1-payday','2026-11-08','{"stock":8}',10),
    ('v1-latest','lic-payday','ventas1-payday','2026-11-10','{"stock":10}',20),
    ('v2-latest','lic-payday','ventas2-payday','2026-11-11','{"stock":20}',30),
    ('v1-future','lic-payday','ventas1-payday','2026-11-13','{"stock":13}',40)
])

# Mismo orden y selección del Worker: más reciente por slot, solo equipos con pago debido.
due_slots = [2]
rows = db.execute("""SELECT s.id,s.inventory_date,s.snapshot_json,s.updated_at,d.slot_number
    FROM daily_inventory_snapshots s JOIN devices d ON d.id=s.ventas_device_id
    WHERE s.license_id=? AND d.status IN ('active','revoked')
      AND d.device_type='VENTAS' AND d.slot_number IN (2,3)
      AND s.inventory_date>=? AND s.inventory_date<=?
    ORDER BY d.slot_number ASC,s.inventory_date DESC,s.updated_at DESC""",
    ('lic-payday','2026-11-06','2026-11-12')).fetchall()
latest = {}
for row in rows:
    if row[4] in due_slots and row[4] not in latest:
        latest[row[4]] = row
assert latest[2][0] == 'v1-latest'
payload = {
    "paymentDate": "2026-11-12",
    "inventories": [{
        "slot": "VENTAS_1", "inventoryDate": latest[2][1],
        "updatedAt": latest[2][3], "inventoryId": latest[2][0],
        "snapshot": json.loads(latest[2][2])
    }]
}
db.execute("""INSERT INTO payday_deliveries
    (id,license_id,payment_date,payload_json,status,created_at)
    VALUES ('payday-delivery','lic-payday','2026-11-12',?,'pending',50)""",
    (json.dumps(payload,separators=(',',':')),))

# Reproduce the Worker's ACK batch in one SQLite transaction.
db.execute("BEGIN")
db.execute("""UPDATE payday_deliveries SET status='acked',acked_at=60
    WHERE id='payday-delivery' AND license_id='lic-payday' AND status='pending'""")
db.execute("""DELETE FROM daily_inventory_snapshots
    WHERE license_id='lic-payday' AND inventory_date<='2026-11-12'
      AND ventas_device_id IN (
        SELECT s.ventas_device_id FROM daily_inventory_snapshots s
        WHERE s.id IN (
          SELECT json_extract(j.value,'$.inventoryId')
          FROM payday_deliveries p,json_each(p.payload_json,'$.inventories') j
          WHERE p.id='payday-delivery' AND p.license_id='lic-payday'
        )
      )""")
db.commit()

assert db.execute("SELECT status FROM payday_deliveries WHERE id='payday-delivery'").fetchone()[0] == 'acked'
assert db.execute("SELECT COUNT(*) FROM daily_inventory_snapshots WHERE ventas_device_id='ventas1-payday' AND inventory_date<='2026-11-12'").fetchone()[0] == 0
assert db.execute("SELECT COUNT(*) FROM daily_inventory_snapshots WHERE id='v2-latest'").fetchone()[0] == 1
assert db.execute("SELECT COUNT(*) FROM daily_inventory_snapshots WHERE id='v1-future'").fetchone()[0] == 1
assert db.execute("PRAGMA foreign_key_check").fetchall() == []
assert db.execute("PRAGMA integrity_check").fetchone()[0] == 'ok'
print("PASS: inventario más reciente seleccionado; ACK limpia solo el equipo entregado y conserva otros equipos y fechas futuras")
