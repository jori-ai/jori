// stated-place.test.mjs — "If you know this, why did you ask?"
//
// At 12:42 local time the user wrote of meeting friends for lunch at a named
// restaurant; at 15:31 a card asked which of four places the 13:31–14:52 stop
// was. The step reads the day's chat and calendar before any stop question;
// every model rung here is stubbed. Names and places are synthetic.
//
// Run: node --test tests/stated-place.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "stated-place-"));
process.env.JORI_STATED_PLACE_LOG = path.join(LOG_DIR, "log.jsonl");
// A synthetic installation: the owner the transcript names.
fs.writeFileSync(path.join(LOG_DIR, "instance.json"), JSON.stringify({ owner_name: "Alex" }));
process.env.JORI_LOCAL_DIR = LOG_DIR;

const { statedPlace, checkAnswer, buildTranscript, timedEvents, localDayStartMs, readFromMs } =
  await import("../lib/stated-place.mjs");
const { evidenceVerdict } = await import("../lib/stop-evidence.mjs");

const TZ = "Asia/Jerusalem";
const START = Date.parse("2026-10-20T10:31:42Z"); // 13:31 local
const END = Date.parse("2026-10-20T11:52:00Z");   // 14:52 local
const NOW = Date.parse("2026-10-20T12:31:00Z");   // when the card went out

// The day's chat as it was (abridged; real rows, real wording).
const ROWS = [
  { role: "user", content: "the grilled meats were excellent and jo really wanted to go. However, it was very expensive and the included salad variety were disappointing. we probably won’t go again.", created_at: "2026-10-20T08:05:01Z" },
  { role: "assistant", content: "Looking back to this morning, around 08:55 — 08:55–09:54 (59 min), around 1 רח׳ מספר 3350, after The Rental Flat — which of these was it?", created_at: "2026-10-20T08:30:46Z" },
  { role: "user", content: "בוטיקפה", created_at: "2026-10-20T08:33:13Z" },
  { role: "assistant", content: "It's lunchtime where you are. Want me to find a couple of spots within walking distance?", created_at: "2026-10-20T09:16:26Z" },
  { role: "user", content: "No need. I’m picking up Robin and Lee and meeting Sam and kim for lunch at the blue fish in the old port.", created_at: "2026-10-20T09:42:41Z" },
  { role: "assistant", content: "Sounds like a good lunch crowd. Enjoy it at the port with Robin, Lee, Sam and Kim.", created_at: "2026-10-20T09:42:42Z" },
  { role: "assistant", content: "You're near the old port, which has been in use for close to 4,000 years.", created_at: "2026-10-20T10:40:08Z" },
];
const PLACES = [
  { id: "c0", name: "The Blue Fish", type: "restaurant", from_m: 12 },
  { id: "c1", name: "Example Taverna", type: "restaurant", from_m: 25 },
  { id: "c2", name: "Example Theater", type: "performing_arts_theater", from_m: 40 },
];
const sbFor = (rows) => async (q) => (q.startsWith("jori_messages") ? rows : []);
const SONNET_YES = { named: true, venue: "The Blue Fish", listed_id: "c0", source: "chat",
  quote: "meeting Sam and kim for lunch at the blue fish in the old port", said_at: "12:42",
  confidence: 0.94, basis: "At 12:42 he said lunch was at The Blue Fish; the stop is lunchtime at the port." };

/** A ladder stub: answers per tier, recording what each rung was shown. */
function ladder(answers) {
  const calls = [];
  const run = async (tier, prompt) => {
    calls.push({ tier, prompt });
    const a = answers[tier];
    if (a instanceof Error) throw a;
    return typeof a === "string" ? a : JSON.stringify(a);
  };
  return { run, calls };
}

let seq = 0;
const fresh = () => ({ id: `t${++seq}`, now: NOW + seq * 1000, cache: false });

test("the port lunch: the 12:42 plan settles the 13:31 stop, and the model saw it", async () => {
  const { run, calls } = ladder({ local: "I think it is the restaurant.", sonnet: SONNET_YES });
  const r = await statedPlace({ sb: sbFor(ROWS), start: START, end: END, tz: TZ, places: PLACES, run, ...fresh() });
  assert.equal(r.settled, true);
  assert.equal(r.tier, "sonnet");
  assert.equal(r.venue.name, "The Blue Fish");
  assert.equal(r.venue.source, "chat");
  assert.equal(r.venue.plan, true);           // said 49 min before the stop began
  assert.equal(r.venue.said_at, Date.parse("2026-10-20T09:42:41Z"));
  assert.deepEqual(calls.map((c) => c.tier), ["local", "sonnet"]);
  const p = calls[1].prompt;
  assert.ok(p.includes("[12:42] USER: No need. I’m picking up Robin"));
  assert.ok(p.includes("from 13:31 to 14:52"));
  // The morning answer is shown WITH the question it answered.
  assert.ok(p.includes("which of these was it?") && p.includes("[11:33] USER: בוטיקפה"));
  // Jori's ambient line that he never answered is not shown.
  assert.ok(!p.includes("4,000 years"));
});

