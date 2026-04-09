#!/usr/bin/env node
/* BRIDGE_META
{
  "name": "Irisdown Server",
  "version": "1.4.0",
  "type": "control",
  "description": "Exposes the Irisdown Countdown Timer v2.0.10 control protocol over TCP. Allows Companion, TouchOSC, and any Irisdown-compatible controller to control EventsTimer. Supports UPDATES ON push subscriptions.",
  "fields": [
    { "id": "port", "label": "TCP listen port", "type": "number", "default": "61002" }
  ]
}
BRIDGE_META */
/**
 * bridges/irisdown-server.js — Irisdown protocol TCP server bridge
 *
 * Listens for inbound TCP connections from Irisdown-compatible controllers
 * (Companion, etc.) and translates their commands to EventsTimer WebSocket
 * messages. Subscribes to timer state via WebSocket and pushes updates to
 * any clients that have sent UPDATES ON.
 *
 * Supported commands:
 *   GO, PAUSE, TOGGLEPAUSE, RESET, RESET <hh:mm:ss>, RESET <minutes>
 *   JOG <minutes>, MESSAGE "<text>", MESSAGE CLEAR
 *   DISPLAY TIMER|CLOCK, STATE, REMAINING, VERSION
 *   UPDATEMODE 2, UPDATES ON|OFF
 *
 * Options:
 *   --port <number>     TCP port to listen on (default: 61002)
 *   --http-port <n>     EventsTimer HTTP/WS port (default: 80, injected by bridge manager)
 */

const net = require("net");
const { WebSocket } = require("ws");

// ── Args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function arg(name, def) { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : def; }

const LISTEN_PORT = parseInt(arg("--port",      "61002"), 10);
const HTTP_PORT   = parseInt(arg("--http-port", "80"),    10);

console.log("\nIrisdown Server bridge");
console.log(`  Listening on TCP port ${LISTEN_PORT}`);
console.log(`  Timer WS: ws://localhost:${HTTP_PORT}\n`);

// ── Cached timer state (from WebSocket) ───────────────────────────────────────

let timerState   = null;
let displayState = null;

// ── WebSocket connection to EventsTimer ───────────────────────────────────────

let ws;
let wsReady = false;
let wsReconnectDelay = 2000;

// All connected Irisdown TCP clients that have UPDATES ON
const updateSubscribers = new Set(); // Set of { socket, write }

function sendCommand(action, payload = {}) {
  if (!wsReady) return;
  ws.send(JSON.stringify({ type: "command", payload: { action, ...payload } }));
}

function pushUpdate() {
  if (!timerState) return;
  const t      = timerState;
  const ms     = t.currentMs;
  const sign   = t.endReached ? "-" : "+";
  const hh     = String(Math.floor(ms / 3_600_000)).padStart(2, "0");
  const mm     = String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, "0");
  const ss     = String(Math.floor((ms % 60_000) / 1_000)).padStart(2, "0");
  const state  = t.running ? "PLAYING"
               : (t.currentMs === t.targetMs || t.currentMs === 0) ? "STOPPED"
               : "PAUSED";
  const display  = t.mode === "clock" ? "CLOCK" : "TIMER";
  const message  = (t.message && t.message.trim()) ? "TRUE" : "FALSE";
  const line     = `TIME=${sign}${hh}:${mm}:${ss}&STATE=${state}&DISPLAY=${display}&MESSAGE=${message}\r\n`;

  for (const sub of updateSubscribers) {
    if (sub.writable) sub.write(line);
    else updateSubscribers.delete(sub);
  }
}

function connectWs() {
  ws = new WebSocket(`ws://localhost:${HTTP_PORT}`);

  ws.on("open", () => {
    wsReady = true;
    wsReconnectDelay = 2000;
  });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === "state" && msg.payload) {
      timerState   = msg.payload.timer;
      displayState = msg.payload.display;
      pushUpdate();
    }
  });

  ws.on("close", () => {
    wsReady = false;
    timerState = null;
    setTimeout(connectWs, wsReconnectDelay);
    wsReconnectDelay = Math.min(wsReconnectDelay * 1.5, 30_000);
  });

  ws.on("error", (e) => {
    console.error(`  WS error: ${e.message}`);
    ws.terminate();
  });
}

connectWs();

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseTimeString(str) {
  const parts = (str || "").trim().split(":").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return null;
  const [h, m, s] = parts;
  if (m > 59 || s > 59) return null;
  return (h * 3600 + m * 60 + s) * 1000;
}

// ── TCP server ────────────────────────────────────────────────────────────────

