// watches.test.mjs — the trigger → action engine (lib/watches.mjs).
//
// The fixtures mirror the first three kinds of watch: "remind me to
// check my passport two days before I leave for
// Lisbon" over a synthetic timeline (BOS→LIS Nov 15), "remind me when the
// bank letter for the insurer arrives in the mailbox" over a USPS
// Informed Delivery scan, and a match the model can't settle, which becomes a
// hum question. Models and senders are injected; nothing leaves the process.
// Run: node --test tests/watches.test.mjs

import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watches-test-"));
process.env.WATCH_DB = path.join(dir, "memory-index.db");
process.env.WATCH_DATA_DIR = dir;
process.env.WATCH_LOG = path.join(dir, "watch.log");
process.env.WATCH_RESPONSES = path.join(dir, "hum-responses.jsonl");
process.env.WATCH_TZ = "America/New_York";
const W = await import("../lib/watches.mjs");

// bin/travel list --json, 2026-10-23 (trimmed).
const SEGMENTS = [
  { id: "9f0798d5", metro: "paris", place_label: "12 Rue de Rivoli, Paris", arrive_at: "2026-10-01T13:25:00+00:00", depart_at: "2026-10-31T17:05:00+00:00", source: "manual" },
  { id: "eec7391a", metro: "transit", place_label: "CDG→BOS (Air France)", arrive_at: "2026-10-31T22:05:00+00:00", depart_at: "2026-11-01T09:55:00+00:00", source: "flights" },
  { id: "4ce66425", metro: "boston", place_label: "Boston", arrive_at: "2026-11-01T09:55:00+00:00", depart_at: "2026-11-15T20:59:00+00:00", source: "flights" },
  { id: "59830779", metro: "transit", place_label: "BOS→LIS (TAP)", arrive_at: "2026-11-15T20:59:00+00:00", depart_at: "2026-11-16T00:11:00+00:00", source: "flights" },
  { id: "7e4dd0f1", metro: "lisbon", place_label: "Lisbon", arrive_at: "2026-11-16T00:11:00+00:00", depart_at: null, source: "flights" },
  { id: "48f586f2", metro: "lisbon|boston", place_label: "Boston/Lisbon (Schrodinger)", arrive_at: "2026-12-01T17:00:00+00:00", depart_at: "2027-02-01T17:00:00+00:00", source: "manual" },
];

function fakeDeps(over = {}) {
  const calls = { sent: [], tasks: [], judged: [], asked: [], logged: [] };
  const deps = {
    ...W.defaultDeps,
    fetchSegments: () => SEGMENTS,
    emailEvents: () => [],
    sendChat: (text, id) => { calls.sent.push({ text, id }); },
    addTask: (t) => { calls.tasks.push(t); },
    dispatchAgent: async () => "dispatched",
    appendPageLog: (rule, line) => calls.logged.push(line),
    judgeMatch: async (rule, item) => { calls.judged.push(item.subject_key); return { verdict: "no_match", used: "jev" }; },
    judgeAnswer: async () => "unclear",
    askQuestion: (q) => { calls.asked.push(q); return { code: 0 }; },
    pendingQuestionOpen: () => false,
    readResponses: () => [],
    ...over,
  };
  return { deps, calls };
}

function reset() {
  W.db().exec("DELETE FROM watch_rules; DELETE FROM watch_matches;");
  for (const f of ["watch-state.json", "watch-spool.jsonl"]) fs.rmSync(path.join(dir, f), { force: true });
}

const LISBON = {
  id: "passport-check-before-lisbon",
  title: "Check the passport before the Lisbon trip",
  page_id: "watch_passport_check_before_lisbon",
  trigger: { kind: "anchor", condition: "the user leaves for Lisbon", anchor: { source: "travel", field: "leave", offset_min: -2880, local_time: "09:00" } },
  action: { notify: "Two days until Lisbon: time to check the passport.", task: { title: "Check the passport's expiry" } },
  recurrence: "once",
};

