#!/usr/bin/env node
/* BRIDGE_META
{
  "name": "Irisdown Countdown Timer",
  "version": "1.3.1",
  "description": "Connects to Irisdown (Windows) and mirrors its timer to this display. Irisdown must have Remote Control enabled (port 61002).",
  "fields": [
    { "id": "irisdown",      "label": "Irisdown host IP",  "type": "text",   "default": "" },
    { "id": "irisdown-port", "label": "Irisdown TCP port", "type": "number", "default": "61002" },
    { "id": "no-auto-mode",  "label": "Skip auto-switch to External mode", "type": "checkbox", "default": false }
  ]
}
BRIDGE_META */
/**
 * bridges/irisdown.js — Irisdown → Countdown Timer bridge
 *
 * Connects to a running Irisdown Countdown Timer (Windows app) as a TCP client,
 * subscribes to UPDATES mode 2, and forwards the time remaining to our timer
 * via UDP OSC commands (/timer/set and /timer/mode external).
 *
 * Usage:
 *   node bridges/irisdown.js --irisdown 192.168.1.50 --timer timer-1.local
 *
 * Options:
 *   --irisdown <host>   IP or hostname of the Windows machine running Irisdown
 *   --irisdown-port     Irisdown TCP port (default: 61002)
 *   --timer <host>      Hostname or IP of the countdown timer Pi (default: timer-1.local)
 *   --timer-port        Timer OSC UDP port (default: 3001)
 *   --no-auto-mode      Don't automatically switch timer to external mode on connect
 *
 * The bridge automatically:
 *   - Reconnects if Irisdown closes the connection or is restarted
 *   - Switches the timer to external mode when connected and data is flowing
 *   - Does NOT switch the timer back on disconnect (operator decides what to do)
 */

const net   = require("net");
const dgram = require("dgram");

// ── Config from command line args ─────────────────────────────────────────────

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : def;
}

const IRISDOWN_HOST  = arg("--irisdown",      "127.0.0.1");
const IRISDOWN_PORT  = parseInt(arg("--irisdown-port", "61002"), 10);
const TIMER_HOST     = arg("--timer",         "timer-1.local");
const TIMER_PORT     = parseInt(arg("--timer-port",    "3001"),  10);
const AUTO_MODE      = !args.includes("--no-auto-mode");

console.log(`\nIrisdown → Countdown Timer bridge`);
console.log(`  Irisdown:  ${IRISDOWN_HOST}:${IRISDOWN_PORT}`);
console.log(`  Timer:     ${TIMER_HOST}:${TIMER_PORT}`);
console.log(`  Auto-mode: ${AUTO_MODE ? "yes (will set timer to external mode)" : "no"}\n`);

// ── UDP sender — sends OSC-style commands to our timer ───────────────────────

const udp = dgram.createSocket("udp4");
udp.bind(() => {}); // bind to ephemeral port

function sendToTimer(cmd) {
  const buf = Buffer.from(cmd + "\n");
  udp.send(buf, TIMER_PORT, TIMER_HOST, (err) => {
    if (err) console.error(`  UDP send error: ${err.message}`);
  });
}

// ── Irisdown protocol parser ──────────────────────────────────────────────────
// Mode 2 update line: TIME=±hh:mm:ss&STATE=PLAYING|PAUSED|STOPPED&DISPLAY=TIMER|CLOCK|BLACK|TEST&MESSAGE=TRUE|FALSE

function parseUpdate(line) {
  const result = {};
  for (const part of line.split("&")) {
    const [key, val] = part.split("=");
    if (key && val !== undefined) result[key.trim()] = val.trim();
  }
  return result;
}

function updateToOsc(parsed) {
  // TIME field: ±hh:mm:ss  (- means overtime/negative)
  const timeStr = parsed.TIME;
  if (!timeStr) return null;

  const sign = timeStr[0]; // + or -
  const hms  = timeStr.slice(1); // hh:mm:ss

  // We send the absolute time — overtime is represented as endReached on our end
  // The timer's stop behavior handles what happens at zero
  return `/timer/set ${hms}`;
}

// ── TCP connection to Irisdown ────────────────────────────────────────────────

let reconnectDelay = 2000;
let connected      = false;
let modeSet        = false;

function connect() {
  console.log(`Connecting to Irisdown at ${IRISDOWN_HOST}:${IRISDOWN_PORT}…`);

  const socket = new net.Socket();
  let buffer   = "";

  socket.connect(IRISDOWN_PORT, IRISDOWN_HOST, () => {
    console.log("  Connected to Irisdown ✓");
    reconnectDelay = 2000;
    connected      = true;

    // Switch timer to external mode before data starts flowing
    if (AUTO_MODE && !modeSet) {
      sendToTimer("/timer/mode external");
      modeSet = true;
      console.log("  Timer set to external mode");
    }

    // Subscribe to mode 2 updates (key=value format)
    socket.write("UPDATEMODE 2\r\n");
    socket.write("UPDATES ON\r\n");
    console.log("  Subscribed to UPDATES mode 2\n");
  });

  socket.setEncoding("utf8");

  socket.on("data", (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, i).replace(/\r$/, "").trim();
      buffer     = buffer.slice(i + 1);
      if (!line) continue;

      // Mode 2 update lines start with TIME=
      if (line.startsWith("TIME=")) {
        const parsed = parseUpdate(line);
        const cmd    = updateToOsc(parsed);
        if (cmd) {
          sendToTimer(cmd);
          process.stdout.write(`\r  ${line.split("&")[0]}  `); // live time display
        }
      } else if (line === "OK") {
        // Acknowledge — ignore
      } else {
        console.log(`  Irisdown → "${line}"`);
      }
    }
  });

  socket.on("close", () => {
    connected = false;
    modeSet = false;
    console.log(`\n  Irisdown disconnected — reconnecting in ${reconnectDelay / 1000}s…`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 30_000);
  });

  socket.on("error", (err) => {
    console.error(`\n  Connection error: ${err.message}`);
    socket.destroy();
  });
}

// ── Startup ───────────────────────────────────────────────────────────────────

connect();

// Keep process alive
process.on("SIGINT", () => {
  console.log("\n\nBridge stopped.");
  udp.close();
  process.exit(0);
});
