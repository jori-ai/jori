// stop-rests-two-lobes.test.mjs — a coffee stop 170 m from the door is a stop.
//
// The user, on a daily summary: the 7am also had a coffee stop and a bakery
// run — why wasn't any of that captured? (Synthetic coordinates, real geometry.)
//
// The trace had captured it. From the rental flat the user walked ~170 m to a café:
// a 07:49 CLVisit row, five stationary fixes, a storefront photo at 07:57 and
// two coffee-table photos at 08:09, all within 15 m of each other. Three things
// hid it, each sufficient on its own:
//
//   1. location-segment's 200 m anchor-walk fused café + door into ONE cluster,
//      and splitStopOnRests only looked inside clusters whose radius beat 100 m.
//      Two lobes 170 m apart put the centroid between them, so the "radius" was
//      92 m -- half the gap -- and the stop was never examined.
//   2. splitWideStopsOnRests skipped any stop named by `confirmed_stop`, which
//      is a proximity match to an earlier confirmation, not an answer about
//      this window.
//   3. That confirmation had itself been saved off a blend: the earlier
//      "The Rental Flat" anchor sits 82 m from the door and 86 m
//      from the café, so the blended centroid matched it at 16 m.
//
// Run: node --test tests/stop-rests-two-lobes.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Synthetic coordinates: metres east/north of an obviously fake origin, so the
// fixtures keep the real traces' geometry without pinning a real place.
const ORIGIN = [12.3456, -65.4321];
const M_PER_DEG = 6371000 * Math.PI / 180;
const fakePt = (e, n) => { const lat = ORIGIN[0] + n / M_PER_DEG; return [lat, ORIGIN[1] + e / (M_PER_DEG * Math.cos(lat * Math.PI / 180))]; };
const fakeAt = (e, n) => { const [lat, lon] = fakePt(e, n); return { lat, lon }; };
const fakeRow = (e, n) => { const [latitude, longitude] = fakePt(e, n); return { latitude, longitude }; };
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { findRests, splitStopOnRests, haversineMeters, TWO_LOBE_RADIUS_M, SPLIT_RADIUS_M } =
  require(path.join(ROOT, "lib/stop-rests.js"));
const { splitWideStopsOnRests, nameRest, matchConfirmedRest, SPLIT_SEPARATION_M } =
  require(path.join(ROOT, "lib/resolve-day.js"))._internal;

const U = (hms) => Date.parse(`2026-10-10T${hms}Z`);

// Every fix that morning, verbatim from location_history (+ the three photos).
const DOOR = fakePt(-0.07, 0.3);
const CAFE = fakePt(164.86, 44.78);
const PINGS = [
  { ts: U("04:07:07"), ...fakeAt(0, 0), acc: 17.6, kind: "transit", activity: "unknown" },
  { ts: U("04:07:48"), ...fakeAt(0, 0.01), acc: 10.8, kind: "transit", activity: "unknown" },
  { ts: U("04:08:01"), ...fakeAt(0, 0.01), acc: 9.5, kind: "transit", activity: "unknown" },
  { ts: U("04:08:23"), ...fakeAt(0, 0.01), acc: 7.2, kind: "transit", activity: "unknown" },
  // 41 minutes of silence, then the phone's visit detector fires at the café.
  { ts: U("04:49:20"), ...fakeAt(164.45, 47.02), acc: null, kind: "visit", activity: null },
  { ts: U("04:49:20"), ...fakeAt(4.32, 5.38), acc: 4.4, kind: "transit", activity: "unknown" },
  { ts: U("04:55:47"), ...fakeAt(165.36, 45.7), acc: 13.1, kind: "transit", activity: "stationary" },
  { ts: U("04:57:20"), ...fakeAt(162.03, 51.45), acc: null, kind: "photo", activity: null },
  { ts: U("05:00:36"), ...fakeAt(162.1, 45.82), acc: 14.5, kind: "transit", activity: "stationary" },
  { ts: U("05:02:22"), ...fakeAt(168.9, 53.45), acc: 9.7, kind: "transit", activity: "unknown" },
  { ts: U("05:02:26"), ...fakeAt(168.51, 51.01), acc: 8.7, kind: "transit", activity: "unknown" },
  { ts: U("05:04:36"), ...fakeAt(165.65, 44.09), acc: 13.7, kind: "transit", activity: "unknown" },
  { ts: U("05:04:45"), ...fakeAt(165.14, 43.42), acc: 11.3, kind: "transit", activity: "unknown" },
  { ts: U("05:09:11"), ...fakeAt(165.49, 44.97), acc: null, kind: "photo", activity: null },
  { ts: U("05:09:12"), ...fakeAt(165.8, 44.66), acc: null, kind: "photo", activity: null },
  // 46 minutes of silence, then back at the door.
  { ts: U("05:55:45"), ...fakeAt(0.62, 2.05), acc: 10.3, kind: "transit", activity: "stationary" },
  { ts: U("05:55:45"), ...fakeAt(0.62, 2.05), acc: 10.3, kind: "transit", activity: "stationary" },
  { ts: U("06:15:42"), ...fakeAt(100.33, 29.33), acc: 12.2, kind: "transit", activity: "driving" },
  { ts: U("06:18:39"), ...fakeAt(762.21, -378.15), acc: 5, kind: "transit", activity: "driving" },
];

