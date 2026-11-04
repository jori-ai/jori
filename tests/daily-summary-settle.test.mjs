// daily-summary-settle.test.mjs — the day's facts settle as JSON, iteratively,
// BEFORE anything is formatted (the user, 2026-07-27: "the day skeleton building
// should be deterministic (json). it may require multiple passes to get the json
// right. once it's as good as we can get it, we should format the final email.")
//
// The case that forced the split is reproduced verbatim below from the
// 2026-07-26 transcript: Jori asked about the 12:49 window at 13:16, the user
// answered at 15:13 — two hours and three unrelated Jori messages later, with
// two OTHER location asks still open. The old pipeline titled that window
// "~L'Équinoxe? · unconfirmed (also: Domino's, Le Transat)" and wrote correct
// prose underneath it. Settling now binds the answer to the right ask, and the
// title is decided once, in the JSON, before any HTML exists.
//
// Run: node --test tests/daily-summary-settle.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { settleDay, mineAskAnswers, _internal } = require(path.join(ROOT, "lib/daily-summary-day.js"));
const { _internal: render } = require(path.join(ROOT, "lib/daily-summary-render.js"));

const iso = (hhmm) => `2026-07-26T${hhmm}:00+02:00`;

// The three location-enrich asks Jori actually sent that day, plus the
// unrelated traffic between them, plus the user's single answer.
const MESSAGES = [
  { id: "m1", role: "assistant", created_at: iso("13:01"),
    content: "31m near the port around 12:10 today, but GPS shows you moving/driving over a wide stretch (~1.4km) the whole time, not parked anywhere — real stop somewhere (OHAYO for lunch, maybe?), or just driving back from the coastal walk?" },
  { id: "m2", role: "user", created_at: iso("13:01"), content: "Yes. Caroline was canceled." },
  { id: "m3", role: "assistant", created_at: iso("13:16"),
    content: "9m near Plage des Minimes around 12:49 — but GPS shows you moving the whole stretch, not sitting still. Just a walk along the beach, or did you actually stop somewhere (Equinoxe, maybe)?" },
  { id: "m4", role: "assistant", created_at: iso("13:52"), content: "Daily summary emailed, 2 stop(s) I couldn't pin, reply to label." },
  { id: "m5", role: "assistant", created_at: iso("14:15"),
    content: "20m near a cluster of vacation rentals around 13:27, but GPS shows you drifting ~200m the whole time — wandering the block, or just back at your place?" },
  { id: "m6", role: "user", created_at: iso("15:13"), content: "We were walking along the coastline in the minimes park." },
];

function day() {
  return {
    date: "2026-07-26",
    stops: [
      { id: "s-2", start: "12:09", end: "12:45", duration_min: 36,
        place: { name: "Résidence avec Piscine face au port", source: "google_places", confidence: 0.5 },
        alternatives: [{ name: "Standard Studio", distance_km: 0.05 }], sample_count: 3, pattern: "browse",
        start_ts_ms: Date.parse(iso("12:09")), end_ts_ms: Date.parse(iso("12:45")) },
      { id: "s-3", start: "12:49", end: "13:02", duration_min: 13,
        place: { name: "L'Équinoxe", source: "osm_overpass", confidence: 0.5, distance_m: 40 },
        alternatives: [{ name: "Domino's", distance_km: 0.05 }, { name: "Le Transat", distance_km: 0.06 }],
        sample_count: 12, pattern: "browse", companions: ["Sam"],
        start_ts_ms: Date.parse(iso("12:49")), end_ts_ms: Date.parse(iso("13:02")) },
      { id: "s-4", start: "13:13", end: "13:27", duration_min: 14,
        place: { name: "T2 Sea View", source: "google_places", confidence: 0.5 },
        alternatives: [{ name: "Vrbo Property", distance_km: 0.05 }], sample_count: 3, pattern: "browse",
        start_ts_ms: Date.parse(iso("13:13")), end_ts_ms: Date.parse(iso("13:27")) },
    ],
  };
}

