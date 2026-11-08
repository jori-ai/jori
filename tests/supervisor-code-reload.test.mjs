// supervisor-code-reload.test.mjs — the decision behind reloading a supervisor
// whose code on disk is newer than the running process.
//
// Guards the case where owner-approved supervisor fixes sat on disk unloaded
// for days because nothing restarted the Node supervisors, and the inert
// turn-watchdog fix let a working turn on the user's own email be killed twice
// and dropped (2026-10-11).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { decide, busyReason, heldQueue, unsettled, importClosure, codeStamp, getJson } from "../lib/supervisor-code-reload.mjs";

const T0 = Date.parse("2026-10-08T07:39:26Z");     // process start
const CODE = Date.parse("2026-10-08T09:22:12Z");   // fix landed after it
const at = (iso) => new Date(iso);
const idle = { inFlight: null, queueDepth: 0, lastEventAgeMs: 30 * 60_000 };
const sup = (agent, over = {}) => ({ agent, startedMs: T0, stampMs: CODE, dirty: false, checkOk: true, health: { ...idle }, ...over });

test("stale + idle -> reloads the first one, holds the rest to one per tick", () => {
  const r = decide({ now: at("2026-10-11T08:42:00Z"), sups: [sup("ops-haiku"), sup("ops-light"), sup("ops"), sup("chat")] });
  assert.equal(r.reload.agent, "ops-haiku");
  assert.deepEqual(r.holds.map((h) => h.reason), ["one reload per tick", "one reload per tick", "one reload per tick"]);
});

test("a process already on the code on disk is left alone", () => {
  const r = decide({ now: at("2026-10-11T08:42:00Z"), sups: [sup("ops", { startedMs: CODE + 1000 })] });
  assert.equal(r.reload, null);
  assert.equal(r.holds.length, 0);
});

test("never reloads into uncommitted or unparseable code", () => {
  const now = at("2026-10-11T08:42:00Z");
  assert.equal(decide({ now, sups: [sup("ops", { dirty: true })] }).holds[0].reason, "uncommitted edits in its code");
  assert.equal(decide({ now, sups: [sup("ops", { checkOk: false })] }).holds[0].reason, "node --check fails on its code");
  assert.equal(decide({ now, sups: [sup("ops", { dirty: true })] }).reload, null);
});

test("holds while a turn is in flight, queued, or recently active", () => {
  const now = at("2026-10-11T08:42:00Z");
  assert.equal(decide({ now, sups: [sup("ops", { health: { ...idle, inFlight: { id: "x" } } })] }).holds[0].reason, "turn in flight");
  assert.equal(decide({ now, sups: [sup("ops", { health: { ...idle, queueDepth: 2 } })] }).holds[0].reason, "2 queued");
  assert.match(decide({ now, sups: [sup("ops", { health: { ...idle, lastEventAgeMs: 60_000 } })] }).holds[0].reason, /^active/);
});

test("holds through 20 quiet minutes, background tasks, and chat forks or tools", () => {
  assert.match(busyReason("ops", { ...idle, lastEventAgeMs: 5 * 60_000 }), /^active/);   // an async subagent streams nothing
  assert.equal(busyReason("ops", { ...idle, lastEventAgeMs: 21 * 60_000 }), null);
  assert.equal(busyReason("ops", { ...idle, liveBackgroundTasks: 2 }), "2 background task(s) running");
  assert.equal(busyReason("ops", { inFlight: null, queueDepth: 0 }), "no activity reading");
  assert.equal(busyReason("chat", { ...idle, forksActive: 1 }), "fork running");
  assert.equal(busyReason("chat", { ...idle, activeTools: ["Bash"] }), "tool running");
  assert.equal(busyReason("chat", { ...idle, chatAgentStatus: "working" }), "chat agent working");
});

