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
import { jevState } from "./jev.mjs";
import { setupChecks, jobFailureIncidents } from "./setup.mjs";
import { missingRequirements, planCrontab } from "../plugin-manager.mjs";

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

// Feature plugins (system/plugins.md): each with its settings and its
// problems, and the scheduled jobs no plugin owns yet.
//
// Settings: the manifest's `config.name` and `settings` list, then by name —
// a settings file named after the plugin, or after one of its jobs, schedules
// or files. Problems: manifest errors, missing requirements, failing
// schedules (run log + open incidents), launchd agents not loaded, schedules
// out of step with the crontab (the sync plan, read only), settings files that
// do not parse.
const stem = (x) => path.basename(String(x)).replace(/\.(sh|mjs|cjs|js|py|md|json|plist)$/, "").replace(/^trigger-/, "").replace(/^(ai\.claude|com\.jori|ai\.jori|com\.[a-z]+)\./, "");

function pluginsState(snap = {}) {
  const P = require("../plugins.cjs");
  const all = P.plugins();
  const jobs = snap.schedule?.jobs || [];
  const configs = Array.isArray(snap.configs) ? snap.configs : [];
  const incidents = snap.jobFailures && !snap.jobFailures.error ? snap.jobFailures : {};

  // Settings ownership: explicit first, then the plugin's own name, then its parts.
  const cfgOwner = new Map();
  const claim = (cfg, plugin, rank) => {
    const cur = cfgOwner.get(cfg);
    if (!cur || rank < cur.rank) cfgOwner.set(cfg, { plugin, rank });
  };
  const cfgNames = new Set(configs.map((c) => c.name));
  for (const p of all) {
    const m = p.manifest;
    for (const c of [m.config?.name, ...(m.settings || [])].filter(Boolean)) claim(c, p.name, 0);
    if (cfgNames.has(p.name)) claim(p.name, p.name, 1);
    const parts = new Set([...P.schedulesOf(p).map((x) => stem(x.label)), ...(m.launchd || []).map((l) => stem(l.label)), ...Object.keys(m.jobs || {}), ...(m.adopted_jobs || []), ...(m.files || []).map(stem)]);
    for (const n of parts) if (cfgNames.has(n)) claim(n, p.name, 2);
    for (const c of cfgNames) if (c.startsWith(`${p.name}-`)) claim(c, p.name, 3);
  }

  // Whatever no feature claims is the core's (agents, channels, outbound checks…).
  const core = all.find((p) => p.manifest.core);
  if (core) for (const c of cfgNames) if (!cfgOwner.has(c)) claim(c, core.name, 9);

  // Schedules out of step with the crontab (read only).
  let plan = [];
  try { plan = planCrontab(); } catch (e) { plan = [{ op: "unreadable", problem: e.message }]; }

  const list = all.map((p) => {
    const m = p.manifest;
    const enabled = P.isEnabled(p.name, all);
    let missing = [];
    try { missing = missingRequirements(p, { all }); } catch {}
    const schedules = P.schedulesOf(p).map((x) => ({ label: x.label, cron: x.cron, paused: x.paused || null }));
    const labels = new Set([...schedules.map((x) => x.label), ...(m.launchd || []).map((l) => l.label)]);
    const mine = jobs.filter((j) => j.plugin === p.name || labels.has(j.label) || labels.has(j.name));
    const settings = [...cfgOwner].filter(([, o]) => o.plugin === p.name).map(([c]) => {
      const info = configs.find((x) => x.name === c);
      return { name: c, exists: !!info, error: info?.error || null, keys: info?.keys ?? 0 };
    }).sort((a, b) => a.name.localeCompare(b.name));

    const problems = [];
    for (const e of p.errors) problems.push({ level: "error", text: `Manifest: ${e}` });
    if (enabled) for (const x of missing) problems.push({ level: "error", text: `Needs ${x}` });
    for (const j of mine) {
      const inc = incidents[j.label] || incidents[j.name];
      const runs = (j.runs || []).slice(-10);
      const fails = runs.filter((r) => r.exit !== 0).length;
      // A job whose latest run succeeded has recovered, and recovered is not a
      // problem: failures before its first success are history. Only a failure
      // that came after a success (flaky) is still worth a look.
      const recovered = runs.length > 0 && runs[runs.length - 1].exit === 0;
      if (recovered && !inc) {
        const firstOk = runs.findIndex((r) => r.exit === 0);
        const flaky = runs.slice(firstOk).filter((r) => r.exit !== 0).length;
        if (flaky) problems.push({ level: "warn", text: `${j.label || j.name} failed ${flaky} of its last ${runs.length - firstOk} runs after succeeding; the latest succeeded`, job: j.id });
      } else if (inc) problems.push({ level: "error", text: `${j.label || j.name} has failed every run since ${inc.since}${inc.error ? `: ${inc.error}` : ""}`, job: j.id });
      else if (runs.length && fails >= Math.max(1, Math.ceil(runs.length / 2))) problems.push({ level: "error", text: `${j.label || j.name} failed ${fails} of its last ${runs.length} runs`, job: j.id });
      else if (fails) problems.push({ level: "warn", text: `${j.label || j.name} failed ${fails} of its last ${runs.length} runs`, job: j.id });
      if (enabled && j.source === "launchd" && j.paused === "UNLOADED" && !j.schedule?.onDemand) problems.push({ level: "warn", text: `${j.label} is installed but not loaded, so it never runs`, job: j.id });
    }
    for (const c of plan.filter((x) => x.plugin === p.name)) {
      const t = { add: `${c.label} is not in the crontab yet (sync adds it)`, rewrite: `${c.label} in the crontab differs from the plugin (sync rewrites it)`, adopt: `${c.label} is in the crontab but not marked as this plugin's (sync adopts it)`, remove: `${c.label} is still in the crontab although the plugin no longer runs it (sync removes it)`, untag: `lines tagged ${c.label} remain while the plugin is off (sync removes them)`, conflict: c.problem }[c.op];
      if (t) problems.push({ level: c.op === "conflict" ? "error" : "warn", text: t });
    }
    for (const st of settings) if (st.error) problems.push({ level: "error", text: `Settings ${st.name}: ${st.error}` });

    return {
      name: p.name, scope: p.scope, title: m.title || p.name, description: m.description || "", version: m.version || "",
      enabled, core: !!m.core, default: m.default || "enabled", errors: p.errors, missing,
      requires: m.requires || {}, schedules, launchd: (m.launchd || []).map((l) => l.label),
      jobs: [...Object.keys(m.jobs || {}), ...(m.adopted_jobs || [])], bins: m.provides_bins || [],
      files: m.files || [], cronTags: m.cron_tags || [],
      config: m.config?.name || null, settings, problems,
      dir: path.relative(TOOLS_DIR, p.dir), readme: fs.existsSync(path.join(p.dir, "README.md")),
    };
  });
  const owned = new Set(all.flatMap((p) => [...P.schedulesOf(p).map((x) => x.label), ...(p.manifest.launchd || []).map((l) => l.label)]));
  const tags = all.flatMap((p) => p.manifest.cron_tags || []);
  const loose = jobs.filter((j) => !j.plugin && !owned.has(j.label) && !owned.has(j.name) && !tags.some((t) => String(j.command || "").includes(t))).map((j) => j.label || j.name);
  const unowned = configs.map((c) => c.name).filter((c) => !cfgOwner.has(c));
  return { plugins: list, notPluginYet: [...new Set(loose)].sort(), settingsWithoutPlugin: unowned, syncUnreadable: plan.find((x) => x.op === "unreadable")?.problem || null };
}

function jobRepairs() {
  const q = readJson(installTools("data", "job-repair-queue.json"), { pending: [], history: [] });
  const strip = ({ log_tail, ...r }) => r;
  return { pending: (q.pending || []).map(strip), history: (q.history || []).slice(-50) };
}

export async function snapshot() {
  const [ag, ch] = await Promise.all([agents().catch((e) => ({ error: e.message })), channels().catch((e) => ({ error: e.message }))]);
  const snap = {
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
    jev: part(jevState),
    configs: part(configs),
    identity: part(identity),
    services: part(services),
    machine: part(machine),
    hardcoded: part(hardcoded),
    history: part(() => history(200)),
    jobFailures: part(jobFailureIncidents),
    jobRepairs: part(jobRepairs),
  };
  snap.plugins = part(() => pluginsState(snap));
  snap.setup = await setupChecks(snap).catch((e) => ({ error: e.message }));
  return snap;
}
