// resolve-day-spine-named.test.mjs — a stop the spine built goes through the
// naming ladder: a named location (his homes and family homes), then a place he
// confirmed, then a known-recurring entry.
//
// 2026-10-14: a 71-minute stop at his parents' house in Orchardton came back as
// "12 Example Alley". Mason: "Do you have my parent's address? Why wasn't it
// identified automatically?" The stop reached the day through addSpineDwells,
// which carried the visit row's street address and never asked a rung.
//
// Run: node --test tests/resolve-day-spine-named.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
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
const { _internal } = require(path.join(ROOT, "lib/resolve-day.js"));
const { nameSpineDwells } = _internal;
const { loadNamedLocations, matchNamedLocation } = require(path.join(ROOT, "lib/named-locations.js"));

const PARENTS = { name: "Parents' home, Orchardton", ...LL(0.0, 0.0),
                  address: "Example Lane 9, Orchardton 00000" };
const CAFE = { name: "Boutique cafe", centroid: { ...LL(-4521.1, 18154.96) } };
const ctx = { date: "2026-10-14", namedLocations: [PARENTS], confirmedStopsEntries: [CAFE],
              knownStopsEntries: [] };

function spineStop(id, lat, lon, place, extra = {}) {
  return { id, start: "17:22", end: "18:34", lat, lon, from_spine: true, place, ...extra };
}
const streetAddress = (name) => ({ name, source: "spine_dwell", address: null, confidence: 0.85 });

test("a spine stop at his parents' house takes the family-home name", () => {
  const s = spineStop("s-p1", ...PT(0.38, 2.56), streetAddress("12 Example Alley"));
  const named = nameSpineDwells([s], ctx);
  assert.equal(s.place.name, "Parents' home, Orchardton");
  assert.equal(s.place.source, "named_location");
  assert.equal(s.place.address, PARENTS.address);
  assert.deepEqual(named.map(n => [n.name, n.was]), [["Parents' home, Orchardton", "12 Example Alley"]]);
});

test("a spine stop where he answered once takes his answer (30 m)", () => {
  const s = spineStop("s-p2", ...PT(-4513.69, 18167.37), streetAddress("30 Birch Street"));
  nameSpineDwells([s], ctx);
  assert.equal(s.place.name, "Boutique cafe");
  assert.equal(s.place.source, "confirmed_stop");
});

test("a borrowed weak name (a twin's reverse geocode) is still upgraded", () => {
  const s = spineStop("s-p3", ...PT(0.38, 2.56),
    { name: "7 התמר", source: "reverse_geocode", confidence: 0.4 });
  nameSpineDwells([s], ctx);
  assert.equal(s.place.source, "named_location");
});

test("his own answer, a lodging, or 'not a stop' is never renamed", () => {
  const confirmed = spineStop("s-p4", ...PT(0.38, 2.56),
    { name: "Notary", source: "user_confirmed", confidence: 1 });
  const lodging = spineStop("s-p5", ...PT(0.38, 2.56),
    { name: "The Harbor Flat", source: "accommodation", confidence: 0.95 });
  const nonStop = spineStop("s-p6", ...PT(0.38, 2.56), streetAddress("12 Example Alley"),
    { user_non_stop: true });
  const named = nameSpineDwells([confirmed, lodging, nonStop], ctx);
  assert.equal(named.length, 0);
  assert.equal(confirmed.place.name, "Notary");
  assert.equal(lodging.place.name, "The Harbor Flat");
  assert.equal(nonStop.place.name, "12 Example Alley");
});

test("a spine name that IS his answer (tier user-confirmed) is never replaced", () => {
  // The real shape: addSpineDwells copies a confirmed dwell's name under
  // source "spine_dwell" and records the tier on the stop.
  const built = spineStop("s-p8", ...PT(0.38, 2.56),
    { name: "Notary", source: "spine_dwell", confidence: 1 }, { spine_tier: "user-confirmed" });
  const widened = { id: "s9", start: "17:22", end: "18:34", ...LL(0.38, 2.56),
    widened_by_spine: "d3", spine_tier: "user-confirmed",
    place: { name: "Coffee with Otis", source: "spine_dwell", confidence: 1 } };
  assert.equal(nameSpineDwells([built, widened], ctx).length, 0);
  assert.equal(built.place.name, "Notary");
  assert.equal(widened.place.name, "Coffee with Otis");
});

test("addSpineDwells records the tier on a stop it widens and names", () => {
  const { addSpineDwells } = _internal;
  const at = (hhmm) => Date.parse(`2026-10-14T${hhmm}:00Z`);
  const stop = { id: "s-20261014-1", start: "14:30", end: "14:40", start_ts_ms: at("14:30"), end_ts_ms: at("14:40"),
                 duration_min: 10, ...LL(0.38, 2.56), place: { name: null, source: "unknown" } };
  const dayPath = { spine: [{ id: "d1", type: "dwell", major: true, start_ms: at("14:22"), end_ms: at("15:34"),
    place: { ...LL(0.38, 2.56), name: "My parents home", tier: "user-confirmed" } }] };
  addSpineDwells([stop], dayPath);
  assert.equal(stop.place.name, "My parents home");
  assert.equal(stop.spine_tier, "user-confirmed");
  assert.equal(nameSpineDwells([stop], ctx).length, 0);
  assert.equal(stop.place.name, "My parents home");
});

test("stops the spine did not build are left to the ladder that named them", () => {
  const s = { id: "s4", start: "17:22", end: "18:34", ...LL(0.38, 2.56),
              place: { name: "12 Example Alley", source: "reverse_geocode", confidence: 0.4 } };
  assert.equal(nameSpineDwells([s], ctx).length, 0);
  assert.equal(s.place.name, "12 Example Alley");
});

test("nowhere near anything he named: the spine's label stands", () => {
  const s = spineStop("s-p7", ...PT(-144.54, 407.09), streetAddress("90 Maple Street"));
  assert.equal(nameSpineDwells([s], ctx).length, 0);
  assert.equal(s.place.name, "90 Maple Street");
});

test("a named-locations file carries the parents' home, within 150 m of the 10-14 stop", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "named-locations-"));
  const file = path.join(dir, "named-locations.json");
  const home = fakeAt(0.38, 2.56);
  fs.writeFileSync(file, JSON.stringify({ entries: [{ name: "Parents' home, Orchardton", lat: home.lat, lon: home.lon, kind: "family" }] }));
  const entries = loadNamedLocations(file);
  fs.rmSync(dir, { recursive: true, force: true });
  const hit = matchNamedLocation(entries, ...PT(0.38, 2.56));
  assert.ok(hit);
  assert.equal(hit.entry.name, "Parents' home, Orchardton");
  assert.ok(hit.distance_m < 30);
  assert.equal(matchNamedLocation(entries, ...PT(-144.54, 407.09)), null); // Tax office, 447 m
  assert.deepEqual(loadNamedLocations("/nonexistent/named.json"), []);
});
