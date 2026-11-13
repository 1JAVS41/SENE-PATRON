#!/bin/sh
set -eu
mkdir -p diagnostics
STAGE=initial
record_failure() {
  code=$?
  echo "Fallo en etapa: $STAGE (código $code)" > diagnostics/result.txt
  timeout 30s adb logcat -d -v threadtime > diagnostics/logcat.txt 2>&1 || true
  timeout 20s adb shell dumpsys activity activities > diagnostics/activity.txt 2>&1 || true
  timeout 20s adb shell dumpsys package com.sene.patron > diagnostics/package.txt 2>&1 || true
  exit "$code"
}
trap record_failure HUP INT TERM
test -n "${APK_PATH:-}" && test -s "$APK_PATH"
STAGE=espera-adb
timeout 90s adb wait-for-device
STAGE=arranque-emulador
BOOTED=""
attempt=0
while [ "$attempt" -lt 180 ]; do
  BOOTED="$(timeout 15s adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r' || true)"
  [ "$BOOTED" = "1" ] && break
  attempt=$((attempt + 1))
  sleep 2
done
if [ "$BOOTED" != "1" ]; then
  echo "El emulador no terminó de iniciar." > diagnostics/result.txt
  exit 1
fi
echo "Emulador iniciado" > diagnostics/stages.txt
STAGE=instalacion
timeout 180s adb install -r "$APK_PATH"
echo "Instalación correcta" >> diagnostics/stages.txt
STAGE=detener-version-anterior
timeout 30s adb shell am force-stop com.sene.patron || true
STAGE=lanzamiento
timeout 90s adb shell am start -n com.sene.patron/.MainActivity > diagnostics/start.txt 2>&1
echo "Comando de lanzamiento enviado" >> diagnostics/stages.txt
STAGE=verificar-proceso
attempt=0
PID=""
while [ "$attempt" -lt 45 ]; do
  PID="$(timeout 15s adb shell pidof com.sene.patron 2>/dev/null | tr -d '\r' || true)"
  if [ -n "$PID" ]; then
    echo "$PID" > diagnostics/pid.txt
    echo "Smoke test de arranque correcto para PATRON." > diagnostics/result.txt
    echo "Proceso activo: $PID" >> diagnostics/stages.txt
    trap - HUP INT TERM
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 2
done
echo "La aplicación no mantuvo un proceso activo tras el lanzamiento." > diagnostics/result.txt
exit 1
