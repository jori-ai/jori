// control/schedule.mjs — every recurring job on the host, read from where it
// is actually scheduled (the crontab and the user's launchd agents), and the
// only code the control room uses to change a schedule.
//
// Reads: `crontab -l` (bounded), ~/Library/LaunchAgents/<prefix>*.plist via
// plutil, `launchctl list`, the tail of data/cron-runs.jsonl.
// Writes: crontab lines only through bin/crontab-safe (it re-reads the whole
// crontab, refuses on a bad read, and recounts before installing); launchd
// through plutil + launchctl bootout/bootstrap, editing the tracked template
// under agent/launch-agents/ as well so a reinstall keeps the change.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { TOOLS_DIR, installTools } = require("../root.cjs");
const { localConfig } = require("../instance.cjs");

const PAUSE_MARK = "#PAUSED# ";
const FAMILY_PAUSE = /^#([A-Z]+PAUSE)#\s*/; // lang-regex-ok: crontab marker syntax, not language

export function settings() {
  return localConfig("control", {
    launchd_prefixes: ["com.jori.", "ai.jori.", "ai.claude."],
    launch_agents_dir: path.join(os.homedir(), "Library", "LaunchAgents"),
    runs_tail_bytes: 3_000_000,
  });
}

function sh(cmd, args, { timeout = 20_000, input } = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", timeout, input, stdio: ["pipe", "pipe", "pipe"] });
}

// ── cron expressions ─────────────────────────────────────────────────────

export function cronField(spec, lo, hi) {
  const set = new Set();
  for (const part of String(spec).split(",")) {
    let [range, step] = part.split("/");
    step = Number(step) || 1;
    let a = lo, b = hi;
    if (range !== "*") {
      if (range.includes("-")) [a, b] = range.split("-").map(Number);
      else { a = Number(range); b = step > 1 ? hi : a; }
    }
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error(`bad cron field: ${spec}`);
    for (let v = a; v <= b; v += step) set.add(hi === 6 && v === 7 ? 0 : v);
  }
  return set;
}

export function validCron(expr) {
  const f = String(expr || "").trim().split(/\s+/);
  if (f.length !== 5) return false;
  try {
    const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
    f.forEach((x, i) => {
      if (!/^[\d*,/-]+$/.test(x)) throw new Error("chars"); // lang-regex-ok: cron syntax
      for (const v of cronField(x, ranges[i][0], ranges[i][1])) if (v < ranges[i][0] || v > ranges[i][1]) throw new Error("range");
    });
    return true;
  } catch {
    return false;
  }
}

// ── crontab ──────────────────────────────────────────────────────────────

export function readCrontab() {
  return sh("crontab", ["-l"]);
}

// One crontab line → a job, or null for comments/env lines.
export function parseCronLine(raw) {
  let line = raw.trim();
  if (!line) return null;
  let paused = null;
  if (line.startsWith(PAUSE_MARK.trim())) { paused = "PAUSED"; line = line.slice(PAUSE_MARK.trim().length).trim(); }
  else {
    const fam = line.match(FAMILY_PAUSE);
    if (fam) { paused = fam[1]; line = line.slice(fam[0].length); }
    else if (line.startsWith("#")) return null;
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(line)) return null; // lang-regex-ok: env assignment syntax
  const parts = line.split(/\s+/);
  if (parts.length < 6 || !validCron(parts.slice(0, 5).join(" "))) return null;
  const lab = line.match(/--label\s+(\S+)/); // lang-regex-ok: cron-run flag
  const label = lab ? lab[1] : null;
  const name = (label || path.basename(parts[5])).replace(/^trigger-/, "");
  return {
    id: `cron:${label || name}`,
    name,
    label,
    source: "cron",
    schedule: parts.slice(0, 5).join(" "),
    command: parts.slice(5).join(" "),
    paused,
    tag: label ? `--label ${label} --` : null,
    line: raw.trim(),
  };
}

export function cronJobs(text = readCrontab()) {
  return text.split("\n").map(parseCronLine).filter(Boolean);
}

// Replace the one crontab line carrying `tag` with `newLine`, through
// crontab-safe. Refuses when the tag is on more than one line (a retired,
// commented copy would be dropped with it).
export function replaceCronLine(tag, newLine) {
  if (!tag) throw new Error("this job has no --label, so it cannot be edited safely");
  if (!newLine.includes(tag)) throw new Error("the new line lost its label");
  const lines = readCrontab().split("\n").filter((l) => l.includes(tag));
  if (lines.length !== 1) throw new Error(`expected one crontab line with ${tag}, found ${lines.length}`);
  sh(path.join(TOOLS_DIR, "bin", "crontab-safe"), ["replace", tag, newLine], { timeout: 60_000 });
}

export function setCronSchedule(job, expr) {
  if (!validCron(expr)) throw new Error(`not a valid schedule: ${expr}`);
  const prefix = job.paused === "PAUSED" ? PAUSE_MARK : job.paused ? `#${job.paused}# ` : "";
  const newLine = `${prefix}${expr.trim().split(/\s+/).join(" ")} ${job.command}`;
  replaceCronLine(job.tag, newLine);
  return newLine;
}

export function setCronPaused(job, paused) {
  if (job.paused && job.paused !== "PAUSED") throw new Error(`paused as part of the ${job.paused} family; switch the family instead`);
  const newLine = `${paused ? PAUSE_MARK : ""}${job.schedule} ${job.command}`;
  replaceCronLine(job.tag, newLine);
  return newLine;
}

