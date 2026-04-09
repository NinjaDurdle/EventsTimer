# EventsTimer — Control & Feedback API

**Version:** 1.3.1

All ports are configurable in `config.json`. Values shown are defaults.

---

## WebSocket API

**Endpoint:** `ws://<host>/`  
**Port:** 80 (shared with HTTP)

The primary control interface. All connected clients receive the same broadcasts — control pages, display pages, and any external tooling.

### Server → Client Messages

All messages are JSON: `{ "type": "<type>", "payload": <payload> }`

#### `state`

Sent on every tick (100ms while running), after every command, and immediately on connection.

```json
{
  "type": "state",
  "payload": {
    "timer": {
      "mode": "countdown",
      "running": false,
      "currentMs": 300000,
      "targetMs": 300000,
      "endBehavior": "flash",
      "nextPresetId": null,
      "endReached": false,
      "message": "",
      "lastExternalMs": null
    },
    "display": {
      "font": "monospace",
      "fontSize": "20",
      "textColor": "#ffffff",
      "bgColor": "#000000",
      "showSubseconds": false,
      "label": "",
      "flashColor": "#ff0000",
      "visibleDigits": [false, false, true, true, true, true],
      "colorTriggers": [],
      "positionX": 50,
      "positionY": 50
    },
    "message": {
      "font": "monospace",
      "fontSize": "5",
      "textColor": "#ffffff",
      "bgColor": "#000000",
      "bgOpacity": 0,
      "positionX": 50,
      "positionY": 90,
      "width": 80
    }
  }
}
```

**`timer` fields:**

| Field | Type | Description |
|---|---|---|
| `mode` | string | `countdown`, `countup`, `clock`, `external` |
| `running` | boolean | Whether the tick loop is active |
| `currentMs` | number | Current display value in milliseconds |
| `targetMs` | number | Set time in milliseconds (countdown target) |
| `endBehavior` | string | `flash`, `hold`, or `next` |
| `nextPresetId` | string\|null | Preset ID to load when `endBehavior` is `next` |
| `endReached` | boolean | True when countdown has reached zero |
| `message` | string | Active message text; empty string = hidden |
| `lastExternalMs` | number\|null | Timestamp of last `setTime` in external mode |

**`display` fields:**

| Field | Type | Description |
|---|---|---|
| `font` | string | CSS font-family string |
| `fontSize` | string | Numeric string; renders as `N vw` |
| `textColor` | string | Hex color |
| `bgColor` | string | Hex color |
| `showSubseconds` | boolean | Show tenths of a second |
| `label` | string | Text shown above the timer |
| `flashColor` | string | Hex color used during end flash |
| `visibleDigits` | boolean[6] | Which digit pairs to show: `[tensH, onesH, tensM, onesM, tensS, onesS]` |
| `colorTriggers` | object[] | Color changes at time thresholds (see below) |
| `positionX` | number | Horizontal position, percent from left (0–100) |
| `positionY` | number | Vertical position, percent from top (0–100) |

**`colorTriggers` entries** (countdown mode only):

```json
{ "atMs": 60000, "textColor": "#ff0000", "bgColor": "#000000" }
```

The first trigger where `currentMs <= atMs` is applied. Triggers are sorted descending by `atMs`.

**`message` fields:**

| Field | Type | Description |
|---|---|---|
| `font` | string | CSS font-family string |
| `fontSize` | string | Numeric string; renders as `N vw` |
| `textColor` | string | Hex color |
| `bgColor` | string | Hex color (used when bgOpacity > 0) |
| `bgOpacity` | number | 0 (transparent) to 100 (opaque) |
| `positionX` | number | Percent from left |
| `positionY` | number | Percent from top |
| `width` | number | Width as percent of screen width |

---

#### `presets`

Sent on connection and after any preset save/delete.

```json
{
  "type": "presets",
  "payload": [
    {
      "id": "preset_1712345678",
      "name": "Act 1 Intro",
      "mode": "countdown",
      "targetMs": 300000,
      "endBehavior": "flash",
      "nextPresetId": null,
      "displayConfig": { }
    }
  ]
}
```

#### `sysconfig`

Sent on connection. Contains server configuration.

```json
{
  "type": "sysconfig",
  "payload": {
    "httpPort": 80,
    "oscTcpPort": 3001,
    "oscUdpPort": 3001,
    "oscFeedbackPort": 3002,
    "feedbackTarget": "auto",
    "irisdownPort": 61002,
    "idctPort": 61003,
    "hostname": "timer",
    "version": "1.3.1"
  }
}
```

#### `bridges`

Sent on connection and when bridge state changes.

```json
{
  "type": "bridges",
  "payload": [
    {
      "id": "irisdown",
      "name": "Irisdown Countdown Timer",
      "description": "...",
      "fields": [ ],
      "running": false,
      "shouldRun": false,
      "config": { }
    }
  ]
}
```

#### `reload`

