// daily-summary-spine.test.mjs — the travel line between two stops reads the
// day spine, not a time-window intersection over segments (2026-09-07).
//
// Run: node --test tests/daily-summary-spine.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
process.env.JORI_TZ = process.env.JORI_TZ || "America/Toronto"; // the fixtures are US-Eastern days; set before the libs load
const { buildManifest, buildSkeleton, _internal } = require("../lib/daily-summary-render.js");
const { movementHtml } = _internal;

const T = (h, m) => Date.UTC(2026, 8, 6, h + 4, m);   // home time (UTC-4 in September) -> UTC

function stop(id, name, s, e) {
  return { id, place_name: name, start: s, end: e, start_ts_ms: T(...s.split(":").map(Number)),
           end_ts_ms: T(...e.split(":").map(Number)), place: { name, source: "user_confirmed" } };
}

const home = stop("home", "Home (Eastside)", "10:07", "13:18");
const theatre = stop("th", "Golden Theatre", "13:47", "16:42");
const home2 = stop("home2", "Home (Eastside)", "16:52", "23:59");

const spine = [
  { type: "dwell", id: "d0", place: { name: "Home (Eastside)", tier: "corroborated" }, start: "10:07", end: "13:18", mins: 191, major: true },
  { type: "leg", id: "l0", from: "d0", to: "d1", from_name: "Home (Eastside)", to_name: "Golden Theatre",
    start: "13:18", end: "13:47", start_ms: T(13, 18), end_ms: T(13, 47), mins: 29, mode: "walking",
    routed_m: 2317, straight_m: 2200, geometry: "map_matched", streets: ["Main Street", "Oak Avenue"],
    holes: [], confidence: "observed", first_fix: "13:19", last_fix: "13:46" },
  { type: "dwell", id: "d1", place: { name: "Golden Theatre", tier: "user-confirmed" }, start: "13:47", end: "16:42", mins: 175, major: true },
  { type: "leg", id: "l1", from: "d1", to: "d2", from_name: "Golden Theatre", to_name: "Home (Eastside)",
    start: "16:42", end: "16:52", start_ms: T(16, 42), end_ms: T(16, 52), mins: 10, mode: "riding", mode_uncertain: true,
    routed_m: 2630, straight_m: 2472, geometry: "map_matched", streets: ["Oak Avenue"],
    holes: [{ t0: "16:45", t1: "16:50", m: 1514, min: 5 }], confidence: "partly inferred" },
  { type: "dwell", id: "d2", place: { name: "Home (Eastside)", tier: "stay-point" }, start: "16:52", end: "23:59", mins: 427, major: true },
];

const resolved = {
  date: "2026-09-06", stops: [home, theatre, home2], routes: [],
  // an old-style whole-day segment that the time-window path would have
  // apportioned -- it must be ignored when a spine is present
  path: { stats: { walked_km: 1.9 }, segments: [{ start_ms: T(0, 0), end_ms: T(23, 59), matched_m: 9000,
          streets: ["Broadway", "West 27th Street"], legs: [] }], spine,
          unsupported_records: [{ name: "10 Example St", claimed: "12:10–23:38", reason: "every fix during it is elsewhere" }] },
  map_url: "https://example.test/map.png",
};

test("the walk up reads the spine leg: its metres, its streets, no whole-day blob", () => {
  const html = movementHtml(resolved, home, theatre);
  assert.match(html, /Walked 1\.4 miles along Main Street and Oak Avenue, about 29 min\./);
  assert.doesNotMatch(html, /Broadway/);
});

test("routes[] calling the window 'drove' does not silence a walking spine leg", () => {
  const r = JSON.parse(JSON.stringify(resolved));
  // location-segment's coarse leg: one 'drove' from a 10:11 fix at home to a
  // 13:38 fix near the theatre, across the stint at home (2026-09-06)
  r.routes = [{ legs: [{ start: new Date(T(10, 11)).toISOString(), end: new Date(T(13, 38)).toISOString(), mode: "drove", distance_km: 2.9 }] }];
  const html = movementHtml(r, home, theatre);
  assert.match(html, /Walked 1\.4 miles along Main Street and Oak Avenue/);
});

