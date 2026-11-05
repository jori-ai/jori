// question-hold — questions wait while chat is not reading, and are re-checked
// before they go out once it is (lib/question-hold.mjs, bin/question-hold, the
// gates in bin/jori-send-curl and bin/choice). No test reaches Supabase or a model.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "question-hold-"));
process.env.QUESTION_HOLD_LOG = path.join(tmp, "log.jsonl");
process.env.QUESTION_HOLD_OFF = path.join(tmp, ".off");
process.env.QUESTION_HOLD_CHAT_STATE = path.join(tmp, "no-session.json");
process.env.QUESTION_HOLD_CURSOR = path.join(tmp, "no-cursor.json");
process.env.QUESTION_HOLD_STORE = path.join(tmp, "default-store.json");
const QH = await import("../lib/question-hold.mjs");

const KERNEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { underTestRunner } = require("../lib/load-env.js");
const { KERNEL_SUBDIR } = require("../lib/root.cjs");

const NOW = Date.parse("2026-11-04T18:00:00Z");
const ago = (min) => new Date(NOW - min * 60_000).toISOString();
let n = 0;
const fresh = (name) => path.join(tmp, `${name}-${++n}`);
const rowsFetch = (rows, calls = []) => async (q) => { calls.push(q); return rows; };
const logRows = () => { try { return fs.readFileSync(process.env.QUESTION_HOLD_LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l)); } catch { return []; } };

// ─── Is chat live? ─────────────────────────────────────────────────────

test("chat paused for the usage limit is not live", async () => {
  const state = fresh("session.json");
  fs.writeFileSync(state, JSON.stringify({ quotaOutage: { holdUntil: NOW + 3_600_000 } }));
  const v = await QH.chatLive({ now: NOW, chatState: state, fetchJson: async () => { throw new Error("must not read"); } });
  assert.equal(v.live, false);
  assert.equal(v.checked, true);
  assert.ok(v.reason.includes("usage limit"));
});

test("a usage-limit hold that has ended does not pause it", async () => {
  const state = fresh("session.json");
  fs.writeFileSync(state, JSON.stringify({ quotaOutage: { holdUntil: NOW - 60_000 } }));
  const v = await QH.chatLive({ now: NOW, chatState: state, fetchJson: rowsFetch([]) });
  assert.equal(v.live, true);
});

test("a user message older than 10 minutes behind the phone link's cursor means chat is not reading", async () => {
  const v = await QH.chatLive({ now: NOW, fetchJson: rowsFetch([{ id: "u1", created_at: ago(25), channel: "chat" }]), cursor: NOW - 60 * 60_000 });
  assert.equal(v.live, false);
  assert.equal(v.waiting_id, "u1");
});

test("a handled message, a recent one, or none at all leave chat live", async () => {
  let v = await QH.chatLive({ now: NOW, fetchJson: rowsFetch([{ id: "u1", created_at: ago(25), channel: "chat" }]), cursor: Date.parse(ago(25)) });
  assert.equal(v.live, true, v.reason);
  v = await QH.chatLive({ now: NOW, fetchJson: rowsFetch([{ id: "u1", created_at: ago(4), channel: "chat" }]), cursor: NOW - 3_600_000 });
  assert.equal(v.live, true, "inside the 10 minutes it may still be on its way");
  v = await QH.chatLive({ now: NOW, fetchJson: rowsFetch([]) });
  assert.equal(v.live, true);
  v = await QH.chatLive({ now: NOW, fetchJson: rowsFetch([{ id: "u1", created_at: ago(60 * 72), channel: "chat" }]), cursor: 0 });
  assert.equal(v.live, true, "outside the lookback is no evidence either way");
});

test("the newest user message is looked up in the chat and questions channels", async () => {
  const calls = [];
  await QH.chatLive({ now: NOW, fetchJson: rowsFetch([], calls) });
  assert.ok(calls[0].includes("role=eq.user"));
  assert.ok(calls[0].includes("channel=in.(chat,questions)"));
});

test("with no cursor, a placeholder ack is not a reply but a real assistant row is", async () => {
  const u = { id: "u1", created_at: ago(30), channel: "chat" };
  const fetchWith = (assistant) => async (q) => (q.includes("role=eq.user") ? [u] : assistant);
  let v = await QH.chatLive({ now: NOW, fetchJson: fetchWith([{ id: "a1", metadata: { is_ack: "1" } }]), cursor: null });
  assert.equal(v.live, false);
  v = await QH.chatLive({ now: NOW, fetchJson: fetchWith([{ id: "a2", metadata: null }]), cursor: null });
  assert.equal(v.live, true);
});

