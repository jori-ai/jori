// resolve-day-calendar-split.test.mjs — a confirmed name reaches only as far as
// its row; a corroborated event over the rest of the window is its own stop.
//
// 2026-09-08 (Mason: "The movie should have received it's own location (even
// if it's next door to essex market)"). Market Example and the Cinema Example
// Crossing share a building: one 167-minute cluster, 18:10–20:57. His answer
// "Market Example" sat on a 42-minute row (18:09–18:51, note "Before the movie");
// the calendar held "Film (Cinema Example & RPX)" 18:45–21:15 at a
// location that matched the stop. The whole cluster shipped as Market Example.
//
// Also here: routes[] modes defer to the spine. The same evening's return was
// "cycled" in location-segment's classifier (two fixes, 1.47 km, 5.8 min) while
// the spine said riding/uncertain — and the narrator wrote "biked home".
//
// Run: node --test tests/resolve-day-calendar-split.test.mjs

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
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { _internal } = require(path.join(HERE, "..", "lib", "resolve-day.js"));
const { splitConfirmedStopOnEvent, supersedeRouteModesBySpine, venueFromEventLocation, overlayConfirmedVisits } = _internal;

const ET = (h, m) => Date.UTC(2026, 8, 8, h + 4, m);   // 2026-09-08 ET → UTC
const iso = ms => new Date(ms).toISOString();

const TONY = {
  summary: "Film (Cinema Example & RPX)",
  location: "Cinema Example &amp; RPX, 129 Placeholder St, Example City, ZZ 00000",
  location_match: true, physical: true,
  start: "2026-09-08T18:45:00-04:00", end: "2026-09-08T21:15:00-04:00",
  duration_min: 150, event_share: 0.825,
};

function essex(over = {}) {
  return {
    id: "s-20260908-3", start: "18:10", end: "20:57", start_ts_ms: ET(18, 10), end_ts_ms: ET(20, 57),
    duration_min: 167, ...LL(0.0, 0.0),
    place: { name: "Market Example", source: "user_confirmed", confidence: 1, distance_m: 29 },
    confirmed_row: { id: "af80486d", name: "Market Example", start_ms: ET(18, 9), end_ms: ET(18, 51) },
    calendar_event: TONY, companions: ["Paige"],
    photos: [{ uuid: "a", taken_at: iso(ET(18, 30)) }, { uuid: "b", taken_at: iso(ET(20, 10)) }],
    ...over,
  };
}

test("the market keeps its row's window; the movie becomes its own stop at the venue in the event's location", () => {
  const { stops, splits } = splitConfirmedStopOnEvent([essex()]);
  assert.equal(stops.length, 2);
  const [market, movie] = stops;
  assert.equal(market.place.name, "Market Example");
  assert.equal(market.end, "18:51");
  assert.equal(market.duration_min, 41);
  assert.equal(movie.place.name, "Cinema Example & RPX");
  assert.equal(movie.place.source, "calendar_corroborated");
  assert.equal(movie.start, "18:51");
  assert.equal(movie.end, "20:57");
  assert.equal(movie.calendar_event.summary, "Film (Cinema Example & RPX)");
  assert.deepEqual(movie.companions, ["Paige"]);
  assert.deepEqual(market.photos.map(p => p.uuid), ["a"]);
  assert.deepEqual(movie.photos.map(p => p.uuid), ["b"]);
  assert.deepEqual(stops.map(s => s.id), ["s-20260908-1", "s-20260908-2"]);
  assert.equal(splits.length, 1);
  assert.equal(splits[0].cut_at, "confirmed row departure");
});

test("the boundary is the row's departure, not the event's scheduled start", () => {
  const { stops } = splitConfirmedStopOnEvent([essex()]);
  assert.equal(stops[0].end, "18:51");   // event said 18:45
});

test("a confirmed row that covers the stop is not split", () => {
  const { stops } = splitConfirmedStopOnEvent([essex({ confirmed_row: { id: "x", name: "Market Example", start_ms: ET(18, 9), end_ms: ET(20, 50) } })]);
  assert.equal(stops.length, 1);
});

test("an event that does not cover most of the tail leaves the stop alone", () => {
  const short = { ...TONY, start: "2026-09-08T20:30:00-04:00", end: "2026-09-08T21:15:00-04:00" };
  const { stops } = splitConfirmedStopOnEvent([essex({ calendar_event: short })]);
  assert.equal(stops.length, 1);
});

