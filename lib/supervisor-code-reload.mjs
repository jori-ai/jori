// supervisor-code-reload — put each supervisor back on the code that is on disk.
//
// A supervisor imports its .mjs once, at Node start (architecture.md § Deploy
// Model). Committing a fix under agent/supervisor/ changes nothing until
// that process restarts, and until 2026-10-11 nothing restarted it:
// self-improve-approval-poll applies, commits and confirms an approved fix and
// stops there. Measured 2026-10-11: all four supervisors had been up for three
// days, so two committed fixes (a turn watchdog and a network-env change) had
// never run, and under the old watchdog the user's own correction email was
// killed twice mid-work and dropped.
//
// watchdog.sh runs this every tick. For each supervisor, least critical first:
// if the newest file in its import closure is newer than the running process,
// and it is safe right now, SIGTERM it and let process-manager respawn it on the
// new code. Safe means ALL of:
//   - no uncommitted edits in the closure: the tree is shared, never load
//     another session's half-finished edit
//   - `node --check` passes on every file in the closure
//   - its /health shows nothing in flight, nothing queued, no background task,
//     and no activity for QUIET_MS (20 min: an async subagent or a
//     run_in_background task streams nothing, and neither supervisor's /health
//     reports liveBackgroundTasks yet, so silence must outlast
//     BACKGROUND_TASK_MAX_AGE_MS);
//     chat also no fork or tool running. Re-read right before the signal.
//   - not on a five-minute boundary, when cron dispatches land
//   - nothing else reloaded in this run (one supervisor per tick)
//   - not already reloaded for this same code stamp (a respawn that somehow
//     still reads older than its code must not loop)
//   - the previous reload came back healthy (up 10 min on the new code): a
//     change that passes `node --check` but dies at load stops at the first,
//     least critical supervisor instead of walking through all four
// A hold is a log line (written when its reason changes), never a page. Two
// conditions are worth a page, and watchdog.sh (the only authorized author)
// sends it from this tool's exit code: 3 = a reloaded supervisor did not come
// back, 4 = a supervisor has stayed on stale code for STALE_PAGE_MS. Out of process
// on purpose: an in-supervisor self-reload would need one manual restart to
// bootstrap, and could never load a fix to its own reload code.
//
// hum-sense is a fifth target (2026-10-20): its log-spam fix landed 20 minutes
// after it started, and nothing restarted it for a week. Same rules, plus its own: its closure includes the
// sensors it import()s by name from agent/scripts/hum-sensors; launchd
// (not process-manager) owns it, so the pid comes from `launchctl print` and the
// restart is `launchctl kickstart -k`; and it is restarted only between passes.
// Its loop writes the heartbeat right after a pass has saved its state, then
// sleeps tick_sec; inside that sleep (heartbeat younger than tick_sec minus a
// 3 s margin) there is no pass, dispatch or spool drain to cut short, and an
// event pushed meanwhile waits in the on-disk spool for the next process. Any
// child process (a hum turn, a sensor) also holds. For every target, code that
// changed under CODE_QUIET_MS ago or a rebase/merge/index lock in the tree holds.
// Exit 5 = some target is still on old code (or unreadable) but nothing is due a
// page: watchdog.sh must neither page nor clear on it, so a "recovered" line is
// only ever sent once every target really runs the code on disk (exit 0).
// --report prints a read-only JSON view for `jori doctor`, including the
// report-only daemons (wiki servers, whatsapp-channel, phone-channel) and the
// tracked files left uncommitted, aged by the first-sighting ledger each acting
// run keeps in its state file.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { writeFileAtomic } from "./atomic-write.js";
import { createRequire } from "node:module";

const { KERNEL_SUBDIR, installRoot } = createRequire(import.meta.url)("./root.cjs");

const ROOT = process.env.JORI_ROOT || installRoot();
const SUP_DIR = path.join(ROOT, "agent/supervisor");
const STATE_FILE = path.join(ROOT, "data/supervisor-code-reload-state.json");
const PM_HEALTH = "http://127.0.0.1:9095/health";

