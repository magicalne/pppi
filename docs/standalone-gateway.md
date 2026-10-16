# Standalone gateway (systemd) — issue #30

The gateway can live in two places. Same wire protocol, same pairing
(`~/.pppi` — token, `pair.json`, `config.json`), same health endpoint:

| | hosted in a pi session | standalone (this) |
|---|---|---|
| started by | `/pppi_gateway` in a TUI | `scripts/install-systemd.sh` (or `bun run dev:server`) |
| lifetime | tied to that TUI session | systemd unit — survives TUI exit and reboot |
| omni agent | rpc child by default; **`here` mode: the session IS the omni** | always a child (`pi --mode rpc` by default; `--agent sdk\|durable` for in-process) |
| voice | mic via the TUI's desktop session | needs a user audio server (see below) |
| best for | laptops / interactive use / `here` mode | unattended machines, redeploys without a human at a TUI |

The standalone host is `apps/server` (`bun run dev:server`):
`--port 8787 --host 0.0.0.0 --token X --cwd ~/.pppi/omni-home --agent-cmd "…" --no-stt`.

## Install

```sh
scripts/install-systemd.sh                 # binds 0.0.0.0; extra CLI args after --
sudo loginctl enable-linger "$USER"        # once: survive logout/reboot
journalctl --user -u pppi-gateway -f       # logs
curl http://localhost:8787/api/health      # ok · gateway · agent · stt · tts · boot
```

The unit is `~/.config/systemd/user/pppi-gateway.service` with absolute bun +
repo paths (the user manager has no PATH/cwd), `Restart=on-failure` (3s
backoff), `PPPI_DIR=%h/.pppi`, and clean SIGTERM shutdown (`TimeoutStopSec=15`).
Re-running the installer updates the unit and restarts the service.

## Migrating an existing phone pairing

Nothing re-pairs: both modes read the same `~/.pppi/config.json` token, and
`pair.json` carries the same machine fingerprint.

1. In the pi session that hosts the old gateway: `/pppi_gateway stop`
   (the port must be free before the unit starts — the installer starts it,
   so do this first if both would bind the same port).
2. `scripts/install-systemd.sh` — the phone reconnects on its next retry
   (chat ws backs off to 15s; voice reconnects on the next session).
3. The omni conversation continues: the standalone child resumes the session
   id marked by `/pppi_gateway mark` (`~/.pppi/omni.json`), or `pppi-omni`
   when unmarked. Run `/pppi_gateway mark` in the TUI omni first if you want
   that exact conversation to carry over.

**Hosted `here` mode has no standalone equivalent** — there the TUI session
itself is the omni; standalone always spawns a child (rpc default, or
`--agent sdk` / `--agent durable`). If you lived in `here` mode, either stay
hosted or accept a fresh omni conversation under the marked/default id.

## Voice on a headless box

STT/TTS run in a spawned child of the gateway and need an audio stack:
pipewire/pulseaudio are user services, and on a truly headless machine they
may not come up until first login even with lingering. Pairing, chat, and
artifacts work regardless; voice needs the audio server running (verify with
`pactl info`). `--no-stt` (or the same flag through the installer) keeps the
unit text-only deliberately.

## Manual QA (the reboot needs a human)

```sh
# 1. unit is live and healthy
systemctl --user status pppi-gateway
curl -s localhost:8787/api/health | head -c 400

# 2. survives a TUI exit: close/kill every pi session on the box, re-check
#    status + health, send a chat message from the phone

# 3. survives failure: systemctl --user kill pppi-gateway (SIGTERM = clean
#    stop; use --signal=KILL for a crash) — systemd restarts it within ~3s

# 4. survives reboot (once linger is on): sudo reboot, then re-check 1;
#    loginctl show-user "$USER" -p Linger   # → Linger=yes
```

The reboot check can be deferred — verify at the next natural reboot; if
linger is enabled the unit auto-starts then. Steps 1–3 (start/stop/health,
TUI exit, crash-restart) are sufficient to ship.
