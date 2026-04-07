#!/usr/bin/env node
/* BRIDGE_META
{
  "name": "Mitti",
  "version": "1.3.1",
  "description": "Receives cue time-remaining from Mitti (Mac) via OSC feedback and drives the display. Enable OSC feedback in Mitti and set the feedback target to this Pi's IP address on port 51001.",
  "fields": [
    { "id": "port",         "label": "OSC feedback receive port", "type": "number",   "default": "51001" },
    { "id": "timer",        "label": "Timer host",                "type": "text",     "default": "localhost" },
    { "id": "timer-port",   "label": "Timer OSC port",            "type": "number",   "default": "3001" },
    { "id": "no-auto-mode", "label": "Skip auto-switch to External mode", "type": "checkbox", "default": false }
  ]
}
BRIDGE_META */
/**
 * bridges/mitti.js — Mitti → Countdown Timer bridge
 *
 * Listens for Mitti's OSC feedback and forwards /mitti/cueTimeLeft
 * to the timer as /timer/set.
 *
 * Mitti setup:
 *   Project Preferences → OSC → Enable OSC Feedback
 *   Set feedback target IP to this Pi's IP address, port 51001
 *
 * Mitti pushes /mitti/cueTimeLeft in hh:mm:ss:ff format continuously.
 * We strip the frame component and round to tenths of a second.
 */

const dgram  = require("dgram");
const osc    = require("osc");

// ── Args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function arg(name, def) { const i = args.indexOf(name); return i !== -1 ? args[i+1] : def; }

const LISTEN_PORT = parseInt(arg("--port",       "51001"), 10);
const TIMER_HOST  = arg("--timer",      "localhost");
const TIMER_PORT  = parseInt(arg("--timer-port", "3001"),  10);
const AUTO_MODE   = !args.includes("--no-auto-mode");

console.log("\nMitti → Countdown Timer bridge");
console.log(`  Listening for Mitti OSC on UDP port ${LISTEN_PORT}`);
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

// ── HMSF parser ───────────────────────────────────────────────────────────────
// Input: "00:04:32:12" (hh:mm:ss:ff)
// Output: "HH:MM:SS" with tenths rounded from frames
// Assumes 25fps if frame count is 0-24, 30fps if 25-29

function hmsfToHms(hmsf) {
  const parts = String(hmsf).split(":");
  if (parts.length < 3) return null;
  const hh = parts[0].padStart(2, "0");
  const mm = parts[1].padStart(2, "0");
  const ss = parts[2].padStart(2, "0");
  // Strip frames — tenths display handles sub-second display on timer side
  return `${hh}:${mm}:${ss}`;
}

// ── OSC receiver ──────────────────────────────────────────────────────────────

let modeSet = false;

const udp = new osc.UDPPort({
  localAddress: "0.0.0.0",
  localPort:    LISTEN_PORT,
  metadata:     true,
});

udp.on("message", (msg) => {
  const addr = msg.address;

  if (addr === "/mitti/cueTimeLeft") {
    // Set external mode on first data received
    if (AUTO_MODE && !modeSet) {
      sendToTimer("/timer/mode external");
      modeSet = true;
      console.log("  Timer set to external mode");
    }

    // Value is a string argument: "hh:mm:ss:ff"
    const raw = msg.args && msg.args[0] ? msg.args[0].value : null;
    if (!raw) return;

    const hms = hmsfToHms(raw);
    if (hms) {
      sendToTimer(`/timer/set ${hms}`);
      process.stdout.write(`\r  Mitti cueTimeLeft: ${raw} → ${hms}  `);
    }
  }
});

udp.on("error", (err) => console.error("OSC error:", err.message));

udp.open();
console.log(`Waiting for Mitti OSC feedback on port ${LISTEN_PORT}…`);
console.log("(In Mitti: Project Preferences → OSC → Enable Feedback, target this Pi)\n");

process.on("SIGINT", () => {
  console.log("\nBridge stopped.");
  sender.close();
  udp.close();
  process.exit(0);
});