export const QUIET_MS = 20 * 60_000;           // = BACKGROUND_TASK_MAX_AGE_MS in index.mjs
export const SETTLE_MS = 10 * 60_000;          // a reloaded supervisor must be up this long before the next
export const COMEBACK_MS = 4 * 60_000;         // ...and must be back within this
export const SETTLE_DEADLINE_MS = 30 * 60_000; // ...and settled within this, or it is crash-looping
export const STALE_PAGE_MS = 6 * 3_600_000;    // stale and held this long -> exit 4

// Least critical first, so a bad respawn shows on a cron tier before chat.
export const SUPERVISORS = [
  { agent: "ops-haiku", child: "ops-haiku-supervisor", entry: "index.mjs" },
  { agent: "ops-light", child: "ops-light-supervisor", entry: "index.mjs" },
  { agent: "ops", child: "ops-supervisor", entry: "index.mjs" },
  { agent: "chat", child: "chat-supervisor", entry: "chat-supervisor.mjs" },
];
export const HUM_SENSE = { agent: "hum-sense", kind: "launchd", label: "ai.claude.hum-sense",
  entry: "bin/hum-sense", extraDirs: ["agent/scripts/hum-sensors"] };
const HUM_HEARTBEAT = path.join(ROOT, "data/hum-sense-heartbeat.json");
const HUM_REGISTRY = path.join(ROOT, "data/hum-sensors.json");
export const PASS_MARGIN_MS = 3_000;
export const CODE_QUIET_MS = 2 * 60_000;

// Any relative code-file string literal: covers `import`, `import()`, `require`,
// `require_` and `createRequire(import.meta.url)("../lib/x.js")`, all of which
// the supervisors use. Over-matching a path that is not an import only adds a
// file to the stamp (at worst one extra idle reload); missing one would leave a
// fix unloaded. Machine structure, not language.
const SPEC_RE = /["'](\.{1,2}\/[^"'\s]+\.(?:mjs|cjs|js))["']/g; // lang-regex-ok: relative module paths in source code
// Repo-rooted loads, e.g. import(path.join(JORI_ROOT, "lib/triage-log.js")).
// The kernel tree is tools/ here and the repo root in a root-layout install,
// where a rooted path starts with one of the tree's own code dirs.
const ROOTED_PREFIX = KERNEL_SUBDIR ? `${KERNEL_SUBDIR}\\/` : "(?:lib|agent|bin|scripts)\\/";
const ROOTED_RE = new RegExp(`["'](${ROOTED_PREFIX}[^"'\\s]+\\.(?:mjs|cjs|js))["']`, "g"); // lang-regex-ok: repo-relative module paths in source code

// Every local file the entry loads, transitively (packages under node_modules
// are not followed: they change only with a deliberate install).
export function importClosure(entry, root = ROOT) {
  const seen = new Set();
  const stack = [path.resolve(entry)];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    let src;
    try { src = fs.readFileSync(f, "utf8"); } catch { continue; }
    seen.add(f);
    const found = [...src.matchAll(SPEC_RE)].map((m) => path.resolve(path.dirname(f), m[1]))
      .concat([...src.matchAll(ROOTED_RE)].map((m) => path.resolve(root, m[1])));
    for (const p of found) if (!p.includes(`${path.sep}node_modules${path.sep}`)) stack.push(p);
  }
  return [...seen].sort();
}

export function codeStamp(files) {
  let max = 0, newest = null;
  for (const f of files) {
    try { const m = fs.statSync(f).mtimeMs; if (m > max) { max = m; newest = f; } } catch {}
  }
  return { stampMs: max, newest };
}

