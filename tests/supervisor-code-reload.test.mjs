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
