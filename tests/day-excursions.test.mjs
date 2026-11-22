// day-excursions.test.mjs — a walk from the nightly base is a slot of its own,
// unless something named claimed the stretch (2026-09-01).
//
// The bug that prompted it, from the 2026-08-31 summary: the afternoon walk with
// the dog is plainly drawn on the map and appears in no sentence. (Synthetic
// places: tests/fixtures/fake-geo.mjs keeps that day's geometry.) Three separate
// causes, all covered here.
//
//   1. The chain store WAS resolved — 15 min, `known_recurring`, confidence 0.92,
//      provenance tier CONFIRMED / certainty "known" — and the renderer's
//      30-minute MAIN_STOP_MIN deleted it anyway, because `isConfirmed` only
//      accepted `user_confirmed`. The `movement_spared_reason` escape hatch
//      written for exactly this case (the 2026-08-14 chain store) could not
//      save it either: that flag is only set on stops that were CANDIDATES for
//      pace-demotion, and markMovementByPace skips `known_recurring` outright.
//      Being confidently named was what disqualified it.
//
//   2. Movement had one slot — the italic travel line — and it degraded to a
//      bare "26 min between stops" because routedMetersBetween apportioned a
//      whole-day street-matched segment by ELAPSED TIME. The day was one
//      2,590 m segment spanning 00:00-21:12, so 26 minutes of walking drew
//      26/1272 of it (53 m) and the rest was charged to sitting at home.
//
//   3. There was no such thing as a walk block at all. Rung 5 of the location
//      spine reports moves and never writes them, so an out-and-back has no
//      representation — it falls inside the gap between two stops.
//
// Run: node --test tests/day-excursions.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { at } from "./fixtures/fake-geo.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { detectExcursions, _internal } = require(path.join(ROOT, "lib/day-excursions.js"));
const { computeProvenance } = require(path.join(ROOT, "lib/daily-summary-confirm.js"));
const render = require(path.join(ROOT, "lib/daily-summary-render.js"));
const { isMainStop, isConfirmed, routedMetersBetween, stopHeaderHtml, MAIN_STOP_MIN } = render._internal;

// ---------------------------------------------------------------------------
// Fixtures: the real 2026-08-31 afternoon, as resolve-day emits it.
// ---------------------------------------------------------------------------

// Synthetic places (tests/fixtures/fake-geo.mjs): `e` metres east and `n` north
// of the home, keeping the real day's geometry.
const LL = (e, n, suf = "") => { const p = at(e, n); return { [`lat${suf}`]: p.lat, [`lon${suf}`]: p.lon }; };
const LLR = (e, n) => { const p = at(e, n); return { latitude: p.lat, longitude: p.lon }; };
const HOME = { ...LL(0.0, 0.0) };
const T = (hhmm) => Date.parse(`2026-08-31T${hhmm}:00-04:00`);

function homeStop(id, start, end, extra = {}) {
  return {
    id, start, end, start_ts_ms: T(start), end_ts_ms: T(end),
    duration_min: Math.round((T(end) - T(start)) / 60000),
    lat: HOME.lat, lon: HOME.lon,
    place: { name: "Home (Example)", source: "named_location", confidence: 0.95 },
    companions: [], photos: [], ...extra,
  };
}

// The 12 street-matched legs day-path produced for that day, trimmed to the
// afternoon. Real numbers: 17:00-17:43 is 2,235 m of walking that got 722 m
// from the front door.
const LEGS = [
  { t0: T("00:00"), t1: T("17:03"), ...LL(74.64, -7.0, "0"), ...LL(211.37, 242.41, "1"), m: 290 },
  { t0: T("17:03"), t1: T("17:04"), ...LL(211.37, 242.41, "0"), ...LL(134.88, 112.42, "1"), m: 164 },
  { t0: T("17:04"), t1: T("17:07"), ...LL(134.88, 112.42, "0"), ...LL(211.37, 242.41, "1"), m: 164 },
  { t0: T("17:07"), t1: T("17:12"), ...LL(211.37, 242.41, "0"), ...LL(291.06, 402.31, "1"), m: 195 },
  { t0: T("17:12"), t1: T("17:14"), ...LL(291.06, 402.31, "0"), ...LL(414.71, 591.01, "1"), m: 245 },
  { t0: T("17:14"), t1: T("17:26"), ...LL(414.71, 591.01, "0"), ...LL(296.7, 403.2, "1"), m: 225 },
  { t0: T("17:26"), t1: T("17:26"), ...LL(296.7, 403.2, "0"), ...LL(414.71, 591.01, "1"), m: 225 },
  { t0: T("17:26"), t1: T("17:27"), ...LL(414.71, 591.01, "0"), ...LL(264.36, 311.24, "1"), m: 325 },
  { t0: T("17:27"), t1: T("17:38"), ...LL(264.36, 311.24, "0"), ...LL(196.71, 191.48, "1"), m: 138 },
  { t0: T("17:38"), t1: T("17:39"), ...LL(196.71, 191.48, "0"), ...LL(264.36, 311.24, "1"), m: 138 },
  { t0: T("17:39"), t1: T("17:43"), ...LL(264.36, 311.24, "0"), ...LL(58.97, -30.69, "1"), m: 415 },
  { t0: T("17:43"), t1: T("17:49"), ...LL(58.97, -30.69, "0"), ...LL(0.0, -0.11, "1"), m: 66 },
];

// One coarse segment for the whole day — the shape that broke the distance math.
const DAY_PATH = {
  segments: [{
    kind: "observed", start_ms: T("00:00"), end_ms: T("21:12"),
    matched_m: 2590, streets: ["8th Avenue", "West 18th Street"], legs: LEGS,
  }],
};

const TARGET = {
  id: "s-20260831-2", start: "17:06", end: "17:21",
  start_ts_ms: T("17:06"), end_ts_ms: T("17:21"), duration_min: 15,
  ...LL(238.83, 286.78),
  place: { name: "Store Example", source: "known_recurring", confidence: 0.92, distance_m: 72 },
  companions: [], photos: [], pattern: "browse", pace_kmh: 3.02,
};

const SLIVER = {
  id: "s-20260831-3", start: "17:25", end: "17:26",
  start_ts_ms: T("17:25"), end_ts_ms: T("17:26"), duration_min: 1,
  ...LL(414.69, 590.97),
  place: { name: null, source: "unknown", confidence: 0 },
  companions: [], photos: [], pattern: "dwell",
  movement_spared_reason: "returned to within 0m of where the window started",
};

// resolvePoint is the only outside dependency detectExcursions takes; stub it so
// the test never touches the network. nearbyFeatures is exercised separately
// against fixed geometry.
const NORTH_OF = at(0, 437.55).lat;   // the boundary between the two neighbourhoods
const stubResolve = (lat) => ({ neighborhood: lat > NORTH_OF ? "North Village" : "Home Quarter" });
// No OSM here either — dominantFeature is exercised directly further down.
const noFeatures = async () => [];
const OPTS = { resolvePoint: stubResolve, features: noFeatures };

// ---------------------------------------------------------------------------
// 1. A named stop inside the stretch means NO walk block.
// ---------------------------------------------------------------------------

