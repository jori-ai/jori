// resolve-day-photo-reclaim.test.mjs — the E Main St photo that rendered under
// the following "Home" stop instead of its own stop (Mason, 2026-09-14, in
// reply to the Sept 13 daily-summary fixes: "Investigate and fix that too").
//
// photos.uuid E5399CB8's own segment_id pointed at the "E Main St" visit row
// the whole time, and its timestamp (20:32:38 UTC) sat 67s before that visit's
// departed_at (20:33:45). But dropShortStops runs long before the spine
// reconciliation adds "E Main St" back as a stop (it starts life as a 6-minute
// unconfirmed google_places guess — "Taco Cart Example" — short enough to
// get dropped), so at drop-time the only candidates were "Example Hospital"
// (37 min away) and "Home" (25 min away) — nearest-in-time-only picked Home,
// 2.4km from where the photo was actually taken. addSpineDwells later adds
// "E Main St" as its own stop from the day's spine, by which point the photo
// had already permanently moved.
//
// reclaimMisplacedPhotos runs once, right after addSpineDwells, and pulls a
// photo back from wherever it landed if a stop added (or widened) by that
// pass now fits it better — same two-gate test (time window ± 5min, distance
// ≤ CONFIRMED_MATCH_M) any photo has to pass to attach to a stop at all, so a
// correctly-placed photo essentially never qualifies for an unrelated dwell.
//
// Run: node --test tests/resolve-day-photo-reclaim.test.mjs

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
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { _internal } = require(path.join(HERE, "..", "lib", "resolve-day.js"));
const { reclaimMisplacedPhotos, RECLAIM_WINDOW_BUFFER_MS, RECLAIM_RADIUS_M } = _internal;

const MIN = 60_000;

// Real Sept 13 numbers.
const E27TH_START = Date.parse("2026-09-13T19:53:38Z");
const E27TH_END = Date.parse("2026-09-13T20:33:45Z");
const HOME_START = Date.parse("2026-09-13T21:00:05Z");
const PHOTO_TS = "2026-09-13T20:32:38.758Z";
const PHOTO_LAT = 40.7397916666667, PHOTO_LON = -73.976355;
const E27TH_LAT = 40.738370961414, E27TH_LON = -73.9744951444737;
const HOME_LAT = 40.742699, HOME_LON = -74.001611;

function baseStops() {
  return [
    {
      id: "s-20260913-4", start_ts_ms: E27TH_START - 90 * MIN, end_ts_ms: E27TH_START - 40 * MIN,
      ...LL(0.0, 0.0), place: { name: "Example Hospital" }, photos: [],
    },
    {
      id: "s-20260913-5", start_ts_ms: HOME_START, end_ts_ms: HOME_START + 125 * MIN,
      lat: HOME_LAT, lon: HOME_LON, place: { name: "Home (Example)" },
      photos: [{ uuid: "E5399CB8-C32B-4AEC-A629-3C760EE23573", ts: PHOTO_TS, filename: "IMG_7089.HEIC" }],
    },
  ];
}

function e27thDwell() {
  return {
    id: "s-20260913-p3", start_ts_ms: E27TH_START, end_ts_ms: E27TH_END,
    lat: E27TH_LAT, lon: E27TH_LON, place: { name: "E Main St", source: "spine_dwell" }, photos: [],
  };
}

test("a photo dropShortStops sent to Home moves to the E Main St dwell added after it", () => {
  const stops = baseStops();
  const dwell = e27thDwell();
  stops.push(dwell);
  const photoRows = [{ uuid: "E5399CB8-C32B-4AEC-A629-3C760EE23573", taken_at: PHOTO_TS,
                       latitude: PHOTO_LAT, longitude: PHOTO_LON }];

  const reclaimed = reclaimMisplacedPhotos(stops, new Set(["s-20260913-p3"]), photoRows);

  assert.equal(reclaimed.length, 1);
  assert.deepEqual(reclaimed[0], { uuid: "E5399CB8-C32B-4AEC-A629-3C760EE23573", from: "s-20260913-5", to: "s-20260913-p3" });
  const home = stops.find(s => s.id === "s-20260913-5");
  const e27th = stops.find(s => s.id === "s-20260913-p3");
  assert.equal(home.photos.length, 0);
  assert.equal(e27th.photos.length, 1);
  assert.equal(e27th.photos[0].uuid, "E5399CB8-C32B-4AEC-A629-3C760EE23573");
});

test("224m from a single-fix spine dwell still qualifies (CONFIRMED_MATCH_M, not the tighter 200m)", () => {
  // The real Sept 13 distance between the photo and E Main St's centroid.
  const distM = haversine(PHOTO_LAT, PHOTO_LON, E27TH_LAT, E27TH_LON);
  assert.ok(distM > 200 && distM < RECLAIM_RADIUS_M, `expected 200 < ${distM} < ${RECLAIM_RADIUS_M}`);
});

test("a photo outside the dwell's time window (even by a hair beyond the buffer) stays put", () => {
  const stops = baseStops();
  const dwell = e27thDwell();
  dwell.end_ts_ms = Date.parse(PHOTO_TS) - RECLAIM_WINDOW_BUFFER_MS - 60_000; // 1 min beyond the buffer
  stops.push(dwell);
  const photoRows = [{ uuid: "E5399CB8-C32B-4AEC-A629-3C760EE23573", taken_at: PHOTO_TS,
                       latitude: PHOTO_LAT, longitude: PHOTO_LON }];

  const reclaimed = reclaimMisplacedPhotos(stops, new Set(["s-20260913-p3"]), photoRows);

  assert.equal(reclaimed.length, 0);
  assert.equal(stops.find(s => s.id === "s-20260913-5").photos.length, 1);
});