test("a reload must settle before the next: a load-time crash stops at the canary", () => {
  const now = at("2026-10-11T09:02:00Z");
  const reloadedAt = "2026-10-11T08:58:00Z";
  const state = { "ops-haiku": { stampMs: CODE, at: reloadedAt, pid: 1 } };
  // ops-haiku came back 3 min ago: everything else waits
  let r = decide({ now, sups: [sup("ops-haiku", { startedMs: Date.parse("2026-10-11T08:59:00Z") }), sup("ops-light")], state });
  assert.equal(r.reload, null);
  assert.match(r.holds[0].reason, /waiting for ops-haiku to settle/);
  // ops-haiku never came back: hold, and report failed after COMEBACK_MS
  const down = [sup("ops-haiku", { health: null, startedMs: 0 }), sup("ops-light")];
  assert.equal(decide({ now, sups: down, state }).reload, null);
  assert.equal(unsettled({ now: at("2026-10-11T09:03:00Z"), sups: down, state }).failed, true);
  assert.equal(unsettled({ now: at("2026-10-11T09:00:00Z"), sups: down, state }).failed, false);
  // back for 10+ min: settled, the next one goes
  const ok = [sup("ops-haiku", { startedMs: Date.parse("2026-10-11T08:58:05Z") }), sup("ops-light")];
  assert.deepEqual(unsettled({ now: at("2026-10-11T09:09:00Z"), sups: ok, state }), { agent: "ops-haiku", settled: true });
  assert.equal(decide({ now: at("2026-10-11T09:09:00Z"), sups: ok, state }).reload.agent, "ops-light");
  // a settled record never blames a later, unrelated outage on the reload
  const settledState = { "ops-haiku": { ...state["ops-haiku"], settled: true }, _held: {} };
  assert.equal(unsettled({ now: at("2026-10-12T09:00:00Z"), sups: down, state: settledState }), null);
});

test("skips the five-minute boundary when cron dispatches land", () => {
  const r = decide({ now: at("2026-10-11T08:40:00Z"), sups: [sup("ops")] });
  assert.equal(r.reload, null);
  assert.equal(r.holds[0].reason, "cron boundary minute");
});

test("does not loop on a respawn that still reads older than its code", () => {
  const r = decide({ now: at("2026-10-11T08:42:00Z"), sups: [sup("ops")], state: { ops: { stampMs: CODE } } });
  assert.equal(r.reload, null);
  assert.equal(r.holds[0].reason, "already reloaded for this code once");
});

test("a supervisor that is down or unreadable is not this tool's business", () => {
  const r = decide({ now: at("2026-10-11T08:42:00Z"), sups: [sup("ops", { health: null }), sup("chat", { startedMs: 0 })] });
  assert.equal(r.reload, null);
  assert.equal(r.holds.length, 0);
});

test("import closure follows relative and repo-rooted imports, dynamic imports and requires, not packages", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "scr-"));
  fs.mkdirSync(path.join(d, "sup")); fs.mkdirSync(path.join(d, "lib")); fs.mkdirSync(path.join(d, "node_modules"));
  fs.writeFileSync(path.join(d, "sup/entry.mjs"), `const t = await import(path.join(ROOT, "lib/rooted.js"));\nimport a from "./a.mjs";\nimport "../lib/side.mjs";\nconst w = createRequire(import.meta.url)("../lib/w.js");\nconst x = await import("../lib/dyn.mjs");\nimport fs from "node:fs";\nimport p from "../node_modules/pkg.mjs";\n`);
  fs.writeFileSync(path.join(d, "sup/a.mjs"), `import { createRequire } from "node:module";\nconst r = createRequire(import.meta.url);\nconst c = r("../lib/c.js");\nexport default 1;\n`);
  fs.writeFileSync(path.join(d, "lib/side.mjs"), ``);
  fs.mkdirSync(path.join(d, "lib"), { recursive: true });
  fs.writeFileSync(path.join(d, "lib/rooted.js"), ``);
  fs.writeFileSync(path.join(d, "lib/w.js"), ``);
  fs.writeFileSync(path.join(d, "lib/dyn.mjs"), ``);
  fs.writeFileSync(path.join(d, "lib/c.js"), `const y = require("./y.cjs");\n`);
  fs.writeFileSync(path.join(d, "lib/y.cjs"), ``);
  fs.writeFileSync(path.join(d, "node_modules/pkg.mjs"), ``);
  const got = importClosure(path.join(d, "sup/entry.mjs"), d).map((f) => path.relative(d, f)).sort();
  assert.deepEqual(got, ["lib/c.js", "lib/dyn.mjs", "lib/side.mjs", "lib/w.js", "lib/y.cjs", "sup/a.mjs", "sup/entry.mjs", "lib/rooted.js"].sort());
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(d, "lib/y.cjs"), future, future);
  assert.equal(path.relative(d, codeStamp(importClosure(path.join(d, "sup/entry.mjs"), d)).newest), "lib/y.cjs");
  fs.rmSync(d, { recursive: true, force: true });
});

