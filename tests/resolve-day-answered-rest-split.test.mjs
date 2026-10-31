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