test("a 1B model's 'no' is not evidence: it climbs; Sonnet's 'no' stands", async () => {
  const { run, calls } = ladder({ local: { named: false }, sonnet: { named: false, basis: "nothing for this window" } });
  const r = await statedPlace({ sb: sbFor(ROWS), start: START, end: END, tz: TZ, places: PLACES, run, ...fresh() });
  assert.equal(r.settled, false);
  assert.equal(r.tier, "sonnet");
  assert.deepEqual(calls.map((c) => c.tier), ["local", "sonnet"]);
});

test("the local rung may settle a listed place on its own, but never durably", async () => {
  const { run, calls } = ladder({ local: SONNET_YES });
  const r = await statedPlace({ sb: sbFor(ROWS), start: START, end: END, tz: TZ, places: PLACES, run, ...fresh() });
  assert.equal(r.settled, true);
  assert.equal(r.tier, "local");
  assert.equal(r.venue.durable, false);
  assert.deepEqual(calls.map((c) => c.tier), ["local"]);
  // stop-evidence names the stop from it but does not confirm it.
  const ev = await evidenceVerdict({ sb: async () => [], start: START, end: END, tz: TZ, rest: null, near: () => [],
    stated: async () => r });
  assert.equal(ev.settled, true);
  assert.equal(ev.confirm, false);
});

test("a quote must carry words: 'ok' never passes; an unlisted name must be spelled as he wrote it", () => {
  const rows = [{ role: "user", content: "ok", created_at: "2026-10-20T10:50:00Z" },
                { role: "user", content: "We're at the hummus place by the clock tower", created_at: "2026-10-20T10:55:00Z" }];
  const ctx = { lines: buildTranscript(rows), events: [], places: PLACES, start: START };
  assert.equal(checkAnswer({ ...SONNET_YES, quote: "ok" }, ctx, "sonnet").ok, false);
  const translated = { named: true, venue: "Example Hummus", listed_id: null, source: "chat",
    quote: "We're at the hummus place by the clock tower", confidence: 0.9, basis: "guessing the name" };
  assert.equal(checkAnswer(translated, ctx, "sonnet").ok, false);
  // Two of his messages joined with an ellipsis still verify.
  const lines = buildTranscript(ROWS);
  const joined = { ...SONNET_YES, quote: "No need… meeting Sam and kim for lunch at the blue fish" };
  assert.equal(checkAnswer(joined, { lines, events: [], places: PLACES, start: START }, "sonnet").settled, true);
});

test("the ladder stops at its deadline", async () => {
  const { run, calls } = ladder({ local: { named: false }, sonnet: SONNET_YES });
  const r = await statedPlace({ sb: sbFor(ROWS), start: START, end: END, tz: TZ, places: PLACES, run, ...fresh(), deadlineMs: 1000 });
  assert.equal(r.settled, false);
  assert.equal(calls.length, 0);
  assert.ok(r.attempts.every((a) => a.error === "skipped: out of time"));
});

test("an invented quote fails validation and climbs to Opus", async () => {
  const bad = { ...SONNET_YES, quote: "we are having lunch at The Blue Fish" };
  const { run, calls } = ladder({ local: { named: false }, sonnet: bad, opus: SONNET_YES });
  const r = await statedPlace({ sb: sbFor(ROWS), start: START, end: END, tz: TZ, places: PLACES, run, ...fresh() });
  assert.equal(r.settled, true);
  assert.equal(r.tier, "opus");
  assert.ok(r.attempts[1].error.startsWith("quote is not in the user's messages"));
});

test("Jori's words are never his: quoting the assistant fails", () => {
  const lines = buildTranscript(ROWS);
  const chk = checkAnswer({ ...SONNET_YES, quote: "Enjoy it at the port" }, { lines, events: [], places: PLACES, start: START }, "sonnet");
  assert.equal(chk.ok, false);
});

