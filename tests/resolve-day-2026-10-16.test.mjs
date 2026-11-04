// resolve-day-2026-10-16.test.mjs — Friday in Portside, the day Mason said "is off".
//
// Three resolver defects, each pinned here on the day's own shapes (Israel is UTC+3):
//   1. applySpineVerdicts only clipped a stop's OUTER edges to its place's dwells,
//      so the flat's evening (20:13 to midnight) kept the dinner at Shawarma
//      the restaurant (20:38-21:42, 250 m away) inside it. The spine had already said
//      he was elsewhere. A stop is now cut around a major dwell at another place
//      (day-path's place_id, not distance from the stop's smeared centroid).
//   2. Nothing merged what the late passes left, so the flat shipped as three
//      back-to-back headers 05:39-05:49, 05:49-14:17, 14:17-15:38; and once the
//      night and the morning carried one name, mergeSplitVisits joined them over
//      the 34 km drive to the airport between them.
// The spine half (the dinner as a silence stay) is day-path-silence-stay.test.py.
//
// Run: node --test tests/resolve-day-2026-10-16.test.mjs

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
// The fixtures are a home-zone (US Eastern) day; pin the home zone so a host in
// another zone, or a fresh install, reads them the same.
process.env.JORI_TZ = "America/New_York";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { applySpineVerdicts, mergeTouchingSameName, mergeSplitVisits, reclaimMisplacedPhotos,
        overlayConfirmedVisits, reclaimTargetIds, extendThroughSilence, mergeDuplicateStops } =
  require(path.join(ROOT, "lib/resolve-day.js"))._internal;

const U = (hms) => Date.parse(`2026-10-16T${hms}Z`);
const FLAT = { ...LL(0.0, 0.0) };
const DINNER = { ...LL(156.51, 188.38) };
// resolve-day formats in its module display zone, the home zone unless a run sets it
// (UTC-4 in October); the times below are written as that clock reads them.
const hm = (ms) => new Date(ms - 4 * 3600_000).toISOString().slice(11, 16);

const dwell = (id, name, from, to, at, placeId, extra = {}) => ({
  type: "dwell", id, start_ms: U(from), end_ms: U(to), start: hm(U(from)), end: hm(U(to)),
  major: true, place: { name, tier: name ? "corroborated" : "stay-point", lat: at.lat, lon: at.lon, place_id: placeId },
  ...extra,
});

const stop = (id, name, from, to, extra = {}) => ({
  id, start_ts_ms: U(from), end_ts_ms: U(to), start: hm(U(from)), end: hm(U(to)),
  duration_min: Math.round((U(to) - U(from)) / 60000),
  // the evening cluster's centroid, halfway to the restaurant (as on the day)
  ...LL(102.07, 68.1),
  place: { name, source: "user_confirmed", confidence: 1 },
  confirmed_row: { id: "7b50c688", name, place_type: "named" },
  companions: [], photos: [], ...extra,
});

const SPINE = { spine: [
  dwell("d7", "The Harbor Flat", "17:13:41", "17:18:21", FLAT, 0),
  { type: "leg", id: "l6" },
  dwell("d8", null, "17:38:25", "18:42:40", DINNER, 7, { corroborated_by: "silence", witnessed_min: 0 }),
  { type: "leg", id: "l7" },
  dwell("d9", "The Harbor Flat", "18:44:56", "21:00:00", FLAT, 0),
] };

test("the flat's evening is cut around the dinner the spine placed elsewhere", () => {
  const evening = stop("s-20261016-7", "The Harbor Flat", "17:12:08", "21:00:00", {
    photos: [{ uuid: "at-dinner", ts: "2026-10-16T18:05:00Z" }, { uuid: "at-home", ts: "2026-10-16T19:30:00Z" }],
  });
  const { stops, clipped } = applySpineVerdicts([evening], SPINE);
  // 20:12-20:18 at the door is under ten minutes: not a stop of its own
  assert.equal(stops.length, 1, JSON.stringify(stops.map(s => [s.id, s.start, s.end])));
  assert.equal(stops[0].start, hm(U("18:44:56")));
  assert.equal(stops[0].end, hm(U("21:00:00")));
  assert.equal(stops[0].id, "s-20261016-7");
  assert.deepEqual(stops[0].photos.map(p => p.uuid), ["at-dinner", "at-home"], "no photo is lost in the cut");
  // ...and once the dinner stop exists, the photo taken there moves to it
  const dinner = { id: "s-20261016-p2", start_ts_ms: U("17:38:25"), end_ts_ms: U("18:42:40"), ...DINNER, photos: [] };
  const rows = [{ uuid: "at-dinner", taken_at: "2026-10-16T18:05:00Z", ...{ latitude: DINNER.lat, longitude: DINNER.lon } },
                { uuid: "at-home", taken_at: "2026-10-16T19:30:00Z", latitude: FLAT.lat, longitude: FLAT.lon }];
  reclaimMisplacedPhotos([stops[0], dinner], new Set([dinner.id]), rows);
  assert.deepEqual(dinner.photos.map(p => p.uuid), ["at-dinner"]);
  assert.deepEqual(stops[0].photos.map(p => p.uuid), ["at-home"]);
  assert.deepEqual(clipped[0].carved_around, [{ dwell: "d8", start: hm(U("17:38:25")), end: hm(U("18:42:40")) }]);
});

