import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
process.env.JORI_TZ = "America/Chicago"; // a synthetic home zone, before the lib loads
const H = require("../lib/daily-summary-harvest.js");
const REVIEW = path.join(path.dirname(fileURLToPath(import.meta.url)), "../bin/daily-summary-review");

const NO_MSG = () => ({ facts: [], counts: {}, errors: {} });

test("dayWindow is home midnight to home midnight, DST-aware", () => {
  const summer = H.dayWindow("2026-07-15");
  assert.equal(summer.start, "2026-07-15T05:00:00.000Z");
  assert.equal(summer.end, "2026-07-16T05:00:00.000Z");
  const winter = H.dayWindow("2026-01-15");
  assert.equal(winter.start, "2026-01-15T06:00:00.000Z");
});

const ms = (iso) => Date.parse(iso);
const stops = [
  { id: "s1", start_ts_ms: ms("2026-07-15T13:00:00Z"), end_ts_ms: ms("2026-07-15T14:00:00Z") },
  { id: "s2", start_ts_ms: ms("2026-07-15T15:00:00Z"), end_ts_ms: ms("2026-07-15T18:00:00Z") },
];

test("anchorFacts: inside a stop, in the gap between stops, or orphan", () => {
  const facts = [
    { kind: "commit", at: "2026-07-15T13:30:00Z", ms: ms("2026-07-15T13:30:00Z"), sha: "a" },
    { kind: "note", at: "2026-07-15T14:30:00Z", ms: ms("2026-07-15T14:30:00Z"), title: "x" },
    { kind: "chat", at: "2026-07-15T05:00:00Z", ms: ms("2026-07-15T05:00:00Z"), text: "early" },
    { kind: "chat", at: null, ms: NaN, text: "undated" },
  ];
  const a = H.anchorFacts(facts, stops);
  assert.deepEqual(a.facts_by_stop.s1.map((f) => f.sha), ["a"]);
  assert.equal(a.facts_by_leg.length, 1);
  assert.deepEqual([a.facts_by_leg[0].from, a.facts_by_leg[0].to], ["s1", "s2"]);
  assert.equal(a.orphan_facts.length, 2);
  assert.equal("ms" in a.facts_by_stop.s1[0], false);
});

test("anchorFacts orders stops itself", () => {
  const a = H.anchorFacts([{ kind: "x", at: "2026-07-15T16:00:00Z", ms: ms("2026-07-15T16:00:00Z") }], [...stops].reverse());
  assert.equal(a.facts_by_stop.s2.length, 1);
});

test("chatFacts trims to the day window and truncates text", () => {
  const w = H.dayWindow("2026-07-15");
  const rows = [
    { id: 1, role: "user", content: "x".repeat(2000), created_at: "2026-07-15T13:10:00Z" },
    { id: 2, role: "user", content: "next day", created_at: "2026-07-16T13:10:00Z" },
  ];
  const f = H.chatFacts(rows, w);
  assert.equal(f.length, 1);
  assert.equal(f[0].text.length, 600);
});

test("chatFacts keeps reply_to only when he used the app's Reply action", () => {
  const w = H.dayWindow("2026-07-15");
  const rows = [
    { id: "q", role: "assistant", content: "What drew you there?", created_at: "2026-07-15T13:00:00Z", reply_to: null },
    { id: "a", role: "user", content: "The building", created_at: "2026-07-15T13:50:00Z", reply_to: "q" },
  ];
  const f = H.chatFacts(rows, w);
  assert.equal(f[1].reply_to, "q");
  assert.ok(!("reply_to" in f[0]));
});

test("harvestDay: stubbed sources, per-source errors, and cache reuse", () => {
  let calls = 0;
  const sources = {
    git: () => { calls++; return { commits: [{ kind: "commit", at: "2026-07-15T13:20:00Z", ms: ms("2026-07-15T13:20:00Z"), sha: "abc", subject: "s" }], added: [] }; },
    sentMail: () => { calls++; throw new Error("keyring locked"); },
    messages: NO_MSG, notes: () => { calls++; return [{ kind: "note", at: "2026-07-15T16:00:00Z", ms: ms("2026-07-15T16:00:00Z"), title: "Plan" }]; },
  };
  const chatRows = [{ id: 9, role: "user", content: "we went to Ping's", created_at: "2026-07-15T13:45:00Z" }];
  const h = H.harvestDay({ date: "2026-07-15", chatRows, stops, sources });
  assert.equal(calls, 3);
  assert.equal(h.errors.sent_mail, "keyring locked");
  assert.equal(h.counts.commits, 1);
  assert.deepEqual(h.facts_by_stop.s1.map((f) => f.kind), ["commit", "chat"]);
  assert.equal(h.facts_by_stop.s2[0].title, "Plan");

  // Re-prep: stops renumbered, sources must not be called again.
  const renumbered = [{ ...stops[0], id: "s7" }, { ...stops[1], id: "s8" }];
  const h2 = H.harvestDay({ date: "2026-07-15", chatRows, stops: renumbered, cached: h._cache, sources });
  assert.equal(calls, 3);
  assert.equal(h2.facts_by_stop.s7.length, 2);
  assert.equal(h2.errors.sent_mail, "keyring locked");
});

