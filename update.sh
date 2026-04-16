#!/usr/bin/env bash
# update.sh — Pull latest EventsTimer from git and restart
#
# Run as: sudo bash update.sh
#
# For private repos, ensure /etc/eventstimer-update.token exists.
# Once the repo is public this script works without any token.
# ─────────────────────────────────────────────────────────────────────────────

set -e

INSTALL_DIR="/opt/eventstimer"
TOKEN_FILE="/etc/eventstimer-update.token"

echo "=== EventsTimer Update ==="
echo ""

cd "$INSTALL_DIR"

# Inject token into remote URL if token file exists
REMOTE=$(git remote get-url origin)
if [ -f "$TOKEN_FILE" ]; then
    TOKEN=$(cat "$TOKEN_FILE")
    REMOTE=$(echo "$REMOTE" | sed "s|https://|https://x-access-token:${TOKEN}@|")
fi

echo "  Fetching from remote..."
git fetch "$REMOTE" main

# Check before the reset whether network-manager.py is in this update
NM_UPDATED=false
if git diff HEAD FETCH_HEAD --name-only 2>/dev/null | grep -q "network-manager.py"; then
    NM_UPDATED=true
fi

echo "  Applying update..."
# Reset all tracked files to the upstream state. Unlike 'git pull' (which uses
# merge and aborts if local files conflict), reset --hard forcibly overwrites
# modifications to app files without complaint — correct behaviour for an
# update script where app files should always come from the repo.
git reset --hard FETCH_HEAD

# Remove untracked files that would conflict with the updated tree (e.g. a file
# that was untracked on an old install but is now tracked upstream).
# node_modules and public/fonts are runtime-generated and not in the repo, so
# they are excluded. User data files (config.json, presets.json,
# bridge-state.json) are already protected via .git/info/exclude.
git clean -fd --exclude=node_modules --exclude='public/fonts'

echo "  Installing dependencies..."
npm install --omit=dev

# ── One-time system config (idempotent) ───────────────────────────────────────
# Applies any system-level setup that install.sh would normally handle but that
# may be missing on Pis installed before a given version. Safe to run repeatedly.

# sudoers entry for reboot/shutdown buttons (added in v1.7.5)
SUDOERS_FILE="/etc/sudoers.d/eventstimer"
SERVICE_USER=$(stat -c '%U' "$INSTALL_DIR/server.js")
SUDOERS_LINE="${SERVICE_USER} ALL=(ALL) NOPASSWD: /sbin/reboot, /sbin/shutdown"
if [ ! -f "$SUDOERS_FILE" ] || ! grep -qF "$SUDOERS_LINE" "$SUDOERS_FILE" 2>/dev/null; then
    printf '# EventsTimer — allow service user to reboot/shutdown from admin UI\n%s\n' \
        "$SUDOERS_LINE" > "$SUDOERS_FILE"
    chmod 440 "$SUDOERS_FILE"
    echo "  sudoers: added reboot/shutdown permission for ${SERVICE_USER}"
fi

echo "  Restarting services..."
systemctl restart eventstimer

if [ "$NM_UPDATED" = true ]; then
    echo "  Network manager updated — restarting (brief network interruption)..."
    systemctl restart eventstimer-network
fi

echo ""
VERSION=$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "unknown")
echo "  Done. Running v${VERSION}."
echo ""