test("both sides survive when each is long enough", () => {
  const spine = { spine: [dwell("d7", "The Harbor Flat", "16:50:00", "17:18:21", FLAT, 0), ...SPINE.spine.slice(1)] };
  const evening = stop("s-20261016-7", "The Harbor Flat", "16:50:00", "21:00:00");
  const { stops } = applySpineVerdicts([evening], spine);
  assert.deepEqual(stops.map(s => [s.id, s.start, s.end]),
    [["s-20261016-7", hm(U("16:50:00")), hm(U("17:18:21"))], ["s-20261016-7-r1", hm(U("18:44:56")), hm(U("21:00:00"))]]);
});

test("a window he answered for is never cut", () => {
  const evening = stop("s-20261016-7", "The Harbor Flat", "17:12:08", "21:00:00",
    { confirmed_row: { id: "x", name: "The Harbor Flat", place_type: "user-confirmed" } });
  const { stops } = applySpineVerdicts([evening], SPINE);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].start, hm(U("17:12:08")));
});

test("a dwell at the same place (same place_id) is not a departure", () => {
  const spine = { spine: SPINE.spine.map(n => n.id === "d8" ? { ...n, place: { ...n.place, place_id: 0 } } : n) };
  const { stops } = applySpineVerdicts([stop("s-20261016-7", "The Harbor Flat", "17:12:08", "21:00:00")], spine);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].start, hm(U("17:12:08")));
});

test("kill switch", () => {
  process.env.JORI_SPINE_CARVE = "0";
  try {
    const { stops } = applySpineVerdicts([stop("s-20261016-7", "The Harbor Flat", "17:12:08", "21:00:00")], SPINE);
    assert.equal(stops.length, 1);
    assert.equal(stops[0].start, hm(U("17:12:08")));
  } finally { delete process.env.JORI_SPINE_CARVE; }
});

test("one stay at the flat in three touching pieces is one stop", () => {
  const a = stop("s-20261016-1", "The Harbor Flat", "02:39:30", "02:49:44",
    { place: { name: "The Harbor Flat", source: "confirmed_stop" }, photos: [{ uuid: "p1" }] });
  const b = stop("s-20261016-p2", "The Harbor Flat", "02:49:44", "11:17:05",
    { place: { name: "The Harbor Flat", source: "confirmed_stop" }, photos: [{ uuid: "p1" }, { uuid: "p2" }], from_spine: true });
  const c = stop("s-20261016-2", "The Harbor Flat", "11:17:05", "12:38:56",
    { place: { name: "The Harbor Flat", source: "user_confirmed" }, companions: ["Paige"] });
  const later = stop("s-20261016-3", "Abby's apartment", "13:00:57", "14:48:36");
  const { stops, merged } = mergeTouchingSameName([c, later, a, b]);
  assert.deepEqual(stops.map(s => [s.id, s.start, s.end]),
    [["s-20261016-1", hm(U("02:39:30")), hm(U("12:38:56"))], ["s-20261016-3", hm(U("13:00:57")), hm(U("14:48:36"))]]);
  assert.equal(stops[0].place.source, "user_confirmed", "the more authoritative name wins");
  assert.deepEqual(stops[0].photos.map(p => p.uuid), ["p1", "p2"]);
  assert.deepEqual(stops[0].companions, ["Paige"]);
  assert.deepEqual(merged[0].absorbed, ["s-20261016-p2", "s-20261016-2"]);
});

