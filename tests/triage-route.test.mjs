// triage-route.test.mjs — per-message Gmail triage → ops-light (with fallback
// to the ops dispatcher), gmail-source's command-channel carve-out, and the
// --exclude-dynamic-system-prompt-sections flag gate.
//
// Run: node --test tests/triage-route.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeTriageRouter, triageTargetFromConfig } from "../agent/supervisor/triage-route.mjs";
import { supportsCliFlag, ClaudeSession } from "../agent/supervisor/claude-session.mjs";

const AGENTS = {
  agents: {
    ops: { supervisor: { webhookPort: 9092, healthPort: 9093, gmailPubsubPort: 9090 } },
    "ops-light": { supervisor: { webhookPort: 9082, healthPort: 9083 } },
  },
};

test("target: defaults to ops-light; 'ops'/null roll back; missing ports disable", () => {
  assert.deepEqual(triageTargetFromConfig(AGENTS), { agent: "ops-light", webhookPort: 9082, healthPort: 9083 });
  const roll = structuredClone(AGENTS); roll.agents.ops.gmailTriageTarget = "ops";
  assert.equal(triageTargetFromConfig(roll), null);
  const off = structuredClone(AGENTS); off.agents.ops.gmailTriageTarget = null;
  assert.equal(triageTargetFromConfig(off), null);
  const bad = structuredClone(AGENTS); delete bad.agents["ops-light"].supervisor.webhookPort;
  assert.equal(triageTargetFromConfig(bad), null);
});

function fakeFetch({ healthy = true, postStatus = 200, throwOnPost = false } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith("/health")) return { ok: true, json: async () => ({ childAlive: healthy }) };
    if (throwOnPost) throw new Error("ECONNREFUSED");
    return { ok: postStatus < 300, status: postStatus };
  };
  return { fn, calls };
}

const target = { agent: "ops-light", webhookPort: 9082, healthPort: 9083 };

test("healthy ops-light: POSTs {task, source} with the bearer token; nothing local", async () => {
  const local = [];
  const { fn, calls } = fakeFetch();
  const route = makeTriageRouter({ target, localDispatch: (c, s) => local.push(s), tokenFile: "/x", readFile: () => "tok\n", fetchFn: fn });
  const r = await route("CONTENT", "gmail:abc");
  assert.equal(r.routed, "ops-light");
  assert.equal(local.length, 0);
  const post = calls.find((c) => c.init.method === "POST");
  assert.equal(post.url, "http://127.0.0.1:9082");
  assert.equal(post.init.headers.Authorization, "Bearer tok");
  assert.deepEqual(JSON.parse(post.init.body), { task: "CONTENT", source: "gmail:abc" });
});

test("unhealthy ops-light, failed POST, or no target → the ops dispatcher (never dropped)", async () => {
  for (const opts of [{ healthy: false }, { postStatus: 500 }, { throwOnPost: true }]) {
    const local = [];
    const { fn } = fakeFetch(opts);
    const route = makeTriageRouter({ target, localDispatch: (c, s) => local.push([c, s]), tokenFile: "/x", readFile: () => "", fetchFn: fn });
    const r = await route("C", "gmail:1");
    assert.equal(r.routed, "local", JSON.stringify(opts));
    assert.deepEqual(local, [["C", "gmail:1"]]);
  }
  const local = [];
  const route = makeTriageRouter({ target: null, localDispatch: (c, s) => local.push(s), tokenFile: "/x" });
  await route("C", "gmail:2");
  assert.deepEqual(local, ["gmail:2"]);
});

test("gmail-source: per-message triage uses the router, the command channel stays on ops", async () => {
  const { GmailSource } = await import("../agent/supervisor/gmail-source.mjs");
  const tmp = (await import("node:fs")).mkdtempSync((await import("node:path")).join(process.env.TMPDIR || "/tmp", "trt-"));
  process.env.RECLASSIFY_TRACKING_FILE = `${tmp}/track.json`;
  const g = new GmailSource({ lastHistoryFile: `${tmp}/last.json`, pauseFlagFile: `${tmp}/.p`, triageLog: () => {} });
  const local = [], routed = [];
  g._dispatchFn = (c, s) => local.push(s);
  g._triageDispatchFn = async (c, s) => { routed.push(s); return { routed: "ops-light" }; };
  g._dispatchTriage("X", "m1");
  g._dispatchTriage("Y", "m2", { commandChannel: true });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(routed, ["gmail:m1"]);
  assert.deepEqual(local, ["gmail:m2"]);
  // Router rejects → falls back locally.
  g._triageDispatchFn = async () => { throw new Error("boom"); };
  g._dispatchTriage("Z", "m3");
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(local.includes("gmail:m3"));
});

test("supportsCliFlag probes --help once and gates the flag", () => {
  let n = 0;
  const spawnSyncFn = () => { n++; return { status: 0, stdout: "  --exclude-dynamic-system-prompt-sections\n" }; };
  assert.equal(supportsCliFlag("--exclude-dynamic-system-prompt-sections", { claudeBin: "/fake/claude-a", spawnSyncFn }), true);
  assert.equal(supportsCliFlag("--exclude-dynamic-system-prompt-sections", { claudeBin: "/fake/claude-a", spawnSyncFn }), true);
  assert.equal(n, 1, "cached");
  assert.equal(supportsCliFlag("--exclude-dynamic-system-prompt-sections", { claudeBin: "/fake/claude-old", spawnSyncFn: () => ({ status: 0, stdout: "old help" }) }), false);
  assert.equal(supportsCliFlag("--x", { claudeBin: "/fake/broken", spawnSyncFn: () => { throw new Error("ENOENT"); } }), false);
});

