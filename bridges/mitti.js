#!/usr/bin/env node
/* BRIDGE_META
{
  "name": "Mitti",
  "version": "1.4.0",
  "type": "receive",
  "description": "Receives cue time-remaining from Mitti (Mac) via OSC feedback and drives the display. Enable OSC feedback in Mitti and set the feedback target to this Pi's IP address on port 51001.",
  "fields": [
    { "id": "port",         "label": "OSC feedback receive port", "type": "number", "default": "51001" },
    { "id": "no-auto-mode", "label": "Skip auto-switch to External mode", "type": "checkbox", "default": false }
  ]
}
BRIDGE_META */
/**
 * bridges/mitti.js — Mitti → EventsTimer bridge
 *
 * Listens for Mitti's OSC feedback and forwards /mitti/cueTimeLeft
 * to the timer via WebSocket.
 *
 * Mitti setup:
 *   Project Preferences → OSC → Enable OSC Feedback
 *   Set feedback target IP to this Pi's IP address, port 51001
 *
 * Mitti pushes /mitti/cueTimeLeft in hh:mm:ss:ff format continuously.
 * We strip the frame component and convert to milliseconds.
 *
 * Options:
 *   --port <number>     UDP port to receive Mitti OSC feedback on (default: 51001)
 *   --http-port <n>     EventsTimer HTTP/WS port (default: 80, injected by bridge manager)
 *   --no-auto-mode      Don't automatically switch timer to external mode
 */

const osc = require("osc");
const { WebSocket } = require("ws");

// ── Args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function arg(name, def) { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : def; }

const LISTEN_PORT = parseInt(arg("--port",      "51001"), 10);
const HTTP_PORT   = parseInt(arg("--http-port", "80"),    10);
const AUTO_MODE   = !args.includes("--no-auto-mode");

console.log("\nMitti → EventsTimer bridge");
console.log(`  Listening for Mitti OSC on UDP port ${LISTEN_PORT}`);
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

// ── HMSF parser ───────────────────────────────────────────────────────────────
// Input: "00:04:32:12" (hh:mm:ss:ff)
// Strips frames and converts to milliseconds.

function hmsfToMs(hmsf) {
  const parts = String(hmsf).split(":");
  if (parts.length < 3) return null;
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);
  const s = parseInt(parts[2], 10);
  if ([h, m, s].some(isNaN)) return null;
  return (h * 3600 + m * 60 + s) * 1000;
}

// ── OSC receiver ──────────────────────────────────────────────────────────────

const udp = new osc.UDPPort({
  localAddress: "0.0.0.0",
  localPort:    LISTEN_PORT,
  metadata:     true,
});

udp.on("message", (msg) => {
  if (msg.address !== "/mitti/cueTimeLeft") return;

  if (AUTO_MODE && !modeSet) {
    sendCommand("setMode", { mode: "external" });
    modeSet = true;
    console.log("  Timer set to external mode");
  }

  const raw = msg.args && msg.args[0] ? msg.args[0].value : null;
  if (!raw) return;

  const ms = hmsfToMs(raw);
  if (ms !== null) {
    sendCommand("setTime", { ms });
    process.stdout.write(`\r  Mitti cueTimeLeft: ${raw} → ${ms}ms  `);
  }
});

udp.on("error", (err) => console.error("OSC error:", err.message));

udp.open();
console.log(`Waiting for Mitti OSC feedback on port ${LISTEN_PORT}…`);
console.log("(In Mitti: Project Preferences → OSC → Enable Feedback, target this Pi)\n");

process.on("SIGINT", () => {
  console.log("\nBridge stopped.");
  if (ws) ws.terminate();
  udp.close();
  process.exit(0);
});
