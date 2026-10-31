// stale-code-watch — the rest of "a fix that lands is actually running" (item 2
// of the 2026-10-20 review), next to supervisor-code-reload.
//
// supervisor-code-reload already puts the four supervisors (idle-gated) and
// hum-sense (between passes) back on the code on disk every watchdog tick. Three
// gaps were left, and this closes them:
//
//   1. Small long-running daemons nothing restarted. On the mini (2026-10-22):
//      heartbeat-sender.sh and minibeat (bash loops under launchd, up since
//      Sep 29), the dashboard (launchd, up since Oct 3) and the two wiki servers
//      (process-manager children, up since Oct 11). Each is cheap to bounce and
//      holds no turn, so when its code on disk is newer than the process it is
//      restarted at once: `launchctl kickstart -k` for a launchd agent, SIGTERM
//      for a process-manager child (process-manager respawns it). Same safety as
//      the reloader: committed code only (an uncommitted edit in its closure
//      holds), syntax check passes (`node --check` / `bash -n`), code quiet for
//      CODE_QUIET_MS, no rebase/merge in the tree, once per code stamp.
//   2. Big daemons that are only reported (in `jori doctor`, which nobody
//      reads unprompted): whatsapp-channel, phone-channel (loads with chat's
//      next session) and process-manager itself (its restart restarts
//      everything). These are FLAGGED once they have missed committed code for
//      LATE_FLAG_MS, never restarted here. The age runs from the first sighting
//      for that running process (`_missed_since`), so a later commit to a file
//      it already missed neither resets the age nor clears the flag.
//   3. Tracked code files modified but never committed. Two chat fixes lived
//      only in the host's working tree for days (saved 2026-10-22), one
//      autostash or revert from being lost. A code file (not data/ or
//      logs) dirty for over UNCOMMITTED_FLAG_H hours is flagged, aged by the
//      first-sighting ledger supervisor-code-reload keeps (`_dirty_since`).
//
// Flagging goes through the existing path: this tool never sends anything. It
// exits 6 with the text in its state file's `_flag`; watchdog.sh (the only
// authorized author of machine-health alerts) pages from that through its
// incident dedup, and clears on exit 0. Kill switch: data/.stale-code-watch-off.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { writeJsonAtomic } from "./atomic-write.js";
import {
  parsePs, closureWithDirs, codeStamp, gitBusy, porcelainPaths, realIo as reloadIo,
  getJson, CODE_QUIET_MS, DATA_PREFIXES, COMEBACK_MS,
} from "./supervisor-code-reload.mjs";

const require = createRequire(import.meta.url);
const ROOT = process.env.JORI_ROOT || require("./root.cjs").installRoot();

// The heartbeat sender's launchd label is the installation's own (services
// registry entry whose script is heartbeat-sender.sh); com.jori.heartbeat when
// none is registered.
function heartbeatLabel() {
  try {
    const s = require("./registry.cjs").loadRegistryList("services").find((x) => x.script === "heartbeat-sender.sh");
    if (s?.label) return s.label;
  } catch {}
  return "com.jori.heartbeat";
}
const STATE_FILE = path.join(ROOT, "data/stale-code-watch-state.json");
const RELOAD_STATE = path.join(ROOT, "data/supervisor-code-reload-state.json");
const PM_HEALTH = "http://127.0.0.1:9095/health";

export const LATE_FLAG_MS = 6 * 3_600_000;
export const UNCOMMITTED_FLAG_H = 12;
export const STUCK_MS = 10 * 60_000;   // restarted for this stamp this long ago and still old: flag

// kind "launchd": pid from `launchctl print`; kind "pm": pid from process-manager's /health.
export const SMALL = [
  { name: "heartbeat-sender", kind: "launchd", label: heartbeatLabel(), entry: "heartbeat-sender.sh" },
  { name: "minibeat", kind: "launchd", label: "com.jori.minibeat", entry: "bin/minibeat" },
  { name: "dashboard", kind: "launchd", label: "com.jori.dashboard", entry: "agent/dashboard/server.mjs" },
  { name: "wiki-server", kind: "pm", child: "wiki-server", entry: "bin/wiki" },
  { name: "wiki-server-public", kind: "pm", child: "wiki-server-public", entry: "bin/wiki" },
];
// Flag only. kind "ps": the oldest process whose argv ends in the entry path.
export const FLAG_ONLY = [
  { name: "whatsapp-channel", kind: "pm", child: "whatsapp-channel", entry: "agent/whatsapp-channel/index.mjs", fix: "jori restart whatsapp-channel" },
  { name: "phone-channel", kind: "ps", entry: "agent/phone-channel/index.mjs", fix: "loads with chat's next session: jori restart chat" },
  { name: "process-manager", kind: "launchd", label: "ai.claude.session", entry: "agent/bin/process-manager.mjs", fix: "jori restart session (restarts every supervisor)" },
];