test("a named stop inside the stretch takes the slot; no walk block is emitted", async () => {
  const stops = [
    homeStop("s-20260831-1", "00:00", "17:00"),
    TARGET, SLIVER,
    homeStop("s-20260831-4", "17:43", "21:12", {
      place: { name: "Home (Example)", source: "user_confirmed", confidence: 1 },
    }),
  ];
  const { stops: out, excursions } = await detectExcursions(stops, DAY_PATH, OPTS);

  assert.equal(out.filter(s => s.excursion).length, 0, "no walk block when something named is inside");
  assert.equal(out.length, 4, "the stop list is untouched");
  assert.equal(excursions.length, 1, "the stretch is still recorded, so 'why no walk?' is answerable");
  assert.equal(excursions[0].emitted, false);
  assert.match(excursions[0].reason, /named stop inside \(Store Example\)/);
  // The geometry is measured either way — it's what the travel line will state.
  assert.equal(excursions[0].minutes, 43);
  assert.ok(excursions[0].routed_m > 2000, `routed_m ${excursions[0].routed_m}`);
  assert.ok(excursions[0].away_m > 700, `away_m ${excursions[0].away_m}`);
});

// ---------------------------------------------------------------------------
// 2. Nothing named inside => the walk IS the slot.
// ---------------------------------------------------------------------------

test("base -> nothing named -> base becomes one walk block titled by where it went", async () => {
  const stops = [
    homeStop("s-20260831-1", "00:00", "17:00"),
    SLIVER,   // unlabeled: absorbed, never a blocker
    homeStop("s-20260831-3", "17:43", "21:12"),
  ];
  const { stops: out, excursions } = await detectExcursions(stops, DAY_PATH, OPTS);

  assert.equal(out.length, 3, "home, walk, home");
  const walk = out[1];
  assert.ok(walk.excursion, "the middle block is the walk");
  assert.equal(walk.start, "17:00");
  assert.equal(walk.end, "17:43");
  assert.equal(walk.duration_min, 43);
  assert.equal(walk.place.source, "excursion");
  // Turnaround resolved to a different neighborhood than the base -> "Walk to".
  assert.equal(walk.place.name, "Walk to North Village");
  assert.ok(walk.excursion.routed_m > 2000);
  assert.equal(walk.excursion.absorbed.length, 1, "the unlabeled sliver went into the walk");
  assert.equal(walk.excursion.absorbed[0].id, "s-20260831-3");
  assert.equal(excursions.filter(e => e.emitted).length, 1);
  // Ids stay contiguous after the insert.
  assert.deepEqual(out.map(s => s.id), ["s-20260831-1", "s-20260831-2", "s-20260831-3"]);
});

test("a walk that never went anywhere is not a block", async () => {
  const shortPath = { segments: [{ start_ms: T("17:00"), end_ms: T("17:20"), matched_m: 120, legs: [
    { t0: T("17:00"), t1: T("17:20"), lat0: HOME.lat, lon0: HOME.lon, ...LL(20.05, 26.13, "1"), m: 120 },
  ] }] };
  const stops = [homeStop("a", "00:00", "17:00"), homeStop("b", "17:20", "23:00")];
  const { stops: out, excursions } = await detectExcursions(stops, shortPath, OPTS);
  assert.equal(out.filter(s => s.excursion).length, 0);
  assert.match(excursions[0].reason, /never got further than/);
});

test("a day with nowhere settled to have slept has no base, so no walk blocks", async () => {
  const nameless = (id, a, b) => ({ ...homeStop(id, a, b),
    place: { name: null, source: "unknown", confidence: 0 } });
  const stops = [nameless("a", "00:00", "09:00"), nameless("b", "20:00", "23:59")];
  const { stops: out, excursions } = await detectExcursions(stops, DAY_PATH, OPTS);
  assert.equal(out.length, 2);
  assert.equal(excursions.length, 0, "fail-safe: no base, no claims about walks from it");
});

// 2026-08-19 opened with a 0-minute "Tap 42" left over from the night before.
// Reading stops[0] as the base erased every walk that day.
test("a stray sliver at the top of the day does not become the base", async () => {
  const stops = [
    { ...homeStop("a", "00:00", "00:00"), duration_min: 0, ...LL(-4093.81, -4731.88),
      place: { name: "Tap 42", source: "user_confirmed", confidence: 1 } },
    homeStop("b", "00:16", "17:00"),
    homeStop("c", "17:43", "23:59"),
  ];
  const { excursions } = await detectExcursions(stops, DAY_PATH, OPTS);
  assert.equal(excursions.filter(e => e.emitted).length, 1, "the walk between the two home stops survives");
});

// 2026-10-20: the night at the flat reached the day only as a spine dwell, which
// resolve-day adds after this pass, so the first named stop long enough to be a
// base was the lunch 1 km away and the evening walk out of the flat was never a
// block. A remainder carved from the flat's stop also sat out of time order, so
// even a right base saw nothing between the two flat stays.
test("the spine's settled night is the base when no stop covers it", async () => {
  const away = (id, a, b, name) => ({ ...homeStop(id, a, b), ...LL(1805.61, 1938.9),
    place: { name, source: "user_confirmed", confidence: 1 } });
  const spinePath = { ...DAY_PATH, spine: [
    { type: "dwell", id: "d0", start_ms: T("00:00"), end_ms: T("09:00"), major: true,
      place: { name: "Home (Example)", tier: "corroborated", lat: HOME.lat, lon: HOME.lon } },
  ] };
  const stops = [
    away("s-20260831-1", "12:00", "13:30", "Lunch place"),
    homeStop("s-20260831-2", "16:30", "17:00"),
    homeStop("s-20260831-2-r1", "17:43", "21:12"),   // carved remainder, seated by its parent
    SLIVER,
  ];
  const without = await detectExcursions(stops.map(s => ({ ...s })), DAY_PATH, OPTS);
  assert.equal(without.excursions.filter(e => e.emitted).length, 0, "no night in the stops: the lunch was the base");
  const { stops: out, excursions } = await detectExcursions(stops.map(s => ({ ...s })), spinePath, OPTS);
  assert.equal(excursions.filter(e => e.emitted).length, 1, "the walk out of home and back is a block");
  const walk = out.find(s => s.excursion);
  assert.equal(walk.start, "17:00");
  assert.equal(walk.end, "17:43");
  assert.equal(walk.excursion.absorbed.length, 1, "the sliver inside it went into the walk");
  assert.deepEqual(out.map(s => s.start), ["12:00", "16:30", "17:00", "17:43"], "in time order, sliver absorbed");
});

