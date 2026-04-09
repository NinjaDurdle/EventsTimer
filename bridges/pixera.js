#!/usr/bin/env node
/* BRIDGE_META
{
  "name": "Pixera",
  "version": "1.4.0",
  "type": "receive",
  "description": "Polls a Pixera timeline for countdown time remaining via JSON-RPC over TCP and drives the display. Set up API Access in Pixera Settings → API, using JSON/TCP(dl) protocol.",
  "fields": [
    { "id": "pixera",      "label": "Pixera host IP",     "type": "text",   "default": "" },
    { "id": "pixera-port", "label": "Pixera API port",    "type": "number", "default": "1400" },
    { "id": "timeline",    "label": "Timeline name",      "type": "text",   "default": "Timeline 1" },
    { "id": "poll-ms",     "label": "Poll interval (ms)", "type": "number", "default": "100" },
    { "id": "no-auto-mode", "label": "Skip auto-switch to External mode", "type": "checkbox", "default": false }
  ]
}
BRIDGE_META */
/**
 * bridges/pixera.js — Pixera → EventsTimer bridge
 *
 * Connects to Pixera as a TCP client (JSON/TCP dl mode).
 * Polls getCurrentCountdownHMSFOfTimeline at a configurable interval
 * and forwards the countdown time to the timer via WebSocket.
 *
 * Pixera setup:
 *   Settings → API → API Access 1 (or 2)
 *   Protocol: JSON/TCP(dl)
 *   Port: 1400 (or your chosen port)
 *   Input Network Adapter: choose the network interface connected to your show network
 *
 * The JSON/TCP(dl) protocol appends "0xPX" as a delimiter to every message.
 * Responses also end with "0xPX".
 *
 * Options:
 *   --pixera <host>       Pixera host IP (default: 127.0.0.1)
 *   --pixera-port <n>     Pixera API port (default: 1400)
 *   --timeline <name>     Timeline name to poll (default: Timeline 1)
 *   --poll-ms <n>         Poll interval in milliseconds (default: 100)
 *   --http-port <n>       EventsTimer HTTP/WS port (default: 80, injected by bridge manager)
 *   --no-auto-mode        Don't automatically switch timer to external mode
 */

const net = require("net");
const { WebSocket } = require("ws");

// ── Args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function arg(name, def) { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : def; }

const PIXERA_HOST   = arg("--pixera",      "127.0.0.1");
const PIXERA_PORT   = parseInt(arg("--pixera-port", "1400"), 10);
const TIMELINE_NAME = arg("--timeline",    "Timeline 1");
const POLL_MS       = parseInt(arg("--poll-ms",     "100"),  10);
const HTTP_PORT     = parseInt(arg("--http-port",   "80"),   10);
const AUTO_MODE     = !args.includes("--no-auto-mode");

const DELIMITER = "0xPX";

console.log("\nPixera → EventsTimer bridge");
console.log(`  Pixera:    ${PIXERA_HOST}:${PIXERA_PORT}`);
console.log(`  Timeline:  "${TIMELINE_NAME}"`);
console.log(`  Poll:      ${POLL_MS}ms`);
console.log(`  Timer WS:  ws://localhost:${HTTP_PORT}`);
console.log(`  Auto-mode: ${AUTO_MODE}\n`);

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

// ── HMSF → milliseconds ───────────────────────────────────────────────────────
// Pixera returns "HH:MM:SS:FF" — we strip frames and convert to ms.

function hmsfToMs(hmsf) {
  const parts = String(hmsf).split(":");
  if (parts.length < 3) return null;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  const s = parseInt(parts[2], 10);
  if ([h, m, s].some(isNaN)) return null;
  return (h * 3600 + m * 60 + s) * 1000;
}

// ── JSON-RPC over TCP (dl mode) ───────────────────────────────────────────────

let msgId          = 1;
let socket         = null;
let recvBuf        = "";
let pollTimer      = null;
let pixReconnectDelay = 2000;
const pending      = new Map(); // id → { resolve, reject }

function sendRpc(method, params) {
  return new Promise((resolve, reject) => {
    if (!socket || !socket.writable) {
      reject(new Error("Not connected"));
      return;
    }
    const id  = msgId++;
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + DELIMITER;
    pending.set(id, { resolve, reject });
    socket.write(msg);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error("RPC timeout"));
      }
    }, 2000);
  });
}

function handleResponse(json) {
  let parsed;
  try { parsed = JSON.parse(json); } catch { return; }
  const cb = pending.get(parsed.id);
  if (!cb) return;
  pending.delete(parsed.id);
  if (parsed.error) cb.reject(new Error(parsed.error.message || "RPC error"));
  else cb.resolve(parsed.result);
}

function connectPixera() {
  console.log(`Connecting to Pixera at ${PIXERA_HOST}:${PIXERA_PORT}…`);

  socket = new net.Socket();
  socket.setEncoding("utf8");

  socket.connect(PIXERA_PORT, PIXERA_HOST, () => {
    console.log("  Connected to Pixera ✓");
    pixReconnectDelay = 2000;
    startPolling();
  });

  socket.on("data", (chunk) => {
    recvBuf += chunk;
    let idx;
    while ((idx = recvBuf.indexOf(DELIMITER)) !== -1) {
      const msg = recvBuf.slice(0, idx).trim();
      recvBuf   = recvBuf.slice(idx + DELIMITER.length);
      if (msg) handleResponse(msg);
    }
  });

  socket.on("close", () => {
    console.log(`\n  Pixera disconnected — reconnecting in ${pixReconnectDelay / 1000}s…`);
    stopPolling();
    setTimeout(connectPixera, pixReconnectDelay);
    pixReconnectDelay = Math.min(pixReconnectDelay * 1.5, 30_000);
  });

  socket.on("error", (err) => {
    console.error(`\n  Connection error: ${err.message}`);
    socket.destroy();
  });
}

// ── Polling loop ──────────────────────────────────────────────────────────────

function startPolling() {
  stopPolling();
  pollTimer = setInterval(poll, POLL_MS);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function poll() {
  try {
    const result = await sendRpc(
      "Pixera.Compound.getCurrentCountdownHMSFOfTimeline",
      { name: TIMELINE_NAME }
    );

    if (AUTO_MODE && !modeSet) {
      sendCommand("setMode", { mode: "external" });
      modeSet = true;
      console.log("\n  Timer set to external mode");
    }

    const ms = hmsfToMs(result);
    if (ms !== null) {
      sendCommand("setTime", { ms });
      process.stdout.write(`\r  Pixera countdown: ${result} → ${ms}ms  `);
    }
  } catch (e) {
    if (e.message !== "Not connected") {
      process.stdout.write(`\r  Poll error: ${e.message}  `);
    }
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────

connectPixera();

process.on("SIGINT", () => {
  console.log("\nBridge stopped.");
  stopPolling();
  if (ws) ws.terminate();
  if (socket) socket.destroy();
  process.exit(0);
});
