#!/usr/bin/env bash
# install.sh — EventsTimer
# Run once as root on a fresh Raspberry Pi OS / Debian / Ubuntu install:
#
#   sudo bash install.sh
#
# Supported platforms:
#   Raspberry Pi OS Trixie (32/64-bit)     ← primary target
#   Debian 13 Trixie (arm64 / x86-64)
#   Ubuntu 22.04 LTS / 24.04 LTS
#   Any current Debian-based distro
# ─────────────────────────────────────────────────────────────────────────────

set -e

VERSION="1.10.1"
INSTALL_DIR="/opt/eventstimer"

echo "=== EventsTimer v${VERSION} — Install ==="
echo ""

# ── Detect OS ─────────────────────────────────────────────────────────────────

if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS_ID="${ID}"
    OS_ID_LIKE="${ID_LIKE}"
else
    echo "ERROR: /etc/os-release not found. Requires a systemd-based Linux distro."
    exit 1
fi

echo "Detected OS:   ${PRETTY_NAME:-$OS_ID}"
is_like() { [[ "$OS_ID" == "$1" || "$OS_ID_LIKE" == *"$1"* ]]; }

# ── Detect service user ────────────────────────────────────────────────────────

if [ -n "$SUDO_USER" ] && [ "$SUDO_USER" != "root" ]; then
    SERVICE_USER="$SUDO_USER"
else
    SERVICE_USER=$(awk -F: '$3 >= 1000 && $3 < 65534 {print $1; exit}' /etc/passwd)
fi

if [ -z "$SERVICE_USER" ]; then
    echo "ERROR: Could not determine a non-root user. Run: sudo bash install.sh"
    exit 1
fi

SERVICE_HOME=$(eval echo "~${SERVICE_USER}")
echo "Service user:  ${SERVICE_USER} (home: ${SERVICE_HOME})"

# ── Detect Chromium ───────────────────────────────────────────────────────────

detect_chromium() {
    if apt-cache show chromium &>/dev/null; then
        CHROMIUM_PKG="chromium"; CHROMIUM_BIN="/usr/bin/chromium"
    elif apt-cache show chromium-browser &>/dev/null; then
        CHROMIUM_PKG="chromium-browser"; CHROMIUM_BIN="/usr/bin/chromium-browser"
    else
        CHROMIUM_PKG=""; CHROMIUM_BIN=""
    fi
}

detect_chromium
if [ -z "$CHROMIUM_PKG" ]; then apt-get update -q; detect_chromium; fi

if [ -z "$CHROMIUM_PKG" ]; then
    echo "WARNING: Chromium not found in apt repos."
    if is_like "ubuntu"; then
        echo "         Ubuntu ships Chromium as a snap — installing via snap."
        CHROMIUM_BIN="/snap/bin/chromium"
    else
        echo "         Install Chromium manually for the display kiosk."
        CHROMIUM_BIN="/usr/bin/chromium"
    fi
fi

echo "Chromium:      ${CHROMIUM_PKG:-'(snap or manual)'} → ${CHROMIUM_BIN}"
echo ""

# ── 1. Node.js 20 LTS ─────────────────────────────────────────────────────────

echo "[1/8] Installing Node.js 20 LTS via NodeSource..."
apt-get install -y curl gnupg --no-install-recommends
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -

# ── 2. System packages ────────────────────────────────────────────────────────

echo "[2/8] Installing system packages..."
BASE_PKGS="nodejs dnsmasq avahi-daemon avahi-utils isc-dhcp-client authbind python3 fontconfig"

if [ -n "$CHROMIUM_PKG" ]; then
    apt-get install -y $BASE_PKGS "$CHROMIUM_PKG" --no-install-recommends
else
    apt-get install -y $BASE_PKGS --no-install-recommends
    if is_like "ubuntu" && command -v snap &>/dev/null; then
        snap install chromium
    fi
fi

echo "  Node.js: $(node --version)"
echo "  npm:     $(npm --version)"

# ── 3. Copy app files ─────────────────────────────────────────────────────────

echo "[3/8] Installing app files to ${INSTALL_DIR}..."
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "${INSTALL_DIR}/public/fonts"
mkdir -p "${INSTALL_DIR}/bridges"

