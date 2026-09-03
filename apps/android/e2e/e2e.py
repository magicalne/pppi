#!/usr/bin/env python3
"""sspi Android E2E driver — asserts the real UI flow over adb.

Phases (coordinated by run.sh):
  pair     fresh install -> pair through the real UI -> connected
  chat     send a chat message -> mock agent reply appears
  voice    hold-to-talk -> upload -> empty-transcript toast OR transcript bubble
  unpair   tap unpair -> pairing screen
  offline  gateway down -> "connecting…" | gateway up -> reconnected

No third-party deps: adb + uiautomator dumps only.
"""

import html
import os
import re
import subprocess
import sys
import time

ADB = os.environ.get("ADB", "adb")
GATEWAY = os.environ["E2E_GATEWAY"]          # e.g. http://10.0.2.2:8791
TOKEN = os.environ["E2E_TOKEN"]
GW_PID = os.environ.get("E2E_GW_PID", "")
MOCK_REPLY = os.environ.get("E2E_MOCK_REPLY", "mock omni: standing by")
VOICE_WAV = os.environ.get("E2E_VOICE_WAV", "")

_failures: list[str] = []
_passes = 0


def adb(*args: str, check: bool = True) -> str:
    r = subprocess.run([ADB, *args], capture_output=True, text=True, timeout=60)
    if check and r.returncode != 0:
        raise RuntimeError(f"adb {args} failed: {r.stderr.strip()[:300]}")
    return r.stdout


def shell(cmd: str, check: bool = True) -> str:
    return adb("shell", cmd, check=check)


def dump() -> str:
    shell("rm -f /sdcard/e2e-ui.xml")
    for _ in range(4):
        shell("uiautomator dump /sdcard/e2e-ui.xml", check=False)
        out = shell("cat /sdcard/e2e-ui.xml", check=False)
        if out.strip():
            return html.unescape(out)
        time.sleep(1)
    return ""


def texts(xml: str) -> list[str]:
    return [m for m in re.findall(r'text="([^"]+)"', xml) if m.strip()]


def bounds_center(xml: str, match_text: str, occurrence: int = 0) -> tuple[int, int] | None:
    """Center of the node whose text equals/contains match_text."""
    hits = []
    for m in re.finditer(r'text="([^"]*)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', xml):
        t = m.group(1)
        if match_text in t:
            hits.append(m)
    if occurrence >= len(hits):
        return None
    m = hits[occurrence]
    x = (int(m.group(2)) + int(m.group(4))) // 2
    y = (int(m.group(3)) + int(m.group(5))) // 2
    return x, y


def edit_field_center(xml: str, index: int) -> tuple[int, int] | None:
    fields = re.findall(r'class="[^"]*EditText[^"]*"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', xml)
    if index >= len(fields):
        return None
    f = fields[index]
    return (int(f[0]) + int(f[2])) // 2, (int(f[1]) + int(f[3])) // 2


def tap(x: int, y: int) -> None:
    shell(f"input tap {x} {y}")


def type_text(s: str) -> None:
    shell("input text " + s.replace(" ", "%s"))


