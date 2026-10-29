// resolve-day-israel-window.test.mjs — what changes when an Israel day is cut at
// local midnight instead of home midnight.
//
// 2026-10-15. Every Israel day had been cut at 00:00 ET = 07:00 in Portside, so the
// night never reached the raw stops and the Oct 14 summary opened "7:00am ·
// Café Corvina" with the Watch asleep until 07:29. Cutting the day where it
// really starts puts the whole night in the window, and three things have to
// hold for that to be an improvement:
//   1. a venue stop cannot begin before he woke, even when its raw cluster
//      already starts at the window's edge (the flat is 93 m from the café, so
//      the night's cluster is named for the café);
//   2. location-segment gets the same window as everything else (bare dates are
//      home-zone days to it), so a stop after midnight does not leak in;
//   3. an unnamed stop that is the only one at a dwell the spine names takes
//      that name.
//
// Run: node --test tests/resolve-day-israel-window.test.mjs

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
// The fixtures are a home-zone (US Eastern) day; pin the home zone so a host in
// another zone, or a fresh install, reads them the same.
process.env.JORI_TZ = "America/New_York";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { _internal } = require(path.join(ROOT, "lib/resolve-day.js"));
const { holdStartsAtWake, placesSleptAt, nameDayEndFromNight, addSpineDwells, nameBareStopFromDwell, etBoundaryUtcIso, hmFromMs } = _internal;

const MIN = 60_000;
const iso = (s) => Date.parse(s);
// 2026-10-14, Israel (UTC+3). The Israel day opens at 21:00Z the evening before.
const WINDOW_START = iso("2026-10-13T21:00:00Z");
const ONSET = iso("2026-10-13T22:26:00Z");   // 01:26 IDT, the Watch
const WAKE = iso("2026-10-14T04:29:00Z");    // 07:29 IDT, the Watch
const LEAVE = iso("2026-10-14T05:05:00Z");   // 08:05 IDT
const CAFE = { ...LL(0.0, 0.0) };
const asleep = { from_ms: ONSET, to_ms: WAKE };

function overnightCluster(source, over = {}) {
  return {
    id: "s-1", start: "00:00", end: "08:05", start_ts_ms: WINDOW_START, end_ts_ms: LEAVE,
    duration_min: 485, lat: CAFE.lat, lon: CAFE.lon,
    place: { name: "Café Corvina", source, confidence: 0.95 }, ...over,
  };
}
const ping = (ts, lat = CAFE.lat, lon = CAFE.lon) => ({ ts, lat, lon, acc: 10 });

test("etBoundaryUtcIso cuts an Israel day at Israel midnight", () => {
  assert.equal(etBoundaryUtcIso("2026-10-14", "Asia/Jerusalem"), "2026-10-13T21:00:00.000Z");
  assert.equal(etBoundaryUtcIso("2026-10-14", "America/New_York"), "2026-10-14T04:00:00.000Z");
});

test("the night's cluster, named for the café, begins at his first fix after he woke", () => {
  const stops = [overnightCluster("confirmed_stop")];
  const pings = [ping(iso("2026-10-14T02:10:00Z")), ping(iso("2026-10-14T04:34:00Z")), ping(iso("2026-10-14T04:50:00Z"))];
  const held = holdStartsAtWake(stops, pings, asleep);
  assert.equal(held.length, 1);
  assert.equal(stops[0].start_ts_ms, iso("2026-10-14T04:34:00Z"));
  assert.equal(stops[0].start, hmFromMs(iso("2026-10-14T04:34:00Z")), "the header string follows the new start");
  assert.equal(stops[0].start_held_at_wake, true);
  assert.equal(stops[0].duration_min, 31);
  assert.equal(held[0].was, "00:00–08:05");
  assert.equal(held[0].basis, "watch");
});

test("no fix after he woke: the stop begins at the wake itself, never before", () => {
  const stops = [overnightCluster("confirmed_stop")];
  holdStartsAtWake(stops, [ping(iso("2026-10-14T02:10:00Z"))], asleep);
  assert.equal(stops[0].start_ts_ms, WAKE);
});

test("a fix elsewhere does not count as arriving", () => {
  const stops = [overnightCluster("confirmed_stop")];
  const farAway = ping(iso("2026-10-14T04:31:00Z"), 32.09, 34.80);
  holdStartsAtWake(stops, [farAway, ping(iso("2026-10-14T04:40:00Z"))], asleep);
  assert.equal(stops[0].start_ts_ms, iso("2026-10-14T04:40:00Z"));
});

