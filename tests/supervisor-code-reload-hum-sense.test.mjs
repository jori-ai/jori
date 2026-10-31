// supervisor-code-reload-hum-sense.test.mjs — hum-sense as a reload target, the
// exit-5 "still stale, do not clear" signal, and the read-only --report view
// (an improvement-plan item, 2026-10-20).
//
// THE CASE: hum-sense started 2026-10-13 08:57:44Z; its log-spam fix
// landed at 09:17:27Z and nothing restarted it for a week. Every machine touch
// (launchctl, ps, health, git, kill, state) is an injected fake over a
// throwaway tree; nothing real is restarted or signalled.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "scr-hum-"));
process.env.JORI_ROOT = ROOT;
const m = await import("../lib/supervisor-code-reload.mjs");

const T0 = Date.parse("2026-10-13T08:57:44Z");
const LANDED = Date.parse("2026-10-13T09:17:27Z");
const NOW = Date.parse("2026-10-20T08:01:20Z");   // minute 01: not a cron boundary
const OLD = T0 - 7 * 86_400_000;
const MIN = 60_000;
const FILES = {
  "bin/hum-sense": 'import { x } from "../lib/hum-events.mjs";\n',
  "lib/hum-events.mjs": "export const x = 1;\n",
  "agent/scripts/hum-sensors/excursion.mjs": 'import "./_common.mjs";\nexport default () => [];\n',
  "agent/scripts/hum-sensors/_common.mjs": "export const c = 1;\n",
  "agent/supervisor/index.mjs": "export {};\n",
  "agent/supervisor/chat-supervisor.mjs": "export {};\n",
  "bin/wiki": 'require("../lib/wiki-serve.js");\n',
  "lib/wiki-serve.js": "module.exports = {};\n",
  "agent/whatsapp-channel/index.mjs": "export {};\n",
  "agent/phone-channel/index.mjs": "export {};\n",
};
function setTree(mtimes = {}) {
  for (const [rel, body] of Object.entries(FILES)) {
    const f = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
    const t = new Date(mtimes[rel] ?? OLD);
    fs.utimesSync(f, t, t);
  }
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const lstart = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, "0");
  return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, " ")} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${d.getFullYear()}`; };
const row = (pid, ppid, started, cmd) => `${pid} ${ppid} ${lstart(started)} ${cmd}`;
const humRow = (pid = 57609, started = T0) => row(pid, 1, started, `/opt/homebrew/bin/node ${ROOT}/bin/hum-sense daemon`);

const SUPS = ["ops-haiku", "ops-light", "ops", "chat"];
const PORTS = { "ops-haiku": 9201, "ops-light": 9202, ops: 9203, chat: 9204 };
const idle = { startedAt: new Date(T0 + 86_400_000).toISOString(), inFlight: null, queueDepth: 0, lastEventAgeMs: 30 * MIN };

// o.ps / o.beat may be functions of the call number (to change mid-run).
function harness(o = {}) {
  const calls = { kickstart: [], kill: [], writes: 0, logs: [], psCalls: 0 };
  let state = o.state ? JSON.parse(JSON.stringify(o.state)) : {};
  let n = 0;
  const io = {
    getJson: async (url) => (url.includes(":9095/") ? (o.pm === undefined ? { children: [] } : o.pm)
      : { ...idle, ...(o.health?.[Object.keys(PORTS).find((k) => url.includes(`:${PORTS[k]}/`))] || {}) }),
    healthPorts: () => PORTS,
    isDirty: () => o.dirty ?? false,
    checksPass: () => o.checkOk ?? true,
    readState: () => JSON.parse(JSON.stringify(state)),
    writeState: (st) => { state = JSON.parse(JSON.stringify(st)); calls.writes++; },
    readJson: (f) => (f.endsWith("hum-sense-heartbeat.json")
      ? (typeof o.beat === "function" ? o.beat(++n) : o.beat ?? { ts: new Date((o.now ?? NOW) - 2_000).toISOString(), pid: 57609, status: "running" })
      : f.endsWith("hum-sensors.json") ? { config: { tick_sec: 10 } } : null),
    say: (msg) => calls.logs.push(msg),
    alive: () => false,
    isSupervisorPid: () => true,
    git: (args) => (args[0] === "ls-tree" ? (o.lsTree ?? "") : o.status ?? ""),
    now: () => new Date(o.now ?? NOW),
    sleep: async () => {},
    kill: (pid, sig) => calls.kill.push([pid, sig]),
    gitBusy: () => o.gitBusy ?? null,
    statMs: (f) => fs.statSync(f).mtimeMs,
    ps: () => { calls.psCalls++; if (o.psThrows) throw new Error("ps hung"); if (o.psNull) return null;
      const p = typeof o.ps === "function" ? o.ps(calls.psCalls) : o.ps; return (p ?? [humRow()]).join("\n") + "\n"; },
    launchdPid: () => { if (o.launchctlThrows) throw new Error("launchctl hung"); return o.lpid === undefined ? 57609 : o.lpid; },
    kickstart: (label) => { if (o.kickstartThrows) throw new Error("boom"); calls.kickstart.push(label); },
  };
  return { io, calls, state: () => state };
}

test("hum-sense on code that landed after it started is kickstarted once, between passes, and nothing else is touched", async () => {
  setTree({ "lib/hum-events.mjs": LANDED });
  const h = harness();
  assert.equal(await m.main([], h.io), 5, "still stale at this tick, so nothing may clear yet");
  assert.deepEqual(h.calls.kickstart, ["ai.claude.hum-sense"]);
  assert.deepEqual(h.calls.kill, []);
  assert.equal(h.state()["hum-sense"].stampMs, LANDED);
  assert.equal(h.state()["hum-sense"].pid, 57609);
  assert.ok(h.calls.logs.some((l) => l.startsWith("hum-sense: reloaded (launchctl kickstart -k pid 57609, between passes")));
});

test("a sensor it import()s by name counts as its code", async () => {
  setTree({ "agent/scripts/hum-sensors/_common.mjs": LANDED });
  const h = harness();
  await m.main([], h.io);
  assert.deepEqual(h.calls.kickstart, ["ai.claude.hum-sense"]);
});

test("the respawn reads as current, settles, and the tick returns 0 only once every target is on the code on disk", async () => {
  setTree({ "lib/hum-events.mjs": LANDED });
  const first = harness();
  await m.main([], first.io);
  const at = Date.parse(first.state()["hum-sense"].at);
  const ps = [humRow(61000, at)];   // same second as the reload stamp: rounded up, still "after" it
  const soon = harness({ state: first.state(), ps, lpid: 61000, now: at + 3 * MIN, beat: { ts: new Date(at + 3 * MIN - 1000).toISOString(), pid: 61000, status: "running" } });
  assert.equal(await m.main([], soon.io), 0);
  assert.deepEqual(soon.calls.kickstart, []);
  const later = harness({ state: soon.state(), ps, lpid: 61000, now: at + 11 * MIN, beat: { ts: new Date(at + 11 * MIN - 1000).toISOString(), pid: 61000, status: "running" } });
  assert.equal(await m.main([], later.io), 0);
  assert.equal(later.state()["hum-sense"].settled, true);
});

test("holds hum-sense mid-pass, with a child process, on uncommitted or unparseable code, fresh code, a rebase, or a cron minute", async () => {
  setTree({ "lib/hum-events.mjs": LANDED });
  const cases = [
    [{ beat: { ts: new Date(NOW - 8_000).toISOString(), pid: 57609, status: "running" } }, "mid-pass (not in the sleep after a heartbeat)"],
    [{ beat: { ts: new Date(NOW - 1_000).toISOString(), pid: 57609, status: "starting" } }, "mid-pass (not in the sleep after a heartbeat)"],
    [{ beat: { ts: new Date(NOW - 1_000).toISOString(), pid: 1234, status: "running" } }, "mid-pass (not in the sleep after a heartbeat)"],
    [{ ps: [humRow(), row(70000, 57609, NOW - MIN, "/opt/homebrew/bin/node /x/hum-tick.mjs run")] }, "1 child process(es) running"],
    [{ dirty: true }, "uncommitted edits in its code"],
    [{ checkOk: false }, "node --check fails on its code"],
    [{ now: LANDED + MIN, beat: { ts: new Date(LANDED + MIN - 1000).toISOString(), pid: 57609, status: "running" } }, "code changed under 2 minutes ago"],
    [{ gitBusy: "git operation in progress (.git/rebase-merge)" }, "git operation in progress (.git/rebase-merge)"],
    [{ now: Date.parse("2026-10-20T08:05:20Z"), beat: { ts: "2026-10-20T08:05:18.000Z", pid: 57609, status: "running" } }, "cron boundary minute"],
  ];
  for (const [o, reason] of cases) {
    const h = harness(o);
    await m.main([], h.io);
    assert.deepEqual(h.calls.kickstart, [], reason);
    assert.equal(h.state()._held["hum-sense"], reason);
  }
});

test("re-checks right before the kickstart: a pass that started meanwhile, or a new pid, holds", async () => {
  setTree({ "lib/hum-events.mjs": LANDED });
  const midPass = harness({ beat: (n) => ({ ts: new Date(NOW - (n === 1 ? 1_000 : 9_000)).toISOString(), pid: 57609, status: "running" }) });
  await m.main([], midPass.io);
  assert.deepEqual(midPass.calls.kickstart, []);
  assert.match(midPass.state()._held["hum-sense"], /on re-check|mid-pass/);
  const newPid = harness({ ps: (n) => (n === 1 ? [humRow()] : [humRow(61000, NOW)]), lpid: 57609 });
  await m.main([], newPid.io);
  assert.deepEqual(newPid.calls.kickstart, []);
});

test("a hum-sense one-shot or a pid launchd does not own is never treated as the daemon", () => {
  const rows = m.parsePs([humRow(5, T0).replace("daemon", "once --dispatch"), humRow()].join("\n"));
  assert.equal(m.humSenseView({ pid: 5, rows, heartbeat: null, tickSec: 10, nowMs: NOW }).health, null);
  assert.equal(m.humSenseView({ pid: null, rows, heartbeat: null, tickSec: 10, nowMs: NOW }).health, null);
  const v = m.humSenseView({ pid: 57609, rows, heartbeat: { ts: new Date(NOW - 2000).toISOString(), pid: 57609, status: "running" }, tickSec: 10, nowMs: NOW });
  assert.equal(v.startedMs, T0 + 999);
  assert.equal(m.busyReason("hum-sense", v.health), null);
});

test("a kickstart that never comes back returns 3 and holds every other reload; a failed command records nothing", async () => {
  setTree({ "lib/hum-events.mjs": LANDED, "agent/supervisor/index.mjs": LANDED });
  const state = { "hum-sense": { stampMs: LANDED, at: new Date(NOW - 5 * MIN).toISOString(), pid: 57609 } };
  const gone = harness({ state, lpid: null, ps: [], health: { "ops-haiku": { startedAt: new Date(T0).toISOString() } },
    pm: { children: [{ name: "ops-haiku-supervisor", alive: true, pid: 4242 }] } });
  assert.equal(await m.main([], gone.io), 3);
  assert.equal(gone.state()._failed, "hum-sense", "named for the page");
  assert.deepEqual(gone.calls.kill, []);
  assert.match(gone.state()._held["ops-haiku"], /waiting for hum-sense to settle/);

  setTree({ "lib/hum-events.mjs": LANDED });
  const throws = harness({ kickstartThrows: true });
  await m.main([], throws.io);
  assert.equal(throws.state()["hum-sense"], undefined);
  assert.match(throws.state()._held["hum-sense"], /kickstart failed/);
});

test("exit 0 only when every target is current; process-manager down or hum-sense unreadable is 5, never 0", async () => {
  setTree();
  assert.equal(await m.main([], harness().io), 0);
  assert.equal(await m.main([], harness({ pm: null }).io), 5);
  assert.equal(await m.main([], harness({ lpid: null, ps: [] }).io), 5);
});

test("the 6h page clock runs from the first stale tick and is not reset by a newer landing", async () => {
  setTree({ "lib/hum-events.mjs": LANDED });
  const kid = [humRow(), row(70000, 57609, NOW - MIN, "node hum-tick.mjs run")];
  const h1 = harness({ ps: kid });
  assert.equal(await m.main([], h1.io), 5);
  const t2 = NOW + 5 * 3_600_000;
  fs.utimesSync(path.join(ROOT, "bin/hum-sense"), new Date(t2 - 10 * MIN), new Date(t2 - 10 * MIN));
  const h2 = harness({ ps: kid, state: h1.state(), now: t2, beat: { ts: new Date(t2 - 1000).toISOString(), pid: 57609, status: "running" } });
  assert.equal(await m.main([], h2.io), 5);
  const t3 = NOW + 6 * 3_600_000 + MIN;
  const h3 = harness({ ps: kid, state: h2.state(), now: t3, beat: { ts: new Date(t3 - 1000).toISOString(), pid: 57609, status: "running" } });
  assert.equal(await m.main([], h3.io), 4);
});

test("the acting run keeps a first-sighting ledger of dirty tracked files; a recommit restarts a clock; --dry-run writes nothing", async () => {
  setTree();
  const status = " M bin/wiki-db-snapshot\0 M data/wiki-share-scopes.json\0";
  const lsTree = "100755 blob aaa\t" + "bin/wiki-db-snapshot" + "\x00100644 blob bbb\t" + "data/wiki-share-scopes.json" + "\0";
  const a = harness({ status, lsTree, now: Date.parse("2026-10-17T14:01:20Z"),
    beat: { ts: "2026-10-17T14:01:19.000Z", pid: 57609, status: "running" } });
  await m.main([], a.io);
  assert.deepEqual(a.state()._dirty_since["bin/wiki-db-snapshot"], { since: "2026-10-17T14:01:20.000Z", head: "aaa" });
  const b = harness({ status, lsTree, state: a.state() });
  await m.main([], b.io);
  assert.equal(b.state()._dirty_since["bin/wiki-db-snapshot"].since, "2026-10-17T14:01:20.000Z");
  const c = harness({ status, lsTree: lsTree.replace("aaa", "ccc"), state: b.state() });
  await m.main([], c.io);
  assert.equal(c.state()._dirty_since["bin/wiki-db-snapshot"].since, new Date(NOW).toISOString());
  const clean = harness({ status: "", state: c.state() });
  await m.main([], clean.io);
  assert.deepEqual(clean.state()._dirty_since, {});
  const dry = harness({ status, lsTree });
  setTree({ "lib/hum-events.mjs": LANDED });
  await m.main(["--dry-run"], dry.io);
  assert.equal(dry.calls.writes, 0);
  assert.deepEqual(dry.calls.kickstart, []);
  assert.ok(dry.calls.logs.some((l) => l.startsWith("hum-sense: would kickstart pid 57609")));
});

test("--report: the watched daemons that missed committed code for over an hour, supervisors from the reloader's state, code vs data", () => {
  setTree({ "lib/hum-events.mjs": LANDED, "bin/hum-sense": NOW - 5 * MIN,
    "agent/whatsapp-channel/index.mjs": NOW - 30 * MIN, "lib/wiki-serve.js": NOW - 3 * 3_600_000 });
  const ps = [
    humRow(),
    row(24132, 1, T0 - 2 * 86_400_000, `/opt/homebrew/bin/node ${ROOT}/bin/wiki serve --port 9096 --host 0.0.0.0`),
    row(24134, 1, T0 - 2 * 86_400_000, `/opt/homebrew/bin/node ${ROOT}/agent/whatsapp-channel/index.mjs`),
  ];
  const state = {
    _stale_since: { ops: { stampMs: 1, since: "2026-10-20T05:00:00.000Z" } }, _held: { ops: "turn in flight" },
    _dirty_since: { "bin/wiki-db-snapshot": { since: "2026-10-17T14:00:00.000Z", head: "aaa" } },
  };
  const h = harness({ ps, state, status: " M lib/wiki-serve.js\0 M bin/wiki-db-snapshot\0 M bin/jori\0 M data/meeting-notes.md\0" });
  const r = m.report(h.io, ROOT);
  assert.equal(r.ok, true);
  assert.equal(r.running, 3);
  assert.deepEqual(r.late.map((l) => l.name), ["hum-sense"], "wiki: only an uncommitted edit is newer; whatsapp: inside the hour");
  assert.equal(r.late[0].since, new Date(LANDED).toISOString(), "aged from the first change it missed");
  assert.deepEqual(r.supervisors.find((s) => s.agent === "ops"), { agent: "ops", stale_since: "2026-10-20T05:00:00.000Z", held: "turn in flight" });
  const snap = r.uncommitted.code.find((a) => a.path === "bin/wiki-db-snapshot");
  assert.ok(snap.hours > 24);
  assert.equal(r.uncommitted.code.find((a) => a.path === "bin/jori").hours, null, "never seen: age unknown, never claimed");
  assert.deepEqual(r.uncommitted.data.map((a) => a.path), ["data/meeting-notes.md"]);
  assert.equal(h.calls.writes, 0);
  assert.deepEqual(h.calls.kickstart, []);
});

test("watchdog.sh: exit 5 neither pages nor clears; the stale incident clears only on 0", () => {
  const src = fs.readFileSync(process.env.WATCHDOG_SH || path.join(REPO, "agent/scripts/watchdog.sh"), "utf8");
  const start = src.indexOf("# --- Supervisor code reload");
  const from = src.indexOf('if [ ! -f "$HOME/Dev/jori/data/.supervisor-code-reload-off" ]', start);
  // Up to the next section (stale-code-watch, 2026-10-22), which has its own test.
  const to = src.indexOf("# ── Stale code, the rest", from);
  const block = src.slice(from, to > from ? to : undefined);
  const run = (rc) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "scr-wd-"));
    fs.mkdirSync(path.join(home, "bin"));
    fs.writeFileSync(path.join(home, "bin/node"), `#!/bin/bash\nexit ${rc}\n`);
    fs.chmodSync(path.join(home, "bin/node"), 0o755);
    const out = path.join(home, "out");
    const script = [`LOG=/dev/null`, `incident_seen() { echo "seen $1" >> ${out}; }`, `incident_should_alert() { return 1; }`,
      `incident_clear() { echo "clear $1" >> ${out}; }`, `notify() { echo notify >> ${out}; }`, block].join("\n");
    execFileSync("bash", ["-c", script], { env: { PATH: `${home}/bin:/usr/bin:/bin`, HOME: home } });
    return fs.existsSync(out) ? fs.readFileSync(out, "utf8").trim().split("\n") : [];
  };
  assert.deepEqual(run(0), ["clear supervisor-code-reload-failed", "clear supervisor-code-stale"]);
  assert.deepEqual(run(5), []);
  assert.deepEqual(run(4), ["clear supervisor-code-reload-failed", "seen supervisor-code-stale"]);
  assert.deepEqual(run(3), ["seen supervisor-code-reload-failed"]);
});

