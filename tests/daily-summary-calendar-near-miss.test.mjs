// daily-summary-calendar-near-miss.test.mjs — a place-less calendar event that
// missed every stop by minutes is the stop the person it names joined the user at.
//
// 2026-10-22: "Pick up Alex" was on the calendar 17:30-18:00 (the flight landed at
// 17:25); the pickup the user described ("Picking up Alex at the airport now", 6:09pm) was
// 18:06-18:12, and the summary listed the event as "not matched to a location"
// right beside that stop. The flat stop ending 17:28, two minutes before the event,
// is nearer in time and must not take it: Alex was not there.
//
// Run: node --test tests/daily-summary-calendar-near-miss.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const render = require(path.join(ROOT, "lib/daily-summary-render.js"));
const { attachNearMissEvents } = render;
const { calendarCorroborated, eventsNotMatched } = render._internal;

const T = (hm) => Date.parse(`2026-10-22T${hm}:00+03:00`);
const stop = (id, from, to, companions) => ({ id, start_ts_ms: T(from), end_ts_ms: T(to), companions, calendar_event: null });
const ev = (summary, from, to, location = null) => ({ summary, location,
  start: `2026-10-22T${from}:00+03:00`, end: `2026-10-22T${to}:00+03:00`, duration_min: 30, physical: false });

const day = () => ({
  date: "2026-10-22",
  stops: [
    stop("s-flat", "14:36", "17:28", ["Sam"]),
    stop("s-airport", "18:06", "18:12", ["Sam", "Alex", "Rover"]),
    stop("s-nana", "18:47", "21:45", ["Nana", "Alex", "Sam", "Rover", "Noa"]),
  ],
  unmatched_calendar_events: [
    ev("Alex's flight LY348 ZRH → AAB", "13:30", "17:25"),
    ev("Pick up Alex", "17:30", "18:00"),
  ],
});

test("Pick up Alex goes on the airport stop, where Alex joined, not the flat two minutes away", () => {
  const d = day();
  const out = attachNearMissEvents(d);
  assert.deepEqual(out, [{ stop_id: "s-airport", event: "Pick up Alex", near_miss_min: 6 }]);
  const airport = d.stops[1];
  assert.equal(airport.calendar_event.summary, "Pick up Alex");
  assert.equal(d.stops[0].calendar_event, null);
  assert.ok(calendarCorroborated(airport));
  assert.deepEqual(eventsNotMatched(d).map((e) => e.summary), ["Alex's flight LY348 ZRH → AAB"]);
});

test("the flight stays not matched: a stop overlaps it, so it is left alone", () => {
  const d = day();
  d.unmatched_calendar_events = [ev("Alex's flight LY348 ZRH → AAB", "13:30", "17:25")];
  assert.deepEqual(attachNearMissEvents(d), []);
  assert.equal(d.unmatched_calendar_events.length, 1);
});

test("an event naming someone already with him cannot land on the next stop", () => {
  const d = { date: "2026-10-22",
    stops: [stop("a", "17:00", "18:55", ["Sam"]), stop("b", "19:05", "20:00", ["Sam"])],
    unmatched_calendar_events: [ev("Dinner with Sam", "18:56", "19:04")] };
  // overlaps no stop, 1 minute from both, but Sam joined the user at neither
  assert.deepEqual(attachNearMissEvents(d), []);
  assert.deepEqual(eventsNotMatched(d).map((e) => e.summary), ["Dinner with Sam"]);
});

test("a placed event, or one further than 15 minutes off, is not attached", () => {
  const d = day();
  d.unmatched_calendar_events = [ev("Pick up Alex", "17:30", "18:00", "Ben Gurion Airport"),
                                 ev("Meet Alex", "17:00", "17:20")];
  d.stops[0].end_ts_ms = T("16:30");
  assert.deepEqual(attachNearMissEvents(d), []);
});

test("JORI_CAL_NEAR_MISS=0 leaves the day as it was", () => {
  process.env.JORI_CAL_NEAR_MISS = "0";
  try {
    const d = day();
    assert.deepEqual(attachNearMissEvents(d), []);
    assert.equal(d.unmatched_calendar_events.length, 2);
  } finally { delete process.env.JORI_CAL_NEAR_MISS; }
});

test("the real shape: the event rode on the pieces of a cut stop, none of which overlap it", () => {
  const d = day();
  d.unmatched_calendar_events = [];
  const stale = { ...ev("Pick up Alex", "17:30", "18:00", ""), event_share: 0.199, duration_min: 30 };
  d.stops.unshift(stop("s-shafa", "14:12", "14:36", ["Sam"]));
  d.stops[0].calendar_event = { ...stale };
  d.stops[1].calendar_event = { ...stale };       // the flat piece, 14:36-17:28
  const out = attachNearMissEvents(d);
  assert.deepEqual(out, [{ stop_id: "s-airport", event: "Pick up Alex", near_miss_min: 6 }]);
  assert.equal(d.stops[0].calendar_event, null);
  assert.equal(d.stops[1].calendar_event, null);
  assert.deepEqual(eventsNotMatched(d).map((e) => e.summary), []);
});

test("a stale event no stop can take is listed once as not matched", () => {
  const d = { date: "2026-10-22", stops: [stop("x", "10:00", "11:00", ["Sam"]), stop("y", "11:00", "12:00", ["Sam"])],
    unmatched_calendar_events: [] };
  const stale = { ...ev("Dentist", "15:00", "16:00"), event_share: 0.5, duration_min: 60 };
  d.stops[0].calendar_event = { ...stale };
  d.stops[1].calendar_event = { ...stale };
  assert.deepEqual(attachNearMissEvents(d), []);
  assert.deepEqual(eventsNotMatched(d).map((e) => e.summary), ["Dentist"]);
});