test("a real return is not merged: the drive to the airport sits between", () => {
  const night = stop("s-20261015-p1", "The Harbor Flat", "01:28:00", "01:43:00");
  const back = stop("s-20261016-1", "The Harbor Flat", "02:39:30", "12:38:56");
  const { stops } = mergeTouchingSameName([night, back]);
  assert.equal(stops.length, 2);
});

test("a walk block is never merged into the stop beside it", () => {
  const a = stop("s-1", "The Harbor Flat", "08:00:00", "09:00:00");
  const walk = stop("s-1-loop", "The Harbor Flat", "09:00:00", "09:40:00", { excursion: { from_base: "x" } });
  assert.equal(mergeTouchingSameName([a, walk]).stops.length, 2);
});

test("the night and the morning at the flat stay two visits across the airport drive", () => {
  const night = stop("s-1", "The Harbor Flat", "21:00:00", "01:43:10", { place: { name: "The Harbor Flat", source: "confirmed_stop" }, ...LL(38.92, -5.52) });
  const morning = stop("s-2", "The Harbor Flat", "02:39:30", "02:49:44", { place: { name: "The Harbor Flat", source: "confirmed_stop" }, ...LL(26.67, 16.72) });
  const drive = [["01:44:38", ...PT(705.26, -370.21)], ["01:57:16", ...PT(9566.66, -6638.25)], ["02:28:49", ...PT(3656.57, -1541.57)]]
    .map(([hms, lat, lon]) => ({ ts: U(hms), lat, lon, acc: 5 }));
  assert.equal(mergeSplitVisits([night, morning], drive).length, 2, "34 km away in between: he left");
  assert.equal(mergeSplitVisits([stop("s-1", "The Harbor Flat", "21:00:00", "01:43:10", { place: { name: "The Harbor Flat", source: "confirmed_stop" } }),
    stop("s-2", "The Harbor Flat", "02:39:30", "02:49:44", { place: { name: "The Harbor Flat", source: "confirmed_stop" } })], []).length, 1,
    "with no trace between them they are still one visit recorded twice");
});

test("a stay split around the café keeps each piece to its own part of his window", () => {
  // day-path splits the flat's 05:39-14:20 answer around Café Corvina; both flat
  // pieces carry the row's whole confirmed span, which crushed the café to 1 minute
  const span = { confirmed_start_ms: U("02:39:30"), confirmed_end_ms: U("11:20:09") };
  const visit = (name, from, to, at, extra = {}) => ({ name, ptype: "user-confirmed", start_ms: U(from), end_ms: U(to), ...at, ...extra });
  const cafe = { ...LL(78.51, -17.75) };
  const dayPath = { visits: [
    visit("The Harbor Flat", "02:39:30", "07:18:57", FLAT, span),
    visit("Café Corvina", "07:18:57", "07:57:21", cafe, { confirmed_start_ms: U("07:18:57"), confirmed_end_ms: U("07:57:21") }),
    visit("The Harbor Flat", "07:57:21", "11:20:09", FLAT, span),
  ] };
  const flatStop = stop("s-2", "The Harbor Flat", "02:39:30", "11:20:09", { place: { name: "The Harbor Flat", source: "confirmed_stop" }, ...FLAT });
  const stops = [flatStop];
  overlayConfirmedVisits(stops, dayPath);
  const byName = stops.map(s => [s.place.name, s.start, s.end]);
  assert.deepEqual(byName, [
    ["The Harbor Flat", hm(U("02:39:30")), hm(U("07:18:57"))],
    ["Café Corvina", hm(U("07:18:57")), hm(U("07:57:21"))],
    ["The Harbor Flat", hm(U("07:57:21")), hm(U("11:20:09"))],
  ]);
});

test("photos are handed to stops built from his answers as well as to spine-built ones", () => {
  const ids = reclaimTargetIds([{ id: "a" }, { id: "c2", from_confirmed_visit: true }], [{ id: "p1" }]);
  assert.deepEqual([...ids].sort(), ["c2", "p1"]);
});

test("JORI_CONFIRMED_SPAN_CLIP=0 gives each piece the row's whole span again", () => {
  const span = { confirmed_start_ms: U("02:39:30"), confirmed_end_ms: U("11:20:09") };
  const dayPath = { visits: [{ name: "The Harbor Flat", ptype: "user-confirmed", start_ms: U("02:39:30"), end_ms: U("07:18:57"), ...FLAT, ...span }] };
  const stops = [stop("s-2", "The Harbor Flat", "02:39:30", "07:18:57", { place: { name: "The Harbor Flat", source: "confirmed_stop" }, ...FLAT })];
  process.env.JORI_CONFIRMED_SPAN_CLIP = "0";
  try { overlayConfirmedVisits(stops, dayPath); } finally { delete process.env.JORI_CONFIRMED_SPAN_CLIP; }
  assert.equal(stops[0].end, hm(U("11:20:09")));
});

