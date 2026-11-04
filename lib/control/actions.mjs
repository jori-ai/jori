// control/actions.mjs — every change the control room can make, in one table.
//
// `perform(action, args, who)` validates, applies, and records the change in
// the audit log with an `undo` (the action + args that put it back). Nothing
// here runs a shell string built from input: commands are execFile with
// fixed argv, file targets come from an allowlist, and config names must
// match CONFIG_NAME.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import * as S from "./schedule.mjs";
import { record, writeWithBackup, entry as auditEntry } from "./audit.mjs";
import { CONFIG_NAME } from "./state.mjs";
import { CONFIG as JEV_CONFIG, OFF_FILE as JEV_OFF, applyJevChange } from "./jev.mjs";

const require = createRequire(import.meta.url);
const { TOOLS_DIR } = require("../root.cjs");
const inst = require("../instance.cjs");
const ports = require("../ports.cjs");
const { MODELS_ENV } = require("../models.cjs");

const localFile = (...p) => path.join(inst.localDir(), ...p);
const readJson = (f, d = {}) => {
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { if (e.code === "ENOENT") return d; throw e; }
};
const pretty = (o) => JSON.stringify(o, null, 2) + "\n";

function job(id) {
  const j = S.findJob(id);
  if (!j) throw new Error("no such job (it may have changed since the page loaded; reload)");
  return j;
}

// Write a JSON object to an allowlisted file, recorded with a restore undo.
function saveJson(file, obj, meta) {
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  const text = pretty(obj);
  if (before === text) return { unchanged: true };
  const backup = writeWithBackup(file, text);
  return record({ ...meta, target: path.relative(TOOLS_DIR, file), undo: { action: "file.restore", args: { file: path.relative(TOOLS_DIR, file), backup } } });
}

