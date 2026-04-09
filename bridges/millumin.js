#!/usr/bin/env node
/* BRIDGE_META
{
  "name": "Millumin V4/V5",
  "version": "1.4.0",
  "type": "receive",
  "description": "Receives media time from a named Millumin layer via OSC feedback and drives the display. Enable API feedback in Millumin (CMD+K → OSC tab → API feedback). Name the layer you want to monitor 'time' in your Millumin project (or configure a different name below).",
  "fields": [
    { "id": "port",         "label": "OSC feedback receive port", "type": "number", "default": "5001" },
    { "id": "layer",        "label": "Millumin layer name",       "type": "text",   "default": "time" },
    { "id": "no-auto-mode", "label": "Skip auto-switch to External mode", "type": "checkbox", "default": false }
  ]
}
BRIDGE_META */
/**
 * bridges/millumin.js — Millumin V4/V5 → EventsTimer bridge
 *
 * Millumin setup:
 *   1. Open Device Manager (CMD+K) → OSC tab
 *   2. Enable "API feedback"
 *   3. Set feedback target to this Pi's IP, port 5001 (or your chosen port)
 *   4. Name the layer you want to monitor "time" (or set --layer to your name)
 *
 * Millumin sends /millumin/layer:time/media/time [float:elapsed, float:duration]
 * continuously while media is playing. We compute remaining = duration - elapsed
 * and forward to the timer via WebSocket.
 *
 * Works identically for V4 and V5 — same OSC address scheme.
 *
 * Options:
 *   --port <number>     UDP port to receive Millumin OSC feedback on (default: 5001)
 *   --layer <name>      Millumin layer name to monitor (default: time)
 *   --http-port <n>     EventsTimer HTTP/WS port (default: 80, injected by bridge manager)
 *   --no-auto-mode      Don't automatically switch timer to external mode
 */

const osc = require("osc");
const { WebSocket } = require("ws");

// ── Args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function arg(name, def) { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : def; }

const LISTEN_PORT = parseInt(arg("--port",       "5001"), 10);
const LAYER_NAME  = arg("--layer",     "time");
const HTTP_PORT   = parseInt(arg("--http-port",  "80"),   10);
const AUTO_MODE   = !args.includes("--no-auto-mode");

const TARGET_ADDR = `/millumin/layer:${LAYER_NAME}/media/time`;

console.log("\nMillumin V4/V5 → EventsTimer bridge");
console.log(`  Listening on UDP port ${LISTEN_PORT}`);
console.log(`  Watching layer: "${LAYER_NAME}" (${TARGET_ADDR})`);
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

// ── OSC receiver ──────────────────────────────────────────────────────────────

let lastDuration = 0;

const udp = new osc.UDPPort({
  localAddress: "0.0.0.0",
  localPort:    LISTEN_PORT,
  metadata:     true,
});

udp.on("message", (msg) => {
  if (msg.address !== TARGET_ADDR) return;

  // Args: [float:elapsed_seconds, float:duration_seconds]
  const elapsed  = msg.args && msg.args[0] ? msg.args[0].value : 0;
  const duration = msg.args && msg.args[1] ? msg.args[1].value : lastDuration;
  if (duration > 0) lastDuration = duration;

  const remainingMs = Math.max(0, Math.round((duration - elapsed) * 1000));

  if (AUTO_MODE && !modeSet) {
    sendCommand("setMode", { mode: "external" });
    modeSet = true;
    console.log("  Timer set to external mode");
  }

  sendCommand("setTime", { ms: remainingMs });
  process.stdout.write(`\r  elapsed=${elapsed.toFixed(1)}s  duration=${duration.toFixed(1)}s  remaining=${remainingMs}ms  `);
});

udp.on("error", (err) => console.error("OSC error:", err.message));

udp.open();
console.log(`Waiting for Millumin OSC feedback on port ${LISTEN_PORT}…`);
console.log(`(In Millumin: CMD+K → OSC → API feedback → target this Pi on port ${LISTEN_PORT})\n`);

process.on("SIGINT", () => {
  console.log("\nBridge stopped.");
  if (ws) ws.terminate();
  udp.close();
  process.exit(0);
});
