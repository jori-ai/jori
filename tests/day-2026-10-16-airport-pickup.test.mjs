// An airport pickup: the user drove from the rented flat to the airport at
// 04:43 local to pick up a family member and was back at 05:39. The phone, in
// driving mode, saw the drive once every five minutes; at 05:13 it stood 92 m
// from the terminal. The user's correction: the day was missing the pickup at
// the airport. Two defects kept it out of the day:
//   1. the base-to-base excursion pass titled the 35 km drive "Walk to ..."
//      whenever the map-matcher answered (it had a floor on pace, no ceiling);
//   2. a place saved with the user's window (`location-confirm save-at`) never
//      became a stop where no visit row or dwell existed for it to name.
// Places are synthetic (tests/fixtures/fake-geo.mjs) with the real day's geometry.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { detectExcursions } = require(path.join(ROOT, "lib/day-excursions.js"));
const { addSavedAtStops } = require(path.join(ROOT, "lib/resolve-day.js"))._internal;
const { at: fakeAt } = await import(path.join(ROOT, "tests/fixtures/fake-geo.mjs"));
const LL = (e, n) => { const p = fakeAt(e, n); return { lat: p.lat, lon: p.lon }; };
const PT = (e, n) => { const p = fakeAt(e, n); return [p.lat, p.lon]; };

const U = (hms) => Date.parse(`2026-10-16T${hms}Z`);   // local = UTC+3
const FLAT = { ...LL(0, 0) };
const T3 = { ...LL(11009.41, -5897.39) };

function flat(id, from, to, source = "user_confirmed") {
  return { id, start: from, end: to, start_ts_ms: U(from), end_ts_ms: U(to),
           duration_min: Math.round((U(to) - U(from)) / 60000), ...FLAT,
           place: { name: "The rented flat", source, confidence: 1 }, companions: [], photos: [] };
}

const DRIVE_PATH = { segments: [{ kind: "observed", start_ms: U("01:43:00"), end_ms: U("02:39:00"), legs: [
  { t0: U("01:43:00"), t1: U("02:13:47"), lat0: FLAT.lat, lon0: FLAT.lon, lat1: T3.lat, lon1: T3.lon, m: 17400 },
  { t0: U("02:13:47"), t1: U("02:39:00"), lat0: T3.lat, lon0: T3.lon, lat1: FLAT.lat, lon1: FLAT.lon, m: 17500 },
] }] };
const OPTS = { resolvePoint: () => ({ neighborhood: "Airport City" }), features: async () => [] };

test("a driven base-to-base stretch is not a walk block", async () => {
  const stops = [flat("s-1", "00:00:00", "01:43:00", "confirmed_stop"), flat("s-2", "02:39:00", "07:19:00")];
  const { stops: out, excursions } = await detectExcursions(stops, DRIVE_PATH, OPTS);
  assert.equal(out.filter(s => s.excursion).length, 0);
  assert.equal(excursions[0].emitted, false);
  assert.match(excursions[0].reason, /^driven at 37\.\d km\/h/);
});

test("JORI_EXCURSION_DRIVES=1 restores the block", async () => {
  const stops = [flat("s-1", "00:00:00", "01:43:00", "confirmed_stop"), flat("s-2", "02:39:00", "07:19:00")];
  process.env.JORI_EXCURSION_DRIVES = "1";
  try {
    const { stops: out } = await detectExcursions(stops, DRIVE_PATH, OPTS);
    assert.equal(out.filter(s => s.excursion).length, 1);
  } finally { delete process.env.JORI_EXCURSION_DRIVES; }
});

const DAY_FROM = Date.parse("2026-10-15T21:00:00Z"), DAY_TO = Date.parse("2026-10-16T21:00:00Z");
const entry = (ask_id, name, from, to, at = T3) => ({ ask_id, name, centroid: { ...at },
  source: "user_stated_at", stop_window: { start: `2026-10-16T${from}+00:00`, end: `2026-10-16T${to}+00:00` } });

