// resolve-day-evening-split.test.mjs — an evening at the flat is not one block
// when the trace shows a café 190 m away in the middle of it.
//
// The incident (2026-10-14, Portside): the phone's "The Harbor Flat" geofence row
// (place_type `named`) covered 19:48-20:13, widenToBackingVisits stretched it to
// midnight, and the daily summary folded the 67 minutes at פועה קפה into one long
// Airbnb block. Three things were wrong and each is pinned here:
//   1. splitWideStopsOnRests treated a geofence-`named` row as the user's answer and
//      never re-cut it. Only an answer (`user-confirmed`) is final.
//   2. extendThroughSilence counted the 21:20 walk home (101 m from the café, 66 m
//      from the flat) as "still at the café" and stretched the café through the
//      flat's hour.
//   3. A rest cut out of the flat's stop took the café-under-the-flat's name,
//      because that anchor sat 8 m nearer the centroid than the flat's own.
// The day-path half (the spine splitting the visit row) is day-path-stay-split.test.py.
//
// Run: node --test tests/resolve-day-evening-split.test.mjs

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
const PT = (e, n) => { const p = fakeAt(e, n); return [p.lat, p.lon]; };
const LLG = (e, n) => { const p = fakeAt(e, n); return { lat: p.lat, lng: p.lon }; };

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { findRests, haversineMeters } = require(path.join(ROOT, "lib/stop-rests.js"));
const { splitWideStopsOnRests, matchConfirmedRest, extendThroughSilence } =
  require(path.join(ROOT, "lib/resolve-day.js"))._internal;

const U = (hms) => Date.parse(`2026-10-14T${hms}Z`);
const FLAT = [...PT(-101.94, -26.51)];
const CAFE = [...PT(81.71, -9.56)];

// The evening's fixes, verbatim from location_history (UTC; Israel is UTC+3).
const p = (hms, lat, lon, acc, activity = "unknown") => ({ ts: U(hms), lat, lon, acc, kind: "transit", activity });
// (location_history holds several of these twice or three times: two producers write each fix.)
const PINGS = [
  ...Array(3).fill(p("16:48:33", ...PT(-82.83, -10.25), 23.9, "stationary")),
  p("16:49:00", ...PT(-32.61, 85.4), 5, "driving"),
  ...Array(3).fill(p("16:53:17", ...PT(-95.44, -19.65), 17.5)),
  p("17:05:52", ...PT(18.72, 51.97), 2.6),
  p("17:05:54", ...PT(20.07, 51.68), 5.5),
  p("17:05:57", ...PT(28.0, 52.27), 15.8),
  p("17:06:10", ...PT(45.33, 51.74), 24.3),
  p("17:13:28", ...PT(79.45, -66.62), 35.2),
  p("17:17:37", ...PT(57.21, 2.31), 18.4),
  p("17:24:03", ...PT(90.31, 14.09), 33.1),
  p("17:24:22", ...PT(87.79, 4.43), 13.9),
  p("18:05:57", ...PT(86.8, 2.29), 31.2),
  p("18:07:46", ...PT(85.19, 4.88), 6.5),
  p("18:07:49", ...PT(85.19, 4.88), 6.5, "stationary"),
  p("18:12:08", ...PT(86.38, 3.78), 7.5),
  p("18:20:41", ...PT(-18.69, -0.96), 20, "walking"),     // the walk home
  p("19:10:23", ...PT(-101.6, -26.74), 5.2, "stationary"),
  p("20:12:13", ...PT(-101.6, -26.73), 2.0),
  p("20:14:53", ...PT(-101.61, -26.74), 9.4),
  p("20:15:35", ...PT(-101.61, -26.74), 7.2),
];