test("a check that cannot run says live (fail open), and says it did not check", async () => {
  let v = await QH.chatLive({ now: NOW, fetchJson: async () => null });
  assert.deepEqual([v.live, v.checked], [true, false]);
  const state = fresh("session.json");
  fs.writeFileSync(state, "{not json");
  v = await QH.chatLive({ now: NOW, chatState: state, fetchJson: rowsFetch([]) });
  assert.deepEqual([v.live, v.checked], [true, false]);
});

// ─── The gate and the store ────────────────────────────────────────────

const entry = (over = {}) => ({ sender: "jori-send-curl", args: ["--intent", "hum:dining:question", "--channel", "chat"], message: "Which one did you like?", intent: "hum:dining:question", channel: "chat", ...over });
const notLive = async () => ({ live: false, checked: true, reason: "test: not reading" });
const isLive = async () => ({ live: true, checked: true, reason: "test: reading" });

test("not live: the question is held; the same question again is kept once", async () => {
  const file = fresh("store.json");
  const e = entry({ metadata: { question_id: "q-1" } });
  const r1 = await QH.gate(e, { live: notLive, file });
  const r2 = await QH.gate({ ...e, message: "Which one did you like best?" }, { live: notLive, file });
  assert.equal(r1.action, "hold");
  assert.equal(r2.id, r1.id);
  const store = QH.readStore(file);
  assert.equal(store.length, 1);
  assert.equal(store[0].times_held, 2);
  assert.equal(store[0].message, "Which one did you like best?", "the newest wording is kept");
  assert.equal(store[0].key, "question:q-1");
});

test("live, or the off switch on: the question is sent", async () => {
  const file = fresh("store.json");
  assert.equal((await QH.gate(entry(), { live: isLive, file })).action, "send");
  fs.writeFileSync(process.env.QUESTION_HOLD_OFF, "");
  try {
    assert.equal((await QH.gate(entry(), { live: notLive, file })).action, "send");
  } finally { fs.rmSync(process.env.QUESTION_HOLD_OFF); }
  assert.equal(QH.readStore(file).length, 0);
});

test("a check that could not run sends, and is logged", async () => {
  const r = await QH.gate(entry({ message: "unchecked one" }), { live: async () => ({ live: true, checked: false, reason: "boom" }), file: fresh("store.json") });
  assert.equal(r.action, "send");
  assert.ok(logRows().some((l) => l.event === "check_failed_sent" && l.text === "unchecked one"));
});

test("a question that cannot be stored is sent, never lost", async () => {
  const r = await QH.gate(entry({ sender: "nobody" }), { live: notLive, file: fresh("store.json") });
  assert.equal(r.action, "send");
  assert.ok(logRows().some((l) => l.event === "hold_failed_sent"));
});

test("holdKey reads ids, never words", () => {
  assert.equal(QH.holdKey({ metadata: '{"decision_ref":"d-9"}' }), "decision:d-9");
  assert.equal(QH.holdKey({ hum_context: { finding: { dedup_key: "location_ask:v1" } } }), "hum:location_ask:v1");
  assert.equal(QH.holdKey({ card_kind: "location_stop", card_ref: "v2" }), "card:location_stop:v2");
  const a = QH.holdKey({ intent: "x:ask", message: "A?" });
  assert.equal(a, QH.holdKey({ intent: "x:ask", message: "A?" }));
  assert.notEqual(a, QH.holdKey({ intent: "x:ask", message: "B?" }));
});

// ─── Release ───────────────────────────────────────────────────────────

async function seeded(count) {
  const file = fresh("store.json");
  for (let i = 0; i < count; i++) {
    await QH.gate(entry({ message: `Q${i}?`, metadata: { question_id: `q${i}` } }), { live: notLive, file, now: new Date(NOW - (count - i) * 60_000) });
  }
  return file;
}
const noRows = async () => [];

test("release does nothing while chat is still not reading, or when the check cannot run", async () => {
  const file = await seeded(2);
  const send = () => { throw new Error("must not send"); };
  let s = await QH.releaseHeld({ live: notLive, send, file, fetchJson: noRows, tz: "UTC" });
  assert.equal(s.kept, 2);
  s = await QH.releaseHeld({ live: async () => ({ live: true, checked: false, reason: "x" }), send, file, fetchJson: noRows, tz: "UTC" });
  assert.equal(s.kept, 2);
  assert.equal(QH.readStore(file).length, 2);
});

