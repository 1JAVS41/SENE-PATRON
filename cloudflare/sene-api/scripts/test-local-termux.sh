#!/usr/bin/env bash
# SENE PATRON - verificacion local sin GitHub Actions ni despliegues.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

API="cloudflare/sene-api"
WORKER="$API/src/worker.js"
WORKER_MJS="$API/src/worker.mjs"

for bin in node python3; do
  command -v "$bin" >/dev/null 2>&1 || {
    echo "FALTA: $bin. Instálalo en Termux con: pkg install $bin"
    exit 2
  }
done

echo "== SENE: comprobación local (sin red, sin secretos, sin despliegue) =="
node --version
python3 --version

if [[ ! -f "$WORKER" ]]; then
  echo "ERROR: no existe $WORKER"
  exit 2
fi

cleanup() { rm -f "$WORKER_MJS"; }
trap cleanup EXIT
cp "$WORKER" "$WORKER_MJS"

echo
echo "[1/4] Sintaxis del Worker"
node --check "$WORKER"

echo
echo "[2/4] Pruebas Node.js"
for test_file in \
  iso-date-validation.test.mjs \
  payday-immutability.test.mjs \
  payment-folio-contract.test.mjs \
  universal-ack.test.mjs \
  admin-auth.test.mjs
do
  echo "--- $test_file"
  node "$API/tests/$test_file"
done

echo
echo "[3/4] Pruebas Python"
for test_file in \
  payday-inventory-retention.test.py \
  payment-idempotency.test.py \
  admin-event-migrations.test.py
do
  echo "--- $test_file"
  python3 "$API/tests/$test_file"
done

echo
echo "[4/4] Todas las migraciones SQL en SQLite temporal"
python3 - "$API/migrations" <<'PY'
from pathlib import Path
import sqlite3
import sys

migration_dir = Path(sys.argv[1])
migrations = sorted(migration_dir.glob("*.sql"))
if not migrations:
    raise SystemExit("ERROR: no se encontraron migraciones SQL")

db = sqlite3.connect(":memory:")
db.execute("PRAGMA foreign_keys=ON")
for migration in migrations:
    print("Aplicando", migration.name)
    db.executescript(migration.read_text(encoding="utf-8"))

integrity = db.execute("PRAGMA integrity_check").fetchone()[0]
foreign_keys = db.execute("PRAGMA foreign_key_check").fetchall()
if integrity != "ok":
    raise SystemExit("ERROR: PRAGMA integrity_check: " + str(integrity))
if foreign_keys:
    raise SystemExit("ERROR: PRAGMA foreign_key_check: " + repr(foreign_keys))

tables = db.execute(
    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
).fetchone()[0]
print(f"OK: {len(migrations)} migraciones aplicadas; {tables} tablas; integridad y claves foráneas correctas")
PY

echo
echo "RESULTADO: todas las comprobaciones locales incluidas terminaron correctamente."
echo "Nota: esto no despliega, no contacta Cloudflare y no sustituye las pruebas reales de integración."