test("a riding leg is not narrated as a walk", () => {
  assert.equal(movementHtml(resolved, theatre, home2), "");
});

test("a hole in a walking leg is never narrated (GPS silence is not prose, 2026-10-11)", () => {
  const r = JSON.parse(JSON.stringify(resolved));
  r.path.spine[3].mode = "walking";
  const html = movementHtml(r, theatre, home2);
  assert.match(html, /Walked /);
  assert.doesNotMatch(html, /phone lost you|lost you for/);
});

test("the caption's miles are the spine's walking legs, not path.stats", () => {
  const html = buildSkeleton(resolved);
  assert.match(html, /1\.4 miles walked/);
  assert.doesNotMatch(html, /1\.2 miles walked/);
});

test("a caption that would read 0.0 miles walked says nothing about walking (2026-10-24)", () => {
  const r = JSON.parse(JSON.stringify(resolved));
  for (const n of r.path.spine) if (n.type === "leg") n.mode = "riding";
  const html = buildSkeleton(r);
  assert.doesNotMatch(html, /miles walked/);
  assert.match(html, /\d+ stops/);
});

test("a walking leg just inside the next stop's window is still that gap's walk (2026-10-24)", () => {
  // Oct 24, Old Port: the flat's stop began 5 s before the last leg of the walk back
  // from the café, and the walk home from the lunch began as the flat's stop did.
  // The lines said "Walked 0.4 miles" and "3 min between stops" under "2.2 miles walked";
  // the second also because a router detour made the walk look mostly ridden.
  const S = (h, m, s = 0) => T(h, m) + s * 1000;
  const at = (id, name, a, b) => ({ id, place_name: name, start_ts_ms: a, end_ts_ms: b, place: { name, source: "user_confirmed" } });
  const cafe = at("c", "Café", S(8, 41), S(9, 35)), flat = at("f", "The Old Port Airbnb", S(10, 0, 5), S(13, 15));
  const lunch = at("l", "Saint George", S(13, 19), S(15, 57)), flat2 = at("f2", "The Old Port Airbnb", S(16, 0), S(16, 34));
  const dwell = (id, a, b) => ({ type: "dwell", id, place: { name: id }, start_ms: a, end_ms: b });
  const walk = (id, a, b, m, street) => ({ type: "leg", id, mode: "walking", start_ms: a, end_ms: b, routed_m: m, walked_m: m,
    straight_m: m, geometry: "map_matched", streets: [street], holes: [], confidence: "observed" });
  const r = { date: "2026-10-24", stops: [cafe, flat, lunch, flat2], routes: [], map_url: "https://x/map.png", path: { stats: {}, spine: [
    dwell("d3", S(8, 51), S(9, 35)), walk("l3", S(9, 35), S(9, 43), 616, "Shabazi"),
    dwell("d4", S(9, 43), S(9, 49)), dwell("d5", S(9, 50), S(10, 0, 5)), walk("l5", S(10, 0, 5), S(10, 1, 13), 509, "Raziel"),
    dwell("d6", S(10, 1, 13), S(13, 15)), walk("l6", S(13, 15), S(13, 19), 507, "Yefet"),
    // the router went round for 502 m, faster than a walk in 4 min; day-path counted the 247 m straight line
    dwell("d7", S(13, 19), S(16, 0, 14)), { ...walk("l7", S(16, 0, 14), S(16, 4, 22), 247, "Louis Pasteur"), routed_m: 502 },
    dwell("d8", S(16, 4, 22), S(16, 34)),
  ] } };
  assert.match(movementHtml(r, cafe, flat), /Walked 0\.7 miles along Shabazi and Raziel/);
  assert.match(movementHtml(r, lunch, flat2), /Walked 0\.2 miles along Louis Pasteur/);
  // the caption and the lines are one sum: 0.7 + 0.3 + 0.2
  assert.match(buildSkeleton(r), /1\.2 miles walked/);
  // a stop the spine has no dwell for (inside a leg) keeps the time test, and claims no later leg
  const unseen = at("u", "Drop-off", S(9, 37), S(9, 41));
  const html = movementHtml(r, cafe, unseen);
  assert.match(html, /2 min between stops/);
  assert.doesNotMatch(html, /Raziel/);
});

