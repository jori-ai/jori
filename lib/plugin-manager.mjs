// plugin-manager.mjs — turn plugins on and off on this machine, install and
// remove them, and keep the machine in step with the state. Design:
// system/plugins.md. Questions (which exist, which are on) are lib/plugins.cjs.
//
// Crontab: a plugin's schedule line ends with `# jori-plugin:<name>:<label>`
// and is written only through bin/crontab-safe. An unmarked line with the same
// `--label` (a feature from before it became a plugin) is adopted: its time
// is kept, its command and marker rewritten. A marked line's time is never
// reset (cron-tz-sync and the control room retime lines in place).
// launchd: templates in <plugin>/launchd/ are rendered with
// agent/scripts/lib/launchd-render.sh into ~/Library/LaunchAgents.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const P = require("./plugins.cjs");
const { TOOLS_DIR, installTools, nodeBin } = require("./root.cjs");
const { writeJsonAtomic } = require("./atomic-write.js");

const MARK = (name, label) => `# jori-plugin:${name}:${label}`;
const MARK_PREFIX = (name) => `# jori-plugin:${name}:`;
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", timeout: 60_000, stdio: ["pipe", "pipe", "pipe"], ...opts });
const agentsDir = () => process.env.JORI_LAUNCH_AGENTS_DIR || path.join(os.homedir(), "Library", "LaunchAgents");

// Seams for tests: crontab read/write and launchctl.
const io = {
  readCrontab: () => sh("crontab", ["-l"]),
  crontabSafe: (args) => sh(path.join(TOOLS_DIR, "bin", "crontab-safe"), args),
  launchctl: (args) => sh("launchctl", args),
  dryRun: false,
};
export function _setIo(o) { Object.assign(io, o); }

// ── schedule lines ───────────────────────────────────────────────────────