test("a plan naming a place that is not where he stopped does not settle (and does not climb)", async () => {
  const rows = [...ROWS.slice(0, 4), { role: "user", content: "Lunch today at Example Diner", created_at: "2026-10-20T09:40:00Z" }];
  const ans = { named: true, venue: "Example Diner", listed_id: null, source: "chat", quote: "Lunch today at Example Diner", confidence: 0.9, basis: "his plan" };
  const { run, calls } = ladder({ local: { named: false }, sonnet: ans, opus: SONNET_YES });
  const r = await statedPlace({ sb: sbFor(rows), start: START, end: END, tz: TZ, places: PLACES, run, ...fresh() });
  assert.equal(r.settled, false);
  assert.ok(r.reason.includes("not among the places"));
  assert.deepEqual(calls.map((c) => c.tier), ["local", "sonnet"]);
});

test("said during the stop, an unlisted place stands on his word", async () => {
  const rows = [{ role: "user", content: "We're at Example Hummus, best hummus", created_at: "2026-10-20T10:50:00Z" }];
  const ans = { named: true, venue: "Example Hummus", listed_id: null, source: "chat", quote: "We're at Example Hummus", confidence: 0.95, basis: "he said so" };
  const { run } = ladder({ local: { named: false }, sonnet: ans });
  const r = await statedPlace({ sb: sbFor(rows), start: START, end: END, tz: TZ, places: PLACES, run, ...fresh() });
  assert.equal(r.settled, true);
  assert.equal(r.venue.name, "Example Hummus");
  assert.equal(r.venue.plan, false);
});

test("low confidence never settles; a listed_id that is not a candidate is invalid", () => {
  const lines = buildTranscript(ROWS), ctx = { lines, events: [], places: PLACES, start: START };
  assert.equal(checkAnswer({ ...SONNET_YES, confidence: 0.6 }, ctx, "sonnet").settled, false);
  assert.equal(checkAnswer({ ...SONNET_YES, listed_id: "c9" }, ctx, "sonnet").ok, false);
  assert.equal(checkAnswer({ ...SONNET_YES, confidence: 0.6 }, ctx, "local").ok, false);
});

test("nothing said today and nothing on the calendar: no model call", async () => {
  const { run, calls } = ladder({});
  const r = await statedPlace({ sb: sbFor([{ role: "assistant", content: "Hi", created_at: "2026-10-20T08:00:00Z" }]),
    start: START, end: END, tz: TZ, places: PLACES, run, ...fresh() });
  assert.equal(r.settled, false);
  assert.equal(calls.length, 0);
});

test("calendar: timed events around the window only; a calendar name must be a listed place", async () => {
  const cal = [
    { summary: "Jerusalem", start: "2026-10-20", end: "2026-10-21" },                                    // all-day: dropped
    { summary: "Lunch — The Blue Fish", location: "", start: "2026-10-20T13:30:00+03:00", end: "2026-10-20T15:00:00+03:00" },
    { summary: "Dinner", start: "2026-10-20T20:00:00+03:00", end: "2026-10-20T22:00:00+03:00" },        // far from the window
  ];
  const ev = timedEvents(cal, START, END);
  assert.deepEqual(ev.map((e) => e.title), ["Lunch — The Blue Fish"]);
  const ans = { named: true, venue: "The Blue Fish", listed_id: "c0", source: "calendar",
    quote: "Lunch — The Blue Fish", confidence: 0.9, basis: "calendar" };
  const { run } = ladder({ local: { named: false }, sonnet: ans });
  const r = await statedPlace({ sb: sbFor([]), start: START, end: END, tz: TZ, places: PLACES, calendar: cal, run, ...fresh() });
  assert.equal(r.settled, true);
  assert.equal(r.venue.source, "calendar");
  const unlisted = checkAnswer({ ...ans, listed_id: null }, { lines: [], events: ev, places: PLACES, start: START }, "sonnet");
  assert.equal(unlisted.settled, false);
});

test("not logged in (a cron child): the other Claude rung is skipped, not retried", async () => {
  const { run, calls } = ladder({ local: { named: false }, sonnet: new Error("not_logged_in: Not logged in"), opus: SONNET_YES });
  const r = await statedPlace({ sb: sbFor(ROWS), start: START, end: END, tz: TZ, places: PLACES, run, ...fresh() });
  assert.equal(r.settled, false);
  assert.deepEqual(calls.map((c) => c.tier), ["local", "sonnet"]);
});