const BOFA = {
  id: "bank-letter-to-insurer",
  title: "Send the Acme Bank letter to the insurer",
  trigger: { kind: "event", listens: ["email.received", "mail.piece"], condition: "The Acme Bank account confirmation letter arrives" },
  action: { notify: "The Acme Bank letter is here: send it to the insurer." },
  recurrence: "each",
};

test("event-type globs are structural prefix matches", () => {
  assert.ok(W.typeMatches(["email.*"], "email.received"));
  assert.ok(W.typeMatches(["mail.piece"], "mail.piece"));
  assert.ok(!W.typeMatches(["email.*"], "mail.piece"));
  assert.ok(W.typeMatches(["*"], "travel.metro_change"));
});

test("a bad spec is refused before anything is written", () => {
  assert.throws(() => W.normalizeSpec({ id: "X", title: "t", trigger: { kind: "event" }, action: {} }), /invalid watch spec/);
  assert.throws(() => W.normalizeSpec({ ...BOFA, trigger: { ...BOFA.trigger, listens: [] } }), /listens/);
});

test("trips: the Lisbon leg leaves at the BOS→LIS takeoff; the undecided Dec stay is not a trip", () => {
  const trips = W.buildTrips(SEGMENTS);
  const lisbon = trips.find((t) => t.metro === "lisbon");
  assert.equal(new Date(lisbon.leave_ms).toISOString(), "2026-11-15T20:59:00.000Z");
  assert.equal(lisbon.via, "BOS→LIS (TAP)");
  assert.equal(lisbon.from_metro, "boston");
  assert.ok(!trips.some((t) => t.metro.includes("|")));
});

test("two days before leaving, at 09:00 local: Fri Nov 13 09:00 EST", () => {
  const rule = W.getRule(W.upsertRule(LISBON).id);
  const lisbon = W.buildTrips(SEGMENTS).find((t) => t.metro === "lisbon");
  assert.equal(new Date(W.anchorFireMs(rule, lisbon, "America/New_York")).toISOString(), "2026-11-13T14:00:00.000Z");
  reset();
});

test("anchor watch: decided once, waits for its day, fires once, then is done", async () => {
  reset();
  W.upsertRule(LISBON);
  const { deps, calls } = fakeDeps({
    judgeMatch: async (rule, item) => { calls.judged.push(item.subject_key); return { verdict: item.data.metro === "lisbon" ? "match" : "no_match", used: "jev" }; },
  });
  await W.tick({ nowMs: Date.parse("2026-10-23T15:00:00Z"), deps });
  assert.equal(calls.sent.length, 0);
  const judgedFirst = calls.judged.length;
  assert.equal(judgedFirst, 3, "Paris (still on), boston and lisbon judged; the Schrodinger stay is not a trip");

  await W.tick({ nowMs: Date.parse("2026-11-13T13:59:00Z"), deps });
  assert.equal(calls.sent.length, 0, "08:59 — not yet");
  assert.equal(calls.judged.length, judgedFirst, "verdicts are stored, never re-asked");

  await W.tick({ nowMs: Date.parse("2026-11-13T14:01:00Z"), deps });
  assert.equal(calls.sent.length, 1);
  assert.match(calls.sent[0].text, /check the passport/);
  assert.equal(calls.tasks[0].title, "Check the passport's expiry");
  assert.equal(W.getRule(LISBON.id).status, "done");
  assert.equal(calls.logged.length, 1, "the firing is written back to the watch's memory page");

  await W.tick({ nowMs: Date.parse("2026-11-13T15:00:00Z"), deps });
  assert.equal(calls.sent.length, 1, "never twice");
});

