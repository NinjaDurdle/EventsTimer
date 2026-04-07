/**
 * server.js — Countdown Timer Server (v1.3.1)
 *
 * New in v1.2:
 *  - displayConfig gains: visibleDigits, colorTriggers, positionX, positionY
 *  - messageConfig — independent font/size/color for the message area
 *  - timerState gains: message (string, empty = hidden)
 *  - Stop command zeroes timer and clears endReached/flash
 *  - setMode "clock" auto-starts the timer
 *  - GET /api/fonts — returns installed font families via fc-list
 *  - handleConfig accepts "message" and "messageConfig" keys
 */

const http     = require("http");
const fs       = require("fs");
const os       = require("os");
const path     = require("path");
const net      = require("net");
const dgram    = require("dgram");
const { exec, execSync } = require("child_process");
const { WebSocketServer, WebSocket } = require("ws");

const TIMER_VERSION = "1.3.1";

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG_FILE  = path.join(__dirname, "config.json");
const PRESETS_FILE = path.join(__dirname, "presets.json");
const PUBLIC_DIR   = path.join(__dirname, "public");
const TICK_MS      = 100;

const CONFIG_DEFAULTS = {
  httpPort:        80,
  oscTcpPort:      3001,
  oscUdpPort:      3001,
  oscFeedbackPort: 3002,
  feedbackTarget:  "auto",
  irisdownPort:    61002,
  idctPort:        61003,
  hostname:        "timer",
  iface:           "eth0",
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE))
      return { ...CONFIG_DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) };
  } catch (e) { console.warn("Could not load config.json, using defaults:", e.message); }
  return { ...CONFIG_DEFAULTS };
}

function saveConfig(cfg) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); }
  catch (e) { console.error("Could not save config.json:", e.message); }
}

let config = loadConfig();

// ─── Timer State ──────────────────────────────────────────────────────────────

let timerState = {
  mode:         "countdown",
  running:      false,
  currentMs:    5 * 60 * 1000,
  targetMs:     5 * 60 * 1000,
  endBehavior:  "flash",
  nextPresetId: null,
  endReached:       false,
  message:          "",   // active message text, empty = hidden
  lastExternalMs:   null, // Date.now() of last setTime in external mode, null if not external
};

// ─── Display Config ───────────────────────────────────────────────────────────
// visibleDigits: array of 6 booleans [tensHours, onesHours, tensMins, onesMins, tensSecs, onesSecs]
// colorTriggers: [{atMs, textColor, bgColor}] sorted descending by atMs — countdown only
// positionX/Y: percentage 0-100 for display position on screen

let displayConfig = {
  font:           "monospace",
  fontSize:       "20",
  textColor:      "#ffffff",
  bgColor:        "#000000",
  showSubseconds: false,
  label:          "",
  flashColor:     "#ff0000",
  visibleDigits:  [false, false, true, true, true, true], // default: MM:SS
  colorTriggers:  [],   // [{atMs: 60000, textColor: "#ff0000", bgColor: "#000000"}]
  positionX:      50,   // percent from left
  positionY:      50,   // percent from top
};

// ─── Message Config ───────────────────────────────────────────────────────────
// Independently styled from the timer display

let messageConfig = {
  font:      "monospace",
  fontSize:  "5",       // vw
  textColor: "#ffffff",
  bgColor:   "#000000",
  bgOpacity: 0,         // 0 = fully transparent, 100 = fully opaque
  positionX: 50,        // percent from left
  positionY: 90,        // percent from top (default near bottom)
  width:     80,        // percent of screen width
};

// ─── Presets ──────────────────────────────────────────────────────────────────

function loadPresets() {
  try {
    if (fs.existsSync(PRESETS_FILE))
      return JSON.parse(fs.readFileSync(PRESETS_FILE, "utf8"));
  } catch (e) { console.warn("Could not load presets.json:", e.message); }
  return [];
}

function savePresetsFile(p) {
  try { fs.writeFileSync(PRESETS_FILE, JSON.stringify(p, null, 2)); }
  catch (e) { console.error("Could not save presets.json:", e.message); }
}

let presets = loadPresets();

// ─── Tick Loop ────────────────────────────────────────────────────────────────

let lastTickTime = null;
let tickInterval = null;

function startTick() {
  if (tickInterval) return;
  lastTickTime = Date.now();
  tickInterval = setInterval(tick, TICK_MS);
}

function stopTick() {
  if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
  lastTickTime = null;
}

function tick() {
  const now   = Date.now();
  const delta = now - lastTickTime;
  lastTickTime = now;

  if (timerState.mode === "clock") {
    timerState.currentMs = timeOfDayMs();
  } else if (timerState.mode === "countup") {
    timerState.currentMs += delta;
  } else {
    if (!timerState.endReached) {
      timerState.currentMs = Math.max(0, timerState.currentMs - delta);
      if (timerState.currentMs === 0) handleCountdownEnd();
    }
  }

  broadcast({ type: "state", payload: getFullState() });
}