// 2026-10-11: every re-check read failed with ECONNRESET (164 of 164) and no
// supervisor was ever reloaded. fetch() pooled the first read's keep-alive
// socket; main()'s synchronous git/node --check work outlasted the server's
// keep-alive window; the re-check got the dead socket back. Same shape here:
// read A, read B, block past A's keep-alive, read A again. Keep server B: with
// a single origin the old fetch() passes, so the test would guard nothing.
test("a health re-read after a long synchronous stretch still answers", async () => {
  const serve = async () => {
    const s = http.createServer((q, r) => { r.setHeader("content-type", "application/json"); r.end('{"startedAt":"2026-10-11T09:00:00Z"}'); });
    // The supervisors run Node's defaults (5000 + 1000 buffer). Shorter here to
    // keep the test quick, but long enough that fetch() pools the socket.
    s.keepAliveTimeout = 3000;
    s.keepAliveTimeoutBuffer = 1000;
    await new Promise((r) => s.listen(0, "127.0.0.1", r));
    return s;
  };
  const a = await serve(), b = await serve();
  const urlA = `http://127.0.0.1:${a.address().port}/health`;
  try {
    assert.ok(await getJson(urlA));
    assert.ok(await getJson(`http://127.0.0.1:${b.address().port}/health`));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4500);   // past A closing its socket at 4 s
    assert.deepEqual(await getJson(urlA), { startedAt: "2026-10-11T09:00:00Z" });
  } finally { a.close(); b.close(); }
});

