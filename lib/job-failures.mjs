// job-failures.mjs — notice a recurring job that keeps failing, say so once,
// and queue it for repair.
//
// Every cron/launchd job started through bin/cron-run leaves a line in
// data/cron-runs.jsonl with its exit code. Before this, nothing read those
// exits: on 2026-11-04 eight jobs had failed every run for four days unseen
// (one re-summarised the same call with Sonnet every 30 minutes). Now
// bin/job-failure-watch (cron, every 30 min) calls `scan()`:
//   - a job whose last `streak` runs (default 3) all failed opens an incident:
//     one system-channel alert with the error from its log, and one repair
//     item in data/job-repair-queue.json (the job-repair playbook drains it);
//   - the first successful run after that closes it with one "works again".
// Settings: agent/local/config/job-failure-watch.json (defaults below).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { installTools } = require("./root.cjs");
const { localConfig } = require("./instance.cjs");

export const DEFAULTS = {
  streak: 3,            // consecutive failed runs before an incident opens
  max_age_days: 8,      // a job whose last run is older than this is retired, not failing
  repair: true,         // queue a repair item for each new incident
  repairs_per_day: 4,   // all jobs together
  ignore: [],           // labels never reported
};

export function settings() {
  return localConfig("job-failure-watch", DEFAULTS);
}

const P = {
  runs: () => process.env.JORI_CRON_RUNS || installTools("data", "cron-runs.jsonl"),
  state: () => process.env.JORI_JOB_FAILURE_STATE || installTools("data", "job-failure-state.json"),
  queue: () => process.env.JORI_JOB_REPAIR_QUEUE || installTools("data", "job-repair-queue.json"),
};

const readJson = (f, d) => {
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; }
};
const writeJson = (f, o) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(o, null, 2) + "\n");
  fs.renameSync(tmp, f);
};

export const failed = (r) => r.exit !== 0 || !!r.signal;

/** The tail of cron-runs.jsonl, grouped by label, oldest first. */
export function runsByLabel(file = P.runs(), tailBytes = 4_000_000) {
  let text = "";
  try {
    const st = fs.statSync(file);
    const n = Math.min(st.size, tailBytes);
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, st.size - n);
    fs.closeSync(fd);
    text = buf.toString("utf8");
    if (n < st.size) text = text.slice(text.indexOf("\n") + 1);
  } catch {
    return {};
  }
  const by = {};
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (r.label) (by[r.label] ||= []).push(r);
    } catch {}
  }
  return by;
}

/** How many runs at the end of `runs` failed in a row. */
export function trailingFailures(runs) {
  let n = 0;
  for (let i = runs.length - 1; i >= 0 && failed(runs[i]); i--) n++;
  return n;
}