test("an identical bundle reuses its answer; a dead ladder is not cached", async () => {
  const { run } = ladder({ local: { named: false }, sonnet: SONNET_YES });
  const args = { sb: sbFor(ROWS), start: START, end: END, tz: TZ, places: PLACES, id: "cache", now: NOW };
  const a = await statedPlace({ ...args, run });
  const second = ladder({});
  const b = await statedPlace({ ...args, run: second.run });
  assert.equal(a.settled, true);
  assert.equal(b.cached, true);
  assert.equal(b.venue.name, "The Blue Fish");
  assert.equal(second.calls.length, 0);
});

test("the read starts at local midnight (six hours back for a small-hours stop)", () => {
  assert.equal(new Date(localDayStartMs(START, TZ)).toISOString(), "2026-10-19T21:00:00.000Z");
  const early = Date.parse("2026-10-20T00:30:00Z"); // 03:30 local
  assert.equal(readFromMs(early, TZ), early - 6 * 3600e3);
  assert.equal(new Date(localDayStartMs(Date.parse("2026-10-20T15:00:00Z"), "America/New_York")).toISOString(), "2026-10-20T04:00:00.000Z");
});

test("stop-evidence: a stated answer from his words comes back as confirm, before anything else runs", async () => {
  let decided = false;
  const stated = async () => ({ settled: true, tier: "sonnet", summary: { his_messages: 3 },
    venue: { name: "The Blue Fish", listed: true, source: "chat", plan: true, confidence: 0.94,
      quote: "lunch at the blue fish", said_at: Date.parse("2026-10-20T09:42:41Z"), basis: "his plan" } });
  const r = await evidenceVerdict({ sb: async () => [], start: START, end: END, tz: TZ, rest: { lat: 12.3456, lon: -65.4321 },
    near: () => [{ name: "The Blue Fish", primary_type: "restaurant", lat: 12.3457, lon: -65.4321 }],
    decideImpl: async () => { decided = true; return { value: null }; }, stated });
  assert.equal(r.settled, true);
  assert.equal(r.confirm, true);
  assert.equal(r.venue.name, "The Blue Fish");
  assert.ok(r.reason.startsWith('the user said "lunch at the blue fish" at 12:42'));
  assert.equal(decided, false);
  // Named from the calendar alone: settled, but not his confirmation.
  const cal = await evidenceVerdict({ sb: async () => [], start: START, end: END, tz: TZ, rest: null, near: () => [],
    stated: async () => ({ settled: true, tier: "sonnet", venue: { name: "X", source: "calendar", quote: "Lunch at X", confidence: 0.9 } }) });
  assert.equal(cal.settled, true);
  assert.equal(cal.confirm, false);
});

// ---------------------------------------------------------------------------
// location-confirm (the cron path): the stated verdict is tier 3, ahead of the
// Jev tail, and the tail now sees his earlier-today messages.
// ---------------------------------------------------------------------------
const { spawnSync } = await import("node:child_process");
const { fileURLToPath } = await import("node:url");
const RESOLVE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/location-confirm-resolve.mjs");

test("location-confirm-resolve: a settled stated verdict auto-confirms as stated:chat", () => {
  const payload = {
    centroid: { lat: 10.5, lon: 10.5 }, // nowhere near a confirmed stop (tier 1 reads the live file)
    candidates: [{ name: "The Blue Fish", primary_type: "restaurant" }, { name: "Example Taverna" }],
    calendarEvents: [], messages: [], dwellWindow: { startMs: START, endMs: END },
    stated: { settled: true, tier: "sonnet", venue: { name: "The Blue Fish", source: "chat",
      quote: "lunch at the blue fish", confidence: 0.94 } },
  };
  const res = spawnSync(process.execPath, [RESOLVE, "--resolve-only"], { input: JSON.stringify(payload), encoding: "utf8", timeout: 30000 });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.decision, "auto_confirm");
  assert.equal(out.venue, "The Blue Fish");
  assert.equal(out.source, "stated:chat");
  assert.ok(out.reasoning.startsWith('he said "lunch at the blue fish"'));
});

test("location-confirm Jev tail: earlier_today is his messages before the dwell, never Jori's", async () => {
  const { earlierTodayMsgs, dwellWindowMsgs } = await import("../lib/location-confirm-jev.mjs");
  const msgs = ROWS.map((r) => ({ role: r.role, body: r.content, at: r.created_at }));
  const win = { startMs: START, endMs: END };
  const earlier = earlierTodayMsgs(msgs, win);
  assert.deepEqual(earlier.map((m) => m.at), ["2026-10-20T08:05:01Z", "2026-10-20T08:33:13Z", "2026-10-20T09:42:41Z"]);
  assert.equal(dwellWindowMsgs(msgs, win).length, 0); // the 12:42 plan was outside the old window
});