// The same day once Raisa was his own confirmed stop: the 19:12 return to the
// flat had no stop of its own until addSpineDwells, which runs after this pass.
test("a return to the base the trace saw, with no stop yet, still closes the walk", async () => {
  const back = { type: "dwell", id: "d3", start_ms: T("17:43"), end_ms: T("21:12"), start: "17:43", end: "21:12",
    major: true, place: { name: "Home (Example)", tier: "corroborated", lat: HOME.lat, lon: HOME.lon } };
  const { stops: out, excursions } = await detectExcursions(
    [homeStop("s-20260831-1", "00:00", "17:00"), { ...SLIVER }], { ...DAY_PATH, spine: [back] }, OPTS);
  assert.equal(excursions.filter(e => e.emitted).length, 1);
  assert.equal(out.length, 2, "home and the walk; the trace's dwell is not emitted here");
  assert.equal(out[1].start, "17:00");
  assert.equal(out[1].end, "17:43");
  assert.equal(out[1].excursion.absorbed.length, 1);
  assert.deepEqual(out.map(s => s.id), ["s-20260831-1", "s-20260831-2"]);
  assert.ok(!out.some(s => s._anchor));
  // A walk that STARTS from such a dwell is found the same way, with a real id.
  const leave = { ...back, id: "d0", start_ms: T("00:00"), end_ms: T("17:00"), start: "00:00", end: "17:00" };
  const r2 = await detectExcursions([{ ...SLIVER }, homeStop("s-20260831-3", "17:43", "21:12")],
    { ...DAY_PATH, spine: [leave] }, OPTS);
  assert.equal(r2.excursions.filter(e => e.emitted).length, 1);
  assert.deepEqual(r2.stops.map(s => s.id), ["s-20260831-1", "s-20260831-2"]);
  assert.ok(r2.stops[0].excursion);
  // A dwell a stop already covers is no anchor: nothing changes.
  const covered = await detectExcursions(
    [homeStop("s-20260831-1", "00:00", "17:00"), { ...SLIVER }, homeStop("s-20260831-3", "17:43", "21:12")],
    { ...DAY_PATH, spine: [back] }, OPTS);
  assert.equal(covered.stops.length, 3);
  assert.equal(covered.excursions.filter(e => e.emitted).length, 1);
});

test("an unsettled or short opening spine dwell is not the base", async () => {
  const stops = [
    { ...homeStop("a", "12:00", "13:30"), ...LL(1805.61, 1938.9),
      place: { name: "Lunch place", source: "user_confirmed", confidence: 1 } },
    homeStop("b", "16:30", "17:00"), SLIVER, homeStop("c", "17:43", "21:12"),
  ];
  const night = (tier, endHH) => ({ ...DAY_PATH, spine: [{ type: "dwell", id: "d0", start_ms: T("00:00"),
    end_ms: T(endHH), major: true, place: { name: "Home (Example)", tier, lat: HOME.lat, lon: HOME.lon } }] });
  for (const p of [night("stay-point", "09:00"), night("recorded", "09:00"), night("corroborated", "00:30")]) {
    const { excursions } = await detectExcursions(stops.map(s => ({ ...s })), p, OPTS);
    assert.equal(excursions.filter(e => e.emitted).length, 0);
  }
});

// 2026-08-29 ended on a 1-minute Miznon stop after the phone went quiet. Under
// applyAccommodation's first-and-last rule that erased the base and with it
// every walk of the day; the base is where he WOKE, and the return trip is
// required per-stretch rather than of the day as a whole.
test("a day that ends away from home still has a base", async () => {
  const stops = [
    homeStop("a", "00:00", "17:00"),
    homeStop("b", "17:43", "21:12"),
    { ...homeStop("c", "21:20", "21:21"), duration_min: 1, ...LL(-384.35, -274.09),
      place: { name: "Miznon", source: "user_confirmed", confidence: 1 } },
  ];
  const { excursions } = await detectExcursions(stops, DAY_PATH, OPTS);
  assert.equal(excursions.filter(e => e.emitted).length, 1, "the 17:00-17:43 walk survives");
});

// The guard that keeps an unnamed LUNCH from being retitled as a stroll.
test("a long unnamed stop he was still for blocks the walk", async () => {
  const sat = {
    id: "s-2", start: "17:05", end: "17:35",
    start_ts_ms: T("17:05"), end_ts_ms: T("17:35"), duration_min: 30,
    ...LL(331.74, 437.56), pace_kmh: 0.82,
    place: { name: null, source: "unknown", confidence: 0 }, companions: [], photos: [],
  };
  const stops = [homeStop("s-1", "00:00", "17:00"), sat, homeStop("s-3", "17:43", "21:12")];
  const { stops: out, excursions } = await detectExcursions(stops, DAY_PATH, OPTS);
  assert.equal(out.filter(s => s.excursion).length, 0);
  assert.match(excursions[0].reason, /unnamed dwell inside \(30 min at 0\.82 km\/h\)/);
});

// 2026-08-23: a 133-minute absence from home with 1,040 m of path and
// no cluster in it at all. Nothing to judge as an inner dwell, so the stretch
// has to answer for its own pace.
test("a slow stretch with no cluster in it is not a walk", async () => {
  const slowPath = { segments: [{ start_ms: T("17:00"), end_ms: T("19:13"), matched_m: 1040, legs: [
    { t0: T("17:00"), t1: T("18:00"), lat0: HOME.lat, lon0: HOME.lon, ...LL(542.34, 604.36, "1"), m: 520 },
    { t0: T("18:00"), t1: T("19:13"), ...LL(542.34, 604.36, "0"), lat1: HOME.lat, lon1: HOME.lon, m: 520 },
  ] }] };
  const stops = [homeStop("a", "00:00", "17:00"), homeStop("b", "19:13", "23:00")];
  const { stops: out, excursions } = await detectExcursions(stops, slowPath, OPTS);
  assert.equal(out.filter(s => s.excursion).length, 0);
  assert.match(excursions[0].reason, /km\/h over 133 min/);
});

test("a long unnamed cluster he was MOVING through is still part of the walk", async () => {
  const wandering = {
    id: "s-2", start: "17:05", end: "17:35",
    start_ts_ms: T("17:05"), end_ts_ms: T("17:35"), duration_min: 30,
    ...LL(415.98, 582.12), pace_kmh: 3.17,
    place: { name: null, source: "unknown", confidence: 0 }, companions: [], photos: [],
  };
  const stops = [homeStop("s-1", "00:00", "17:00"), wandering, homeStop("s-3", "17:43", "21:12")];
  const { stops: out } = await detectExcursions(stops, DAY_PATH, OPTS);
  assert.equal(out.filter(s => s.excursion).length, 1, "browsing a park at walking pace is the walk");
});

// ---------------------------------------------------------------------------
// 3. Naming is geometry, from a data source — never a guess at a venue.
// ---------------------------------------------------------------------------

test("a river the path ran along names the walk; a park it crossed does not outrank it", () => {
  const { dominantFeature, titleFor } = _internal;
  const points = Array.from({ length: 10 }, (_, i) => at(-637.02, 604.37 + 22.24 * i));
  const river = { name: "North River", kind: "water",
                  geometry: Array.from({ length: 10 }, (_, i) => at(-763.38, 604.37 + 22.24 * i)) };
  const sw = at(-721.27, 493.18), ne = at(-552.77, 826.75);
  const park = { name: "Riverside Example Park", kind: "green",
                 geometry: [{ ...LL(-637.02, 604.37) }],
                 bounds: { minlat: sw.lat, maxlat: ne.lat, minlon: sw.lon, maxlon: ne.lon } };

  const f = dominantFeature(points, [park, river]);
  assert.equal(f.name, "North River");
  assert.equal(titleFor({ feature: f }), "Walk along North River");
  assert.equal(titleFor({ feature: dominantFeature(points, [park]) }), "Walk in Riverside Example Park");
});

