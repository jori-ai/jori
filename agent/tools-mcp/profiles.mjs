// profiles.mjs — which of tools-mcp's tools a session gets (JORI_TOOL_PROFILE).
//
// Profiles live in agent/config/tool-profiles.json (kernel) and an
// installation's agent/local/config/tool-profiles.json. The server filters
// both ListTools (what the model sees) and CallTool (what it can run), so a
// denied tool is gone from the context and cannot be called by name. The
// homectl passthrough can be held to read-only commands (status, list,
// snapshot, help, …) or switched off. Not a security boundary while the agent
// has Bash; see docs/agent-secrets.md § Tool profiles.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const KERNEL_FILE = path.join(HERE, "..", "config", "tool-profiles.json");

// homectl words that change something in the home. A command with none of
// these is read-only (status, list, scan, snapshot, help, network status, …).
const HOMECTL_ACTIONS = new Set(["on", "off", "set", "unlock", "lock", "open", "close", "enter",
  "mode", "print", "volume", "mute", "power", "source", "brightness", "shade", "play", "pause",
  "next", "previous", "skip", "start", "stop", "toggle", "arm", "disarm", "reboot", "restart", "delete", "add", "remove"]);

const globRe = (g) => new RegExp("^" + g.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$"); // lang-regex-ok: tool-name glob to regex
const matches = (name, globs) => (globs || []).some((g) => globRe(g).test(name));

export function loadProfiles({ kernelFile = KERNEL_FILE, localDir } = {}) {
  let kernel = {};
  try { kernel = JSON.parse(fs.readFileSync(kernelFile, "utf8")).profiles || {}; } catch {}
  let local = {};
  try {
    const dir = localDir || require("../../lib/instance.cjs").localDir();
    local = JSON.parse(fs.readFileSync(path.join(dir, "config", "tool-profiles.json"), "utf8")).profiles || {};
  } catch {}
  return { ...kernel, ...local };
}

/** { name, profile, warning? } for the env's JORI_TOOL_PROFILE. */
export function resolveProfile(envValue, profiles = loadProfiles()) {
  const name = String(envValue || "").trim();
  if (!name) return { name: "full", profile: {}, warning: "JORI_TOOL_PROFILE is not set: serving every tool (full)" };
  if (!profiles[name]) return { name: "full", profile: {}, warning: `unknown JORI_TOOL_PROFILE "${name}": serving every tool (full)` };
  return { name, profile: profiles[name] };
}

/** Whether the profile serves a tool of this name. */
export function allowsTool(profile, name) {
  if (profile.allow && !matches(name, profile.allow)) return false;
  if (matches(name, profile.deny)) return false;
  if (name === "homectl" && profile.homectl === "off") return false;
  return true;
}

/** null when the call may run; otherwise the refusal text. */
export function callRefusal(profileName, profile, name, args = {}) {
  if (!allowsTool(profile, name)) return `The "${name}" tool is not available to this session (tool profile "${profileName}").`;
  if (name === "homectl" && profile.homectl === "read-only") {
    const words = String(args.command || "").toLowerCase().split(/\s+/).filter(Boolean); // lang-regex-ok: splitting a CLI command string into argv words
    const act = words.find((w) => HOMECTL_ACTIONS.has(w));
    if (act) return `homectl is read-only in this session (tool profile "${profileName}"): "${act}" changes something in the home. Ask the user, or hand it to the chat agent.`;
  }
  return null;
}

// Self-wakes and forks are drained only by the chat supervisor (its fork and
// check-later ticks, keyed to the agent id "chat"). A session with any other id,
// or none, would file them where nothing fires them or where their answer goes
// to the chat agent instead of back to the asker, so they are not offered there.
export const LOOP_TOOLS = new Set(["check_later", "delegate", "delegate_status"]);
export function servesLoopTools(agentId) { return agentId === "chat"; }