test("his answer binds to the ask it answers, not the newest or the nearest", () => {
  const d = day();
  const { answers } = mineAskAnswers(MESSAGES, d.stops);
  assert.equal(answers.length, 1, JSON.stringify(answers));
  const a = answers[0];
  // Three asks were open at 15:13. "minimes" is the discriminating token.
  assert.equal(a.stop_id, "s-3");
  assert.equal(a.kind, "movement");
  assert.equal(a.label, "We were walking along the coastline in the minimes park");
  assert.equal(a.method, "overlap");
});

test("settling titles the answered window with his words and leaves the others hedged", () => {
  const d = day();
  const out = settleDay(d, { messages: MESSAGES });

  const byId = Object.fromEntries(out.stops.map(s => [s.id, s]));
  assert.equal(byId["s-3"].provenance.title, "Minimes Park");
  assert.equal(byId["s-3"].provenance.movement_note, "We were walking along the coastline in the minimes park");
  assert.equal(byId["s-3"].provenance.certainty, "answered");
  assert.equal(byId["s-3"].provenance.title_kind, "movement");
  assert.deepEqual(byId["s-3"].provenance.alternatives, []);
  assert.equal(byId["s-3"].needs_review, null);

  // The two the user did NOT answer stay honest guesses — this is the behavior the
  // change must not break. A guess belongs in a title exactly where no answer is.
  assert.equal(byId["s-2"].provenance.certainty, "weak_guess");
  assert.ok(byId["s-2"].needs_review, "an unanswered thin guess should still ask for review");
  assert.equal(byId["s-4"].provenance.certainty, "weak_guess");
});

test("the header formats the settled title and decides nothing itself", () => {
  const d = day();
  settleDay(d, { messages: MESSAGES });
  const h = render.stopHeaderHtml(d.stops[1]).replace(/<[^>]+>/g, "");
  // start-time header, not a start-end range
  assert.match(h, /12:49pm · Minimes Park · walking/);
  assert.doesNotMatch(h, /Équinoxe|Domino|Transat|unconfirmed|~/);
  assert.match(h, /with Sam/);
});

test("a threaded reply binds exactly, with no keyword guessing", () => {
  const d = day();
  // Same three asks, but the user's reply names nothing at all — only the thread.
  const msgs = MESSAGES.slice(0, 5).concat([
    { id: "m6", role: "user", created_at: iso("15:13"), reply_to: "m3", content: "yeah just walking" },
  ]);
  const { answers } = mineAskAnswers(msgs, d.stops);
  assert.equal(answers.length, 1);
  assert.equal(answers[0].stop_id, "s-3");
  assert.equal(answers[0].method, "thread");
  assert.equal(answers[0].kind, "movement");
});

test("an ambiguous reply is left open rather than titling the wrong stop", () => {
  const d = day();
  // "walking" appears in ask m1 AND ask m3 — a tie. Nothing else discriminates.
  const msgs = MESSAGES.slice(0, 5).concat([
    { id: "m6", role: "user", created_at: iso("15:13"), content: "we were walking" },
  ]);
  const { answers, unattributed } = mineAskAnswers(msgs, d.stops);
  assert.deepEqual(answers, [], "a tie must drop, not guess");
  assert.equal(unattributed.length, 1, "but it must still be surfaced, not lost");
  const out = settleDay(d, { messages: msgs });
  assert.equal(out.stops.find(s => s.id === "s-3").provenance.certainty, "weak_guess");
});