def wait_for_text(match: str, timeout: float = 20.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if any(match in t for t in texts(dump())):
            return True
        time.sleep(1)
    return False


def check(name: str, ok: bool, detail: str = "") -> None:
    global _passes
    mark = "PASS" if ok else "FAIL"
    print(f"[{mark}] {name}" + (f" — {detail}" if detail and not ok else ""))
    if ok:
        _passes += 1
    else:
        _failures.append(name)


def tap_text(match: str, occurrence: int = 0) -> bool:
    pos = bounds_center(dump(), match, occurrence)
    if pos is None:
        return False
    tap(*pos)
    return True


# ---------------------------------------------------------------- phases

def phase_pair() -> None:
    adb("uninstall", "dev.sspi.omni", check=False)  # ok if not installed
    apk = os.environ["E2E_APK"]
    adb("install", apk)
    shell("pm grant dev.sspi.omni android.permission.RECORD_AUDIO")
    shell("am start -n dev.sspi.omni/.MainActivity")
    check("pairing screen appears", wait_for_text("Pair with your omni agent", 15))

    xml = dump()
    server_field = edit_field_center(xml, 0)
    check("server field found", server_field is not None)
    if server_field is None:
        return
    tap(*server_field)
    time.sleep(1)
    type_text(GATEWAY)  # full URL incl. scheme — the app validates it
    time.sleep(1)

    xml = dump()
    token_field = edit_field_center(xml, 1)
    check("token field found", token_field is not None)
    if token_field is None:
        return
    tap(*token_field)
    time.sleep(1)
    type_text(TOKEN)
    time.sleep(1)

    check("connect button tapped", tap_text("Connect"))
    check("connected (status text)", wait_for_text("one session · every screen", 20))


def phase_chat() -> None:
    xml = dump()
    composer = edit_field_center(xml, 0)
    check("composer found", composer is not None)
    if composer is None:
        return
    tap(*composer)
    time.sleep(1)
    type_text("e2e ping")
    time.sleep(1)
    check("send tapped", tap_text("send"))
    check("mock agent reply mirrored", wait_for_text(MOCK_REPLY, 40))


def phase_voice() -> None:
    before = set(texts(dump()))
    started = False
    for _ in range(2):
        # the ● dot lives INSIDE the mic button; the "hold to talk" label is
        # ~150px below it — tapping the label misses the button
        mic = bounds_center(dump(), "●") or bounds_center(dump(), "■") or bounds_center(dump(), "hold to talk")
        if mic is None:
            break
        x, y = mic
        shell(f"input swipe {x} {y} {x + 7} {y + 11} 800")
        time.sleep(2)
        if "recording" in dump():
            started = True
            break
    check("recording started", started)
    if not started:
        return
    if VOICE_WAV and os.path.exists(VOICE_WAV):
        subprocess.run(["afplay", VOICE_WAV], timeout=30)
    shell(f"input tap {x} {y - 20}")
    # outcome A: gateway transcribed a fragment -> transcript bubble appears
    # outcome B: silence -> 422 toast "transcript was empty…"
    deadline = time.time() + 25
    new_text = None
    toast = False
    while time.time() < deadline:
        xml = dump()
        toast = any("transcript was empty" in t for t in texts(xml))
        if toast:
            break
        new = [t for t in texts(xml) if t not in before and len(t) > 1]
        if new:
            new_text = new[0]
            break
        time.sleep(1)
    check("voice round trip reached the gateway", toast or new_text is not None,
          f"new={new_text} toast={toast}")


def phase_unpair() -> None:
    check("unpair tapped", tap_text("unpair"))
    check("back on pairing screen", wait_for_text("Pair with your omni agent", 10))


def phase_offline() -> None:
    if GW_PID:
        try:
            subprocess.run(["kill", GW_PID], check=False)
        except Exception:
            pass
    # detection relies on the WS keepalive ping (30s interval) — allow for it
    check("connecting… shown after gateway down", wait_for_text("connecting", 90))


def phase_reconnect() -> None:
    check("reconnected after gateway restart", wait_for_text("one session · every screen", 60))
    # fresh gateway = empty history; prove the reconnect with a new round trip
    composer = edit_field_center(dump(), 0)
    check("composer found after reconnect", composer is not None)
    if composer is None:
        return
    tap(*composer)
    time.sleep(1)
    type_text("e2e reconnect ping")
    time.sleep(1)
    check("send tapped after reconnect", tap_text("send"))
    check("post-reconnect reply", wait_for_text(MOCK_REPLY, 40))


PHASES = {
    "pair": phase_pair,
    "chat": phase_chat,
    "voice": phase_voice,
    "offline": phase_offline,
    "reconnect": phase_reconnect,
    "unpair": phase_unpair,
}


def main() -> int:
    phases = sys.argv[1].split(",") if len(sys.argv) > 1 else list(PHASES)
    for phase in phases:
        print(f"--- phase: {phase} ---")
        PHASES[phase]()
    print(f"\ne2e: {_passes} passed, {len(_failures)} failed")
    if _failures:
        print("failed:", ", ".join(_failures))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
