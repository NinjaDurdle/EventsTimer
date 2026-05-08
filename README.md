# EventsTimer — v1.9.0

Stage management countdown timer for Raspberry Pi and Debian-based Linux.
Browser-controlled, OSC-compatible, CDEther-compatible, Irisdown-compatible.

---

## Package Contents

```
eventstimer/
├── install.sh              ← run this first
├── server.js               ← Node.js server
├── package.json
├── config.json             ← port and hostname defaults
├── network-manager.py      ← automatic DHCP / self-hosting
├── public/
│   ├── display.html        ← fullscreen kiosk output
│   ├── control.html        ← operator control page
│   ├── admin.html          ← configuration and status
│   └── fonts/              ← bundled woff2 fonts (after install)
└── bridges/
    ├── irisdown.js         ← Irisdown → Timer bridge
    ├── mitti.js            ← Mitti → Timer bridge
    ├── millumin.js         ← Millumin V4/V5 → Timer bridge
    ├── pixera.js           ← Pixera → Timer bridge
    └── ltc.js              ← LTC Timecode → Timer bridge
```

---

## Quick Start

### 1. Flash the Pi

Flash **Raspberry Pi OS Trixie 64-bit** (based on Debian 13) using Raspberry Pi Imager.
In the Imager settings (⚙ icon) before flashing:

- Set hostname: `timer-1` (or `timer-2`, `timer-3` for additional units)
- Enable SSH
- Set a username and password of your choice
- Configure Wi-Fi if not using ethernet

### 2. Copy the package to the Pi

```bash
# Replace <username> with the username you set in Imager
# Replace <hostname> with the hostname you set in Imager
scp -r eventstimer/ <username>@<hostname>.local:~/
```

Or copy the folder to a USB drive and plug it into the Pi.

### 3. Run the installer

```bash
ssh <username>@<hostname>.local
cd ~/eventstimer
sudo bash install.sh
```

Takes 3–5 minutes. Requires internet for Node.js and font downloads.

### 4. Reboot

```bash
sudo reboot
```

### 5. Open the web UI

Replace `<hostname>` with the hostname you configured in step 1.

| Page | URL | Used by |
|---|---|---|
| Control | http://\<hostname\>.local/control | Operator / stage manager |
| Display | http://\<hostname\>.local/ | Extra screens, confidence monitors |
| Admin | http://\<hostname\>.local/admin | Tech / setup |

---

## Network Behaviour

### With a router (normal show)
The Pi detects the existing DHCP server, gets a lease, and advertises
`<hostname>.local` via mDNS. All devices on the network can reach it by
hostname without any additional configuration.

### Standalone / no router
If no DHCP server is found within ~36 seconds the Pi becomes the DHCP server:
- Assigns itself `192.168.39.1`
- Serves `192.168.39.10–200` to connected devices
- Still advertises `<hostname>.local` via mDNS

### Ceding when a router appears
The network manager polls every 30 seconds. If a real router appears it hands
off DHCP control automatically — no reboot needed.

---

## Control Page

### Transport buttons

| Button | Action |
|---|---|
| ▶ Start | Start or resume |
| ⏸ Pause | Pause — holds time without zeroing |
| ⏹ Stop | Stop and zero the display |
| ↺ Reset | Return to last set time |

### Modes
**Countdown** — counts down to zero  
**Count Up** — counts up from zero  
**Clock** — shows wall clock time (starts automatically)  
**External** — display driven by a bridge from external software

### Jog buttons
`+5` `+1` `−1` `−5` — adjust minutes while running or paused

### Message
Appears below the timer on the display page. Persists through pause/stop/reset.

### Presets
Save named snapshots of time, mode, and display config. Load instantly during
a show. Survive server restarts.

---

## OSC Control (port 3001, TCP and UDP)

Commands are plain ASCII, newline-terminated. Compatible with any OSC software
that supports plain text UDP, and directly testable with `nc`.

```
/timer/start
/timer/pause
/timer/stop
/timer/reset
/timer/set HH:MM:SS
/timer/mode countdown|countup|clock|external
/timer/add [minutes]
/timer/subtract [minutes]
/timer/preset/load <id>
/timer/preset/save <id>
/timer/message <text>
/timer/message                  ← clears message
```

### OSC Feedback (UDP broadcast, port 3002)