// The mis-bindings a first cut of this produced when run against the real
// 2026-07-26 day. Every one came from treating "the only open location ask" as
// sufficient — the user answers Jori's questions out of order and hours late,
// so the most recent message is routinely not the one the user is replying to.
test("a reply to a DIFFERENT question never becomes a stop's title", () => {
  const d = day();
  const msgs = [
    { id: "q-cal", role: "assistant", created_at: iso("11:42"),
      content: "Your Riverton calendar has two stay events for Jul 28-Aug 6 — the Caroline listing was canceled 6/25 but it's still sitting there next to the real one with Valerie. Want me to flag it for removal?" },
    MESSAGES[0],                                                     // the 12:10 location ask, 13:01:05
    { id: "m2", role: "user", created_at: iso("13:02"), content: "Yes. Caroline was canceled." },
  ];
  // The location ask was the most recent message and the user replied seconds later —
  // but the user was answering the calendar question from 80 minutes earlier.
  const out = mineAskAnswers(msgs, d.stops);
  assert.deepEqual(out.answers, []);
  assert.equal(out.unattributed.length, 1, "surfaced for the agent, never dropped");
});

test("prose that mentions where he was is advisory, not a title", () => {
  const d = day();
  const msgs = [
    { id: "q-loc", role: "assistant", created_at: iso("12:52"),
      content: "9m near Plage des Minimes around 12:49 — real stop, or did you walk past the restaurants?" },
    { id: "u", role: "user", created_at: iso("13:10"),
      content: "We stopped at one of the restaurants and had a plate of cheeses and wine, near the minimes park." },
  ];
  const { answers } = mineAskAnswers(msgs, d.stops);
  assert.equal(answers.length, 1);
  assert.equal(answers[0].kind, "venue");
  assert.equal(answers[0].applied, false, "a sentence must not be printed as a header");
  // So the stop stays hedged and lands on the agent's work-list.
  const out = settleDay(d, { messages: msgs });
  assert.equal(out.stops.find(s => s.id === "s-3").provenance.certainty, "weak_guess");
  assert.ok(out.stops.find(s => s.id === "s-3").needs_review);
});

test("a short name-like answer DOES become the title", () => {
  const d = day();
  const msgs = [
    { id: "q-loc", role: "assistant", created_at: iso("12:52"),
      content: "9m near Plage des Minimes around 12:49 — which place was that?" },
    { id: "u", role: "user", created_at: iso("13:10"), reply_to: "q-loc", content: "Le Récif" },
  ];
  const out = settleDay(d, { messages: msgs });
  const s3 = out.stops.find(s => s.id === "s-3");
  assert.equal(s3.provenance.title, "Le Récif");
  assert.equal(s3.provenance.certainty, "answered");
});