// Pure decision. `sups` items: { agent, startedMs, health, stampMs, dirty, checkOk }.
// Returns { reload: {agent, reason} | null, holds: [{agent, reason}] }.
export function decide({ now, sups, state = {}, gitBusy = null }) {
  const holds = [];
  let reload = null;
  const p = unsettled({ now, sups, state });
  const pending = p && !p.settled ? p : null;
  for (const s of sups) {
    if (!s.health || !s.startedMs || !s.stampMs) continue;   // down or unreadable: watchdog's own checks own that
    if (s.startedMs >= s.stampMs) continue;                  // already on the code on disk
    const hold = (reason) => holds.push({ agent: s.agent, reason });
    if (reload) { hold("one reload per tick"); continue; }
    if (pending) { hold(`waiting for ${pending.agent} to settle after its reload`); continue; }
    if (s.dirty) { hold("uncommitted edits in its code"); continue; }
    if (!s.checkOk) { hold("node --check fails on its code"); continue; }
    if (state[s.agent]?.stampMs === s.stampMs) { hold("already reloaded for this code once"); continue; }
    if (now - s.stampMs < CODE_QUIET_MS) { hold("code changed under 2 minutes ago"); continue; }
    if (gitBusy) { hold(gitBusy); continue; }
    if (now.getMinutes() % 5 === 0) { hold("cron boundary minute"); continue; }
    const busy = busyReason(s.agent, s.health, now.getTime());
    if (busy) { hold(busy); continue; }
    reload = { agent: s.agent, reason: `running since ${new Date(s.startedMs).toISOString()}, code changed ${new Date(s.stampMs).toISOString()}` };
  }
  return { reload, holds };
}

// The last reload that has not yet proven itself (back up on new code and
// SETTLE_MS old). Returns { agent, settled: true } the first time it has, so
// main() can mark it and a later, unrelated outage of that supervisor is never
// blamed on this tool; { agent, failed } once it is past COMEBACK_MS and not back,
// or past SETTLE_DEADLINE_MS without ever staying up SETTLE_MS: a daemon that
// crashes at load is respawned by launchd every 30 s, so a pid is usually
// there and "not back" alone would never fire.
export function unsettled({ now, sups, state }) {
  const last = Object.entries(state).filter(([k, v]) => !k.startsWith("_") && v && v.at && !v.settled)
    .sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at))[0];
  if (!last) return null;
  const [agent, rec] = last;
  const at = Date.parse(rec.at);
  const s = sups.find((x) => x.agent === agent);
  const back = !!(s?.health && s.startedMs > at);
  if (back && now - s.startedMs >= SETTLE_MS) return { agent, settled: true };
  return { agent, failed: (!back && now - at > COMEBACK_MS) || now - at > SETTLE_DEADLINE_MS };
}

// The ops-tier supervisors persist their queue to data/dispatcher-queue*.json
// (queue-persist.mjs) and replay it at boot. chat keeps its queue in memory only,
// so a chat restart would drop what is queued: chat always holds on a queue.
const DURABLE_QUEUE = new Set(["ops", "ops-light", "ops-haiku"]);

// A queue that cannot run because dispatch is held for the Claude usage limit
// (/health rateLimitHoldUntil still ahead) is not work a reload would cut short:
// nothing is dispatching, and for a durable-queue supervisor the queue survives
// the restart. Holding on it deadlocks: the queue drains only when the hold
// lifts, so a committed fix to the hold itself could not load until the reset
// the refusal named, up to a day away (a fix sat inert behind
// "ops: stale, holding (8 queued)"). Every other gate still applies.
export function heldQueue(agent, h, nowMs = Date.now()) {
  return DURABLE_QUEUE.has(agent) && Date.parse(h?.rateLimitHoldUntil || "") > nowMs;
}