function handleCountdownEnd() {
  timerState.endReached = true;
  if (timerState.endBehavior === "hold") {
    timerState.running = false;
    stopTick();
  } else if (timerState.endBehavior === "next" && timerState.nextPresetId) {
    const next = presets.find(p => p.id === timerState.nextPresetId);
    if (next) { applyPreset(next); return; }
    timerState.running = false;
    stopTick();
  }
  // "flash": endReached halts decrement, display animates
}

function timeOfDayMs() {
  const now = new Date();
  return (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) * 1000
       + now.getMilliseconds();
}

// ─── State Helpers ────────────────────────────────────────────────────────────

function getFullState() {
  return {
    timer:   { ...timerState },
    display: { ...displayConfig },
    message: { ...messageConfig },
  };
}

function formatMs(ms, showSubseconds = false) {
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

function parseTimeString(str) {
  const parts = (str || "").trim().split(":").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return null;
  const [h, m, s] = parts;
  if (m > 59 || s > 59) return null;
  return (h * 3600 + m * 60 + s) * 1000;
}

// ─── Command Handlers ─────────────────────────────────────────────────────────

function handleCommand(action, payload = {}) {
  switch (action) {
    case "start":
      if (!timerState.running) {
        timerState.running    = true;
        timerState.endReached = false;
        if (timerState.mode === "clock") timerState.currentMs = timeOfDayMs();
        startTick();
      }
      break;

    case "pause":
      // Pause — stops the tick but keeps currentMs so resume works
      timerState.running = false;
      stopTick();
      break;

    case "stop":
      // Stop zeroes the display and clears any flash state.
      // Does not reset targetMs — Reset still returns to the set time.
      timerState.running    = false;
      timerState.endReached = false;
      timerState.currentMs  = 0;
      stopTick();
      break;

    case "reset":
      timerState.running    = false;
      timerState.endReached = false;
      stopTick();
      if (timerState.mode === "countdown")    timerState.currentMs = timerState.targetMs;
      else if (timerState.mode === "countup") timerState.currentMs = 0;
      else                                    timerState.currentMs = timeOfDayMs();
      break;

    case "setTime":
      if (typeof payload.ms === "number") {
        timerState.currentMs  = payload.ms;
        // In external mode don't overwrite targetMs — it retains the last
        // manually set value so switching back to countdown works naturally
        if (timerState.mode !== "external") timerState.targetMs = payload.ms;
        else timerState.lastExternalMs = Date.now();
        timerState.endReached = false;
      }
      break;

    case "setMode":
      if (["countdown", "countup", "clock", "external"].includes(payload.mode)) {
        timerState.endReached = false;
        timerState.mode       = payload.mode;
        if (payload.mode === "external") {
          timerState.lastExternalMs = null; // reset — no data yet
          // External source mode — park the tick loop completely.
          // currentMs is now driven by incoming setTime commands from a bridge.
          // Running state is set to true so the display shows it as active,
          // but no internal counting happens.
          timerState.running = true;
          stopTick();
        } else if (payload.mode === "countup") {
          timerState.currentMs = 0;
          timerState.running   = false;
          stopTick();
        } else if (payload.mode === "clock") {
          // Clock mode always runs — start it automatically
          timerState.currentMs = timeOfDayMs();
          timerState.running   = true;
          startTick();
        } else {
          // For countdown, stop if switching modes mid-run
          timerState.running = false;
          stopTick();
        }
      }
      break;

    case "setEndBehavior":
      if (["hold", "flash", "next"].includes(payload.behavior)) {
        timerState.endBehavior  = payload.behavior;
        timerState.nextPresetId = payload.nextPresetId || null;
      }
      break;

    case "adjust": {
      if (typeof payload.deltaMs === "number") {
        if (timerState.mode === "clock" || timerState.mode === "external") break;
        const adjusted = timerState.currentMs + payload.deltaMs;
        timerState.currentMs  = Math.max(0, adjusted);
        timerState.endReached = false;
        if (timerState.mode === "countdown" && timerState.currentMs === 0 && timerState.running) {
          handleCountdownEnd();
        }
      }
      break;
    }

    case "setMessage":
      // payload.text — set or clear the message
      timerState.message = (payload.text || "").slice(0, 200);
      break;
  }
}

function handlePreset(action, preset = {}) {
  switch (action) {
    case "save": {
      const id  = preset.id || `preset_${Date.now()}`;
      const idx = presets.findIndex(p => p.id === id);
      const entry = {
        id,
        name:          preset.name         || "Untitled",
        mode:          preset.mode         || timerState.mode,
        targetMs:      preset.targetMs     ?? timerState.targetMs,
        endBehavior:   preset.endBehavior  || timerState.endBehavior,
        nextPresetId:  preset.nextPresetId || null,
        displayConfig: preset.displayConfig || { ...displayConfig },
      };
      if (idx >= 0) presets[idx] = entry; else presets.push(entry);
      savePresetsFile(presets);
      break;
    }
    case "load": {
      const found = presets.find(p => p.id === preset.id);
      if (found) applyPreset(found);
      break;
    }
    case "delete":
      presets = presets.filter(p => p.id !== preset.id);
      savePresetsFile(presets);
      break;
  }
}

function applyPreset(preset) {
  const wasRunning = timerState.running;
  stopTick();
  timerState.mode          = preset.mode;
  timerState.targetMs      = preset.targetMs;
  timerState.currentMs     = preset.mode === "countup" ? 0
                           : preset.mode === "clock"   ? timeOfDayMs()
                           : preset.targetMs;
  timerState.endBehavior   = preset.endBehavior;
  timerState.nextPresetId  = preset.nextPresetId;
  timerState.endReached    = false;
  if (preset.displayConfig) Object.assign(displayConfig, preset.displayConfig);
  if (wasRunning || preset.mode === "clock") {
    timerState.running = true;
    startTick();
  } else {
    timerState.running = false;
  }
}

function handleConfig(updates) {
  // Timer display config keys
  const displayKeys = ["font", "fontSize", "textColor", "bgColor",
                       "showSubseconds", "label", "flashColor",
                       "positionX", "positionY"];
  for (const key of displayKeys) {
    if (key in updates) displayConfig[key] = updates[key];
  }

  // visibleDigits — array of 6 booleans
  if (Array.isArray(updates.visibleDigits) && updates.visibleDigits.length === 6) {
    displayConfig.visibleDigits = updates.visibleDigits.map(Boolean);
  }

  // colorTriggers — [{atMs, textColor, bgColor}]
  // Sorted descending so the display can find the active trigger with a simple find()
  if (Array.isArray(updates.colorTriggers)) {
    displayConfig.colorTriggers = updates.colorTriggers
      .filter(t => typeof t.atMs === "number" && t.textColor && t.bgColor)
      .sort((a, b) => b.atMs - a.atMs);
  }

  // Message config keys
  const msgKeys = ["font", "fontSize", "textColor", "bgColor", "bgOpacity", "positionX", "positionY", "width"];
  if (updates.messageConfig && typeof updates.messageConfig === "object") {
    for (const key of msgKeys) {
      if (key in updates.messageConfig) messageConfig[key] = updates.messageConfig[key];
    }
  }
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

const wsClients = new Set();

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}

// ─── OSC/TCP Server ───────────────────────────────────────────────────────────

function startTcpServer(port) {
  const server = net.createServer((socket) => {
    console.log(`OSC/TCP client connected: ${socket.remoteAddress}`);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, i).trim();
        buffer     = buffer.slice(i + 1);
        if (line) handleOscCommand(line);
      }
    });
    socket.on("close", () => console.log("OSC/TCP client disconnected"));
    socket.on("error", (e) => console.error("OSC/TCP error:", e.message));
  });
  server.listen(port, "0.0.0.0", () => console.log(`  OSC/TCP:      port ${port}`));
  server.on("error", (e) => console.error(`OSC/TCP server error (port ${port}):`, e.message));
  return server;
}