// The stop as it reached splitWideStopsOnRests: the geofence row's name, widened to midnight.
const blend = (rowType) => ({
  id: "s-20261014-6", start: "19:48", end: "00:00",
  start_ts_ms: U("16:48:33"), end_ts_ms: U("21:00:00"),
  duration_min: 251, ...LL(0.0, 0.0), cluster_radius_km: 0.105, sample_count: 39,
  place: { name: "The Harbor Flat", source: "user_confirmed", confidence: 1 },
  confirmed_row: { id: "386eb720", name: "The Harbor Flat", start_ms: U("16:48:33"), end_ms: U("17:13:28"), place_type: rowType },
  photos: [],
});

const AIRBNB = { name: "The Harbor Flat", centroid: { ...LL(-99.24, -19.57) } };
const ANTILIA = { name: "Café Corvina", centroid: { ...LL(-101.94, -26.51) } };
const PUAA = { name: "פועה קפה", centroid: { ...LL(84.23, -26.24) } };
const ANCHORS = [AIRBNB, ANTILIA, PUAA];
const nameRest = (piece, ctx) => {
  const m = matchConfirmedRest(ANCHORS, piece.lat, piece.lon, piece.split_from && piece.split_from.dropped_name);
  piece.place = m
    ? { name: m.entry.name, address: null, source: "confirmed_stop", confidence: 0.95, distance_m: m.distance_m }
    : { name: null, address: null, source: "unknown", confidence: 0, distance_m: null };
};
const ctx = { date: "2026-10-14", knownStopsEntries: [], nameRest };

test("the trace holds the café as its own 60+ minute rest, 190 m from the flat", () => {
  const rests = findRests(PINGS, U("16:48:33"), U("21:00:00"));
  const cafe = rests.find(r => haversineMeters(r.lat, r.lon, ...CAFE) < 40);
  assert.ok(cafe, "a rest at the café");
  assert.ok(cafe.minutes >= 60, `${cafe.minutes} min`);
  assert.ok(haversineMeters(cafe.lat, cafe.lon, ...FLAT) > 130, "further from the flat than one building");
});

test("a geofence-named row is re-cut: flat, café, flat", () => {
  const { stops, splits } = splitWideStopsOnRests([blend("named")], PINGS, ctx);
  assert.equal(splits.length, 1);
  assert.ok(!splits[0].kept_whole);
  const names = stops.map(s => s.place.name);
  assert.ok(names.includes("פועה קפה"), `the café is back: ${names}`);
  assert.equal(names[0], "The Harbor Flat");
  assert.equal(names[names.length - 1], "The Harbor Flat", "the late rest at the flat keeps the flat's name, not the café-under-it's");
});

test("a row he ANSWERED (user-confirmed) is still final", () => {
  const { stops, splits } = splitWideStopsOnRests([blend("user-confirmed")], PINGS, ctx);
  assert.equal(stops.length, 1);
  assert.equal(splits.length, 0);
});

test("kill switch JORI_GEOFENCE_RESPLIT=0 restores the old exemption", () => {
  process.env.JORI_GEOFENCE_RESPLIT = "0";
  try {
    const { stops } = splitWideStopsOnRests([blend("named")], PINGS, ctx);
    assert.equal(stops.length, 1);
  } finally { delete process.env.JORI_GEOFENCE_RESPLIT; }
});

test("matchConfirmedRest: two anchors 8 m apart, the parent's name wins the tie", () => {
  const [lat, lon] = [...PT(-101.6, -26.74)];
  assert.equal(matchConfirmedRest(ANCHORS, lat, lon).entry.name, "Café Corvina", "no preference: nearest");
  assert.equal(matchConfirmedRest(ANCHORS, lat, lon, "The Harbor Flat").entry.name, "The Harbor Flat");
  assert.equal(matchConfirmedRest(ANCHORS, lat, lon, "Somewhere else").entry.name, "Café Corvina", "an absent preference changes nothing");
});

// The two pieces as they stand after the split and the spine clip.
const cafeStop = () => ({
  id: "s-7", start: "20:17", end: "21:12", start_ts_ms: U("17:17:00"), end_ts_ms: U("18:12:11"),
  duration_min: 55, ...LL(81.71, -9.56), place: { name: "פועה קפה", source: "confirmed_stop" },
});
const flatStop = () => ({
  id: "s-8", start: "22:10", end: "00:00", start_ts_ms: U("19:10:23"), end_ts_ms: U("21:00:00"),
  duration_min: 110, ...LL(-101.6, -26.74), place: { name: "The Harbor Flat", source: "confirmed_stop" },
});

