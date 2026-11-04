// control/state.mjs — what the control room shows, read live on the host.
//
// One `snapshot()` feeds every page except a feature's full settings file,
// which `configFile(name)` returns when that file is opened. Each part is
// read independently; a part that fails comes back as { error } so one
// broken source never blanks the whole room.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { allJobs, recentRuns } from "./schedule.mjs";
import { history } from "./audit.mjs";

const require = createRequire(import.meta.url);
const { TOOLS_DIR, installTools } = require("../root.cjs");
const inst = require("../instance.cjs");
const ports = require("../ports.cjs");
const { loadRegistryList } = require("../registry.cjs");
const { parseModelsEnv, MODELS_ENV } = require("../models.cjs");

export const CONFIG_NAME = /^[a-z0-9][a-z0-9-]*$/; // lang-regex-ok: file-name syntax

const readJson = (f, d = null) => {
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; }
};
const part = (fn) => {
  try { return fn(); } catch (e) { return { error: e.message }; }
};

async function health(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const ct = res.headers.get("content-type") || "";
    return { ok: true, ...(ct.includes("json") ? await res.json() : {}) };
  } catch (e) {
    return { ok: false, error: e.name === "TimeoutError" ? "no answer" : e.message };
  }
}

function schedule() {
  const { jobs, cronError } = allJobs();
  const runs = recentRuns();
  const routing = part(() => loadRegistryList("job-routing")) || {};
  const brake = inst.localConfig("allowance-brake", { jobs: {} });
  for (const j of jobs) {
    const r = runs[j.label] || runs[j.name] || runs[`trigger-${j.name}`];
    if (r) j.runs = r;
    const route = routing[j.name] || routing[j.name.replace(/^trigger-/, "")];
    if (route) j.route = { target: route.target, model: route.model, effort: route.effort, disposition: route.disposition };
    const b = brake.jobs?.[j.name];
    if (b) j.importance = b.importance;
  }
  return { jobs, cronError };
}

function watches() {
  const out = execFileSync(process.execPath, [path.join(TOOLS_DIR, "bin", "watch"), "list", "--all", "--json"], { encoding: "utf8", timeout: 20_000 });
  const list = JSON.parse(out || "[]");
  return (Array.isArray(list) ? list : list.watches || []).map((w) => ({
    id: w.id, title: w.title, status: w.status, kind: w.trigger_kind, when: w.fire_local_time || null, condition: w.condition || null,
  }));
}

async function agents() {
  const cfg = readJson(path.join(TOOLS_DIR, "agent", "config", "agents.json"), { agents: {} }).agents || {};
  const healthPort = { chat: "chat_health", ops: "ops_health", "ops-light": "ops_light_health", "ops-haiku": "ops_haiku_health" };
  const rows = await Promise.all(Object.entries(cfg).map(async ([name, a]) => {
    const pn = healthPort[name];
    const h = pn ? await health(ports.localUrl(pn, "/health")) : { ok: false, error: "no health port" };
    return {
      name, model: a.model, fallbackModel: a.fallbackModel, maxSessionTurns: a.maxSessionTurns,
      health: h.ok ? {
        ok: true, model: h.model, turns: h.totalTurns, contextTokens: h.contextTokens, costUsd: h.totalCostUsd, queueDepth: h.queueDepth,
        childAlive: h.childAlive, lastEventTs: h.lastEventTs, maxSessionTurns: h.maxSessionTurns, restartCount: h.restartCount,
      } : h,
    };
  }));
  const pins = part(() => {
    const env = parseModelsEnv(fs.readFileSync(MODELS_ENV, "utf8"));
    return Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith("JORI_MODEL_")));
  });
  return { agents: rows, pins };
}