cp "${SCRIPT_DIR}/server.js"          "${INSTALL_DIR}/server.js"
cp "${SCRIPT_DIR}/package.json"       "${INSTALL_DIR}/package.json"
cp "${SCRIPT_DIR}/network-manager.py" "${INSTALL_DIR}/network-manager.py"
cp "${SCRIPT_DIR}/update.sh"          "${INSTALL_DIR}/update.sh"
chmod +x "${INSTALL_DIR}/update.sh"
cp "${SCRIPT_DIR}"/public/*.html "${INSTALL_DIR}/public/"

# Icons (SVG — used by control page buttons)
if [ -d "${SCRIPT_DIR}/public/icons" ]; then
    mkdir -p "${INSTALL_DIR}/public/icons"
    cp "${SCRIPT_DIR}"/public/icons/*.svg "${INSTALL_DIR}/public/icons/"
    echo "  Icons:   $(ls "${SCRIPT_DIR}/public/icons/"*.svg | wc -l) SVG(s)"
fi

# Bridges
if ls "${SCRIPT_DIR}/bridges/"*.js &>/dev/null 2>&1; then
    cp "${SCRIPT_DIR}"/bridges/*.js "${INSTALL_DIR}/bridges/"
    echo "  Bridges: $(ls "${SCRIPT_DIR}/bridges/"*.js | wc -l) script(s)"
fi

# Config — preserve existing config on updates
if [ ! -f "${INSTALL_DIR}/config.json" ]; then
    cp "${SCRIPT_DIR}/config.json" "${INSTALL_DIR}/config.json"
    echo "  Config:  installed (fresh)"
else
    echo "  Config:  preserved (existing settings kept)"
fi

# Pre-downloaded fonts (from package if available)
if ls "${SCRIPT_DIR}/public/fonts/"*.woff2 &>/dev/null 2>&1; then
    cp "${SCRIPT_DIR}"/public/fonts/*.woff2 "${INSTALL_DIR}/public/fonts/"
    echo "  Fonts:   copied from package"
fi

# Git setup — initialise install dir as a repo so future updates work.
# Detects the remote from the directory this script was run from.
if [ ! -d "${INSTALL_DIR}/.git" ]; then
    REPO_URL=$(git -C "$SCRIPT_DIR" remote get-url origin 2>/dev/null || true)
    if [ -n "$REPO_URL" ]; then
        echo "  Setting up git for future updates..."
        git -C "${INSTALL_DIR}" init -b main
        git -C "${INSTALL_DIR}" remote add origin "$REPO_URL"
        # Exclude runtime files so git operations never overwrite them
        printf 'config.json\npresets.json\nbridge-state.json\n' \
            >> "${INSTALL_DIR}/.git/info/exclude"
        echo "  Git remote: $REPO_URL"
    else
        echo "  Note: run install from a git clone to enable one-click updates"
    fi
fi

# Optional update token — required while repo is private.
# Pass as: EVENTSTIMER_TOKEN=<token> sudo -E bash install.sh
# Remove /etc/eventstimer-update.token once the repo is made public.
UPDATE_TOKEN_FILE="/etc/eventstimer-update.token"
if [ -n "${EVENTSTIMER_TOKEN:-}" ]; then
    printf '%s' "$EVENTSTIMER_TOKEN" > "$UPDATE_TOKEN_FILE"
    chmod 600 "$UPDATE_TOKEN_FILE"
    echo "  Token:   written to $UPDATE_TOKEN_FILE"
elif [ ! -f "$UPDATE_TOKEN_FILE" ]; then
    echo "  Token:   not set (needed for private repo — see README)"
fi

chown -R "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}"

# ── 4. Node dependencies ──────────────────────────────────────────────────────

echo "[4/8] Installing Node.js dependencies..."
cd "${INSTALL_DIR}"
sudo -u "${SERVICE_USER}" npm install --omit=dev

# ── 5. Download display fonts ─────────────────────────────────────────────────
# Fonts are served from the Pi's own web server so display.html works offline.
# Trebuchet MS, Courier New, and Monospace are built-in system fonts.

echo "[5/8] Downloading display fonts..."
FONTS_DIR="${INSTALL_DIR}/public/fonts"

download_font() {
    local name="$1" url="$2" file="${FONTS_DIR}/$3"
    if [ -f "$file" ]; then echo "  ${name}: already present"; return; fi
    if curl -fsSL --connect-timeout 15 "$url" -o "$file" 2>/dev/null; then
        echo "  ${name}: OK"
    else
        echo "  ${name}: FAILED (no internet?) — will fall back to system font"
        rm -f "$file"
    fi
}

download_font "Nunito Regular"     \
    "https://fonts.gstatic.com/s/nunito/v26/XRXI3I6Li01BKofIMN5MZ9vN.woff2" \
    "Nunito-Regular.woff2"

download_font "Nunito Bold"        \
    "https://fonts.gstatic.com/s/nunito/v26/XRXI3I6Li01BKofIKN5MZ9vN.woff2" \
    "Nunito-Bold.woff2"

download_font "Quicksand Regular"  \
    "https://fonts.gstatic.com/s/quicksand/v31/6xKtdSZaM9iE8KbpRA_LJ3z8mH9BOJvgkBgv18G0wx40.woff2" \
    "Quicksand-Regular.woff2"

download_font "Roboto Mono"        \
    "https://fonts.gstatic.com/s/robotomono/v23/L0xuDF4xlVMF-BfR8bXMIhJHg45mwgGEFl0_3vrtSM1J-gEPT5Ese6hmHSV0me8iUI.woff2" \
    "RobotoMono-Regular.woff2"

download_font "Share Tech Mono"    \
    "https://fonts.gstatic.com/s/sharetechmono/v15/J7aHnp1uDWRBEqV98dVQztYldFc7pAsEIc3Xew.woff2" \
    "ShareTechMono-Regular.woff2"

# Install Roboto as a system font for fc-list (font picker in admin)
apt-get install -y fonts-roboto --no-install-recommends 2>/dev/null || true
fc-cache -f 2>/dev/null || true

chown -R "${SERVICE_USER}:${SERVICE_USER}" "${FONTS_DIR}"

# ── 6. authbind (port 80 without root) + sudoers ─────────────────────────────

echo "[6/8] Configuring authbind and sudoers..."
touch /etc/authbind/byport/80
chmod 500 /etc/authbind/byport/80
chown "${SERVICE_USER}:${SERVICE_USER}" /etc/authbind/byport/80

# Allow the service user to reboot and shutdown without a password.
# Required for the Restart Server / Reboot Pi / Shutdown Pi buttons in admin.
SUDOERS_FILE="/etc/sudoers.d/eventstimer"
cat > "$SUDOERS_FILE" << SUDOEOF
# EventsTimer — allow service user to reboot/shutdown from admin UI
${SERVICE_USER} ALL=(ALL) NOPASSWD: /sbin/reboot, /sbin/shutdown
SUDOEOF
chmod 440 "$SUDOERS_FILE"
echo "  sudoers: ${SERVICE_USER} may reboot and shutdown without password"

# ── 7. systemd services ───────────────────────────────────────────────────────

echo "[7/8] Installing systemd services..."

cat > /etc/systemd/system/eventstimer-network.service << EOF
[Unit]
Description=EventsTimer — Network Manager
After=network.target
Before=eventstimer.service

[Service]
Type=simple
ExecStart=/usr/bin/python3 ${INSTALL_DIR}/network-manager.py
# Override the network interface by adding an override file:
#   sudo systemctl edit eventstimer-network
# and adding:
#   [Service]
#   Environment=TIMER_IFACE=wlan0
#   (or eth1, eth2, etc.)
Environment=TIMER_IFACE=eth0
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
User=root

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/eventstimer.service << EOF
[Unit]
Description=EventsTimer — Node.js Server
After=network.target eventstimer-network.service avahi-daemon.service
Wants=eventstimer-network.service

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
ExecStart=/usr/bin/authbind --deep /usr/bin/node server.js
Restart=always
RestartSec=2
User=${SERVICE_USER}
Environment=NODE_ENV=production
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

cp "${SCRIPT_DIR}/start-display.sh" "${INSTALL_DIR}/start-display.sh"
chmod +x "${INSTALL_DIR}/start-display.sh"
chown "${SERVICE_USER}:${SERVICE_USER}" "${INSTALL_DIR}/start-display.sh"

cat > /etc/systemd/system/eventstimer-display.service << EOF
[Unit]
Description=EventsTimer — Display Kiosk (Chromium)
After=eventstimer.service graphical-session.target
Wants=eventstimer.service

[Service]
Type=simple
User=${SERVICE_USER}
Environment=DISPLAY=:0
Environment=WAYLAND_DISPLAY=wayland-0
Environment=XDG_RUNTIME_DIR=/run/user/$(id -u ${SERVICE_USER})
ExecStartPre=/bin/sleep 5
ExecStart=${INSTALL_DIR}/start-display.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=graphical-session.target
EOF

# ── 7b. Release eth0 from the system DHCP client ─────────────────────────────
# network-manager.py owns eth0 exclusively — dhcpcd or NetworkManager must not
# also manage it, or they will fight: re-assigning IPs after our flush, holding
# port 68, and conflicting with dhclient calls.

NM_IFACE="${TIMER_IFACE:-eth0}"

if systemctl is-active --quiet dhcpcd 2>/dev/null || \
   systemctl is-enabled --quiet dhcpcd 2>/dev/null; then
    if ! grep -q "denyinterfaces ${NM_IFACE}" /etc/dhcpcd.conf 2>/dev/null; then
        printf '\n# EventsTimer: network-manager.py owns this interface\ndenyinterfaces %s\n' \
            "${NM_IFACE}" >> /etc/dhcpcd.conf
        echo "  dhcpcd:          configured to ignore ${NM_IFACE}"
    else
        echo "  dhcpcd:          already ignoring ${NM_IFACE}"
    fi
    systemctl restart dhcpcd 2>/dev/null || true
fi

if systemctl is-active --quiet NetworkManager 2>/dev/null; then
    mkdir -p /etc/NetworkManager/conf.d
    cat > /etc/NetworkManager/conf.d/eventstimer.conf << NMEOF
[keyfile]
unmanaged-devices=interface-name:${NM_IFACE}
NMEOF
    systemctl reload NetworkManager 2>/dev/null || true
    echo "  NetworkManager:  configured to ignore ${NM_IFACE}"
fi

# ── 8. Avahi and final startup ────────────────────────────────────────────────

echo "[8/8] Configuring avahi and enabling services..."

# IPv4-only mDNS — prevents Windows browsers from resolving to IPv6 link-local
sed -i 's/^#*use-ipv4=.*/use-ipv4=yes/'                       /etc/avahi/avahi-daemon.conf || true
sed -i 's/^#*use-ipv6=.*/use-ipv6=no/'                        /etc/avahi/avahi-daemon.conf || true
sed -i 's/^#*publish-aaaa-on-ipv4=.*/publish-aaaa-on-ipv4=no/' /etc/avahi/avahi-daemon.conf || true
sed -i 's/^#*publish-a-on-ipv6=.*/publish-a-on-ipv6=no/'       /etc/avahi/avahi-daemon.conf || true

