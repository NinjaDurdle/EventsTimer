#!/usr/bin/env node
/* BRIDGE_META
{
  "name": "Pixera",
  "version": "1.3.1",
  "description": "Polls a Pixera timeline for countdown time remaining via JSON-RPC over TCP and drives the display. Set up API Access in Pixera Settings → API, using JSON/TCP(dl) protocol.",
  "fields": [
    { "id": "pixera",       "label": "Pixera host IP",       "type": "text",     "default": "" },
    { "id": "pixera-port",  "label": "Pixera API port",      "type": "number",   "default": "1400" },
    { "id": "timeline",     "label": "Timeline name",        "type": "text",     "default": "Timeline 1" },
    { "id": "poll-ms",      "label": "Poll interval (ms)",   "type": "number",   "default": "100" },
    { "id": "timer",        "label": "Timer host",           "type": "text",     "default": "localhost" },
    { "id": "timer-port",   "label": "Timer OSC port",       "type": "number",   "default": "3001" },
    { "id": "no-auto-mode", "label": "Skip auto-switch to External mode", "type": "checkbox", "default": false }
  ]
}
BRIDGE_META */
/**
 * bridges/pixera.js — Pixera → Countdown Timer bridge
 *
 * Connects to Pixera as a TCP client (JSON/TCP dl mode).
 * Polls getCurrentCountdownHMSFOfTimeline at a configurable interval
 * and forwards the countdown time to the timer.
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
 * We use getCurrentCountdownHMSFOfTimeline which returns the remaining
 * time as "HH:MM:SS:FF". We strip the frame component.
 */

const net   = require("net");
const dgram = require("dgram");

// ── Args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function arg(name, def) { const i = args.indexOf(name); return i !== -1 ? args[i+1] : def; }

const PIXERA_HOST   = arg("--pixera",      "127.0.0.1");
const PIXERA_PORT   = parseInt(arg("--pixera-port",  "1400"), 10);
const TIMELINE_NAME = arg("--timeline",    "Timeline 1");
const POLL_MS       = parseInt(arg("--poll-ms",      "100"),  10);
const TIMER_HOST    = arg("--timer",       "localhost");
const TIMER_PORT    = parseInt(arg("--timer-port",   "3001"), 10);
const AUTO_MODE     = !args.includes("--no-auto-mode");

const DELIMITER = "0xPX";

console.log("\nPixera → Countdown Timer bridge");
console.log(`  Pixera:   ${PIXERA_HOST}:${PIXERA_PORT}`);
console.log(`  Timeline: "${TIMELINE_NAME}"`);
console.log(`  Poll:     ${POLL_MS}ms`);
console.log(`  Timer:    ${TIMER_HOST}:${TIMER_PORT}`);
console.log(`  Auto-mode: ${AUTO_MODE}\n`);

// ── UDP sender ────────────────────────────────────────────────────────────────

const sender = dgram.createSocket("udp4");
sender.bind(() => {});

function sendToTimer(cmd) {
  const buf = Buffer.from(cmd + "\n");
  sender.send(buf, TIMER_PORT, TIMER_HOST, (err) => {
    if (err) console.error("Timer send error:", err.message);
  });
}

// ── HMSF → HH:MM:SS ──────────────────────────────────────────────────────────

function hmsfToHms(hmsf) {
  const parts = String(hmsf).split(":");
  if (parts.length < 3) return null;
  return `${parts[0].padStart(2,"0")}:${parts[1].padStart(2,"0")}:${parts[2].padStart(2,"0")}`;
}

// ── JSON-RPC over TCP (dl mode) ───────────────────────────────────────────────

let msgId         = 1;
let socket        = null;
let recvBuf       = "";
let pollTimer     = null;
let modeSet       = false;
let reconnectDelay = 2000;
const pending     = new Map(); // id → { resolve, reject }

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
    // Timeout after 2 seconds
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

function connect() {
  console.log(`Connecting to Pixera at ${PIXERA_HOST}:${PIXERA_PORT}…`);

  socket = new net.Socket();
  socket.setEncoding("utf8");

  socket.connect(PIXERA_PORT, PIXERA_HOST, () => {
    console.log("  Connected to Pixera ✓");
    reconnectDelay = 2000;
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
    console.log(`\n  Pixera disconnected — reconnecting in ${reconnectDelay/1000}s…`);
    stopPolling();
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);
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
    // getCurrentCountdownHMSFOfTimeline returns "HH:MM:SS:FF" string
    const result = await sendRpc(
      "Pixera.Compound.getCurrentCountdownHMSFOfTimeline",
      { name: TIMELINE_NAME }
    );

    if (AUTO_MODE && !modeSet) {
      sendToTimer("/timer/mode external");
      modeSet = true;
      console.log("\n  Timer set to external mode");
    }

    const hms = hmsfToHms(result);
    if (hms) {
      sendToTimer(`/timer/set ${hms}`);
      process.stdout.write(`\r  Pixera countdown: ${result} → ${hms}  `);
    }
  } catch (e) {
    // Ignore timeout / not-connected errors during normal polling
    if (e.message !== "Not connected") {
      process.stdout.write(`\r  Poll error: ${e.message}  `);
    }
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────

connect();

process.on("SIGINT", () => {
  console.log("\nBridge stopped.");
  stopPolling();
  sender.close();
  if (socket) socket.destroy();
  process.exit(0);
});
