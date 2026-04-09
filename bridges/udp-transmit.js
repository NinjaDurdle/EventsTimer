#!/usr/bin/env node
/* BRIDGE_META
{
  "name": "UDP Feedback",
  "version": "1.4.0",
  "type": "transmit",
  "description": "Broadcasts timer state as plaintext UDP packets. Supports subnet broadcast and/or unicast to specific receivers (e.g. Companion). Packet format: /timer/state running=<bool> mode=<mode> time=<HH:MM:SS> ms=<int> end=<bool>",
  "fields": [
    { "id": "broadcast",        "label": "Enable subnet broadcast",           "type": "checkbox", "default": false },
    { "id": "broadcast-port",   "label": "Broadcast port",                    "type": "number",   "default": "3002" },
    { "id": "unicast-targets",  "label": "Unicast targets (IP:Port, comma-separated)", "type": "text", "default": "" },
    { "id": "interval",         "label": "Send interval (ms)",                "type": "number",   "default": "500" }
  ]
}
BRIDGE_META */
/**
 * bridges/udp-transmit.js — UDP plaintext state feedback transmitter
 *
 * Subscribes to EventsTimer state via WebSocket and sends plaintext UDP
 * feedback packets at a configurable interval.
 *
 * Packet format:
 *   /timer/state running=<true|false> mode=<mode> time=<HH:MM:SS[.T]> ms=<int> end=<true|false>\n
 *
 * Broadcast and unicast are independent — either, both, or neither can be active.
 * Unicast targets are specified as a comma-separated list of IP:Port pairs:
 *   192.168.1.50:3002, 192.168.1.51:9000
 *
 * Options:
 *   --broadcast               Enable subnet broadcast
 *   --broadcast-port <n>      Broadcast port (default: 3002)
 *   --unicast-targets <list>  Comma-separated IP:Port pairs
 *   --interval <ms>           Send interval in milliseconds (default: 500)
 *   --http-port <n>           EventsTimer HTTP/WS port (default: 80, injected by bridge manager)
 */

const dgram = require("dgram");
const os    = require("os");
const { WebSocket } = require("ws");

// ── Args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function arg(name, def) { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : def; }

const BROADCAST        = args.includes("--broadcast");
const BROADCAST_PORT   = parseInt(arg("--broadcast-port",  "3002"), 10);
const UNICAST_RAW      = arg("--unicast-targets", "");
const INTERVAL_MS      = parseInt(arg("--interval",        "500"),  10);
const HTTP_PORT        = parseInt(arg("--http-port",       "80"),   10);

// Parse unicast targets: "192.168.1.50:3002, 192.168.1.51:9000"
const unicastTargets = UNICAST_RAW
  .split(",")
  .map(s => s.trim())
  .filter(Boolean)
  .map(s => {
    const lastColon = s.lastIndexOf(":");
    if (lastColon === -1) return null;
    const address = s.slice(0, lastColon).trim();
    const port    = parseInt(s.slice(lastColon + 1).trim(), 10);
    if (!address || isNaN(port) || port < 1 || port > 65535) return null;
    return { address, port };
  })
  .filter(Boolean);

console.log("\nUDP Feedback bridge");
console.log(`  Broadcast:       ${BROADCAST ? `yes → port ${BROADCAST_PORT}` : "no"}`);
console.log(`  Unicast targets: ${unicastTargets.length > 0 ? unicastTargets.map(t => `${t.address}:${t.port}`).join(", ") : "none"}`);
console.log(`  Interval:        ${INTERVAL_MS}ms`);
console.log(`  Timer WS:        ws://localhost:${HTTP_PORT}\n`);

// ── Subnet broadcast addresses ────────────────────────────────────────────────

function getSubnetBroadcasts() {
  const broadcasts = [];
  const ifaces = os.networkInterfaces();
  for (const iface of Object.values(ifaces)) {
    for (const addr of iface) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      const prefixLen = addr.cidr ? parseInt(addr.cidr.split("/")[1], 10) : 24;
      const ipParts   = addr.address.split(".").map(Number);
      const maskInt   = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
      const ipInt     = (ipParts[0] << 24 | ipParts[1] << 16 | ipParts[2] << 8 | ipParts[3]) >>> 0;
      const bcInt     = (ipInt | (~maskInt >>> 0)) >>> 0;
      const bc        = [bcInt >>> 24, (bcInt >> 16) & 0xff, (bcInt >> 8) & 0xff, bcInt & 0xff].join(".");
      broadcasts.push(bc);
    }
  }
  return broadcasts;
}

// ── UDP socket ────────────────────────────────────────────────────────────────

const sock = dgram.createSocket("udp4");
sock.bind(() => {
  sock.setBroadcast(true);
});
sock.on("error", (e) => console.error(`UDP socket error: ${e.message}`));

// ── State + packet builder ────────────────────────────────────────────────────

let currentState = null;

function formatMs(ms, showSubseconds) {
  const totalSec = Math.floor(ms / 1000);
  const hours    = Math.floor(totalSec / 3600);
  const minutes  = Math.floor((totalSec % 3600) / 60);
  const seconds  = totalSec % 60;
  const tenths   = Math.floor((ms % 1000) / 100);
  const hh = String(hours).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return showSubseconds ? `${hh}:${mm}:${ss}.${tenths}` : `${hh}:${mm}:${ss}`;
}

function buildPacket(timer, display) {
  return Buffer.from(
    `/timer/state running=${timer.running} mode=${timer.mode} ` +
    `time=${formatMs(timer.currentMs, display.showSubseconds)} ` +
    `ms=${Math.floor(timer.currentMs)} end=${timer.endReached}\n`
  );
}

// ── Send loop ─────────────────────────────────────────────────────────────────

let sendInterval = null;

function startSending() {
  if (sendInterval) return;
  sendInterval = setInterval(() => {
    if (!currentState) return;
    if (!BROADCAST && unicastTargets.length === 0) return;

    const pkt = buildPacket(currentState.timer, currentState.display);

    if (BROADCAST) {
      for (const bc of getSubnetBroadcasts()) {
        sock.send(pkt, BROADCAST_PORT, bc, (e) => {
          if (e) console.error(`Broadcast error to ${bc}:`, e.message);
        });
      }
    }

    for (const { address, port } of unicastTargets) {
      sock.send(pkt, port, address, (e) => {
        if (e) console.error(`Unicast error to ${address}:${port}:`, e.message);
      });
    }
  }, INTERVAL_MS);
}

function stopSending() {
  if (sendInterval) { clearInterval(sendInterval); sendInterval = null; }
}

// ── WebSocket connection to EventsTimer ───────────────────────────────────────

let ws;
let wsReconnectDelay = 2000;

function connectWs() {
  ws = new WebSocket(`ws://localhost:${HTTP_PORT}`);

  ws.on("open", () => {
    wsReconnectDelay = 2000;
    startSending();
  });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === "state" && msg.payload) {
      currentState = msg.payload;
    }
  });

  ws.on("close", () => {
    stopSending();
    currentState = null;
    setTimeout(connectWs, wsReconnectDelay);
    wsReconnectDelay = Math.min(wsReconnectDelay * 1.5, 30_000);
  });

  ws.on("error", (e) => {
    console.error(`  WS error: ${e.message}`);
    ws.terminate();
  });
}

connectWs();

// ── Shutdown ──────────────────────────────────────────────────────────────────

process.on("SIGINT", () => {
  console.log("\nUDP Feedback bridge stopped.");
  stopSending();
  if (ws) ws.terminate();
  sock.close();
  process.exit(0);
});
