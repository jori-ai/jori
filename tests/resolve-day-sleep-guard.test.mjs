// resolve-day-sleep-guard.test.mjs — a venue stop is not stretched back through
// the time the Watch had him asleep.
//
// The incident: the 2026-10-14 summary opened "7:00am · Café Corvina" for a man
// the Watch had asleep until 07:29 (Mason: "I woke up at 7:30am and you're
// telling me I was at the coffee shop at 7am? How is this possible?"). The
// first fix at the café was 07:34 and the cluster began 07:38. Three passes each
// pulled that start back: widenToBackingVisits (to the overnight visit row, which
// iOS had filed 8 m from the café and the day's window had clipped to 00:00 ET),
// addSpineDwells (to the same dwell), and extendThroughSilence (to a night-time
// ping at the flat, 93 m away). All three now stop at the wake.
//
// Run: node --test tests/resolve-day-sleep-guard.test.mjs

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
const { widenToBackingVisits, addSpineDwells, extendThroughSilence, widensThroughSleep } = _internal;

const MIN = 60_000;
// 2026-10-14, Israel (UTC+3). The day window opens at 00:00 ET = 04:00Z = 07:00 IDT.
const WINDOW_START = Date.parse("2026-10-14T04:00:00Z");
const WAKE = Date.parse("2026-10-14T04:29:00Z");          // 07:29 IDT, from the Watch
const CLUSTER_START = Date.parse("2026-10-14T04:38:00Z"); // 07:38 IDT, first stop cluster
const LEAVE = Date.parse("2026-10-14T05:09:00Z");         // 08:09 IDT
const CAFE = { ...LL(0.0, 0.0) };
const asleep = { from_ms: Date.parse("2026-10-13T22:26:00Z"), to_ms: WAKE };

function stop(source, over = {}) {
  return {
    id: "s-1", start: "07:38", end: "08:09", start_ts_ms: CLUSTER_START, end_ts_ms: LEAVE,
    duration_min: 31, lat: CAFE.lat, lon: CAFE.lon,
    place: { name: "Café Corvina", source, confidence: 0.95 }, ...over,
  };
}

// The overnight visit as day-path hands it over: filed 8 m from the café,
// start clipped to the window's opening.
const overnight = { start_ms: WINDOW_START, end_ms: LEAVE, ...LL(-4.83, 6.94) };

test("widensThroughSleep: only a stop that begins after the wake, stretched back before it", () => {
  const venue = stop("confirmed_stop");
  assert.equal(widensThroughSleep(venue, WINDOW_START, asleep), true);
  assert.equal(widensThroughSleep(venue, WAKE + 3 * MIN, asleep), false, "a stretch that stays after the wake is fine");
  assert.equal(widensThroughSleep(venue, WINDOW_START, null), false, "no Watch night: the guard is off");
  const early = stop("confirmed_stop", { start_ts_ms: WAKE - 20 * MIN });
  assert.equal(widensThroughSleep(early, WINDOW_START, asleep), false, "a stop the fixes already put in the night is left alone");
});

test("widensThroughSleep: his own answer, his homes and the lodging base are exempt", () => {
  for (const source of ["user_confirmed", "named_location", "known_recurring", "accommodation"]) {
    assert.equal(widensThroughSleep(stop(source), WINDOW_START, asleep), false, source);
  }
  assert.equal(widensThroughSleep(stop("confirmed_stop", { accommodation: { name: "our Airbnb" } }), WINDOW_START, asleep), false);
});

test("widensThroughSleep: a name the app gave on arrival (a `named` row) is not exempt (2026-10-19)", () => {
  const geofence = stop("user_confirmed", { confirmed_row: { id: "r", name: "Café Corvina", place_type: "named" } });
  assert.equal(widensThroughSleep(geofence, WINDOW_START, asleep), true);
  const answer = stop("user_confirmed", { confirmed_row: { id: "r", name: "Café Corvina", place_type: "user-confirmed" } });
  assert.equal(widensThroughSleep(answer, WINDOW_START, asleep), false, "his answer stays exempt");
  const stops = [geofence];
  const held = [];
  widenToBackingVisits(stops, { visits: [overnight] }, asleep, held);
  assert.equal(stops[0].start_ts_ms, CLUSTER_START, "held at its own start, not the night's");
  assert.equal(held.length, 1);
});