test("jori doctor reads --report for both checks", () => {
  const src = fs.readFileSync(path.join(REPO, "bin/jori"), "utf8");
  assert.ok(src.includes("'supervisor-code-reload')}\" --report`"));
  assert.ok(src.includes("add('running code matches what landed', true,"));
  assert.ok(src.includes("add('no code file uncommitted over 24h', true,"));
});

test("launchd starts hum-sense again after kickstart -k: KeepAlive is unconditional", () => {
  const plist = fs.readFileSync(path.join(REPO, "agent/launch-agents/ai.claude.hum-sense.plist"), "utf8");
  const body = plist.slice(plist.indexOf("<plist"));
  assert.match(body, /<key>KeepAlive<\/key>\s*<true\/>/);
});

test("ps or launchctl failing costs hum-sense this tick (unknown, hold) and never the supervisors", async () => {
  setTree({ "lib/hum-events.mjs": LANDED, "agent/supervisor/index.mjs": LANDED });
  const supStale = { health: { "ops-haiku": { startedAt: new Date(T0).toISOString() } },
    pm: { children: [{ name: "ops-haiku-supervisor", alive: true, pid: 4242 }] } };
  for (const broken of [{ psThrows: true }, { psNull: true }, { launchctlThrows: true }]) {
    const h = harness({ ...supStale, ...broken });
    assert.equal(await m.main([], h.io), 5, JSON.stringify(broken));
    assert.deepEqual(h.calls.kickstart, [], "hum-sense unreadable: no kickstart");
    assert.deepEqual(h.calls.kill, [[4242, "SIGTERM"]], "the stale supervisor is still reloaded");
  }
  const rep = m.report(harness({ psNull: true }).io, ROOT);
  assert.equal(rep.ok, false, "doctor says 'could not determine', never '0 running, all current'");
});