test("the places he sleeps keep their overnight block", () => {
  for (const source of ["user_confirmed", "named_location", "known_recurring", "accommodation"]) {
    const stops = [overnightCluster(source)];
    assert.deepEqual(holdStartsAtWake(stops, [], asleep), [], source);
    assert.equal(stops[0].start_ts_ms, WINDOW_START, source);
  }
  const lodging = [overnightCluster("confirmed_stop", { accommodation: { name: "our Airbnb in Portside" } })];
  assert.deepEqual(holdStartsAtWake(lodging, [], asleep), []);
  const nonStop = [overnightCluster("confirmed_stop", { user_non_stop: true })];
  assert.deepEqual(holdStartsAtWake(nonStop, [], asleep), []);
});

test("a geofence name is not his answer: a café named by its arrival row is still held (2026-10-19)", () => {
  // The Café Corvina `named` row (the app recognising the saved café as he
  // arrived, 09:10-09:54) reached the night's cluster as user_confirmed, so the
  // day opened "12:00am · Café Corvina" with the Watch asleep until 08:35.
  const named = { id: "row-cafe", name: "Café Corvina", place_type: "named",
                  start_ms: iso("2026-10-14T06:10:00Z"), end_ms: iso("2026-10-14T06:54:00Z") };
  const stops = [overnightCluster("user_confirmed", { confirmed_row: named })];
  const held = holdStartsAtWake(stops, [ping(iso("2026-10-14T04:34:00Z"))], asleep);
  assert.equal(held.length, 1);
  assert.equal(stops[0].start_ts_ms, iso("2026-10-14T04:34:00Z"));
  // his own answer (a user-confirmed row) for a row that began in the night still keeps the overnight block
  const answered = [overnightCluster("user_confirmed", { confirmed_row: { ...named, place_type: "user-confirmed", start_ms: WINDOW_START } })];
  assert.deepEqual(holdStartsAtWake(answered, [], asleep), []);
  assert.equal(answered[0].start_ts_ms, WINDOW_START);
  // ...but his answer for a visit that began after he woke says nothing about the night (2026-10-24:
  // "Brenna" for the 08:49 bakery rows opened the day "12:00am · Brenna")
  const later = [overnightCluster("user_confirmed", { confirmed_row: { ...named, place_type: "user-confirmed" } })];
  assert.equal(holdStartsAtWake(later, [ping(iso("2026-10-14T04:34:00Z"))], asleep).length, 1);
  assert.equal(later[0].start_ts_ms, iso("2026-10-14T04:34:00Z"));
});

test("a stop that ended before he woke, or barely touched the night, is left alone", () => {
  const early = [overnightCluster("confirmed_stop", { end_ts_ms: iso("2026-10-14T03:00:00Z") })];
  assert.deepEqual(holdStartsAtWake(early, [], asleep), [], "gone before he woke");
  const brief = [overnightCluster("confirmed_stop", { start_ts_ms: iso("2026-10-14T03:50:00Z") })];
  assert.deepEqual(holdStartsAtWake(brief, [], asleep), [], "under an hour of the night");
  const evening = [overnightCluster("confirmed_stop", { start_ts_ms: iso("2026-10-14T04:40:00Z"), end_ts_ms: LEAVE })];
  assert.deepEqual(holdStartsAtWake(evening, [], asleep), [], "began after he woke");
});

test("without a Watch night the phone's wake stands in, but only for a stop that spent hours before it", () => {
  const phoneWake = { from_ms: WINDOW_START, to_ms: iso("2026-10-14T04:10:00Z") };   // 07:10 IDT, 7 h into the stop
  const long = [overnightCluster("confirmed_stop")];
  assert.equal(holdStartsAtWake(long, [], phoneWake, true).length, 1);
  assert.equal(long[0].start_ts_ms, phoneWake.to_ms);
  const short = [overnightCluster("confirmed_stop", { start_ts_ms: iso("2026-10-14T02:00:00Z") })];   // 2 h before the wake
  assert.deepEqual(holdStartsAtWake(short, [], phoneWake, true), [], "a phone-wake can be a bathroom trip");
  assert.deepEqual(holdStartsAtWake([overnightCluster("confirmed_stop")], [], null), []);
});

// ---- a bare stop that covers a dwell the spine names ------------------------

