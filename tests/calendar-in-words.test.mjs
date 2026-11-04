// calendar-in-words.test.mjs — a calendar event the user's words say the user went to is that stop.
//
// 2026-10-21, Seaside City: "hilton hotel for the AI conference", the user's answer for the
// 10:30 stop, while "Future of AI 2026 conference" (8am-4pm, no location) was
// listed under "Events not matched to a location" right below it. A model reads
// whether the user's words name the event (Rule #0b); code only picks the questions,
// remembers the answers and stamps the event. No model runs here: `ask` is injected.
//
// Run: node --test tests/calendar-in-words.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { candidates, markCalendarInWords, validLadderAnswer } = await import("../lib/calendar-in-words.mjs");
const render = require("../lib/daily-summary-render.js");
const { eventsNotMatched, calendarCorroborated } = render._internal;

const AI = { summary: "Future of AI 2026 conference", location: "", physical: "", location_match: false,
  start: "2026-10-21T08:00:00+03:00", end: "2026-10-21T16:00:00+03:00", duration_min: 480, event_share: 0.05 };
const SAID = { venue: "Hilton hotel", activity: "AI conference", evidence: "hilton hotel for the AI conference" };
const day = () => ({ date: "2026-10-21", tz: "Asia/Jerusalem", unmatched_calendar_events: [], stops: [
  { id: "s-1", start: "09:04", end: "10:16", place: { name: "Café Example" }, calendar_event: { ...AI },
    provenance: { tier: "CONFIRMED", confirmed_name: "Café Example" } },
  { id: "s-2", start: "10:30", end: "10:56", place: { name: "Hilton Seaside City" }, calendar_event: { ...AI }, his_words: [SAID],
    provenance: { tier: "CONFIRMED", confirmed_name: "Hilton Seaside City" } },
  { id: "s-3", start: "11:09", end: "13:00", place: { name: "The Old Port Airbnb" }, calendar_event: { ...AI, location: "Expo Seaside City" },
    his_words: [SAID], provenance: { tier: "CONFIRMED", confirmed_name: "The Old Port Airbnb" } },
] });
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ciw-")), "verdicts.json");

test("only a stop with his words and an event with no place of its own is asked about", () => {
  const c = candidates(day());
  assert.deepEqual(c.map((x) => x.stop_id), ["s-2"]);
  assert.deepEqual(c[0].state, {
    stop: { place: "Hilton Seaside City", from: "10:30", to: "10:56" },
    what_he_said: [{ words: "hilton hotel for the AI conference", read_as: "Hilton hotel, AI conference" }],
    event: { title: "Future of AI 2026 conference", from: "08:00", to: "16:00" },
  });
});

test("a yes stamps the event on that stop only; it then leaves 'Events not matched' (2026-10-21)", async () => {
  const d = day(), file = tmpFile();
  const before = eventsNotMatched(d).map((e) => e.summary);
  assert.deepEqual(before, ["Future of AI 2026 conference"]);
  let calls = 0;
  const ask = async () => { calls += 1; return { yes: true, quote: "for the AI conference", by: "sonnet" }; };
  const out = await markCalendarInWords(d, { file, ask });
  assert.deepEqual(out.map((o) => [o.stop_id, o.yes, o.cached]), [["s-2", true, false]]);
  assert.deepEqual(d.stops[1].calendar_event.in_his_words, { quote: "for the AI conference", by: "sonnet" });
  assert.equal(d.stops[0].calendar_event.in_his_words, undefined, "the other stops it overlaps are not it");
  assert.equal(calendarCorroborated(d.stops[1]), true);
  assert.equal(calendarCorroborated(d.stops[0]), false);
  assert.deepEqual(eventsNotMatched(d), [], "matched at the Hilton, so not listed for the other stops either");
  // Asked once: a re-prep reads the answer back.
  const again = day();
  const out2 = await markCalendarInWords(again, { file, ask });
  assert.equal(calls, 1);
  assert.equal(out2[0].cached, true);
  assert.ok(again.stops[1].calendar_event.in_his_words);
});

