/**
 * server.js — Countdown Timer Server (v1.6.0)
 *
 * New in v1.5:
 *  - GET  /api/update/check  — fetch remote, compare versions
 *  - POST /api/update/apply  — git pull + npm install + restart
 *  - POST /api/display/launch — open Chromium kiosk on Pi desktop
 *  - Update token read from /etc/eventstimer-update.token at startup
 */

const http     = require("http");
const fs       = require("fs");
const path     = require("path");
const { exec, execSync } = require("child_process");
const { WebSocketServer, WebSocket } = require("ws");

const TIMER_VERSION = "1.10.0";

// ─── Config ───────────────────────────────────────────────────────────────────

const CONFIG_FILE  = path.join(__dirname, "config.json");
const PRESETS_FILE = path.join(__dirname, "presets.json");
const PUBLIC_DIR   = path.join(__dirname, "public");
const TICK_MS      = 100;

const CONFIG_DEFAULTS = {
  httpPort:  80,
  hostname:  "timer",
  iface:     "eth0",
  colorSlots: [
    { name: "Normal",  textColor: "#ffffff", labelColor: "#ffffff", bgColor: "#000000", flashColor: "#ff0000", msgBgOpacity: 0 },
    { name: "Good",    textColor: "#4fc978", labelColor: "#4fc978", bgColor: "#000000", flashColor: "#ff0000", msgBgOpacity: 0 },
    { name: "Warning", textColor: "#f9c74f", labelColor: "#f9c74f", bgColor: "#000000", flashColor: "#ff0000", msgBgOpacity: 0 },
    { name: "Alert",   textColor: "#f95f4f", labelColor: "#f95f4f", bgColor: "#000000", flashColor: "#ff0000", msgBgOpacity: 0 },
  ],
  timerDisplaySlots: [
    { name: "Default", font: "monospace", fontSize: "20", showSubseconds: false, visibleDigits: [false,false,true,true,true,true], positionX: 50, positionY: 50, colorTriggers: [] },
    { name: "Slot 2",  font: "monospace", fontSize: "20", showSubseconds: false, visibleDigits: [false,false,true,true,true,true], positionX: 50, positionY: 50, colorTriggers: [] },
    { name: "Slot 3",  font: "monospace", fontSize: "20", showSubseconds: false, visibleDigits: [false,false,true,true,true,true], positionX: 50, positionY: 50, colorTriggers: [] },
    { name: "Slot 4",  font: "monospace", fontSize: "20", showSubseconds: false, visibleDigits: [false,false,true,true,true,true], positionX: 50, positionY: 50, colorTriggers: [] },
  ],
  msgDisplaySlots: [
    { name: "Default", font: "monospace", fontSize: "5", positionX: 50, positionY: 90, width: 80 },
    { name: "Slot B",  font: "monospace", fontSize: "5", positionX: 50, positionY: 90, width: 80 },
    { name: "Slot C",  font: "monospace", fontSize: "5", positionX: 50, positionY: 90, width: 80 },
    { name: "Slot D",  font: "monospace", fontSize: "5", positionX: 50, positionY: 90, width: 80 },
  ],
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

// Migrate old definedColors → colorSlots[0..2].textColor/labelColor
if (!Array.isArray(config.colorSlots) || config.colorSlots.length !== 4) {
  const defs = CONFIG_DEFAULTS.colorSlots.map(s => ({ ...s }));
  if (Array.isArray(config.definedColors)) {
    config.definedColors.slice(0, 3).forEach((hex, i) => {
      defs[i + 1].textColor  = hex;
      defs[i + 1].labelColor = hex;
    });
  }
  config.colorSlots = defs;
  delete config.definedColors;
  saveConfig(config);
}
if (!Array.isArray(config.timerDisplaySlots) || config.timerDisplaySlots.length !== 4) {
  config.timerDisplaySlots = CONFIG_DEFAULTS.timerDisplaySlots.map(s => ({ ...s }));
  saveConfig(config);
}
if (!Array.isArray(config.msgDisplaySlots) || config.msgDisplaySlots.length !== 4) {
  config.msgDisplaySlots = CONFIG_DEFAULTS.msgDisplaySlots.map(s => ({ ...s }));
  saveConfig(config);
}

// ─── Timer State ──────────────────────────────────────────────────────────────

let timerState = {
  mode:              "countdown",
  running:           false,
  currentMs:         5 * 60 * 1000,
  targetMs:          5 * 60 * 1000,
  endBehavior:       "flash",
  activePresetId:    null,
  nextPresetId:      null,
  endReached:        false,
  messages:          [{ text: "", colorSlot: 1 }, { text: "", colorSlot: 1 }, { text: "", colorSlot: 1 }, { text: "", colorSlot: 1 }],
  lastExternalMs:    null,
  activeColorSlot:   1,
  activeDisplaySlot: 1,
};

// Background parent state — set when a child timer is foreground in a nested session.
// running mirrors timerState.running — both always start/pause/stop together.
let backgroundParent = null; // { id, currentMs, targetMs, endReached, running }

// Which timer the display page shows: "foreground" (child) or "parent".
// Reset to "foreground" whenever a session is exited or a standalone preset loads.
let displayFocus = "foreground";


// ─── Presets ──────────────────────────────────────────────────────────────────

function loadPresets() {
  try {
    if (fs.existsSync(PRESETS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(PRESETS_FILE, "utf8"));
      return raw.map(p => {
        // Migrate: promote displayConfig.label → preset.label
        if (p.displayConfig && !p.label) p.label = p.displayConfig.label || "";
        const { displayConfig: _dc, ...rest } = p;
        return {
          children:            [],
          parentId:            null,
          useParentRemaining:  false,
          defaultDisplayFocus: "foreground",
          colorSlot:           1,
          displaySlot:         1,
          ...rest,
          // Ensure colorSlot/displaySlot are always valid numbers
          colorSlot:   (rest.colorSlot   != null ? rest.colorSlot   : 1),
          displaySlot: (rest.displaySlot != null ? rest.displaySlot : 1),
        };
      });
    }
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
  // Keep the loop alive only if the parent is still actively running.
  if (backgroundParent && backgroundParent.running) return;
  if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
  lastTickTime = null;
}

function hardStopTick() {
  if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
  lastTickTime = null;
}

function tick() {
  const now   = Date.now();
  const delta = now - lastTickTime;
  lastTickTime = now;

  // Foreground timer — only advances while running
  if (timerState.running) {
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
  }

  // Background parent — ticks only when running (mirrors foreground running state)
  if (backgroundParent && backgroundParent.running && !backgroundParent.endReached) {
    backgroundParent.currentMs = Math.max(0, backgroundParent.currentMs - delta);
    if (backgroundParent.currentMs === 0) backgroundParent.endReached = true;
  }

  broadcast({ type: "state", payload: getFullState() });
}

function handleCountdownEnd() {
  timerState.endReached = true;
  if (timerState.endBehavior === "hold") {
    timerState.running = false;
    // Parent keeps ticking — stopTick() checks backgroundParent.running and keeps the loop alive.
    // This preserves correct remaining time for subsequent children.
    stopTick();
  } else if (timerState.endBehavior === "load" || timerState.endBehavior === "start") {
    const autoStart = timerState.endBehavior === "start";
    // In nested context — advance to next sibling child instead of using nextPresetId
    if (backgroundParent) {
      const parentPreset = presets.find(p => p.id === backgroundParent.id);
      if (parentPreset && Array.isArray(parentPreset.children)) {
        const idx = parentPreset.children.indexOf(timerState.activePresetId);
        if (idx >= 0 && idx < parentPreset.children.length - 1) {
          const nextChild = presets.find(p => p.id === parentPreset.children[idx + 1]);
          if (nextChild) {
            fireChild(nextChild);
            if (autoStart) {
              timerState.running = true;
              backgroundParent.running = true;
            }
            return;
          }
        }
      }
      // No next sibling — hold at 0
      timerState.running = false;
      backgroundParent.running = false;
      return;
    }
    // Normal single-timer behavior
    const next = presets.find(p => p.id === timerState.nextPresetId);
    if (next) {
      applyPreset(next, autoStart);
      return;
    }
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

// Load a child preset as the foreground timer without touching backgroundParent.
// The last child in the parent's list always snaps to the parent's remaining time.
// Any child with useParentRemaining also snaps.
function fireChild(child) {
  const parentPreset = backgroundParent ? presets.find(p => p.id === backgroundParent.id) : null;
  const isLastChild  = parentPreset && Array.isArray(parentPreset.children) &&
                       parentPreset.children.length > 0 &&
                       parentPreset.children[parentPreset.children.length - 1] === child.id;
  const snapToParent = (isLastChild || child.useParentRemaining) && backgroundParent;
  const targetMs = snapToParent ? backgroundParent.currentMs : child.targetMs;
  timerState.mode              = child.mode || "countdown";
  timerState.targetMs          = targetMs;
  timerState.currentMs         = child.mode === "countup" ? 0 : targetMs;
  timerState.endBehavior       = child.endBehavior;
  timerState.endReached        = false;
  timerState.running           = false;
  timerState.activePresetId    = child.id;
  timerState.nextPresetId      = null;
  timerState.activeColorSlot   = child.colorSlot   ?? 1;
  timerState.activeDisplaySlot = child.displaySlot  ?? 1;
}

function getFullState() {
  const activePreset = timerState.activePresetId
    ? presets.find(p => p.id === timerState.activePresetId)
    : null;

  let parentContext = null;
  if (backgroundParent) {
    const parentPreset = presets.find(p => p.id === backgroundParent.id);
    parentContext = {
      id:         backgroundParent.id,
      name:       parentPreset ? parentPreset.name : "Session",
      currentMs:  backgroundParent.currentMs,
      targetMs:   backgroundParent.targetMs,
      endReached: backgroundParent.endReached,
      running:    backgroundParent.running,
      childIds:   parentPreset ? (parentPreset.children || []) : [],
    };
  }

  const cs = config.colorSlots[(timerState.activeColorSlot  || 1) - 1] || config.colorSlots[0];
  const ds = config.timerDisplaySlots[(timerState.activeDisplaySlot || 1) - 1] || config.timerDisplaySlots[0];

  const messages = timerState.messages.map((m, i) => {
    const mcs = config.colorSlots[(m.colorSlot || 1) - 1] || config.colorSlots[0];
    const mds = config.msgDisplaySlots[i] || config.msgDisplaySlots[0];
    return {
      text:      m.text || "",
      colorSlot: m.colorSlot || 1,
      font:      mds.font,
      fontSize:  mds.fontSize,
      textColor: mcs.textColor,
      bgColor:   mcs.bgColor,
      bgOpacity: mcs.msgBgOpacity,
      positionX: mds.positionX,
      positionY: mds.positionY,
      width:     mds.width,
    };
  });

  return {
    timer: { ...timerState, activePresetName: activePreset ? activePreset.name : null },
    display: {
      font:           ds.font,
      fontSize:       ds.fontSize,
      textColor:      cs.textColor,
      labelColor:     cs.labelColor,
      bgColor:        cs.bgColor,
      flashColor:     cs.flashColor,
      showSubseconds: ds.showSubseconds,
      visibleDigits:  ds.visibleDigits,
      colorTriggers:  ds.colorTriggers,
      positionX:      ds.positionX,
      positionY:      ds.positionY,
    },
    messages,
    colorSlots:        config.colorSlots,
    timerDisplaySlots: config.timerDisplaySlots,
    msgDisplaySlots:   config.msgDisplaySlots,
    parentContext,
    displayFocus,
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
        if (backgroundParent) backgroundParent.running = true;
        startTick();
      }
      break;

    case "pause":
      timerState.running = false;
      if (backgroundParent) backgroundParent.running = false;
      stopTick();
      break;

    case "stop":
      // Stop zeroes both timers and clears flash state.
      // Does not reset targetMs — Reset still returns to the set time.
      timerState.running    = false;
      timerState.endReached = false;
      timerState.currentMs  = 0;
      if (backgroundParent) {
        backgroundParent.running   = false;
        backgroundParent.currentMs = 0;
      }
      stopTick();
      break;

    case "reset":
      // In session context: re-apply parent preset from scratch (full session restart).
      if (backgroundParent) {
        const parentPreset = presets.find(p => p.id === backgroundParent.id);
        if (parentPreset) applyPreset(parentPreset, false);
        break;
      }
      // Standalone timer: return to set time.
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
      if (["hold", "flash", "load", "start"].includes(payload.behavior)) {
        timerState.endBehavior = payload.behavior;
        // If the timer already ended, apply the new behavior immediately
        if (timerState.endReached) {
          if (payload.behavior === "hold") {
            timerState.running = false;
            if (backgroundParent) backgroundParent.running = false;
            stopTick();
          } else if (payload.behavior === "flash") {
            timerState.running = true;
            if (backgroundParent) backgroundParent.running = true;
            startTick();
          }
          // "load" and "start" have no retroactive effect once the timer has ended
        }
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

    case "adjustParent": {
      if (!backgroundParent || typeof payload.deltaMs !== "number") break;
      backgroundParent.currentMs  = Math.max(0, backgroundParent.currentMs + payload.deltaMs);
      backgroundParent.endReached = backgroundParent.currentMs === 0;
      break;
    }

    case "adjustBoth": {
      if (typeof payload.deltaMs !== "number") break;
      // Adjust child
      if (timerState.mode !== "clock" && timerState.mode !== "external") {
        timerState.currentMs  = Math.max(0, timerState.currentMs + payload.deltaMs);
        timerState.endReached = false;
        if (timerState.mode === "countdown" && timerState.currentMs === 0 && timerState.running) {
          handleCountdownEnd();
        }
      }
      // Adjust parent
      if (backgroundParent) {
        backgroundParent.currentMs  = Math.max(0, backgroundParent.currentMs + payload.deltaMs);
        backgroundParent.endReached = backgroundParent.currentMs === 0;
      }
      break;
    }

    case "setDisplayFocus": {
      if (["foreground", "parent"].includes(payload.focus)) {
        displayFocus = payload.focus;
      }
      break;
    }

    case "setMessage": {
      const slotIdx = Math.max(0, Math.min(3, (payload.msgDisplaySlot || 1) - 1));
      timerState.messages[slotIdx] = {
        text:      (payload.text || "").slice(0, 200),
        colorSlot: payload.colorSlot || 1,
      };
      break;
    }

    case "fireNextChild": {
      if (!backgroundParent) break;
      const parentPreset = presets.find(p => p.id === backgroundParent.id);
      if (!parentPreset || !Array.isArray(parentPreset.children)) break;
      const childIds  = parentPreset.children;
      const curIdx    = childIds.indexOf(timerState.activePresetId);
      if (curIdx < 0 || curIdx >= childIds.length - 1) break;
      const nextChild = presets.find(p => p.id === childIds[curIdx + 1]);
      if (nextChild) {
        fireChild(nextChild);
        timerState.running    = true;
        backgroundParent.running = true;
        startTick();
      }
      break;
    }

    case "exitChildContext": {
      if (!backgroundParent) break;
      const exitParentId     = backgroundParent.id;
      const exitParentPreset = presets.find(p => p.id === exitParentId);
      backgroundParent = null;
      displayFocus     = "foreground";
      hardStopTick();
      // Restore parent as the foreground timer (stopped at full time)
      if (exitParentPreset) {
        timerState.mode           = exitParentPreset.mode || "countdown";
        timerState.targetMs       = exitParentPreset.targetMs;
        timerState.currentMs      = exitParentPreset.targetMs;
        timerState.endBehavior    = exitParentPreset.endBehavior;
        timerState.endReached     = false;
        timerState.running        = false;
        timerState.activePresetId = exitParentPreset.id;
        timerState.activeColorSlot   = exitParentPreset.colorSlot   ?? 1;
        timerState.activeDisplaySlot = exitParentPreset.displaySlot  ?? 1;
        const tl  = presets.filter(p => !p.parentId);
        const idx = tl.findIndex(p => p.id === exitParentPreset.id);
        timerState.nextPresetId = (idx !== -1 && idx < tl.length - 1) ? tl[idx + 1].id : null;
      } else {
        timerState.activePresetId = null;
      }
      break;
    }
  }
}

function handlePreset(action, preset = {}) {
  switch (action) {
    case "save": {
      const id  = preset.id || `preset_${Date.now()}`;
      const idx = presets.findIndex(p => p.id === id);
      const entry = {
        id,
        name:                preset.name               || "Untitled",
        mode:                preset.mode               || timerState.mode,
        targetMs:            preset.targetMs            ?? timerState.targetMs,
        endBehavior:         preset.endBehavior         || timerState.endBehavior,
        colorSlot:           preset.colorSlot           ?? 1,
        displaySlot:         preset.displaySlot         ?? 1,
        children:            preset.children            || [],
        parentId:            preset.parentId            ?? null,
        useParentRemaining:  preset.useParentRemaining  ?? false,
        defaultDisplayFocus: preset.defaultDisplayFocus ?? "foreground",
      };
      if (idx >= 0) presets[idx] = entry; else presets.push(entry);
      // If saving a child, auto-link into parent's children array
      if (entry.parentId) {
        const parentIdx = presets.findIndex(p => p.id === entry.parentId);
        if (parentIdx !== -1) {
          if (!Array.isArray(presets[parentIdx].children)) presets[parentIdx].children = [];
          if (!presets[parentIdx].children.includes(id)) presets[parentIdx].children.push(id);
        }
      }
      savePresetsFile(presets);
      break;
    }
    case "overwrite": {
      const idx = presets.findIndex(p => p.id === preset.id);
      if (idx === -1) break;
      presets[idx] = {
        ...presets[idx],
        mode:         timerState.mode,
        targetMs:     timerState.targetMs,
        endBehavior:  timerState.endBehavior,
        colorSlot:    timerState.activeColorSlot,
        displaySlot:  timerState.activeDisplaySlot,
      };
      savePresetsFile(presets);
      break;
    }
    case "rename": {
      const idx = presets.findIndex(p => p.id === preset.id);
      if (idx === -1) break;
      presets[idx] = { ...presets[idx], name: preset.name || "Untitled" };
      savePresetsFile(presets);
      break;
    }
    case "reorder": {
      // preset.ids is the new ordered array of preset IDs
      if (!Array.isArray(preset.ids)) break;
      const reordered = preset.ids
        .map(id => presets.find(p => p.id === id))
        .filter(Boolean);
      // Append any presets not included in the reorder (safety net)
      presets.forEach(p => { if (!reordered.find(r => r.id === p.id)) reordered.push(p); });
      presets = reordered;
      // Re-compute nextPresetId from top-level order
      if (timerState.activePresetId && !backgroundParent) {
        const tl  = presets.filter(p => !p.parentId);
        const idx = tl.findIndex(p => p.id === timerState.activePresetId);
        timerState.nextPresetId = (idx !== -1 && idx < tl.length - 1) ? tl[idx + 1].id : null;
      }
      savePresetsFile(presets);
      break;
    }
    case "setActive": {
      // Move the on-deck pointer without loading the preset
      timerState.nextPresetId = preset.id || null;
      break;
    }
    case "load": {
      const found = presets.find(p => p.id === preset.id);
      if (!found) break;
      if (found.parentId) {
        // Child preset — set up parent context if needed, then fire child
        const parent = presets.find(p => p.id === found.parentId);
        if (parent) {
          if (!backgroundParent || backgroundParent.id !== found.parentId) {
            hardStopTick();
            backgroundParent = {
              id:         parent.id,
              currentMs:  parent.targetMs,
              targetMs:   parent.targetMs,
              endReached: false,
              running:    false,
            };
            displayFocus = parent.defaultDisplayFocus || "foreground";
          }
          fireChild(found);
        }
      } else {
        applyPreset(found, false);
      }
      break;
    }
    case "delete": {
      const toDelete = presets.find(p => p.id === preset.id);
      if (toDelete) {
        // Orphan children if deleting a parent
        (toDelete.children || []).forEach(childId => {
          const child = presets.find(p => p.id === childId);
          if (child) child.parentId = null;
        });
        // Remove from parent's children array if deleting a child
        if (toDelete.parentId) {
          const parent = presets.find(p => p.id === toDelete.parentId);
          if (parent) parent.children = (parent.children || []).filter(id => id !== preset.id);
        }
        // Exit nested context if active parent or child is deleted
        if (backgroundParent && (backgroundParent.id === preset.id || timerState.activePresetId === preset.id)) {
          backgroundParent = null;
          hardStopTick();
        }
      }
      if (timerState.activePresetId === preset.id) timerState.activePresetId = null;
      if (timerState.nextPresetId   === preset.id) timerState.nextPresetId   = null;
      presets = presets.filter(p => p.id !== preset.id);
      savePresetsFile(presets);
      break;
    }

    case "update": {
      const idx = presets.findIndex(p => p.id === preset.id);
      if (idx === -1) break;
      const isActive = timerState.activePresetId === preset.id;

      if (preset.name !== undefined)
        presets[idx].name = preset.name || "Untitled";

      if (preset.mode !== undefined && !timerState.running)
        presets[idx].mode = preset.mode;

      if (preset.endBehavior !== undefined) {
        presets[idx].endBehavior = preset.endBehavior;
        if (isActive) timerState.endBehavior = preset.endBehavior;
      }

      if (preset.targetMs !== undefined) {
        const oldTarget  = presets[idx].targetMs;
        const newTarget  = preset.targetMs;
        presets[idx].targetMs = newTarget;
        if (isActive) {
          timerState.targetMs = newTarget;
          // Preserve elapsed time: remaining = new target − elapsed
          const elapsed = oldTarget - timerState.currentMs;
          timerState.currentMs = Math.max(0, newTarget - elapsed);
        }
      }

      if (preset.colorSlot !== undefined) {
        presets[idx].colorSlot = preset.colorSlot ?? 1;
        if (isActive) timerState.activeColorSlot = preset.colorSlot ?? 1;
      }

      if (preset.displaySlot !== undefined) {
        presets[idx].displaySlot = preset.displaySlot ?? 1;
        if (isActive) timerState.activeDisplaySlot = preset.displaySlot ?? 1;
      }

      if (preset.useParentRemaining !== undefined) {
        presets[idx].useParentRemaining = !!preset.useParentRemaining;
      }

      if (preset.defaultDisplayFocus !== undefined &&
          ["foreground", "parent"].includes(preset.defaultDisplayFocus)) {
        presets[idx].defaultDisplayFocus = preset.defaultDisplayFocus;
      }

      savePresetsFile(presets);
      break;
    }

    case "addChild": {
      // preset.parentId = parent, preset.childId = child to adopt
      const parentIdx = presets.findIndex(p => p.id === preset.parentId);
      const childIdx  = presets.findIndex(p => p.id === preset.childId);
      if (parentIdx === -1 || childIdx === -1) break;
      if (!Array.isArray(presets[parentIdx].children)) presets[parentIdx].children = [];
      if (!presets[parentIdx].children.includes(preset.childId)) {
        presets[parentIdx].children.push(preset.childId);
      }
      presets[childIdx].parentId = preset.parentId;
      savePresetsFile(presets);
      break;
    }

    case "removeChild": {
      const parentIdx = presets.findIndex(p => p.id === preset.parentId);
      const childIdx  = presets.findIndex(p => p.id === preset.childId);
      if (parentIdx !== -1) {
        presets[parentIdx].children = (presets[parentIdx].children || []).filter(id => id !== preset.childId);
      }
      if (childIdx !== -1) presets[childIdx].parentId = null;
      savePresetsFile(presets);
      break;
    }
  }
}

function applyPreset(preset, autoStart = false) {
  // Parent preset with children → enter nested context
  if (Array.isArray(preset.children) && preset.children.length > 0) {
    // Always reset the session (covers both fresh load and session reset)
    hardStopTick();
    backgroundParent = {
      id:         preset.id,
      currentMs:  preset.targetMs,
      targetMs:   preset.targetMs,
      endReached: false,
      running:    false,
    };
    displayFocus = preset.defaultDisplayFocus || "foreground";
    const firstChild = presets.find(p => p.id === preset.children[0]);
    if (firstChild) {
      fireChild(firstChild);
      if (autoStart) {
        timerState.running    = true;
        backgroundParent.running = true;
        startTick();
      }
    }
    return;
  }

  // Normal single-timer load — exit any existing nested context
  backgroundParent = null;
  displayFocus = "foreground";
  hardStopTick();
  timerState.mode           = preset.mode;
  timerState.targetMs       = preset.targetMs;
  timerState.currentMs      = preset.mode === "countup" ? 0
                            : preset.mode === "clock"   ? timeOfDayMs()
                            : preset.targetMs;
  timerState.endBehavior       = preset.endBehavior;
  timerState.endReached        = false;
  timerState.activePresetId    = preset.id;
  timerState.activeColorSlot   = preset.colorSlot   ?? 1;
  timerState.activeDisplaySlot = preset.displaySlot  ?? 1;
  const topLevel = presets.filter(p => !p.parentId);
  const idx      = topLevel.findIndex(p => p.id === preset.id);
  timerState.nextPresetId   = (idx !== -1 && idx < topLevel.length - 1)
                            ? topLevel[idx + 1].id : null;
  if (autoStart || preset.mode === "clock") {
    timerState.running = true;
    startTick();
  } else {
    timerState.running = false;
  }
}

function handleConfig(updates) {
  if (typeof updates.colorSlot === "number" && updates.data && typeof updates.data === "object") {
    const idx = updates.colorSlot - 1;
    if (idx >= 0 && idx < 4) {
      config.colorSlots[idx] = { ...config.colorSlots[idx], ...updates.data };
      saveConfig(config);
    }
  }

  if (typeof updates.timerDisplaySlot === "number" && updates.data && typeof updates.data === "object") {
    const idx = updates.timerDisplaySlot - 1;
    if (idx >= 0 && idx < 4) {
      const d = { ...updates.data };
      if (Array.isArray(d.visibleDigits) && d.visibleDigits.length === 6)
        d.visibleDigits = d.visibleDigits.map(Boolean);
      if (Array.isArray(d.colorTriggers))
        d.colorTriggers = d.colorTriggers
          .filter(t => typeof t.atMs === "number" && t.textColor && t.bgColor)
          .sort((a, b) => b.atMs - a.atMs);
      config.timerDisplaySlots[idx] = { ...config.timerDisplaySlots[idx], ...d };
      saveConfig(config);
    }
  }

  if (typeof updates.msgDisplaySlot === "number" && updates.data && typeof updates.data === "object") {
    const idx = updates.msgDisplaySlot - 1;
    if (idx >= 0 && idx < 4) {
      config.msgDisplaySlots[idx] = { ...config.msgDisplaySlots[idx], ...updates.data };
      saveConfig(config);
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

// ─── Update Token ─────────────────────────────────────────────────────────────
// Stored outside the repo so it survives git pulls and is never committed.
// Remove this file once the repo is public — HTTPS works without auth.

const UPDATE_TOKEN_FILE = "/etc/eventstimer-update.token";
let updateToken = null;
try {
  if (fs.existsSync(UPDATE_TOKEN_FILE))
    updateToken = fs.readFileSync(UPDATE_TOKEN_FILE, "utf8").trim() || null;
} catch (e) { console.warn("Could not read update token:", e.message); }

// Build an authenticated remote URL by injecting the token into the HTTPS URL.
// Falls back to the plain remote URL (works once repo is public).
function getAuthRemote() {
  try {
    const url = execSync("git remote get-url origin", { cwd: __dirname }).toString().trim();
    if (updateToken && url.startsWith("https://"))
      return url.replace("https://", `https://x-access-token:${updateToken}@`);
    return url;
  } catch (e) { return "origin"; }
}

// ─── HTTP + API Server ────────────────────────────────────────────────────────

const MIME = {
  ".html": "text/html",
  ".js":   "application/javascript",
  ".css":  "text/css",
  ".json": "application/json",
  ".ico":  "image/x-icon",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
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

  // GET /api/update/check — fetch remote, compare versions
  if (req.method === "GET" && req.url === "/api/update/check") {
    const remote = getAuthRemote();
    exec(`git fetch ${remote}`, { cwd: __dirname }, (err) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "git fetch failed — check network or token" }));
        return;
      }
      exec("git show FETCH_HEAD:package.json", { cwd: __dirname }, (err2, stdout) => {
        if (err2) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Could not read remote version" }));
          return;
        }
        let latestVersion;
        try { latestVersion = JSON.parse(stdout).version; }
        catch {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Could not parse remote package.json" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          currentVersion: TIMER_VERSION,
          latestVersion,
          updateAvailable: latestVersion !== TIMER_VERSION,
        }));
      });
    });
    return true;
  }

  // POST /api/update/apply — pull latest, reinstall deps, restart
  if (req.method === "POST" && req.url === "/api/update/apply") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    const remote = getAuthRemote();
    exec(`git pull ${remote} main && npm install --omit=dev`, { cwd: __dirname }, (err, _stdout, stderr) => {
      if (err) { console.error("Update failed:", err.message, stderr); return; }
      console.log("Update complete — restarting…");
      setTimeout(() => process.exit(0), 500);
    });
    return true;
  }

  // POST /api/display/launch — open Chromium in kiosk mode on the Pi's desktop
  if (req.method === "POST" && req.url === "/api/display/launch") {
    const script = path.join(__dirname, "start-display.sh");
    exec(`bash "${script}"`, (err) => {
      if (err) console.warn("Display launch error:", err.message);
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  // POST /api/system/restart — restart the Node service (eventstimer)
  if (req.method === "POST" && req.url === "/api/system/restart") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    setTimeout(() => exec("systemctl restart eventstimer"), 300);
    return true;
  }

  // POST /api/system/reboot — full Pi reboot
  if (req.method === "POST" && req.url === "/api/system/reboot") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    setTimeout(() => exec("sudo reboot"), 300);
    return true;
  }

  // POST /api/system/shutdown — clean Pi shutdown
  if (req.method === "POST" && req.url === "/api/system/shutdown") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    setTimeout(() => exec("sudo shutdown -h now"), 300);
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
  console.log(`\nCountdown Timer v${TIMER_VERSION}`);
  console.log(`  HTTP/WS:      port ${config.httpPort}`);
  console.log(`  Display:      http://localhost:${config.httpPort}/display`);
  console.log(`  Control:      http://localhost:${config.httpPort}/control`);
  console.log(`  Admin:        http://localhost:${config.httpPort}/admin`);
});

restoreBridges();
applyAvahiHostname(config.hostname);
