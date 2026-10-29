// daily-summary-calendar-unmatched.test.mjs — every calendar event appears.
//
// 2026-10-20: "Pool guys in Villa Example", 5-8pm, overlapped three stops in
// Old Port. It attached to one by time, its place matched nothing (so the stop never
// prints it, by design), and it was not in unmatched_calendar_events either, so
// it was in no part of the summary. An event with no location was also labelled
// "(virtual)", which nothing said.
//
// Run: node --test tests/daily-summary-calendar-unmatched.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const render = require(path.join(ROOT, "lib/daily-summary-render.js"));
const { eventsNotMatched, eventWhere } = render._internal;

const POOL = { summary: "Pool guys in Villa Example", location: "", physical: "", location_match: false,
  start: "2026-10-20T17:00:00+03:00", end: "2026-10-20T20:00:00+03:00", duration_min: 180, event_share: 0.27 };
const DINNER = { summary: "Dinner at Bistro Example", location: "Bistro Example, Old Port", physical: true, location_match: true,
  start: "2026-10-20T20:00:00+03:00", end: "2026-10-20T21:00:00+03:00", duration_min: 60, event_share: 1 };
const QUINN = { summary: "Quinn <> User", location: "https://zoom.us/j/1", physical: false,
  start: "2026-10-20T23:00:00+03:00", end: "2026-10-20T23:30:00+03:00", duration_min: 30 };
const TOMORROW = { summary: "Future of AI 2026 conference", location: null, physical: null,
  start: "2026-10-21T08:00:00+03:00", end: "2026-10-21T16:00:00+03:00", duration_min: 480 };
const stop = (id, title, cal) => ({ id, calendar_event: cal,
  provenance: { tier: "CONFIRMED", confirmed_name: title, display_name: title } });

test("an event a stop overlapped but did not match is listed, once, in time order", () => {
  const day = { date: "2026-10-20",
    stops: [stop("a", "Visiting Nana", POOL), stop("b", "The Old Port Airbnb", POOL), stop("c", "Bistro Example", DINNER)],
    unmatched_calendar_events: [QUINN, TOMORROW] };
  assert.deepEqual(eventsNotMatched(day).map(e => e.summary), ["Pool guys in Villa Example", "Quinn <> User"]);
});

test("an event that corroborates a stop is that stop, not an unmatched event", () => {
  const day = { date: "2026-10-20", stops: [stop("c", "Bistro Example", DINNER), stop("d", "The Old Port Airbnb", DINNER)],
    unmatched_calendar_events: [] };
  assert.deepEqual(eventsNotMatched(day), []);
});

test("an all-day event is not listed with clock times", () => {
  const day = { date: "2026-10-20", unmatched_calendar_events: [],
    stops: [stop("a", "The Old Port Airbnb", { ...POOL, summary: "Stay at the Old Port flat", start: "2026-10-20", end: "2026-10-21" })] };
  assert.deepEqual(eventsNotMatched(day), []);
});

test("where: a place, a link is virtual, no location says nothing", () => {
  assert.equal(eventWhere(DINNER), "Bistro Example, Old Port");
  assert.equal(eventWhere(QUINN), "(virtual)");
  assert.equal(eventWhere(POOL), "");
  assert.equal(eventWhere(TOMORROW), "");
});

// 2026-10-21: the user confirmed Dana and Lior were at the Bistro Example dinner, the stop
// carried them, and "Dana and Lior" 8-9pm was still listed as not matched.
const RANI = { summary: "Dana and Lior", location: "", physical: "", location_match: false,
  start: "2026-10-20T20:00:00+03:00", end: "2026-10-20T21:00:00+03:00", duration_min: 60, event_share: 1 };
const withPeople = (s, companions) => ({ ...s, companions });

test("an event with no location that names people on the stop is that stop", () => {
  const day = { date: "2026-10-20", unmatched_calendar_events: [QUINN],
    stops: [withPeople(stop("c", "Bistro Example", RANI), ["Sam", "Dana", "Lior"])] };
  assert.deepEqual(eventsNotMatched(day).map(e => e.summary), ["Quinn <> User"]);
});

test("the same event stays unmatched when the stop does not carry those people", () => {
  const day = { date: "2026-10-20", unmatched_calendar_events: [],
    stops: [withPeople(stop("c", "Bistro Example", RANI), ["Sam"])] };
  assert.deepEqual(eventsNotMatched(day).map(e => e.summary), ["Dana and Lior"]);
});

test("people never match an event placed somewhere else, or one the stop barely touched", () => {
  const elsewhere = { ...RANI, location: "Seaside City Port" };
  const sliver = { ...RANI, event_share: 0.1 };
  const day = { date: "2026-10-20", unmatched_calendar_events: [],
    stops: [withPeople(stop("c", "Bistro Example", elsewhere), ["Dana", "Lior"]),
      withPeople(stop("d", "The Old Port Airbnb", { ...sliver, summary: "Dana and Lior again" }), ["Dana", "Lior"])] };
  assert.deepEqual(eventsNotMatched(day).map(e => e.summary), ["Dana and Lior", "Dana and Lior again"]);
});