Sent to all clients by `POST /api/reload`. Display pages reload themselves on receipt. No payload.

```json
{ "type": "reload" }
```

---

### Client → Server Messages

#### `command`

Controls timer transport and state.

```json
{ "type": "command", "payload": { "action": "<action>", ...params } }
```

| Action | Parameters | Description |
|---|---|---|
| `start` | — | Start the timer |
| `pause` | — | Pause; preserves `currentMs` for resume |
| `stop` | — | Stop and zero the display; does not reset `targetMs` |
| `reset` | — | Stop and return to `targetMs` (countdown) or zero (countup) |
| `setTime` | `ms: number` | Set current time in milliseconds |
| `setMode` | `mode: string` | Set mode: `countdown`, `countup`, `clock`, `external` |
| `setEndBehavior` | `behavior: string`, `nextPresetId?: string` | Set end behavior: `flash`, `hold`, `next` |
| `adjust` | `deltaMs: number` | Add or subtract milliseconds from current time (not available in `clock` or `external` mode) |
| `setMessage` | `text: string` | Set or clear the message overlay (empty string clears) |

**Mode notes:**
- `clock` — starts automatically; cannot be paused
- `external` — `running` is set to `true` but internal tick is stopped; time is driven by incoming `setTime` commands from a bridge
- Switching to `countup` resets `currentMs` to 0 and stops the timer
- Switching to `countdown` stops the timer; `currentMs` is unchanged

#### `preset`

```json
{ "type": "preset", "payload": { "action": "<action>", "preset": { } } }
```

| Action | Preset fields | Description |
|---|---|---|
| `save` | `id?`, `name`, `mode`, `targetMs`, `endBehavior`, `nextPresetId?`, `displayConfig?` | Save or overwrite a preset. `id` is generated if omitted. |
| `load` | `id` | Load and apply a preset |
| `delete` | `id` | Delete a preset |

#### `config`

Update display or message appearance. Any subset of fields may be sent.

```json
{ "type": "config", "payload": { <display or message keys> } }
```

Top-level keys update `displayConfig`. Pass a `messageConfig` object to update the message area:

```json
{
  "type": "config",
  "payload": {
    "textColor": "#ffff00",
    "fontSize": "25",
    "visibleDigits": [false, false, true, true, true, true],
    "colorTriggers": [
      { "atMs": 300000, "textColor": "#ffffff", "bgColor": "#000000" },
      { "atMs": 60000,  "textColor": "#ff0000", "bgColor": "#000000" }
    ],
    "messageConfig": {
      "fontSize": "6",
      "positionY": 85
    }
  }
}
```

---

## OSC / Plain-Text TCP

**Port:** 3001  
**Protocol:** TCP, newline-delimited plain text (not binary OSC)

Commands are ASCII strings terminated with `\n`. One command per line.

| Command | Example | Description |
|---|---|---|
| `/timer/start` | `/timer/start` | Start |
| `/timer/pause` | `/timer/pause` | Pause |
| `/timer/stop` | `/timer/stop` | Stop and zero |
| `/timer/reset` | `/timer/reset` | Reset to target time |
| `/timer/set <HH:MM:SS>` | `/timer/set 00:05:00` | Set time |
| `/timer/mode <mode>` | `/timer/mode countdown` | Set mode |
| `/timer/add [minutes]` | `/timer/add 1` | Add time (default 1 min) |
| `/timer/subtract [minutes]` | `/timer/subtract 0.5` | Subtract time (default 1 min) |
| `/timer/preset/load <id>` | `/timer/preset/load preset_123` | Load preset by ID |
| `/timer/preset/save <id>` | `/timer/preset/save preset_123` | Overwrite preset with current state |
| `/timer/message <text>` | `/timer/message Stand by` | Set message (no arg = clear) |

There is no response — this is a send-only control channel.

---

## OSC / Plain-Text UDP

**Port:** 3001  
**Protocol:** UDP

Same command set as OSC/TCP. Each datagram contains one command, terminated with `\n`.

The source address of each UDP sender is recorded and receives unicast feedback responses (see below).

---

## OSC Feedback (UDP)

**Port:** 3002  
**Protocol:** UDP broadcast or unicast  
**Interval:** every 500ms

The server broadcasts timer state to the subnet. The `feedbackTarget` config key controls the destination:

- `auto` — broadcast to all active subnet broadcast addresses
- `<IP address>` — unicast to a specific host

Additionally, any host that has sent a UDP command on port 3001 within the last 30 seconds also receives unicast feedback.

**Packet format:** plain text, newline-terminated

```
/timer/state running=<true|false> mode=<mode> time=<HH:MM:SS[.T]> ms=<int> end=<true|false>
```

**Example:**
```
/timer/state running=true mode=countdown time=00:04:32 ms=272000 end=false
```

`time` includes tenths (`HH:MM:SS.T`) when `showSubseconds` is enabled.

---

## Irisdown Protocol (TCP)

