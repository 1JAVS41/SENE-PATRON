#!/bin/sh
set -eu
mkdir -p diagnostics
test -n "${APK_PATH:-}" && test -s "$APK_PATH"
timeout 60s adb wait-for-device
BOOTED="$(adb shell getprop sys.boot_completed | tr -d '\r')"
if [ "$BOOTED" != "1" ]; then
  echo "El emulador no terminó de iniciar." > diagnostics/result.txt
  adb logcat -d -v threadtime > diagnostics/logcat.txt 2>&1 || true
  exit 1
fi
if ! timeout 120s adb install -r "$APK_PATH"; then
  adb logcat -d -v threadtime > diagnostics/logcat.txt 2>&1 || true
  exit 1
fi
adb shell am force-stop com.sene.patron
if ! timeout 45s adb shell monkey -p com.sene.patron 1; then
  adb logcat -d -v threadtime > diagnostics/logcat.txt 2>&1 || true
  adb shell dumpsys activity activities > diagnostics/activity.txt 2>&1 || true
  exit 1
fi
attempt=0
while [ "$attempt" -lt 20 ]; do
  PID="$(adb shell pidof com.sene.patron 2>/dev/null | tr -d '\r' || true)"
  if [ -n "$PID" ]; then
    echo "$PID" > diagnostics/pid.txt
    echo "Smoke test de arranque correcto." > diagnostics/result.txt
    exit 0
  fi
  attempt=$((attempt + 1))
  sleep 1
done
echo "La aplicación no mantuvo un proceso activo tras el lanzamiento." > diagnostics/result.txt
adb logcat -d -v threadtime > diagnostics/logcat.txt 2>&1 || true
adb shell dumpsys activity activities > diagnostics/activity.txt 2>&1 || true
adb shell dumpsys package com.sene.patron > diagnostics/package.txt 2>&1 || true
exit 1