const ACTIONS = {
  "job.schedule"({ id, cron, launchd }, who) {
    const j = job(id);
    if (j.source === "cron") {
      const before = j.schedule;
      const line = S.setCronSchedule(j, cron);
      return record({ who, page: "schedule", what: `${j.name}: schedule ${before} → ${cron}`, target: "crontab", detail: { before: j.line, after: line }, undo: { action: "job.schedule", args: { id, cron: before } } });
    }
    const before = j.schedule.every ? { every: j.schedule.every } : { calendar: j.schedule.calendar };
    S.setLaunchdSchedule(j, launchd);
    return record({ who, page: "schedule", what: `${j.name}: launchd schedule changed`, target: j.label, detail: { before, after: launchd }, undo: { action: "job.schedule", args: { id, launchd: before } } });
  },
  "job.pause"({ id }, who) {
    const j = job(id);
    if (j.source === "cron") S.setCronPaused(j, true); else S.setLaunchdPaused(j, true);
    return record({ who, page: "schedule", what: `Paused ${j.name}`, target: j.source === "cron" ? "crontab" : j.label, undo: { action: "job.resume", args: { id } } });
  },
  "job.resume"({ id }, who) {
    const j = job(id);
    if (j.source === "cron") S.setCronPaused(j, false); else S.setLaunchdPaused(j, false);
    return record({ who, page: "schedule", what: `Resumed ${j.name}`, target: j.source === "cron" ? "crontab" : j.label, undo: { action: "job.pause", args: { id } } });
  },
  "job.run"({ id }, who) {
    const j = job(id);
    if (j.source === "cron") S.runCronNow(j); else S.runLaunchdNow(j);
    return record({ who, page: "schedule", what: `Ran ${j.name} now`, target: j.label || j.name });
  },
  "family.pause"({ family }, who) {
    const n = S.setFamilyPaused(family, true);
    return record({ who, page: "schedule", what: `Paused the ${family} family (${n} jobs)`, target: "crontab", undo: { action: "family.resume", args: { family } } });
  },
  "family.resume"({ family }, who) {
    const n = S.setFamilyPaused(family, false);
    return record({ who, page: "schedule", what: `Resumed the ${family} family (${n} jobs)`, target: "crontab", undo: { action: "family.pause", args: { family } } });
  },
  "job.route"({ name, target, model, effort }, who) {
    const file = localFile("job-routing.json");
    const doc = readJson(file, { jobs: {} });
    doc.jobs ||= {};
    const cur = { ...(doc.jobs[name] || {}) };
    for (const [k, v] of Object.entries({ target, model, effort })) if (v) cur[k] = v;
    doc.jobs[name] = cur;
    if (Array.isArray(doc.order) && !doc.order.includes(name)) doc.order.push(name);
    return saveJson(file, doc, { who, page: "schedule", what: `${name}: runs on ${cur.target || "?"} with ${cur.model || "?"}, effort ${cur.effort || "?"}` });
  },
  "job.importance"({ name, importance }, who) {
    if (!["essential", "important", "optional"].includes(importance)) throw new Error("importance must be essential, important or optional");
    const file = localFile("config", "allowance-brake.json");
    const doc = readJson(file);
    doc.jobs ||= {};
    doc.jobs[name] = { ...(doc.jobs[name] || {}), importance };
    return saveJson(file, doc, { who, page: "budget", what: `${name} is ${importance} when the budget is tight` });
  },
  "watch.pause"({ id }, who) {
    execFileSync(process.execPath, [path.join(TOOLS_DIR, "bin", "watch"), "pause", id, "--by", "control-room", "--reason", "paused from the control room"], { timeout: 20_000 });
    return record({ who, page: "watches", what: `Paused watch ${id}`, target: id, undo: { action: "watch.resume", args: { id } } });
  },
  "watch.resume"({ id }, who) {
    execFileSync(process.execPath, [path.join(TOOLS_DIR, "bin", "watch"), "resume", id, "--by", "control-room"], { timeout: 20_000 });
    return record({ who, page: "watches", what: `Resumed watch ${id}`, target: id, undo: { action: "watch.pause", args: { id } } });
  },
  "config.save"({ name, text }, who) {
    if (!CONFIG_NAME.test(String(name))) throw new Error("bad settings name");
    let obj;
    try { obj = JSON.parse(text); } catch (e) { throw new Error(`not saved: the JSON does not parse (${e.message})`); }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("not saved: a settings file must be a JSON object");
    return saveJson(localFile("config", `${name}.json`), obj, { who, page: "features", what: `Changed ${name} settings` });
  },
  "instance.save"({ values }, who) {
    const allowed = new Set([...Object.keys(inst.INSTANCE_KEYS), "agent_email_aliases", "assistant_aliases"]);
    const file = localFile("instance.json");
    const doc = readJson(file);
    const changed = [];
    for (const [k, v] of Object.entries(values || {})) {
      if (!allowed.has(k)) throw new Error(`unknown identity setting: ${k}`);
      const val = k.endsWith("_aliases") ? (Array.isArray(v) ? v : String(v).split(",")).map((x) => String(x).trim()).filter(Boolean) : String(v).trim();
      if (JSON.stringify(doc[k]) !== JSON.stringify(val)) { doc[k] = val; changed.push(k); }
    }
    if (!changed.length) return { unchanged: true };
    if (doc.tz) {
      try { new Intl.DateTimeFormat("en-US", { timeZone: doc.tz }); } catch { throw new Error(`not a time zone: ${doc.tz}`); }
    }
    return saveJson(file, doc, { who, page: "identity", what: `Changed ${changed.join(", ").replace(/_/g, " ")}` });
  },
  "models.save"({ key, value }, who) {
    if (!/^JORI_MODEL_[A-Z0-9_]+$/.test(key)) throw new Error("bad model key"); // lang-regex-ok: env key syntax
    if (!/^[a-z0-9][a-z0-9.\-]*$/.test(value)) throw new Error("bad model id"); // lang-regex-ok: model id syntax
    const text = fs.readFileSync(MODELS_ENV, "utf8");
    const re = new RegExp(`^${key}=.*$`, "m");
    if (!re.test(text)) throw new Error(`${key} is not in models.env`);
    const before = text.match(re)[0].split("=")[1];
    if (before === value) return { unchanged: true };
    const backup = writeWithBackup(MODELS_ENV, text.replace(re, `${key}=${value}`));
    return record({ who, page: "agents", what: `${key}: ${before} → ${value}`, target: path.relative(TOOLS_DIR, MODELS_ENV), undo: { action: "file.restore", args: { file: path.relative(TOOLS_DIR, MODELS_ENV), backup } } });
  },
  "ports.save"({ name, port }, who) {
    const n = Number(port);
    if (!(name in ports.PORTS)) throw new Error("unknown port name");
    if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new Error("a port is a whole number from 1024 to 65535");
    const file = localFile("config", "ports.json");
    const doc = readJson(file, { _comment: "This installation's port overrides, read by lib/ports.cjs. Restart the process that listens on a port after changing it." });
    if (n === ports.PORTS[name][0]) delete doc[name]; else doc[name] = n;
    return saveJson(file, doc, { who, page: "machine", what: `${ports.PORTS[name][1]} port → ${n}` });
  },
  "quiet.save"({ awake_from, awake_to }, who) {
    const a = Number(awake_from), b = Number(awake_to);
    if (![a, b].every((x) => Number.isInteger(x) && x >= 0 && x <= 24) || a >= b) throw new Error("awake hours must be whole hours, start before end");
    const file = localFile("config", "quiet-hours.json");
    const doc = readJson(file, { _comment: "Hours the owner is awake; non-urgent pings wait outside them (lib/watches.mjs and others via localConfig(\"quiet-hours\"))." });
    Object.assign(doc, { awake_from: a, awake_to: b });
    return saveJson(file, doc, { who, page: "channels", what: `Awake hours ${a}:00 to ${b}:00` });
  },
  "jev.save"(args, who) {
    const file = JEV_CONFIG();
    const before = readJson(file);
    const after = applyJevChange(before, args || {});
    const what = args.site ? `Jev ${args.site}: ${args.enabled === false || args.enabled === "false" ? "off" : "on"}${args.threshold != null && args.threshold !== "" ? `, threshold ${args.threshold}` : ""}` : "Changed Jev settings";
    return saveJson(file, after, { who, page: "agents", what });
  },
  "jev.on"(_a, who) {
    if (!fs.existsSync(JEV_OFF())) return { unchanged: true };
    fs.rmSync(JEV_OFF());
    return record({ who, page: "agents", what: "Turned Jev on", target: "data/.jev-off", undo: { action: "jev.off", args: {} } });
  },
  "jev.off"(_a, who) {
    if (fs.existsSync(JEV_OFF())) return { unchanged: true };
    fs.writeFileSync(JEV_OFF(), `turned off from the control room by ${who} at ${new Date().toISOString()}\n`);
    return record({ who, page: "agents", what: "Turned Jev off (every site uses its fallback)", target: "data/.jev-off", undo: { action: "jev.on", args: {} } });
  },
  async "agent.restart"({ name }, who) {
    const pn = { chat: "chat_health", ops: "ops_health", "ops-light": "ops_light_health", "ops-haiku": "ops_haiku_health" }[name];
    if (!pn) throw new Error("unknown agent");
    const res = await fetch(ports.localUrl(pn, "/restart"), { method: "POST", signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`restart refused: HTTP ${res.status}`);
    return record({ who, page: "agents", what: `Restarted the ${name} session (takes up to a minute)`, target: name });
  },
  "file.restore"({ file, backup }, who) {
    const abs = path.join(TOOLS_DIR, file);
    const okTargets = [path.join(inst.localDir()), MODELS_ENV, JEV_CONFIG()];
    if (!okTargets.some((t) => abs === t || abs.startsWith(t + path.sep))) throw new Error("not a file the control room manages");
    const content = backup ? fs.readFileSync(backup, "utf8") : null;
    if (content == null) { fs.rmSync(abs, { force: true }); return record({ who, page: "history", what: `Removed ${file} (it did not exist before)`, target: file }); }
    const newBackup = writeWithBackup(abs, content);
    return record({ who, page: "history", what: `Put back ${file}`, target: file, undo: { action: "file.restore", args: { file, backup: newBackup } } });
  },
  "scan.run"(_args, who) {
    execFileSync(path.join(TOOLS_DIR, "bin", "control-scan"), ["--quiet"], { timeout: 120_000 });
    return { what: "Scanned the code for hardcoded values", unchanged: false };
  },
  async "history.revert"({ id }, who) {
    const e = auditEntry(id);
    if (!e) throw new Error("no such change");
    if (!e.undo) throw new Error("this change has nothing to put back");
    return perform(e.undo.action, e.undo.args, who);
  },
};

export async function perform(action, args, who) {
  const fn = ACTIONS[action];
  if (!fn) throw new Error(`unknown action: ${action}`);
  return await fn(args || {}, who);
}

export const ACTION_NAMES = Object.keys(ACTIONS);