// ─── OSC/UDP Server ───────────────────────────────────────────────────────────

const udpSenders = new Map();
const SENDER_TTL = 30_000;

function startUdpServer(port) {
  const sock = dgram.createSocket("udp4");
  sock.on("message", (msg, rinfo) => {
    const key = `${rinfo.address}:${rinfo.port}`;
    udpSenders.set(key, { address: rinfo.address, port: rinfo.port, lastSeen: Date.now() });
    const line = msg.toString("utf8").trim();
    if (line) handleOscCommand(line);
  });
  sock.on("error", (e) => console.error(`OSC/UDP error (port ${port}):`, e.message));
  sock.bind(port, "0.0.0.0", () => console.log(`  OSC/UDP:      port ${port}`));
  return sock;
}

// ─── OSC Command Parser ───────────────────────────────────────────────────────

function handleOscCommand(line) {
  console.log(`OSC ← "${line}"`);
  const parts = line.split(/\s+/);
  const cmd   = parts[0].toLowerCase();

  switch (cmd) {
    case "/timer/start":  handleCommand("start"); break;
    case "/timer/pause":  handleCommand("pause"); break;
    case "/timer/stop":   handleCommand("stop");  break;
    case "/timer/reset":  handleCommand("reset"); break;

    case "/timer/set": {
      const ms = parseTimeString(parts[1]);
      if (ms !== null) handleCommand("setTime", { ms });
      else console.warn(`OSC /timer/set: invalid time "${parts[1]}"`);
      break;
    }
    case "/timer/mode": {
      const mode = (parts[1] || "").toLowerCase();
      if (["countdown", "countup", "clock", "external"].includes(mode))
        handleCommand("setMode", { mode });
      else console.warn(`OSC /timer/mode: unknown mode "${parts[1]}"`);
      break;
    }
    case "/timer/preset/load":
      if (parts[1]) handlePreset("load", { id: parts[1] });
      else console.warn("OSC /timer/preset/load: missing id");
      break;

    case "/timer/add": {
      const addMins = parts[1] !== undefined ? parseFloat(parts[1]) : 1;
      if (isNaN(addMins)) { console.warn(`OSC /timer/add: invalid value "${parts[1]}"`); break; }
      handleCommand("adjust", { deltaMs: Math.round(addMins * 60_000) });
      break;
    }
    case "/timer/subtract": {
      const subMins = parts[1] !== undefined ? parseFloat(parts[1]) : 1;
      if (isNaN(subMins)) { console.warn(`OSC /timer/subtract: invalid value "${parts[1]}"`); break; }
      handleCommand("adjust", { deltaMs: -Math.round(subMins * 60_000) });
      break;
    }
    case "/timer/preset/save": {
      const saveId = parts[1];
      if (!saveId) { console.warn("OSC /timer/preset/save: missing id"); break; }
      const existing = presets.find(p => p.id === saveId);
      if (!existing) { console.warn(`OSC /timer/preset/save: no preset with id "${saveId}"`); break; }
      handlePreset("save", {
        id:           saveId,
        name:         existing.name,
        mode:         timerState.mode,
        targetMs:     timerState.mode === "countdown" ? timerState.currentMs : timerState.targetMs,
        endBehavior:  timerState.endBehavior,
        nextPresetId: timerState.nextPresetId,
        displayConfig: { ...displayConfig },
      });
      broadcast({ type: "presets", payload: presets });
      break;
    }
    case "/timer/message":
      // /timer/message <text> or /timer/message (no arg = clear)
      handleCommand("setMessage", { text: parts.slice(1).join(" ") });
      break;

    default:
      console.warn(`OSC: unknown command "${cmd}"`);
  }

  broadcast({ type: "state", payload: getFullState() });
  if (global._pushIrisdownUpdate) global._pushIrisdownUpdate();
}