test("widensThroughSleep: his answer about a visit that began after he woke is not exempt (2026-10-24)", () => {
  // "Brenna" named the 08:49 bakery rows; the dwell ran from midnight at the flat.
  const later = stop("user_confirmed", { confirmed_row: { id: "r", name: "Brenna", place_type: "user-confirmed",
    start_ms: CLUSTER_START, end_ms: LEAVE } });
  assert.equal(widensThroughSleep(later, WINDOW_START, asleep), true);
  const stops = [later];
  const held = [];
  widenToBackingVisits(stops, { visits: [overnight] }, asleep, held);
  assert.equal(stops[0].start_ts_ms, CLUSTER_START, "held at its own start, not midnight");
  assert.equal(held.length, 1);
  // His answer for a row that began in the night still holds through it.
  const overnightAnswer = stop("user_confirmed", { confirmed_row: { id: "r", name: "The Harbor Flat",
    place_type: "user-confirmed", start_ms: WINDOW_START, end_ms: LEAVE } });
  assert.equal(widensThroughSleep(overnightAnswer, WINDOW_START, asleep), false);
  // A window he named (location-confirm save-at) holds too: Café Corvina 07:56-08:47 ran back to 03:56.
  const savedAt = stop("user_confirmed", { from_saved_at: "lc-at-20261024-011642", from_confirmed_visit: true });
  assert.equal(widensThroughSleep(savedAt, WINDOW_START, asleep), true);
  const night = [{ ts: Date.parse("2026-10-14T00:38:00Z"), ...LL(90.35, 23.51), accuracy_m: 20 }];
  extendThroughSilence([savedAt], night, asleep);
  assert.equal(savedAt.start_ts_ms, CLUSTER_START, "still his window's start, not the night fix at the flat");
  const control = stop("user_confirmed", { from_saved_at: "lc-at-x", from_confirmed_visit: true });
  extendThroughSilence([control], night, null);
  assert.ok(control.start_ts_ms < CLUSTER_START, "control: the unguarded pass does extend");
});

test("widenToBackingVisits holds a proximity-named venue at its own start", () => {
  const stops = [stop("confirmed_stop")];
  const held = [];
  widenToBackingVisits(stops, { visits: [overnight] }, asleep, held);
  assert.equal(stops[0].start_ts_ms, CLUSTER_START, "still 07:38, not the window's 07:00");
  assert.equal(held.length, 1);
  assert.equal(held[0].woke, _internal.hmFromMs(WAKE));
});

test("widenToBackingVisits still widens the END of a held stop, and a stop he named himself", () => {
  const venue = [stop("confirmed_stop", { end_ts_ms: LEAVE - 10 * MIN })];
  widenToBackingVisits(venue, { visits: [overnight] }, asleep, []);
  assert.equal(venue[0].end_ts_ms, LEAVE, "the end is not what the Watch contradicts");

  const answered = [stop("user_confirmed")];
  widenToBackingVisits(answered, { visits: [overnight] }, asleep, []);
  assert.equal(answered[0].start_ts_ms, WINDOW_START, "his own answer about the window is not second-guessed");
});

test("widenToBackingVisits is unchanged with no Watch night (the old behaviour)", () => {
  const stops = [stop("confirmed_stop")];
  widenToBackingVisits(stops, { visits: [overnight] });
  assert.equal(stops[0].start_ts_ms, WINDOW_START);
});

test("addSpineDwells does not widen a held venue to the dwell's clipped start", () => {
  const stops = [stop("confirmed_stop")];
  const spine = [{ type: "dwell", id: "d0", major: true, start_ms: WINDOW_START, end_ms: LEAVE,
                   place: { name: "Café Corvina", tier: "corroborated", lat: CAFE.lat, lon: CAFE.lon }, witnessed_min: 584 }];
  const held = [];
  addSpineDwells(stops, { spine }, asleep, held);
  assert.equal(stops[0].start_ts_ms, CLUSTER_START);
  assert.equal(held.at(-1).by, "spine");
});

test("extendThroughSilence does not pull a held venue back to a night ping at the flat", () => {
  const nightPing = Date.parse("2026-10-14T00:38:00Z");   // 03:38 IDT, the phone woke at the flat
  const pings = [{ ts: nightPing, ...LL(90.35, 23.51), accuracy_m: 20 }];
  const stops = [stop("confirmed_stop")];
  extendThroughSilence(stops, pings, asleep);
  assert.equal(stops[0].start_ts_ms, CLUSTER_START);
  // and without the Watch night it would have been extended: the guard is what holds it
  const unguarded = [stop("confirmed_stop")];
  extendThroughSilence(unguarded, pings, null);
  assert.ok(unguarded[0].start_ts_ms < CLUSTER_START, "control: the unguarded pass does extend");
});