test("a place the user named for a window the phone never paused in becomes a stop", () => {
  const stops = [flat("s-1", "01:28:36", "01:43:10"), flat("s-2", "02:39:30", "07:19:00")];
  const added = addSavedAtStops(stops, [entry("lc-at-20261017-090000", "Example Airport", "02:02:16", "02:18:48")], DAY_FROM, DAY_TO);
  assert.equal(added.length, 1);
  assert.deepEqual(stops.map(s => s.place.name), ["The rented flat", "Example Airport", "The rented flat"]);
  const a = stops[1];
  assert.equal(a.place.source, "user_confirmed");
  assert.equal(a.from_confirmed_visit, true, "photos taken there can be reclaimed onto it");
  assert.equal(a.from_saved_at, "lc-at-20261017-090000");
  assert.equal(a.duration_min, 17);
});

test("only save-at entries with a window, never over a stop", () => {
  const stops = [flat("s-1", "01:28:36", "01:43:10"), flat("s-2", "02:39:30", "07:19:00")];
  const added = addSavedAtStops(stops, [
    entry("lc-direct-20261016-151933", "Example Airport", "02:02:16", "02:18:48"),   // a card / live answer
    entry("lc-at-20261017-090002", "Café", "02:30:00", "02:50:00", FLAT),                // overlaps the flat
    { ask_id: "lc-at-20261017-090003", name: "No window", centroid: { ...T3 } },
  ], DAY_FROM, DAY_TO);
  assert.equal(added.length, 0);
  assert.equal(stops.length, 2);
});

test("a short stop the user named is a stop; a sliver the day's edge cut off is not", () => {
  // A gas stop the user described and saved for an 8-minute window was dropped
  // for being short, after the user had said the gas stop was part of the drive.
  const stops = [flat("s-1", "01:28:36", "01:43:10"), flat("s-2", "02:39:30", "07:19:00")];
  const added = addSavedAtStops(stops, [
    entry("lc-at-20261017-090001", "Gas station", "02:20:00", "02:25:00"),
    entry("lc-at-20261017-090008", "Late snack", "20:55:00", "21:05:00"),   // 5 of its 10 minutes are this day's
  ], DAY_FROM, DAY_TO);
  assert.deepEqual(added.map(a => a.name), ["Gas station"]);
  assert.deepEqual(stops.map(s => s.place.name), ["The rented flat", "Gas station", "The rented flat"]);
  assert.equal(stops[1].duration_min, 5);
});

test("a window running past the day is cut at the day's edge", () => {
  const stops = [flat("s-1", "01:28:36", "01:43:10")];
  const added = addSavedAtStops(stops, [entry("lc-at-20261017-090004", "Late place", "20:30:00", "22:30:00")], DAY_FROM, DAY_TO);
  assert.equal(added.length, 1);
  assert.equal(stops[1].end_ts_ms, DAY_TO);
});

test("JORI_SAVED_AT_STOPS=0 adds nothing", () => {
  const stops = [flat("s-1", "01:28:36", "01:43:10")];
  process.env.JORI_SAVED_AT_STOPS = "0";
  try {
    assert.equal(addSavedAtStops(stops, [entry("lc-at-20261017-090005", "Example Airport", "02:02:16", "02:18:48")], DAY_FROM, DAY_TO).length, 0);
  } finally { delete process.env.JORI_SAVED_AT_STOPS; }
});

test("the people the user's words put there ride onto the stop", () => {
  const stops = [flat("s-1", "01:28:36", "01:43:10"), flat("s-2", "02:39:30", "07:19:00")];
  addSavedAtStops(stops, [{ ...entry("lc-at-20261017-090006", "Example Airport", "02:02:16", "02:18:48"), companions: ["Alex"] }], DAY_FROM, DAY_TO);
  assert.deepEqual(stops[1].companions, ["Alex"]);
  assert.equal(stops[1].id, "s-20261016-a1");
});