// ─── UDP Feedback Broadcast ───────────────────────────────────────────────────

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

function startFeedbackBroadcast(feedbackPort) {
  const sock = dgram.createSocket("udp4");
  sock.bind(() => {
    sock.setBroadcast(true);
    console.log(`  OSC feedback: port ${feedbackPort} (target: ${config.feedbackTarget || "auto"})`);
  });
  sock.on("error", (e) => console.error("Feedback socket error:", e.message));

  function buildFeedback() {
    const t = timerState;
    return Buffer.from(
      `/timer/state running=${t.running} mode=${t.mode} ` +
      `time=${formatMs(t.currentMs, displayConfig.showSubseconds)} ` +
      `ms=${Math.floor(t.currentMs)} end=${t.endReached}\n`
    );
  }

  function pruneSenders() {
    const cutoff = Date.now() - SENDER_TTL;
    for (const [k, v] of udpSenders) if (v.lastSeen < cutoff) udpSenders.delete(k);
  }

  function sendTo(msg, address) {
    sock.send(msg, feedbackPort, address, (e) => {
      if (e) console.error(`Feedback send error to ${address}:`, e.message);
    });
  }

  setInterval(() => {
    pruneSenders();
    const msg    = buildFeedback();
    const target = (config.feedbackTarget || "auto").trim().toLowerCase();
    if (target === "auto") {
      const broadcasts = getSubnetBroadcasts();
      for (const bc of broadcasts) sendTo(msg, bc);
      if (broadcasts.length === 0)
        console.debug("Feedback: no active interfaces, skipping broadcast");
    } else {
      sendTo(msg, target);
    }
    for (const { address, feedbackPort } of udpSenders.values()) {
      sock.send(msg, feedbackPort, address, (e) => {
        if (e) console.error(`Feedback unicast error to ${address}:`, e.message);
      });
    }
  }, 500);
}


// ─── IDCT Broadcast (Interspace Industries CDEther compatible) ────────────────
// Broadcasts a 20-character UDP string every 100ms on port 61003.
// Format (Irisdown Countdown Timer v2.0.10+ / CDEther protocol):
//   "IDCT:" + sign + seconds(6 digits) + instanceId(hex) + color + blink + padding
// This makes the Pi a drop-in replacement for a CDEther transmitter —
// any CDEther receiver or compatible app on the network will display our time.

function startIdctBroadcast(idctPort) {
  const sock = dgram.createSocket("udp4");
  sock.bind(() => {
    sock.setBroadcast(true);
    console.log(`  IDCT broadcast: port ${idctPort} (CDEther compatible)`);
  });
  sock.on("error", (e) => console.error("IDCT socket error:", e.message));

  setInterval(() => {
    const ms      = timerState.currentMs;
    const seconds = Math.floor(ms / 1000);
    const sign    = timerState.endReached ? "-" : "+";  // "-" = overtime per spec
    const secStr  = String(seconds).padStart(6, "0");   // max 344619 (99h59m59s)
    const instId  = "0";   // single instance, hex 0
    const color   = "G";   // green — color change not yet implemented per spec
    const blink   = "0";   // no blink
    const padding = "     ";  // 5 unused chars for future expansion
    const packet  = Buffer.from(`IDCT:${sign}${secStr}${instId}${color}${blink}${padding}`);
    // Always broadcast to 255.255.255.255 as per Irisdown spec
    sock.send(packet, idctPort, "255.255.255.255", (e) => {
      if (e) console.error("IDCT broadcast error:", e.message);
    });
  }, 100); // 100ms interval per Irisdown protocol spec
}