const isShell = (f) => {
  if (f.endsWith(".sh")) return true;
  try { return /^#!.*\b(ba|z)?sh\b/.test(fs.readFileSync(f, "utf8").split("\n", 1)[0]); } catch { return false; } // lang-regex-ok: shebang line of a script file
};

export function realIo() {
  const base = reloadIo();
  return {
    ...base,
    getJson,
    pmHealth: () => getJson(PM_HEALTH),
    readState: () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; } },
    writeState: (st) => { try { writeJsonAtomic(STATE_FILE, st); } catch {} },
    readReloadState: () => { try { return JSON.parse(fs.readFileSync(RELOAD_STATE, "utf8")); } catch { return {}; } },
    syntaxOk: (files) => {
      for (const f of files) {
        try {
          if (isShell(f)) execFileSync("bash", ["-n", f], { stdio: "ignore", timeout: 20_000 });
          else execFileSync(process.execPath, ["--check", f], { stdio: "ignore", timeout: 20_000 });
        } catch { return false; }
      }
      return true;
    },
    gitBusy: () => gitBusy(ROOT),
    say: (msg) => console.log(`${new Date().toLocaleString("sv-SE", { hour12: false }).slice(0, 19)} [stale-code-watch] ${msg}`),
  };
}

// The running process of a target: { pid, startedMs } or null.
export function locate(t, { rows, pm, launchdPid }) {
  let pid = null;
  if (t.kind === "launchd") pid = launchdPid(t.label);
  else if (t.kind === "pm") { const c = (pm?.children || []).find((x) => x.name === t.child); pid = c?.alive ? c.pid : null; }
  else {
    const suffix = `/${t.entry}`.toLowerCase();
    const r = rows.filter((x) => x.argv.some((a) => a.toLowerCase().endsWith(suffix))).sort((a, b) => a.startedMs - b.startedMs)[0];
    pid = r?.pid ?? null;
  }
  const r = pid ? rows.find((x) => x.pid === pid) : null;
  if (!r) return null;
  // The pid must really run this entry (a reused pid, a wrapper): compared
  // case-insensitively, since launchd starts the dashboard from ~/Dev/jori.
  const base = path.basename(t.entry).toLowerCase();
  if (!r.argv.some((a) => a.toLowerCase().endsWith(`/${t.entry}`.toLowerCase()) || path.basename(a).toLowerCase() === base)) return null;
  return { pid, startedMs: r.startedMs + 999 };   // lstart is whole seconds: round up
}

// Pure decision for one small target. Returns { restart: bool, hold?, stuck? }.
export function decideSmall({ now, run, stampMs, dirty, syntaxOk, busyGit, prev }) {
  if (!run || !stampMs || run.startedMs >= stampMs) return { restart: false };
  if (prev?.stampMs === stampMs) {
    const stuck = now - Date.parse(prev.at) > STUCK_MS;
    return { restart: false, hold: "already restarted for this code once", stuck };
  }
  if (dirty) return { restart: false, hold: "uncommitted edits in its code" };
  if (!syntaxOk) return { restart: false, hold: "syntax check fails on its code" };
  if (now - stampMs < CODE_QUIET_MS) return { restart: false, hold: "code changed under 2 minutes ago" };
  if (busyGit) return { restart: false, hold: busyGit };
  return { restart: true };
}

// Earliest committed closure change after the process started, or 0 when it
// is current. A file changed twice shows only its later mtime, so this moves
// forward with every re-commit; it is never the age on its own. The persisted
// first sighting (stickyMissed) is what keeps a re-commit from resetting the age.
export function missedSince(run, files, dirtySet, statMs) {
  let since = 0;
  for (const f of files) {
    if (dirtySet.has(f)) continue;
    let m; try { m = statMs(f); } catch { continue; }
    if (m >= run.startedMs && (!since || m < since)) since = m;
  }
  return since;
}

// The `_missed_since` entry for one running process: { pid, startedMs, sinceMs }
// or null. While the same process (same pid and start time) is still missing
// code, the age keeps its first sighting. A new process starts from what is
// computed now. Defends the stale-code-flag alert against a false "Recovered"
// and a second page for one unchanged condition when a file the daemon already
// missed is committed again. `masked`: a closure file has uncommitted edits, so
// a 0 from missedSince cannot tell current from missed, and the same process's
// entry stands.
export function stickyMissed(prev, run, computed, masked = false) {
  const same = !!prev && prev.pid === run.pid && prev.startedMs === run.startedMs && prev.sinceMs > 0;
  if (!computed) return same && masked ? prev : null;
  return { pid: run.pid, startedMs: run.startedMs, sinceMs: same ? Math.min(prev.sinceMs, computed) : computed };
}

export function composeFlag(items) {
  if (!items.length) return null;
  return ["⚠️ Code on disk isn't fully live or saved:", ...items.map((i) => `• ${i}`)].join("\n");
}

const hours = (ms) => `${Math.round(ms / 3_600_000)}h`;