// The stop as location-segment handed it over: one cluster, centroid between
// the lobes, named by the 2026-10-09 anchor 16 m away.
const BLEND = {
  id: "s-20261010-1", start: "04:00", end: "06:18",
  start_ts_ms: U("04:00:00"), end_ts_ms: U("06:18:39"),
  duration_min: 139, ...fakeAt(88.24, 25.32), cluster_radius_km: 0.0918, sample_count: 20,
  place: { name: "The Rental Flat", source: "confirmed_stop", confidence: 0.95, distance_m: 16 },
  // The shape attachPhotosToStop gives a stop: `ts`, not `taken_at`. The split
  // once read only `taken_at` and handed every photo to the first piece.
  photos: [
    { uuid: "cafe-front", ts: "2026-10-10T04:57:20Z" },
    { uuid: "cafe-cup-1", ts: "2026-10-10T05:09:11Z" },
    { uuid: "cafe-cup-2", ts: "2026-10-10T05:09:12Z" },
  ],
};

const AIRBNB_ANCHOR = { name: "The Rental Flat", centroid: { ...fakeAt(8.42, 14.76) } };
// What the 2026-10-09 confirmation saved: the midpoint of door and café.
const POLLUTED_ANCHOR = { name: "The Rental Flat", centroid: { ...fakeAt(80.98, 11.2) } };

test("preconditions: the blend is under the old radius bar, over the two-lobe floor", () => {
  const r = BLEND.cluster_radius_km * 1000;
  assert.ok(r < SPLIT_RADIUS_M, `${r} m radius sits under the ${SPLIT_RADIUS_M} m wide-cluster bar`);
  assert.ok(r > TWO_LOBE_RADIUS_M);
  assert.ok(haversineMeters(...DOOR, ...CAFE) > SPLIT_SEPARATION_M, "the lobes are further apart than one building");
  assert.ok(haversineMeters(BLEND.lat, BLEND.lon, ...POLLUTED_ANCHOR_LATLON()) < 30,
    "and the blend's centroid is inside the polluted anchor's 30 m ring");
});
function POLLUTED_ANCHOR_LATLON() { return [POLLUTED_ANCHOR.centroid.lat, POLLUTED_ANCHOR.centroid.lon]; }

test("the trace holds three rests: door, café, door", () => {
  const rests = findRests(PINGS, BLEND.start_ts_ms, BLEND.end_ts_ms);
  assert.equal(rests.length, 3);
  assert.ok(haversineMeters(rests[0].lat, rests[0].lon, ...DOOR) < 25);
  assert.ok(haversineMeters(rests[1].lat, rests[1].lon, ...CAFE) < 25, "the middle rest is at the café");
  assert.ok(haversineMeters(rests[2].lat, rests[2].lon, ...DOOR) < 25);
  assert.ok(rests[1].corroborated_by.includes("photo"), "and its photos vouch for it");
});

test("a 92 m blend over two places is now examined, and cut", () => {
  const pieces = splitStopOnRests(BLEND, PINGS);
  assert.ok(pieces, "before the floor it returned null without ever reading the trace");
  assert.equal(pieces.length, 3);
});