// 2026-10-17, re-resolving with the day's full camera roll: the photos at the
// table (20:48-20:57) made a rest of the dinner, which ends on the timestamp of
// the first fix elsewhere (21:44:56, walking, 169 m out). extendThroughSilence
// looked only after the end, skipped that fix, and stretched dinner to 22:15.
test("the fix a rest ends on stops the silence stretch: dinner ends 21:44, not at the flat's next fix", () => {
  const LEFT = { ...LL(107.72, 33.4) };   // walking home, 169 m from dinner, 112 m from the flat
  const pings = [
    { ts: U("17:38:25"), ...DINNER }, { ts: U("17:57:24"), ...DINNER },
    { ts: U("18:44:56"), ...LEFT, acc: 14 },
    { ts: U("19:16:42"), ...FLAT, acc: 20 },
  ];
  const stops = [
    stop("s-11", "Shawarma Example", "17:38:25", "18:44:56", { place: { name: "Shawarma Example", source: "user_confirmed" }, ...DINNER }),
    stop("s-12", "The Harbor Flat", "19:16:42", "21:00:00", { place: { name: "The Harbor Flat", source: "confirmed_stop" }, ...FLAT }),
  ];
  extendThroughSilence(stops, pings, null);
  assert.equal(stops[0].end_ts_ms, U("18:44:56"));
});

test("silence after the last fix AT the place is still read as him sitting there", () => {
  const pings = [{ ts: U("17:57:24"), ...DINNER }, { ts: U("18:44:56"), ...FLAT, acc: 14 }];
  const stops = [
    stop("s-11", "Shawarma Example", "17:38:25", "17:57:24", { place: { name: "Shawarma Example", source: "user_confirmed" }, ...DINNER }),
    stop("s-12", "The Harbor Flat", "18:44:56", "21:00:00", { place: { name: "The Harbor Flat", source: "confirmed_stop" }, ...FLAT }),
  ];
  extendThroughSilence(stops, pings, null);
  assert.ok(stops[0].end_ts_ms > U("18:40:00") && stops[0].end_ts_ms <= U("18:44:56"), hm(stops[0].end_ts_ms));
});

// August: 13 minutes where he parked (291 m from the bar, no fix there but the
// row's own), then the hour at the bar where he photographed its sign.
const PARKED = { ...LL(-2034.57, -6171.63) };
const BAR = { ...LL(-2039.24, -5880.23) };
const august = () => [
  stop("s-20261016-c4", "August", "14:57:27", "15:10:16", { ...PARKED }),
  stop("s-20261016-c5", "August", "15:15:42", "16:16:07", { ...BAR }),
];

test("two pieces of one visit joined: the pin goes where he spent longest", () => {
  const out = mergeDuplicateStops(august(), null);
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].lat, out[0].lon], [BAR.lat, BAR.lon]);
  assert.deepEqual([out[0].start, out[0].end], [hm(U("14:57:27")), hm(U("16:16:07"))]);
});

test("a short piece after the long one does not move the pin", () => {
  const [, bar] = august();
  const back = stop("s-20261016-c6", "August", "16:18:00", "16:28:00", { ...PARKED });
  const out = mergeDuplicateStops([bar, back], null);
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].lat, out[0].lon], [BAR.lat, BAR.lon]);
});

test("JORI_MERGE_PIN_LONGEST=0 keeps the first piece's pin", () => {
  process.env.JORI_MERGE_PIN_LONGEST = "0";
  try {
    const out = mergeDuplicateStops(august(), null);
    assert.deepEqual([out[0].lat, out[0].lon], [PARKED.lat, PARKED.lon]);
  } finally { delete process.env.JORI_MERGE_PIN_LONGEST; }
});

test("a photo taken at the other piece (by the car, 18:04) still lands on the joined stop", () => {
  const [joined] = mergeDuplicateStops(august(), null);
  const rows = [{ uuid: "IMG_7728", taken_at: "2026-10-16T15:04:37Z", ...LLR(-2032.86, -6168.85), self_captured: true }];
  const moved = reclaimMisplacedPhotos([joined], new Set([joined.id]), rows);
  assert.deepEqual(moved.map(m => [m.uuid, m.to]), [["IMG_7728", joined.id]]);
});