const FLAT = { ...LL(-4.1, -3.84) };
const dwell = (tier, name = "The Harbor Flat") => ({
  type: "dwell", id: "d7", major: true,
  start_ms: iso("2026-10-11T16:01:00Z"), end_ms: iso("2026-10-11T21:00:00Z"),
  place: { name, tier, lat: FLAT.lat, lon: FLAT.lon },
});
const bareStop = (over = {}) => ({
  id: "s-8", start: "19:02", end: "00:00", start_ts_ms: iso("2026-10-11T16:02:00Z"), end_ts_ms: iso("2026-10-11T21:00:00Z"),
  ...LL(72.92, 13.61), place: { name: null, address: "4 רבי פנחס", source: "unknown", confidence: 0 },
  unnamed: true, guessed_name: "אנטיליה", ...over,
});

test("the only unnamed stop at a corroborated dwell takes the dwell's name", () => {
  const stops = [bareStop()];
  const added = addSpineDwells(stops, { spine: [dwell("corroborated")] });
  assert.equal(stops[0].place.name, "The Harbor Flat");
  assert.equal(stops[0].place.source, "spine_dwell");
  assert.equal(stops[0].unnamed, false);
  assert.equal(stops.length, 1, "named, not duplicated");
  assert.deepEqual(added.map((a) => [a.id, a.named_only]), [["s-8", true]]);
});

test("a name the spine does not stand behind is not borrowed", () => {
  for (const tier of ["recorded", "stay-point", "unwitnessed"]) {
    const stops = [bareStop()];
    addSpineDwells(stops, { spine: [dwell(tier)] });
    assert.equal(stops[0].place.name, null, tier);
  }
});

test("a stop that already has a name is never renamed by the spine", () => {
  const stops = [bareStop({ place: { name: "Café Corvina", source: "confirmed_stop", confidence: 0.95 } })];
  addSpineDwells(stops, { spine: [dwell("corroborated")] });
  assert.equal(stops[0].place.name, "Café Corvina");
});

test("two unnamed stops at one dwell: neither is guessed at", () => {
  const stops = [bareStop(), bareStop({ id: "s-9", start_ts_ms: iso("2026-10-11T18:00:00Z"), end_ts_ms: iso("2026-10-11T19:00:00Z") })];
  assert.equal(nameBareStopFromDwell(stops, dwell("corroborated")), null);
  assert.equal(stops[0].place.name, null);
});

test("an unnamed stop elsewhere is not named for a dwell it is not at", () => {
  const stops = [bareStop({ lat: 32.07, lon: 34.78 })];
  assert.equal(nameBareStopFromDwell(stops, dwell("corroborated")), null);
});

// 2026-10-15, the daily-summary fix loop: the flat itself was held. This trip's
// stay is a manual travel row, so nothing marks the Portside flat as lodging; it
// arrives as a `confirmed_stop` named "The Harbor Flat", and holding it at the
// wake turned the night into "12:36am · 6h 38m between stops".
const AIRBNB = { ...LL(42.33, 0.01) };
const sleptHere = (over = {}) => ({
  name: "The Harbor Flat", centroid: { ...AIRBNB },
  stop_window: { start: "2026-10-17T23:43:25+00:00", end: "2026-10-18T06:56:46+00:00" }, ...over,
});
const jerusalem = () => "Asia/Jerusalem";

test("placesSleptAt keeps only confirmations that ran four hours or more through 03:00 local", () => {
  const afternoon = sleptHere({ stop_window: { start: "2026-10-15T11:11:53+00:00", end: "2026-10-15T16:39:04+00:00" } });
  const shortNight = sleptHere({ stop_window: { start: "2026-10-17T23:43:25+00:00", end: "2026-10-18T01:30:00+00:00" } });
  const noWindow = sleptHere({ stop_window: null });
  const got = placesSleptAt([sleptHere(), afternoon, shortNight, noWindow], jerusalem);
  assert.equal(got.length, 1);
  assert.equal(got[0].name, "The Harbor Flat");
  // A home-city evening at Jazz Club Example runs through 03:00 in Portside, not where it was.
  const blueNote = { name: "Jazz Club Example", centroid: { ...LL(-6604613.8, 6280538.43) },
    stop_window: { start: "2026-05-01T23:38:00+00:00", end: "2026-05-02T04:02:00+00:00" } };
  assert.deepEqual(placesSleptAt([blueNote]), [], "judged in its own zone, an evening");
});