/** The command part of a plugin schedule (everything after the five fields). */
export function scheduleCommand(p, s) {
  const root = installTools();
  const run = String(s.run)
    .replace(/\{node\}/g, String(P.state().node || nodeBin()).replace(/^~(?=\/)/, os.homedir()))
    .replace(/\{root\}/g, root)
    .replace(/(^|\s)(bin|lib)\//g, `$1${p.dir}/$2/`); // lang-regex-ok: plugin-relative paths in a command
  const body = s.log ? `bash -c '${run.replace(/'/g, "'\\''")} >> ${path.join(root, s.log)} 2>&1'` : run;
  return `${path.join(root, "bin", "cron-run")} --label ${s.label} -- ${body} ${MARK(p.name, s.label)}`;
}

function cronLines() {
  try { return io.readCrontab().split("\n"); } catch (e) { throw new Error(`could not read the crontab: ${e.message}`); }
}

/** What sync would change in the crontab: [{op: add|adopt|rewrite|remove, label, plugin, line}] */
export function planCrontab({ lines = cronLines(), all = P.plugins(), enabled = P.enabledPlugins() } = {}) {
  const plan = [];
  const on = new Set(enabled.map((p) => p.name));
  for (const p of enabled) {
    for (const s of P.schedulesOf(p)) {
      const cmd = scheduleCommand(p, s);
      const mine = lines.filter((l) => l.includes(MARK(p.name, s.label)));
      const unmarked = lines.filter((l) => !l.trim().startsWith("#") && l.includes(`--label ${s.label} --`) && !l.includes("# jori-plugin:"));
      // crontab-safe drops every line carrying the tag, a retired commented copy too.
      const tagged = lines.filter((l) => l.includes(`--label ${s.label} --`) && !l.includes("# jori-plugin:"));
      const timeOf = (l) => l.trim().split(/\s+/).slice(0, 5).join(" ");
      if (!mine.length && tagged.length > 1) {
        plan.push({ op: "conflict", plugin: p.name, label: s.label, problem: `${tagged.length} crontab lines carry --label ${s.label}; keep one, then sync` });
      } else if (mine.length === 1) {
        const want = `${timeOf(mine[0])} ${cmd}`;
        if (mine[0].trim() !== want) plan.push({ op: "rewrite", plugin: p.name, label: s.label, line: want, from: mine[0].trim() });
      } else if (mine.length > 1) {
        plan.push({ op: "rewrite", plugin: p.name, label: s.label, line: `${timeOf(mine[0])} ${cmd}`, from: mine[0].trim(), duplicates: mine.length });
      } else if (unmarked.length === 1) {
        plan.push({ op: "adopt", plugin: p.name, label: s.label, line: `${timeOf(unmarked[0])} ${cmd}`, from: unmarked[0].trim() });
      } else {
        plan.push({ op: "add", plugin: p.name, label: s.label, line: `${s.cron} ${cmd}` });
      }
    }
  }
  // Marked lines of a plugin that is off, removed, or no longer lists the label.
  const known = new Map(all.map((p) => [p.name, new Set(P.schedulesOf(p).map((s) => s.label))]));
  for (const l of lines) {
    const m = l.match(/# jori-plugin:([a-z0-9-]+):([a-z0-9._-]+)\s*$/); // lang-regex-ok: our own crontab marker
    if (!m) continue;
    const [, name, label] = m;
    if (!on.has(name) || !known.get(name)?.has(label)) plan.push({ op: "remove", plugin: name, label, from: l.trim() });
  }
  return plan;
}

function applyCrontab(plan) {
  for (const c of plan) {
    if (io.dryRun || c.op === "conflict") continue;
    if (c.op === "remove") io.crontabSafe(["remove", MARK(c.plugin, c.label)]);
    else if (c.op === "adopt") io.crontabSafe(["replace", `--label ${c.label} --`, c.line]);
    else io.crontabSafe(["replace", MARK(c.plugin, c.label), c.line]);
  }
}

// ── launchd agents ───────────────────────────────────────────────────────

function uid() { return process.getuid ? process.getuid() : 501; }

export function planLaunchd({ all = P.plugins(), enabled = P.enabledPlugins() } = {}) {
  const plan = [];
  const on = new Set(enabled.map((p) => p.name));
  for (const p of all) {
    for (const l of p.manifest.launchd || []) {
      const dst = path.join(agentsDir(), `${l.label}.plist`);
      const installed = fs.existsSync(dst);
      if (on.has(p.name)) plan.push({ op: installed ? "refresh" : "install", plugin: p.name, label: l.label, src: path.join(p.dir, "launchd", l.file), dst });
      else if (installed) plan.push({ op: "uninstall", plugin: p.name, label: l.label, dst });
    }
  }
  return plan;
}

function applyLaunchd(plan) {
  const render = path.join(TOOLS_DIR, "agent", "scripts", "lib", "launchd-render.sh");
  for (const c of plan) {
    if (io.dryRun) continue;
    const domain = `gui/${uid()}`;
    if (c.op === "uninstall") {
      try { io.launchctl(["bootout", domain, c.dst]); } catch {}
      fs.rmSync(c.dst, { force: true });
      continue;
    }
    const tmp = `${c.dst}.tmp`;
    sh("bash", ["-c", 'source "$1" && launchd_render_plist "$2" "$3"', "_", render, c.src, tmp]);
    if (c.op === "refresh" && fs.existsSync(c.dst) && fs.readFileSync(c.dst, "utf8") === fs.readFileSync(tmp, "utf8")) { fs.rmSync(tmp); continue; }
    try { io.launchctl(["bootout", domain, c.dst]); } catch {}
    fs.renameSync(tmp, c.dst);
    io.launchctl(["bootstrap", domain, c.dst]);
  }
}

// ── requirements, settings, state ───────────────────────────────────────

function envKeys() {
  try {
    return new Set(fs.readFileSync(installTools(".env"), "utf8").split("\n")
      .map((l) => l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\S.*)$/)) // lang-regex-ok: .env syntax
      .filter(Boolean).map((m) => m[1]));
  } catch { return new Set(); }
}
function onPath(cmd) {
  try { sh("/bin/sh", ["-c", `command -v "$1"`, "_", cmd]); return true; } catch { return false; }
}