// ─── Bridge Manager ───────────────────────────────────────────────────────────
// Scans bridges/ directory for .js files, reads their BRIDGE_META block,
// spawns/kills child processes, persists running state across server restarts.

const { spawn } = require("child_process");

const BRIDGES_DIR  = path.join(__dirname, "bridges");
const BRIDGE_STATE = path.join(__dirname, "bridge-state.json");

// Map of bridgeId -> { process, config, meta, shouldRun }
const bridgeProcesses = new Map();

// Read BRIDGE_META JSON block from the first 3KB of a bridge script
function readBridgeMeta(filePath) {
  try {
    const chunk = fs.readFileSync(filePath, "utf8").slice(0, 3000);
    const start = chunk.indexOf("/* BRIDGE_META");
    const end   = chunk.indexOf("BRIDGE_META */");
    if (start === -1 || end === -1) return { name: path.basename(filePath, ".js"), description: "", fields: [] };
    const json = chunk.slice(start + 14, end).trim();
    return { name: path.basename(filePath, ".js"), description: "", fields: [], ...JSON.parse(json) };
  } catch (e) {
    return { name: path.basename(filePath, ".js"), description: "", fields: [] };
  }
}

// Scan bridges directory and return list of available bridges with meta + status
function listBridges() {
  if (!fs.existsSync(BRIDGES_DIR)) return [];
  return fs.readdirSync(BRIDGES_DIR)
    .filter(f => f.endsWith(".js"))
    .map(f => {
      const id   = path.basename(f, ".js");
      const meta = readBridgeMeta(path.join(BRIDGES_DIR, f));
      const proc = bridgeProcesses.get(id);
      return {
        id,
        ...meta,
        running:   !!(proc && proc.process),
        shouldRun: !!(proc && proc.shouldRun),
        config:    proc ? proc.config : {},
      };
    });
}

function loadBridgeState() {
  try {
    if (fs.existsSync(BRIDGE_STATE))
      return JSON.parse(fs.readFileSync(BRIDGE_STATE, "utf8"));
  } catch (e) { console.warn("Could not load bridge-state.json:", e.message); }
  return {};
}

function saveBridgeState() {
  const state = {};
  for (const [id, info] of bridgeProcesses) {
    if (info.shouldRun) state[id] = { config: info.config };
  }
  try { fs.writeFileSync(BRIDGE_STATE, JSON.stringify(state, null, 2)); }
  catch (e) { console.error("Could not save bridge-state.json:", e.message); }
}

// Convert field config object to CLI args array
// { irisdown: "192.168.1.50" } -> ["--irisdown", "192.168.1.50"]
function configToArgs(config) {
  const args = [];
  for (const [key, val] of Object.entries(config)) {
    if (val !== "" && val !== null && val !== undefined) {
      args.push("--" + key, String(val));
    }
  }
  return args;
}

