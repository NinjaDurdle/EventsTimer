#!/usr/bin/env bash
# start-display.sh — Launch Chromium in kiosk mode to the display page.
#
# Called by server.js (/api/display/launch) and by eventstimer-display.service.
# The server process runs under systemd and does not inherit display environment
# variables, so we probe for active socket files rather than trusting $DISPLAY
# or $WAYLAND_DISPLAY.
# ─────────────────────────────────────────────────────────────────────────────

CHROMIUM_BIN="$(command -v chromium || command -v chromium-browser || echo /usr/bin/chromium)"
URL="http://localhost/display"
KIOSK_DIR="/tmp/eventstimer-display"
COMMON_FLAGS=(
    --kiosk
    --user-data-dir="$KIOSK_DIR"
    --noerrdialogs
    --disable-infobars
    --disable-session-crashed-bubble
    --disable-restore-session-state
    --no-first-run
    --check-for-update-interval=31536000
    --disable-pinch
)

# If the kiosk instance is already running, don't open a second one
if pgrep -f "user-data-dir=${KIOSK_DIR}" > /dev/null 2>&1; then
    echo "Display kiosk already running"
    exit 0
fi

# Resolve XDG_RUNTIME_DIR from our UID if not already set.
# Under systemd the env var may be absent even though the directory exists.
USER_UID="$(id -u)"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/${USER_UID}}"

# ── Wayland: look for an active compositor socket ────────────────────────────
WAYLAND_SOCK=""
for w in wayland-0 wayland-1 wayland-2; do
    if [ -S "${XDG_RUNTIME_DIR}/${w}" ]; then
        WAYLAND_SOCK="$w"
        break
    fi
done

if [ -n "$WAYLAND_SOCK" ]; then
    export WAYLAND_DISPLAY="$WAYLAND_SOCK"
    exec "$CHROMIUM_BIN" "${COMMON_FLAGS[@]}" \
        --ozone-platform=wayland --enable-features=UseOzonePlatform "$URL"
fi

# ── X11 fallback ─────────────────────────────────────────────────────────────
export DISPLAY="${DISPLAY:-:0}"
export XAUTHORITY="${XAUTHORITY:-${HOME}/.Xauthority}"
exec "$CHROMIUM_BIN" "${COMMON_FLAGS[@]}" "$URL"