test("an event whose location did not match this place cannot name a tail", () => {
  const { stops } = splitConfirmedStopOnEvent([essex({ calendar_event: { ...TONY, location_match: false } })]);
  assert.equal(stops.length, 1);
  const { stops: s2 } = splitConfirmedStopOnEvent([essex({ calendar_event: { ...TONY, physical: false, location: "" } })]);
  assert.equal(s2.length, 1);
});

test("a name the resolver only guessed is not split — there is no row to bound it", () => {
  const { stops } = splitConfirmedStopOnEvent([essex({ place: { name: "Market Example", source: "saved_place", confidence: 0.9 }, confirmed_row: null })]);
  assert.equal(stops.length, 1);
});

test("the event that starts long after the row ends is a different outing", () => {
  const late = { ...TONY, start: "2026-09-08T20:00:00-04:00", end: "2026-09-08T22:30:00-04:00" };
  const { stops } = splitConfirmedStopOnEvent([essex({ calendar_event: late })]);
  assert.equal(stops.length, 1);
});

test("venue comes from the location's first segment, entities decoded", () => {
  assert.equal(venueFromEventLocation("Cinema Example &amp; RPX, 129 Placeholder St"), "Cinema Example & RPX");
  assert.equal(venueFromEventLocation(""), null);
});

test("a routes[] leg under a spine leg takes the spine's mode and keeps its own as mode_was", () => {
  const spine = [
    { type: "leg", id: "l3", mode: "riding", mode_uncertain: true, start_ms: ET(20, 58), end_ms: ET(21, 10) },
  ];
  const routes = [{ id: "route-2", legs: [
    { mode: "cycled", start: iso(ET(20, 58)), end: iso(ET(21, 4)), distance_km: 1.472 },
  ] }];
  const out = supersedeRouteModesBySpine(routes, spine);
  assert.equal(out[0].legs[0].mode, "rode");
  assert.equal(out[0].legs[0].mode_was, "cycled");
  assert.equal(out[0].legs[0].mode_uncertain, true);
  assert.equal(out[0].legs[0].spine_leg, "l3");
});

test("a routes[] leg the spine does not cover keeps its own mode", () => {
  const spine = [{ type: "leg", id: "l0", mode: "walking", start_ms: ET(9, 0), end_ms: ET(9, 30) }];
  const routes = [{ id: "r", legs: [{ mode: "drove", start: iso(ET(15, 0)), end: iso(ET(15, 20)) }] }];
  const out = supersedeRouteModesBySpine(routes, spine);
  assert.equal(out[0].legs[0].mode, "drove");
  assert.equal(out[0].legs[0].mode_was, undefined);
});

// The pass that undid the split on first deploy: overlayConfirmedVisits took
// day-path's dwell window (the merged building's whole stay, 18:07–20:58) as
// "his window", renamed the movie "Market Example" and re-merged the two.
// day-path now carries the confirmed rows' own span on the dwell.
test("the confirmed overlay applies the row's span, not the merged dwell's, so the movie survives", () => {
  const { stops } = splitConfirmedStopOnEvent([essex()]);
  const dayPath = { visits: [{
    ptype: "user-confirmed", name: "Market Example", ...LL(0.0, 0.0),
    start_ms: ET(18, 7), end_ms: ET(20, 58),                       // the building's dwell
    confirmed_start_ms: ET(18, 9), confirmed_end_ms: ET(18, 51),   // what he confirmed
  }] };
  overlayConfirmedVisits(stops, dayPath);
  assert.deepEqual(stops.map(s => `${s.start}-${s.end} ${s.place.name}`),
    ["18:09-18:51 Market Example", "18:51-20:57 Cinema Example & RPX"]);
});

test("without a confirmed span the overlay still uses the dwell window (older day-path payloads)", () => {
  const one = [essex({ end: "18:40", end_ts_ms: ET(18, 40), confirmed_row: null, calendar_event: null })];
  overlayConfirmedVisits(one, { visits: [{ ptype: "user-confirmed", name: "Market Example", ...LL(0.0, 0.0),
    start_ms: ET(18, 9), end_ms: ET(18, 51) }] });
  assert.equal(one[0].end, "18:51");
});