test("event watch: a 3am match is held until 08:00, then fires", async () => {
  reset();
  W.upsertRule(BOFA);
  const { deps, calls } = fakeDeps({
    judgeMatch: async (rule, item) => { calls.judged.push(item.subject_key); return { verdict: item.type === "mail.piece" ? "match" : "no_match", used: "jev" }; },
  });
  W.spoolEvents([{ type: "mail.piece", subject_key: "mail:abc:mailer-1.jpg", summary: "Physical mail piece arriving today (USPS scan of the envelope reads: ACME BANK / PO BOX 15284)", data: {} }]);
  await W.tick({ nowMs: Date.parse("2026-10-27T07:00:00Z"), deps }); // 03:00 EDT
  assert.equal(calls.sent.length, 0);
  await W.tick({ nowMs: Date.parse("2026-10-27T12:30:00Z"), deps }); // 08:30 EDT
  assert.equal(calls.sent.length, 1);
  assert.match(calls.sent[0].text, /ACME BANK/);
  assert.equal(calls.judged.length, 1);
  assert.equal(W.getRule(BOFA.id).status, "active", "recurrence each: stays armed for the next piece");
});

test("unclear → one hum question; his yes fires it, through the answer judge", async () => {
  reset();
  W.upsertRule(BOFA);
  let responses = [];
  const { deps, calls } = fakeDeps({
    judgeMatch: async () => ({ verdict: "unclear", used: "legacy" }),
    readResponses: () => responses,
    judgeAnswer: async (q, reply) => (reply === "yes that's the one" ? "yes" : "unclear"),
  });
  W.spoolEvents([{ type: "email.received", subject_key: "email:x:1", summary: "Email from Acme Bank: Your document is ready", data: {} }]);
  await W.tick({ nowMs: Date.parse("2026-10-27T14:00:00Z"), deps });
  assert.equal(calls.asked.length, 1);
  assert.equal(calls.sent.length, 0);
  const qid = calls.asked[0].id;
  await W.tick({ nowMs: Date.parse("2026-10-27T14:05:00Z"), deps });
  assert.equal(calls.asked.length, 1, "asked once");
  responses = [{ ts: "2026-10-27T14:10:00Z", ping_id: qid, reply_text: "yes that's the one" }];
  await W.tick({ nowMs: Date.parse("2026-10-27T14:11:00Z"), deps });
  assert.equal(calls.sent.length, 1);
});

test("a failed delivery is retried next tick, not lost", async () => {
  reset();
  W.upsertRule({ ...BOFA, recurrence: "once" });
  let fail = true;
  const { deps, calls } = fakeDeps({
    judgeMatch: async () => ({ verdict: "match", used: "jev" }),
    sendChat: (text) => { if (fail) throw new Error("send failed"); calls.sent.push(text); },
  });
  W.spoolEvents([{ type: "mail.piece", subject_key: "mail:y:1", summary: "ACME BANK envelope", data: {} }]);
  const s = await W.tick({ nowMs: Date.parse("2026-10-27T14:00:00Z"), deps });
  assert.equal(s.errors.length, 1);
  fail = false;
  await W.tick({ nowMs: Date.parse("2026-10-27T14:02:00Z"), deps });
  assert.equal(calls.sent.length, 1);
});

test("mail pieces: each USPS mailer scan becomes one event carrying its OCR text", () => {
  const evs = W.mailPieceEvents("m1", {
    gogJson: () => ({ attachments: [{ filename: "mailer-1.jpg", attachmentId: "a1" }, { filename: "content-1.jpg", attachmentId: "a2" }] }),
    download: (m, id, f) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, "x"); return { status: 0 }; },
    ocrImage: () => "ACME BANK / ALEX EXAMPLE",
  });
  assert.equal(evs.length, 1, "the ride-along ad (content-*) is not mail");
  assert.equal(evs[0].type, "mail.piece");
  assert.match(evs[0].summary, /ACME BANK/);
});

