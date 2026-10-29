// resolve-day-follow-up-floor.test.mjs — the follow-up list (unknown_stops[])
// obeys the under-10-minutes-isn't-a-stop rule even when a stop only fell
// under the floor AFTER dropShortStops ran (reconcileStopTimeline trims later).
//
// The case: the 2026-10-06 daily summary's only follow-up was a 13:28-13:31
// "stop" 4 m from the Airbnb, trimmed from 12 minutes by reconcile to make
// room for the walk to lunch. Its pointer asked "was that just stepping out?".
//
// Run: node --test tests/resolve-day-follow-up-floor.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { at as fakeAt } from "./fixtures/fake-geo.mjs";
// Synthetic places (tests/fixtures/fake-geo.mjs): `e` metres east and `n` north
// of an obviously fake origin, keeping the real day's geometry.
const LL = (e, n, suf = "") => { const p = fakeAt(e, n); return { [`lat${suf}`]: p.lat, [`lon${suf}`]: p.lon }; };
const LLR = (e, n) => { const p = fakeAt(e, n); return { latitude: p.lat, longitude: p.lon }; };
const LLG = (e, n) => { const p = fakeAt(e, n); return { lat: p.lat, lng: p.lon }; };

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { _internal } = require(path.join(ROOT, "lib/resolve-day.js"));
const { askableStops, SHORT_STOP_MIN } = _internal;

const ms = (hhmm) => Date.parse(`2026-10-06T${hhmm}:00+03:00`);
const stop = (id, start, end, extra = {}) => ({
  id, start, end, start_ts_ms: ms(start), end_ts_ms: ms(end),
  duration_min: Math.round((ms(end) - ms(start)) / 60_000),
  place: { name: null, source: "unknown", confidence: 0 }, ...extra,
});
const ids = (list) => list.map(s => s.id);

test("the floor is the drop's own constant", () => {
  assert.equal(SHORT_STOP_MIN, 10);
});

test("2026-10-06: a 3-minute edge of the Airbnb stay is not a question", () => {
  const stops = [
    stop("s-1", "09:37", "13:28", { ...LL(0.0, 0.0) }),
    stop("s-2", "13:28", "13:31", { ...LL(-3.77, 3.61), timeline_reconciled: true }),
    stop("s-3", "13:39", "14:51", { place: { name: "Al-Example", source: "user_confirmed", confidence: 1 } }),
  ];
  assert.deepEqual(ids(askableStops(stops)), ["s-1", "s-3"]);
});

test("touching short fragments are judged as the run they make", () => {
  // 2026-10-04: two 8-minute pieces a minute apart are one 17-minute pause.
  const stops = [stop("a", "18:26", "18:34"), stop("b", "18:35", "18:43")];
  assert.deepEqual(ids(askableStops(stops)), ["a", "b"]);
});

test("a run that is still under the floor goes", () => {
  const stops = [stop("a", "12:00", "12:03"), stop("b", "12:04", "12:07"), stop("c", "13:00", "13:45")];
  assert.deepEqual(ids(askableStops(stops)), ["c"]);
});

test("short fragments further apart than the touch window are judged alone", () => {
  const stops = [stop("a", "12:00", "12:07"), stop("b", "12:10", "12:17")];
  assert.deepEqual(ids(askableStops(stops)), []);
});

test("a known name or an iOS visit row keeps a short stop askable", () => {
  const stops = [
    stop("named", "10:00", "10:06", { place: { name: "Espresso bar", source: "user_confirmed", confidence: 1 } }),
    stop("visit", "11:00", "11:07", { backed_by_visit: true }),
    stop("bare", "12:00", "12:07"),
  ];
  assert.deepEqual(ids(askableStops(stops)), ["named", "visit"]);
});

test("ten minutes or more is untouched", () => {
  const stops = [stop("a", "12:00", "12:10"), stop("b", "15:00", "15:45")];
  assert.deepEqual(ids(askableStops(stops)), ["a", "b"]);
});

test("missing timestamps fail open, a recorded short duration still counts", () => {
  const noTs = { id: "x", start: "12:00", end: "12:30", place: { name: null, confidence: 0 } };
  const shortNoTs = { id: "y", start: "13:00", end: "13:03", duration_min: 3, place: { name: null, confidence: 0 } };
  assert.deepEqual(ids(askableStops([noTs, shortNoTs])), ["x"]);
});

test("input order is preserved", () => {
  const stops = [stop("late", "15:00", "15:45"), stop("early", "09:00", "09:40")];
  assert.deepEqual(ids(askableStops(stops)), ["late", "early"]);
});