test("a photo well outside CONFIRMED_MATCH_M stays put even inside the time window", () => {
  const stops = baseStops();
  const dwell = e27thDwell();
  // Push the dwell 1km away — same window, way too far.
  ({ lat: dwell.lat, lon: dwell.lon } = LL(130.7, 1007.1));
  stops.push(dwell);
  const photoRows = [{ uuid: "E5399CB8-C32B-4AEC-A629-3C760EE23573", taken_at: PHOTO_TS,
                       latitude: PHOTO_LAT, longitude: PHOTO_LON }];

  const reclaimed = reclaimMisplacedPhotos(stops, new Set(["s-20260913-p3"]), photoRows);

  assert.equal(reclaimed.length, 0);
  assert.equal(stops.find(s => s.id === "s-20260913-5").photos.length, 1);
});

test("a correctly-placed photo on a normal day is never pulled into an unrelated new dwell", () => {
  const stops = baseStops();
  // the hospital's own photo, correctly attached, far from the E Main St dwell in time.
  stops[0].photos = [{ uuid: "F0244BE1-F36A-4A4A-8A6A-0B0AD5166AF8", ts: "2026-09-13T19:34:23.247Z" }];
  const dwell = e27thDwell();
  stops.push(dwell);
  const photoRows = [
    { uuid: "F0244BE1-F36A-4A4A-8A6A-0B0AD5166AF8", taken_at: "2026-09-13T19:34:23.247Z",
      ...LLR(-133.68, 18.76) },
  ];

  const reclaimed = reclaimMisplacedPhotos(stops, new Set(["s-20260913-p3"]), photoRows);

  assert.equal(reclaimed.length, 0);
  assert.equal(stops[0].photos.length, 1);
});

test("no added stops (a normal day with no spine dwell) is a silent no-op", () => {
  const stops = baseStops();
  const reclaimed = reclaimMisplacedPhotos(stops, new Set(), []);
  assert.equal(reclaimed.length, 0);
  assert.equal(stops.find(s => s.id === "s-20260913-5").photos.length, 1);
});

test("falls back to the photo's own lat/ts when it isn't in photoRows (JS-shaped photo entries)", () => {
  const stops = baseStops();
  // Give the Home-held photo entry its own lat/lon/ts, as attachPhotosToStop (JS) would.
  stops[1].photos = [{ uuid: "E5399CB8-C32B-4AEC-A629-3C760EE23573", ts: PHOTO_TS, lat: PHOTO_LAT, lon: PHOTO_LON }];
  const dwell = e27thDwell();
  stops.push(dwell);

  const reclaimed = reclaimMisplacedPhotos(stops, new Set(["s-20260913-p3"]), []);

  assert.equal(reclaimed.length, 1);
  assert.equal(stops.find(s => s.id === "s-20260913-p3").photos.length, 1);
});

// Local haversine, independent of the implementation under test.
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 2026-10-16: IMG_7728 (18:04 IDT, 90 m from August) sat on no stop at all: it
// fell in the travel around August, which only existed once his answer built it,
// and the reclaim pass only moved photos already on some other stop.
test("a photo on no stop goes to the late stop it fits; a received one, or one outside it, does not", () => {
  const AUG = { ...LL(7393870.28, 5329665.2) };
  const august = { id: "s-20261016-c4", start_ts_ms: Date.parse("2026-10-16T14:57:27Z"), end_ts_ms: Date.parse("2026-10-16T16:26:29Z"),
                   ...AUG, place: { name: "August", source: "user_confirmed" }, photos: [], from_confirmed_visit: true };
  const flat = { id: "s-20261016-12", start_ts_ms: Date.parse("2026-10-16T18:44:56Z"), end_ts_ms: Date.parse("2026-10-16T21:00:00Z"),
                 ...LL(7386659.22, 5334918.35), place: { name: "The Harbor Flat" },
                 photos: [{ uuid: "ALREADY-ON-A-STOP", ts: "2026-10-16T19:00:00Z" }] };
  const rows = [
    { uuid: "816CD686", taken_at: "2026-10-16T15:04:37Z", ...LLR(7393844.36, 5329565.32), self_captured: true, original_filename: "IMG_7728.HEIC" },
    { uuid: "RECEIVED", taken_at: "2026-10-16T15:10:00Z", ...LLR(7393844.36, 5329565.32), self_captured: false },
    { uuid: "FAR-AWAY", taken_at: "2026-10-16T15:10:00Z", latitude: 32.05, longitude: 34.75, self_captured: true },
    { uuid: "ALREADY-ON-A-STOP", taken_at: "2026-10-16T19:00:00Z", ...LLR(7386659.22, 5334918.35) },
  ];
  const reclaimed = reclaimMisplacedPhotos([august, flat], new Set([august.id]), rows);
  assert.deepEqual(reclaimed, [{ uuid: "816CD686", from: null, to: "s-20261016-c4" }]);
  assert.deepEqual(august.photos, [{ uuid: "816CD686", ts: "2026-10-16T15:04:37Z", filename: "IMG_7728.HEIC" }]);
  assert.equal(flat.photos.length, 1);
});