test("the manifest hands the narrator the spine and the records set aside", () => {
  const m = buildManifest(resolved);
  assert.equal(m.spine.length, 5);
  assert.equal(m.spine[0].type, "dwell");
  assert.equal(m.spine[1].to, "Golden Theatre");
  assert.equal(m.spine[1].miles, 1.4);
  assert.equal(m.spine[3].mode, "riding");
  assert.equal(m.spine[3].mode_uncertain, true);
  assert.deepEqual(m.spine[3].holes, [{ from: "16:45", to: "16:50", min: 5 }]);
  assert.equal(m.spine[2].tier, "user-confirmed");
  assert.equal(m.records_set_aside[0].name, "10 Example St");
});

test("without a spine the old path still renders", () => {
  const r = JSON.parse(JSON.stringify(resolved));
  delete r.path.spine;
  const html = movementHtml(r, home, theatre);
  assert.match(html, /Walked/);
  assert.equal(buildManifest(r).spine.length, 0);
});

// ---- resolve-day: a major spine dwell no stop covers becomes a stop ---------
const { _internal: rd } = require("../lib/resolve-day.js");

function rdStop(id, name, s, e, source = "known_recurring") {
  return { id, start: s, end: e, start_ts_ms: T(...s.split(":").map(Number)), end_ts_ms: T(...e.split(":").map(Number)),
           duration_min: 0, lat: 12.3456, lon: -65.4321, place: { name, source, confidence: 0.95, address: "x" } };
}
const spineDay = {
  spine: [
    { type: "dwell", id: "d0", major: true, start_ms: T(0, 1), end_ms: T(9, 8), place: { name: "Home (Eastside)", tier: "corroborated", lat: 12.3456, lon: -65.4321 } },
    { type: "dwell", id: "d1", major: true, start_ms: T(10, 7), end_ms: T(13, 18), place: { name: "Home (Eastside)", tier: "corroborated", lat: 12.3457, lon: -65.4321 }, witnessed_min: 0 },
    { type: "dwell", id: "d2", major: true, start_ms: T(13, 47), end_ms: T(16, 42), place: { name: "Golden Theatre", tier: "user-confirmed", lat: 12.3620, lon: -65.4214 } },
    { type: "dwell", id: "d3", major: false, start_ms: T(16, 52), end_ms: T(16, 57), place: { name: "Home (Eastside)", tier: "corroborated", lat: 12.3456, lon: -65.4321 } },
    { type: "dwell", id: "d4", major: true, start_ms: T(18, 4), end_ms: T(23, 59), place: { name: "Home (Eastside)", tier: "stay-point", lat: 12.3456, lon: -65.4321 } },
  ],
};

test("the home stint clustering lost becomes a stop, borrowing Home's place object", () => {
  const stops = [rdStop("a", "Home (Eastside)", "00:01", "09:13"), rdStop("b", "skip", "09:15", "09:16", "user_confirmed"),
                 rdStop("c", "Golden Theatre", "13:47", "16:42", "user_confirmed"), rdStop("d", "Home (Eastside)", "16:53", "23:59")];
  stops[1].user_non_stop = true;
  const added = rd.addSpineDwells(stops, spineDay);
  assert.equal(added.length, 1);
  assert.equal(added[0].spine_id, "d1");
  assert.equal(added[0].borrowed_place_from, "a");
  const ns = stops.find(s => s.from_spine);
  assert.equal(ns.place.source, "known_recurring");
  assert.equal(ns.start, "10:07");
  assert.equal(ns.end, "13:18");
  assert.deepEqual(stops.map(s => s.start), ["00:01", "09:15", "10:07", "13:47", "16:53"]);
});