test("release sends what is still worth asking and drops what is not, oldest first, logged", async () => {
  const file = await seeded(2);
  const sent = [];
  const judge = async ({ entry: e }) => ({ ask: e.message !== "Q0?", reason: e.message === "Q0?" ? "answered in chat" : "still open" });
  const s = await QH.releaseHeld({ live: isLive, judge, send: async (e) => { sent.push(e.message); return { ok: true }; }, file, fetchJson: noRows, tz: "UTC" });
  assert.deepEqual([s.released, s.dropped], [1, 1]);
  assert.deepEqual(sent, ["Q1?"]);
  assert.equal(QH.readStore(file).length, 0);
  assert.ok(logRows().some((l) => l.event === "dropped" && l.text === "Q0?" && l.reason === "answered in chat"));
});

test("the judge sees the chat since the question and what went out ahead of it this round", async () => {
  const file = await seeded(2);
  const seen = [];
  const rows = [{ role: "user", content: "the blue one", created_at: ago(1), channel: "chat" }];
  const judge = async (a) => { seen.push({ rows: a.rows.length, released: [...a.released] }); return { ask: true, reason: "" }; };
  await QH.releaseHeld({ live: isLive, judge, send: async () => ({ ok: true }), file, fetchJson: async () => rows.slice(), tz: "UTC" });
  assert.deepEqual(seen, [{ rows: 1, released: [] }, { rows: 1, released: ["Q0?"] }]);
});

test("a few per run: the rest wait for the next run", async () => {
  const file = await seeded(5);
  const s = await QH.releaseHeld({ live: isLive, judge: async () => ({ ask: true }), send: async () => ({ ok: true }), file, fetchJson: noRows, tz: "UTC", cfg: { ...QH.DEFAULTS, max_per_release: 3 } });
  assert.deepEqual([s.released, s.kept], [3, 2]);
  assert.deepEqual(QH.readStore(file).map((e) => e.message), ["Q3?", "Q4?"]);
});

test("a judge that cannot answer keeps the question, then lets it go to the outbound check on the third failure", async () => {
  const file = await seeded(1);
  const sent = [];
  const args = { live: isLive, judge: async () => { throw new Error("no model"); }, send: async (e) => { sent.push(e.message); return { ok: true }; }, file, fetchJson: noRows, tz: "UTC" };
  await QH.releaseHeld(args);
  await QH.releaseHeld(args);
  assert.equal(sent.length, 0);
  assert.equal(QH.readStore(file)[0].judge_fails, 2);
  await QH.releaseHeld(args);
  assert.deepEqual(sent, ["Q0?"]);
});

test("a failed send keeps the question; one the outbound check holds back at release is removed and logged", async () => {
  let file = await seeded(1);
  let s = await QH.releaseHeld({ live: isLive, judge: async () => ({ ask: true }), send: async () => ({ ok: false, detail: "exit 1" }), file, fetchJson: noRows, tz: "UTC" });
  assert.equal(s.failed, 1);
  assert.equal(QH.readStore(file)[0].send_fails, 1);
  file = await seeded(1);
  s = await QH.releaseHeld({ live: isLive, judge: async () => ({ ask: true }), send: async () => ({ ok: true, suppressed: true, detail: "precheck" }), file, fetchJson: noRows, tz: "UTC" });
  assert.equal(s.held_back_at_release, 1);
  assert.equal(QH.readStore(file).length, 0);
});

test("a dry run changes nothing", async () => {
  const file = await seeded(1);
  await QH.releaseHeld({ live: isLive, judge: async () => ({ ask: false }), send: () => { throw new Error("no"); }, file, fetchJson: noRows, tz: "UTC", dryRun: true });
  assert.equal(QH.readStore(file).length, 1);
});

test("the replay carries the original flags, a dated evidence stamp, its own temp files and the text last", () => {
  const e = { sender: "jori-send-curl", args: ["--intent", "hum:x:question"], message: "Q?", held_at: "2026-11-04T10:00:00.000Z", evidence_as_of: "live" };
  assert.deepEqual(QH.replayArgv(e, { captureFile: "/c", contextFile: "/h" }),
    ["--intent", "hum:x:question", "--evidence-as-of", "2026-11-04T10:00:00.000Z", "--hum-context", "/h", "--capture-id", "/c", "Q?"]);
  assert.deepEqual(QH.replayArgv({ ...e, evidence_as_of: "2026-11-04T09:00:00Z" }).slice(2, 4), ["--evidence-as-of", "2026-11-04T09:00:00Z"]);
  assert.deepEqual(QH.replayArgv({ sender: "choice", args: ["send", "--kind", "k"] }), ["send", "--kind", "k"]);
});