test("Anytime Mailbox: armed on first read, then each new envelope is one mail.piece", () => {
  const file = path.join(dir, "anytime-mail-state.json");
  const state = {};
  fs.writeFileSync(file, JSON.stringify({ seen: {
    old1: { sender: "Spectrum", ocr: ["SPECTRUM"], arrived: new Date(Date.now() - 10 * 86400e3).toISOString() },
    recent: { sender: "IRS", ocr: ["IRS"], arrived: new Date(Date.now() - 86400e3).toISOString() } } }));
  assert.deepEqual(W.anytimeMailEvents(state, Date.now(), { anytimeStateFile: file }).map((e) => e.subject_key), ["anytime:recent"],
    "cold start replays only the last 3 days");
  fs.writeFileSync(file, JSON.stringify({ seen: { old1: { sender: "Spectrum" }, recent: { sender: "IRS" }, m42: { sender: "Acme Bank", recipient: "the household", verdict: "important", ocr: ["ACME BANK", "ALEX EXAMPLE"] } } }));
  const evs = W.anytimeMailEvents(state, Date.now(), { anytimeStateFile: file });
  assert.equal(evs.length, 1);
  assert.equal(evs[0].subject_key, "anytime:m42");
  assert.match(evs[0].summary, /Acme Bank/);
  assert.equal(W.anytimeMailEvents(state, Date.now(), { anytimeStateFile: file }).length, 0, "never twice");
});

test("tracking: every step lands in watch_events and the scorecard reads it back", async () => {
  reset();
  W.db().exec("DELETE FROM watch_events;");
  W.upsertRule({ ...BOFA, action: { ...BOFA.action, task: { title: "Send the Acme Bank letter" } }, origin: "chat", request: "remind me to send the bank details letter to the insurer" });
  const { deps } = fakeDeps({
    judgeMatch: async (rule, item) => ({ verdict: item.subject_key === "mail:z:1" ? "match" : "no_match", used: item.subject_key === "mail:z:1" ? "jev" : "legacy" }),
    sendChat: () => ({ delivery: "suppressed", reason: "duplicate of an earlier message" }),
    addTask: () => ({ task_id: "t1" }),
  });
  W.spoolEvents([
    { type: "mail.piece", subject_key: "mail:z:1", summary: "ACME BANK envelope", data: {} },
    { type: "email.received", subject_key: "email:q:1", summary: "Email from a shop: offer", data: {} },
  ]);
  const nowMs = Date.parse("2026-10-27T14:00:00Z");
  await W.tick({ nowMs, deps });
  W.recordFeedback(BOFA.id, "that was a statement, not the letter", { subjectKey: "mail:z:1", nowMs });
  W.recordMiss("never reminded me about the dentist", { nowMs });
  const s = await W.stats({ days: 7, nowMs: nowMs + 60e3, outcomes: async () => ({ reactions: {}, tasks: { t1: "completed" } }) });
  assert.equal(s.watches.created_by.chat, 1);
  assert.deepEqual(s.decisions.by_verdict, { match: 1, no_match: 1 });
  assert.deepEqual(s.decisions.by_decider, { jev: 1, legacy: 1 });
  assert.equal(s.firings.total, 1);
  assert.equal(s.firings.delivery.suppressed, 1, "a reminder the precheck held back is counted, not hidden");
  assert.match(s.firings.suppressed[0].reason, /duplicate/);
  assert.deepEqual(s.firings.tasks, { completed: 1 });
  assert.equal(s.feedback.length, 1);
  assert.equal(s.misses.length, 1);
  assert.equal(s.firings.median_late_min, 0);
});

test("quiet hours: next awake moment is 08:00 local", () => {
  assert.equal(new Date(W.nextAwake(Date.parse("2026-10-27T07:00:00Z"), "America/New_York")).toISOString(), "2026-10-27T12:00:00.000Z");
  assert.equal(new Date(W.nextAwake(Date.parse("2026-10-28T03:30:00Z"), "America/New_York")).toISOString(), "2026-10-28T12:00:00.000Z");
});