export function busyReason(agent, h, nowMs = Date.now()) {
  if (agent === "hum-sense") {
    if (h.children) return `${h.children} child process(es) running`;
    const b = h.sinceBeatMs;   // null (no running heartbeat from this pid) must never read as 0
    if (typeof b !== "number" || !(b >= 0 && b < h.windowMs)) return "mid-pass (not in the sleep after a heartbeat)";
    return null;
  }
  if (h.inFlight) return "turn in flight";
  if ((h.queueDepth || 0) > 0 && !heldQueue(agent, h, nowMs)) return `${h.queueDepth} queued`;
  if ((h.liveBackgroundTasks || 0) > 0) return `${h.liveBackgroundTasks} background task(s) running`;
  if (typeof h.lastEventAgeMs !== "number") return "no activity reading";
  if (h.lastEventAgeMs < QUIET_MS) return `active ${Math.round(h.lastEventAgeMs / 60_000)} min ago`;
  if (agent === "chat") {
    if ((h.forksActive || 0) > 0) return "fork running";
    if (Array.isArray(h.activeTools) && h.activeTools.length) return "tool running";
    if (h.chatAgentStatus && h.chatAgentStatus !== "idle") return `chat agent ${h.chatAgentStatus}`;
  }
  return null;
}

// A fresh connection per read, never a pooled one. main() blocks the event loop
// between the first health read and the re-check (git status + node --check,
// all synchronous: 3 s from a shell, 9-25 s under cron's background priority),
// and the supervisors' HTTP servers close an idle keep-alive socket after 5 s.
// fetch() keeps the first read's socket in its pool and hands it back for the
// re-check after it is already dead, so the re-check fails at once with
// ECONNRESET. On 2026-10-11 that was every re-check, 164 of 164, and no
// supervisor was reloaded in 7 h.
export function getJson(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let req;
    try {
      req = http.get(url, { agent: false, timeout: timeoutMs }, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); return resolve(null); }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { body += c; });
        res.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
        res.on("error", () => resolve(null));
      });
    } catch { return resolve(null); }   // a malformed URL (bad port in agents.json) throws synchronously
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => resolve(null));
  });
}

function healthPorts() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "agent/config/agents.json"), "utf8"));
    return Object.fromEntries(Object.entries(cfg.agents || {}).map(([k, v]) => [k, v?.supervisor?.healthPort]));
  } catch { return {}; }
}

function isDirty(files) {
  try {
    return execFileSync("git", ["-C", ROOT, "status", "--porcelain", "--", ...files], { encoding: "utf8", timeout: 20_000 }).trim() !== "";
  } catch { return true; }   // can't tell: treat as dirty, hold
}

function checksPass(files) {
  for (const f of files) {
    try { execFileSync(process.execPath, ["--check", f], { stdio: "ignore", timeout: 20_000 }); } catch { return false; }
  }
  return true;
}

function readState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; } }
// Atomic: watchdog.sh jq-reads ._failed from this file every tick (D15).
function writeState(st) { try { writeFileAtomic(STATE_FILE, JSON.stringify(st, null, 2) + "\n"); } catch {} }
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };

// Local time, to match the rest of watchdog.log.
const stamp = () => new Date().toLocaleString("sv-SE", { hour12: false }).slice(0, 19);
const say = (msg) => console.log(`${stamp()} [supervisor-code-reload] ${msg}`);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function isSupervisorPid(pid, entry, agent) {
  let argv = [];
  try { argv = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim().split(/\s+/); } catch {} // lang-regex-ok: ps argv whitespace
  const i = argv.indexOf("--agent");
  return argv.includes(path.join(SUP_DIR, entry)) && i >= 0 && argv[i + 1] === agent;
}

// `LC_ALL=C ps -axww -o pid=,ppid=,lstart=,command=` -> [{pid, ppid, startedMs, argv}];
// lstart is five fields of local time, whole seconds.
export function parsePs(text) {
  return String(text || "").split("\n").map((l) => l.trim().split(/\s+/)) // lang-regex-ok: ps output columns
    .filter((t) => t.length >= 8)
    .map((t) => ({ pid: Number(t[0]), ppid: Number(t[1]), startedMs: Date.parse(t.slice(2, 7).join(" ")), argv: t.slice(7) }))
    .filter((r) => Number.isInteger(r.pid) && Number.isFinite(r.startedMs));
}

