// resolve-day-non-stop-walk.test.mjs — one city day (synthetic places).
//
// The summary said Restaurant Example → "walked 10 miles" → Bakery chain, and the Bakery chain block
// carried every photo of the afternoon. Two bugs:
//   1. The Library (136 min) was flagged `user_non_stop` because a
//      22-min `[ask-gate same-stay]` row overlapped it — a row that says the user
//      was STILL there — and dropUndescribedNonStops deleted it.
//   2. The Old Town walk was four "not a stop" clusters; each was dropped
//      (correctly) and nothing replaced them, so the walk had no slot.
//
// Run: node --test tests/resolve-day-non-stop-walk.test.mjs

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
const { classifyStops, _internal } = require(path.join(ROOT, "lib/resolve-day.js"));
const { dropUndescribedNonStops } = _internal;

const T = (hhmm) => Date.parse(`2026-10-12T${hhmm}:00Z`);
const iso = (hhmm) => `2026-10-12T${hhmm}:00+00:00`;

function segStop(startHm, endHm, lat, lon, name) {
  return { start_ts_ms: T(startHm), end_ts_ms: T(endHm), centroid: { lat, lon },
           primary: { name, source: "osm_overpass", confidence: 0.5 } };
}

test("a same-stay non-stop row does not erase the stay it continues", () => {
  const [lib] = classifyStops([segStop("12:15", "14:31", ...PT(40.65, -185.7), "הספרייה הלאומית")], {
    date: "2026-10-12", knownStopsEntries: [],
    userConfirmed: [{ id: "68fec830", place_type: "non-stop", place_name: "(photo-inferred)",
      arrived_at: iso("13:38"), departed_at: iso("14:01"), ...LLR(0.0, 0.0),
      notes: "[ask-gate same-stay] continues f1026449 from 2026-10-12T13:14:06+00:00" }],
  });
  assert.equal(lib.user_non_stop, false);
});

test("a non-stop row covering a sliver of a long stop does not flag it", () => {
  const [lib] = classifyStops([segStop("12:15", "14:31", ...PT(40.65, -185.7), "Library")], {
    date: "2026-10-12", knownStopsEntries: [],
    userConfirmed: [{ id: "x", place_type: "non-stop", place_name: null,
      arrived_at: iso("14:10"), departed_at: iso("14:31"), ...LLR(37.81, -189.03), notes: "" }],
  });
  assert.equal(lib.user_non_stop, false);
});

test("a non-stop row covering most of a stop still flags it", () => {
  const [cafe] = classifyStops([segStop("09:57", "10:48", ...PT(2571.15, -10.8), "Coffee chain")], {
    date: "2026-10-12", knownStopsEntries: [],
    userConfirmed: [{ id: "1bfa61e3", place_type: "non-stop", place_name: null,
      arrived_at: iso("09:40"), departed_at: iso("10:46"), ...LLR(2561.7, -14.14), notes: "" }],
  });
  assert.equal(cafe.user_non_stop, true);
});

function stop(id, s, e, extra = {}) {
  return { id, start: s, end: e, start_ts_ms: T(s), end_ts_ms: T(e), duration_min: (T(e) - T(s)) / 60000,
           ...LL(2448.26, 33.65), place: { name: id, source: "osm_overpass" }, photos: [], ...extra };
}

// A walking-pace path through the window (≈4 km/h).
function walkPath(from, to) {
  const legs = [];
  for (let t = T(from); t < T(to); t += 5 * 60_000) {
    legs.push({ t0: t, t1: t + 5 * 60_000, m: 330, ...LL(2164.7, -77.61, "0"), ...LL(2448.26, 33.65, "1") });
  }
  return { segments: [{ legs }] };
}