test("a feature the path only brushed past does not name the walk", () => {
  const { dominantFeature } = _internal;
  const points = Array.from({ length: 10 }, (_, i) => at(121.14 + 842.4 * i, 604.35));
  const river = { name: "North River", kind: "water", geometry: [{ ...LL(121.14, 604.35) }] };
  assert.equal(dominantFeature(points, [river]), null);
});

test("a feature tagged in the local script is named by its English tag when it has one", () => {
  const { featureName } = _internal;
  assert.equal(featureName({ name: "Plage du Nord", "name:en": "North Beach" }), "North Beach");
  assert.equal(featureName({ name: "Plage du Nord", int_name: "North Beach" }), "North Beach");
  assert.equal(featureName({ name: "Plage du Nord", "name:en": "  " }), "Plage du Nord");
  assert.equal(featureName({ name: "Plage du Nord" }), "Plage du Nord");
  assert.equal(featureName({}), null);
  assert.equal(featureName(null), null);
});

test("a walk named for a beach runs along it, as one named for a river does", () => {
  const { titleFor } = _internal;
  assert.equal(titleFor({ feature: { name: "North Beach", kind: "beach" } }), "Walk along North Beach");
  assert.equal(titleFor({ feature: { name: "Example Park", kind: "green" } }), "Walk in Example Park");
});

test("with no feature and no neighborhood the walk is still a walk", () => {
  const { titleFor } = _internal;
  assert.equal(titleFor({}), "Walk");
  assert.equal(titleFor({ turnNeighborhood: "Home Quarter", baseNeighborhood: "Home Quarter" }), "Walk around Home Quarter");
});

// ---------------------------------------------------------------------------
// 3b. REGRESSION GUARD: a walk INSIDE one district must not read as a walk TO it.
//
// One geocode answers with its finest area (a small neighbourhood) and another,
// a few hundred metres away in the same district, only with the wider name that
// CONTAINS the small one. The two strings differ though the walk never left the
// district, and "Walk to <district>" was written. The start's geocode holds both
// levels (`areas`); a turnaround named after one of them is "around". The rule is
// one-directional and never an intersection of area sets.
// ---------------------------------------------------------------------------

const OLD_QUARTER_AREAS = ["Old Quarter", "Harbour District", "Metro City"];

test("a turnaround named for a wider area that contains the start is 'around', not 'to'", () => {
  const { titleFor } = _internal;
  assert.equal(
    titleFor({ turnNeighborhood: "Harbour District", baseNeighborhood: "Old Quarter", baseAreas: OLD_QUARTER_AREAS }),
    "Walk around Harbour District");
  assert.equal(
    titleFor({ turnNeighborhood: "harbour district", baseNeighborhood: "Old Quarter", baseAreas: OLD_QUARTER_AREAS }),
    "Walk around harbour district", "the match is case-insensitive");
});

test("two different neighbourhoods that share only the city still read 'to'", () => {
  const { titleFor } = _internal;
  // "Metro City" is in both area sets; the turnaround is "Riverside", which is
  // not in the start's areas. Set intersection would have merged them.
  assert.equal(
    titleFor({ turnNeighborhood: "Riverside", baseNeighborhood: "Old Quarter", baseAreas: OLD_QUARTER_AREAS }),
    "Walk to Riverside");
});

test("a start known only coarsely that turns in a finer name keeps 'to' (one direction only)", () => {
  const { titleFor } = _internal;
  assert.equal(
    titleFor({ turnNeighborhood: "Harbour District", baseNeighborhood: "Metro City", baseAreas: ["Metro City"] }),
    "Walk to Harbour District");
});

test("with no baseAreas the title is exactly what it was: 'to' when they differ, 'around' when equal", () => {
  const { titleFor } = _internal;
  for (const baseAreas of [undefined, null, []]) {
    assert.equal(titleFor({ turnNeighborhood: "Harbour District", baseNeighborhood: "Old Quarter", baseAreas }),
                 "Walk to Harbour District");
    assert.equal(titleFor({ turnNeighborhood: "Old Quarter", baseNeighborhood: "Old Quarter", baseAreas }),
                 "Walk around Old Quarter");
  }
  assert.equal(titleFor({ turnNeighborhood: "Harbour District", baseNeighborhood: "Old Quarter" }),
               "Walk to Harbour District");
});

test("driving follows the same rule: 'Drive around' inside the start's district, 'Drive to' otherwise", () => {
  const { titleFor } = _internal;
  const mode = "driving";
  assert.equal(titleFor({ mode, turnNeighborhood: "Harbour District", baseNeighborhood: "Old Quarter", baseAreas: OLD_QUARTER_AREAS }),
               "Drive around Harbour District");
  assert.equal(titleFor({ mode, turnNeighborhood: "Riverside", baseNeighborhood: "Old Quarter", baseAreas: OLD_QUARTER_AREAS }),
               "Drive to Riverside");
  assert.equal(titleFor({ mode, turnNeighborhood: "Harbour District", baseNeighborhood: "Old Quarter" }),
               "Drive to Harbour District");
  assert.equal(titleFor({ mode, turnNeighborhood: "Old Quarter", baseNeighborhood: "Old Quarter", baseAreas: OLD_QUARTER_AREAS }),
               "Drive around Old Quarter");
});

test("a named feature still wins over the neighbourhood rule", () => {
  const { titleFor } = _internal;
  const args = { turnNeighborhood: "Harbour District", baseNeighborhood: "Old Quarter", baseAreas: OLD_QUARTER_AREAS };
  assert.equal(titleFor({ ...args, feature: { name: "North River", kind: "water" } }), "Walk along North River");
  assert.equal(titleFor({ ...args, feature: { name: "Example Park", kind: "green" } }), "Walk in Example Park");
  assert.equal(titleFor({ ...args, mode: "driving", feature: { name: "Example Park", kind: "green" } }), "Drive through Example Park");
});

test("a walk from the base to a wider area holding the base is titled 'around' end to end", async () => {
  // The turnaround resolves only to the wider district; the base's geocode holds
  // both its own small neighbourhood and that district (`areas` from resolve-point).
  const resolvePoint = (lat) => lat > NORTH_OF
    ? { neighborhood: "Harbour District", areas: ["Harbour District", "Metro City"] }
    : { neighborhood: "Old Quarter", areas: OLD_QUARTER_AREAS };
  const stops = [homeStop("s-1", "00:00", "17:00"), SLIVER, homeStop("s-3", "17:43", "21:12")];
  const { stops: out } = await detectExcursions(stops, DAY_PATH, { resolvePoint, features: noFeatures });
  assert.equal(out.find(s => s.excursion).place.name, "Walk around Harbour District");

  // Same geometry, a turnaround in a district the base does not sit in: still "to".
  const elsewhere = (lat) => lat > NORTH_OF
    ? { neighborhood: "Riverside", areas: ["Riverside", "Metro City"] }
    : { neighborhood: "Old Quarter", areas: OLD_QUARTER_AREAS };
  const { stops: out2 } = await detectExcursions(
    [homeStop("s-1", "00:00", "17:00"), SLIVER, homeStop("s-3", "17:43", "21:12")],
    DAY_PATH, { resolvePoint: elsewhere, features: noFeatures });
  assert.equal(out2.find(s => s.excursion).place.name, "Walk to Riverside");
});