test("harvestDay anchors the tasks he closed to the stop they closed at (2026-10-19 Café Example)", () => {
  const sources = { git: () => ({ commits: [], added: [] }), sentMail: () => [], messages: NO_MSG, notes: () => [], corrections: () => [] };
  const tasks = [
    { title: "Pension Fund payout: send bank SWIFT/BIC", completed_at: "10:15", completed_ts: ms("2026-07-15T13:15:00Z"), completed_utc: "2026-07-15T13:15:00.000Z" },
    { title: "Between stops", completed_ts: ms("2026-07-15T14:30:00Z") },
    { title: "No timestamp" },
  ];
  const h = H.harvestDay({ date: "2026-07-15", stops, sources, tasks });
  assert.deepEqual(h.facts_by_stop.s1.map((f) => [f.kind, f.title]), [["task", "Pension Fund payout: send bank SWIFT/BIC"]]);
  assert.equal(h.facts_by_leg[0].facts[0].title, "Between stops");
  assert.equal(h.counts.chat, 0);   // the count columns are unchanged by tasks
  assert.ok(!JSON.stringify(h).includes("No timestamp"));
});

test("harvestDay ignores a cache for another date", () => {
  let calls = 0;
  const sources = { git: () => { calls++; return { commits: [], added: [] }; }, sentMail: () => [], messages: NO_MSG, notes: () => [] };
  H.harvestDay({ date: "2026-07-15", stops, cached: { date: "2026-07-14", raw: {}, errors: {} }, sources });
  assert.equal(calls, 1);
});

test("review (structural): photo counts and standout amounts", () => {
  const date = "2099-01-02";
  const files = {
    html: `/tmp/daily-summary-${date}.html`,
    man: `/tmp/ds-manifest-${date}.json`,
  };
  fs.writeFileSync(files.html, `<h1>Day</h1><h3>1:00pm–2:00pm · Ping's</h3><p>Lunch at Ping's, 5 photos of dumplings, $44 at the bar.</p>`);
  fs.writeFileSync(files.man, JSON.stringify({ standout_transactions: [{ merchant: "Semma", amount_usd: "$120" }] }));
  try {
    const r = spawnSync(process.execPath, [REVIEW, date, "--no-model"], { encoding: "utf8" });
    const out = JSON.parse(r.stdout);
    const kinds = out.findings.map((f) => `${f.kind}:${f.severity}`);
    assert.ok(kinds.includes("quality:high"), "photo count flagged");
    assert.ok(out.findings.some((f) => f.kind === "missing" && f.detail.includes("$120")), "missing standout flagged");
    assert.ok(out.findings.some((f) => f.kind === "invented" && f.detail.includes("$44")), "stray amount flagged");
    assert.equal(r.status, 3);
  } finally {
    for (const f of [...Object.values(files), `/tmp/ds-review-${date}.json`]) { try { fs.unlinkSync(f); } catch {} }
  }
});

// 2026-10-11: the user emailed "The 7am also had a coffee stop and a bagel run at
// Falafel Example" about the 2026-10-10 summary. An emailed reply never reaches the chat
// transcript the summary reads, so the sentence had nowhere to land. Corrections
// recorded with bin/day-correction are read here and anchored by time.
test("correctionFacts: one fact per stop the window touches, each anchored inside it", () => {
  const morning = [
    { id: "a", start_ts_ms: ms("2026-10-10T04:00:00Z"), end_ts_ms: ms("2026-10-10T04:49:00Z") },
    { id: "cafe", start_ts_ms: ms("2026-10-10T04:55:00Z"), end_ts_ms: ms("2026-10-10T05:52:00Z") },
    { id: "b", start_ts_ms: ms("2026-10-10T05:52:00Z"), end_ts_ms: ms("2026-10-10T06:15:00Z") },
    { id: "later", start_ts_ms: ms("2026-10-10T07:00:00Z"), end_ts_ms: ms("2026-10-10T10:00:00Z") },
  ];
  const c = { said_at: "2026-10-11T06:54:35Z", channel: "email", text: "coffee stop and a bagel run",
    applies_from: "2026-10-10T07:00:00+03:00", applies_to: "2026-10-10T09:18:00+03:00" };
  const facts = H.correctionFacts([c], morning);
  assert.deepEqual(facts.map((f) => f.stop_id), ["a", "cafe", "b"], "the afternoon stop is not touched");
  const a = H.anchorFacts(facts, morning);
  assert.equal(a.facts_by_stop.cafe[0].kind, "correction");
  assert.equal(a.facts_by_stop.cafe[0].text, "coffee stop and a bagel run");
  assert.equal(a.facts_by_stop.later, undefined);
  assert.equal(a.orphan_facts.length, 0);
});