test("a stop for the same visit is the user's answer about it, never overwritten by another place", () => {
  // A dinner: the spine's stop 20:27-21:42, named by the 30 m rung from the
  // entry the user's Maps link made (17:38-18:42Z); it read as a past-day match.
  const GRILL = { ...LL(155.22, 200.36) };
  const dinner = { id: "s-p1", start: "20:27", end: "21:42", start_ts_ms: U("17:27:00"), end_ts_ms: U("18:42:40"),
    duration_min: 76, ...LL(157.18, 196.13), place: { name: "Example Grill", source: "confirmed_stop", confidence: 0.95 }, companions: [] };
  const morning = flat("s-2", "02:39:30", "11:20:00");
  const stops = [morning, dinner];
  const added = addSavedAtStops(stops, [
    entry("lc-at-20261017-072113", "Example Grill", "17:38:25", "18:42:40", GRILL),
    entry("lc-at-20261017-090007", "Café Example", "07:18:57", "07:57:21", { ...LL(79.17, -10.01) }),  // inside the flat's long stay
  ], DAY_FROM, DAY_TO);
  assert.equal(stops.length, 2, "nothing added");
  assert.equal(dinner.place.source, "user_confirmed");
  assert.equal(morning.place.name, "The rented flat", "a short entry inside a long stay elsewhere does not rename it");
  assert.deepEqual(added.map(a => [a.id, a.same_visit]), [["s-p1", true]]);
});

// A morning coffee with companions, then a long walk along the beach. Every fix
// from 09:00 to 09:50 sat within 4 m of the café, but the flat's overnight row,
// confirmed by the user as the night's stay, ran to 09:56 and the café had no
// stop of its own.
const D18_FROM = Date.parse("2026-10-17T21:00:00Z"), D18_TO = Date.parse("2026-10-18T21:00:00Z");
const U18 = (hms) => Date.parse(`2026-10-18T${hms}Z`);
const CAFE_AT = { ...LL(79.45, -9.56) };
const cafeEntry = { ask_id: "lc-at-20261019-011500", name: "Café Example", centroid: { ...CAFE_AT },
  source: "user_stated_at", companions: ["Sam", "Max"],
  stop_window: { start: "2026-10-18T06:00:33+00:00", end: "2026-10-18T06:56:00+00:00" } };
function morning() {
  const night = { id: "s-20261018-1", start: "00:00", end: "09:56", start_ts_ms: D18_FROM, end_ts_ms: U18("06:56:46"),
    duration_min: 597, ...LL(20.08, 15.19),
    place: { name: "The rented flat", source: "user_confirmed", confidence: 1 }, companions: [],
    photos: [{ uuid: "p-night", ts: "2026-10-18T03:00:00Z" }, { uuid: "p-cafe", ts: "2026-10-18T06:30:00Z" }] };
  const walk = { id: "s-20261018-1-loop", start_ts_ms: U18("06:56:46"), end_ts_ms: U18("07:37:00"), ...LL(294.97, 596.01),
    place: { name: "Walk along the beach", source: "excursion" }, excursion: { away_m: 651 }, companions: [], photos: [] };
  return [night, walk];
}
const cafeFixes = ["06:00:33", "06:24:47", "06:31:10", "06:38:03", "06:47:38", "06:49:53"]
  .map(t => ({ ts: U18(t), ...LL(78.22, -8.9), acc: 8 }));

test("the user's café inside the flat's overnight stay is cut out of it when the fixes sit at the café", () => {
  const stops = morning();
  const added = addSavedAtStops(stops, [cafeEntry], D18_FROM, D18_TO,
    [{ ts: U18("04:51:49"), ...LL(4.71, 6.67), acc: 14 }, ...cafeFixes]);
  assert.equal(added.length, 1);
  assert.deepEqual(added[0].cut_from && added[0].cut_from.id, "s-20261018-1");
  assert.deepEqual(stops.map(s => [s.id, s.place.name, s.start_ts_ms, s.end_ts_ms]), [
    ["s-20261018-1", "The rented flat", D18_FROM, U18("06:00:33")],
    ["s-20261018-a1", "Café Example", U18("06:00:33"), U18("06:56:00")],
    ["s-20261018-1-loop", "Walk along the beach", U18("06:56:46"), U18("07:37:00")],
  ], "the 46-second tail at the flat is a moment at the door and goes");
  assert.deepEqual(stops[1].companions, ["Sam", "Max"]);
  assert.equal(stops[1].place.source, "user_confirmed");
  assert.deepEqual(stops[0].photos.map(p => p.uuid), ["p-night"]);
  assert.deepEqual(stops[1].photos.map(p => p.uuid), ["p-cafe"], "a photo taken in the user's window goes with it");
});