// ---------------------------------------------------------------------------
// 4. Provenance + rendering: the walk asserts, it does not hedge.
// ---------------------------------------------------------------------------

test("an excursion's provenance is CONFIRMED/known, not a merged-walk hedge", () => {
  const walk = {
    id: "w", start: "17:00", end: "17:43", duration_min: 43,
    place: { name: "Walk to North Village", source: "excursion", confidence: 0.7 },
    excursion: { routed_m: 2235, away_m: 722, feature: null,
                 turnaround: { neighborhood: "North Village" }, absorbed: [] },
    companions: ["Rover"],
  };
  const p = computeProvenance(walk);
  assert.equal(p.tier, "CONFIRMED");
  assert.equal(p.certainty, "known");
  assert.equal(p.hedge, false);
  assert.equal(p.excursion, true);
  assert.equal(p.title, "Walk to North Village");
  assert.equal(p.title_kind, "movement");

  walk.provenance = p;
  assert.equal(isMainStop(walk), true, "43 min of movement is a slot, not a gap");
  const html = stopHeaderHtml(walk);
  assert.match(html, /<b>Walk to North Village<\/b>/);
  assert.match(html, /1\.4 mi/, "the walk states the distance it covered");
  assert.match(html, /with Rover/);
  assert.doesNotMatch(html, /not a stop/);
});

// ---------------------------------------------------------------------------
// 5. The chain-store regression itself.
// ---------------------------------------------------------------------------

test("a known_recurring venue under the 30-minute bar keeps its block", () => {
  const target = { ...TARGET, provenance: { tier: "CONFIRMED", certainty: "known", title: "Store Example", title_kind: "venue" } };
  assert.ok(target.duration_min < MAIN_STOP_MIN, "precondition: it is a short stop");
  assert.equal(isConfirmed(target), true);
  assert.equal(isMainStop(target), true, "Store Example must survive to the page");
});

test("walking past your own front door is still not a stop", () => {
  const passBy = {
    id: "x", start: "17:00", end: "17:03", duration_min: 3,
    place: { name: "Home (Example)", source: "named_location", confidence: 0.95 },
  };
  assert.equal(isMainStop(passBy), false, "a settled name is not a licence to block-ify 3 minutes");
});

test("a stop he ANSWERED for has no duration floor at all", () => {
  const bouillon = {
    id: "y", start: "12:00", end: "12:06", duration_min: 6,
    place: { name: "Bouillon Republic", source: "user_confirmed", confidence: 1 },
  };
  assert.equal(isMainStop(bouillon), true);
});

// ---------------------------------------------------------------------------
// 6. A movement line without a clock cannot be placed in the day.
// ---------------------------------------------------------------------------

test("the walk between two stops carries the time it started", () => {
  const { movementHtml } = render._internal;
  const a = { id: "a", start: "00:00", end: "17:00", end_ts_ms: T("17:00") };
  const b = { id: "b", start: "17:06", end: "17:21", start_ts_ms: T("17:06") };
  const html = movementHtml({ path: DAY_PATH, routes: [] }, a, b);
  assert.match(html, /^<p class="travel"[^>]*>5:00pm · Walked 0\.\d miles/,
    "the walk starts when the stop before it ended");
});

// ---------------------------------------------------------------------------
// 6. Distance: per-leg, not apportioned across a whole-day blob.
// ---------------------------------------------------------------------------

test("routed metres come from the legs, so a walk is not charged to sitting at home", () => {
  const resolved = { path: DAY_PATH };
  const walkM = routedMetersBetween(resolved, T("17:00"), T("17:43"));
  assert.ok(walkM > 1800 && walkM < 2400, `the 43-minute walk covered ~2.2 km, got ${Math.round(walkM)} m`);

  // The old time-apportioned reading of the same window, for contrast: one
  // segment of 2,590 m over 1,272 minutes gives 43/1272 of it.
  const timeShare = 2590 * ((T("17:43") - T("17:00")) / (T("21:12") - T("00:00")));
  assert.ok(timeShare < 100, `precondition: time-apportionment yields ${Math.round(timeShare)} m`);
  assert.ok(walkM > timeShare * 10, "per-leg beats time-apportionment by an order of magnitude here");
});

test("paths written before legs carried endpoints still fall back to matched_m", () => {
  const legacy = { path: { segments: [{ start_ms: T("12:00"), end_ms: T("14:00"), matched_m: 1000, legs: [] }] } };
  const m = routedMetersBetween(legacy, T("12:00"), T("13:00"));
  assert.ok(Math.abs(m - 500) < 1, `expected half the segment, got ${m}`);
});

// ---------------------------------------------------------------------------
// A walk survives a map-matching outage.
// ---------------------------------------------------------------------------
//
// The excursion pass reads day-path legs for distance and direction, so when the
// public matcher went down on 2026-09-01 it saw no geometry and declined to emit
// any walk at all. resolve-day now hands it straight lines between raw fixes
// instead — short on distance, exact on direction.

const { ensurePathGeometry } = require(path.join(ROOT, "lib/resolve-day.js"))._internal;

test("a walk is still emitted when the map-matcher returns nothing", async () => {
  const dead = { segments: [{ start_ms: T("00:00"), end_ms: T("21:12"), matched_m: 0, legs: [] }],
                 stats: {} };
  const pings = LEGS.map(l => ({ ts: l.t0, lat: l.lat0, lon: l.lon0, acc: 15 }))
    .concat([{ ts: LEGS[LEGS.length - 1].t1, lat: LEGS[LEGS.length - 1].lat1,
               lon: LEGS[LEGS.length - 1].lon1, acc: 15 }]);
  const patched = ensurePathGeometry(dead, pings);

  const stops = [homeStop("s-1", "00:00", "17:00"), homeStop("s-2", "17:43", "21:12")];
  const { stops: out, excursions } = await detectExcursions(stops, patched, OPTS);
  assert.equal(out.filter(s => s.excursion).length, 1, "the walk survives the outage");
  const walk = out.find(s => s.excursion);
  assert.ok(walk.excursion.away_m > 600, "direction is exact: it still went 722 m out");
  assert.ok(walk.excursion.routed_m > 0 && walk.excursion.routed_m < 2235,
    `distance is a floor: ${walk.excursion.routed_m} m vs 2235 m matched`);
  assert.equal(excursions[0].emitted, true);
});

// ---------------------------------------------------------------------------
// A walk keeps its map feature when Overpass is down on a later rebuild.
// ---------------------------------------------------------------------------
//
// nearbyFeatures had no memory: one build of a day read the beach the walk ran
// along, a rebuild during an Overpass outage got nothing and titled the walk by
// the turnaround's neighbourhood instead. The last real answer for the same area
// is kept on disk and used when the service fails.

import fs from "node:fs";
import os from "node:os";