test("a no, a failed model or the kill switch stamp nothing", async () => {
  const no = day();
  await markCalendarInWords(no, { file: tmpFile(), ask: async () => ({ yes: false, quote: null, by: "jev" }) });
  assert.equal(no.stops[1].calendar_event.in_his_words, undefined);
  const fail = day();
  const out = await markCalendarInWords(fail, { file: tmpFile(), ask: async () => { throw new Error("not_logged_in"); } });
  assert.deepEqual(out, []);
  assert.equal(fail.stops[1].calendar_event.in_his_words, undefined);
  process.env.JORI_CALENDAR_IN_WORDS = "0";
  try {
    const off = day();
    assert.deepEqual(await markCalendarInWords(off, { file: tmpFile(), ask: async () => ({ yes: true }) }), []);
  } finally { delete process.env.JORI_CALENDAR_IN_WORDS; }
});

test("a ladder yes must quote his own words; a no needs no quote", () => {
  const state = candidates(day())[0].state;
  assert.deepEqual(validLadderAnswer(state, { went_to_event: true, quote: "For the AI conference" }), { yes: true, quote: "For the AI conference" });
  assert.equal(validLadderAnswer(state, { went_to_event: true, quote: "I attended the Future of AI summit" }), null);
  assert.equal(validLadderAnswer(state, { went_to_event: true, quote: "" }), null);
  assert.deepEqual(validLadderAnswer(state, { went_to_event: false }), { yes: false, quote: null });
  assert.equal(validLadderAnswer(state, { went_to_event: "yes" }), null);
});

test("an event with a place of its own is never matched by his words, even if stamped", () => {
  const s = { calendar_event: { ...AI, location: "Expo Seaside City", in_his_words: { quote: "x" } },
    provenance: { tier: "CONFIRMED", confirmed_name: "Hilton Seaside City" } };
  assert.equal(calendarCorroborated(s), false);
});

// ---- the trip to a stop (markCalendarTrips) ----
// A place-less "Drive to the airport", 5:15-6:00, sat on the lodging stop the user
// left at 5:40 (it overlapped only that one) and was listed under "Events not
// matched to a location" right below the 6:00 airport stop it led to. Code picks
// the question by timing; whether the entry is the way there is a model's reading
// (Rule #0b), injected here.
const { tripCandidates, markCalendarTrips } = await import("../lib/calendar-in-words.mjs");
const T = (hhmm) => Date.parse(`2026-10-21T${hhmm}:00+03:00`);
const DRIVE = { summary: "Drive to the airport", location: "", physical: "", location_match: false,
  start: "2026-10-21T05:15:00+03:00", end: "2026-10-21T06:00:00+03:00", duration_min: 45, event_share: 0.13 };
const tripDay = () => ({ date: "2026-10-21", tz: "Asia/Jerusalem", unmatched_calendar_events: [], stops: [
  { id: "s-1", start: "05:14", end: "05:40", start_ts_ms: T("05:14"), end_ts_ms: T("05:40"),
    place: { name: "The Old Port Airbnb" }, calendar_event: { ...DRIVE },
    provenance: { tier: "CONFIRMED", confirmed_name: "The Old Port Airbnb" } },
  { id: "s-2", start: "06:01", end: "06:16", start_ts_ms: T("06:01"), end_ts_ms: T("06:16"),
    place: { name: "Seaside City Airport" }, calendar_event: null,
    provenance: { tier: "CONFIRMED", confirmed_name: "Seaside City Airport" } },
  { id: "s-3", start: "06:44", end: "12:21", start_ts_ms: T("06:44"), end_ts_ms: T("12:21"),
    place: { name: "The Old Port Airbnb" }, calendar_event: null,
    provenance: { tier: "CONFIRMED", confirmed_name: "The Old Port Airbnb" } },
] });

