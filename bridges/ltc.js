#!/usr/bin/env node
/* BRIDGE_META
{
  "name": "LTC Timecode",
  "version": "1.3.1",
  "description": "Reads LTC (Linear Timecode) from a USB audio interface and displays it on the timer. Requires libltc-tools (ltcdump) to be installed: sudo apt install libltc-dev ltcdump. Connect LTC source to the line input of a USB audio interface.",
  "fields": [
    { "id": "device",       "label": "ALSA audio device",   "type": "text",     "default": "hw:1,0" },
    { "id": "fps",          "label": "Frames per second",   "type": "number",   "default": "25" },
    { "id": "timer",        "label": "Timer host",          "type": "text",     "default": "localhost" },
    { "id": "timer-port",   "label": "Timer OSC port",      "type": "number",   "default": "3001" },
    { "id": "no-auto-mode", "label": "Skip auto-switch to External mode", "type": "checkbox", "default": false }
  ]
}
BRIDGE_META */
/**
 * bridges/ltc.js — LTC Timecode → Countdown Timer bridge
 *
 * Spawns ltcdump (from libltc-tools) to decode LTC from a USB audio input,
 * parses the timecode output, rounds to tenths of a second, and forwards
 * to the timer as /timer/set HH:MM:SS.
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
 * We round frames to tenths: tenths = round(frames / fps * 10)
 * and display as HH:MM:SS (the timer's tenths display handles sub-second).
 */

const { spawn } = require("child_process");
const dgram     = require("dgram");

// ── Args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function arg(name, def) { const i = args.indexOf(name); return i !== -1 ? args[i+1] : def; }

const ALSA_DEVICE  = arg("--device",     "hw:1,0");
const FPS          = parseFloat(arg("--fps",        "25"));
const TIMER_HOST   = arg("--timer",      "localhost");
const TIMER_PORT   = parseInt(arg("--timer-port",   "3001"), 10);
const AUTO_MODE    = !args.includes("--no-auto-mode");

console.log("\nLTC Timecode → Countdown Timer bridge");
console.log(`  ALSA device: ${ALSA_DEVICE}`);
console.log(`  FPS:         ${FPS}`);
console.log(`  Timer:       ${TIMER_HOST}:${TIMER_PORT}`);
console.log(`  Auto-mode:   ${AUTO_MODE}\n`);

// ── UDP sender ────────────────────────────────────────────────────────────────

const sender = dgram.createSocket("udp4");
sender.bind(() => {});

function sendToTimer(cmd) {
  const buf = Buffer.from(cmd + "\n");
  sender.send(buf, TIMER_PORT, TIMER_HOST, (err) => {
    if (err) console.error("Send error:", err.message);
  });
}

// ── Timecode parser ───────────────────────────────────────────────────────────
// ltcdump outputs: "HH:MM:SS:FF\n"
// We keep HH:MM:SS and discard frames — the timer's tenths display is sufficient.
// The tenths value could be computed as round(FF / FPS * 10) if needed later.

function parseLtcLine(line) {
  const m = line.trim().match(/^(\d{2}):(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, hh, mm, ss] = m;
  return `${hh}:${mm}:${ss}`;
}

// ── ltcdump process ───────────────────────────────────────────────────────────

let modeSet       = false;
let ltcProc       = null;
let reconnectDelay = 2000;
let stopping      = false;

function startLtcdump() {
  if (stopping) return;

  // Check ltcdump is installed
  const which = require("child_process").spawnSync("which", ["ltcdump"]);
  if (which.status !== 0) {
    console.error("ERROR: ltcdump not found.");
    console.error("Install with: sudo apt install ltcdump");
    console.error("Or: sudo apt install libltc-dev && sudo apt install ltcdump");
    process.exit(1);
  }

  console.log(`Starting ltcdump on ${ALSA_DEVICE}…`);

  // ltcdump -i <device> -f <fps> reads LTC and outputs one TC line per frame
  ltcProc = spawn("ltcdump", ["-i", ALSA_DEVICE, "-f", String(FPS)], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let buf = "";

  ltcProc.stdout.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf        = buf.slice(nl + 1);
      const hms  = parseLtcLine(line);
      if (!hms) continue;

      if (AUTO_MODE && !modeSet) {
        sendToTimer("/timer/mode external");
        modeSet = true;
        console.log("  Timer set to external mode");
      }

      sendToTimer(`/timer/set ${hms}`);
      process.stdout.write(`\r  LTC: ${line.trim()} → ${hms}  `);
    }
  });

  ltcProc.stderr.on("data", (d) => {
    const msg = d.toString().trim();
    if (msg) console.error(`  ltcdump: ${msg}`);
  });

  ltcProc.on("exit", (code) => {
    ltcProc = null;
    if (stopping) return;
    console.log(`\n  ltcdump exited (code=${code}) — retrying in ${reconnectDelay/1000}s…`);
    setTimeout(startLtcdump, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);
  });
}

// ── Startup ───────────────────────────────────────────────────────────────────

startLtcdump();

process.on("SIGINT", () => {
  stopping = true;
  console.log("\nBridge stopped.");
  if (ltcProc) ltcProc.kill("SIGTERM");
  sender.close();
  process.exit(0);
});