export async function main(argv = [], io = realIo(), root = ROOT) {
  const dryRun = argv.includes("--dry-run");
  const now = io.now();
  const psText = io.ps();
  if (psText == null) return 5;                       // cannot see processes: neither page nor clear
  const rows = parsePs(psText);
  const pm = await io.pmHealth();
  const state = io.readState();
  const flags = [];
  const abs = (rel) => path.join(root, rel);
  const relOf = (f) => path.relative(root, f);

  const all = [...SMALL, ...FLAG_ONLY];
  const closures = Object.fromEntries(all.map((t) => [t.name, closureWithDirs(abs(t.entry), [], root)]));
  let dirtySet = new Set();
  try {
    const files = [...new Set(Object.values(closures).flat().map(relOf))];
    dirtySet = new Set(porcelainPaths(io.git(["status", "--porcelain", "-z", "--untracked-files=all", "--", ...files])).map(abs));
  } catch { dirtySet = null; }

  for (const t of SMALL) {
    if (t.kind === "pm" && !pm) continue;             // process-manager down: watchdog.sh owns that
    const run = locate(t, { rows, pm, launchdPid: io.launchdPid });
    const files = closures[t.name];
    const prev = state[t.name];
    if (!run) {
      // Restarted by us and not back within COMEBACK_MS: that restart is the suspect.
      if (prev?.at && !prev.back && now - Date.parse(prev.at) > COMEBACK_MS && now - Date.parse(prev.at) < 3_600_000) {
        flags.push(`${t.name}: restarted at ${prev.at.slice(11, 16)}Z for new code and not running since`);
      }
      continue;
    }
    if (prev?.at && run.startedMs > Date.parse(prev.at)) prev.back = true;
    const { stampMs } = codeStamp(files);
    const dirty = dirtySet == null || files.some((f) => dirtySet.has(f));
    const stale = run.startedMs < stampMs;
    const d = decideSmall({ now, run, stampMs, dirty, syntaxOk: stale && !dirty ? io.syntaxOk(files) : true, busyGit: io.gitBusy(), prev });
    if (d.stuck) flags.push(`${t.name}: restarted for new code but still runs the old (pid ${run.pid})`);
    if (d.hold && stale && state._held?.[t.name] !== d.hold) io.say(`${t.name}: stale, holding (${d.hold})`);
    (state._held ||= {})[t.name] = stale ? d.hold || null : null;
    if (!d.restart) continue;
    if (dryRun) { io.say(`${t.name}: would restart pid ${run.pid}`); continue; }
    const at = now.toISOString();
    try {
      if (t.kind === "launchd") io.kickstart(t.label);
      else io.kill(run.pid, "SIGTERM");
    } catch (e) { io.say(`${t.name}: restart failed: ${String(e.message).split("\n")[0].slice(0, 120)}`); continue; }
    state[t.name] = { stampMs, at, pid: run.pid };
    io.say(`${t.name}: restarted (${t.kind === "launchd" ? `launchctl kickstart -k ${t.label}` : `SIGTERM pid ${run.pid}, process-manager respawns it`}) - running since ${new Date(run.startedMs).toISOString()}, code changed ${new Date(stampMs).toISOString()}`);
  }

  if (dirtySet) {
    const missed = state._missed_since || {};
    for (const t of FLAG_ONLY) {
      if (t.kind === "pm" && !pm) continue;
      const run = locate(t, { rows, pm, launchdPid: io.launchdPid });
      if (!run) continue;                             // not seen this tick: its entry waits (pid check catches a restart)
      const files = closures[t.name];
      const entry = stickyMissed(missed[t.name], run, missedSince(run, files, dirtySet, io.statMs), files.some((f) => dirtySet.has(f)));
      if (entry) missed[t.name] = entry; else delete missed[t.name];
      const since = entry?.sinceMs || 0;
      if (since && now - since > LATE_FLAG_MS) flags.push(`${t.name}: on code older than committed for ${hours(now - since)} (${t.fix})`);
    }
    state._missed_since = Object.keys(missed).length ? missed : undefined;
  }

  // Uncommitted code, aged by the reloader's first-sighting ledger.
  const ledger = io.readReloadState()._dirty_since || {};
  let dirtyNow = null;
  try { dirtyNow = new Set(porcelainPaths(io.git(["status", "--porcelain=v1", "-z", "--untracked-files=no"]))); } catch {}
  if (dirtyNow) {
    const old = Object.entries(ledger)
      .filter(([p, v]) => dirtyNow.has(p) && !DATA_PREFIXES.some((pre) => p.startsWith(pre)) && v?.since && now - Date.parse(v.since) > UNCOMMITTED_FLAG_H * 3_600_000)
      .sort((a, b) => Date.parse(a[1].since) - Date.parse(b[1].since));
    if (old.length) {
      const shown = old.slice(0, 4).map(([p, v]) => `${p} (${hours(now - Date.parse(v.since))})`).join(", ");
      flags.push(`not committed: ${shown}${old.length > 4 ? ` +${old.length - 4} more` : ""} (jori-commit -m "..." -- <path>)`);
    }
  }

  state._flag = composeFlag(flags) || undefined;
  state._checked_at = now.toISOString();
  if (!dryRun) io.writeState(state);
  if (state._flag) io.say(`flag: ${flags.join(" | ")}`);
  return state._flag ? 6 : 0;
}