function startBridge(id, config) {
  const scriptPath = path.join(BRIDGES_DIR, id + ".js");
  if (!fs.existsSync(scriptPath)) {
    console.warn("Bridge script not found:", scriptPath);
    return false;
  }

  // Kill existing process if any
  stopBridge(id, false);

  const args = configToArgs(config);
  console.log("Starting bridge:", id, args);

  const proc = spawn(process.execPath, [scriptPath, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  proc.stdout.on("data", (d) => process.stdout.write("[bridge:" + id + "] " + d));
  proc.stderr.on("data", (d) => process.stderr.write("[bridge:" + id + "] " + d));

  proc.on("exit", (code, signal) => {
    console.log("Bridge " + id + " exited (code=" + code + " signal=" + signal + ")");
    const info = bridgeProcesses.get(id);
    if (info) {
      info.process = null;
      // Auto-restart if it should still be running and didn't exit cleanly
      if (info.shouldRun && code !== 0) {
        console.log("Auto-restarting bridge " + id + " in 3s...");
        setTimeout(() => {
          if (bridgeProcesses.get(id) && bridgeProcesses.get(id).shouldRun)
            startBridge(id, info.config);
        }, 3000);
      }
    }
    broadcast({ type: "bridges", payload: listBridges() });
  });

  bridgeProcesses.set(id, { process: proc, config, shouldRun: true });
  saveBridgeState();
  broadcast({ type: "bridges", payload: listBridges() });
  return true;
}

function stopBridge(id, persist = true) {
  const info = bridgeProcesses.get(id);
  if (info) {
    info.shouldRun = false;
    if (info.process) {
      info.process.kill("SIGTERM");
      info.process = null;
    }
    if (persist) {
      saveBridgeState();
      broadcast({ type: "bridges", payload: listBridges() });
    }
  }
}

// Re-launch bridges that were running before the server restarted
function restoreBridges() {
  const saved = loadBridgeState();
  for (const [id, info] of Object.entries(saved)) {
    console.log("Restoring bridge:", id);
    startBridge(id, info.config || {});
  }
}

// ─── Font Discovery ───────────────────────────────────────────────────────────
// Uses fc-list (fontconfig) to enumerate installed font families.
// Returns pinned fonts first, then sorted system fonts below a separator.

const PINNED_FONTS = [
  { label: "Nunito",          value: "Nunito, sans-serif" },
  { label: "Quicksand",       value: "Quicksand, sans-serif" },
  { label: "Trebuchet MS",    value: "'Trebuchet MS', sans-serif" },
  { label: "Monospace",       value: "monospace" },
  { label: "Courier New",     value: "'Courier New', monospace" },
  { label: "Roboto Mono",     value: "'Roboto Mono', monospace" },
  { label: "Share Tech Mono", value: "'Share Tech Mono', monospace" },
];

function getInstalledFonts() {
  try {
    const raw = execSync("fc-list : family", { timeout: 3000 }).toString();
    const families = new Set();
    for (const line of raw.split("\n")) {
      // fc-list may return comma-separated aliases; take the first
      const family = line.split(",")[0].trim();
      if (family) families.add(family);
    }
    // Remove pinned font names from the system list to avoid duplicates
    const pinnedLabels = new Set(PINNED_FONTS.map(f => f.label.toLowerCase()));
    const system = [...families]
      .filter(f => !pinnedLabels.has(f.toLowerCase()))
      .sort((a, b) => a.localeCompare(b))
      .map(f => ({ label: f, value: `'${f}', sans-serif` }));

    return { pinned: PINNED_FONTS, system };
  } catch (e) {
    console.warn("fc-list not available:", e.message);
    return { pinned: PINNED_FONTS, system: [] };
  }
}


// ─── Irisdown TCP Server (port 61002) ────────────────────────────────────────
// Implements the Irisdown Countdown Timer v2.0.10 Remote Control Protocol.
// Commands are plain ASCII, newline-terminated — similar to our OSC TCP server.
// Supports UPDATES ON mode 2 for push feedback to connected clients.
//
// Command mapping to our internal handlers:
//   GO           → start
//   PAUSE        → pause
//   TOGGLEPAUSE  → start (if stopped) or pause (if running)
//   RESET        → reset
//   RESET hh:mm:ss → setTime
//   JOG <min>    → adjust
//   MESSAGE "x"  → setMessage
//   MESSAGE CLEAR → setMessage (empty)
//   STATE        → returns PLAYING | PAUSED | STOPPED
//   REMAINING    → returns seconds remaining
//   UPDATES ON/OFF → subscribe to push updates (mode 2)
//   VERSION      → returns our version string

function startIrisdownServer(port) {
  const irisdownClients = new Map(); // socket → { updatesEnabled }

  // Push an UPDATES mode 2 line to all subscribed Irisdown clients
  function pushIrisdownUpdate() {
    const t       = timerState;
    const ms      = t.currentMs;
    const sign    = t.endReached ? "-" : "+";
    const hh      = String(Math.floor(ms / 3_600_000)).padStart(2, "0");
    const mm      = String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, "0");
    const ss      = String(Math.floor((ms % 60_000) / 1_000)).padStart(2, "0");
    const state   = t.running ? "PLAYING" : (t.currentMs === t.targetMs ? "STOPPED" : "PAUSED");
    const display = t.mode === "clock" ? "CLOCK" : "TIMER";
    const message = (t.message && t.message.trim()) ? "TRUE" : "FALSE";
    const line    = `TIME=${sign}${hh}:${mm}:${ss}&STATE=${state}&DISPLAY=${display}&MESSAGE=${message}\r\n`;
    for (const [sock, info] of irisdownClients) {
      if (info.updatesEnabled && sock.writable) {
        sock.write(line);
      }
    }
  }

  // Hook into the broadcast cycle so Irisdown clients get updates too
  // We store the push function globally so the tick/command handlers can call it
  global._pushIrisdownUpdate = pushIrisdownUpdate;

  const server = net.createServer((socket) => {
    console.log(`Irisdown client connected: ${socket.remoteAddress}`);
    irisdownClients.set(socket, { updatesEnabled: false });

    let buffer = "";
    socket.setEncoding("utf8");

    function reply(msg) {
      if (socket.writable && !irisdownClients.get(socket)?.updatesEnabled) {
        socket.write(msg + "\r\n");
      }
    }

    socket.on("data", (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, i).replace(/\r$/, "").trim();
        buffer     = buffer.slice(i + 1);
        if (!line) continue;

        console.log(`Irisdown ← "${line}"`);
        const upper = line.toUpperCase();
        const parts = line.split(/\s+/);
        const cmd   = parts[0].toUpperCase();

        if (cmd === "GO") {
          handleCommand("start");
          reply("OK");

        } else if (cmd === "PAUSE") {
          handleCommand("pause");
          reply("OK");

        } else if (cmd === "TOGGLEPAUSE") {
          handleCommand(timerState.running ? "pause" : "start");
          reply("OK");

        } else if (cmd === "RESET" && parts.length === 1) {
          handleCommand("reset");
          reply("OK");

        } else if (cmd === "RESET" && parts.length === 2) {
          // RESET <minutes> or RESET hh:mm or RESET hh:mm:ss
          let ms = null;
          if (parts[1].includes(":")) {
            ms = parseTimeString(parts[1]);
          } else {
            const mins = parseFloat(parts[1]);
            if (!isNaN(mins)) ms = Math.round(mins * 60_000);
          }
          if (ms !== null) {
            handleCommand("setTime", { ms });
            handleCommand("reset");
            reply("OK");
          } else {
            reply("ERROR");
          }

        } else if (cmd === "JOG" && parts.length === 2) {
          const mins = parseFloat(parts[1]);
          if (!isNaN(mins)) {
            handleCommand("adjust", { deltaMs: Math.round(mins * 60_000) });
            reply("OK");
          } else {
            reply("ERROR");
          }

        } else if (cmd === "REMAINING") {
          reply(String(Math.floor(timerState.currentMs / 1000)));

        } else if (cmd === "STATE") {
          const t = timerState;
          const state = t.running ? "PLAYING"
                      : (t.currentMs === t.targetMs || t.currentMs === 0) ? "STOPPED"
                      : "PAUSED";
          reply(state);

        } else if (cmd === "VERSION") {
          reply("VERSION 2.0.10.0");  // report Irisdown-compatible version

        } else if (cmd === "UPDATES") {
          const onOff = (parts[1] || "").toUpperCase();
          if (onOff === "ON") {
            irisdownClients.get(socket).updatesEnabled = true;
            // Send immediate state so client doesn't wait for next change
            pushIrisdownUpdate();
          } else if (onOff === "OFF") {
            irisdownClients.get(socket).updatesEnabled = false;
            reply("OK");
          } else {
            reply("ERROR");
          }

        } else if (cmd === "UPDATEMODE") {
          // We only implement mode 2 — silently accept mode 2, reject others
          if (parts[1] === "2") reply("OK");
          else reply("ERROR");

        } else if (cmd === "MESSAGE") {
          const rest = line.slice(8).trim(); // everything after "MESSAGE "
          if (rest.toUpperCase() === "CLEAR" || rest === "") {
            handleCommand("setMessage", { text: "" });
          } else {
            // Strip surrounding quotes if present
            const text = rest.replace(/^"|"$/g, "");
            handleCommand("setMessage", { text });
          }
          reply("OK");

        } else if (cmd === "DISPLAY") {
          // DISPLAY TIMER|CLOCK|BLACK|TEST — we support TIMER and CLOCK
          const mode = (parts[1] || "").toUpperCase();
          if (mode === "CLOCK") handleCommand("setMode", { mode: "clock" });
          else if (mode === "TIMER") {
            if (timerState.mode === "clock") handleCommand("setMode", { mode: "countdown" });
          }
          reply("OK");

        } else {
          reply("ERROR");
        }

        broadcast({ type: "state", payload: getFullState() });
      }
    });

    socket.on("close", () => {
      irisdownClients.delete(socket);
      console.log("Irisdown client disconnected");
    });
    socket.on("error", (e) => {
      console.error("Irisdown TCP error:", e.message);
      irisdownClients.delete(socket);
    });
  });

  server.listen(port, "0.0.0.0", () => console.log(`  Irisdown TCP: port ${port}`));
  server.on("error", (e) => console.error(`Irisdown server error (port ${port}):`, e.message));
  return server;
}