// hum-sense as a reload target. `pid` is launchd's; the heartbeat is the one its
// loop writes after each pass. startedMs rounds lstart UP, so a respawn in the
// same second as the reload stamp still reads as after it.
export function humSenseView({ pid, rows, heartbeat, tickSec, nowMs, root = ROOT }) {
  const r = pid ? rows.find((x) => x.pid === pid) : null;
  if (!r || !r.argv.includes(path.join(root, HUM_SENSE.entry)) || !r.argv.includes("daemon")) return { pid: null, health: null, startedMs: 0 };
  const sinceBeatMs = heartbeat?.pid === pid && heartbeat.status === "running" ? nowMs - Date.parse(heartbeat.ts) : null;
  return { pid, startedMs: r.startedMs + 999, health: {
    children: rows.filter((x) => x.ppid === pid).length, sinceBeatMs,
    windowMs: Math.max(2, tickSec ?? 10) * 1000 - PASS_MARGIN_MS } };
}

export function closureWithDirs(entry, dirs = [], root = ROOT) {
  const roots = [entry];
  for (const d of dirs) {
    let names = [];
    try { names = fs.readdirSync(path.join(root, d)); } catch {}
    for (const n of names.sort()) if (n.endsWith(".mjs") || n.endsWith(".js")) roots.push(path.join(root, d, n));
  }
  return [...new Set(roots.flatMap((r) => importClosure(r, root)))].sort();
}

export function gitBusy(root = ROOT) {
  for (const f of ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "index.lock"]) {
    if (fs.existsSync(path.join(root, ".git", f))) return `git operation in progress (.git/${f})`;
  }
  return null;
}

// `git status --porcelain=v1 -z` -> paths (a rename's source path follows it; skipped).
export function porcelainPaths(text) {
  const f = String(text || "").split("\0"), out = [];
  for (let i = 0; i < f.length; i++) {
    if (f[i].length < 4) continue;
    out.push(f[i].slice(3));
    if (f[i][0] === "R" || f[i][0] === "C") i++;
  }
  return out;
}

// First sighting of each tracked file left modified, kept only while it stays
// dirty against the SAME committed blob, so a commit in between restarts its
// clock and an age is never overstated. File times cannot do this: every
// autostash pull rewrites the mtime and birth time of each dirty file (three
// times on 2026-10-20 alone).
export function dirtyLedger({ paths, blobs, prev = {}, nowIso }) {
  const next = {};
  for (const p of paths) next[p] = prev[p] && prev[p].head === (blobs[p] ?? null) ? prev[p] : { since: nowIso, head: blobs[p] ?? null };
  return next;
}