test("a dwell a stop already covers is not added twice, and a minor one never is", () => {
  const stops = [rdStop("a", "Home (Eastside)", "00:01", "09:13"), rdStop("b", "Home (Eastside)", "10:00", "13:20"),
                 rdStop("c", "Golden Theatre", "13:47", "16:42", "user_confirmed"), rdStop("d", "Home (Eastside)", "16:53", "23:59")];
  assert.equal(rd.addSpineDwells(stops, spineDay).length, 0);
});

const theatreStop = (s, e) => ({ ...rdStop("c", "Golden Theatre", s, e, "user_confirmed"), lat: 12.3620, lon: -65.4214 });

test("a same-place stop touching the dwell is widened to it, bounded by its neighbours", () => {
  const stops = [rdStop("a", "Home (Eastside)", "00:01", "11:00"), theatreStop("13:00", "16:42")];
  const added = rd.addSpineDwells(stops, spineDay);
  assert.equal(stops[0].start, "00:01");
  assert.equal(stops[0].end, "13:00");                 // widened to the dwell, stopped by the theatre
  assert.equal(added.find(x => x.spine_id === "d1").widened_from, "00:01–11:00");
  // the evening at home (d4) has no stop near it in time, so it is added
  assert.deepEqual(stops.filter(s => s.from_spine).map(s => s.spine_id), ["d4"]);
  assert.equal(stops.length, 3);
});

test("a dwell with no same-place stop near it becomes a new stop in the free window", () => {
  const stops = [theatreStop("13:00", "16:42")];
  const day = { spine: [spineDay.spine[1]] };            // Home 10:07–13:18, nothing at home in the list
  rd.addSpineDwells(stops, day);
  const ns = stops.find(s => s.from_spine && s.spine_id === "d1");
  assert.equal(ns.start, "10:07");
  assert.equal(ns.end, "13:00");
});

test("an unnamed stay point carries spine_dwell provenance, not a borrowed name", () => {
  const day = { spine: [{ type: "dwell", id: "d9", major: true, start_ms: T(15, 0), end_ms: T(15, 30),
                          place: { name: null, tier: "stay-point", lat: 12.3530, lon: -65.4231 } }] };
  const stops = [rdStop("a", "Home (Eastside)", "00:01", "09:13")];
  rd.addSpineDwells(stops, day);
  const ns = stops.find(s => s.from_spine);
  assert.equal(ns.place.source, "spine_dwell");
  assert.equal(ns.place.name, null);
  assert.equal(ns.place.confidence, 0.5);
});