async function channels() {
  const probes = [
    ["WhatsApp", "whatsapp", "/health", ["whatsapp-send"]],
    ["iMessage", "imessage", "/health", ["send-intents"]],
    ["Slack", "slack", "/health", ["slack-channel", "slack-inbox"]],
  ];
  const rows = await Promise.all(probes.map(async ([name, pn, p, config]) => {
    const h = await health(ports.localUrl(pn, p));
    return { name, port: ports.port(pn), up: h.ok, error: h.ok ? null : h.error, config };
  }));
  const chat = await health(ports.localUrl("chat_health", "/health"));
  rows.push({ name: "Phone app", up: chat.ok && chat.phoneChannelHeartbeatAgeMs != null && chat.phoneChannelHeartbeatAgeMs < 5 * 60_000, detail: chat.ok ? `heartbeat ${Math.round((chat.phoneChannelHeartbeatAgeMs || 0) / 1000)} s ago` : null, config: ["apns", "companion-names"] });
  rows.push({ name: "Email", up: null, detail: `sends as ${inst.instanceValue("agent_email") || "(not set)"}`, config: ["email-inbound", "draft-gate", "outbound-precheck"] });
  rows.push({ name: "Text messages", up: null, config: ["sms-send"] });
  return { channels: rows, quietHours: inst.localConfig("quiet-hours", { awake_from: 8, awake_to: 22 }) };
}

function configs() {
  const dir = path.join(inst.localDir(), "config");
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => {
    const name = f.slice(0, -5);
    const j = readJson(path.join(dir, f), null);
    if (!j) return { name, error: "does not parse" };
    const about = typeof j._comment === "string" ? j._comment : Array.isArray(j._comment) ? j._comment.join(" ") : "";
    return { name, about: about.slice(0, 400), keys: Object.keys(j).filter((k) => !k.startsWith("_")).length };
  });
}

export function configFile(name) {
  if (!CONFIG_NAME.test(name)) throw new Error("bad settings name");
  const file = path.join(inst.localDir(), "config", `${name}.json`);
  return { name, file: path.relative(TOOLS_DIR, file), text: fs.readFileSync(file, "utf8") };
}

function identity() {
  const file = readJson(path.join(inst.localDir(), "instance.json"), {});
  const resolved = inst.instance();
  return {
    keys: Object.keys(inst.INSTANCE_KEYS),
    file: Object.fromEntries(Object.entries(file).filter(([k]) => !k.startsWith("_"))),
    resolved,
    envOverrides: Object.entries(inst.INSTANCE_KEYS).filter(([, e]) => process.env[e]).map(([k]) => k),
    aliases: inst.assistantAliases(),
    agentAddresses: inst.agentAddresses(),
  };
}

function envKeyNames() {
  try {
    return fs.readFileSync(installTools(".env"), "utf8").split("\n")
      .map((l) => l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)) // lang-regex-ok: .env syntax
      .filter((m) => m && m[2].replace(/^["']|["']$/g, "").length > 0)
      .map((m) => m[1]);
  } catch {
    return [];
  }
}

function services() {
  const base = readJson(path.join(TOOLS_DIR, "system", "service-catalog.json"), { services: [] });
  const cat = inst.localConfig("service-catalog", { services: base.services }).services;
  const keys = envKeyNames();
  const claimed = new Set();
  const rows = cat.map((s) => {
    const mine = keys.filter((k) => (s.env || []).some((p) => k.startsWith(p)));
    mine.forEach((k) => claimed.add(k));
    return { ...s, keys: mine };
  });
  const other = keys.filter((k) => !claimed.has(k));
  return { services: rows, unclaimed: other };
}

function machine() {
  const r = inst.instance();
  return {
    host: r.host, host_label: r.host_label, host_title: r.host_title,
    install: installTools(),
    ports: ports.table(),
    processes: part(() => loadRegistryList("services").map((s) => ({ name: s.name, type: s.type, label: s.label, does: String(s.description || "").split(/(?<=\.)\s/)[0].slice(0, 200), expected: s.expected_running }))),
  };
}

function hardcoded() {
  return readJson(installTools("data", "control-hardcoded.json"), { scannedAt: null, findings: [] });
}

function budget() {
  return { brake: inst.localConfig("allowance-brake", {}) };
}

export async function snapshot() {
  const [ag, ch] = await Promise.all([agents().catch((e) => ({ error: e.message })), channels().catch((e) => ({ error: e.message }))]);
  return {
    at: new Date().toISOString(),
    tz: inst.instanceValue("tz"),
    assistant: inst.assistantName(),
    owner: inst.instanceValue("owner_name"),
    host: inst.instanceValue("host_title"),
    areas: inst.localConfig("control", { areas: null }).areas,
    schedule: part(schedule),
    watches: part(watches),
    agents: ag,
    channels: ch,
    budget: part(budget),
    configs: part(configs),
    identity: part(identity),
    services: part(services),
    machine: part(machine),
    hardcoded: part(hardcoded),
    history: part(() => history(200)),
  };
}
