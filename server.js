/**
 * server.js — Countdown Timer Server (v1.4.0)
 *
 * New in v1.4:
 *  - Bridge system: receive, control, and transmit bridge types
 *  - All protocol handling (TCP/UDP control, Irisdown, IDCT, LTC, OSC) moved to bridges
 *  - server.js now provides only HTTP + WebSocket core; everything else is optional
 *  - Single-receive enforcement: only one receive bridge may run at a time
 *  - Bridge auto-restart on unexpected exit
 */

const http     = require("http");
const fs       = require("fs");
const path     = require("path");
const { exec, execSync } = require("child_process");
const { WebSocketServer, WebSocket } = require("ws");

const TIMER_VERSION = "1.4.0";

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG_FILE  = path.join(__dirname, "config.json");
const PRESETS_FILE = path.join(__dirname, "presets.json");
const PUBLIC_DIR   = path.join(__dirname, "public");
const TICK_MS      = 100;

const CONFIG_DEFAULTS = {
  httpPort:        80,
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
        type:      meta.type || "receive",
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

function startBridge(id, bridgeConfig) {
  const scriptPath = path.join(BRIDGES_DIR, id + ".js");
  if (!fs.existsSync(scriptPath)) {
    console.warn("Bridge script not found:", scriptPath);
    return false;
  }

  // Enforce single-receive rule — only one receive bridge at a time.
  // control and transmit bridges have no such restriction.
  const meta = readBridgeMeta(scriptPath);
  if (!meta.type) console.warn(`Bridge "${id}" has no type in BRIDGE_META — treating as receive`);
  const bridgeType = meta.type || "receive";
  if (bridgeType === "receive") {
    for (const [otherId, info] of bridgeProcesses) {
      if (otherId === id) continue;
      if (info.shouldRun && info.process) {
        const otherMeta = readBridgeMeta(path.join(BRIDGES_DIR, otherId + ".js"));
        const otherType = otherMeta.type || "receive";
        if (otherType === "receive") {
          console.warn(`Cannot start receive bridge "${id}" — "${otherId}" is already running`);
          return { conflict: otherId };
        }
      }
    }
  }

  // Kill existing process if any
  stopBridge(id, false);

  const args = ["--http-port", String(config.httpPort), ...configToArgs(bridgeConfig)];
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

  bridgeProcesses.set(id, { process: proc, config: bridgeConfig, shouldRun: true });
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
      const result = startBridge(id, config);
      if (result && result.conflict) {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: `Cannot start receive bridge "${id}" — "${result.conflict}" is already running`, conflictingBridge: result.conflict, bridges: listBridges() }));
        return;
      }
      res.writeHead(result ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: !!result, bridges: listBridges() }));
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

      const portKeys = ["httpPort"];

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
  });

  ws.on("close", () => { wsClients.delete(ws); console.log(`WS disconnected (${wsClients.size} remaining)`); });
  ws.on("error", (e) => { console.error("WS error:", e.message); wsClients.delete(ws); });
});

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(config.httpPort, "0.0.0.0", () => {
  console.log(`\nCountdown Timer v1.4.0`);
  console.log(`  HTTP/WS:      port ${config.httpPort}`);
  console.log(`  Display:      http://localhost:${config.httpPort}/display`);
  console.log(`  Control:      http://localhost:${config.httpPort}/control`);
  console.log(`  Admin:        http://localhost:${config.httpPort}/admin`);
});

restoreBridges();
applyAvahiHostname(config.hostname);