test("without fixes at the user's place, the stop that claims the window keeps it", () => {
  for (const pings of [null, [], [{ ts: U18("06:10:00"), ...LL(4.71, 6.67), acc: 10 },
                                  { ts: U18("06:40:00"), ...LL(5.65, 6.67), acc: 10 }]]) {
    const stops = morning();
    assert.equal(addSavedAtStops(stops, [cafeEntry], D18_FROM, D18_TO, pings).length, 0);
    assert.deepEqual(stops.map(s => s.id), ["s-20261018-1", "s-20261018-1-loop"]);
  }
});

// A coffee (07:56-08:47) with no fix inside it at all, a still phone; the only
// fixes were two at 08:47, 36-46 m from the café on the way out.
test("a silent window is carved when the first fixes after it sit at the user's place", () => {
  const stops = morning();
  const leaving = [{ ts: U18("06:56:06"), ...LL(76.34, 35.58), acc: 10 },
                   { ts: U18("06:56:11"), ...LL(90.1, 25.24), acc: 10 }];
  const added = addSavedAtStops(stops, [cafeEntry], D18_FROM, D18_TO,
    [{ ts: U18("04:51:49"), ...LL(4.71, 6.67), acc: 14 }, ...leaving]);
  assert.equal(added.length, 1);
  assert.equal(added[0].cut_from && added[0].cut_from.id, "s-20261018-1");
  assert.deepEqual(stops.map(s => s.place.name).slice(0, 2), ["The rented flat", "Café Example"]);
});

test("a silent window stays with the stop that claims it when the next fixes are elsewhere or late", () => {
  for (const after of [
    [{ ts: U18("06:56:06"), ...LL(4.71, 6.67), acc: 10 }, { ts: U18("06:56:30"), ...LL(5.65, 6.67), acc: 10 }],
    [{ ts: U18("07:05:00"), ...LL(78.22, -8.9), acc: 8 }, { ts: U18("07:06:00"), ...LL(78.22, -8.9), acc: 8 }],
  ]) {
    const stops = morning();
    assert.equal(addSavedAtStops(stops, [cafeEntry], D18_FROM, D18_TO, after).length, 0);
  }
});

test("JORI_SAVED_AT_CARVE=0 leaves a claimed window alone", () => {
  const stops = morning();
  process.env.JORI_SAVED_AT_CARVE = "0";
  try {
    assert.equal(addSavedAtStops(stops, [cafeEntry], D18_FROM, D18_TO, cafeFixes).length, 0);
    assert.equal(stops.length, 2);
  } finally { delete process.env.JORI_SAVED_AT_CARVE; }
});

test("a piece left after the cut whose own fixes are all elsewhere is not time at the flat", () => {
  // The flat's row really ran to 10:06; its last ten minutes were the walk out
  // (every fix 200-420 m off), and a "flat" stop there made the walk read as an arrival.
  const [night] = morning();
  night.end_ts_ms = U18("07:06:00");
  night.photos.push({ uuid: "p-beach", ts: "2026-10-18T07:13:03Z" });
  const stops = [night];
  const walkingOut = [["06:57:00", ...PT(153.61, 273.54)], ["07:01:19", ...PT(172.46, 351.38)], ["07:04:16", ...PT(219.58, 451.45)]]
    .map(([t, lat, lon]) => ({ ts: U18(t), lat, lon, acc: 20 }));
  addSavedAtStops(stops, [cafeEntry], D18_FROM, D18_TO,
    [{ ts: U18("04:51:49"), ...LL(4.71, 6.67), acc: 14 }, ...cafeFixes, ...walkingOut]);
  assert.deepEqual(stops.map(s => [s.place.name, s.start_ts_ms, s.end_ts_ms]), [
    ["The rented flat", D18_FROM, U18("06:00:33")],
    ["Café Example", U18("06:00:33"), U18("06:56:00")],
  ]);
  assert.deepEqual(stops[1].photos.map(p => p.uuid), ["p-cafe", "p-beach"],
    "a photo after the window goes to the nearest stop, so the walk built later can take it");
});