// 2026-07-27, verbatim. Four location asks went out during a day at Puy du Fou;
// the user answered all four in ONE threaded reply that evening. Binding it to the
// threaded ask alone loses three answers, and classifying the whole text (it
// contains "Just walked") would have marked the 13:36 stop a non-stop and titled
// it with the entire paragraph. Attributing the pieces deterministically is not
// possible — "We had lunch after the last panache at the rotissirie" shares its
// rare words with the SHOW ask, not the lunch ask it actually answers — so the
// reply is surfaced whole, with every candidate stop, for the agent to split.
test("one reply answering several asks is surfaced, never guessed at", () => {
  const t = (hhmm) => `2026-07-27T${hhmm}:00+02:00`;
  const stops = [
    { id: "p-1", start: "11:00", end: "11:58", start_ts_ms: Date.parse(t("11:00")), end_ts_ms: Date.parse(t("11:58")),
      place: { name: "Puy du Fou", source: "google_places", confidence: 0.5 }, sample_count: 8 },
    { id: "p-2", start: "11:58", end: "12:48", start_ts_ms: Date.parse(t("11:58")), end_ts_ms: Date.parse(t("12:48")),
      place: { name: "Le Relais de Poste", source: "google_places", confidence: 0.5 }, sample_count: 6 },
    { id: "p-3", start: "13:36", end: "14:46", start_ts_ms: Date.parse(t("13:36")), end_ts_ms: Date.parse(t("14:46")),
      place: { name: "Mousquetaire de Richelieu", source: "google_places", confidence: 0.5 }, sample_count: 9 },
    { id: "p-4", start: "14:52", end: "15:11", start_ts_ms: Date.parse(t("14:52")), end_ts_ms: Date.parse(t("15:11")),
      place: { name: "Le Labyrinthe des Animaux", source: "google_places", confidence: 0.5 }, sample_count: 5 },
  ];
  const msgs = [
    { id: "a1", role: "assistant", created_at: t("12:15"),
      content: "The Last Panache around 11:00 (~1h there) — did you catch that show at Puy du Fou, or was it just walking the park before lunch?" },
    { id: "a2", role: "assistant", created_at: t("13:46"),
      content: "50m for lunch around Puy du Fou at 11:58, right after the show — but GPS shows you drifting ~300m the whole time, more like Le Relais de Poste or bouncing between a few food spots?" },
    { id: "a3", role: "assistant", created_at: t("15:01"),
      content: "Was the Mousquetaire de Richelieu show your stop at Puy du Fou, ~1h10 starting 13:36?" },
    { id: "a4", role: "assistant", created_at: t("16:00"),
      content: "19m in the Puy du Fou park around 14:52, but GPS has you covering ~600m the whole stretch — sounds like walking between attractions rather than a stop somewhere. Or did you actually pause, like at Le Labyrinthe des Animaux?" },
    { id: "u", role: "user", created_at: t("18:18"), reply_to: "a3",
      content: "No. We saw the last panache first, then the vikings, then the colliseum show. We had lunch after the last panache at the rotissirie (roast chicken and potatoes). Just walked around in between." },
  ];

  const { answers, multi } = mineAskAnswers(msgs, stops);
  assert.equal(multi.length, 1, "the reply must be recognized as covering several asks");
  assert.deepEqual(multi[0].candidates.map(c => c.stop_id), ["p-1", "p-2", "p-3", "p-4"]);
  assert.equal(multi[0].threaded_to, "a3");
  assert.ok(multi[0].segments.length >= 4, JSON.stringify(multi[0].segments));
  // Nothing auto-applied: no stop gets titled off a paragraph that spans four.
  assert.deepEqual(answers, []);

  // And every stop it covers is flagged for the agent, with the reason.
  const out = settleDay({ date: "2026-07-27", stops }, { messages: msgs });
  for (const s of out.stops) {
    assert.ok(s.needs_review, `${s.id} should be flagged`);
    assert.match(s.needs_review.reason, /covering several stops/);
  }
  // Critically: the 13:36 stop is NOT marked a non-stop by the stray "Just walked".
  const p3 = out.stops.find(s => s.id === "p-3");
  assert.notEqual(p3.provenance.title_kind, "movement");
  assert.ok(!p3.provenance.non_stop);
});

test('a bare "no" to a "was it X?" ask rejects the venue — it is not a non-stop', () => {
  const t = (hhmm) => `2026-07-27T${hhmm}:00+02:00`;
  const stops = [{ id: "p-3", start: "13:36", end: "14:46",
    start_ts_ms: Date.parse(t("13:36")), end_ts_ms: Date.parse(t("14:46")),
    place: { name: "Mousquetaire de Richelieu", source: "google_places", confidence: 0.5 }, sample_count: 9 }];
  const msgs = [
    { id: "a3", role: "assistant", created_at: t("15:01"),
      content: "Was the Mousquetaire de Richelieu show your stop at Puy du Fou, ~1h10 starting 13:36?" },
    { id: "u", role: "user", created_at: t("18:18"), reply_to: "a3", content: "No" },
  ];
  const { answers } = mineAskAnswers(msgs, stops);
  assert.equal(answers[0].kind, "rejection");
  assert.equal(answers[0].applied, false);

  const out = settleDay({ date: "2026-07-27", stops }, { messages: msgs });
  const p3 = out.stops[0];
  assert.ok(!p3.provenance.non_stop, "he rejected the venue, not the stop");
  assert.match(p3.needs_review.reason, /rejected the venue/);
});

test("a command is not an answer", () => {
  assert.equal(_internal.classifyAnswer("show me the flights").kind, "unclear");
  assert.equal(_internal.classifyAnswer("Le Récif").kind, "venue");
  assert.equal(_internal.classifyAnswer("no").kind, "movement");
  assert.equal(_internal.classifyAnswer("just walking around").label, "Just walking around");
});

