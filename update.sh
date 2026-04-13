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
git pull "$REMOTE" main

echo "  Installing dependencies..."
npm install --omit=dev

echo "  Restarting service..."
systemctl restart eventstimer

echo ""
VERSION=$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "unknown")
echo "  Done. Running v${VERSION}."
echo ""
