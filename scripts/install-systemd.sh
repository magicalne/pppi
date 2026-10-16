#!/usr/bin/env bash
# Install the pppi gateway as a systemd --user unit (#30).
#
#   scripts/install-systemd.sh [--host 0.0.0.0] [-- extra CLI args...]
#
# Writes ~/.config/systemd/user/pppi-gateway.service templated to THIS
# checkout (absolute bun + repo paths — the user manager has no PATH/cwd),
# enables + starts it, and prints the linger step that makes it survive
# reboots. Re-running updates the unit and restarts the service.
#
# Pairing survives: the unit uses the same PPPI_DIR (~/.pppi) as the hosted
# mode, so the token/QR the phone already has keeps working. See
# docs/standalone-gateway.md for the full migration story.

set -euo pipefail

HOST="0.0.0.0"
EXTRA=()
while [[ $# -gt 0 ]]; do
	case "$1" in
		--host) HOST="$2"; shift 2 ;;
		--) shift; EXTRA=("$@"); break ;;
		*) echo "unknown option: $1 (use -- to pass CLI args through)" >&2; exit 2 ;;
	esac
done

BUN="$(command -v bun || true)"
if [[ -z "$BUN" ]]; then
	echo "bun not found in PATH — install bun first (https://bun.sh)" >&2
	exit 1
fi

REPO="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$REPO/apps/server/src/cli.ts"
if [[ ! -f "$CLI" ]]; then
	echo "cannot locate the gateway CLI at $CLI" >&2
	exit 1
fi

UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/pppi-gateway.service"
mkdir -p "$UNIT_DIR"

if [[ ${#EXTRA[@]} -gt 0 ]]; then
	EXTRA_ARGS=" ${EXTRA[*]}"
else
	EXTRA_ARGS=""
fi

cat >"$UNIT" <<EOF
# pppi gateway — standalone omni host (issue #30).
# Managed by scripts/install-systemd.sh; re-run it to update this unit.
[Unit]
Description=pppi gateway (standalone omni host)
Documentation=file://$REPO/docs/standalone-gateway.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$REPO
# absolute paths: the systemd user manager has no shell PATH or cwd
ExecStart=$BUN run $CLI --host $HOST$EXTRA_ARGS
Environment=PPPI_DIR=%h/.pppi
Restart=on-failure
RestartSec=3
# SIGTERM is handled (clean gateway + agent shutdown); give it a beat
TimeoutStopSec=15

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
if systemctl --user is-active --quiet pppi-gateway; then
	systemctl --user restart pppi-gateway
	echo "pppi-gateway restarted with the updated unit"
else
	systemctl --user enable --now pppi-gateway
	echo "pppi-gateway enabled + started"
fi

sleep 1
systemctl --user --no-pager --lines=0 status pppi-gateway || true

cat <<EOF

next steps:
  survive reboots (run once):   sudo loginctl enable-linger "$USER"
  logs:                         journalctl --user -u pppi-gateway -f
  health:                       curl http://localhost:8787/api/health
  stop the old TUI gateway:    /pppi_gateway stop  (in the pi session that hosts it)

pairing: the unit shares ~/.pppi with the hosted mode — the phone keeps its
token; nothing re-pairs. If the hosted gateway still runs, stop it first so
the port does not collide.
EOF