export function realIo() {
  const git = (args) => execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", timeout: 20_000,
    stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  return {
    getJson, healthPorts, isDirty, checksPass, readState, writeState, readJson, say, alive, isSupervisorPid, git,
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    kill: (pid, sig) => process.kill(pid, sig),
    gitBusy: () => gitBusy(ROOT),
    statMs: (f) => fs.statSync(f).mtimeMs,
    // Short timeouts and no throw: these run every tick, and a hang here must
    // cost hum-sense one tick ("unknown, hold"), never the supervisors.
    ps: () => { try { return execFileSync("ps", ["-axww", "-o", "pid=,ppid=,lstart=,command="], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" } }); } catch { return null; } },
    launchdPid: (label) => {
      try {
        const out = execFileSync("launchctl", ["print", `gui/${process.getuid()}/${label}`], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });
        for (const l of out.split("\n")) { const t = l.trim().split(" = "); if (t[0] === "pid" && Number(t[1]) > 0) return Number(t[1]); }
      } catch {}
      return null;
    },
    kickstart: (label) => execFileSync("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/${label}`], { stdio: "ignore", timeout: 30_000 }),
  };
}

// Unreadable (ps or launchctl failed, hung or threw) reads as "not running":
// no reload, exit 5, and the supervisor targets carry on.
function humSenseNow(io) {
  try {
    const pid = io.launchdPid(HUM_SENSE.label);
    const ps = io.ps();
    if (!pid || ps == null) return { pid: null, health: null, startedMs: 0 };
    return humSenseView({ pid, rows: parsePs(ps), heartbeat: io.readJson(HUM_HEARTBEAT),
      tickSec: io.readJson(HUM_REGISTRY)?.config?.tick_sec, nowMs: io.now().getTime() });
  } catch { return { pid: null, health: null, startedMs: 0 }; }
}

// Exit code for watchdog.sh: 0 every target on the code on disk, 3 a reload did
// not come back, 4 stale too long, 5 something stale or unreadable, no page due.
export async function main(argv = [], io = realIo()) {
  if (argv.includes("--report")) { console.log(JSON.stringify(report(io), null, 2)); return 0; }
  const dryRun = argv.includes("--dry-run");
  const pm = await io.getJson(PM_HEALTH);
  if (!pm) return 5;                                 // process-manager down: watchdog.sh handles that, and a SIGTERM would not respawn
  const ports = io.healthPorts();
  const closures = {};
  // hum-sense first: least critical, since hum falls back to a cron tick while it is down.
  const hsFiles = closureWithDirs(path.join(ROOT, HUM_SENSE.entry), HUM_SENSE.extraDirs);
  const sups = [{ ...HUM_SENSE, ...humSenseNow(io), files: hsFiles, stampMs: codeStamp(hsFiles).stampMs }];
  for (const s of SUPERVISORS) {
    const health = ports[s.agent] ? await io.getJson(`http://127.0.0.1:${ports[s.agent]}/health`) : null;
    const startedMs = health?.startedAt ? Date.parse(health.startedAt) : 0;
    const files = closures[s.entry] ||= importClosure(path.join(SUP_DIR, s.entry));
    const { stampMs } = codeStamp(files);
    sups.push({ ...s, health, startedMs, stampMs, files });
  }
  // The expensive checks only run when something is actually stale.
  for (const s of sups) {
    if (!s.health || !s.startedMs || s.startedMs >= s.stampMs) continue;
    s.dirty = io.isDirty(s.files);
    s.checkOk = !s.dirty && io.checksPass(s.files);
  }
  const state = io.readState();
  const now = io.now();
  const held = state._held || {};
  const staleSince = state._stale_since || {};
  let code = 0;

  // A previous reload that never came back: page (via exit 3) and stop.
  const pend = unsettled({ now, sups, state });
  if (pend?.settled && !dryRun) state[pend.agent].settled = true;
  if (pend?.failed) { io.say(`${pend.agent}: reloaded at ${state[pend.agent].at} and not back on new code; holding every reload`); code = 3; }
  // watchdog.sh names it in the exit-3 page, so a night push says WHICH one.
  state._failed = pend?.failed ? (pend.agent === HUM_SENSE.agent ? "hum-sense" : `the ${pend.agent} supervisor`) : undefined;

  const { reload, holds } = decide({ now, sups, state, gitBusy: io.gitBusy() });
  const heldNow = {};
  for (const h of holds) {
    heldNow[h.agent] = h.reason;
    if (held[h.agent] !== h.reason) io.say(`${h.agent}: stale, holding (${h.reason})`);
  }
  for (const s of sups) {
    const stale = s.health && s.startedMs && s.startedMs < s.stampMs;
    if (!stale) { delete staleSince[s.agent]; continue; }
    // The clock runs from the first tick it was stale, not the newest landing.
    if (!staleSince[s.agent]) staleSince[s.agent] = { stampMs: s.stampMs, since: now.toISOString() };
    staleSince[s.agent].stampMs = s.stampMs;
    if (now - Date.parse(staleSince[s.agent].since) > STALE_PAGE_MS && heldNow[s.agent] && code === 0) {
      io.say(`${s.agent}: on code older than disk for over ${STALE_PAGE_MS / 3_600_000}h (${heldNow[s.agent]})`);
      code = 4;
    }
  }
  // Never 0 while any target is stale or unreadable, so watchdog.sh never clears early.
  if (code === 0 && sups.some((s) => !s.health || !s.startedMs || s.startedMs < s.stampMs)) code = 5;
  if (!dryRun) {
    try {
      const paths = porcelainPaths(io.git(["status", "--porcelain=v1", "-z", "--untracked-files=no"]));
      const blobs = {};
      if (paths.length) for (const l of io.git(["ls-tree", "-z", "HEAD", "--", ...paths]).split("\0").filter(Boolean)) blobs[l.slice(l.indexOf("\t") + 1)] = l.split(" ")[2].split("\t")[0];
      state._dirty_since = dirtyLedger({ paths, blobs, prev: state._dirty_since, nowIso: now.toISOString() });
    } catch {}   // git unreadable: keep the old ledger
  }
  const save = () => { if (!dryRun) io.writeState({ ...state, _held: heldNow, _stale_since: staleSince }); };
  if (!reload) { save(); return code; }

  const s = sups.find((x) => x.agent === reload.agent);
  const holdNow = (busy) => { heldNow[s.agent] = busy; io.say(`${s.agent}: stale, holding (${busy}, on re-check)`); save(); return code; };
  if (s.kind === "launchd") {
    // Re-read right before the restart: still the same pid, still between passes.
    const again = humSenseNow(io);
    const busy = again.pid !== s.pid ? "pid changed" : busyReason(s.agent, again.health) || (io.now().getMinutes() % 5 === 0 ? "cron boundary minute" : null);
    if (busy) return holdNow(busy);
    if (dryRun) { io.say(`${s.agent}: would kickstart pid ${s.pid} (${reload.reason})`); return code; }
    const at = io.now().toISOString();
    try { io.kickstart(s.label); } catch (e) { return holdNow(`kickstart failed: ${String(e.message).split("\n")[0].slice(0, 100)}`); }
    state[s.agent] = { stampMs: s.stampMs, at, pid: s.pid };
    delete heldNow[s.agent];
    save();
    io.say(`${s.agent}: reloaded (launchctl kickstart -k pid ${s.pid}, between passes; launchd starts it again) - ${reload.reason}`);
    return code;
  }
  const child = (pm.children || []).find((c) => c.name === s.child);
  if (!child?.alive || !child.pid) { io.say(`${s.agent}: stale but process-manager shows no live pid; leaving it`); save(); return code; }
  if (!io.isSupervisorPid(child.pid, s.entry, s.agent)) { io.say(`${s.agent}: pid ${child.pid} is not ${s.entry} --agent ${s.agent}; leaving it`); save(); return code; }
  // Re-read right before the signal: the checks above took seconds, and a
  // dispatch that landed meanwhile must not be killed mid-turn.
  const fresh = await io.getJson(`http://127.0.0.1:${ports[s.agent]}/health`);
  const busy = !fresh ? "health unreadable" : busyReason(s.agent, fresh, io.now().getTime()) || (io.now().getMinutes() % 5 === 0 ? "cron boundary minute" : null);
  if (busy) return holdNow(busy);
  if (dryRun) { io.say(`${s.agent}: would reload pid ${child.pid} (${reload.reason})`); return code; }

  // Stamp the reload before the signal: process-manager may respawn within
  // seconds, and unsettled() reads "back" as started after this time.
  const at = io.now().toISOString();
  io.kill(child.pid, "SIGTERM");
  // Graceful shutdown awaits http.close() then session.stop(); if that hangs,
  // the pid stays alive with its ports closed and process-manager never
  // respawns it. Give it 20 s, then SIGKILL.
  for (let i = 0; i < 20 && io.alive(child.pid); i++) await io.sleep(1000);
  const forced = io.alive(child.pid);
  if (forced) { try { io.kill(child.pid, "SIGKILL"); } catch {} }
  state[s.agent] = { stampMs: s.stampMs, at, pid: child.pid };
  delete heldNow[s.agent];
  save();
  io.say(`${s.agent}: reloaded (${forced ? "SIGTERM ignored for 20s, SIGKILLed" : "SIGTERM"} pid ${child.pid}; process-manager respawns it) - ${reload.reason}`);
  return code;
}

// ─── --report: read-only, for `jori doctor` ─────────────────────────────
// The daemons nothing restarts are only reported. A process is listed once it
// has missed committed code for REPORT_GRACE_MS, aged from the EARLIEST
// committed change after its start (a file changed twice shows only its later
// mtime, so the age can only be understated).
export const REPORT = [
  { name: "hum-sense", entry: HUM_SENSE.entry, argv: ["daemon"], extraDirs: HUM_SENSE.extraDirs,
    fix: "the watchdog restarts it between passes; by hand: launchctl kickstart -k gui/$(id -u)/ai.claude.hum-sense" },
  { name: "wiki-server", entry: "bin/wiki", argv: ["--port", "9096"], fix: "jori restart wiki-server" },
  { name: "wiki-server-public", entry: "bin/wiki", argv: ["--port", "9097"], fix: "kill its pid; process-manager respawns it" },
  { name: "whatsapp-channel", entry: "agent/whatsapp-channel/index.mjs", argv: [], fix: "jori restart whatsapp-channel" },
  { name: "phone-channel", entry: "agent/phone-channel/index.mjs", argv: [], fix: "loads with the chat agent's next session (jori restart chat)" },
];
export const REPORT_GRACE_MS = 3_600_000;
export const DATA_PREFIXES = ["data/", "agent/logs/"];

export function report(io = realIo(), root = ROOT) {
  const nowMs = io.now().getTime();
  const psText = io.ps();
  const rows = parsePs(psText);
  const closures = REPORT.map((t) => closureWithDirs(path.join(root, t.entry), t.extraDirs, root));
  const rel = (f) => path.relative(root, f);
  let notCommitted = null;
  try { notCommitted = new Set(porcelainPaths(io.git(["status", "--porcelain", "-z", "--untracked-files=all", "--", ...new Set(closures.flat().map(rel))]))); } catch {}
  const late = [];
  let running = 0;
  REPORT.forEach((t, i) => {
    const entry = path.join(root, t.entry);
    const r = rows.filter((x) => x.argv.includes(entry) && t.argv.every((a) => x.argv.includes(a))).sort((a, b) => a.startedMs - b.startedMs)[0];
    if (!r || !notCommitted) return;
    running++;
    let since = 0, newest = null, newestMs = 0;
    for (const f of closures[i]) {
      if (notCommitted.has(rel(f))) continue;
      let m; try { m = io.statMs(f); } catch { continue; }
      if (m >= r.startedMs + 1000 && (!since || m < since)) since = m;
      if (m > newestMs) { newestMs = m; newest = rel(f); }
    }
    if (since && nowMs - since > REPORT_GRACE_MS) late.push({ name: t.name, pid: r.pid, started: new Date(r.startedMs).toISOString(), since: new Date(since).toISOString(), newest, fix: t.fix });
  });
  const st = io.readState();
  const supervisors = SUPERVISORS.map((s) => ({ agent: s.agent, stale_since: st._stale_since?.[s.agent]?.since || null, held: st._held?.[s.agent] || null }));
  let uncommitted = null;
  try {
    const ledger = st._dirty_since || {};
    const aged = porcelainPaths(io.git(["status", "--porcelain=v1", "-z", "--untracked-files=no"])).map((p) => ({ path: p, since: ledger[p]?.since || null,
      hours: ledger[p]?.since ? (nowMs - Date.parse(ledger[p].since)) / 3_600_000 : null }));
    const isData = (p) => DATA_PREFIXES.some((pre) => p.startsWith(pre));
    uncommitted = { code: aged.filter((a) => !isData(a.path)), data: aged.filter((a) => isData(a.path)) };
  } catch {}
  return { as_of: new Date(nowMs).toISOString(), ok: !!notCommitted && psText != null, running, watched: REPORT.length, late, supervisors, uncommitted };
}