**Port:** 61002  
**Protocol:** TCP, CRLF-terminated plain text

Implements a subset of the Irisdown Countdown Timer v2.0.10 Remote Control Protocol. Allows any Irisdown-compatible controller (including Companion's Irisdown module) to control this timer.

### Commands

| Command | Response | Description |
|---|---|---|
| `GO` | `OK` | Start |
| `PAUSE` | `OK` | Pause |
| `TOGGLEPAUSE` | `OK` | Start if stopped, pause if running |
| `RESET` | `OK` | Reset to target time |
| `RESET <HH:MM:SS>` | `OK` \| `ERROR` | Set time and reset |
| `RESET <minutes>` | `OK` \| `ERROR` | Set time in minutes and reset |
| `JOG <minutes>` | `OK` \| `ERROR` | Adjust time by ± minutes (decimal supported) |
| `REMAINING` | `<seconds>` | Seconds remaining as integer |
| `STATE` | `PLAYING` \| `PAUSED` \| `STOPPED` | Current state |
| `VERSION` | `VERSION 2.0.10.0` | Protocol version |
| `DISPLAY TIMER` | `OK` | Switch to countdown mode |
| `DISPLAY CLOCK` | `OK` | Switch to clock mode |
| `MESSAGE "<text>"` | `OK` | Set message overlay |
| `MESSAGE CLEAR` | `OK` | Clear message overlay |
| `UPDATEMODE 2` | `OK` \| `ERROR` | Select push update format (only mode 2 supported) |
| `UPDATES ON` | *(push stream)* | Subscribe to push state updates |
| `UPDATES OFF` | `OK` | Unsubscribe from push updates |

### Push Updates (`UPDATES ON`)

After `UPDATEMODE 2` + `UPDATES ON`, the server pushes a state line on every change:

```
TIME=±HH:MM:SS&STATE=PLAYING|PAUSED|STOPPED&DISPLAY=TIMER|CLOCK&MESSAGE=TRUE|FALSE\r\n
```

`TIME` sign: `+` = counting, `-` = overtime (endReached). While subscribed, individual command responses (`OK`) are suppressed — state changes are visible in the push stream.

---

## IDCT Broadcast (UDP)

**Port:** 61003  
**Protocol:** UDP broadcast to 255.255.255.255  
**Interval:** every 100ms

CDEther-compatible broadcast. Makes the timer a drop-in replacement for an Interspace Industries CDEther transmitter. Any CDEther receiver or compatible display on the network will pick this up automatically.

**Packet format:** 20-character ASCII string

```
IDCT:<sign><SSSSSS><I><C><B><PPPPP>
```

| Field | Length | Description |
|---|---|---|
| `IDCT:` | 5 | Header |
| sign | 1 | `+` = normal, `-` = overtime (endReached) |
| seconds | 6 | Total seconds, zero-padded (`000000`–`344619`) |
| instance | 1 | Instance ID, hex (`0`) |
| color | 1 | Display color (`G` = green) |
| blink | 1 | Blink flag (`0` = off) |
| padding | 5 | Reserved, spaces |

**Example:** `IDCT:+0002700G0     ` (45 minutes remaining)

---

## HTTP API

**Port:** 80

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/config` | Server config + running version |
| `GET` | `/api/fonts` | Installed font families for the font picker |
| `GET` | `/api/bridges` | Bridge list with status |
| `POST` | `/api/bridges/start` | Start a bridge |
| `POST` | `/api/bridges/stop` | Stop a bridge |
| `POST` | `/api/system` | Update server config (port changes trigger restart) |
| `POST` | `/api/reload` | Force all connected display pages to reload |

### `POST /api/bridges/start`

```json
{ "id": "irisdown", "config": { "irisdown": "192.168.1.50", "irisdown-port": "61002" } }
```

### `POST /api/bridges/stop`

```json
{ "id": "irisdown" }
```

### `POST /api/system`

Any subset of the following:

```json
{
  "httpPort": 80,
  "oscTcpPort": 3001,
  "oscUdpPort": 3001,
  "oscFeedbackPort": 3002,
  "feedbackTarget": "auto",
  "irisdownPort": 61002,
  "idctPort": 61003,
  "hostname": "timer"
}
```

Port changes return `{ "restartRequired": true }` and the server restarts after 1.5 seconds. `feedbackTarget` must be `"auto"` or a valid IPv4 address. `hostname` is sanitised to `[a-z0-9-]`, max 63 characters.

---

## Ports Summary

| Port | Protocol | Direction | Purpose |
|---|---|---|---|
| 80 | TCP | In | HTTP pages + WebSocket control/state |
| 3001 | TCP | In | OSC plain-text control |
| 3001 | UDP | In | OSC plain-text control |
| 3002 | UDP | Out | OSC plain-text feedback broadcast |
| 61002 | TCP | In | Irisdown protocol control |
| 61003 | UDP | Out | IDCT / CDEther broadcast |
