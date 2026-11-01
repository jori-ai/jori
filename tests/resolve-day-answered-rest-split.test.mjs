// resolve-day-answered-rest-split.test.mjs — a rest his own past answer names is
// its own place, however close to the stop it was cut from.
//
// 2026-10-22, Portside: the phone named the 14:12 arrival "Café Corvina" and iOS ran
// that visit to 17:35. From 14:35 to 17:28 the fixes sat 3 m from the flat he has
// confirmed again and again, 73 m from the café, and the 14:16 rest sat by Tamsa,
// where he confirmed dinner the night before. The two rests were 128 m apart, under
// SPLIT_SEPARATION_M (130), so the cut was refused and the afternoon at the flat
// shipped as three hours at Café Corvina.
//
// Run: node --test tests/resolve-day-answered-rest-split.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { at as fakeAt, loadRows } from "./fixtures/fake-geo.mjs";
// Synthetic places (tests/fixtures/fake-geo.mjs): `e` metres east and `n` north
// of an obviously fake origin, keeping the real day's geometry.
const LL = (e, n, suf = "") => { const p = fakeAt(e, n); return { [`lat${suf}`]: p.lat, [`lon${suf}`]: p.lon }; };
const LLR = (e, n) => { const p = fakeAt(e, n); return { latitude: p.lat, longitude: p.lon }; };
const LLG = (e, n) => { const p = fakeAt(e, n); return { lat: p.lat, lng: p.lon }; };

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { splitWideStopsOnRests } = require(path.join(ROOT, "lib/resolve-day.js"))._internal;

// Every raw fix 14:09-17:35 local, as location_history held them (synthetic places).
const PINGS = loadRows(path.join(ROOT, "tests/fixtures/resolve-day-2026-10-22-afternoon.pings.json"), { latKey: "lat", lonKey: "lon" })
  .map(p => ({ ts: Date.parse(p.at), lat: p.lat, lon: p.lon, acc: p.acc, kind: p.kind, activity: p.activity }));

const T = (hms) => Date.parse(`2026-10-22T${hms}+03:00`);

// The stop as resolve-day had it: the café's arrival row, carried as user_confirmed.
const blend = () => ({
  id: "s-20261022-3", start: "14:12", end: "17:35",
  start_ts_ms: T("14:12:33"), end_ts_ms: T("17:35:58"), duration_min: 203,
  ...LL(0.0, 0.0), cluster_radius_km: 0.219, sample_count: 67,
  place: { name: "Café Corvina", address: null, source: "user_confirmed", confidence: 1, distance_m: 58 },
  confirmed_row: { id: "f90ec82f", name: "Café Corvina", place_type: "named" },
  photos: [], companions: [],
});

// His past answers (confirmed-stops.json), the three that sit near that afternoon.
const CONFIRMED = [
  { name: "The Harbor Flat", centroid: { ...LL(-15.09, -3.53) } },
  { name: "Café Corvina", centroid: { ...LL(59.28, -22.24) } },
  { name: "Tamsa", centroid: { ...LL(138.99, 18.58) } },
];
const ctx = () => ({ date: "2026-10-22", knownStopsEntries: [], confirmedStopsEntries: CONFIRMED, companionRows: [] });

test("the afternoon is cut at the flat his answers name, though the rests are 128 m apart", () => {
  const { stops, splits } = splitWideStopsOnRests([blend()], PINGS, ctx());
  assert.equal(splits.length, 1);
  assert.ok(!splits[0].kept_whole, JSON.stringify(splits[0]));
  assert.ok(splits[0].apart_m < 130, "still under the plain separation bar");
  const flat = stops.find(s => s.place.name === "The Harbor Flat");
  assert.ok(flat, JSON.stringify(stops.map(s => s.place.name)));
  assert.equal(flat.place.source, "confirmed_stop");
  assert.ok(flat.duration_min >= 170, `flat for ${flat.duration_min} min`);
  assert.ok(!stops.some(s => s.place.name === "Café Corvina" && s.duration_min > 60),
    "no long café stop is left");
});

test("JORI_SPLIT_ON_ANSWERED_REST=0 restores the old refusal", () => {
  process.env.JORI_SPLIT_ON_ANSWERED_REST = "0";
  try {
    const { stops, splits } = splitWideStopsOnRests([blend()], PINGS, ctx());
    assert.equal(splits[0].kept_whole, true);
    assert.equal(stops.length, 1);
    assert.equal(stops[0].place.name, "Café Corvina");
  } finally {
    delete process.env.JORI_SPLIT_ON_ANSWERED_REST;
  }
});