test("a long run of non-stops becomes a walk block that keeps its photos", async () => {
  const lunch = stop("lunch", "07:05", "09:00", { place: { name: "Restaurant Example", source: "user_confirmed" } });
  const bakery = stop("bakery", "11:16", "12:04", { place: { name: "Bakery chain", source: "spine_dwell" },
    photos: [{ uuid: "old-city", ts: "2026-10-12T09:30:00Z" }, { uuid: "cake", ts: "2026-10-12T11:40:00Z" }] });
  const stops = [
    lunch,
    stop("luther", "09:54", "09:55", { user_non_stop: true }),
    stop("cafe", "09:57", "10:48", { user_non_stop: true, photos: [{ uuid: "gate", ts: "2026-10-12T10:20:00Z" }] }),
    stop("aroma", "10:52", "11:16", { user_non_stop: true }),
    bakery,
  ];
  const userConfirmed = [
    { place_type: "non-stop", place_name: null, arrived_at: iso("09:24"), departed_at: iso("09:40"), notes: "[passage-auto jev] jev: walk (1.00)" },
    { place_type: "non-stop", place_name: null, arrived_at: iso("09:40"), departed_at: iso("10:46"), notes: "" },
  ];
  const { dropped, walks } = await dropUndescribedNonStops(stops, {
    userConfirmed, dayPath: walkPath("09:24", "11:16"),
    resolvePoint: () => ({ neighborhood: "Old Town" }), features: async () => [], hm: (ms) => new Date(ms).toISOString().slice(11, 16),
  });
  assert.equal(dropped.length, 3);
  assert.equal(walks.length, 1);
  const walk = stops.find(s => s.excursion && s.excursion.non_stop_run);
  assert.ok(walk, "walk block emitted");
  assert.equal(walk.place.name, "Walk around Old Town");
  assert.equal(walk.start, "09:24");   // widened to the first non-stop row
  assert.equal(walk.end, "11:16");
  assert.deepEqual(stops.map(s => s.id), ["lunch", walk.id, "bakery"]);
  assert.deepEqual(walk.photos.map(p => p.uuid).sort(), ["gate", "old-city"]);
  assert.deepEqual(bakery.photos.map(p => p.uuid), ["cake"]);
});

// 2026-10-19, Jerusalem: the fixes from Sabich Example to Example Stadium. A short
// walk back to the car near Cedar St, the drive to Mall Example (the phone's motion
// sensor says "driving"), then parked. The 18:05 sliver chained to the Mall Example
// non-stop row across the drive and shipped as "Walk around Old Quarter".
const T19 = (hms) => Date.parse(`2026-10-19T${hms}Z`);
const DRIVE_FIXES = [
  ["15:05:45", ...PT(1065.26, 597.17), 4, "stationary", "visit"],
  ["15:05:52", ...PT(931.04, 611.61), 23, "walking"], ["15:10:09", ...PT(1060.54, 577.16), 4, "walking"],
  ["15:14:25", ...PT(930.11, 485.96), 5, "driving"], ["15:20:21", ...PT(-218.34, 798.38), 50, "driving"],
  ["15:22:33", ...PT(-448.97, 852.87), 5, "driving"], ["15:25:21", ...PT(-835.71, -1017.4), 5, "driving"],
  ["15:30:22", ...PT(-1347.39, -2816.48), 5, "driving"], ["15:36:46", ...PT(-1112.0, -3266.85), 5, "driving"],
  ["15:37:11", ...PT(-576.82, -3666.08), 5, "stationary", "visit"], ["15:41:47", ...PT(-576.82, -3666.08), 5, "driving"],
  ["15:46:37", ...PT(915.89, 877.37), null, null, "visit"],      // photo-synthesized row, tagged at the market
  ["15:48:05", ...PT(-759.32, -3522.63), 28, "walking"],
].map(([t, lat, lon, acc, activity, kind]) => ({ ts: T19(t), lat, lon, acc, activity, kind: kind || "transit" }));

function stop19(id, s, e, extra = {}) {
  return { id, start: s, end: e, start_ts_ms: T19(`${s}:00`), end_ts_ms: T19(`${e}:00`),
           duration_min: (T19(`${e}:00`) - T19(`${s}:00`)) / 60000,
           ...LL(1030.29, 589.38), place: { name: id, source: "osm_overpass" }, photos: [], ...extra };
}

test("a run of non-stops chained across a drive is not a walk block (2026-10-19)", async () => {
  const aricha = stop19("aricha", "12:58", "15:02", { place: { name: "Sabich Example", source: "user_confirmed" } });
  const teddy = stop19("teddy", "16:01", "19:20", { place: { name: "Example Stadium", source: "user_confirmed" } });
  const stops = [aricha, stop19("sliver", "15:05", "15:06", { user_non_stop: true }), teddy];
  const userConfirmed = [
    { place_type: "non-stop", place_name: null, arrived_at: "2026-10-19T15:05:45+00:00", departed_at: "2026-10-19T15:14:35+00:00",
      notes: "[passage-auto geometry] no rest" },
    { place_type: "non-stop", place_name: null, arrived_at: "2026-10-19T15:37:11+00:00", departed_at: "2026-10-19T15:48:05+00:00",
      notes: "[passage-auto geometry] no rest" },
  ];
  const { dropped, walks } = await dropUndescribedNonStops(stops, {
    userConfirmed, dayPath: { segments: [{ legs: [] }] }, pings: DRIVE_FIXES,
    resolvePoint: () => ({ neighborhood: "נחלאות" }), features: async () => [], hm: (ms) => new Date(ms).toISOString().slice(11, 16),
  });
  assert.equal(walks.length, 0);
  assert.deepEqual(stops.map(s => s.id), ["aricha", "teddy"]);
  assert.equal(dropped.length, 1);
  assert.ok(dropped[0].not_a_walk && dropped[0].not_a_walk.walked_share < 0.1, JSON.stringify(dropped[0]));
});

