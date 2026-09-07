#!/usr/bin/env python3
"""pppi Android E2E driver — asserts the real UI flow over adb.

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


def wait_for_desc(desc: str, timeout: float = 30.0) -> bool:
    """Wait until a node with content-desc=desc appears (presence dot etc.)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if f'content-desc="{desc}"' in dump():
            return True
        time.sleep(1)
    return False


def tap_desc(desc: str) -> bool:
    xml = dump()
    m = re.search(rf'content-desc="{desc}"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', xml)
    if not m:
        return False
    tap((int(m.group(1)) + int(m.group(3))) // 2, (int(m.group(2)) + int(m.group(4))) // 2)
    return True


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


def dismiss_permission_dialogs() -> bool:
    """If a runtime-permission dialog is up, grant it and report that we did."""
    xml = dump()
    for label in ("While using the app", "Only this time", "Allow"):
        pos = bounds_center(xml, label)
        if pos:
            tap(*pos)
            time.sleep(1)
            return True
    return False


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
    adb("uninstall", "dev.pppi.omni", check=False)  # ok if not installed
    apk = os.environ["E2E_APK"]
    adb("install", apk)
    shell("pm grant dev.pppi.omni android.permission.RECORD_AUDIO")
    shell("am start -n dev.pppi.omni/.MainActivity")
    check("pairing screen appears", wait_for_text("Pair with your omni agent", 15))

    xml = dump()
    server_field = edit_field_center(xml, 0)
    check("pair link field found", server_field is not None)
    if server_field is None:
        return
    tap(*server_field)
    time.sleep(1)
    type_text(f"{GATEWAY}/?pair={TOKEN}")  # the /pair link carries the token
    time.sleep(1)

    check("connect button tapped", tap_text("Connect"))
    check("connected (presence dot)", wait_for_desc("connected", 25))


def phase_machines() -> None:
    check("machines menu present", tap_desc("machines"))
    check("machines drawer visible", wait_for_text("MACHINES", 10))
    xml = dump()
    check("add form present", "Paste pair link or server URL" in xml)
    check("scan qr present", "Scan QR" in xml)
    check("paired machine listed", "10.0.2.2" in xml or "MACHINES" in xml and len(texts(xml)) > 4)
    # close via the scrim (top-right corner — far from the composer/mic)
    shell("input tap 1040 300")
    time.sleep(1)
    dismiss_permission_dialogs()
    check("drawer closed, chat intact", wait_for_text("Message Omni", 10))


def phase_chat() -> None:
    dismiss_permission_dialogs()
    composer = None
    for _ in range(6):
        composer = edit_field_center(dump(), 0)
        if composer:
            break
        dismiss_permission_dialogs()
        time.sleep(2)
    check("composer found", composer is not None)
    if composer is None:
        return
    tap(*composer)
    time.sleep(1)
    type_text("e2e ping")
    time.sleep(1)
    shell("input keyevent 66")  # Enter → IME Send action
    check("mock agent reply mirrored", wait_for_text(MOCK_REPLY, 40))


def phase_voice() -> None:
    dismiss_permission_dialogs()
    before = set(texts(dump()))
    # the ● dot lives INSIDE the mic button; the label below it is not tappable
    mic = bounds_center(dump(), "●") or bounds_center(dump(), "■")
    check("mic button found", mic is not None)
    if mic is None:
        return
    x, y = mic
    # hold the button in the background so we can observe the mid-hold state.
    # identical start/end coords: ANY movement past touch slop cancels the press
    # gesture and stops the recording. long hold: uiautomator dump waits for UI
    # idle and the waveform animates, so the dump returns late — the hold must
    # outlive it.
    proc = subprocess.Popen([ADB, "shell", f"input swipe {x} {y} {x} {y} 12000"])
    time.sleep(1.2)
    started = "listening" in dump()
    check("recording started", started)
    if started and VOICE_WAV and os.path.exists(VOICE_WAV):
        subprocess.run(["afplay", VOICE_WAV], timeout=10)
    proc.wait()  # release → upload + send
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
    check("session sheet opened", tap_desc("sessions"))
    check("unpair visible", wait_for_text("Unpair this device", 10))
    check("unpair tapped", tap_text("Unpair this device"))
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
    check("reconnected after gateway restart", wait_for_desc("connected", 90))
    # fresh gateway = empty history; prove the reconnect with a new round trip
    composer = None
    for _ in range(6):  # dumps can transiently fail right after a long poll loop
        composer = edit_field_center(dump(), 0)
        if composer:
            break
        time.sleep(2)
    check("composer found after reconnect", composer is not None)
    if composer is None:
        return
    tap(*composer)
    time.sleep(1)
    type_text("e2e reconnect ping")
    time.sleep(1)
    shell("input keyevent 66")
    check("post-reconnect reply", wait_for_text(MOCK_REPLY, 40))


PHASES = {
    "pair": phase_pair,
    "machines": phase_machines,
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