// ─── Avahi / mDNS Hostname ────────────────────────────────────────────────────

const AVAHI_SERVICE = "/etc/avahi/services/countdown-timer.service";

function applyAvahiHostname(hostname) {
  const safe = hostname.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 63);
  const xml = `<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name replace-wildcards="yes">${safe}</name>
  <service>
    <type>_http._tcp</type>
    <port>${config.httpPort}</port>
    <txt-record>path=/</txt-record>
  </service>
</service-group>
`;
  try { fs.writeFileSync(AVAHI_SERVICE, xml); }
  catch (e) { console.warn("Could not write avahi service file:", e.message); return; }
  try {
    fs.writeFileSync("/etc/hostname", safe + "\n");
    exec(`hostname ${safe}`);
  } catch (e) { console.warn("Could not update /etc/hostname:", e.message); }
  exec("pkill -HUP avahi-daemon", (e) => {
    if (e) console.warn("Could not reload avahi-daemon:", e.message);
    else   console.log(`  mDNS name:    http://${safe}.local`);
  });
}

// ─── HTTP + API Server ────────────────────────────────────────────────────────

const MIME = {
  ".html": "text/html",
  ".js":   "application/javascript",
  ".css":  "text/css",
  ".json": "application/json",
  ".ico":  "image/x-icon",
  ".ttf":  "font/ttf",
  ".woff": "font/woff",
  ".woff2":"font/woff2",
  ".otf":  "font/otf",
};

