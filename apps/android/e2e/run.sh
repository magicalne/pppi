#!/bin/bash
# sspi Android E2E — one command, full system flow.
#
#   apps/android/e2e/run.sh
#
# Boots (or reuses) the emulator, builds the APK, starts a throwaway
# mock-agent gateway, then drives the real app over adb through:
#   pair via /pair link (real UI) -> machines drawer -> chat round trip ->
#   voice upload -> unpair -> gateway down ("connecting…") -> gateway restart
#   (auto-reconnect)
#
# Env:
#   E2E_AVD   emulator name          (default sspi-test)
#   E2E_PORT  gateway port           (default 8791)
#   KEEP=1    leave emulator + gateway running after the run
#   SKIP_BUILD=1  reuse the last built APK

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
AVD="${E2E_AVD:-sspi-test}"
PORT="${E2E_PORT:-8791}"
ADB="${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb"
EMU="${ANDROID_HOME:-$HOME/Library/Android/sdk}/emulator/emulator"
JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}"
export JAVA_HOME ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"

 cleanup() {
  if [ "${KEEP:-0}" != "1" ]; then
    [ -n "${GW_PID:-}" ] && kill "$GW_PID" 2>/dev/null || true
    [ -n "${EMU_PID:-}" ] && kill "$EMU_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

# 1. emulator ------------------------------------------------------------
if ! "$ADB" devices | grep -q "emulator.*device"; then
  echo "== booting emulator $AVD =="
  nohup "$EMU" -avd "$AVD" -no-window -no-audio -gpu swiftshader_indirect \
    -no-snapshot -no-boot-anim > /tmp/sspi-e2e-emulator.log 2>&1 &
  EMU_PID=$!
  for i in $(seq 1 40); do
    [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && break
    sleep 5
  done
fi
"$ADB" wait-for-device
[ "$("$ADB" shell getprop sys.boot_completed | tr -d '\r')" = "1" ] || { echo "emulator did not boot"; exit 1; }

# 2. build ---------------------------------------------------------------
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "== building APK =="
  (cd "$REPO/apps/android" && ./gradlew :app:assembleDebug -q)
fi
APK="$REPO/apps/android/app/build/outputs/apk/debug/app-debug.apk"
[ -f "$APK" ] || { echo "APK missing: $APK"; exit 1; }

# 3. throwaway mock gateway ----------------------------------------------
echo "== starting mock gateway on :$PORT =="
GW_DIR="$(mktemp -d /tmp/sspi-e2e-gw.XXXXXX)"
MOCK_REPLY="mock omni: standing by" SSPI_DIR="$GW_DIR" nohup bun run "$REPO/apps/server/src/cli.ts" \
  --host 127.0.0.1 --port "$PORT" \
  --agent-cmd "bun $REPO/apps/server/src/mock-agent.mjs" > /tmp/sspi-e2e-gw.log 2>&1 &
GW_PID=$!
for i in $(seq 1 20); do
  curl -sf "http://127.0.0.1:$PORT/api/health" > /dev/null && break
  sleep 1
done
curl -sf "http://127.0.0.1:$PORT/api/health" > /dev/null || { echo "gateway did not start"; exit 1; }
TOKEN="$(python3 -c "import json;print(json.load(open('$GW_DIR/config.json'))['token'])")"

# deterministic server-side STT check (full phrase, not the lossy mic path)
WAV="$REPO/apps/android/app/src/androidTest/assets/voice-sample.wav"
if [ -f "$WAV" ]; then
  TRANSCRIPT="$(curl -s -X POST "http://127.0.0.1:$PORT/api/voice" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: audio/wav" \
    --data-binary @"$WAV")"
  echo "$TRANSCRIPT" | grep -q "quick brown fox" \
    && echo "== server-side STT: verbatim transcript ✓" \
    || { echo "server-side STT failed: $TRANSCRIPT"; exit 1; }
fi

# 4. drive the app -------------------------------------------------------
echo "== running E2E driver =="
export E2E_GATEWAY="http://10.0.2.2:$PORT" E2E_TOKEN="$TOKEN" E2E_GW_PID="$GW_PID" \
       E2E_APK="$APK" E2E_MOCK_REPLY="mock omni: standing by" \
       E2E_VOICE_WAV="$WAV" ADB="$ADB"

EXIT=0
# phases: offline kills the gateway and asserts "connecting…";
# after the gateway restart, reconnect + unpair run in a second invocation
if python3 "$HERE/e2e.py" pair,machines,chat,voice,offline; then
  echo "== phases 1/2 PASS =="
else
  echo "== E2E FAIL (phases 1/2) =="
  exit 1
fi

# 5. restart gateway (same SSPI_DIR -> same token) for the reconnect phase
MOCK_REPLY="mock omni: standing by" SSPI_DIR="$GW_DIR" nohup bun run "$REPO/apps/server/src/cli.ts" \
  --host 127.0.0.1 --port "$PORT" \
  --agent-cmd "bun $REPO/apps/server/src/mock-agent.mjs" > /dev/null 2>&1 &
GW_PID=$!
sleep 3

if python3 "$HERE/e2e.py" reconnect,unpair; then
  echo "== E2E PASS =="
else
  echo "== E2E FAIL (reconnect) =="
  EXIT=1
fi

exit $EXIT