```
/timer/state running=true mode=countdown time=00:05:00 ms=300000 end=false
```

Broadcast every 500ms. Set the feedback target in Admin → Network & System.

### Quick test

```bash
# Replace <hostname> with your Pi's hostname
echo -e "/timer/start\n"        | nc -w1 <hostname>.local 3001
echo -e "/timer/set 00:10:00\n" | nc -u -w1 <hostname>.local 3001
```

---

## Irisdown Protocol (port 61002, TCP)

Full implementation of the Irisdown Countdown Timer v2.0.10 Remote Control
Protocol. Point any Irisdown-compatible controller at this Pi instead of a
Windows PC running Irisdown.

```
GO                    start
PAUSE                 pause
TOGGLEPAUSE           start/pause toggle
RESET                 reset to set time
RESET hh:mm:ss        set new time and reset
JOG <minutes>         adjust while running
STATE                 PLAYING | PAUSED | STOPPED
REMAINING             seconds remaining
UPDATES ON            subscribe to push updates
UPDATEMODE 2          key=value format
VERSION               returns 2.0.10.0
MESSAGE "text"        display message
MESSAGE CLEAR         clear message
```

---

## IDCT Broadcast (port 61003, UDP)

100ms broadcast to `255.255.255.255:61003` in CDEther-compatible format.
Interspace CDEther receivers and Irisdown-compatible displays on the same
network receive it automatically — no configuration needed on the receiver end.

The Pi is a drop-in replacement for a CDEther transmitter.

---

## Bridges

Bridges connect external playback systems to the timer in External mode. They
run as child processes on the Pi and are managed from **Admin → Bridges**.

### Available bridges

| Bridge | Source software | Protocol |
|---|---|---|
| `irisdown.js` | Irisdown (Windows) | TCP |
| `mitti.js` | Mitti (Mac) | Binary OSC |
| `millumin.js` | Millumin V4/V5 (Mac) | Binary OSC |
| `pixera.js` | Pixera (Windows) | JSON-RPC TCP |
| `ltc.js` | LTC timecode via USB audio | ALSA / ltcdump |

### Setup via Admin page

1. Open Admin → Bridges
2. Fill in the connection fields for the bridge you want to use
3. Press **▶ Start**

The timer switches to External mode automatically when a bridge connects and
starts receiving data.

### Setup via command line

Each bridge accepts `--flag value` arguments matching its config fields:

```bash
# Irisdown — replace with the IP of the machine running Irisdown
node /opt/eventstimer/bridges/irisdown.js \
  --irisdown 192.168.1.50 \
  --timer localhost

# Mitti — run on the Pi, point Mitti's OSC feedback at the Pi's IP on port 51001
node /opt/eventstimer/bridges/mitti.js \
  --port 51001 \
  --timer localhost

# Pixera — replace with Pixera's IP and your timeline name
node /opt/eventstimer/bridges/pixera.js \
  --pixera 192.168.1.100 \
  --timeline "Timeline 1" \
  --timer localhost

# LTC — replace hw:1,0 with your ALSA device (find with: aplay -l)
node /opt/eventstimer/bridges/ltc.js \
  --device hw:1,0 \
  --timer localhost
```

### Writing a new bridge

Drop a `.js` file into `/opt/eventstimer/bridges/`. Add a metadata block at
the top so the Admin page discovers its name, description, and config fields:

```javascript
/* BRIDGE_META
{
  "name": "My Bridge",
  "description": "Connects X to the timer.",
  "fields": [
    { "id": "host", "label": "Host IP", "type": "text",   "default": "" },
    { "id": "port", "label": "Port",    "type": "number", "default": "1234" }
  ]
}
BRIDGE_META */
```

Fields become `--host x.x.x.x --port 1234` CLI arguments. The bridge sends
`/timer/set HH:MM:SS` via UDP to port 3001.

Press **⟳ Refresh** in the Admin Bridges card after dropping in a new script.

---

## Companion Module

Located in `companion-module-binarylogic-eventstimer/`.

### Install

```bash
cd companion-module-binarylogic-eventstimer
npm install && npm run build
```

Import in Companion: **Settings → Modules → Import from file**.

### Actions
Start, Pause, Start/Pause toggle, Stop, Reset, Set Time, Add/Subtract Time,
Set Mode, Load Preset, Send Message, Clear Message

