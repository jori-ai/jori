// call-actions.test.mjs — the action items of the user's calls, both sides, and
// their follow-up (lib/call-actions.mjs), plus the log fields that feed them
// (lib/call-log.mjs). Synthetic people; no network, no model.
//
// Run: node --test tests/call-actions.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.JORI_OWNER_NAME = "Ann";
process.env.JORI_OWNER_ID = "ann";
process.env.JORI_OWNER_EMAIL = "ann@example.org";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CL = await import(path.join(ROOT, "lib/call-log.mjs"));
const CA = await import(path.join(ROOT, "lib/call-actions.mjs"));

const TZ = "America/New_York";
const rec = { uuid: "U1==", start: "2026-11-16T15:00:00Z", end: "2026-11-16T15:45:00Z", minutes: 45, topic: "", guests: [{ name: "Rob Day", email: null, minutes: 44 }] };
const candidates = [{ id: "user_robin_day", title: "Robin Day", description: "a client" }];
const answer = {
  title: "Pilot scope with Robin", summary: "Ann and Robin agreed the pilot scope.", points: ["Pilot scope"],
  remember: ["Robin's team starts the pilot in January"],
  next_steps_ann: [{ step: "Send Robin the pilot proposal", due: "2026-11-18" }, { step: "Ask legal about the NDA", due: null }],
  next_steps_others: [{ who: "Robin Day", step: "Share last quarter's numbers", due: null }],
  done_items: [],
  people: [{ participant: "Rob Day", wiki_id: "user_robin_day", name: "Robin Day" }], language: "en",
};

test("the log takes items with dates, facts to remember, and only offered done ids", () => {
  const ctx = { rec, candidates, hasContent: true, openItems: [{ id: "ca-aaaaaa-1" }] };
  assert.equal(CL.validateLog(answer, ctx), null);
  assert.equal(CL.validateLog({ ...answer, done_items: ["ca-aaaaaa-1"] }, ctx), null);
  assert.match(CL.validateLog({ ...answer, done_items: ["ca-zzzzzz-9"] }, ctx), /done_items/);
  assert.match(CL.validateLog({ ...answer, next_steps_ann: [{ step: "x", due: "Friday" }] }, ctx), /next_steps_ann/);
  // the older shape (plain strings) still passes
  assert.equal(CL.validateLog({ ...answer, next_steps_ann: ["Send it"] }, ctx), null);
  const log = CL.cleanLog(answer, rec);
  assert.deepEqual(log.next_steps_ann, ["Send Robin the pilot proposal", "Ask legal about the NDA"]);
  assert.deepEqual(log.due, { self: ["2026-11-18", null], others: [null] });
  assert.deepEqual(log.remember, ["Robin's team starts the pilot in January"]);
});

test("the prompt lists earlier open items and reads the transcript as a transcript", () => {
  const p = CL.logPrompt(rec, { kind: "transcript", text: "Ann: hi" }, candidates, TZ, [], [{ id: "ca-aaaaaa-1", owner: "other", who: "Robin Day", step: "Send the deck", call_date: "2026-11-09" }]);
  assert.ok(p.includes("ca-aaaaaa-1 | Robin Day | Send the deck | from the call on 2026-11-09"));
  assert.ok(p.includes("machine transcript"));
  assert.ok(!p.includes("Zoom's AI wrote"));
});

const entry = { ...rec, tz: TZ, local_date: "2026-11-16", status: "logged", source: "transcript", log: CL.cleanLog(answer, rec) };

test("a logged call's items go in the ledger once, both sides, with ids", () => {
  const store = { calls: { [entry.uuid]: entry } };
  const { added } = CA.recordEntry(store, entry, "next_steps_ann", Date.parse("2026-11-16T16:00:00Z"));
  assert.equal(added.length, 3);
  assert.deepEqual(added.map((a) => [a.owner, a.who, a.due]), [["self", null, "2026-11-18"], ["self", null, null], ["other", "Robin Day", null]]);
  assert.equal(added[2].wiki_id, "user_robin_day");
  assert.match(added[0].id, /^ca-[0-9a-f]{6}-1$/);
  CA.setStatus(store, added[1].id, "done", { note: "legal said fine" });
  assert.equal(CA.recordEntry(store, entry, "next_steps_ann").added.length, 0);
  assert.equal(store.actions[added[1].id].status, "done"); // a re-log never reopens it
  // a later call with Robin sees his open items and can close them
  assert.deepEqual(CA.openItemsFor(store, [{ wiki_id: "user_robin_day", name: "Robin Day" }]).map((a) => a.id).sort(), [added[0].id, added[2].id].sort());
  const later = { ...entry, uuid: "U2==", local_date: "2026-11-20", log: { ...CL.cleanLog({ ...answer, next_steps_ann: [], next_steps_others: [] }, rec), done_items: [added[2].id] } };
  const { closed } = CA.recordEntry(store, later, "next_steps_ann");
  assert.deepEqual(closed.map((a) => a.id), [added[2].id]);
  assert.equal(store.actions[added[2].id].closed_by, "call");
});