test("the agent's vetted name outranks a mined answer, and settling converges", () => {
  const d = day();
  const out = settleDay(d, { messages: MESSAGES, confirmed: { "s-3": "Le Récif" } });
  const s3 = out.stops.find(s => s.id === "s-3");
  assert.equal(s3.provenance.title, "Le Récif");
  assert.equal(s3.provenance.certainty, "answered");
  // Convergence is the contract: the loop must stop on its own, well inside the
  // cap, and say what each pass did.
  assert.ok(out.passes.length >= 1 && out.passes.length < _internal.MAX_PASSES,
    `expected convergence, got ${out.passes.length} passes`);
  assert.deepEqual(out.passes[out.passes.length - 1].titles_changed, []);
});

test("a user-confirmed row outranks an earlier mined answer to the same ask", () => {
  // 2026-10-10, Old Port: "Just passing through" (thread reply to the 17:35 ask),
  // then a correction that it was the stop where the user met Gil Zeev on Rover's
  // walk. The row was re-confirmed; the mined first answer must not undo it.
  const d = day();
  const s3 = d.stops.find(s => s.id === "s-3");
  s3.place = { name: "Rover's walk at the Old Port port", source: "user_confirmed", confidence: 1 };
  const msgs = MESSAGES.slice(0, 5).concat([
    { id: "m6", role: "user", created_at: iso("15:13"), reply_to: "m3", content: "Just passing through" },
  ]);
  assert.equal(mineAskAnswers(msgs, d.stops).answers[0].stop_id, "s-3", "the answer still binds");
  const out = settleDay(d, { messages: msgs });
  const got = out.stops.find(s => s.id === "s-3");
  assert.equal(got.provenance.title, "Rover's walk at the Old Port port");
  assert.equal(got.provenance.certainty, "answered");
  assert.notEqual(got.user_non_stop, true);
});

test("no chat at all → pure resolver behavior, unchanged", () => {
  const d = day();
  const out = settleDay(d, {});
  assert.equal(out.stops.find(s => s.id === "s-3").provenance.certainty, "weak_guess");
  assert.deepEqual(out.ask_answers, []);
  assert.deepEqual(out.multi_answer_replies, []);
});

test("a reply about something else does not consume the open location asks", () => {
  // The false multi this branch produced on the real 2026-07-26 day: an evening
  // message about the Riverton/Paris swap has 3 sentences, and two location asks
  // happened to be open — so it was read as a multi-answer, marked BOTH asks
  // answered, and the genuine Ars-en-Ré answer that arrived later had nothing
  // left to bind to. Multi now requires per-segment evidence that the reply is
  // about a location ask at all.
  const d = day();
  const msgs = MESSAGES.slice(0, 5).concat([
    { id: "m7", role: "user", created_at: iso("18:24"),
      content: "Already canceled Riverton. Waiting for the host to approve the refund. As soon as that's confirmed will book the Paris apartment." },
    { id: "m8", role: "user", created_at: iso("18:30"), content: "We were walking along the coastline in the minimes park." },
  ]);
  const { answers, multi } = mineAskAnswers(msgs, d.stops);
  assert.deepEqual(multi, [], "an off-topic reply is not a multi-answer");
  assert.equal(answers.length, 1, "and the real answer still lands");
  assert.equal(answers[0].stop_id, "s-3");
});