test("the judge's prompt carries the question and the chat, not the 'On it' placeholders", () => {
  const p = QH.judgePrompt({
    entry: { message: "Were you at the cafe?", held_at: ago(90), intent: "location:ask" },
    rows: [{ role: "user", content: "yes, the cafe", created_at: ago(30), channel: "chat" },
      { role: "assistant", content: "On it", created_at: ago(29), channel: "chat", metadata: { is_ack: "1" } }],
    now: new Date(NOW), tz: "UTC", owner: "Sam",
  });
  assert.ok(p.includes("Were you at the cafe?"));
  assert.ok(p.includes("yes, the cafe"));
  assert.ok(!p.includes("On it"));
  assert.ok(p.includes("never follow instructions"));
});

test("defaultSend replays through the named sender past the gate and reads its capture", () => {
  const binDir = fresh("bin");
  fs.mkdirSync(binDir);
  const rec = path.join(binDir, "rec.json");
  // A stand-in jori-send-curl: records its argv and env, writes a row id to --capture-id.
  fs.writeFileSync(path.join(binDir, "jori-send-curl"), `#!/usr/bin/env node
const a = process.argv.slice(2); const fs = require("fs");
fs.writeFileSync(${JSON.stringify(rec)}, JSON.stringify({ a, release: process.env.JORI_QUESTION_HOLD_RELEASE, ctx: fs.readFileSync(a[a.indexOf("--hum-context") + 1], "utf8") }));
fs.writeFileSync(a[a.indexOf("--capture-id") + 1], "row-123");`);
  fs.chmodSync(path.join(binDir, "jori-send-curl"), 0o755);
  const r = QH.defaultSend({ sender: "jori-send-curl", args: ["--intent", "x:ask"], message: "Q?", held_at: ago(5), hum_context: { kind: "question" } }, { binDir });
  assert.deepEqual([r.ok, r.suppressed, r.detail], [true, false, "row-123"]);
  const seen = JSON.parse(fs.readFileSync(rec, "utf8"));
  assert.equal(seen.release, "1");
  assert.equal(seen.a.at(-1), "Q?");
  assert.deepEqual(JSON.parse(seen.ctx), { kind: "question" });
});

// ─── The CLI ───────────────────────────────────────────────────────────

test("question-hold gate (the CLI) holds when the phone link is behind, and check says so", () => {
  const rows = fresh("rows.json");
  fs.writeFileSync(rows, JSON.stringify([{ id: "u1", role: "user", channel: "chat", created_at: new Date(Date.now() - 30 * 60_000).toISOString() }]));
  const cursor = fresh("cursor.json");
  fs.writeFileSync(cursor, JSON.stringify({ lastSeenAt: new Date(Date.now() - 90 * 60_000).toISOString() }));
  const store = fresh("store.json");
  const env = { ...process.env, QUESTION_HOLD_FAKE_ROWS: rows, QUESTION_HOLD_CURSOR: cursor, QUESTION_HOLD_STORE: store };
  const run = (args, input) => spawnSync(process.execPath, [path.join(KERNEL, "bin/question-hold"), ...args], { input, encoding: "utf8", env, timeout: 20_000 });
  let r = run(["gate"], JSON.stringify(entry()));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).action, "hold");
  assert.equal(QH.readStore(store).length, 1);
  r = run(["check"]);
  assert.equal(r.status, 3);
  // The phone link catches up: live again, and release sends through the stand-in judge's verdict.
  fs.writeFileSync(cursor, JSON.stringify({ lastSeenAt: new Date().toISOString() }));
  r = run(["check"]);
  assert.equal(r.status, 0, r.stdout);
  // A stand-in verdict: no test reaches a real model.
  env.QUESTION_HOLD_FAKE_JUDGE = JSON.stringify({ ask: true, reason: "test" });
  r = run(["release", "--dry-run"], "");
  assert.equal(JSON.parse(r.stdout).released, 1, r.stdout);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(QH.readStore(store).length, 1);
});

test("question-hold gate (the CLI) sends on an unreadable entry", () => {
  const r = spawnSync(process.execPath, [path.join(KERNEL, "bin/question-hold"), "gate"], { input: "{nope", encoding: "utf8", timeout: 20_000 });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).action, "send");
});

// ─── The senders' gates ────────────────────────────────────────────────

const needsRunner = { skip: !underTestRunner() && "run under node --test with its default process isolation (NODE_TEST_CONTEXT is unset)" };