// The log a job writes to: the command's `>> file` redirect, else the launchd
// plist's StandardErrorPath for the same label (read by the caller).
export function logFileOf(cmd) {
  const m = String(cmd || "").match(/>>?\s*([^\s'"]+\.log)\b/); // lang-regex-ok: shell redirect syntax in a command line
  return m ? m[1] : null;
}

/** The last `lines` lines of a log, and the line most likely to be the error. */
export function logTail(file, lines = 30) {
  if (!file) return { tail: "", error: "" };
  let text = "";
  try {
    const st = fs.statSync(file);
    const n = Math.min(st.size, 64_000);
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, st.size - n);
    fs.closeSync(fd);
    text = buf.toString("utf8");
  } catch {
    return { tail: "", error: "" };
  }
  const all = text.split("\n").map((l) => l.trimEnd()).filter(Boolean);
  const tail = all.slice(-lines);
  // Program output, not anyone's words: the last line that reads like an error.
  const error = [...tail].reverse().find((l) => /error|fatal|failed|exception|not a function|denied|refused|\b40[13]\b|\b5\d\d\b|cannot|unable/i.test(l)) || tail.at(-1) || ""; // lang-regex-ok: error markers in program logs, not user language
  return { tail: tail.join("\n"), error: error.slice(0, 300) };
}

/**
 * Compare the run log with the open incidents. Pure apart from reading the
 * files given; returns what to do and the next state, writes nothing.
 *   runs:    { label: [run…] }    state: { incidents: { label: {...} } }
 *   logs:    label → log file path (or null)
 */
export function evaluate({ runs, state, logs = {}, cfg = settings(), now = Date.now() }) {
  const incidents = { ...(state.incidents || {}) };
  const open = [], closed = [];
  const maxAge = cfg.max_age_days * 86400e3;
  for (const [label, rs] of Object.entries(runs)) {
    if (cfg.ignore.includes(label) || !rs.length) continue;
    const last = rs.at(-1);
    const age = now - Date.parse(last.end || last.start);
    const n = trailingFailures(rs);
    const cur = incidents[label];
    if (!failed(last)) {
      if (cur) { closed.push({ label, ...cur, recovered_at: last.end || last.start }); delete incidents[label]; }
      continue;
    }
    if (age > maxAge) continue;
    if (n >= cfg.streak && !cur) {
      const since = rs[rs.length - n].start;
      const { tail, error } = logTail(logs[label] || logFileOf(last.cmd));
      const inc = { since, streak: n, exit: last.exit, signal: last.signal || null, cmd: last.cmd, log_file: logs[label] || logFileOf(last.cmd) || null, error, opened_at: new Date(now).toISOString() };
      incidents[label] = inc;
      open.push({ label, ...inc, log_tail: tail });
    } else if (cur) {
      incidents[label] = { ...cur, streak: n, exit: last.exit };
    }
  }
  return { open, closed, state: { ...state, incidents, checked_at: new Date(now).toISOString() } };
}

// ── repair queue ──────────────────────────────────────────────────────────

export function loadQueue() {
  return readJson(P.queue(), { pending: [], history: [] });
}
export function saveQueue(q) {
  writeJson(P.queue(), q);
}
export function loadState() {
  return readJson(P.state(), { incidents: {} });
}
export function saveState(s) {
  writeJson(P.state(), s);
}

/** Queue a repair for an opened incident, within the daily cap. */
export function enqueue(q, inc, { cfg = settings(), now = Date.now() } = {}) {
  if (q.pending.some((p) => (p.label === inc.label || (p.also || []).includes(inc.label)) && p.status !== "done")) return { ok: false, reason: "already queued" };
  const day = new Date(now).toISOString().slice(0, 10);
  const today = [...q.pending, ...q.history].filter((p) => String(p.queued_at || "").startsWith(day)).length;
  if (today >= cfg.repairs_per_day) return { ok: false, reason: "daily repair cap reached" };
  const item = {
    id: crypto.randomBytes(4).toString("hex"), label: inc.label, also: inc.also || [], cmd: inc.cmd, log_file: inc.log_file, exit: inc.exit,
    since: inc.since, error: inc.error, log_tail: inc.log_tail, status: "pending", queued_at: new Date(now).toISOString(),
  };
  q.pending.push(item);
  return { ok: true, item };
}

export function claimNext(q, now = Date.now()) {
  const item = q.pending.find((p) => p.status === "pending" || (p.status === "claimed" && now - Date.parse(p.claimed_at) > 2 * 3600e3));
  if (!item) return null;
  item.status = "claimed";
  item.claimed_at = new Date(now).toISOString();
  return item;
}

export const OUTCOMES = ["repaired", "needs_owner", "transient", "failed"];
export function finish(q, id, { outcome, note = "", commit = null, owner_action = null }, now = Date.now()) {
  if (!OUTCOMES.includes(outcome)) throw new Error(`outcome must be one of ${OUTCOMES.join(", ")}`);
  const i = q.pending.findIndex((p) => p.id === id);
  if (i < 0) throw new Error(`no queued repair ${id}`);
  const [item] = q.pending.splice(i, 1);
  const done = { ...item, status: "done", outcome, note, commit, owner_action, done_at: new Date(now).toISOString() };
  delete done.log_tail;
  q.history = [...(q.history || []), done].slice(-200);
  return done;
}

export function hostName() {
  return os.hostname();
}