test("follow-up pacing: due dates, then day 2/5/10 for the user and 3/6/11 for others, once a day", () => {
  const store = { calls: { [entry.uuid]: entry } };
  CA.recordEntry(store, entry, "next_steps_ann");
  const at = (d, h = 10) => Date.parse(`${d}T${String(h + 5).padStart(2, "0")}:00:00Z`); // New York, EST
  assert.equal(CA.followupPlan(store, { tz: TZ, now: at("2026-11-17") }).send, false); // day 1: nothing
  const d2 = CA.followupPlan(store, { tz: TZ, now: at("2026-11-18") });
  assert.equal(d2.send, true);
  assert.deepEqual(d2.items.map((x) => x.why), ["due today", "from the call on 2026-11-16"]); // NDA hits day 2
  assert.ok(d2.text.includes("Send Robin the pilot proposal"));
  assert.equal(CA.followupPlan(store, { tz: TZ, now: at("2026-11-18", 7) }).why, "before 9:00");
  CA.markFollowedUp(store, d2);
  assert.equal(CA.followupPlan(store, { tz: TZ, now: at("2026-11-18", 15) }).send, false); // one a day
  const d3 = CA.followupPlan(store, { tz: TZ, now: at("2026-11-19") });
  assert.deepEqual(d3.items.map((x) => [x.item.owner, x.why]), [["self", "due 2026-11-18, 1 day ago"], ["other", "from the call on 2026-11-16"]]);
  assert.ok(d3.text.includes("Robin Day: Share last quarter's numbers"));
  assert.ok(d3.text.includes("draft a nudge"));
  CA.markFollowedUp(store, d3);
  // a done item is never raised again; a missed mark day is caught up once
  CA.setStatus(store, Object.values(store.actions).find((a) => a.due).id, "done");
  const d9 = CA.followupPlan(store, { tz: TZ, now: at("2026-11-25") });
  assert.deepEqual(d9.items.map((x) => x.item.owner), ["self", "other"]);
  CA.markFollowedUp(store, d9);
  // the last marks: day 10 for the user's, day 11 for Robin's; then quiet for good
  const d10 = CA.followupPlan(store, { tz: TZ, now: at("2026-11-26") });
  assert.deepEqual(d10.items.map((x) => x.item.owner), ["self"]);
  CA.markFollowedUp(store, d10);
  const d11 = CA.followupPlan(store, { tz: TZ, now: at("2026-11-27") });
  assert.deepEqual(d11.items.map((x) => x.item.owner), ["other"]);
  CA.markFollowedUp(store, d11);
  assert.equal(CA.followupPlan(store, { tz: TZ, now: at("2026-12-20") }).send, false);
});

test("a new date resets its follow-ups; past-due nudges stop after three", () => {
  const store = { calls: { [entry.uuid]: entry } };
  const [mine] = CA.recordEntry(store, entry, "next_steps_ann").added;
  for (const d of ["2026-11-18", "2026-11-19", "2026-11-20"]) store.actions[mine.id].nudges.push(d);
  assert.equal(CA.followupReason(store.actions[mine.id], "2026-11-21"), null);
  CA.setStatus(store, mine.id, "due", { due: "2026-11-24" });
  assert.equal(CA.followupReason(store.actions[mine.id], "2026-11-24"), "due today");
  assert.throws(() => CA.setStatus(store, mine.id, "due", { due: "next week" }), /YYYY-MM-DD/);
  assert.throws(() => CA.setStatus(store, "ca-nope-1", "done"), /no action item/);
});

test("the recap names the call, both sides' items and what got done", () => {
  const store = { calls: { [entry.uuid]: entry } };
  const { added } = CA.recordEntry(store, entry, "next_steps_ann");
  const t = CA.recapText(entry, added, [], { who: "Robin Day" });
  assert.ok(t.startsWith("Call with Robin Day, 45 min: Pilot scope with Robin."));
  assert.ok(t.includes("• Send Robin the pilot proposal (by 2026-11-18)"));
  assert.ok(t.includes("Theirs:\n• Robin Day: Share last quarter's numbers"));
  assert.ok(t.includes("(from the call's transcript)"));
});

test("the person page line keeps the facts worth remembering", () => {
  const line = CL.personLine(entry, "user_robin_day");
  assert.ok(line.includes("Worth remembering: Robin's team starts the pilot in January."));
});