test("a place he has confirmed sleeping at keeps its overnight block", () => {
  const flat = [overnightCluster("confirmed_stop", { ...LL(3.43, 2.44),
    place: { name: "The Harbor Flat", source: "confirmed_stop", confidence: 0.95 } })];
  const sleptAt = placesSleptAt([sleptHere()], jerusalem);
  assert.deepEqual(holdStartsAtWake(flat, [], asleep, false, sleptAt), []);
  assert.equal(flat[0].start_ts_ms, WINDOW_START);
  assert.deepEqual(holdStartsAtWake(flat, [], { from_ms: WINDOW_START, to_ms: iso("2026-10-14T04:10:00Z") }, true, sleptAt), [],
    "the phone-wake path honours it too");
});

test("the café-named night is still held, and so is the same name somewhere else", () => {
  const sleptAt = placesSleptAt([sleptHere()], jerusalem);
  const cafe = [overnightCluster("confirmed_stop")];
  assert.equal(holdStartsAtWake(cafe, [], asleep, false, sleptAt).length, 1, "no night was ever confirmed at Café Corvina");
  const elsewhere = [overnightCluster("confirmed_stop", { ...LL(2612.64, 2463.57),
    place: { name: "The Harbor Flat", source: "confirmed_stop", confidence: 0.95 } })];
  assert.equal(holdStartsAtWake(elsewhere, [], asleep, false, sleptAt).length, 1, "3 km from where he slept");
});

// 2026-10-15, the fix loop: home from the comedy show at 23:52, the arrival fix
// on Pine Street 78 m from the flat, then every fix from 00:13 at the flat. The
// day ends at midnight, so the last stop had eight minutes and no name.
const DAY_END = iso("2026-10-15T21:00:00Z");   // midnight in Portside
const NIGHT_FLAT = { ...LL(3.43, 2.44) };
const confirmedFlat = [{ name: "The Harbor Flat", centroid: { ...LL(-4.1, -3.84) } }];
const arrival = (over = {}) => ({
  id: "s-9", start: "23:52", end: "00:00", start_ts_ms: iso("2026-10-15T20:52:00Z"), end_ts_ms: DAY_END,
  duration_min: 8, ...LL(46.98, 93.68),
  place: { name: null, address: null, source: "unknown", confidence: 0 }, ...over,
});
const nightAt = (where) => async () => [
  { ts: iso("2026-10-15T21:13:00Z"), lat: where.lat, lon: where.lon, acc: 12, kind: "transit", activity: "unknown" },
  { ts: iso("2026-10-15T21:13:30Z"), lat: where.lat, lon: where.lon, acc: 12, kind: "transit", activity: "unknown" },
  { ts: iso("2026-10-15T21:14:00Z"), lat: where.lat, lon: where.lon, acc: 20, kind: "transit", activity: "unknown" },
  { ts: iso("2026-10-15T21:51:00Z"), lat: where.lat, lon: where.lon, acc: 12, kind: "transit", activity: "stationary" },
];

test("an unnamed last stop that runs into the night is named for where the night's fixes rest", async () => {
  const stops = [arrival()];
  const got = await nameDayEndFromNight(stops, DAY_END, confirmedFlat, nightAt(NIGHT_FLAT));
  assert.equal(stops[0].place.name, "The Harbor Flat");
  assert.equal(stops[0].place.source, "confirmed_stop");
  assert.equal(got.id, "s-9");
  assert.ok(got.rest_m_from_stop > 50 && got.rest_m_from_stop <= 150);
});

test("the night resting somewhere else, or on no confirmation, leaves the stop unnamed", async () => {
  const bar = { ...LL(181.77, 194.86) };   // ~200 m off: he went on somewhere
  const away = [arrival()];
  assert.equal(await nameDayEndFromNight(away, DAY_END, confirmedFlat, nightAt(bar)), null);
  assert.equal(away[0].place.name, null);
  const unconfirmed = [arrival()];
  assert.equal(await nameDayEndFromNight(unconfirmed, DAY_END, [], nightAt(NIGHT_FLAT)), null);
  const quiet = [arrival()];
  assert.equal(await nameDayEndFromNight(quiet, DAY_END, confirmedFlat, async () => []), null, "no fixes, no rest");
});

test("only an unnamed stop that reaches the day's end is touched", async () => {
  const named = [arrival({ place: { name: "Theatre Example", source: "user_confirmed" } })];
  assert.equal(await nameDayEndFromNight(named, DAY_END, confirmedFlat, nightAt(NIGHT_FLAT)), null);
  assert.equal(named[0].place.name, "Theatre Example");
  const earlier = [arrival({ end_ts_ms: DAY_END - 40 * MIN })];
  let asked = false;
  assert.equal(await nameDayEndFromNight(earlier, DAY_END, confirmedFlat, async () => { asked = true; return []; }), null);
  assert.equal(asked, false, "does not even look past midnight");
});
