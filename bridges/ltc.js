#!/usr/bin/env node
/* BRIDGE_META
{
  "name": "LTC Timecode",
  "version": "1.4.0",
  "type": "receive",
  "description": "Reads LTC (Linear Timecode) from a USB audio interface and displays it on the timer. Requires libltc-tools (ltcdump) to be installed: sudo apt install libltc-dev ltcdump. Connect LTC source to the line input of a USB audio interface.",
  "fields": [
    { "id": "device",       "label": "ALSA audio device",   "type": "text",     "default": "hw:1,0" },
    { "id": "fps",          "label": "Frames per second",   "type": "number",   "default": "25" },
    { "id": "no-auto-mode", "label": "Skip auto-switch to External mode", "type": "checkbox", "default": false }
  ]
}
BRIDGE_META */
/**
 * bridges/ltc.js — LTC Timecode → EventsTimer bridge
 *
 * Spawns ltcdump (from libltc-tools) to decode LTC from a USB audio input,
 * parses the timecode output, and forwards to the timer via WebSocket.
 *
 * Hardware:
 *   - USB audio interface with line input (e.g. Behringer UCA202)
 *   - LTC source connected to line input
 *   - Find the ALSA device name with: aplay -l
 *     Typically hw:1,0 for the first USB audio device
 *
 * Install ltcdump:
 *   sudo apt install libltc-dev ltcdump
 *   (or: sudo apt install ltcdump)
 *
 * ltcdump output format (one line per frame):
 *   HH:MM:SS:FF  (e.g. "01:23:45:12")
 *
 * Options:
 *   --device <alsa>     ALSA device name (default: hw:1,0)
 *   --fps <number>      Frames per second (default: 25)
 *   --http-port <n>     EventsTimer HTTP/WS port (default: 80, injected by bridge manager)
 *   --no-auto-mode      Don't automatically switch timer to external mode
 */

const { spawn, spawnSync } = require("child_process");
const { WebSocket } = require("ws");

// ── Args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function arg(name, def) { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : def; }

const ALSA_DEVICE = arg("--device",     "hw:1,0");
const FPS         = parseFloat(arg("--fps",        "25"));
const HTTP_PORT   = parseInt(arg("--http-port",    "80"), 10);
const AUTO_MODE   = !args.includes("--no-auto-mode");

console.log("\nLTC Timecode → EventsTimer bridge");
console.log(`  ALSA device: ${ALSA_DEVICE}`);
console.log(`  FPS:         ${FPS}`);
console.log(`  Timer WS:    ws://localhost:${HTTP_PORT}`);
console.log(`  Auto-mode:   ${AUTO_MODE}\n`);

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

// ── Timecode parser ───────────────────────────────────────────────────────────
// ltcdump outputs: "HH:MM:SS:FF\n"
// We convert to milliseconds directly, discarding frames.
// Frame → tenths formula (if needed later): round(FF / FPS * 10)

function parseLtcLine(line) {
  const m = line.trim().match(/^(\d{2}):(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, hh, mm, ss] = m;
  return (parseInt(hh, 10) * 3600 + parseInt(mm, 10) * 60 + parseInt(ss, 10)) * 1000;
}

// ── ltcdump process ───────────────────────────────────────────────────────────

let ltcProc = null;
let ltcReconnectDelay = 2000;
let stopping = false;

function startLtcdump() {
  if (stopping) return;

  if (spawnSync("which", ["ltcdump"]).status !== 0) {
    console.error("ERROR: ltcdump not found.");
    console.error("Install with: sudo apt install ltcdump");
    console.error("Or: sudo apt install libltc-dev && sudo apt install ltcdump");
    process.exit(1);
  }

  console.log(`Starting ltcdump on ${ALSA_DEVICE}…`);

  ltcProc = spawn("ltcdump", ["-i", ALSA_DEVICE, "-f", String(FPS)], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let buf = "";

  ltcProc.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const ms = parseLtcLine(line);
      if (ms === null) continue;

      if (AUTO_MODE && !modeSet) {
        sendCommand("setMode", { mode: "external" });
        modeSet = true;
        console.log("  Timer set to external mode");
      }

      sendCommand("setTime", { ms });
      process.stdout.write(`\r  LTC: ${line.trim()} → ${ms}ms  `);
    }
  });

  ltcProc.stderr.on("data", (d) => {
    const msg = d.toString().trim();
    if (msg) console.error(`  ltcdump: ${msg}`);
  });

  ltcProc.on("exit", (code) => {
    ltcProc = null;
    if (stopping) return;
    console.log(`\n  ltcdump exited (code=${code}) — retrying in ${ltcReconnectDelay / 1000}s…`);
    setTimeout(startLtcdump, ltcReconnectDelay);
    ltcReconnectDelay = Math.min(ltcReconnectDelay * 1.5, 30_000);
  });
}

// ── Startup ───────────────────────────────────────────────────────────────────

startLtcdump();

process.on("SIGINT", () => {
  stopping = true;
  console.log("\nBridge stopped.");
  if (ltcProc) ltcProc.kill("SIGTERM");
  if (ws) ws.terminate();
  process.exit(0);
});
