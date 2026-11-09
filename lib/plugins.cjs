"use strict";
// plugins.cjs — the plugin registry: which feature modules exist, which are
// enabled, and what each contributes. Design: system/plugins.md.
//
// Read-only. Changing the machine (crontab, launchd, files) is
// lib/plugin-manager.mjs; this module only answers questions, so the
// supervisor, the registries and the control room can all ask it cheaply.
//
//   plugins()                 every installed plugin, kernel then local
//   plugin(name)              one, or null
//   isEnabled(name)           agent/local/plugins.json, else the manifest's default
//   enabledPlugins()          the enabled ones, dependencies first
//   pluginPath(name, ...p)    a path inside an installed plugin (null if absent)
//   jobDirs()                 enabled plugins' jobs/ dirs (playbook lookup)
//   registryContributions(kind)   "tasks" → [task], "job-routing" → {job: routing}
//   validate(manifest, dir)   [] or a list of problems

const fs = require("node:fs");
const path = require("node:path");
const { TOOLS_DIR } = require("./root.cjs");

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/; // lang-regex-ok: plugin id syntax
const LABEL = /^[a-z0-9][a-z0-9._-]{0,80}$/; // lang-regex-ok: cron label syntax

function localDir() {
  return process.env.JORI_LOCAL_DIR || path.join(TOOLS_DIR, "agent", "local");
}
function roots() {
  return [
    { scope: "kernel", dir: process.env.JORI_PLUGINS_DIR || path.join(TOOLS_DIR, "plugins") },
    { scope: "local", dir: path.join(localDir(), "plugins") },
  ];
}
function stateFile() {
  return path.join(localDir(), "plugins.json");
}
function readJson(f, d = null) {
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; }
}