test("the map img carries a version so a rebuilt map is not served from the proxy cache", () => {
  const html = buildSkeleton({ ...resolved, generated_at: "2026-09-07T15:12:16.416Z" });
  assert.match(html, /example\.test\/map\.png\?v=1788793936416"/);
});

// ---- resolve-day: the spine's verdicts clip and drop stops ------------------
test("a ghost stop is clipped to the dwell the fixes support; a real stop is untouched", () => {
  const day = { spine: [
    { type: "dwell", id: "d1", start_ms: T(11, 8), end_ms: T(12, 2), place: { name: "Union Square Farmers Market", lat: 12.3389, lon: -65.4240 } },
    { type: "dwell", id: "d2", start_ms: T(12, 10), end_ms: T(12, 24), place: { name: "10 Example St", lat: 12.347539, lon: -65.422256 } }, // kernel-guard-ok: synthetic fixture coordinates offset from 12.3456, -65.4321
    { type: "dwell", id: "d3", start_ms: T(12, 37), end_ms: T(13, 41), place: { name: "KPOT", lat: 12.3566, lon: -65.4236 } },
    { type: "dwell", id: "d4", start_ms: T(14, 12), end_ms: T(18, 49), place: { name: "Home (Eastside)", lat: 12.3456, lon: -65.4321 } },
  ] };
  const ghost = { ...rdStop("g", null, "12:16", "23:38", "unknown"), lat: 12.347539, lon: -65.422256, end_ts_ms: T(29, 58) }; // kernel-guard-ok: synthetic fixture coordinates offset from 12.3456, -65.4321
  const kpot = { ...rdStop("k", "KPOT", "12:37", "13:41", "user_confirmed"), lat: 12.3566, lon: -65.4236 };
  const home = rdStop("h", "Home (Eastside)", "14:12", "18:55");
  const r = rd.applySpineVerdicts([ghost, kpot, home], day);
  assert.equal(r.stops.length, 3);
  assert.equal(r.clipped.length, 2);
  assert.equal(r.clipped[0].id, "g");
  assert.equal(r.stops[0].start, "12:16");
  assert.equal(r.stops[0].end, "12:24");
  assert.equal(r.stops[1].start, "12:37");           // KPOT untouched
  assert.equal(r.stops[1].end, "13:41");
  assert.equal(r.clipped[1].id, "h");                // 18:55 -> 18:49, 6 min
  assert.equal(r.dropped.length, 0);
});

test("a stop the trace places elsewhere is dropped; one the trace is silent on stays", () => {
  const day = { spine: [
    { type: "dwell", id: "d3", start_ms: T(12, 37), end_ms: T(13, 41), place: { name: "KPOT", lat: 12.3566, lon: -65.4236 } },
  ] };
  const phantom = { ...rdStop("p", "Somewhere", "12:40", "13:30", "osm_overpass"), lat: 12.3030, lon: -65.4386 };
  const silent = { ...rdStop("q", "Calendar place", "20:00", "21:00", "calendar"), lat: 12.3030, lon: -65.4386 };
  const r = rd.applySpineVerdicts([phantom, silent], day);
  assert.deepEqual(r.stops.map(s => s.id), ["q"]);
  assert.equal(r.dropped[0].id, "p");
  assert.deepEqual(r.dropped[0].elsewhere, ["KPOT"]);
});

test("a same-place remnant is widened to the dwell, not given a neighbour", () => {
  const day = { spine: [{ type: "dwell", id: "d5", major: true, start_ms: T(12, 10), end_ms: T(12, 24),
                          place: { name: "10 Example St", tier: "corroborated", lat: 12.347539, lon: -65.422256 } }] }; // kernel-guard-ok: synthetic fixture coordinates offset from 12.3456, -65.4321
  const remnant = { ...rdStop("g", null, "12:16", "12:18", "unknown"), lat: 12.347539, lon: -65.422256 }; // kernel-guard-ok: synthetic fixture coordinates offset from 12.3456, -65.4321
  const market = { ...rdStop("m", "Union Square Farmers Market", "11:10", "12:02", "user_confirmed"), lat: 12.3389, lon: -65.4240 };
  const stops = [market, remnant];
  const added = rd.addSpineDwells(stops, day);
  assert.equal(stops.length, 2);
  assert.equal(added[0].id, "g");
  assert.equal(added[0].widened_from, "12:16–12:18");
  assert.equal(remnant.start, "12:10");
  assert.equal(remnant.end, "12:24");
  assert.equal(remnant.place.name, "10 Example St");
});

test("the caption is the walking lines and walk blocks it sits over, summed (2026-10-25)", () => {
  // Oct 25, Old Port: the beach walk's leg was moded riding, so a caption summing the
  // spine's walking legs said "1.0 miles walked" while the lines and the walk block
  // over that leg printed 0.3 + 0.1 + 0.4 + 1.0 + 0.2.
  const r = JSON.parse(JSON.stringify(resolved));
  const block = { ...stop("w", "Walk along the river", "16:42", "16:52"),
                  place: { name: "Walk along the river", source: "excursion" }, excursion: { routed_m: 2630 } };
  r.stops = [home, theatre, block, home2];
  const { printedWalkMeters } = _internal;
  assert.equal(Math.round(printedWalkMeters(r, r.stops)), 2317 + 2630);
  assert.match(buildSkeleton(r), /3\.1 miles walked/);
  // the old sum of walking legs, behind its switch
  process.env.JORI_WALKED_FROM_LINES = "0";
  try { assert.match(buildSkeleton(r), /1\.4 miles walked/); } finally { delete process.env.JORI_WALKED_FROM_LINES; }
});
