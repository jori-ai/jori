// jev-p1-resolution.test.mjs — Jev in front of the p1-resolution-scan turn (lib/jev-p1-gate.mjs).
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jev-p1-gate-"));
// The kernel's own site definition, so the test never reads this install's data/.
fs.mkdirSync(path.join(tmp, "questions"));
fs.copyFileSync(path.resolve("agent/config/jev-questions/p1-resolution.json"), path.join(tmp, "questions", "p1-resolution.json"));
Object.assign(process.env, {
  JEV_CONFIG_FILE: path.join(tmp, "jev-config.json"),
  JEV_QUESTIONS_DIR: path.join(tmp, "questions"),
  JEV_SHADOW_DIR: path.join(tmp, "shadow"),
  JEV_EXCLUDE_SENDERS_FILE: path.join(tmp, "exclude.json"),
  P1_RESOLUTIONS_FILE: path.join(tmp, "p1-resolutions.jsonl"),
  JEV_NO_ALERT: "1",
  JEV_PRIVATE_SCREEN: "off",
  TYPESAFE_API_KEY: "test-key",
});
fs.writeFileSync(process.env.JEV_EXCLUDE_SENDERS_FILE, JSON.stringify({ senders: [{ domain: "bank.example", category: "financial" }, { contains: "mychart", category: "health" }] }));

let jevCalls = 0;
let probs = [];
globalThis.fetch = async (url, init) => {
  if (String(url).includes("/api/")) throw new Error("ECONNREFUSED (test: no ollama)");
  jevCalls++;
  const body = JSON.parse(init.body);
  const answers = {};
  Object.keys(body.questions).forEach((k, i) => { answers[k] = { type: "boolean", probability: probs[i] ?? 0.03 }; });
  return new Response(JSON.stringify({ answers }), { status: 200 });
};

const g = await import("../lib/jev-p1-gate.mjs");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const SH = process.env.JEV_SHADOW_DIR;
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const daily = () => (fs.existsSync(SH) ? fs.readdirSync(SH).filter((x) => /^\d{4}-\d\d-\d\d\.jsonl$/.test(x)).flatMap((x) => lines(path.join(SH, x))) : []);
const PENDING = () => lines(path.join(SH, "p1-resolution-pending.jsonl"));
const DIS = () => lines(path.join(SH, "disagreements.jsonl"));
const meta = { m1: { id: "m1", from: "Ann Example <ann@title.example>", subject: "Re: closing docs", internalDate: Date.now() - 2 * 36e5, snippet: "Attached the final wire instructions", labelIds: ["Label_28"], thread_messages: 6, newest_from: "ann@title.example", newest_is_sent: false },
  m2: { id: "m2", from: "Agent <agent@example.org>", subject: "Newsletter digest", internalDate: Date.now() - 96 * 36e5, snippet: "Your digest", labelIds: ["Label_28"], thread_messages: 1, newest_from: "agent@example.org", newest_is_sent: false },
  bank: { id: "bank", from: "Bank <alerts@bank.example>", subject: "Large purchase", internalDate: Date.now(), snippet: "$2,400 at ...", labelIds: [], thread_messages: 1 } };
let spawned;
const deps = (over = {}) => ({ fetchMeta: async (id) => meta[id], spawnShadow: (id) => spawned.push(id), ...over });

beforeEach(() => {
  fs.rmSync(SH, { recursive: true, force: true });
  fs.rmSync(process.env.P1_RESOLUTIONS_FILE, { force: true });
  fs.writeFileSync(process.env.JEV_CONFIG_FILE, JSON.stringify({ shadow_days: 7, shadow_until: null, default_threshold: 0.85, sites: {} }));
  jevCalls = 0; probs = []; spawned = [];
});

test("Jev confident every new id should be left → skip the turn, queue the shadow", async () => {
  probs = [0.03, 0.05];
  const r = await g.p1JevGate(["m1", "m2"], deps());
  assert.equal(r.dispatch, false);
  assert.equal(jevCalls, 1, "one request, one question per id");
  assert.deepEqual(spawned, [r.batchId]);
  const [p] = PENDING();
  assert.equal(p.kind, "skipped"); assert.deepEqual(p.jev.downgrade, []);
});