test("correctionFacts: no window, or a window over no stop, lands as an orphan rather than vanishing", () => {
  const facts = H.correctionFacts([
    { said_at: "2026-10-11T06:54:35Z", channel: "email", text: "no window" },
    { said_at: "2026-10-11T06:54:35Z", channel: "email", text: "nothing there",
      applies_from: "2026-10-10T01:00:00Z", applies_to: "2026-10-10T02:00:00Z" },
  ], stops);
  assert.equal(facts.length, 2);
  const a = H.anchorFacts(facts, stops);
  assert.equal(a.orphan_facts.length, 2);
  assert.deepEqual(a.orphan_facts.map((f) => f.text), ["no window", "nothing there"]);
});

test("readCorrections skips a torn line and a missing file is empty", () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "day-corr-"));
  fs.writeFileSync(path.join(dir, "2026-10-10.jsonl"),
    `${JSON.stringify({ text: "kept", said_at: "2026-10-11T06:00:00Z" })}\n{"text": "torn\n${JSON.stringify({ nope: 1 })}\n`);
  assert.deepEqual(H.readCorrections("2026-10-10", dir).map((c) => c.text), ["kept"]);
  assert.deepEqual(H.readCorrections("2026-10-09", dir), []);
});

test("harvestDay carries corrections into counts and the anchored facts, uncached", () => {
  const morning = [{ id: "cafe", start_ts_ms: ms("2026-10-10T04:55:00Z"), end_ts_ms: ms("2026-10-10T05:52:00Z") }];
  const stub = { git: () => ({ commits: [], added: [] }), sentMail: () => [], messages: NO_MSG, notes: () => [],
    corrections: () => [{ said_at: "2026-10-11T06:54:35Z", channel: "email", text: "bagel run at Falafel Example",
      applies_from: "2026-10-10T07:00:00+03:00", applies_to: "2026-10-10T09:18:00+03:00" }] };
  const h = H.harvestDay({ date: "2026-10-10", stops: morning, sources: stub });
  assert.equal(h.counts.corrections, 1);
  assert.equal(h.facts_by_stop.cafe[0].text, "bagel run at Falafel Example");
  assert.equal("corrections" in h._cache.raw, false, "re-read on every prep, since one can land between them");
});

// 2026-10-11: the review called Airbnb / café / Airbnb "one visit split by a GPS
// drift" and asked to merge them, which would have deleted the coffee stop it was
// reviewing. A split visit has nothing between its halves.
test("review: the same place either side of another stop is a return, not a split visit", () => {
  const date = "2099-03-14";
  const html = `/tmp/daily-summary-${date}.html`;
  const mk = (...hs) => hs.map((h) => `${h}<p>x</p>`).join("");
  const run = (body) => {
    fs.writeFileSync(html, `<h1>Day</h1>${body}`);
    const r = spawnSync(process.execPath, [REVIEW, date, "--no-model"], { encoding: "utf8" });
    return JSON.parse(r.stdout).findings.filter((f) => f.kind === "duplicate");
  };
  try {
    const between = run(mk("<h3>7:07am IDT · the airbnb</h3>", "<h3>7:55am IDT · Dama</h3>", "<h3>8:52am IDT · the airbnb</h3>"));
    assert.equal(between.length, 1);
    assert.equal(between[0].severity, "low", "a return is a note, never a merge instruction");
    const adjacent = run(mk("<h3>7:07am IDT · the airbnb</h3>", "<h3>8:00am IDT · the airbnb</h3>"));
    assert.equal(adjacent[0].severity, "high", "two adjacent halves are still one split visit");
  } finally {
    for (const f of [html, `/tmp/ds-review-${date}.json`]) { try { fs.unlinkSync(f); } catch {} }
  }
});