test("a health read that errors, times out or is not 2xx reads as null", async () => {
  const s = http.createServer((q, r) => {
    if (q.url === "/slow") return;                        // never answers
    if (q.url === "/bad") { r.statusCode = 503; return r.end("{}"); }
    r.end("not json");
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${s.address().port}`;
  try {
    assert.equal(await getJson(`${base}/bad`), null);
    assert.equal(await getJson(`${base}/junk`), null);
    assert.equal(await getJson(`${base}/slow`, 200), null);
  } finally { s.closeAllConnections(); s.close(); }
  assert.equal(await getJson(`${base}/gone`), null);      // connection refused
  assert.equal(await getJson("http://127.0.0.1:undefined/health"), null);   // bad port: no throw
});

// A supervisor held for the usage limit with work queued never reloaded, so the
// fix to the hold sat
// inert behind "ops: stale, holding (8 queued)" until the named reset.
test("a durable queue held for the usage limit does not hold a reload; chat's in-memory queue still does", () => {
  const now = at("2026-10-28T08:22:11Z");
  const held = { ...idle, queueDepth: 8, rateLimitHoldUntil: "2026-10-29T03:01:00.000Z" };
  for (const agent of ["ops", "ops-light", "ops-haiku"]) {
    assert.equal(busyReason(agent, held, now.getTime()), null, agent);
    assert.equal(heldQueue(agent, held, now.getTime()), true, agent);
  }
  assert.equal(decide({ now, sups: [sup("ops", { health: held })] }).reload.agent, "ops");
  assert.equal(busyReason("chat", { ...held, queueDepth: 6, forksActive: 0, activeTools: [], chatAgentStatus: "idle" }, now.getTime()), "6 queued");
  // Every other gate still holds a held supervisor.
  assert.equal(busyReason("ops", { ...held, inFlight: { id: "x" } }, now.getTime()), "turn in flight");
  assert.equal(busyReason("ops", { ...held, liveBackgroundTasks: 1 }, now.getTime()), "1 background task(s) running");
  assert.match(busyReason("ops", { ...held, lastEventAgeMs: 60_000 }, now.getTime()), /^active/);
  // A hold already past, absent or unparseable is no hold: the queue holds as before.
  assert.equal(busyReason("ops", { ...held, rateLimitHoldUntil: "2026-10-28T08:00:00.000Z" }, now.getTime()), "8 queued");
  assert.equal(busyReason("ops", { ...held, rateLimitHoldUntil: null }, now.getTime()), "8 queued");
  assert.equal(busyReason("ops", { ...held, rateLimitHoldUntil: "soon" }, now.getTime()), "8 queued");
});

// ── chat's companion: phone-channel ──────────────────────────────────────────
// Regression guard for the stale-code-flag alert "phone-channel: on code older
// than committed for Nh (loads with chat's next session: jori restart chat)".
// phone-channel is the MCP server chat's `claude -p` spawns (chat-supervisor ->
// claude -p -> phone-channel), so it reloads only when the chat supervisor
// restarts, and its own import closure was never part of chat's: a commit that
// touched only phone-channel's code stayed unloaded for over a day. Chat now
// counts as stale when phone-channel is behind its own closure. Every machine
// touch is an injected fake over a throwaway tree; nothing real is signalled.
const TREE = fs.mkdtempSync(path.join(os.tmpdir(), "scr-pc-"));
process.env.JORI_ROOT = TREE;
const c = await import("../lib/supervisor-code-reload.mjs?companion");   // a fresh instance rooted at TREE

const MIN = 60_000;
const OLD = Date.parse("2026-10-01T10:00:00Z");
const PC_START = Date.parse("2026-10-20T07:00:00Z");     // phone-channel (and chat) started
const LANDED = Date.parse("2026-10-20T09:00:00Z");       // a commit after that
const NOW = Date.parse("2026-10-20T12:01:20Z");          // minute 01: not a cron boundary
const PC_FILES = {
  "agent/supervisor/chat-supervisor.mjs": 'import "../../lib/session.mjs";\n',
  "agent/supervisor/index.mjs": "export {};\n",
  "lib/session.mjs": "export {};\n",
  "agent/phone-channel/index.mjs": 'import { p } from "../../lib/push.mjs";\n',
  "lib/push.mjs": "export const p = 1;\n",
};
function pcTree(mtimes = {}) {
  for (const [rel, body] of Object.entries(PC_FILES)) {
    const f = path.join(TREE, rel);
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
const psRow = (pid, ppid, started, cmd) => `${pid} ${ppid} ${lstart(started)} ${cmd}`;
const SUP_PID = 94154, CLAUDE_PID = 94158, PC_PID = 94175;
const tree = (pcStart = PC_START, extra = []) => [
  psRow(SUP_PID, 66055, PC_START, `/opt/homebrew/bin/node ${TREE}/agent/supervisor/chat-supervisor.mjs --agent chat`),
  psRow(CLAUDE_PID, SUP_PID, PC_START, "/usr/local/bin/claude -p --input-format stream-json"),
  psRow(PC_PID, CLAUDE_PID, pcStart, `node ${TREE}/agent/phone-channel/index.mjs`),
  ...extra,
];
const CHAT_PORT = 9204;
const chatIdle = { startedAt: new Date(PC_START).toISOString(), inFlight: null, queueDepth: 0, lastEventAgeMs: 30 * MIN,
  forksActive: 0, activeTools: [], chatAgentStatus: "idle" };

// o.ps: array of rows, or a function of the calls so far (to change between the
// first read and the re-check, which follows chat's second /health read).
function pcHarness(o = {}) {
  const calls = { kill: [], logs: [], dirtyArgs: [], checkArgs: [], ps: 0, chatReads: 0 };
  let state = o.state ? JSON.parse(JSON.stringify(o.state)) : {};
  const io = {
    getJson: async (url) => (url.includes(`:${CHAT_PORT}/`) ? (calls.chatReads++, { ...chatIdle, ...(o.chat || {}) })
      : (o.pm === undefined ? { children: [{ name: "chat-supervisor", alive: true, pid: SUP_PID }] } : o.pm)),
    healthPorts: () => ({ chat: CHAT_PORT }),   // the ops tiers read as down: not this test's business
    isDirty: (files) => { calls.dirtyArgs.push(files); return typeof o.dirty === "function" ? o.dirty(files) : !!o.dirty; },
    checksPass: (files) => { calls.checkArgs.push(files); return true; },
    readState: () => JSON.parse(JSON.stringify(state)),
    writeState: (st) => { state = JSON.parse(JSON.stringify(st)); },
    readJson: () => null,
    say: (msg) => calls.logs.push(msg),
    alive: () => false,
    isSupervisorPid: () => true,
    git: () => "",
    now: () => new Date(o.now ?? NOW),
    sleep: async () => {},
    kill: (pid, sig) => calls.kill.push([pid, sig]),
    gitBusy: () => null,
    statMs: (f) => fs.statSync(f).mtimeMs,
    ps: () => { calls.ps++; if (o.psThrows) throw new Error("ps hung"); if (o.psNull) return null;
      const rows = typeof o.ps === "function" ? o.ps(calls) : o.ps ?? tree(); return rows.join("\n") + "\n"; },
    launchdPid: () => null,                     // hum-sense not running here
    kickstart: () => {},
  };
  return { io, calls, state: () => state };
}

test("companionView: the phone-channel whose parent's parent is the chat supervisor, oldest first, start rounded up", () => {
  const entry = "agent/phone-channel/index.mjs";
  const rows = c.parsePs(tree(PC_START, [
    psRow(500, 1, PC_START - 3_600_000, `node ${TREE}/agent/phone-channel/index.mjs`),   // an orphan: not under chat
    psRow(501, CLAUDE_PID, PC_START + 5_000, `node ${TREE}/agent/phone-channel/index.mjs`),   // a younger duplicate
  ]).join("\n"));
  assert.deepEqual(c.companionView({ rows, entry, supPid: SUP_PID, root: TREE }), { pid: PC_PID, startedMs: PC_START + 999 });
  assert.equal(c.companionView({ rows, entry, supPid: null, root: TREE }), null);
  assert.equal(c.companionView({ rows, entry, supPid: 12345, root: TREE }), null);
  assert.equal(c.companionView({ rows: c.parsePs(tree().slice(0, 2).join("\n")), entry, supPid: SUP_PID, root: TREE }), null);
});

test("decide: chat is stale through its companion alone, keyed on the union stamp, and not on an unknown", () => {
  const now = at("2026-10-11T08:42:00Z");
  const pc = (over = {}) => ({ name: "phone-channel", stampMs: CODE, run: { pid: 7, startedMs: T0 }, ...over });
  const chat = (companion) => sup("chat", { startedMs: CODE + 1000, stampMs: T0, companion });
  const r = decide({ now, sups: [chat(pc())] });
  assert.equal(r.reload.agent, "chat");
  assert.match(r.reload.reason, /^phone-channel on code older than disk \(pid 7 /);
  assert.equal(decide({ now, sups: [chat(pc())], state: { chat: { stampMs: CODE } } }).holds[0].reason, "already reloaded for this code once");
  assert.deepEqual(decide({ now, sups: [chat(pc({ run: null }))] }), { reload: null, holds: [] }, "not found: the supervisor alone, which is current");
  assert.deepEqual(decide({ now, sups: [chat(pc({ run: { pid: 7, startedMs: CODE + 1 } }))] }), { reload: null, holds: [] });
});

test("phone-channel behind its own code, chat supervisor current: chat is reloaded once, then held on the same stamp", async () => {
  pcTree({ "lib/push.mjs": LANDED });
  const h = pcHarness();
  assert.equal(await c.main([], h.io), 5, "still stale at this tick, so nothing may clear yet");
  assert.deepEqual(h.calls.kill, [[SUP_PID, "SIGTERM"]]);
  assert.equal(h.state().chat.stampMs, LANDED);
  assert.ok(h.calls.logs.some((l) => l.startsWith("chat: reloaded (SIGTERM pid 94154") && l.includes("phone-channel on code older than disk")), h.calls.logs.join("\n"));
  // The supervisor came back and settled, but phone-channel somehow still runs the old code: no loop.
  const later = NOW + 11 * MIN;
  const h2 = pcHarness({ state: h.state(), now: later, chat: { startedAt: new Date(NOW + MIN).toISOString() } });
  assert.equal(await c.main([], h2.io), 5);
  assert.deepEqual(h2.calls.kill, []);
  assert.equal(h2.state()._held.chat, "already reloaded for this code once");
  assert.equal(h2.state().chat.settled, true);
  // ...and it does come back new: chat is current, nothing held or stale.
  const h3 = pcHarness({ state: h2.state(), now: later, chat: { startedAt: new Date(NOW + MIN).toISOString() }, ps: tree(NOW + MIN) });
  await c.main([], h3.io);
  assert.deepEqual(h3.calls.kill, []);
  assert.equal(h3.state()._held.chat, undefined);
  assert.equal(h3.state()._stale_since.chat, undefined);
});

test("phone-channel not found under the chat supervisor, or ps unreadable: chat is judged on the supervisor alone", async () => {
  pcTree({ "lib/push.mjs": LANDED });
  const orphan = [tree()[0], tree()[1], psRow(500, 1, PC_START, `node ${TREE}/agent/phone-channel/index.mjs`)];
  for (const o of [{ ps: tree().slice(0, 2) }, { ps: orphan }, { psNull: true }, { psThrows: true },
    { pm: { children: [{ name: "chat-supervisor", alive: false, pid: SUP_PID }] } }]) {
    const h = pcHarness(o);
    await c.main([], h.io);
    assert.deepEqual(h.calls.kill, [], JSON.stringify(o));
    assert.equal(h.state()._held.chat, undefined, JSON.stringify(o));
    assert.equal(h.state()._stale_since.chat, undefined, JSON.stringify(o));
  }
});

test("phone-channel already on the code on disk: no reload", async () => {
  pcTree({ "lib/push.mjs": LANDED });
  const h = pcHarness({ ps: tree(LANDED + MIN) });
  await c.main([], h.io);
  assert.deepEqual(h.calls.kill, []);
  assert.equal(h.state()._stale_since.chat, undefined);
});

test("an uncommitted edit in phone-channel's closure holds chat; the gates see both closures", async () => {
  pcTree({ "lib/push.mjs": LANDED });
  const pcDirty = (files) => files.some((f) => f.endsWith(`${path.sep}lib${path.sep}push.mjs`));
  const h = pcHarness({ dirty: pcDirty });
  await c.main([], h.io);
  assert.deepEqual(h.calls.kill, []);
  assert.equal(h.state()._held.chat, "uncommitted edits in its code");
  // Only the supervisor behind (phone-channel current): a restart still restarts
  // phone-channel, so an uncommitted edit in its closure must hold it too.
  pcTree({ "lib/session.mjs": LANDED, "lib/push.mjs": PC_START - MIN });
  const h2 = pcHarness({ dirty: pcDirty, chat: { startedAt: new Date(PC_START).toISOString() } });
  await c.main([], h2.io);
  assert.deepEqual(h2.calls.kill, []);
  assert.equal(h2.state()._held.chat, "uncommitted edits in its code");
  const rel = h2.calls.dirtyArgs[0].map((f) => path.relative(TREE, f)).sort();
  assert.deepEqual(rel, ["agent/phone-channel/index.mjs", "agent/supervisor/chat-supervisor.mjs", "lib/push.mjs", "lib/session.mjs"]);
  // committed: node --check runs over the same union, then the reload goes ahead
  const h3 = pcHarness();
  await c.main([], h3.io);
  assert.deepEqual(h3.calls.checkArgs[0].map((f) => path.relative(TREE, f)).sort(), rel);
  assert.deepEqual(h3.calls.kill, [[SUP_PID, "SIGTERM"]]);
});

test("re-checks the companion right before the signal: a phone-channel that came back on its own holds", async () => {
  pcTree({ "lib/push.mjs": LANDED });
  const h = pcHarness({ ps: (calls) => (calls.chatReads < 2 ? tree() : tree(NOW)) });   // a session rotation in between
  await c.main([], h.io);
  assert.deepEqual(h.calls.kill, []);
  assert.equal(h.state()._held.chat, "phone-channel now on the code on disk");
  assert.ok(h.calls.logs.includes("chat: stale, holding (phone-channel now on the code on disk, on re-check)"), h.calls.logs.join("\n"));
  // gone by then: an unknown never reloads
  const gone = pcHarness({ ps: (calls) => (calls.chatReads < 2 ? tree() : tree().slice(0, 2)) });
  await c.main([], gone.io);
  assert.deepEqual(gone.calls.kill, []);
  assert.equal(gone.state()._held.chat, "phone-channel not found");
});

test("chat held on a stale phone-channel for 6h pages through this tool's own exit 4", async () => {
  pcTree({ "lib/push.mjs": LANDED });
  const state = { _stale_since: { chat: { stampMs: LANDED, since: new Date(NOW - 7 * 3_600_000).toISOString() } } };
  const h = pcHarness({ state, chat: { inFlight: { id: "x" } } });
  assert.equal(await c.main([], h.io), 4);
  assert.equal(h.state()._held.chat, "turn in flight");
  assert.ok(h.calls.logs.some((l) => l.startsWith("chat (its phone-channel): on code older than disk for over 6h")), h.calls.logs.join("\n"));
});

test("--report: phone-channel's fix names the reload with chat", () => {
  const pc = c.REPORT.find((t) => t.name === "phone-channel");
  assert.match(pc.fix, /reloads it with chat/);
});