// Family switch: every `#FAMILY#` line on or off, via cron-unpause / crontab-safe.
export function setFamilyPaused(family, paused) {
  if (!/^[A-Z]+PAUSE$/.test(family)) throw new Error("bad family"); // lang-regex-ok: marker syntax
  const jobs = cronJobs().filter((j) => j.tag && (paused ? !j.paused : j.paused === family));
  for (const j of jobs) {
    replaceCronLine(j.tag, `${paused ? `#${family}# ` : ""}${j.schedule} ${j.command}`);
  }
  return jobs.length;
}

export function runCronNow(job) {
  const child = spawn("/bin/sh", ["-c", job.command], { detached: true, stdio: "ignore", cwd: installTools() });
  child.unref();
}

// ── launchd ──────────────────────────────────────────────────────────────

function uid() {
  return process.getuid ? process.getuid() : Number(sh("id", ["-u"]).trim());
}

export function plistJson(file) {
  return JSON.parse(sh("plutil", ["-convert", "json", "-o", "-", file]));
}

export function loadedLabels() {
  try {
    return new Set(sh("launchctl", ["list"]).split("\n").map((l) => l.split("\t")[2]).filter(Boolean));
  } catch {
    return new Set();
  }
}

export function launchdJobs() {
  const { launchd_prefixes: prefixes, launch_agents_dir: dir } = settings();
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return []; }
  const loaded = loadedLabels();
  const out = [];
  for (const f of files.filter((x) => x.endsWith(".plist") && prefixes.some((p) => x.startsWith(p))).sort()) {
    const file = path.join(dir, f);
    let p;
    try { p = plistJson(file); } catch { continue; }
    const label = p.Label || f.replace(/\.plist$/, "");
    const prefix = prefixes.find((x) => label.startsWith(x)) || "";
    let schedule;
    if (p.StartCalendarInterval) schedule = { calendar: [].concat(p.StartCalendarInterval) };
    else if (p.StartInterval) schedule = { every: p.StartInterval };
    else if (p.KeepAlive && p.KeepAlive !== false) schedule = { service: true };
    else schedule = { onDemand: true };
    out.push({
      id: `launchd:${label}`,
      name: label.slice(prefix.length),
      label,
      source: "launchd",
      schedule,
      command: (p.ProgramArguments || [p.Program]).filter(Boolean).join(" "),
      loaded: loaded.has(label),
      paused: loaded.has(label) ? null : "UNLOADED",
      file,
      template: fs.existsSync(path.join(TOOLS_DIR, "agent", "launch-agents", f)) ? path.join(TOOLS_DIR, "agent", "launch-agents", f) : null,
    });
  }
  return out;
}

function reload(job) {
  const domain = `gui/${uid()}`;
  try { sh("launchctl", ["bootout", domain, job.file]); } catch { /* not loaded */ }
  sh("launchctl", ["bootstrap", domain, job.file]);
}

// calendar: [{Hour, Minute, Weekday?, Day?}] or { every: seconds }
export function setLaunchdSchedule(job, sched) {
  const files = [job.file, job.template].filter(Boolean);
  for (const f of files) {
    if (sched.every) {
      const n = Number(sched.every);
      if (!Number.isInteger(n) || n < 60) throw new Error("interval must be at least 60 seconds");
      try { sh("plutil", ["-remove", "StartCalendarInterval", f]); } catch {}
      sh("plutil", ["-replace", "StartInterval", "-integer", String(n), f]);
    } else {
      const cal = [].concat(sched.calendar || []).map((e) => {
        const o = {};
        for (const k of ["Minute", "Hour", "Weekday", "Day", "Month"]) if (e[k] != null && e[k] !== "") o[k] = Number(e[k]);
        if (o.Minute == null || o.Minute < 0 || o.Minute > 59) throw new Error("each time needs a minute");
        return o;
      });
      if (!cal.length) throw new Error("no times given");
      try { sh("plutil", ["-remove", "StartInterval", f]); } catch {}
      sh("plutil", ["-replace", "StartCalendarInterval", "-json", JSON.stringify(cal.length === 1 ? cal[0] : cal), f]);
    }
  }
  if (job.loaded) reload(job);
}

export function setLaunchdPaused(job, paused) {
  const target = `gui/${uid()}/${job.label}`;
  if (paused) {
    try { sh("launchctl", ["bootout", `gui/${uid()}`, job.file]); } catch {}
    try { sh("launchctl", ["disable", target]); } catch {}
  } else {
    try { sh("launchctl", ["enable", target]); } catch {}
    sh("launchctl", ["bootstrap", `gui/${uid()}`, job.file]);
  }
}

export function runLaunchdNow(job) {
  if (!job.loaded) throw new Error("this agent is not loaded; resume it first");
  sh("launchctl", ["kickstart", `gui/${uid()}/${job.label}`]);
}

// ── run history ──────────────────────────────────────────────────────────

export function recentRuns() {
  const file = installTools("data", "cron-runs.jsonl");
  let text = "";
  try {
    const st = fs.statSync(file);
    const n = Math.min(st.size, settings().runs_tail_bytes);
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, st.size - n);
    fs.closeSync(fd);
    text = buf.toString("utf8");
  } catch {
    return {};
  }
  const by = {};
  for (const l of text.split("\n").slice(1)) {
    if (!l) continue;
    try {
      const r = JSON.parse(l);
      (by[r.label] ||= []).push({ start: r.start, ms: r.duration_ms, exit: r.exit });
    } catch {}
  }
  for (const k of Object.keys(by)) by[k] = by[k].slice(-30);
  return by;
}

export function allJobs() {
  let cron = [];
  let cronError = null;
  try { cron = cronJobs(); } catch (e) { cronError = e.message; }
  return { jobs: [...cron, ...launchdJobs()], cronError };
}

export function findJob(id) {
  return allJobs().jobs.find((j) => j.id === id) || null;
}