test("a correction's reading travels with it, apart from his words", () => {
  const morning = [{ id: "cafe", start_ts_ms: ms("2026-10-10T04:55:00Z"), end_ts_ms: ms("2026-10-10T05:52:00Z") }];
  const [f] = H.correctionFacts([{ said_at: "2026-10-11T06:54:35Z", text: "coffee stop and a bagel run at Falafel Example",
    reading: "two activities; the bakery is 140 m from the café",
    applies_from: "2026-10-10T07:00:00+03:00", applies_to: "2026-10-10T09:18:00+03:00" }], morning);
  assert.equal(f.text, "coffee stop and a bagel run at Falafel Example");
  assert.equal(f.reading, "two activities; the bakery is 140 m from the café");
  const [g] = H.correctionFacts([{ said_at: "2026-10-11T06:54:35Z", text: "x" }], morning);
  assert.equal("reading" in g, false);
});

test("countColumns: the weekly packet's commit / message / mail counts come off the harvest", () => {
  const h = { date: "2026-10-18", counts: { chat: 82, commits: 10, new_files: 11, sent_mail: 4, notes: 0, corrections: 2 }, errors: {} };
  assert.deepEqual(H.countColumns(h, "2026-10-18"), { commits_count: 10, emails_sent_count: 4, messages_count: 82 });
  // a genuinely quiet day is a real zero, not a missing value
  assert.deepEqual(H.countColumns({ ...h, counts: { ...h.counts, commits: 0 } }, "2026-10-18").commits_count, 0);
});

test("countColumns: a failed source is left out, never written as zero", () => {
  const h = { date: "2026-10-18", counts: { chat: 3, commits: 0, sent_mail: 0 }, errors: { git: "spawn failed", sent_mail: "gog down" } };
  assert.deepEqual(H.countColumns(h, "2026-10-18"), { messages_count: 3 });
});

test("countColumns: a harvest cut for another date, or none, yields nothing", () => {
  const h = { date: "2026-10-17", counts: { chat: 3, commits: 9, sent_mail: 1 }, errors: {} };
  assert.deepEqual(H.countColumns(h, "2026-10-18"), {});
  assert.deepEqual(H.countColumns(null, "2026-10-18"), {});
});

test("harvestDay carries the previous days' autonomous tags, topped up once on an older cache; a failed read is null", () => {
  let reads = 0;
  const prior = [{ date: "2026-10-20", tags: ["[auto-impl]"] }];
  const sources = { git: () => ({ commits: [], added: [] }), sentMail: () => [], messages: NO_MSG, notes: () => [], corrections: () => [],
    priorTags: () => { reads++; return prior; } };
  const h = H.harvestDay({ date: "2026-10-21", stops: [], sources });
  assert.deepEqual(h.prior_commit_tags, prior);
  // Reused with the cache: not read again.
  const h2 = H.harvestDay({ date: "2026-10-21", stops: [], cached: h._cache, sources });
  assert.deepEqual(h2.prior_commit_tags, prior);
  assert.equal(reads, 1);
  // A cache cut before this existed gets it once.
  const old = { date: "2026-10-21", tz: h._cache.tz, raw: { commits: [], new_files: [], sent_mail: [], notes: [] }, errors: {} };
  assert.deepEqual(H.harvestDay({ date: "2026-10-21", stops: [], cached: old, sources }).prior_commit_tags, prior);
  assert.equal(reads, 2);
  // Failure hides nothing: null, with the error recorded.
  const bad = H.harvestDay({ date: "2026-10-21", stops: [], sources: { ...sources, priorTags: () => { throw new Error("git gone"); } } });
  assert.equal(bad.prior_commit_tags, null);
  assert.ok(bad.errors.prior_tags.includes("git gone"));
});

test("harvestDay anchors the day's iMessage/WhatsApp/Slack messages to stops and counts them", () => {
  const cafe = [{ id: "cafe", start_ts_ms: ms("2026-10-26T12:00:00Z"), end_ts_ms: ms("2026-10-26T13:00:00Z") }];
  const msg = { kind: "message", at: "2026-10-26T12:30:00Z", ms: ms("2026-10-26T12:30:00Z"), channel: "imessage",
    chat: "Family", is_group: true, from_me: false, who: "Alice", text: "see you at the cafe" };
  const sources = { git: () => ({ commits: [], added: [] }), sentMail: () => [], notes: () => [], corrections: () => [],
    priorTags: () => [], messages: () => ({ facts: [msg], counts: { imessage: 1, kept: 1, dropped: 0 }, errors: { slack: "no log" } }) };
  const h = H.harvestDay({ date: "2026-10-26", stops: cafe, sources });
  assert.equal(h.counts.messages, 1);
  assert.deepEqual(h.facts_by_stop.cafe.map((f) => f.text), ["see you at the cafe"]);
  assert.equal(h.errors.messages_slack, "no log");
});