test("two close rests named only by the point resolver stay one place", () => {
  // No past answer at either rest: the 130 m footprint rule still holds.
  const c = { ...ctx(), confirmedStopsEntries: [],
    nameRest: (p) => { p.place = { name: p.start < "14:30" ? "Some bar" : "Some street",
                                   source: "osm_overpass", confidence: 0.6, distance_m: 10 }; } };
  const { stops, splits } = splitWideStopsOnRests([blend()], PINGS, c);
  assert.equal(splits[0].kept_whole, true);
  assert.equal(stops.length, 1);
});

test("a rest whose past answer is the stop's own name does not cut it", () => {
  // The rest at the flat answers "The Harbor Flat"; a stop already named that keeps whole.
  const b = { ...blend(), place: { ...blend().place, name: "The Harbor Flat" } };
  const c = { ...ctx(), confirmedStopsEntries: CONFIRMED.filter(e => e.name === "The Harbor Flat") };
  const { splits } = splitWideStopsOnRests([b], PINGS, c);
  assert.equal(splits[0].kept_whole, true, JSON.stringify(splits[0]));
});

// A stop cut on its rests keeps its own start when nothing before the first rest
// puts the user anywhere else. A night at the flat began before midnight, the
// phone lay silent until 1:00, and the morning café sat 148 m away in the same
// cluster: the first rest began at its first fix, so the day opened at 1:00am
// with its first hour belonging to no stop. Synthetic places and date.
const HT = (hms) => Date.parse(`2099-05-07T${hms}+02:00`);
const H_FLAT = fakeAt(0, 0), H_CAFE = fakeAt(148, 0), H_ELSEWHERE = fakeAt(600, 0);
const hfix = (hms, p) => ({ ts: HT(hms), lat: p.lat, lon: p.lon, acc: 10, kind: "fix", activity: "stationary" });
const H_NIGHT = ["01:00:07", "03:00:00", "05:00:00", "07:28:00", "08:30:00"].map(h => hfix(h, H_FLAT));
const H_MORNING = ["09:00:59", "09:10:00", "09:20:00", "09:30:00"].map(h => hfix(h, H_CAFE));
const nightBlend = () => {
  const mid = fakeAt(74, 0);
  return {
    id: "s-20990507-1", start: "00:00", end: "09:38",
    start_ts_ms: HT("00:00:00"), end_ts_ms: HT("09:38:00"), duration_min: 578,
    lat: mid.lat, lon: mid.lon, cluster_radius_km: 0.136, sample_count: 9,
    place: { name: "Café Example", address: null, source: "confirmed_stop", confidence: 0.95, distance_m: 20 },
    photos: [], companions: [],
  };
};
const headCtx = () => ({ date: "2099-05-07", knownStopsEntries: [], companionRows: [], confirmedStopsEntries: [
  { name: "The Example Flat", centroid: { lat: H_FLAT.lat, lon: H_FLAT.lon } },
  { name: "Café Example", centroid: { lat: H_CAFE.lat, lon: H_CAFE.lon } },
] });

test("the first piece keeps the stop's start when the phone was silent before the first rest", () => {
  const { stops, splits } = splitWideStopsOnRests([nightBlend()], [...H_NIGHT, ...H_MORNING], headCtx());
  assert.equal(splits.length, 1);
  assert.ok(!splits[0].kept_whole, JSON.stringify(splits[0]));
  const flat = stops.find(s => s.place.name === "The Example Flat");
  assert.ok(flat, JSON.stringify(stops.map(s => s.place.name)));
  assert.equal(flat.start_ts_ms, HT("00:00:00"));
  assert.equal(flat.end_ts_ms, HT("09:00:59"));
  const cafe = stops.find(s => s.place.name === "Café Example");
  assert.equal(cafe.start_ts_ms, HT("09:00:59"), "the second piece is untouched");
});

test("a fix elsewhere before the first rest leaves the rest's own start", () => {
  const { stops } = splitWideStopsOnRests([nightBlend()], [hfix("00:30:00", H_ELSEWHERE), ...H_NIGHT, ...H_MORNING], headCtx());
  const flat = stops.find(s => s.place.name === "The Example Flat");
  assert.ok(flat, JSON.stringify(stops.map(s => s.place.name)));
  assert.equal(flat.start_ts_ms, HT("01:00:07"));
});

test("JORI_SPLIT_KEEPS_HEAD=0 leaves the rest's own start", () => {
  process.env.JORI_SPLIT_KEEPS_HEAD = "0";
  try {
    const { stops } = splitWideStopsOnRests([nightBlend()], [...H_NIGHT, ...H_MORNING], headCtx());
    assert.equal(stops.find(s => s.place.name === "The Example Flat").start_ts_ms, HT("01:00:07"));
  } finally { delete process.env.JORI_SPLIT_KEEPS_HEAD; }
});