test("trip: an event under way when the user set off and ending at the arrival is asked about, for that stop only", () => {
  const c = tripCandidates(tripDay());
  assert.deepEqual(c.map((x) => x.stop_id), ["s-2"]);
  assert.deepEqual(c[0].state, {
    event: { title: "Drive to the airport", from: "05:15", to: "06:00" },
    left: { place: "The Old Port Airbnb", at: "05:40" },
    arrived: { place: "Seaside City Airport", from: "06:01", to: "06:16" },
  });
});

test("trip: no question for an event over before leaving, starting after arriving, with a place, or for an unnamed stop", () => {
  const over = tripDay(); over.stops[0].calendar_event = { ...DRIVE, start: "2026-10-21T05:00:00+03:00", end: "2026-10-21T05:30:00+03:00" };
  assert.deepEqual(tripCandidates(over), []);
  const after = tripDay(); after.stops[0].calendar_event = null;
  after.unmatched_calendar_events = [{ ...DRIVE, start: "2026-10-21T06:05:00+03:00", end: "2026-10-21T06:15:00+03:00" }];
  assert.deepEqual(tripCandidates(after), []);
  const placed = tripDay(); placed.stops[0].calendar_event = { ...DRIVE, location: "Terminal 3" };
  assert.deepEqual(tripCandidates(placed), []);
  const unnamed = tripDay(); unnamed.stops[1].provenance = { tier: "GUESS" };
  assert.deepEqual(tripCandidates(unnamed), []);
  const far = tripDay(); far.stops[1].start_ts_ms = T("06:20");
  assert.deepEqual(tripCandidates(far), [], "ends 20 minutes before the arrival");
});

test("trip: a yes stamps every copy and the event leaves 'Events not matched', without corroborating the stop left", async () => {
  const d = tripDay(), file = tmpFile();
  d.unmatched_calendar_events = [{ ...DRIVE }];
  assert.deepEqual(eventsNotMatched(d).map((e) => e.summary), ["Drive to the airport"]);
  let calls = 0;
  const ask = async () => { calls += 1; return { yes: true, by: "sonnet" }; };
  const out = await markCalendarTrips(d, { file, ask });
  assert.deepEqual(out.map((o) => [o.stop_id, o.yes, o.cached]), [["s-2", true, false]]);
  const stamp = { stop_id: "s-2", place: "Seaside City Airport", by: "sonnet" };
  assert.deepEqual(d.stops[0].calendar_event.trip_to, stamp);
  assert.deepEqual(d.unmatched_calendar_events[0].trip_to, stamp);
  assert.equal(calendarCorroborated(d.stops[0]), false, "the lodging is not where the drive happened");
  assert.deepEqual(eventsNotMatched(d), []);
  const again = tripDay();
  const out2 = await markCalendarTrips(again, { file, ask });
  assert.equal(calls, 1, "asked once; a re-prep reads the answer back");
  assert.equal(out2[0].cached, true);
  assert.ok(again.stops[0].calendar_event.trip_to);
});

test("trip: a no (a call taken on the way), a failed model or the kill switch leave it listed", async () => {
  const no = tripDay();
  no.stops[0].calendar_event = { ...DRIVE, summary: "Call with Alex" };
  await markCalendarTrips(no, { file: tmpFile(), ask: async () => ({ yes: false, by: "sonnet" }) });
  assert.equal(no.stops[0].calendar_event.trip_to, undefined);
  assert.deepEqual(eventsNotMatched(no).map((e) => e.summary), ["Call with Alex"]);
  const fail = tripDay();
  assert.deepEqual(await markCalendarTrips(fail, { file: tmpFile(), ask: async () => { throw new Error("not_logged_in"); } }), []);
  assert.equal(fail.stops[0].calendar_event.trip_to, undefined);
  process.env.JORI_CALENDAR_TRIP = "0";
  try {
    const off = tripDay();
    assert.deepEqual(await markCalendarTrips(off, { file: tmpFile(), ask: async () => ({ yes: true }) }), []);
    assert.equal(off.stops[0].calendar_event.trip_to, undefined);
  } finally { delete process.env.JORI_CALENDAR_TRIP; }
});