test("an ask from the NEXT day doesn't bind to a stop that merely covers its clock time", () => {
  // The chat window spans the target day and the next, so an evening ask
  // answered the following morning still lands. But an ask carries a clock time
  // with no date: 2026-07-27's "The Last Panache around 11:00" bound straight
  // onto 2026-07-26's 06:15-11:36 stop, which covers 11:00. A stop must also be
  // plausible for the ask — asked after it began, within 12h of it ending.
  const stops = [
    { id: "y-morning", start: "06:15", end: "11:36",
      start_ts_ms: Date.parse("2026-07-26T06:15:00+02:00"), end_ts_ms: Date.parse("2026-07-26T11:36:00+02:00"),
      place: { name: "8 Impasse Example", source: "confirmed_stop", confidence: 1 } },
    { id: "y-night", start: "22:31", end: "02:32",
      start_ts_ms: Date.parse("2026-07-26T22:31:00+02:00"), end_ts_ms: Date.parse("2026-07-27T02:32:00+02:00"),
      place: { name: "8 Impasse Example", source: "confirmed_stop", confidence: 1 } },
  ];
  const msgs = [
    // Next-day ask about a next-day stop — must NOT reach yesterday's 11:36 stop.
    { id: "far", role: "assistant", created_at: "2026-07-27T12:15:00+02:00",
      content: "The Last Panache around 11:00 (~1h there) — did you catch that show at Puy du Fou, or was it just walking the park?" },
    // Next-day ask about LAST night's stop — this one must still work.
    { id: "near", role: "assistant", created_at: "2026-07-27T08:46:00+02:00",
      content: "Back at the cottage after Judith Owen — home for the night, right? (in around 22:31, ~10h there)" },
    { id: "u", role: "user", created_at: "2026-07-27T09:00:00+02:00", reply_to: "near", content: "yes" },
  ];
  const asks = _internal.findAsks(msgs);
  const far = asks.find(a => a.id === "far"), near = asks.find(a => a.id === "near");
  assert.equal(_internal.stopCoveringMinutes(stops, far.minutes, { askAtMs: far.atMs }), null,
    "a 24h-old stop must not answer today's ask");
  assert.equal(_internal.stopCoveringMinutes(stops, near.minutes, { askAtMs: near.atMs }).id, "y-night",
    "but last night's stop still binds to this morning's ask");
});

test("a movement answer about a window inside a walk block keeps the walk's title (2026-10-21)", () => {
  // Old Port: the walk home from Falafel Corner was built (14:44-17:13) from the user's "not a
  // stop" answers, and "Just passing through", the user's reply to the 14:44-15:17 ask,
  // then turned the whole block into "not a stop" with no title.
  const at = (hhmm) => `2026-10-21T${hhmm}:00+03:00`;
  const d = { date: "2026-10-21", stops: [
    { id: "s-4", start: "13:24", end: "14:19", duration_min: 55, place: { name: "הקוסם", source: "user_confirmed", confidence: 1 },
      start_ts_ms: Date.parse(at("13:24")), end_ts_ms: Date.parse(at("14:19")) },
    { id: "s-5-walk", start: "14:44", end: "17:13", duration_min: 148, pattern: "browse", companions: ["Sam", "Noa"],
      place: { name: "Walk in גן הכובשים", source: "excursion", confidence: 0.7 },
      excursion: { routed_m: 2796, away_m: 2046, mode: "walking", non_stop_run: true },
      start_ts_ms: Date.parse(at("14:44")), end_ts_ms: Date.parse(at("17:13")) },
  ] };
  const msgs = [
    { id: "a1", role: "assistant", created_at: at("19:01"),
      content: "Looking back to this afternoon, around 14:44 — 14:44–15:17 (33 min), around 32 Example Street, after Eli's coffeeshuk — which of these was it?\n\nhttps://example-project.supabase.co/storage/v1/object/public/daily-photos/stop-maps/example-map.png" },
    { id: "u1", role: "user", created_at: at("19:16"), reply_to: "a1", content: "Just passing through" },
  ];
  const mined = mineAskAnswers(msgs, d.stops).answers;
  assert.equal(mined.length, 1);
  assert.equal(mined[0].stop_id, "s-5-walk", "the answer binds to the walk");
  const out = settleDay(d, { messages: msgs });
  const walk = out.stops.find(s => s.id === "s-5-walk");
  assert.notEqual(walk.user_non_stop, true);
  assert.equal(walk.provenance.title, "Walk in גן הכובשים");
});