test("any downgrade → dispatch; reconcile compares against the scan's own audit rows, once", async () => {
  probs = [0.03, 0.97];
  const r = await g.p1JevGate(["m1", "m2"], deps());
  assert.equal(r.dispatch, true);
  g.confirmDispatched(r.batchId); // the trigger's curl succeeded
  assert.equal(g.reconcileP1(Date.now()), 0, "not before the settle window");
  fs.writeFileSync(process.env.P1_RESOLUTIONS_FILE, JSON.stringify({ ts: new Date(Date.now() + 1000).toISOString(), messageId: "m2", source: "unstar-scan", success: true }) + "\n");
  const later = Date.now() + g.SETTLE_MS + 5000;
  assert.equal(g.reconcileP1(later), 1);
  assert.equal(g.reconcileP1(later), 0, "never compared twice");
  assert.equal(DIS().length, 0, "Jev said downgrade m2, the scan downgraded m2 → agree");
});

test("the scan acting on NONE of the batch is not a verdict — no comparison, retired unobserved", async () => {
  probs = [0.97, 0.03];
  const r = await g.p1JevGate(["m1", "m2"], deps());
  g.confirmDispatched(r.batchId);
  assert.equal(g.reconcileP1(Date.now() + g.SETTLE_MS + 5000), 0, "silence is not a legacy verdict");
  assert.equal(DIS().length, 0, "no false disagreement");
  assert.equal(g.reconcileP1(Date.now() + g.VERDICT_TTL_MS + 5000), 0, "retired as no-verdict, not compared");
  assert.equal(DIS().length, 0);
});

test("a partial downgrade IS a verdict — the ids the scan left are compared", async () => {
  probs = [0.97, 0.97];
  const r = await g.p1JevGate(["m1", "m2"], deps());
  g.confirmDispatched(r.batchId);
  fs.writeFileSync(process.env.P1_RESOLUTIONS_FILE, JSON.stringify({ ts: new Date(Date.now() + 1000).toISOString(), messageId: "m2", source: "unstar-scan", success: true }) + "\n");
  assert.equal(g.reconcileP1(Date.now() + g.SETTLE_MS + 5000), 1);
  assert.equal(DIS().length, 1, "Jev said downgrade both, the scan downgraded only m2");
  assert.equal(DIS()[0].site, "p1-resolution");
  assert.deepEqual(JSON.parse(DIS()[0].shadow.value).downgrade, ["m2"]);
});

test("a verdict that only lands hours later is still compared (not frozen at SETTLE_MS)", async () => {
  probs = [0.4, 0.03]; // "leave both", but below threshold → dispatched, so the turn is the oracle
  const r = await g.p1JevGate(["m1", "m2"], deps());
  assert.equal(r.dispatch, true);
  g.confirmDispatched(r.batchId);
  assert.deepEqual(PENDING()[0].jev.downgrade, []);
  assert.equal(g.reconcileP1(Date.now() + g.SETTLE_MS + 5000), 0, "nothing yet");
  fs.writeFileSync(process.env.P1_RESOLUTIONS_FILE, JSON.stringify({ ts: new Date(Date.now() + 3.7 * 3600e3).toISOString(), messageId: "m2", source: "unstar-scan", success: false }) + "\n");
  assert.equal(g.reconcileP1(Date.now() + 4 * 3600e3), 1, "compared when the turn finally spoke");
  assert.equal(DIS().length, 1, "Jev said leave both, the scan downgraded m2 → real disagreement");
});

test("low confidence dispatches and is still compared (calibration)", async () => {
  probs = [0.6, 0.03];
  const r = await g.p1JevGate(["m1", "m2"], deps());
  assert.equal(r.dispatch, true);
  assert.equal(PENDING()[0].jev_used, false);
});

test("a financial or medical sender keeps the whole batch off Jev", async () => {
  const r = await g.p1JevGate(["m1", "bank"], deps());
  assert.equal(r.dispatch, true);
  assert.equal(jevCalls, 0);
  const row = daily()[0];
  assert.equal(row.reason, "financial-excluded");
  assert.equal(row.input, "[withheld]");
  assert.doesNotMatch(JSON.stringify(row), /2,400/);
});

test("metadata failure and screen failure both fail open to dispatch", async () => {
  const r = await g.p1JevGate(["m1"], deps({ fetchMeta: async () => { throw new Error("gmail down"); } }));
  assert.equal(r.dispatch, true);
  process.env.JEV_PRIVATE_SCREEN = "";
  try {
    const r2 = await g.p1JevGate(["m1"], deps());
    assert.equal(r2.dispatch, true);
    assert.equal(jevCalls, 0);
  } finally { process.env.JEV_PRIVATE_SCREEN = "off"; }
});