test("a 65-100 m cluster is only cut on two rests, never tightened onto one", () => {
  const sitting = [
    { ts: U("04:00:00"), ...fakeAt(-0.07, 0.3), acc: 10, kind: "visit" },
    { ts: U("04:20:00"), ...fakeAt(0.88, 1.41), acc: 10 },
    { ts: U("04:40:00"), ...fakeAt(-1.01, -0.81), acc: 10 },
    { ts: U("05:20:00"), ...fakeAt(74.39, 68.13), acc: 40 },   // drift out, too loose to rest
  ];
  const blend = { ...BLEND, start_ts_ms: U("04:00:00"), end_ts_ms: U("05:30:00"), cluster_radius_km: 0.08 };
  assert.equal(splitStopOnRests(blend, sitting), null);
});

test("a cluster under the two-lobe floor is never re-cut", () => {
  const tight = { ...BLEND, cluster_radius_km: (TWO_LOBE_RADIUS_M - 5) / 1000 };
  assert.equal(splitStopOnRests(tight, PINGS), null);
});

// The pieces re-earn names from the rests' own centroids: the door keeps the
// Airbnb, the café keeps nothing it did not earn.
const nameFromAnchors = (anchors) => (piece) => {
  const m = matchConfirmedRest(anchors, piece.lat, piece.lon);
  piece.place = m
    ? { name: m.entry.name, address: null, source: "confirmed_stop", confidence: 0.95, distance_m: m.distance_m }
    : { name: null, address: null, source: "unknown", confidence: 0, distance_m: null };
};

test("the coffee stop comes out of a confirmed_stop blend, and the door keeps its name", () => {
  const ctx = { date: "2026-10-10", knownStopsEntries: [], nameRest: nameFromAnchors([AIRBNB_ANCHOR, POLLUTED_ANCHOR]) };
  const { stops, splits } = splitWideStopsOnRests([{ ...BLEND }], PINGS, ctx);
  assert.equal(stops.length, 3);
  assert.deepEqual(stops.map(s => s.place.name), ["The Rental Flat", null, "The Rental Flat"]);
  assert.equal(splits[0].dropped_name, "The Rental Flat");
  assert.ok(splits[0].apart_m >= SPLIT_SEPARATION_M);
  const cafe = stops[1];
  assert.ok(haversineMeters(cafe.lat, cafe.lon, ...CAFE) < 25);
  assert.deepEqual(cafe.photos.map(p => p.uuid).sort(), ["cafe-cup-1", "cafe-cup-2", "cafe-front"],
    "the café keeps the photos taken inside it");
  assert.equal(stops[0].photos.length + stops[2].photos.length, 0, "and the door either side of it keeps none");
  assert.ok(stops.map(s => s.id).every((id, i) => id.endsWith(`-${i + 1}`)), "ids renumbered in order");
});

test("an unnamed rest is its own place, not 'the same place' as another unnamed one", () => {
  const ctx = { date: "2026-10-10", knownStopsEntries: [], nameRest: nameFromAnchors([]) };
  const { stops, splits } = splitWideStopsOnRests([{ ...BLEND }], PINGS, ctx);
  assert.ok(stops.length >= 2, "two verified rests 170 m apart stay apart even when neither earns a label");
  assert.ok(!splits[0].kept_whole);
});

test("a stop the user answered for is still never re-cut", () => {
  const his = { ...BLEND, place: { name: "The Rental Flat", source: "user_confirmed", confidence: 1 } };
  const ctx = { date: "2026-10-10", knownStopsEntries: [], nameRest: nameFromAnchors([]) };
  const { stops, splits } = splitWideStopsOnRests([his], PINGS, ctx);
  assert.equal(stops.length, 1);
  assert.equal(splits.length, 0);
});

test("nameRest gives a rest the confirmation sitting on it, and not one 80 m away", () => {
  const atDoor = { lat: DOOR[0], lon: DOOR[1], start: "07:07", end: "07:49", start_ts_ms: 0, end_ts_ms: 1 };
  nameRest(atDoor, { date: "2026-10-10", knownStopsEntries: [], confirmedStopsEntries: [AIRBNB_ANCHOR, POLLUTED_ANCHOR] });
  assert.equal(atDoor.place.name, "The Rental Flat");
  assert.equal(atDoor.place.source, "confirmed_stop");
  assert.ok(atDoor.place.distance_m < 30);
  // The café is 86 m from the polluted anchor and 140 m from the true one: neither claims it.
  assert.equal(matchConfirmedRest([AIRBNB_ANCHOR, POLLUTED_ANCHOR], ...CAFE), null);
});