test("walked share: a crawl in traffic the phone called driving is not walked", () => {
  const { walkedShareOfFixes } = _internal;
  const crawl = [["12:24:01", ...PT(2183.58, 26.92), "unknown"], ["12:31:55", ...PT(2065.42, 54.69), "driving"],
                 ["12:39:36", ...PT(1826.27, 4.61), "driving"], ["12:46:38", ...PT(1282.74, 22.32), "driving"]]
    .map(([t, lat, lon, activity]) => ({ ts: T19(t), lat, lon, acc: 5, activity, kind: "transit" }));
  assert.ok(walkedShareOfFixes(crawl, T19("12:24:00"), T19("12:47:00")) < 0.2);
  const walk = crawl.map(p => ({ ...p, activity: "walking" }));
  assert.equal(walkedShareOfFixes(walk, T19("12:24:00"), T19("12:47:00")), 1);
  assert.equal(walkedShareOfFixes(null, 0, Infinity), null);           // no fixes handed in: no opinion
  assert.equal(walkedShareOfFixes(walk.slice(0, 2), T19("12:24:00"), T19("12:47:00")), null);  // under 500 m
});

test("walking fixes keep the walk block", async () => {
  const lunch = stop("lunch", "07:05", "09:00", { place: { name: "Restaurant Example", source: "user_confirmed" } });
  const bakery = stop("bakery", "11:16", "12:04", { place: { name: "Bakery chain", source: "spine_dwell" } });
  const stops = [lunch, stop("cafe", "09:57", "10:48", { user_non_stop: true }), bakery];
  const pings = [];
  for (let t = T("09:24"), i = 0; t <= T("11:16"); t += 2 * 60_000, i++) {
    const leg = i % 20 < 10 ? i % 20 : 20 - (i % 20);   // up the street and back, ~130 m every 2 min
    const o = fakeAt(0, 0);
    pings.push({ ts: t, lat: o.lat + 0.0012 * leg, lon: o.lon, acc: 8, activity: i === 0 ? "driving" : "walking", kind: "transit" });
  }
  const { walks } = await dropUndescribedNonStops(stops, {
    userConfirmed: [{ place_type: "non-stop", place_name: null, arrived_at: iso("09:24"), departed_at: iso("10:46"), notes: "" }],
    dayPath: walkPath("09:24", "11:16"), pings,
    resolvePoint: () => ({ neighborhood: "Old Town" }), features: async () => [], hm: (ms) => new Date(ms).toISOString().slice(11, 16),
  });
  assert.equal(walks.length, 1);
});

test("a short lone non-stop is still just dropped", async () => {
  const stops = [stop("a", "08:00", "09:00"), stop("x", "09:28", "09:35", { user_non_stop: true }), stop("b", "10:00", "11:00")];
  const { dropped, walks } = await dropUndescribedNonStops(stops, {
    userConfirmed: [], dayPath: walkPath("09:00", "10:00"), resolvePoint: () => null, features: async () => [],
  });
  assert.equal(dropped.length, 1);
  assert.equal(walks.length, 0);
  assert.deepEqual(stops.map(s => s.id), ["a", "b"]);
});

test("a Hebrew name matches itself, so its twin stops merge (2026-10-12 Example dish)", () => {
  const { mergeDuplicateStops } = _internal;
  const a = stop("c1", "14:35", "16:02", { ...LL(618.15, 978.53), place: { name: "אישטבח", source: "user_confirmed" } });
  const b = stop("s8", "16:05", "16:07", { ...LL(789.23, 935.18), place: { name: "אישטבח", source: "user_confirmed" } });
  const out = mergeDuplicateStops([a, b], null);
  assert.equal(out.length, 1);
  assert.equal(out[0].end_ts_ms, T("16:07"));
});