/** What an enable would be missing: [] when it can go ahead. */
export function missingRequirements(p, { all = P.plugins() } = {}) {
  const r = p.manifest.requires || {};
  const out = [];
  for (const dep of r.plugins || []) {
    const d = all.find((x) => x.name === dep);
    if (!d) out.push(`plugin ${dep} (not installed)`);
    else if (!P.isEnabled(dep, all)) out.push(`plugin ${dep} (installed but off)`);
  }
  for (const b of r.bins || []) if (!fs.existsSync(installTools(b))) out.push(`file ${b}`);
  for (const c of r.commands || []) if (!onPath(c)) out.push(`command ${c} on PATH`);
  const keys = envKeys();
  for (const k of r.env || []) if (!keys.has(k)) out.push(`.env key ${k}`);
  return out;
}

function seedConfig(p) {
  const c = p.manifest.config;
  if (!c || !c.name) return null;
  const dst = path.join(P.roots()[1].dir, "..", "config", `${c.name}.json`);
  const src = path.join(p.dir, "config.defaults.json");
  if (fs.existsSync(dst) || !fs.existsSync(src) || io.dryRun) return null;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return dst;
}

function setState(name, on) {
  if (io.dryRun) return;
  const s = P.state();
  s.enabled = { ...(s.enabled || {}), [name]: on };
  if (!s._comment) s._comment = "Which plugins are on in this installation (system/plugins.md). A plugin not listed follows its manifest's default. Change with `jori plugin enable|disable` or the control room's Plugins page.";
  writeJsonAtomic(P.stateFile(), s);
}

// ── lifecycle ────────────────────────────────────────────────────────────

// Schedules belong on the production host (system/hosts.json). Elsewhere (a
// laptop with the same checkout) the state is saved but the machine is left
// alone; with no production host registered (a fresh install), any host.
export function syncAllowedHere() {
  if (process.env.JORI_PLUGIN_ANY_HOST === "1") return true;
  try {
    const hi = require("./host-identity.js");
    if (hi.resolveHost().isProduction) return true;
    const reg = JSON.parse(fs.readFileSync(hi.HOSTS_JSON, "utf8"));
    return !(reg.hosts || []).some((h) => h.production === true || h.role === "production");
  } catch {
    return true;
  }
}

/** Make crontab and launchd match the state. Returns what changed. */
export function sync() {
  if (!syncAllowedHere()) return { cron: [], launchd: [], skipped: "not the production host: the state is saved and the production host applies it on its next sync" };
  const all = P.plugins(), enabled = P.enabledPlugins();
  const cron = planCrontab({ all, enabled });
  applyCrontab(cron);
  const agents = planLaunchd({ all, enabled });
  applyLaunchd(agents);
  return { cron, launchd: agents.filter((a) => a.op !== "refresh" || !io.dryRun) };
}

export function enable(name, { force = false } = {}) {
  const all = P.plugins();
  const p = all.find((x) => x.name === name);
  if (!p) throw new Error(`no plugin named ${name}`);
  if (p.errors.length) throw new Error(`${name} has manifest errors: ${p.errors.join("; ")}`);
  const missing = missingRequirements(p, { all });
  if (missing.length && !force) throw new Error(`${name} needs: ${missing.join(", ")}`);
  setState(name, true);
  const seeded = seedConfig(p);
  return { ...sync(), seeded, missing };
}

export function disable(name) {
  const all = P.plugins();
  const p = all.find((x) => x.name === name);
  if (!p) throw new Error(`no plugin named ${name}`);
  const dependents = P.enabledPlugins().filter((x) => (x.manifest.requires?.plugins || []).includes(name)).map((x) => x.name);
  if (dependents.length) throw new Error(`${dependents.join(", ")} need ${name}; turn ${dependents.length > 1 ? "them" : "it"} off first`);
  setState(name, false);
  return sync();
}

