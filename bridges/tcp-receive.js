#!/usr/bin/env node
/* BRIDGE_META
{
  "name": "TCP Control",
  "version": "1.4.0",
  "type": "control",
  "description": "Listens for plaintext timer commands over TCP. Allows any TCP client to control the timer using newline-terminated text commands (e.g. /timer/start, /timer/set 00:05:00). One connection per client, multiple clients supported.",
  "fields": [
    { "id": "port", "label": "TCP listen port", "type": "number", "default": "3001" }
  ]
}
BRIDGE_META */
/**
 * bridges/tcp-receive.js — TCP plaintext command receiver
 *
 * Listens on a TCP port for newline-delimited plaintext commands and
 * forwards them to the EventsTimer server via WebSocket.
 *
 * Command format: one command per line, e.g.
 *   /timer/start
 *   /timer/set 00:05:00
 *   /timer/mode countdown
 *   /timer/add 1
 *   /timer/subtract 0.5
 *   /timer/message Stand by
 *   /timer/preset/load <id>
 *
 * Options:
 *   --port <number>     TCP port to listen on (default: 3001)
 *   --http-port <n>     EventsTimer HTTP/WS port (default: 80, injected by bridge manager)
 */

const net = require("net");
const { WebSocket } = require("ws");

// ── Args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function arg(name, def) { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : def; }

const LISTEN_PORT = parseInt(arg("--port",      "3001"), 10);
const HTTP_PORT   = parseInt(arg("--http-port", "80"),   10);

console.log("\nTCP Control bridge");
console.log(`  Listening on TCP port ${LISTEN_PORT}`);
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
  console.log(`TCP ← "${line}"`);
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

// ── TCP server ────────────────────────────────────────────────────────────────

const tcpServer = net.createServer((socket) => {
  console.log(`  Client connected: ${socket.remoteAddress}`);
  let buffer = "";
  socket.setEncoding("utf8");

  socket.on("data", (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line) handleLine(line);
    }
  });

  socket.on("close", () => console.log(`  Client disconnected: ${socket.remoteAddress}`));
  socket.on("error", (e) => console.error(`  Socket error: ${e.message}`));
});

tcpServer.listen(LISTEN_PORT, "0.0.0.0", () => {
  console.log(`TCP server listening on port ${LISTEN_PORT}`);
});

tcpServer.on("error", (e) => console.error(`TCP server error: ${e.message}`));

// ── Shutdown ──────────────────────────────────────────────────────────────────

process.on("SIGINT", () => {
  console.log("\nTCP Control bridge stopped.");
  tcpServer.close();
  if (ws) ws.terminate();
  process.exit(0);
});
