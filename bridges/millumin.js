#!/usr/bin/env node
/* BRIDGE_META
{
  "name": "Millumin V4/V5",
  "version": "1.3.1",
  "description": "Receives media time from a named Millumin layer via OSC feedback and drives the display. Enable API feedback in Millumin (CMD+K → OSC tab → API feedback). Name the layer you want to monitor 'time' in your Millumin project (or configure a different name below).",
  "fields": [
    { "id": "port",         "label": "OSC feedback receive port", "type": "number",   "default": "5001" },
    { "id": "layer",        "label": "Millumin layer name",       "type": "text",     "default": "time" },
    { "id": "timer",        "label": "Timer host",                "type": "text",     "default": "localhost" },
    { "id": "timer-port",   "label": "Timer OSC port",            "type": "number",   "default": "3001" },
    { "id": "no-auto-mode", "label": "Skip auto-switch to External mode", "type": "checkbox", "default": false }
  ]
}
BRIDGE_META */
/**
 * bridges/millumin.js — Millumin V4/V5 → Countdown Timer bridge
 *
 * Millumin setup:
 *   1. Open Device Manager (CMD+K) → OSC tab
 *   2. Enable "API feedback"
 *   3. Set feedback target to this Pi's IP, port 5001 (or your chosen port)
 *   4. Name the layer you want to monitor "time" (or set --layer to your name)
 *
 * Millumin sends /millumin/layer:time/media/time [float:elapsed, float:duration]
 * continuously while media is playing. We compute remaining = duration - elapsed
 * and forward to the timer.
 *
 * Works identically for V4 and V5 — same OSC address scheme.
 */

const dgram = require("dgram");
const osc   = require("osc");

// ── Args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function arg(name, def) { const i = args.indexOf(name); return i !== -1 ? args[i+1] : def; }

const LISTEN_PORT  = parseInt(arg("--port",       "5001"),      10);
const LAYER_NAME   = arg("--layer",     "time");
const TIMER_HOST   = arg("--timer",     "localhost");
const TIMER_PORT   = parseInt(arg("--timer-port", "3001"),      10);
const AUTO_MODE    = !args.includes("--no-auto-mode");

// Build the OSC address we listen for — matches /millumin/layer:<name>/media/time
const TARGET_ADDR = `/millumin/layer:${LAYER_NAME}/media/time`;

console.log("\nMillumin V4/V5 → Countdown Timer bridge");
console.log(`  Listening on UDP port ${LISTEN_PORT}`);
console.log(`  Watching layer: "${LAYER_NAME}" (${TARGET_ADDR})`);
console.log(`  Timer: ${TIMER_HOST}:${TIMER_PORT}`);
console.log(`  Auto-mode: ${AUTO_MODE}\n`);

// ── UDP sender ────────────────────────────────────────────────────────────────

const sender = dgram.createSocket("udp4");
sender.bind(() => {});

function sendToTimer(cmd) {
  const buf = Buffer.from(cmd + "\n");
  sender.send(buf, TIMER_PORT, TIMER_HOST, (err) => {
    if (err) console.error("Send error:", err.message);
  });
}

// ── Seconds → HH:MM:SS ───────────────────────────────────────────────────────

function secondsToHms(totalSeconds) {
  const s = Math.max(0, totalSeconds);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  return [hh, mm, ss].map(n => String(n).padStart(2, "0")).join(":");
}

// ── OSC receiver ──────────────────────────────────────────────────────────────

let modeSet      = false;
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

  const remaining = Math.max(0, duration - elapsed);

  if (AUTO_MODE && !modeSet) {
    sendToTimer("/timer/mode external");
    modeSet = true;
    console.log("  Timer set to external mode");
  }

  const hms = secondsToHms(remaining);
  sendToTimer(`/timer/set ${hms}`);
  process.stdout.write(`\r  elapsed=${elapsed.toFixed(1)}s  duration=${duration.toFixed(1)}s  remaining=${hms}  `);
});

udp.on("error", (err) => console.error("OSC error:", err.message));

udp.open();
console.log(`Waiting for Millumin OSC feedback on port ${LISTEN_PORT}…`);
console.log(`(In Millumin: CMD+K → OSC → API feedback → target this Pi on port ${LISTEN_PORT})\n`);

process.on("SIGINT", () => {
  console.log("\nBridge stopped.");
  sender.close();
  udp.close();
  process.exit(0);
});