### Feedbacks
Timer running, Timer stopped, Countdown reached zero, Mode: Countdown /
Count Up / Clock

### Variables

| Variable | Value |
|---|---|
| `$(eventstimer:time)` | `HH:MM:SS` |
| `$(eventstimer:time_ms)` | Milliseconds |
| `$(eventstimer:running)` | `true` / `false` |
| `$(eventstimer:mode)` | `countdown` / `countup` / `clock` |
| `$(eventstimer:end_reached)` | `true` / `false` |

---

## Updating an Existing Install

```bash
# Replace <username> and <hostname> with your Pi's credentials
scp -r eventstimer/ <username>@<hostname>.local:~/
ssh <username>@<hostname>.local
cd ~/eventstimer
sudo bash install.sh
```

The installer preserves `config.json` and `presets.json`. All other files
are updated.

---

## Troubleshooting

**`<hostname>.local` not resolving (Windows)**  
Check Services → DNS Client is Running. If still failing, use the IP address
directly — check your router's DHCP table, or run `arp -a` on a connected
machine.

**Display page blank**  
Check the browser console for errors. Use Admin → Developer → Force Reload
Display Page to push a reload to all connected display pages.

**Chromium kiosk not starting**  
The display kiosk requires a graphical desktop session (Pi OS with Desktop,
not Lite).
```bash
sudo systemctl status eventstimer-display
journalctl -u eventstimer-display -n 20
```

**Server not starting**
```bash
sudo systemctl status eventstimer
journalctl -u eventstimer -n 30
```

**Pi booting as DHCP server unexpectedly**
```bash
sudo systemctl restart eventstimer-network
journalctl -u eventstimer-network -n 30
```

**Bridge not connecting**
```bash
# Test that the source machine is reachable on the expected port
# Replace the IP and port with your source machine's values
nc -zv 192.168.1.x 61002
```

---

## Port Reference

| Port | Protocol | Direction | Description |
|---|---|---|---|
| 80 | TCP | In | HTTP + WebSocket |
| 3001 | TCP | In | OSC control |
| 3001 | UDP | In | OSC control |
| 3002 | UDP | Out | OSC feedback broadcast |
| 61002 | TCP | In | Irisdown Remote Control Protocol |
| 61003 | UDP | Out | IDCT broadcast (CDEther compatible) |

All ports are configurable in Admin → Network & System.

---

## Hardware Notes

### Recommended

| Component | Spec |
|---|---|
| Pi model | Pi 4B (2GB+) or Pi 5 |
| Storage | 16GB+ A1 microSD or USB SSD |
| OS | Raspberry Pi OS Trixie 64-bit |
| Power | Official Pi PSU (5V 3A) |

Pi 3B+ works. Pi Zero 2W works headless only.

### LTC timecode input

LTC (Linear Timecode) is received via a USB audio interface with a line input
(e.g. Behringer UCA202, ~£25). Connect the LTC source to the line input.
Install `ltcdump` on the Pi (`sudo apt install ltcdump`) and use the LTC bridge.
Find the ALSA device name with `aplay -l` — typically `hw:1,0` for the first
USB audio device.

### CDEther XLR input (advanced)

The Interspace XLR data signal is RS-232 at ±12V. The Pi GPIO UART runs at
3.3V. A **MAX3232 level-shifter** (~£3 breakout board) is required between
them. Verify the XLR pinout with a multimeter before connecting — incorrect
wiring can damage the Pi GPIO.

---

## Version History

| Version | Summary |
|---|---|
| **1.8.0** | Nested timers (sequential children): parent session clock, children fire in sequence, Fire Next auto-starts next child, useParentRemaining snaps child duration at fire time |
| **1.7.7** | Three-column control page redesign, admin redesign, color system (3 named slots), restart/reboot/shutdown buttons |
| **1.3.1** | Version stamping across all files, bridge version metadata, admin version display, project renamed to EventsTimer |
| **1.3** | External source mode, IDCT broadcast, Irisdown TCP server, Bridge manager, Mitti / Millumin / Pixera / LTC bridges, bundled fonts, admin status card |
| **1.2** | Message display, color triggers, digit visibility, position/width sliders |
| **1.1** | Preset system, end-of-countdown behaviors, OSC feedback, mDNS hostname config |
| **1.0** | Initial — countdown/countup/clock modes, OSC control, WebSocket display |