function handleApiRequest(req, res) {
  // GET /api/bridges
  if (req.method === "GET" && req.url === "/api/bridges") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(listBridges()));
    return true;
  }

  // POST /api/bridges/start
  if (req.method === "POST" && req.url === "/api/bridges/start") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let payload;
      try { payload = JSON.parse(body); }
      catch { res.writeHead(400); res.end(JSON.stringify({ error: "Invalid JSON" })); return; }
      const { id, config = {} } = payload;
      if (!id) { res.writeHead(400); res.end(JSON.stringify({ error: "Missing id" })); return; }
      const ok = startBridge(id, config);
      res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok, bridges: listBridges() }));
    });
    return true;
  }

  // POST /api/bridges/stop
  if (req.method === "POST" && req.url === "/api/bridges/stop") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let payload;
      try { payload = JSON.parse(body); }
      catch { res.writeHead(400); res.end(JSON.stringify({ error: "Invalid JSON" })); return; }
      const { id } = payload;
      if (!id) { res.writeHead(400); res.end(JSON.stringify({ error: "Missing id" })); return; }
      stopBridge(id);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, bridges: listBridges() }));
    });
    return true;
  }

  // GET /api/config
  if (req.method === "GET" && req.url === "/api/config") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ...config, version: TIMER_VERSION }));
    return true;
  }

  // POST /api/reload — broadcasts a reload command to all connected display pages
  if (req.method === "POST" && req.url === "/api/reload") {
    broadcast({ type: "reload" });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  // GET /api/fonts
  if (req.method === "GET" && req.url === "/api/fonts") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getInstalledFonts()));
    return true;
  }

  // POST /api/system
  if (req.method === "POST" && req.url === "/api/system") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let updates;
      try { updates = JSON.parse(body); }
      catch { res.writeHead(400); res.end(JSON.stringify({ error: "Invalid JSON" })); return; }

      const portKeys = ["httpPort", "oscTcpPort", "oscUdpPort", "oscFeedbackPort", "irisdownPort", "idctPort"];

      if (updates.feedbackTarget !== undefined) {
        const t = updates.feedbackTarget.trim();
        const isAuto = t.toLowerCase() === "auto";
        const isIp   = /^\d{1,3}(\.\d{1,3}){3}$/.test(t);
        if (!isAuto && !isIp) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "feedbackTarget must be 'auto' or a valid IP address" }));
          return;
        }
        updates.feedbackTarget = t;
      }

      for (const key of portKeys) {
        if (!(key in updates)) continue;
        const p = parseInt(updates[key], 10);
        if (isNaN(p) || p < 1 || p > 65535) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: `Invalid port for ${key}` }));
          return;
        }
        updates[key] = p;
      }

      if (updates.hostname !== undefined) {
        const safe = updates.hostname.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 63);
        if (!safe) { res.writeHead(400); res.end(JSON.stringify({ error: "Invalid hostname" })); return; }
        updates.hostname = safe;
      }

      config = { ...config, ...updates };
      saveConfig(config);
      if (updates.hostname) applyAvahiHostname(updates.hostname);

      const portChanged = portKeys.some(k => k in updates);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, config, restartRequired: portChanged }));

      if (portChanged) {
        console.log("Port config changed — restarting in 1.5s…");
        setTimeout(() => process.exit(0), 1500);
      }
    });
    return true;
  }

  return false;
}

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (handleApiRequest(req, res)) return;

  let urlPath = req.url.split("?")[0];
  if (urlPath === "/")         urlPath = "/control.html";
  if (urlPath === "/display")  urlPath = "/display.html";
  if (urlPath === "/control")  urlPath = "/control.html";
  if (urlPath === "/admin")    urlPath = "/admin.html";

  const filePath = path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end("Forbidden"); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    const mime = MIME[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": mime });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  wsClients.add(ws);
  console.log(`WS client connected (${wsClients.size} total)`);
  ws.send(JSON.stringify({ type: "state",     payload: getFullState() }));
  ws.send(JSON.stringify({ type: "presets",   payload: presets }));
  ws.send(JSON.stringify({ type: "sysconfig", payload: config }));
  ws.send(JSON.stringify({ type: "bridges",   payload: listBridges() }));

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { type, payload = {} } = msg;

    if (type === "command") {
      handleCommand(payload.action, payload);
    } else if (type === "preset") {
      handlePreset(payload.action, payload.preset || {});
      broadcast({ type: "presets", payload: presets });
    } else if (type === "config") {
      handleConfig(payload);
    }

    broadcast({ type: "state", payload: getFullState() });
    if (global._pushIrisdownUpdate) global._pushIrisdownUpdate();
  });

  ws.on("close", () => { wsClients.delete(ws); console.log(`WS disconnected (${wsClients.size} remaining)`); });
  ws.on("error", (e) => { console.error("WS error:", e.message); wsClients.delete(ws); });
});

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(config.httpPort, "0.0.0.0", () => {
  console.log(`\nCountdown Timer v1.3.1`);
  console.log(`  HTTP/WS:      port ${config.httpPort}`);
  console.log(`  Display:      http://localhost:${config.httpPort}/display`);
  console.log(`  Control:      http://localhost:${config.httpPort}/control`);
  console.log(`  Admin:        http://localhost:${config.httpPort}/admin`);
});

restoreBridges();
startTcpServer(config.oscTcpPort);
startUdpServer(config.oscUdpPort);
startFeedbackBroadcast(config.oscFeedbackPort);
startIdctBroadcast(config.idctPort);
startIrisdownServer(config.irisdownPort);
applyAvahiHostname(config.hostname);