const tcpServer = net.createServer((socket) => {
  console.log(`  Irisdown client connected: ${socket.remoteAddress}`);
  socket.setEncoding("utf8");

  let buffer          = "";
  let updatesEnabled  = false;

  function reply(msg) {
    // While subscribed to updates, suppress individual OK replies —
    // state changes are visible in the push stream instead.
    if (socket.writable && !updatesEnabled) {
      socket.write(msg + "\r\n");
    }
  }

  socket.on("data", (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, i).replace(/\r$/, "").trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;

      console.log(`  Irisdown ← "${line}"`);
      const parts = line.split(/\s+/);
      const cmd   = parts[0].toUpperCase();

      if (cmd === "GO") {
        sendCommand("start");
        reply("OK");

      } else if (cmd === "PAUSE") {
        sendCommand("pause");
        reply("OK");

      } else if (cmd === "TOGGLEPAUSE") {
        sendCommand(timerState && timerState.running ? "pause" : "start");
        reply("OK");

      } else if (cmd === "RESET" && parts.length === 1) {
        sendCommand("reset");
        reply("OK");

      } else if (cmd === "RESET" && parts.length === 2) {
        let ms = null;
        if (parts[1].includes(":")) {
          ms = parseTimeString(parts[1]);
        } else {
          const mins = parseFloat(parts[1]);
          if (!isNaN(mins)) ms = Math.round(mins * 60_000);
        }
        if (ms !== null) {
          sendCommand("setTime", { ms });
          sendCommand("reset");
          reply("OK");
        } else {
          reply("ERROR");
        }

      } else if (cmd === "JOG" && parts.length === 2) {
        const mins = parseFloat(parts[1]);
        if (!isNaN(mins)) {
          sendCommand("adjust", { deltaMs: Math.round(mins * 60_000) });
          reply("OK");
        } else {
          reply("ERROR");
        }

      } else if (cmd === "REMAINING") {
        const ms = timerState ? Math.floor(timerState.currentMs / 1000) : 0;
        reply(String(ms));

      } else if (cmd === "STATE") {
        let state = "STOPPED";
        if (timerState) {
          const t = timerState;
          state = t.running ? "PLAYING"
                : (t.currentMs === t.targetMs || t.currentMs === 0) ? "STOPPED"
                : "PAUSED";
        }
        reply(state);

      } else if (cmd === "VERSION") {
        reply("VERSION 2.0.10.0");

      } else if (cmd === "UPDATEMODE") {
        if (parts[1] === "2") reply("OK");
        else reply("ERROR");

      } else if (cmd === "UPDATES") {
        const onOff = (parts[1] || "").toUpperCase();
        if (onOff === "ON") {
          updatesEnabled = true;
          updateSubscribers.add(socket);
          // Send immediate state so client doesn't wait for next change
          pushUpdate();
        } else if (onOff === "OFF") {
          updatesEnabled = false;
          updateSubscribers.delete(socket);
          reply("OK");
        } else {
          reply("ERROR");
        }

      } else if (cmd === "MESSAGE") {
        const rest = line.slice(8).trim();
        if (rest.toUpperCase() === "CLEAR" || rest === "") {
          sendCommand("setMessage", { text: "" });
        } else {
          const text = rest.replace(/^"|"$/g, "");
          sendCommand("setMessage", { text });
        }
        reply("OK");

      } else if (cmd === "DISPLAY") {
        const mode = (parts[1] || "").toUpperCase();
        if (mode === "CLOCK") {
          sendCommand("setMode", { mode: "clock" });
        } else if (mode === "TIMER") {
          if (timerState && timerState.mode === "clock")
            sendCommand("setMode", { mode: "countdown" });
        }
        reply("OK");

      } else {
        reply("ERROR");
      }
    }
  });

  socket.on("close", () => {
    updateSubscribers.delete(socket);
    console.log(`  Irisdown client disconnected: ${socket.remoteAddress}`);
  });

  socket.on("error", (e) => {
    console.error(`  Irisdown TCP error: ${e.message}`);
    updateSubscribers.delete(socket);
  });
});

tcpServer.listen(LISTEN_PORT, "0.0.0.0", () => {
  console.log(`Irisdown server listening on TCP port ${LISTEN_PORT}`);
});

tcpServer.on("error", (e) => console.error(`Irisdown TCP server error: ${e.message}`));

// ── Shutdown ──────────────────────────────────────────────────────────────────

process.on("SIGINT", () => {
  console.log("\nIrisdown Server bridge stopped.");
  tcpServer.close();
  if (ws) ws.terminate();
  process.exit(0);
});
