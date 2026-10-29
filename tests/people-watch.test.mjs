// people-watch.test.mjs — the contact rhythm, which questions are due, the
// card file round trip through the decision queue (exact option picks applied,
// own words held for a model), research snapshots and their diffs, and the
// wiki ## Background block.
// Run: node --test tests/people-watch.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "people-watch-"));
process.env.JORI_DATA_DIR = dir;
process.env.PEOPLE_WATCH_DB = path.join(dir, "pw.db");
process.env.PEOPLE_WATCH_ASKS = path.join(dir, "people-watch-asks.json");

const pw = createRequire(import.meta.url)(path.resolve("lib/people-watch.js"));
const dq = await import("../lib/decision-queue.mjs");

after(() => {
  pw.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

const DAY = 864e5;
const NOW = Date.UTC(2026, 9, 27);
const today = Math.floor(NOW / DAY);
// Monthly contact for two years, ending `quietDays` ago.
const monthly = (quietDays, n = 24) => new Set(Array.from({ length: n }, (_, i) => today - quietDays - i * 30));

test("rhythm: a monthly correspondent quiet for five months is slipping; one quiet for a month is not", () => {
  const slip = pw.rhythm(monthly(150), NOW);
  assert.equal(slip.typical_gap_days, 30);
  assert.equal(slip.expected_silence_days, 90);
  assert.equal(slip.slipping, true);
  assert.equal(slip.suggested_cadence_days, 60);
  assert.equal(pw.rhythm(monthly(35), NOW).slipping, false);
});

test("rhythm: too little history, or gone quiet years ago, is not slipping", () => {
  assert.equal(pw.rhythm(monthly(150, 3), NOW).slipping, false);
  assert.equal(pw.rhythm(monthly(2000), NOW).slipping, false);
  assert.equal(pw.rhythm([], NOW).slipping, false);
});

function person(wiki_id, extra = {}) {
  return { wiki_id, name: wiki_id.replace("user_", ""), description: null, scope: ["people"], locked: false, works_with: false, state: { status: "unasked", nudges: 0, research: 0 }, ...pw.rhythm(monthly(35), NOW), ...extra };
}

test("propose: slipping people before work people, one per person, at most MAX_OPEN open", () => {
  const scanned = [
    person("user_a", { ...pw.rhythm(monthly(150), NOW) }),
    person("user_b", { ...pw.rhythm(monthly(200), NOW), contact_days: 50 }),
    person("user_w1", { works_with: true, recent_contact_days: 5 }),
    person("user_w2", { works_with: true, recent_contact_days: 9 }),
    person("user_quiet"),
  ];
  const plan = pw.propose({ now: NOW, scanned });
  assert.deepEqual(plan.map((p) => [p.kind, p.wiki_id]), [["stay_in_touch", "user_b"], ["stay_in_touch", "user_a"], ["follow_news", "user_w2"]]);
  assert.equal(pw.propose({ now: NOW, scanned }).length, 0, "full: nothing more until one is answered");
  const file = JSON.parse(fs.readFileSync(process.env.PEOPLE_WATCH_ASKS, "utf8"));
  assert.equal(file.questions.length, 3);
  assert.match(file.questions[0].question, /Do you want to stay in touch\?/);
});

test("decision queue: people questions load as ppl: refs with their own daily slot", () => {
  const items = dq.loadOpen();
  const people = items.filter((i) => i.source === "people");
  assert.equal(people.length, 3);
  assert.ok(people.every((i) => i.ref.startsWith("ppl:")));
  // A review decision asked today does not close the people slot.
  const lane = { asked: [{ ref: "imp:abc", at: new Date(NOW).toISOString() }], cards: {} };
  const r = dq.nextDecision({ items, lane, now: NOW });
  assert.equal(r.decision.source, "people");
  // A people question asked today closes it.
  const lane2 = { asked: [{ ref: people[0].ref, at: new Date(NOW).toISOString() }], cards: {} };
  assert.equal(dq.nextDecision({ items, lane: lane2, now: NOW }).decision, null);
});

test("an exact option pick takes effect; own words wait for a model", () => {
  const items = dq.loadOpen().filter((i) => i.source === "people");
  const b = items.find((i) => i.q.wiki_id === "user_b");
  const a = items.find((i) => i.q.wiki_id === "user_a");
  assert.equal(dq.recordAnswer({ ref: b.ref, answer: b.q.options[1], kind: "option" }).ok, true);
  assert.equal(dq.recordAnswer({ ref: a.ref, answer: "only if she reaches out first", kind: "text" }).ok, true);
  const r = pw.importAnswers({ now: NOW });
  assert.equal(r.applied.length, 1);
  const pb = pw.getPerson("user_b");
  assert.equal(pb.status, "tracking");
  assert.equal(pb.nudges, 1);
  assert.equal(pb.research, 1);
  assert.equal(pb.cadence_days, 60);
  assert.deepEqual(pw.wordsPending().map((w) => w.wiki_id), ["user_a"]);
  pw.decide("user_a", { status: "declined", askId: pw.wordsPending()[0].id, note: "only if she reaches out first", now: NOW });
  assert.equal(pw.getPerson("user_a").status, "declined");
  assert.equal(pw.wordsPending().length, 0);
});

test("decide refuses without the user's words", () => {
  assert.throws(() => pw.decide("user_x", { status: "tracking" }), /note/);
});

test("a tracked person past their cadence gets a reach-out question", () => {
  const later = NOW + 5 * DAY;
  const scanned = [person("user_b", { ...pw.rhythm(monthly(150), later), state: pw.getPerson("user_b") })];
  // user_b's slot is free (their stay_in_touch ask was applied).
  const plan = pw.propose({ now: later, scanned });
  assert.deepEqual(plan.map((p) => p.kind), ["reach_out"]);
});

test("diffSnapshots: job change, move and new life events; spelling is not a change", () => {
  const prev = { role: "VP Engineering", company: "Acme, Inc.", location: "Springfield", life_events: [{ kind: "award", date: "2025-01-01", summary: "won X" }] };
  assert.equal(pw.diffSnapshots(prev, { ...prev, company: "acme inc" }).length, 0);
  const next = { role: "CTO", company: "Beta Labs", location: "Riverton", life_events: [...prev.life_events, { kind: "wedding", date: "2026-09-01", summary: "got married in September" }] };
  const d = pw.diffSnapshots(prev, next);
  assert.deepEqual(d.map((c) => c.kind), ["job_change", "moved", "wedding"]);
  assert.match(d[0].summary, /now CTO at Beta Labs \(was VP Engineering at Acme, Inc\.\)/);
});

test("first snapshot: only recent life events are news", () => {
  const facts = { life_events: [{ kind: "baby", date: "2026-10-01", summary: "had a daughter" }, { kind: "award", date: "2019-01-01", summary: "old award" }] };
  assert.deepEqual(pw.diffSnapshots(null, facts, { now: NOW }).map((c) => c.kind), ["baby"]);
});

test("observe: identity must be established; changes are stored once and become questions", () => {
  assert.equal(pw.observe("user_b", { identity_confidence: "low", role: "x" }, { now: NOW }).stored, false);
  pw.observe("user_b", { identity_confidence: "high", role: "VP", company: "Acme", life_events: [] }, { now: NOW });
  const r = pw.observe("user_b", { identity_confidence: "high", role: "CTO", company: "Beta", links: { linkedin: "https://www.linkedin.com/in/b" }, life_events: [] }, { now: NOW + DAY });
  assert.equal(r.changes.length, 1);
  assert.equal(pw.observe("user_b", { identity_confidence: "high", role: "CTO", company: "Beta", life_events: [] }, { now: NOW + 2 * DAY }).changes.length, 0);
  // Free the slot: answer the open reach-out.
  const open = pw.openAsks().find((a) => a.wiki_id === "user_b");
  pw.decide("user_b", { askId: open.id, note: "later", now: NOW + 2 * DAY });
  const plan = pw.propose({ now: NOW + 2 * DAY, scanned: [person("user_b", { state: pw.getPerson("user_b") })] });
  assert.deepEqual(plan.map((p) => p.kind), ["change"]);
  const q = pw.openAsks().find((a) => a.kind === "change");
  assert.match(q.question, /now CTO at Beta \(was VP at Acme\)/);
});

test("a 'draft a note' pick is queued for the draft step", () => {
  const ask = pw.openAsks().find((a) => a.kind === "change");
  const opts = JSON.parse(ask.options_json);
  const ref = `ppl:${ask.id}`;
  dq.recordAnswer({ ref, answer: opts[0].text, kind: "option" });
  pw.importAnswers({ now: NOW + 3 * DAY });
  assert.deepEqual(pw.draftsPending().map((d) => d.wiki_id), ["user_b"]);
  pw.markDrafted(ask.id);
  assert.equal(pw.draftsPending().length, 0);
});

test("the Background block links Contacts and profiles, never copies contact details", () => {
  assert.equal(pw.contactUrl("people/c123"), "https://contacts.google.com/person/c123");
  assert.equal(pw.contactUrl("nope"), null);
  const facts = pw.factsLine({ contactResource: "people/c123", facts: { role: "CTO", company: "Beta", location: "Riverton", links: { linkedin: "https://l/in/b", x: "https://x.com/b" } }, observedAt: NOW });
  assert.equal(facts, "_Now: CTO at Beta, Riverton. [Google Contacts](https://contacts.google.com/person/c123) · [LinkedIn](https://l/in/b) · [X](https://x.com/b) Researched 2026-10-27._");
  const md = "---\nname: B\n---\n# B\n\nText.\n";
  const once = pw.renderSection(md, { facts, summary: "Summary one." });
  assert.match(once, /## Background\n<!-- people-watch:start -->/);
  const twice = pw.renderSection(once, { facts, summary: "Summary two." });
  assert.equal(twice.match(/## Background/g).length, 1);
  assert.match(twice, /Summary two\./);
  assert.doesNotMatch(twice, /Summary one\./);
});

test("decision cards: more than one a day per group when the backlog is long", () => {
  const items = [
    { ref: "ppl:a", source: "people", q: { question: "A?", options: ["x", "y"], asked_at: "2026-10-27T00:00:00Z" } },
    { ref: "ppl:b", source: "people", q: { question: "B?", options: ["x", "y"], asked_at: "2026-10-27T00:00:00Z" } },
  ];
  const lane = { asked: [{ ref: "ppl:a", at: new Date(NOW - 3600e3).toISOString() }], cards: {} };
  assert.equal(dq.nextDecision({ items, lane, now: NOW, tz: "America/Chicago" }).decision, null);
  assert.equal(dq.nextDecision({ items, lane, now: NOW, tz: "America/Chicago", perDay: 2 }).decision.ref, "ppl:b");
});