test("ClaudeSession passes the flag only when asked", () => {
  const base = { sessionId: "s", model: "m" };
  assert.ok(new ClaudeSession({ ...base, excludeDynamicSystemPromptSections: true })._buildArgs({ resume: false }).includes("--exclude-dynamic-system-prompt-sections"));
  assert.ok(!new ClaudeSession(base)._buildArgs({ resume: false }).includes("--exclude-dynamic-system-prompt-sections"));
});

test("strict: config value 'strict' targets ops-light as the fallback", () => {
  const s = structuredClone(AGENTS); s.agents.ops.gmailTriageTarget = "strict";
  assert.deepEqual(triageTargetFromConfig(s), { agent: "ops-light", webhookPort: 9082, healthPort: 9083, strict: true });
});

test("strict: a finished one-shot is the whole route; a failed one falls back with what it did", async () => {
  const strictTarget = { ...target, strict: true };
  const packet = { messageId: "m1", from: "A <a@x.com>", subject: "s", date: "Mon, 16 Nov 2026 10:00:00 +0000" };
  // finished
  let { fn, calls } = fakeFetch();
  let seen = null;
  let route = makeTriageRouter({ target: strictTarget, localDispatch: () => {}, tokenFile: "/x", readFile: () => "t", fetchFn: fn,
    runStrict: async (p) => { seen = p; return { ok: true, actions: [{ tool: "gmail_message" }] }; } });
  assert.equal((await route("BODY", "gmail:m1", { packet })).routed, "strict");
  assert.equal(seen.content, "BODY");
  assert.equal(seen.messageId, "m1");
  assert.equal(calls.length, 0);
  // failed after acting → ops-light POST carries the note
  ({ fn, calls } = fakeFetch());
  route = makeTriageRouter({ target: strictTarget, localDispatch: () => {}, tokenFile: "/x", readFile: () => "t", fetchFn: fn,
    runStrict: async () => ({ ok: false, why: "no answer", actions: [{ tool: "gmail_message", summary: "gmail-action label m1 personal" }] }) });
  assert.equal((await route("BODY", "gmail:m1", { packet })).routed, "ops-light");
  const post = calls.find((c) => !c.url.endsWith("/health"));
  const body = JSON.parse(post.init.body);
  assert.ok(body.task.startsWith("BODY"));
  assert.ok(body.task.includes("gmail-action label m1 personal"));
  // no packet (e.g. an old caller) → straight to ops-light, the one-shot never runs
  ({ fn, calls } = fakeFetch());
  let ran = false;
  route = makeTriageRouter({ target: strictTarget, localDispatch: () => {}, tokenFile: "/x", readFile: () => "t", fetchFn: fn, runStrict: async () => { ran = true; return { ok: true }; } });
  assert.equal((await route("BODY", "gmail:m2")).routed, "ops-light");
  assert.equal(ran, false);
});

test("strict: at most strictMax one-shots at once; the rest go to ops-light", async () => {
  const { fn } = fakeFetch();
  let release;
  const gate = new Promise((r) => { release = r; });
  let started = 0;
  const route = makeTriageRouter({ target: { ...target, strict: true }, localDispatch: () => {}, tokenFile: "/x", readFile: () => "t", fetchFn: fn, strictMax: 2,
    runStrict: async () => { started++; await gate; return { ok: true, actions: [] }; } });
  const p = (id) => route("B", `gmail:${id}`, { packet: { messageId: id } });
  const a = p("a"), b = p("b");
  const c = await p("c");
  assert.equal(c.routed, "ops-light");
  assert.equal(started, 2);
  release();
  assert.equal((await a).routed, "strict");
  assert.equal((await b).routed, "strict");
});

test("strict-shadow: the dispatch is untouched and a dry one-shot runs alongside", async () => {
  const s = structuredClone(AGENTS); s.agents.ops.gmailTriageTarget = "strict-shadow";
  const t = triageTargetFromConfig(s);
  assert.equal(t.shadow, true); assert.equal(t.strict, undefined);
  const { fn, calls } = fakeFetch();
  const runs = [];
  const route = makeTriageRouter({ target: t, localDispatch: () => {}, tokenFile: "/x", readFile: () => "t", fetchFn: fn,
    runStrict: async (p, o) => { runs.push(o); return { ok: true, actions: [] }; } });
  assert.equal((await route("BODY", "gmail:s1", { packet: { messageId: "s1" } })).routed, "ops-light");
  assert.equal(JSON.parse(calls.find((c) => !c.url.endsWith("/health")).init.body).task, "BODY");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(runs, [{ dry: true }]);
});

test("strict: a run the supervisor never saw end is dispatched once by the sweep", async () => {
  const fs = await import("node:fs"); const os = await import("node:os"); const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tr-pending-"));
  let clock = 1_000_000;
  const { fn, calls } = fakeFetch();
  // a run that never returns (the supervisor "restarts" while it is in flight)
  const route = makeTriageRouter({ target: { ...target, strict: true }, localDispatch: () => {}, tokenFile: "/x", readFile: () => "t", fetchFn: fn,
    pendingDir: dir, sweepEveryMs: 0, now: () => clock, runStrict: () => new Promise(() => {}) });
  route("BODY", "gmail:p1", { packet: { messageId: "p1" } });
  await new Promise((r) => setImmediate(r));
  assert.equal(fs.readdirSync(dir).length, 1);
  assert.equal(await route.sweepPending(), 0);           // too fresh
  clock += 12 * 60 * 1000;
  assert.equal(await route.sweepPending(), 1);
  const post = calls.find((c) => !c.url.endsWith("/health"));
  assert.ok(JSON.parse(post.init.body).task.startsWith("BODY"));
  assert.equal(fs.readdirSync(dir).length, 0);
  assert.equal(await route.sweepPending(), 0);           // once
});