/** Copy a plugin directory (or clone a git URL) into place, validate it, enable it. */
export function install(src, { local = false, enable: turnOn = true } = {}) {
  const root = (local ? P.roots()[1] : P.roots()[0]).dir;
  let dir = src;
  let tmp = null;
  if (/^(https?:\/\/|git@)/.test(src)) { // lang-regex-ok: URL scheme
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jori-plugin-"));
    sh("git", ["clone", "--depth", "1", src, tmp], { timeout: 180_000 });
    dir = tmp;
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "plugin.json"), "utf8"));
  const errs = P.validate(manifest);
  if (errs.length) throw new Error(`not installed: ${errs.join("; ")}`);
  const dst = path.join(root, manifest.name);
  if (fs.existsSync(dst)) throw new Error(`${manifest.name} is already installed at ${path.relative(installTools(), dst)}; remove it first`);
  if (!io.dryRun) {
    fs.mkdirSync(root, { recursive: true });
    fs.cpSync(dir, dst, { recursive: true, filter: (f) => !f.split(path.sep).includes(".git") });
  }
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  const errs2 = io.dryRun ? [] : P.validate(manifest, dst);
  if (errs2.length) throw new Error(`installed but invalid: ${errs2.join("; ")}`);
  return { name: manifest.name, dir: dst, ...(turnOn ? enable(manifest.name) : {}) };
}

/** Disable, then delete the plugin's directory (and, asked, its settings file). Data is never touched. */
export function remove(name, { purgeConfig = false } = {}) {
  const p = P.plugin(name);
  if (!p) throw new Error(`no plugin named ${name}`);
  const out = P.isEnabled(name) ? disable(name) : sync();
  if (!io.dryRun) {
    fs.rmSync(p.dir, { recursive: true, force: true });
    const s = P.state();
    if (s.enabled && name in s.enabled) { delete s.enabled[name]; writeJsonAtomic(P.stateFile(), s); }
    if (purgeConfig && p.manifest.config?.name) fs.rmSync(path.join(P.roots()[1].dir, "..", "config", `${p.manifest.config.name}.json`), { force: true });
  }
  sync();
  return { ...out, removed: p.dir };
}

// ── check ────────────────────────────────────────────────────────────────

/** Problems: invalid manifests, two plugins with one label or job, kernel code naming a plugin's files. */
export function check({ scanCode = true } = {}) {
  const all = P.plugins();
  const problems = [];
  for (const p of all) for (const e of p.errors) problems.push({ plugin: p.name, problem: e });
  const owner = new Map();
  for (const p of all) {
    for (const k of [...P.schedulesOf(p).map((s) => `label ${s.label}`), ...(p.manifest.launchd || []).map((l) => `label ${l.label}`), ...Object.keys(p.manifest.jobs || {}).map((j) => `job ${j}`), ...(p.manifest.provides_bins || []).map((b) => `bin ${b}`)]) {
      if (owner.has(k)) problems.push({ plugin: p.name, problem: `${k} is also claimed by ${owner.get(k)}` });
      else owner.set(k, p.name);
    }
    for (const b of p.manifest.provides_bins || []) if (fs.existsSync(path.join(TOOLS_DIR, "bin", b))) problems.push({ plugin: p.name, problem: `bin/${b} also exists outside the plugin` });
  }
  if (scanCode) {
    // Rule 1: nothing outside a plugin names a plugin's files.
    const names = all.map((p) => p.name);
    const re = new RegExp(`plugins/(${names.map((n) => n.replace(/[-]/g, "\\-")).join("|")})/`); // lang-regex-ok: file paths in code
    if (names.length) {
      const walk = (dir) => {
        let ents = [];
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          const f = path.join(dir, e.name);
          if (e.isDirectory()) { if (!["node_modules", ".git", "data", "logs", "plugins", "local"].includes(e.name)) walk(f); continue; }
          if (!/\.(m?js|cjs|sh|py)$/.test(e.name) && path.basename(dir) !== "bin") continue; // lang-regex-ok: file extensions
          let text = "";
          try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
          if (text.length > 3_000_000) continue;
          text.split("\n").forEach((line, i) => {
            if (re.test(line) && !line.includes("plugin-check-ok")) problems.push({ plugin: line.match(re)[1], problem: `${path.relative(TOOLS_DIR, f)}:${i + 1} names a plugin's file directly` });
          });
        }
      };
      for (const d of ["bin", "lib", "agent"]) walk(path.join(TOOLS_DIR, d));
    }
  }
  return problems;
}

/** Scheduled jobs no plugin owns yet: the control room's "Not a plugin yet" list. */
export function unowned(labels) {
  return labels.filter((l) => !P.ownerOf({ label: l }));
}
