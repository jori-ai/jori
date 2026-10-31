// tools-mcp/modules/home.mjs — the home's devices through the homectl contract
// (lights, shades, lock, TV, and a pass-through for anything else homectl drives).
// Served by agent/tools-mcp/index.mjs (loadExtTools); `after` keeps the tools
// at their place in the served tool list.
//
// The contract: `homectl <cmd…> <action> [args]`, where <cmd…> is the
// installation's homectl subcommand for each kind (`commands` in the config;
// the default is the kind's own name):
//   lights  on|off [room], brightness <0-100> [room], status
//   shades  open|close
//   lock    status|lock|unlock
//   tv      on|off
// plus a pass-through for any other command the installation's homectl
// implements. This module only shells out to it; homectl holds the vendor
// logins and device ids.
//
// The installation binds its homectl at bin/homectl (HOMECTL_BIN, or
// `homectl_bin` in agent/local/config/home-devices.json, override it), and
// lists its light rooms in that file's `rooms` and its per-kind subcommands in
// `commands` ({"lights": ["<vendor>"], "shades": ["<vendor>", "shade"], …}). With no homectl bound the tools
// stay listed but every call answers "no home devices configured": the
// capability is off, not broken.
import * as fsSync from "node:fs";
import * as os from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { localConfig } = require("../../../lib/instance.cjs");
const { installTools } = require("../../../lib/root.cjs");

export const NOT_CONFIGURED = "No home devices configured (bind homectl at bin/homectl and list the devices in agent/local/config/home-devices.json).";

const expandHome = (p) => (typeof p === "string" && p.startsWith("~/") ? os.homedir() + p.slice(1) : p);

// The homectl CLI to call, or null when this installation has none.
export function homectlBin(cfg = localConfig("home-devices", {})) {
  const candidates = [process.env.HOMECTL_BIN, ...[].concat(cfg.homectl_bin || []), installTools("bin", "homectl")];
  for (const c of candidates.map(expandHome)) {
    if (!c) continue;
    try { if (fsSync.existsSync(c)) return c; } catch { /* next */ }
  }
  return null;
}

export const after = "resy_list";

const DEFAULT_COMMANDS = { lights: ["lights"], shades: ["shades"], lock: ["lock"], tv: ["tv"] };

export function tools({ run }) {
  const cfg = localConfig("home-devices", { rooms: [], commands: {} });
  const HOMECTL = homectlBin(cfg);
  const call = (args) => (HOMECTL ? run(HOMECTL, args) : Promise.resolve(NOT_CONFIGURED));
  const commands = { ...DEFAULT_COMMANDS, ...(cfg.commands && typeof cfg.commands === "object" ? cfg.commands : {}) };
  const kind = (k, ...rest) => call([...[].concat(commands[k]), ...rest]);
  const rooms = Array.isArray(cfg.rooms) ? cfg.rooms.filter((r) => typeof r === "string" && r) : [];
  const room = rooms.length ? { type: "string", enum: rooms } : { type: "string", description: "A light room or group name homectl knows" };
  const withRoom = (a) => (a.room ? [a.room] : []);

  return [
    // ── Lights ──
    {
      name: "lights_on",
      description: "Turn on lights. Omit room to turn on ALL lights.",
      schema: { type: "object", properties: { room } },
      run: (a) => kind("lights", "on", ...withRoom(a)),
    },
    {
      name: "lights_off",
      description: "Turn off lights. Omit room to turn off ALL lights.",
      schema: { type: "object", properties: { room } },
      run: (a) => kind("lights", "off", ...withRoom(a)),
    },
    {
      name: "lights_brightness",
      description: "Set light brightness. Omit room for ALL lights.",
      schema: { type: "object", properties: { level: { type: "number", minimum: 0, maximum: 100 }, room }, required: ["level"] },
      run: (a) => kind("lights", "brightness", String(a.level), ...withRoom(a)),
    },
    {
      name: "lights_status",
      description: "Check which light switches are online or offline",
      schema: { type: "object", properties: {} },
      run: () => kind("lights", "status"),
    },

    // ── Shades ──
    {
      name: "shades_open",
      description: "Open window shades",
      schema: { type: "object", properties: {} },
      run: () => kind("shades", "open"),
    },
    {
      name: "shades_close",
      description: "Close window shades",
      schema: { type: "object", properties: {} },
      run: () => kind("shades", "close"),
    },

    // ── Lock ──
    {
      name: "lock_status",
      description: "Check front door lock status (locked/unlocked)",
      schema: { type: "object", properties: {} },
      run: () => kind("lock", "status"),
    },
    {
      name: "lock_lock",
      description: "Lock the front door",
      schema: { type: "object", properties: {} },
      run: () => kind("lock", "lock"),
    },
    {
      name: "lock_unlock",
      description: "Unlock the front door",
      schema: { type: "object", properties: {} },
      run: () => kind("lock", "unlock"),
    },

    // ── TV ──
    {
      name: "tv_on",
      description: "Turn on the TV",
      schema: { type: "object", properties: {} },
      run: () => kind("tv", "on"),
    },
    {
      name: "tv_off",
      description: "Turn off the TV",
      schema: { type: "object", properties: {} },
      run: () => kind("tv", "off"),
    },

    // ── Home (general) ──
    {
      name: "homectl",
      description: "Generic home control for advanced commands not covered by specific tools. Pass the full homectl CLI command.",
      schema: { type: "object", properties: { command: { type: "string", description: "Full command e.g. 'bond fan on', 'spa heat on', 'ring snapshot front'" } }, required: ["command"] },
      run: (a) => call(String(a.command || "").split(" ").filter(Boolean)),
    },
  ];
}