test("a target that keeps crashing but is alive at most ticks is a failure by 30 minutes", () => {
  const at = NOW - 31 * MIN;
  const state = { "hum-sense": { stampMs: LANDED, at: new Date(at).toISOString(), pid: 57609 } };
  const sups = [{ agent: "hum-sense", health: {}, startedMs: NOW - 20_000, stampMs: LANDED }];   // a fresh launchd respawn
  assert.deepEqual(m.unsettled({ now: new Date(NOW), sups, state }), { agent: "hum-sense", failed: true });
  const early = [{ ...sups[0], startedMs: at + 7 * MIN }];
  assert.deepEqual(m.unsettled({ now: new Date(at + 8 * MIN), sups: early, state }), { agent: "hum-sense", failed: false });
});

test("a crash in the tool exits 5, never 0 (which would clear both incidents)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scr-bin-"));
  fs.mkdirSync(path.join(dir, "bin")); fs.mkdirSync(path.join(dir, "lib"));
  fs.copyFileSync(path.join(REPO, "bin/supervisor-code-reload"), path.join(dir, "bin/supervisor-code-reload"));
  const run = () => { try { execFileSync(process.execPath, [path.join(dir, "bin/supervisor-code-reload")], { stdio: "pipe" }); return 0; } catch (e) { return e.status; } };
  fs.writeFileSync(path.join(dir, "lib/supervisor-code-reload.mjs"), 'export async function main() { throw new Error("boom"); }\n');
  assert.equal(run(), 5, "main() throws");
  fs.writeFileSync(path.join(dir, "lib/supervisor-code-reload.mjs"), "export const x = ;\n");
  assert.equal(run(), 5, "the module does not even load");
  fs.writeFileSync(path.join(dir, "lib/supervisor-code-reload.mjs"), "export async function main() { return 0; }\n");
  assert.equal(run(), 0);
});