test("extendThroughSilence: the walk home is not 'still at the café'", () => {
  const [cafe, flat] = [cafeStop(), flatStop()];
  extendThroughSilence([cafe, flat], PINGS);
  assert.equal(cafe.end_ts_ms, U("18:12:11"), "the café ends at his last fix there (21:12 Israel)");
  assert.equal(flat.start_ts_ms, U("18:20:41"), "and the flat starts at the walk home (21:20), not at the 22:10 fix");
});

test("extendThroughSilence: JORI_SILENCE_NEIGHBOUR=0 is the old behaviour (café through the flat's hour)", () => {
  process.env.JORI_SILENCE_NEIGHBOUR = "0";
  try {
    const [cafe, flat] = [cafeStop(), flatStop()];
    extendThroughSilence([cafe, flat], PINGS);
    assert.ok(cafe.end_ts_ms > U("19:00:00") && cafe.end_ts_ms < U("19:10:23"), "old: the café ran to ~22:09 Israel");
  } finally { delete process.env.JORI_SILENCE_NEIGHBOUR; }
});

// 2026-10-21, Portside: the evening at Tamsa was cut out of the flat's 17:18-23:16
// blend, and every piece kept the blend's companions. The 21:49 photo row at
// Tamsa (Ivy, Yuri) put Ivy on the flat at 17:13 and again at 22:39. A piece
// keeps the people whose own visit row it overlaps; a name no row gave the
// blend (here Rover, from his words) stays on every piece.
test("a piece keeps only the companions of the rows it overlaps (2026-10-21)", () => {
  const rows = [
    { arrived_at: "2026-10-14T16:48:33Z", departed_at: "2026-10-14T17:10:00Z", latitude: FLAT[0], longitude: FLAT[1], companions: ["Paige"] },
    { arrived_at: "2026-10-14T17:30:00Z", departed_at: "2026-10-14T17:40:00Z", latitude: CAFE[0], longitude: CAFE[1], companions: ["Ivy wells", "Yuri"] },
  ];
  const b = { ...blend("named"), companions: ["Paige", "Ivy wells", "Yuri", "Rover"] };
  const { stops } = splitWideStopsOnRests([b], PINGS, { ...ctx, companionRows: rows });
  const cafe = stops.find(s => s.place.name === "פועה קפה");
  const first = stops[0], last = stops[stops.length - 1];
  assert.deepEqual([...cafe.companions].sort(), ["Ivy wells", "Rover", "Yuri"]);
  assert.deepEqual([...first.companions].sort(), ["Paige", "Rover"]);
  assert.deepEqual(last.companions, ["Rover"], "nobody's row puts anyone at the flat late; only the row-less name stays");
  assert.deepEqual(b.companions, ["Paige", "Ivy wells", "Yuri", "Rover"], "the blend itself is untouched");
});

test("without rows (or JORI_PIECE_COMPANIONS=0) every piece keeps the blend's companions", () => {
  const b = { ...blend("named"), companions: ["Paige", "Ivy wells"] };
  for (const s of splitWideStopsOnRests([b], PINGS, ctx).stops) assert.deepEqual(s.companions, ["Paige", "Ivy wells"]);
  process.env.JORI_PIECE_COMPANIONS = "0";
  try {
    const rows = [{ arrived_at: "2026-10-14T17:30:00Z", departed_at: "2026-10-14T17:40:00Z", latitude: CAFE[0], longitude: CAFE[1], companions: ["Ivy wells"] }];
    for (const s of splitWideStopsOnRests([b], PINGS, { ...ctx, companionRows: rows }).stops) assert.deepEqual(s.companions, ["Paige", "Ivy wells"]);
  } finally { delete process.env.JORI_PIECE_COMPANIONS; }
});
