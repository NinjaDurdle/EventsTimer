#!/usr/bin/env node
/* BRIDGE_META
{
  "name": "Irisdown Countdown Timer",
  "version": "1.4.0",
  "type": "receive",
  "description": "Connects to Irisdown (Windows) and mirrors its timer to this display. Irisdown must have Remote Control enabled (port 61002).",
  "fields": [
    { "id": "irisdown",      "label": "Irisdown host IP",  "type": "text",   "default": "" },
    { "id": "irisdown-port", "label": "Irisdown TCP port", "type": "number", "default": "61002" },
    { "id": "no-auto-mode",  "label": "Skip auto-switch to External mode", "type": "checkbox", "default": false }
  ]
}
BRIDGE_META */
/**
 * bridges/irisdown.js — Irisdown → EventsTimer bridge
 *
 * Connects to a running Irisdown Countdown Timer (Windows app) as a TCP client,
 * subscribes to UPDATES mode 2, and forwards the time remaining to the timer
 * via WebSocket.
 *
 * Options:
 *   --irisdown <host>   IP or hostname of the Windows machine running Irisdown
 *   --irisdown-port     Irisdown TCP port (default: 61002)
 *   --http-port         EventsTimer HTTP/WS port (default: 80, injected by bridge manager)
 *   --no-auto-mode      Don't automatically switch timer to external mode on connect
 *
 * The bridge automatically:
 *   - Reconnects if Irisdown closes the connection or is restarted
 *   - Reconnects to the timer if the server restarts
 *   - Switches the timer to external mode when connected and data is flowing
 *   - Does NOT switch the timer back on disconnect (operator decides what to do)
 */

const net = require("net");
const { WebSocket } = require("ws");

// ── Args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : def;
}

const IRISDOWN_HOST = arg("--irisdown",      "127.0.0.1");
const IRISDOWN_PORT = parseInt(arg("--irisdown-port", "61002"), 10);
const HTTP_PORT     = parseInt(arg("--http-port",     "80"),    10);
const AUTO_MODE     = !args.includes("--no-auto-mode");

console.log(`\nIrisdown → EventsTimer bridge`);
console.log(`  Irisdown:  ${IRISDOWN_HOST}:${IRISDOWN_PORT}`);
console.log(`  Timer WS:  ws://localhost:${HTTP_PORT}`);
console.log(`  Auto-mode: ${AUTO_MODE ? "yes (will set timer to external mode)" : "no"}\n`);

// ── WebSocket connection to EventsTimer ───────────────────────────────────────

let ws;
let modeSet = false;
let wsReconnectDelay = 2000;

function sendCommand(action, payload = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "command", payload: { action, ...payload } }));
}

function connectWs() {
  ws = new WebSocket(`ws://localhost:${HTTP_PORT}`);

  ws.on("open", () => {
    wsReconnectDelay = 2000;
  });

  ws.on("close", () => {
    // Reset modeSet so external mode is re-asserted after a server restart
    modeSet = false;
    setTimeout(connectWs, wsReconnectDelay);
    wsReconnectDelay = Math.min(wsReconnectDelay * 1.5, 30_000);
  });

  ws.on("error", (e) => {
    console.error(`  WS error: ${e.message}`);
    ws.terminate();
  });
}

connectWs();

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

function hmsToMs(hms) {
  const parts = hms.split(":").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return null;
  const [h, m, s] = parts;
  return (h * 3600 + m * 60 + s) * 1000;
}

// ── TCP connection to Irisdown ────────────────────────────────────────────────

let irisdownReconnectDelay = 2000;

function connect() {
  console.log(`Connecting to Irisdown at ${IRISDOWN_HOST}:${IRISDOWN_PORT}…`);

  const socket = new net.Socket();
  let buffer = "";

  socket.connect(IRISDOWN_PORT, IRISDOWN_HOST, () => {
    console.log("  Connected to Irisdown ✓");
    irisdownReconnectDelay = 2000;

    // Switch timer to external mode before data starts flowing
    if (AUTO_MODE && !modeSet) {
      sendCommand("setMode", { mode: "external" });
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
      buffer = buffer.slice(i + 1);
      if (!line) continue;

      if (line.startsWith("TIME=")) {
        const parsed = parseUpdate(line);
        const timeStr = parsed.TIME;
        if (!timeStr) continue;
        // TIME sign: + = normal, - = overtime. We send the absolute value.
        const ms = hmsToMs(timeStr.slice(1));
        if (ms !== null) {
          sendCommand("setTime", { ms });
          process.stdout.write(`\r  ${line.split("&")[0]}  `);
        }
      } else if (line === "OK") {
        // Acknowledge — ignore
      } else {
        console.log(`  Irisdown → "${line}"`);
      }
    }
  });

  socket.on("close", () => {
    console.log(`\n  Irisdown disconnected — reconnecting in ${irisdownReconnectDelay / 1000}s…`);
    setTimeout(connect, irisdownReconnectDelay);
    irisdownReconnectDelay = Math.min(irisdownReconnectDelay * 1.5, 30_000);
  });

  socket.on("error", (err) => {
    console.error(`\n  Connection error: ${err.message}`);
    socket.destroy();
  });
}

// ── Startup ───────────────────────────────────────────────────────────────────

connect();

process.on("SIGINT", () => {
  console.log("\n\nBridge stopped.");
  if (ws) ws.terminate();
  process.exit(0);
});