test("the exit-3 page names which target did not come back", () => {
  const src = fs.readFileSync(process.env.WATCHDOG_SH || path.join(REPO, "agent/scripts/watchdog.sh"), "utf8");
  const start = src.indexOf("# --- Supervisor code reload");
  const from = src.indexOf('if [ ! -f "$HOME/Dev/jori/data/.supervisor-code-reload-off" ]', start);
  // Up to the next section (stale-code-watch, 2026-10-22), which has its own test.
  const to = src.indexOf("# ── Stale code, the rest", from);
  const block = src.slice(from, to > from ? to : undefined);
  const page = (failed) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "scr-wd3-"));
    fs.mkdirSync(path.join(home, "bin"));
    fs.mkdirSync(path.join(home, "Dev/jori/data"), { recursive: true });
    if (failed) fs.writeFileSync(path.join(home, "Dev/jori/data/supervisor-code-reload-state.json"), JSON.stringify({ _failed: failed }));
    fs.writeFileSync(path.join(home, "bin/node"), "#!/bin/bash\nexit 3\n");
    fs.chmodSync(path.join(home, "bin/node"), 0o755);
    const out = path.join(home, "out");
    const script = ["LOG=/dev/null", "incident_seen() { :; }", "incident_should_alert() { return 0; }", "incident_clear() { :; }",
      `notify() { printf '%s' "$1" > ${out}; }`, block].join("\n");
    execFileSync("bash", ["-c", script], { env: { PATH: `${home}/bin:/usr/bin:/bin`, HOME: home } });
    return fs.readFileSync(out, "utf8");
  };
  assert.ok(page("hum-sense").startsWith("🔴 A supervisor (or hum-sense) I restarted to load new code didn't come back (hum-sense),"));
  assert.ok(page("the ops supervisor").includes("didn't come back (the ops supervisor)"));
  assert.ok(page(null).includes("didn't come back (unknown which; see the log)"));
});