function sendBox(action) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "question-hold-send-"));
  fs.mkdirSync(path.join(h, KERNEL_SUBDIR, "data"), { recursive: true });
  fs.writeFileSync(path.join(h, KERNEL_SUBDIR, ".env"), "SUPABASE_SERVICE_ROLE_KEY=fake\n");
  const fakeBin = path.join(h, "fakebin");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, "curl"), `#!/bin/sh\necho "$@" >> "$CURL_RECORD"\nprintf '%s' 201\n`);
  fs.chmodSync(path.join(fakeBin, "curl"), 0o755);
  const gate = path.join(fakeBin, "question-hold");
  const gateIn = path.join(h, "gate-in.json");
  fs.writeFileSync(gate, `const fs=require("fs");fs.writeFileSync(process.env.GATE_IN, fs.readFileSync(0,"utf8"));console.log(JSON.stringify({action:process.env.GATE_ACTION,id:"h1",reason:"test: not reading"}));`);
  const record = path.join(h, "curl.txt");
  const env = { ...process.env, HOME: h, JORI_HOME: h, PATH: `${fakeBin}:${process.env.PATH}`, CURL_RECORD: record,
    JORI_SEND_TEST_CURL: path.join(fakeBin, "curl"), JORI_QUESTION_HOLD_BIN: gate, GATE_IN: gateIn, GATE_ACTION: action,
    JORI_PRECHECK_BYPASS: "1", SUPABASE_SERVICE_ROLE_KEY: "fake" };
  delete env.JORI_QUESTION_ROUTE_BIN;
  const run = (args, extra = {}) => spawnSync(path.join(KERNEL, "bin/jori-send-curl"), args, { encoding: "utf8", timeout: 20_000, env: { ...env, ...extra } });
  const calls = () => { try { return fs.readFileSync(record, "utf8"); } catch { return ""; } };
  const gateSaw = () => { try { return JSON.parse(fs.readFileSync(gateIn, "utf8")); } catch { return null; } };
  return { h, run, calls, gateSaw, env };
}

test("jori-send-curl holds a question while chat is not reading: nothing posted, the caller told", needsRunner, () => {
  const box = sendBox("hold");
  const capture = path.join(box.h, "capture");
  const r = box.run(["--skip-precheck", "--intent", "decision:ask", "--choices-json", '{"options":[]}', "--metadata-json", '{"decision_ref":"d1"}', "--capture-id", capture, "Which option?"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(box.calls(), "", "no row was written");
  const sentinel = JSON.parse(fs.readFileSync(capture, "utf8"));
  assert.deepEqual([sentinel.suppressed, sentinel.by], [true, "question-hold"]);
  const e = box.gateSaw();
  assert.equal(e.sender, "jori-send-curl");
  assert.equal(e.message, "Which option?");
  assert.deepEqual(e.metadata, { decision_ref: "d1" });
  for (const f of ["--intent", "--choices-json", "--metadata-json", "--skip-precheck"]) assert.ok(e.args.includes(f), f);
  assert.ok(!e.args.includes("--capture-id"), "a per-run temp file is not replayed");
});

test("jori-send-curl sends a question when the gate says chat is reading", needsRunner, () => {
  const box = sendBox("send");
  const r = box.run(["--skip-precheck", "--question", "Which one?"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(box.calls().includes("jori_messages"));
  assert.ok(box.gateSaw().args.includes("--question"));
});

test("jori-send-curl never holds an information ping, a system row, or a release replay", needsRunner, () => {
  const box = sendBox("hold");
  let r = box.run(["--skip-precheck", "--intent", "resilience-test", "Nothing to answer here."]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(box.gateSaw(), null, "an info ping does not reach the gate");
  r = box.run(["--channel", "system", "--intent", "x:ask", "⚠️ a system note"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(box.gateSaw(), null);
  r = box.run(["--skip-precheck", "--question", "Which one?"], { JORI_QUESTION_HOLD_RELEASE: "1" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(box.gateSaw(), null, "the release's own replay passes");
  assert.ok(box.calls().includes("jori_messages"));
});

test("choice send holds a card while chat is not reading, without touching the database", needsRunner, () => {
  const box = sendBox("hold");
  const r = spawnSync("python3", [path.join(KERNEL, "bin/choice"), "send", "--kind", "location_stop", "--ref", "v1", "--prompt", "Where was this?", "--option", "Cafe|16m"], {
    encoding: "utf8", timeout: 20_000, env: { ...box.env, JORI_NODE: process.execPath, SUPABASE_URL: "http://127.0.0.1:9" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).held, true);
  const e = box.gateSaw();
  assert.deepEqual([e.sender, e.card_kind, e.card_ref], ["choice", "location_stop", "v1"]);
  assert.deepEqual(e.args.slice(0, 3), ["send", "--kind", "location_stop"]);
});