test("shadow CLI: skipped batch, Haiku would have downgraded one → one disagreement", async () => {
  probs = [0.03, 0.03];
  const r = await g.p1JevGate(["m1", "m2"], deps());
  const run = () => execFileSync(process.execPath, ["bin/jev-gate-shadow", "p1-resolution", r.batchId],
    { env: { ...process.env, JEV_GATE_SHADOW_STUB: '{"downgrade": ["m2", "not-in-batch"]}' }, encoding: "utf8" });
  assert.match(run(), /haiku-shadow/);
  run();
  assert.equal(DIS().length, 1);
});

test("CLI: `check` with no ids and `reconcile` both exit 0 (fail-open)", () => {
  execFileSync(process.execPath, ["bin/jev-p1-gate", "check", "[]"], { env: process.env });
  execFileSync(process.execPath, ["bin/jev-p1-gate", "reconcile"], { env: process.env });
});

test("a shadow-forced id is dispatched to the real scan, never Jev-skipped twice", async () => {
  const { P1_FORCE_FILE } = await import("../lib/jev-p1-gate.mjs");
  fs.mkdirSync(path.dirname(P1_FORCE_FILE), { recursive: true });
  fs.writeFileSync(P1_FORCE_FILE, JSON.stringify({ ids: ["forced1"] }));
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, [path.resolve("bin/jev-p1-gate"), "check", JSON.stringify(["forced1", "other"])], { env: process.env, encoding: "utf8" });
  assert.equal(r.status, 0, "dispatch");
  assert.match(r.stderr, /shadow-forced re-scan/);
  assert.deepEqual(JSON.parse(fs.readFileSync(P1_FORCE_FILE, "utf8")).ids, [], "consumed once");
});

test("an UNCONFIRMED dispatch (supervisor unhealthy / curl failed) is never compared", async () => {
  probs = [0.97, 0.03];
  await g.p1JevGate(["m1", "m2"], deps());
  assert.equal(g.reconcileP1(Date.now() + g.SETTLE_MS + 5000), 0);
  assert.equal(g.reconcileP1(Date.now() + 3 * 3600e3), 0, "retired as no-run, not compared");
  assert.equal(DIS().length, 0, "no false disagreement");
});

test("a downgrade by ANY source (e.g. p1-reply-sweep) counts as the scan downgrading it", async () => {
  probs = [0.03, 0.97];
  const r = await g.p1JevGate(["m1", "m2"], deps());
  g.confirmDispatched(r.batchId);
  fs.writeFileSync(process.env.P1_RESOLUTIONS_FILE, JSON.stringify({ ts: new Date(Date.now() + 1000).toISOString(), messageId: "m2", source: "reply-sweep", success: true }) + "\n");
  assert.equal(g.reconcileP1(Date.now() + g.SETTLE_MS + 5000), 1);
  assert.equal(DIS().length, 0);
});

test("a batch too big to screen dispatches without fetching anything", async () => {
  let fetched = 0;
  const ids = Array.from({ length: g.MAX_BATCH + 1 }, (_, i) => `big${i}`);
  const r = await g.p1JevGate(ids, { ...deps(), fetchMeta: async () => { fetched++; return {}; } });
  assert.equal(r.dispatch, true);
  assert.equal(fetched, 0);
});

test("metadata is fetched concurrently", async () => {
  let inFlight = 0, peak = 0;
  const slow = async (id) => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 20)); inFlight--; return { id, from: "a@b.c", subject: "s", internalDate: Date.now(), snippet: "", labelIds: [] }; };
  probs = [0.97, 0.97];
  await g.p1JevGate(["m1", "m2"], { ...deps(), fetchMeta: slow });
  assert.equal(peak, 2);
});

test("p1-scan-gate treats a forced id as fresh even when it is in seen", () => {
  const seenFile = path.join(tmp, "seen-forced.json");
  fs.writeFileSync(seenFile, JSON.stringify({ ids: ["f1", "f2"] }));
  fs.mkdirSync(process.env.JEV_SHADOW_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.JEV_SHADOW_DIR, "p1-force.json"), JSON.stringify({ ids: ["f2", "gone"] }));
  const stub = path.join(tmp, "gmail-action-stub.sh");
  fs.writeFileSync(stub, "#!/bin/sh\nprintf 'f1\\nf2\\n'\n", { mode: 0o755 });
  const r = spawnSync(process.execPath, [path.resolve("bin/p1-scan-gate")], { env: { ...process.env, P1_SCAN_SEEN: seenFile, P1_SCAN_GMAIL_ACTION: stub }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim()), ["f2"], "forced id re-dispatched although seen");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(process.env.JEV_SHADOW_DIR, "p1-force.json"), "utf8")).ids, ["f2"], "the no-longer-P1 forced id is pruned");
});