test("a real Overpass answer is kept and used when a later lookup fails", async () => {
  const { nearbyFeatures, FEATURE_CACHE_FRESH_MS } = _internal;
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "ovp-features-"));
  try {
    const pts = [at(0, 0), at(400, 300), at(0, 0)];
    const BEACH = { type: "way", tags: { natural: "beach", name: "Example Beach" },
      geometry: [at(380, 290), at(420, 310)] };
    let asked = 0;
    const up = async () => { asked += 1; return { elements: [BEACH] }; };
    const down = async () => { asked += 1; return null; };

    const first = await nearbyFeatures(pts, { query: up, cacheDir });
    assert.deepEqual(first.map(f => [f.name, f.kind]), [["Example Beach", "beach"]]);
    assert.equal(fs.readdirSync(cacheDir).length, 1, "the answer is written");

    asked = 0;
    const fresh = await nearbyFeatures(pts, { query: down, cacheDir });
    assert.deepEqual(fresh.map(f => f.name), ["Example Beach"], "a fresh answer is used without asking");
    assert.equal(asked, 0);

    const later = Date.now() + FEATURE_CACHE_FRESH_MS + 1000;
    const stale = await nearbyFeatures(pts, { query: down, cacheDir, now: later });
    assert.equal(asked, 1, "an old answer is asked again");
    assert.deepEqual(stale.map(f => f.name), ["Example Beach"], "and still used when the asking fails");

    const nudged = [at(3, 2), at(402, 301), at(3, 2)];
    const again = await nearbyFeatures(nudged, { query: down, cacheDir });
    assert.deepEqual(again.map(f => f.name), ["Example Beach"], "points a few metres off ask the same question");
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("an answer Overpass cut short, or one that found nothing, is never kept and never replaces one", async () => {
  const { nearbyFeatures, FEATURE_CACHE_FRESH_MS } = _internal;
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "ovp-features-"));
  try {
    const pts = [at(0, 0), at(400, 300), at(0, 0)];
    const cut = async () => ({ remark: "runtime error: Query timed out", elements: [] });
    const nothing = async () => ({ elements: [] });
    assert.deepEqual(await nearbyFeatures(pts, { query: cut, cacheDir }), []);
    assert.deepEqual(await nearbyFeatures(pts, { query: nothing, cacheDir }), []);
    assert.equal(fs.readdirSync(cacheDir).length, 0, "neither is written");

    const BEACH = { type: "way", tags: { natural: "beach", name: "Example Beach" },
      geometry: [at(380, 290), at(420, 310)] };
    let asked = 0;
    await nearbyFeatures(pts, { query: async () => ({ elements: [BEACH] }), cacheDir });
    const later = Date.now() + FEATURE_CACHE_FRESH_MS + 1000;
    for (const q of [cut, nothing]) {
      const out = await nearbyFeatures(pts, { query: async (x) => { asked += 1; return q(x); }, cacheDir, now: later });
      assert.deepEqual(out.map(f => f.name), ["Example Beach"], "the kept answer is used instead");
    }
    assert.equal(asked, 2);
    const again = await nearbyFeatures(pts, { query: async () => null, cacheDir, now: later });
    assert.deepEqual(again.map(f => f.name), ["Example Beach"], "and it was not replaced");
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("a failed lookup with nothing kept returns no features and writes nothing", async () => {
  const { nearbyFeatures } = _internal;
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "ovp-features-"));
  try {
    const out = await nearbyFeatures([at(0, 0), at(400, 300)], { query: async () => null, cacheDir });
    assert.deepEqual(out, []);
    assert.equal(fs.readdirSync(cacheDir).length, 0);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The routine walk from home (2026-11-21): a short loop out of the house and
// back on foot is its own named event. Geometry from a real evening (metres east
// / north of the house, synthetic origin): out at 17:26, 596 m east at 17:38,
// back in at 17:49, every fix out there tagged walking, a 13-minute iOS visit row
// in the middle of it that the user was asked about. Titles come from the
// routine-walk config; "Dog" here.
// ---------------------------------------------------------------------------
{
  const { homeLoopConfig, findHomeLoops, applyHomeLoopWalks, dropHomeLoopCompanion, HOME_LOOP_DEFAULTS } =
    require(path.join(ROOT, "lib/day-excursions.js"));
  const TN = (hms) => Date.parse(`2026-11-20T${hms.length === 5 ? hms + ":00" : hms}-05:00`);
  const fixN = (hms, e, n, acc, activity) => ({ ts: TN(hms), ...at(e, n), acc, activity, kind: "transit" });
  const visitN = (hms, e, n, acc = 10) => ({ ts: TN(hms), ...at(e, n), acc, activity: null, kind: "visit" });
  // The named location sits ~70 m off the door, as real ones do: the trace's own
  // points at home decide where the house is.
  const ENTRY = { name: "Home (Example)", kind: "home", ...at(-70, 20) };
  const CFG = homeLoopConfig({ routineWalk: { homes: ["Home (Example)"], companion: "Dog" }, entries: [ENTRY] });
  const EVENING = [
    visitN("16:33:38", -4.7, -12.7, 2),
    fixN("16:46:59", 4.2, 7.2, 3, "unknown"),
    fixN("16:47:54", 0, 0, 13, "unknown"),
    fixN("16:50:10", 1.5, -2, 10, "stationary"),
    fixN("17:26:31", 93, 18.3, 26, "walking"),
    fixN("17:29:07", 164.3, 70.5, 15, "walking"),
    visitN("17:29:55", 380.8, 53.2, 119),        // the iOS visit on the walk: never a point out
    fixN("17:38:07", 590, 84.6, 21, "walking"),
    fixN("17:45:24", 329.7, -15.8, 14, "walking"),
    fixN("17:48:05", 185.7, -19.9, 28, "walking"),
    visitN("17:49:16", -2.3, -25.5, 21),
    fixN("17:50:34", 71.9, 6, 25, "walking"),
    fixN("17:53:20", 12.3, 3, 17, "unknown"),
    fixN("18:00:57", -323.4, -70.9, 1414, "walking"),   // a cell-tower fix: places him nowhere
    fixN("19:05:42", 0, 0, 13, "stationary"),
  ];
  const hm = (ms) => new Date(ms - 5 * 3600_000).toISOString().slice(11, 16);
  const homeN = (id, start, end, extra = {}) => ({
    id, start, end, start_ts_ms: TN(start), end_ts_ms: TN(end), duration_min: Math.round((TN(end) - TN(start)) / 60000),
    ...at(0, 0), place: { name: "Home (Example)", source: "named_location", confidence: 0.95 },
    companions: ["Partner"], photos: [], ...extra,
  });
  const orphanN = () => ({
    id: "s-3", start: "17:29", end: "17:43", start_ts_ms: TN("17:29:55"), end_ts_ms: TN("17:43:07"), duration_min: 13,
    ...at(380.8, 53.2), place: { name: "100 Example St", source: "address", confidence: 0.4 },
    companions: ["Dog"], photos: [{ uuid: "p-walk", ts: "2026-11-20T22:35:00Z" }],
  });

  test("routine walk: the real evening's loop is found, timed from the trace and measured from the door", () => {
    assert.ok(CFG, "the config resolves");
    assert.equal(CFG.title, "Dog's walk");
    const { loops, rejected } = findHomeLoops(EVENING, CFG);
    assert.equal(loops.length, 1, JSON.stringify(rejected));
    const L = loops[0];
    assert.ok(Math.abs(L.away_m - 596) <= 3, `${L.away_m} m out`);
    assert.ok(L.on_foot >= 4, `${L.on_foot} on foot`);
    assert.equal(L.end_ms, TN("17:49:16"), "back home at the visit row's arrival");
    assert.ok(L.start_ms >= TN("17:25:00") && L.start_ms <= TN("17:27:30"), `left ${hm(L.start_ms)}`);
    assert.ok(L.minutes > 20 && L.minutes < 25, `${L.minutes} min`);
    assert.ok(L.longest_silence_min < 10);
  });

  test("routine walk: a silence from one home fix to the next is no walk, and nothing is recorded", () => {
    const quiet = [fixN("23:01:07", 0, 0, 13, "stationary"), fixN("23:50:05", 3, 5, 17, "unknown"), fixN("23:52:15", -1, 0, 8, "stationary")];
    const r = findHomeLoops(quiet, CFG);
    assert.deepEqual([r.loops.length, r.open.length, r.rejected.length], [0, 0, 0]);
  });

  test("routine walk: no fix on foot, a vehicle, a rest out there, a long silence, or too far: not one", () => {
    const base = (pts) => [fixN("16:50", 1, -1, 8, "stationary"), fixN("17:00", 0, 0, 10, "stationary"), ...pts, fixN("17:40", 2, 1, 10, "stationary")];
    const cases = {
      "no fix out of the house on foot": [fixN("17:10", 200, 0, 10, "unknown"), fixN("17:20", 300, 0, 10, "unknown")],
      "a point out of the house was in a vehicle": [fixN("17:10", 200, 0, 10, "walking"), fixN("17:20", 600, 0, 10, "driving")],
      "km/h": [fixN("17:10", 200, 0, 10, "walking"), fixN("17:11", 800, 0, 10, "walking")],
      "stood still": [fixN("17:10", 300, 0, 10, "walking"), fixN("17:14", 305, 3, 10, "stationary"), fixN("17:22", 302, 1, 10, "stationary")],
      "silence out of the house": [fixN("17:08", 300, 0, 10, "walking"), fixN("17:34", 250, 0, 10, "walking")],
      "a longer walk": [fixN("17:10", 600, 0, 10, "walking"), fixN("17:20", 1400, 0, 10, "walking"), fixN("17:30", 500, 0, 10, "walking")],
      "never got further": [fixN("17:10", 120, 0, 5, "walking"), fixN("17:20", 140, 0, 5, "walking")],
    };
    for (const [why, pts] of Object.entries(cases)) {
      const r = findHomeLoops(base(pts), CFG);
      assert.equal(r.loops.length, 0, why);
      assert.equal(r.rejected.length, 1, why);
      assert.ok(r.rejected[0].reason.includes(why), `${why}: ${r.rejected[0].reason}`);
    }
  });

  test("routine walk: added as its own event, the sliver swallowed, the stays at home giving up its minutes", () => {
    // The first stay's window runs a minute into the walk, as iOS departures do.
    const stops = [homeN("s-1", "16:33", "17:28"), orphanN(), homeN("s-4", "17:49", "23:59")];
    const { stops: out, walks } = applyHomeLoopWalks(stops, EVENING, { cfg: CFG, hmFromMs: hm });
    const walk = out.find(s => s.home_loop_walk);
    assert.ok(walk, JSON.stringify(walks));
    assert.equal(walk.place.name, "Dog's walk");
    assert.equal(walk.place.source, "excursion");
    assert.equal(walk.excursion.home_loop, true);
    assert.equal(walk.excursion.mode, "walking");
    assert.equal(walk.excursion.absorbed.length, 1, "the iOS visit is part of the walk");
    assert.deepEqual(walk.photos.map(p => p.uuid), ["p-walk"]);
    assert.deepEqual(walk.companions, [], "the walk's own companion is its title, not a person on it");
    assert.equal(out.find(s => s.id === "s-1").end_ts_ms, walk.start_ts_ms);
    assert.equal(out.find(s => s.id === "s-4").start_ts_ms, walk.end_ts_ms);
    assert.ok(!out.some(s => s.id === "s-3"));
    assert.deepEqual(out.map(s => s.id), ["s-1", walk.id, "s-4"], "in time order");
    assert.equal(walks.filter(w => w.emitted).length, 1);
    // It renders as its own line: a confirmed walk block, always shown.
    const prov = computeProvenance(walk, {});
    assert.equal(prov.excursion, true);
    assert.equal(prov.tier, "CONFIRMED");
    assert.equal(isMainStop({ ...walk, provenance: prov }), true);
  });

  test("routine walk: inside one long stay at home, the stay is cut around it", () => {
    const stops = [homeN("s-1", "16:30", "23:59", { photos: [{ uuid: "early", ts: "2026-11-20T21:40:00Z" }, { uuid: "late", ts: "2026-11-21T00:10:00Z" }] })];
    const { stops: out } = applyHomeLoopWalks(stops, EVENING, { cfg: CFG, hmFromMs: hm });
    assert.deepEqual(out.map(s => s.place.name), ["Home (Example)", "Dog's walk", "Home (Example)"]);
    const [head, walk, tail] = out;
    assert.equal(head.end_ts_ms, walk.start_ts_ms);
    assert.equal(tail.start_ts_ms, walk.end_ts_ms);
    assert.equal(tail.end_ts_ms, TN("23:59"));
    assert.deepEqual(head.photos.map(p => p.uuid), ["early"]);
    assert.deepEqual(tail.photos.map(p => p.uuid), ["late"]);
    assert.deepEqual(tail.companions, ["Partner"], "the people at home stay at home");
  });

  test("routine walk: a walk block another pass built is retitled, keeping what it measured", () => {
    const block = { id: "s-1-loop", start: "17:26", end: "17:49", start_ts_ms: TN("17:26"), end_ts_ms: TN("17:49"), duration_min: 23,
      ...at(590, 84.6), place: { name: "Walk around Example Park", source: "excursion", confidence: 0.7 },
      companions: [], photos: [], excursion: { routed_m: 1180, away_m: 596, kmh: 3.1, mode: "walking", feature: { name: "Example Park", kind: "green" }, absorbed: [] } };
    const { stops: out, walks } = applyHomeLoopWalks([homeN("s-1", "16:33", "17:26"), block, homeN("s-4", "17:49", "23:59")], EVENING, { cfg: CFG, hmFromMs: hm });
    const w = out.find(s => s.id === "s-1-loop");
    assert.equal(w.place.name, "Dog's walk");
    assert.equal(w.excursion.routed_m, 1180);
    assert.equal(w.excursion.feature.name, "Example Park");
    assert.equal(w.home_loop_walk.was, "Walk around Example Park");
    assert.equal(walks.find(x => x.emitted).how, "retitled");
    assert.equal(out.length, 3);
  });

  test("routine walk: the user's own answer inside it is the slot, and nothing changes", () => {
    const answered = { ...orphanN(), place: { name: "Example Bakery", source: "user_confirmed", confidence: 1 } };
    const stops = [homeN("s-1", "16:33", "17:26"), answered, homeN("s-4", "17:49", "23:59")];
    const before = JSON.stringify(stops);
    const { stops: out, walks } = applyHomeLoopWalks(stops, EVENING, { cfg: CFG, hmFromMs: hm });
    assert.equal(JSON.stringify(out), before);
    const w = walks.find(x => x.from === "17:26" || x.from === "17:27");
    assert.equal(w.emitted, false);
    assert.ok(w.reason.includes("Example Bakery"), w.reason);
  });

  test("routine walk: a longer walk built by another pass keeps its own title", () => {
    const long = { id: "s-1-loop", start: "16:50", end: "18:40", start_ts_ms: TN("16:50"), end_ts_ms: TN("18:40"), duration_min: 110,
      ...at(590, 84.6), place: { name: "Walk to Example Town", source: "excursion", confidence: 0.7 }, companions: [], photos: [],
      excursion: { routed_m: 6000, away_m: 2400, mode: "walking", absorbed: [] } };
    const { stops: out, walks } = applyHomeLoopWalks([long], EVENING, { cfg: CFG, hmFromMs: hm });
    assert.equal(out[0].place.name, "Walk to Example Town");
    assert.ok(walks.find(x => !x.emitted && /longer walk/.test(x.reason)));
  });

  test("routine walk: the switch, and no title without a companion or a loop_title", () => {
    assert.equal(homeLoopConfig({ routineWalk: { homes: ["Home (Example)"] }, entries: [ENTRY] }), null);
    assert.equal(homeLoopConfig({ routineWalk: { homes: ["Home (Example)"], companion: "Dog", loop_walk: false }, entries: [ENTRY] }), null);
    assert.equal(homeLoopConfig({ routineWalk: { homes: ["Elsewhere"], companion: "Dog" }, entries: [ENTRY] }), null, "no home, no walk");
    const t = homeLoopConfig({ routineWalk: { companion: "Dog", loop_title: "Evening stroll", loop_thresholds: { max_min: 30 } }, entries: [ENTRY] });
    assert.equal(t.title, "Evening stroll");
    assert.equal(t.max_min, 30);
    assert.equal(t.min_away_m, HOME_LOOP_DEFAULTS.min_away_m);
    assert.equal(t.homes[0].name, "Home (Example)", "default homes: every entry of kind home");
    const was = process.env.JORI_HOME_LOOP_WALK;
    process.env.JORI_HOME_LOOP_WALK = "0";
    try {
      assert.equal(homeLoopConfig({ routineWalk: { companion: "Dog" }, entries: [ENTRY] }), null);
      const stops = [homeN("s-1", "16:33", "17:26"), orphanN(), homeN("s-4", "17:49", "23:59")];
      assert.equal(applyHomeLoopWalks(stops, EVENING, { cfg: homeLoopConfig({ routineWalk: { companion: "Dog" }, entries: [ENTRY] }) }).stops.length, 3);
    } finally {
      if (was === undefined) delete process.env.JORI_HOME_LOOP_WALK; else process.env.JORI_HOME_LOOP_WALK = was;
    }
  });

  test("routine walk: one loose point out of the house is too weak alone", () => {
    // 23:32 at home, one walking fix 167 m out at ±33 m, home again at 23:48.
    const r = findHomeLoops([fixN("23:20", 1, 1, 13, "stationary"), fixN("23:32:45", 0, 1, 13, "unknown"),
      fixN("23:46:23", 160, -48, 33, "walking"), visitN("23:48:50", -1, -19, 11)], CFG);
    assert.equal(r.loops.length, 0);
    assert.match(r.rejected[0].reason, /too weak alone/);
  });

  test("routine walk: a quiet way back that could hide a stop, or only loose points out, is no walk", () => {
    const home = [fixN("17:00", 0, 0, 10, "stationary"), fixN("17:05", 1, 1, 10, "stationary")];
    const slowBack = findHomeLoops([...home, fixN("17:20", 200, 0, 10, "walking"), fixN("17:30", 300, 0, 10, "walking"),
      fixN("17:49", 2, 0, 10, "unknown")], CFG);
    assert.equal(slowBack.loops.length, 0);
    assert.match(slowBack.rejected[0].reason, /silence/);
    const loose = findHomeLoops([...home, fixN("17:20", 160, 0, 55, "walking"), fixN("17:27", 158, 8, 55, "unknown"),
      fixN("17:30", 2, 0, 10, "unknown")], CFG);
    assert.equal(loose.loops.length, 0);
    assert.match(loose.rejected[0].reason, /too weak alone/);
  });

  test("routine walk: the stops handed in are left as they were (resolve-day falls back to them)", () => {
    const stops = [homeN("s-1", "16:30", "23:59"), orphanN()];
    const before = JSON.stringify(stops);
    const { stops: out } = applyHomeLoopWalks(stops, EVENING, { cfg: CFG, hmFromMs: hm });
    assert.equal(JSON.stringify(stops), before);
    assert.equal(out.length, 3);
  });

  test("routine walk: a named place right by the house is a destination, not the house", () => {
    const neighbour = { id: "s-n", start: "17:40", end: "17:44", start_ts_ms: TN("17:40"), end_ts_ms: TN("17:44"), duration_min: 4,
      ...at(110, 0), place: { name: "Example Neighbour", source: "user_confirmed", confidence: 1 }, companions: [], photos: [] };
    const stops = [homeN("s-1", "16:33", "17:28"), neighbour, homeN("s-4", "17:49", "23:59")];
    const { stops: out, walks } = applyHomeLoopWalks(stops, EVENING, { cfg: CFG, hmFromMs: hm });
    assert.ok(!out.some(s => s.home_loop_walk));
    assert.ok(walks.some(w => !w.emitted && /Example Neighbour/.test(w.reason)), JSON.stringify(walks));
  });

  test("routine walk: a morning walk after a silent night leaves from the night's stay", () => {
    const night = homeN("s-1", "00:00", "07:40");
    const morning = [fixN("07:42", 120, 30, 12, "walking"), fixN("07:47", 380, 60, 15, "walking"),
      fixN("07:52", 200, -10, 14, "walking"), fixN("07:56", 3, 2, 9, "unknown"), fixN("08:20", 0, 1, 8, "stationary")];
    const { stops: out, walks } = applyHomeLoopWalks([night, homeN("s-2", "07:56", "12:00")], morning, { cfg: CFG, hmFromMs: hm });
    const w = out.find(s => s.home_loop_walk);
    assert.ok(w, JSON.stringify(walks));
    assert.equal(w.end_ts_ms, TN("07:56"));
  });

  test("routine walk: a later pass's people never put the walk's own companion on it", () => {
    const stops = [{ id: "w", companions: ["Dog", "Partner", { name: "Dog" }], home_loop_walk: { companion: "Dog" } },
                   { id: "h", companions: ["Dog", "Partner"] }];
    dropHomeLoopCompanion(stops);
    assert.deepEqual(stops[0].companions, ["Partner"]);
    assert.deepEqual(stops[1].companions, ["Dog", "Partner"], "other stops keep everyone");
  });
}