function validate(m, dir = "") {
  const errs = [];
  if (!m || typeof m !== "object") return ["plugin.json is not an object"];
  if (!NAME.test(String(m.name || ""))) errs.push("name must be lowercase letters, digits and dashes");
  if (dir && m.name && path.basename(dir) !== m.name) errs.push(`directory name ${path.basename(dir)} differs from name ${m.name}`);
  if (!m.title) errs.push("title is required");
  if (!m.description) errs.push("description is required");
  if (m.default && !["enabled", "disabled"].includes(m.default)) errs.push("default must be enabled or disabled");
  const r = m.requires || {};
  for (const k of ["plugins", "bins", "env", "commands"]) if (r[k] && !Array.isArray(r[k])) errs.push(`requires.${k} must be a list`);
  const labels = new Set();
  for (const [i, s] of (m.schedules || []).entries()) {
    if (!LABEL.test(String(s.label || ""))) errs.push(`schedules[${i}].label is missing or malformed`);
    if (labels.has(s.label)) errs.push(`schedules[${i}].label ${s.label} is repeated`);
    labels.add(s.label);
    if (String(s.cron || "").trim().split(/\s+/).length !== 5) errs.push(`schedules[${i}].cron must have five fields`);
    if (!s.run && !s.command) errs.push(`schedules[${i}] needs run or command`);
    if (/[\n#]/.test(String(s.run || ""))) errs.push(`schedules[${i}].run may not contain a newline or #`);
    if (/\n/.test(String(s.command || "")) || /# jori-plugin:/.test(String(s.command || ""))) errs.push(`schedules[${i}].command may not contain a newline or a plugin marker`);
  }
  for (const [i, l] of (m.launchd || []).entries()) if (!l.label || (!l.file && !l.adopt)) errs.push(`launchd[${i}] needs a label and a file (or adopt: true)`);
  for (const k of ["files", "adopted_jobs", "cron_tags", "settings"]) if (m[k] && !Array.isArray(m[k])) errs.push(`${k} must be a list`);
  for (const c of m.settings || []) if (!NAME.test(String(c))) errs.push(`settings name ${c} is malformed`);
  if (m.core !== undefined && typeof m.core !== "boolean") errs.push("core must be true or false");
  if (m.jobs && typeof m.jobs !== "object") errs.push("jobs must be an object");
  for (const j of Object.keys(m.jobs || {})) {
    if (!NAME.test(j)) errs.push(`job name ${j} is malformed`);
    else if (dir && !fs.existsSync(path.join(dir, "jobs", `${j}.md`))) errs.push(`jobs.${j}: jobs/${j}.md is missing`);
  }
  for (const b of m.provides_bins || []) if (dir && !fs.existsSync(path.join(dir, "bin", b))) errs.push(`provides_bins: bin/${b} is missing`);
  errs.push(...approvalErrors(m));
  return errs;
}

// `approvals`: actions that run only after a Face ID approval on the paired
// phone (lib/action-approval.mjs; same rules as manifestApprovalErrors there).
function approvalErrors(m) {
  if (m.approvals === undefined) return [];
  if (!m.approvals || typeof m.approvals !== "object" || Array.isArray(m.approvals)) return ["approvals must be an object of action → {title, run}"];
  const errs = [];
  for (const [a, d] of Object.entries(m.approvals)) {
    if (!NAME.test(a)) errs.push(`approvals: action name ${a} is malformed`);
    if (!d || typeof d !== "object") { errs.push(`approvals.${a} must be an object`); continue; }
    if (!d.title) errs.push(`approvals.${a}.title is required`);
    if (!d.run || /[\n#]/.test(String(d.run))) errs.push(`approvals.${a}.run is required and may not contain a newline or #`);
    if (d.ttl_minutes !== undefined && !(Number.isInteger(d.ttl_minutes) && d.ttl_minutes >= 1 && d.ttl_minutes <= 1440)) errs.push(`approvals.${a}.ttl_minutes must be 1–1440`);
    if (d.timeout_seconds !== undefined && !(Number.isInteger(d.timeout_seconds) && d.timeout_seconds >= 5 && d.timeout_seconds <= 3600)) errs.push(`approvals.${a}.timeout_seconds must be 5–3600`);
  }
  return errs;
}

/** The approval an enabled plugin declares for an action, or null. */
function declaredApproval(name, action) {
  const all = plugins();
  const p = all.find((x) => x.name === name);
  if (!p || !isEnabled(name, all)) return null;
  const d = (p.manifest.approvals || {})[action];
  return d ? { plugin: p, ...d } : null;
}

/** True when some enabled plugin declares at least one approval. */
function anyApprovalsDeclared() {
  return enabledPlugins().some((p) => Object.keys(p.manifest.approvals || {}).length > 0);
}

function plugins() {
  const out = [];
  const seen = new Set();
  for (const { scope, dir } of roots()) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => !n.startsWith(".") && !n.startsWith("_")); } catch { continue; }
    for (const n of names.sort()) {
      const pdir = path.join(dir, n);
      const mf = path.join(pdir, "plugin.json");
      if (!fs.existsSync(mf)) continue;
      const manifest = readJson(mf, null);
      const errors = manifest ? validate(manifest, pdir) : ["plugin.json does not parse"];
      const name = (manifest && manifest.name) || n;
      if (seen.has(name)) { errors.push(`a plugin named ${name} is installed twice`); continue; }
      seen.add(name);
      const entry = { name, scope, dir: pdir, manifest: manifest || {}, errors };
      if (manifest && manifest.config && manifest.config.schedules) {
        const extra = schedulesOf(entry).slice((manifest.schedules || []).length);
        for (const e of validate({ ...manifest, schedules: extra, jobs: {}, provides_bins: [] }).filter((x) => x.startsWith("schedules"))) errors.push(`settings ${manifest.config.name}.json: ${e}`);
      }
      out.push(entry);
    }
  }
  return out;
}

// A plugin's schedules: the manifest's, plus, when the manifest says
// "config": { "name": X, "schedules": true }, the `schedules` list in this
// installation's agent/local/config/X.json (the times and windows that are the
// owner's own, kept out of a kernel manifest).
function schedulesOf(p) {
  const own = Array.isArray(p.manifest.schedules) ? p.manifest.schedules : [];
  const c = p.manifest.config || {};
  if (!c.schedules || !c.name) return own;
  const local = readJson(path.join(localDir(), "config", `${c.name}.json`), {}) || {};
  const extra = Array.isArray(local.schedules) ? local.schedules : [];
  const labels = new Set(own.map((s) => s.label));
  return [...own, ...extra.filter((s) => s && s.label && !labels.has(s.label))];
}

function plugin(name) {
  return plugins().find((p) => p.name === name) || null;
}

function state() {
  return readJson(stateFile(), { enabled: {} }) || { enabled: {} };
}

function isEnabled(name, all = null) {
  const p = (all || plugins()).find((x) => x.name === name);
  if (!p || p.errors.length) return false;
  if (p.manifest.core) return true; // core plugins are always on
  const s = state().enabled || {};
  if (Object.prototype.hasOwnProperty.call(s, name)) return s[name] === true;
  return (p.manifest.default || "enabled") === "enabled";
}

/** Enabled plugins, each after the plugins it requires; a plugin whose requirement is off is left out. */
function enabledPlugins() {
  const all = plugins();
  const on = new Map(all.filter((p) => isEnabled(p.name, all)).map((p) => [p.name, p]));
  const out = [], done = new Set(), visiting = new Set();
  const visit = (p) => {
    if (done.has(p.name)) return true;
    if (visiting.has(p.name)) return false; // a cycle: neither side loads
    visiting.add(p.name);
    for (const dep of (p.manifest.requires || {}).plugins || []) {
      const d = on.get(dep);
      if (!d || !visit(d)) { visiting.delete(p.name); return false; }
    }
    visiting.delete(p.name);
    done.add(p.name);
    out.push(p);
    return true;
  };
  for (const p of on.values()) visit(p);
  return out;
}

function pluginPath(name, ...parts) {
  const p = plugin(name);
  return p ? path.join(p.dir, ...parts) : null;
}

function jobDirs() {
  return enabledPlugins().map((p) => path.join(p.dir, "jobs")).filter((d) => fs.existsSync(d));
}

/** What enabled plugins add to a registry (lib/registry.cjs merges it between kernel and local). */
function registryContributions(kind) {
  const en = enabledPlugins();
  if (kind === "job-routing") {
    const out = {};
    for (const p of en) for (const [job, j] of Object.entries(p.manifest.jobs || {})) if (j.routing) out[job] = { ...j.routing, plugin: p.name };
    return out;
  }
  if (kind === "tasks") {
    const out = [];
    for (const p of en) for (const [job, j] of Object.entries(p.manifest.jobs || {})) if (j.task) out.push({ name: job, webhook_task: job, ...j.task, plugin: p.name });
    return out;
  }
  if (kind === "services") {
    const out = [];
    for (const p of en) for (const s of p.manifest.services || []) out.push({ ...s, plugin: p.name });
    return out;
  }
  return null;
}

// Jobs a disabled plugin owns (its own jobs/ and the playbooks it adopted in
// place): resolveJobFile refuses them and the registries leave them out.
function disabledJobs() {
  const all = plugins();
  const out = new Set();
  for (const p of all) {
    if (isEnabled(p.name, all)) continue;
    for (const j of [...Object.keys(p.manifest.jobs || {}), ...(p.manifest.adopted_jobs || [])]) out.add(j);
  }
  return out;
}

/** Which plugin owns a cron label or a job name (null when none). */
function ownerOf({ label = null, job = null } = {}) {
  for (const p of plugins()) {
    if (label && schedulesOf(p).some((s) => s.label === label)) return p.name;
    if (label && (p.manifest.launchd || []).some((l) => l.label === label)) return p.name;
    if (job && (Object.prototype.hasOwnProperty.call(p.manifest.jobs || {}, job) || (p.manifest.adopted_jobs || []).includes(job))) return p.name;
  }
  return null;
}

module.exports = {
  plugins, plugin, state, stateFile, isEnabled, enabledPlugins, pluginPath, jobDirs,
  registryContributions, ownerOf, validate, roots, schedulesOf, disabledJobs, NAME,
  declaredApproval, anyApprovalsDeclared,
};

if (require.main === module) {
  for (const p of plugins()) {
    const on = isEnabled(p.name);
    process.stdout.write(`${on ? "on " : "off"}  ${p.name.padEnd(28)} ${p.scope.padEnd(6)} ${p.errors.length ? `INVALID: ${p.errors.join("; ")}` : p.manifest.title}\n`);
  }
}