test("the spine does not drop a stop as 'elsewhere' when elsewhere is the same named place", () => {
  const { applySpineVerdicts } = _internal;
  const st = stop("s9", "14:35", "16:07", { ...LL(789.23, 935.18), place: { name: "אישטבח", source: "user_confirmed" },
    photos: [{ uuid: "meal", ts: "2026-10-12T14:47:24Z" }] });
  const dayPath = { spine: [{ type: "dwell", id: "d6", start_ms: T("14:35"), end_ms: T("16:07"),
    place: { name: "אישטבח", ...LL(618.15, 978.53) } }] };
  const { stops, dropped } = applySpineVerdicts([st], dayPath);
  assert.equal(dropped.length, 0);
  assert.equal(stops[0].photos.length, 1);
});

// 2026-10-21, Portside: the walk home from הקוסם held two non-stop windows 45 min
// apart (14:44-15:00, 15:45-17:13). Each run widened over the other's non-stop
// row (14:44-15:17, 15:45-16:02), so both started at 14:44 and the day shipped
// two overlapping walks, "not a stop" 14:44-16:02 and a walk 14:44-17:13.
test("two runs the widening carries onto the same time are one walk (2026-10-21)", async () => {
  const kosem = stop("kosem", "11:24", "11:44", { place: { name: "הקוסם", source: "user_confirmed" } });
  const flat = stop("flat", "14:13", "17:36", { place: { name: "The Harbor Flat", source: "confirmed_stop" } });
  const stops = [
    kosem,
    stop("carmel", "11:44", "12:00", { user_non_stop: true }),
    stop("ada", "12:45", "14:13", { user_non_stop: true, companions: ["Paige", "Yuri"],
      photos: [{ uuid: "walk", ts: "2026-10-12T12:57:00Z" }] }),
    flat,
  ];
  const userConfirmed = [
    { place_type: "non-stop", place_name: null, arrived_at: iso("11:44"), departed_at: iso("12:17"), notes: "" },
    { place_type: "non-stop", place_name: null, arrived_at: iso("12:45"), departed_at: iso("13:02"), notes: "[passage-auto jev] jev: walk (0.96)" },
  ];
  const { dropped, walks } = await dropUndescribedNonStops(stops, {
    userConfirmed, dayPath: walkPath("11:44", "14:13"),
    resolvePoint: () => ({ neighborhood: "Harbor City Center" }), features: async () => [], hm: (ms) => new Date(ms).toISOString().slice(11, 16),
  });
  assert.equal(walks.length, 1, JSON.stringify(walks));
  assert.equal(dropped.length, 2);
  const walk = stops.find(s => s.excursion && s.excursion.non_stop_run);
  assert.equal(walk.start, "11:44");
  assert.equal(walk.end, "14:13");
  assert.equal(walk.excursion.absorbed.length, 2);
  assert.deepEqual(walk.companions, ["Paige", "Yuri"]);
  assert.deepEqual(walk.photos.map(p => p.uuid), ["walk"]);
  assert.deepEqual(stops.map(s => s.id), ["kosem", walk.id, "flat"]);
});

test("two runs a surviving stop separates stay two walks", async () => {
  const stops = [
    stop("a", "08:00", "09:00", { place: { name: "A", source: "user_confirmed" } }),
    stop("x", "09:00", "09:40", { user_non_stop: true }),
    stop("cafe", "09:50", "10:30", { place: { name: "Café", source: "user_confirmed" } }),
    stop("y", "10:30", "11:10", { user_non_stop: true }),
    stop("b", "11:10", "12:00", { place: { name: "B", source: "user_confirmed" } }),
  ];
  const { walks } = await dropUndescribedNonStops(stops, {
    userConfirmed: [{ place_type: "non-stop", place_name: null, arrived_at: iso("09:00"), departed_at: iso("11:10"), notes: "" }],
    dayPath: walkPath("09:00", "11:10"),
    resolvePoint: () => ({ neighborhood: "Old Town" }), features: async () => [], hm: (ms) => new Date(ms).toISOString().slice(11, 16),
  });
  assert.equal(walks.length, 2);
  assert.deepEqual(stops.map(s => s.id).filter(id => !id.endsWith("-walk")), ["a", "cafe", "b"]);
  const w = stops.filter(s => s.excursion);
  assert.ok(w[0].end_ts_ms <= T("09:50") && w[1].start_ts_ms >= T("10:30"), "each walk stops at the café");
});
