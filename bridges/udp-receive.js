#!/usr/bin/env node
/* BRIDGE_META
{
  "name": "UDP Control",
  "version": "1.4.0",
  "type": "control",
  "description": "Listens for plaintext timer commands over UDP. Allows any UDP sender to control the timer using newline-terminated text commands (e.g. /timer/start, /timer/set 00:05:00). Compatible with TouchOSC, Companion, and other UDP senders.",
  "fields": [
    { "id": "port", "label": "UDP listen port", "type": "number", "default": "3001" }
  ]
}
BRIDGE_META */
/**
 * bridges/udp-receive.js — UDP plaintext command receiver
 *
 * Listens on a UDP port for plaintext commands and forwards them to the
 * EventsTimer server via WebSocket. Each datagram should contain one
 * newline-terminated command.
 *
 * Command format: same as TCP Control bridge, e.g.
 *   /timer/start\n
 *   /timer/set 00:05:00\n
 *
 * Options:
 *   --port <number>     UDP port to listen on (default: 3001)
 *   --http-port <n>     EventsTimer HTTP/WS port (default: 80, injected by bridge manager)
 */

const dgram = require("dgram");
const { WebSocket } = require("ws");

// ── Args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function arg(name, def) { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : def; }

const LISTEN_PORT = parseInt(arg("--port",      "3001"), 10);
const HTTP_PORT   = parseInt(arg("--http-port", "80"),   10);

console.log("\nUDP Control bridge");
console.log(`  Listening on UDP port ${LISTEN_PORT}`);
console.log(`  Timer WS: ws://localhost:${HTTP_PORT}\n`);

// ── WebSocket connection to EventsTimer ───────────────────────────────────────

let ws;
let wsReady = false;
let wsReconnectDelay = 2000;

function sendCommand(action, payload = {}) {
  if (!wsReady) return;
  ws.send(JSON.stringify({ type: "command", payload: { action, ...payload } }));
}

function sendPreset(action, preset = {}) {
  if (!wsReady) return;
  ws.send(JSON.stringify({ type: "preset", payload: { action, preset } }));
}

function connectWs() {
  ws = new WebSocket(`ws://localhost:${HTTP_PORT}`);

  ws.on("open", () => {
    wsReady = true;
    wsReconnectDelay = 2000;
  });

  ws.on("close", () => {
    wsReady = false;
    setTimeout(connectWs, wsReconnectDelay);
    wsReconnectDelay = Math.min(wsReconnectDelay * 1.5, 30_000);
  });

  ws.on("error", (e) => {
    console.error(`  WS error: ${e.message}`);
    ws.terminate();
  });
}

connectWs();

// ── Command parser ────────────────────────────────────────────────────────────

function parseTimeString(str) {
  const parts = (str || "").trim().split(":").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return null;
  const [h, m, s] = parts;
  if (m > 59 || s > 59) return null;
  return (h * 3600 + m * 60 + s) * 1000;
}

function handleLine(line) {
  console.log(`UDP ← "${line}"`);
  const parts = line.trim().split(/\s+/);
  const cmd   = parts[0].toLowerCase();

  switch (cmd) {
    case "/timer/start":   sendCommand("start");  break;
    case "/timer/pause":   sendCommand("pause");  break;
    case "/timer/stop":    sendCommand("stop");   break;
    case "/timer/reset":   sendCommand("reset");  break;

    case "/timer/set": {
      const ms = parseTimeString(parts[1]);
      if (ms !== null) sendCommand("setTime", { ms });
      else console.warn(`  /timer/set: invalid time "${parts[1]}"`);
      break;
    }
    case "/timer/mode": {
      const mode = (parts[1] || "").toLowerCase();
      if (["countdown", "countup", "clock", "external"].includes(mode))
        sendCommand("setMode", { mode });
      else console.warn(`  /timer/mode: unknown mode "${parts[1]}"`);
      break;
    }
    case "/timer/add": {
      const mins = parts[1] !== undefined ? parseFloat(parts[1]) : 1;
      if (isNaN(mins)) { console.warn(`  /timer/add: invalid value "${parts[1]}"`); break; }
      sendCommand("adjust", { deltaMs: Math.round(mins * 60_000) });
      break;
    }
    case "/timer/subtract": {
      const mins = parts[1] !== undefined ? parseFloat(parts[1]) : 1;
      if (isNaN(mins)) { console.warn(`  /timer/subtract: invalid value "${parts[1]}"`); break; }
      sendCommand("adjust", { deltaMs: -Math.round(mins * 60_000) });
      break;
    }
    case "/timer/preset/load":
      if (parts[1]) sendPreset("load", { id: parts[1] });
      else console.warn("  /timer/preset/load: missing id");
      break;

    case "/timer/preset/save":
      if (parts[1]) sendPreset("save", { id: parts[1] });
      else console.warn("  /timer/preset/save: missing id");
      break;

    case "/timer/message":
      sendCommand("setMessage", { text: parts.slice(1).join(" ") });
      break;

    default:
      console.warn(`  Unknown command: "${cmd}"`);
  }
}

// ── UDP server ────────────────────────────────────────────────────────────────

const sock = dgram.createSocket("udp4");

sock.on("message", (msg) => {
  const line = msg.toString("utf8").trim();
  if (line) handleLine(line);
});

sock.on("error", (e) => console.error(`UDP socket error: ${e.message}`));

sock.bind(LISTEN_PORT, "0.0.0.0", () => {
  console.log(`UDP socket listening on port ${LISTEN_PORT}`);
});

// ── Shutdown ──────────────────────────────────────────────────────────────────

process.on("SIGINT", () => {
  console.log("\nUDP Control bridge stopped.");
  sock.close();
  if (ws) ws.terminate();
  process.exit(0);
});