# dnsmasq is managed by network-manager.py — not enabled at boot
systemctl disable dnsmasq || true

systemctl daemon-reload
systemctl enable eventstimer-network.service
systemctl enable eventstimer.service
systemctl enable eventstimer-display.service
systemctl enable avahi-daemon

systemctl start avahi-daemon
systemctl start eventstimer-network.service

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "=== Installation complete ==="
echo ""
echo "  Version:      ${VERSION}"
echo "  OS:           ${PRETTY_NAME:-$OS_ID}"
echo "  User:         ${SERVICE_USER}"
echo "  Install dir:  ${INSTALL_DIR}"
echo "  Node.js:      $(node --version)"
echo "  Chromium:     ${CHROMIUM_BIN}"
echo ""
echo "  Reboot to start all services:"
echo "    sudo reboot"
echo ""
echo "  Or start the server now (no display kiosk):"
echo "    sudo systemctl start eventstimer"
echo ""
echo "  URLs after reboot:"
echo "    Control:  http://timer.local/control"
echo "    Admin:    http://timer.local/admin"
echo "    Display:  http://timer.local/display"
echo ""
echo "  Updates:"
echo "    Admin page → Developer → Check for Updates"
echo "    Or: sudo bash ${INSTALL_DIR}/update.sh"
echo ""
