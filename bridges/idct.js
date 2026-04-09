#!/usr/bin/env node
/* BRIDGE_META
{
  "name": "IDCT / CDEther Broadcast",
  "version": "1.4.0",
  "type": "transmit",
  "description": "Broadcasts timer state in the Interspace Industries CDEther (IDCT) protocol via UDP. Makes EventsTimer a drop-in replacement for a CDEther transmitter — any CDEther receiver or compatible display on the network will pick this up automatically.",
  "fields": [
    { "id": "port", "label": "Broadcast port", "type": "number", "default": "61003" }
  ]
}
BRIDGE_META */
/**
 * bridges/idct.js — IDCT / CDEther broadcast transmit bridge
 *
 * Connects to the EventsTimer WebSocket server, subscribes to state updates,
 * and broadcasts a 20-character CDEther-compatible UDP packet every 100ms.
 *
 * Packet format (Irisdown Countdown Timer v2.0.10 / CDEther protocol):
 *   "IDCT:" + sign + seconds(6 digits) + instanceId(hex) + color + blink + padding
 *
 * Options:
 *   --port <number>      UDP broadcast port (default: 61003)
 *   --http-port <number> EventsTimer HTTP/WS port (default: 80)
 */

const dgram  = require("dgram");
const { WebSocket } = require("ws");

// ── Args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function arg(name, def) { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : def; }

const IDCT_PORT  = parseInt(arg("--port",      "61003"), 10);
const HTTP_PORT  = parseInt(arg("--http-port", "80"),    10);

console.log("\nIDCT / CDEther broadcast bridge");
console.log(`  Broadcast port: ${IDCT_PORT}`);
console.log(`  Timer WS:       ws://localhost:${HTTP_PORT}\n`);

// ── UDP broadcast socket ──────────────────────────────────────────────────────

const sock = dgram.createSocket("udp4");
sock.bind(() => {
  sock.setBroadcast(true);
  console.log(`  UDP socket ready, broadcasting to 255.255.255.255:${IDCT_PORT}`);
});
sock.on("error", (e) => console.error("UDP socket error:", e.message));

// ── Packet builder ────────────────────────────────────────────────────────────

function buildPacket(timer) {
  const seconds = Math.floor(timer.currentMs / 1000);
  const sign    = timer.endReached ? "-" : "+";   // "-" = overtime per CDEther spec
  const secStr  = String(seconds).padStart(6, "0"); // max 344619 (99h59m59s)
  const instId  = "0";    // single instance, hex 0
  const color   = "G";    // green — colour change not implemented per spec
  const blink   = "0";    // no blink
  const padding = "     "; // 5 unused chars for future expansion
  return Buffer.from(`IDCT:${sign}${secStr}${instId}${color}${blink}${padding}`);
}

// ── Broadcast loop ────────────────────────────────────────────────────────────
// Runs at 100ms per CDEther protocol spec, independently of WebSocket updates.
// Current timer state is cached from the last WebSocket message.

let currentTimer = null;
let broadcastInterval = null;

function startBroadcast() {
  if (broadcastInterval) return;
  broadcastInterval = setInterval(() => {
    if (!currentTimer) return;
    const packet = buildPacket(currentTimer);
    sock.send(packet, IDCT_PORT, "255.255.255.255", (e) => {
      if (e) console.error("IDCT broadcast error:", e.message);
    });
  }, 100);
}

function stopBroadcast() {
  if (broadcastInterval) { clearInterval(broadcastInterval); broadcastInterval = null; }
}

// ── WebSocket connection ──────────────────────────────────────────────────────

let ws;
let reconnectDelay = 2000;

function connect() {
  console.log(`Connecting to EventsTimer at ws://localhost:${HTTP_PORT}…`);
  ws = new WebSocket(`ws://localhost:${HTTP_PORT}`);

  ws.on("open", () => {
    console.log("  Connected ✓");
    reconnectDelay = 2000;
    startBroadcast();
  });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === "state" && msg.payload && msg.payload.timer) {
      currentTimer = msg.payload.timer;
    }
  });

  ws.on("close", () => {
    console.log(`  WebSocket closed — reconnecting in ${reconnectDelay / 1000}s…`);
    stopBroadcast();
    currentTimer = null;
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 30_000);
  });

  ws.on("error", (e) => {
    console.error(`  WebSocket error: ${e.message}`);
    ws.terminate();
  });
}

connect();

// ── Shutdown ──────────────────────────────────────────────────────────────────

process.on("SIGINT", () => {
  console.log("\nIDCT bridge stopped.");
  stopBroadcast();
  if (ws) ws.terminate();
  sock.close();
  process.exit(0);
});