test("the manifest splits events the same way the email does", () => {
  const day = { date: "2026-10-20", stops: [
      { id: "s-3", start: "16:19", end: "18:02", place: { name: "Visiting Nana", source: "user_confirmed" },
        provenance: { tier: "CONFIRMED", confirmed_name: "Visiting Nana" }, calendar_event: POOL, photos: [] },
      { id: "s-6", start: "20:06", end: "22:09", place: { name: "Bistro Example", source: "user_confirmed" },
        provenance: { tier: "CONFIRMED", confirmed_name: "Bistro Example" }, calendar_event: DINNER, photos: [] }],
    unmatched_calendar_events: [QUINN, TOMORROW] };
  const m = render.buildManifest(day, {});
  assert.equal(m.stops.find(s => s.id === "s-3").calendar_event, null, "an overlap is not this stop's event");
  assert.equal(m.stops.find(s => s.id === "s-6").calendar_event.corroborated, true);
  assert.deepEqual(m.unmatched_calendar_events.map(e => e.summary), ["Pool guys in Villa Example", "Quinn <> User"]);
});

// 2026-10-28: an hour-long block at a polling place, a 24-minute stop at that place
// inside it (36% of the event). The share test is for a stop elsewhere that only
// overlaps the hours, so at the event's own place a quarter of it is enough; a
// sliver at the place, or the same share somewhere else, still is not.
test("a shorter stop at the event's own place is that event; a sliver there, or elsewhere, is not", () => {
  const VOTE = { summary: "Vote", location: "The school, 9 Main St", physical: true, location_match: true,
    start: "2026-10-27T15:00:00+02:00", end: "2026-10-27T16:00:00+02:00", duration_min: 60, event_share: 0.36 };
  const at = (cal) => ({ date: "2026-10-27", unmatched_calendar_events: [], stops: [stop("s5", "The school", cal)] });
  assert.deepEqual(eventsNotMatched(at(VOTE)), []);
  assert.equal(render._internal.calendarCorroborated(at(VOTE).stops[0]), true);
  assert.deepEqual(eventsNotMatched(at({ ...VOTE, event_share: 0.1 })).map(e => e.summary), ["Vote"]);
  assert.deepEqual(eventsNotMatched(at({ ...VOTE, location_match: false })).map(e => e.summary), ["Vote"]);
});

// One summary printed one Zoom meeting twice (the call
// line, and its invite under "Events not matched"), listed one guest twice
// ("Lena Example and Lena", one person who rejoined under a second name),
// showed a flight as "9:05am-3:42am" (its end is the next day), and timed a
// 0.3-mile walk at 4 min (the gap between two stop edges, not the walk).
const { callCoversEvent, eventClock, movementHtml } = render._internal;

const INVITE = { summary: "AI meeting: Dan + Lena + User", location: null, physical: "",
  start: "2026-10-28T09:30:00+02:00", end: "2026-10-28T10:30:00+02:00", duration_min: 60 };
const ZOOM = { who: "Dan Example and Lena Example", source: "zoom", status: "held",
  start: "2026-10-28T07:32:54Z", end: "2026-10-28T08:34:05Z", evidence: { call_log: true } };
const FLIGHT = { summary: "Noa & Alex depart Seaside City (EL AL)", location: null, physical: "",
  start: "2026-10-28T09:05:00+02:00", end: "2026-10-29T03:42:00+02:00", duration_min: 1117 };

test("a Zoom call from the call log takes its own invite out of the unmatched list", () => {
  const day = { date: "2026-10-28", stops: [], calls: [ZOOM], unmatched_calendar_events: [INVITE, FLIGHT] };
  assert.deepEqual(eventsNotMatched(day).map((e) => e.summary), [FLIGHT.summary]);
});

test("a call does not claim a physical event, one starting far off, or one it barely covers", () => {
  assert.equal(callCoversEvent(ZOOM, { ...INVITE, physical: true }), false);
  assert.equal(callCoversEvent(ZOOM, { ...INVITE, start: "2026-10-28T08:40:00+02:00", end: "2026-10-28T10:40:00+02:00" }), false);
  assert.equal(callCoversEvent(ZOOM, { ...INVITE, start: "2026-10-28T09:30:00+02:00", end: "2026-10-28T13:30:00+02:00" }), false);
  assert.equal(callCoversEvent({ ...ZOOM, calendar: { summary: "x", start: INVITE.start } }, INVITE), false);
  assert.equal(callCoversEvent(ZOOM, INVITE), true);
});

test("an event that ends on a later date shows its start only", () => {
  assert.deepEqual(eventClock(FLIGHT, "Asia/Jerusalem"), { t0: "09:05", t1: "" });
  assert.deepEqual(eventClock(FLIGHT, null), { t0: "09:05", t1: "" });
  assert.deepEqual(eventClock(INVITE, "Asia/Jerusalem"), { t0: "09:30", t1: "10:30" });
});

const U = (hms) => Date.parse(`2026-10-28T${hms}Z`);
const text = (html) => html.replace(/<[^>]+>/g, "");
const flat = { id: "s-a", end: "19:40", end_ts_ms: U("17:40:00"), tz: "Asia/Jerusalem" };
const cafe = { id: "s-b", start: "19:44", start_ts_ms: U("17:44:00"), tz: "Asia/Jerusalem" };
const day = (m) => ({ date: "2026-10-28", tz: "Asia/Jerusalem", path: { spine: [], segments: [
  { start_ms: U("17:40:30"), end_ms: U("17:43:30"), streets: ["Rabbi Tanhum", "Amiad"], legs: [{ t0: U("17:40:30"), t1: U("17:43:30"), m }] }] } });

test("a walk too fast for its minutes keeps its distance and drops the duration", () => {
  const line = text(movementHtml(day(480), flat, cafe));
  assert.match(line, /Walked (at least )?0\.3 miles around Rabbi Tanhum and Amiad\./);
  assert.doesNotMatch(line, /about/);
});

test("a walk at a walking pace keeps its duration", () => {
  const line = text(movementHtml(day(300), flat, cafe));
  assert.match(line, /Walked (at least )?0\.2 miles around Rabbi Tanhum and Amiad, about 4 min\./);
});
