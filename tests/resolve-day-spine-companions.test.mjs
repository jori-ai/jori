// resolve-day-spine-companions.test.mjs — a stop built from the day-path spine
// carries the companions recorded on the visit row it sits on.
//
// 2026-10-09, Mason replying to the 10/8 summary: "Penny did come back with
// us to the apartment but not to lunch." The apartment hour after the café was
// a spine dwell (addSpineDwells, which runs after the companion merge), and its
// location_history row already listed Paige: the stop rendered with nobody.
// Spine stops carry bare lat/lon, no `centroid`, which the merge also read as
// (0, 0) and rejected as 300 m+ away from everything.
//
// Run: node --test tests/resolve-day-spine-companions.test.mjs

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
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { _internal } = require(path.join(ROOT, "lib/resolve-day.js"));
const { applyVisitCompanions } = _internal;

const AIRBNB = { ...LL(0.0, 0.0) };
const at = (hhmm) => Date.parse(`2026-10-08T${hhmm}:00Z`);

function spineStop(id, start, end, pos = AIRBNB) {
  return {
    id, start_ts_ms: at(start), end_ts_ms: at(end), lat: pos.lat, lon: pos.lon,
    companions: [], from_spine: true,
  };
}
const visit = (start, end, companions, pos = AIRBNB) => ({
  arrived_at: new Date(at(start)).toISOString(), departed_at: new Date(at(end)).toISOString(),
  latitude: pos.lat, longitude: pos.lon, companions,
});

test("a spine stop (lat/lon, no centroid) picks up the overlapping visit's companions", () => {
  const stop = spineStop("s-p2", "10:28", "11:15");
  applyVisitCompanions([stop], [visit("10:28", "10:59", ["Paige", "Penny"])]);
  assert.deepEqual(stop.companions, ["Paige", "Penny"]);
});

test("a segment stop (centroid) still merges, deduped by name", () => {
  const stop = { id: "s2", start_ts_ms: at("09:20"), end_ts_ms: at("10:10"),
    centroid: AIRBNB, companions: ["Paige"] };
  applyVisitCompanions([stop], [visit("09:20", "10:10", ["Penny", "Paige"])]);
  assert.deepEqual(stop.companions, ["Paige", "Penny"]);
});

test("a visit that doesn't overlap in time, or sits 300 m+ away, adds nobody", () => {
  const stop = spineStop("s-p1", "06:00", "09:20");
  applyVisitCompanions([stop], [
    visit("10:28", "10:59", ["Penny"]),
    visit("06:00", "09:20", ["Paige"], { lat: AIRBNB.lat + 0.01, lon: AIRBNB.lon }),
  ]);
  assert.deepEqual(stop.companions, []);
});

// 2026-10-15: the pet shop stop is built by overlayConfirmedVisits from his
// confirmed row, after the merge, so the row's "Paige" (his answer: "That was
// Paige at the pet shop too") never reached it.
const { overlayConfirmedVisits, stopsBuiltAfterCompanionMerge } = _internal;
const PET_SHOP = { ...LL(274.25, 65.61) };

test("a stop built from a confirmed row no cluster matched is re-merged and takes that row's companions", () => {
  const guetta = { id: "s-5", start_ts_ms: at("10:09"), end_ts_ms: at("11:09"), ...LL(525.87, 247.98),
    place: { name: "Example", source: "user_confirmed" }, companions: ["Paige"] };
  const flat = { id: "s-7", start_ts_ms: at("11:26"), end_ts_ms: at("16:39"), lat: AIRBNB.lat, lon: AIRBNB.lon,
    place: { name: "The Harbor Flat", source: "user_confirmed" }, companions: [] };
  const stops = [guetta, flat];
  const dayPath = { visits: [{ ptype: "user-confirmed", name: "Example pet shop",
    start_ms: at("11:12"), end_ms: at("11:24"), lat: PET_SHOP.lat, lon: PET_SHOP.lon }] };
  overlayConfirmedVisits(stops, dayPath);
  const pet = stops.find(s => s.place.name === "Example pet shop");
  assert.ok(pet && pet.from_confirmed_visit, "the overlay built the pet shop stop");
  assert.deepEqual(pet.companions, []);
  const again = stopsBuiltAfterCompanionMerge(stops);
  assert.deepEqual(again.map(s => s.id), [pet.id], "only the stop built after the merge is re-merged");
  applyVisitCompanions(again, [visit("11:12", "11:25", ["Paige"], PET_SHOP)]);
  assert.deepEqual(pet.companions, ["Paige"]);
  assert.deepEqual(flat.companions, [], "a stop the first merge already saw is left alone");
});

test("spine stops are still re-merged; a saved-at stop keeps only the people his words named", () => {
  const spine = spineStop("s-p1", "06:00", "07:00");
  const savedAt = { id: "s-a1", start_ts_ms: at("09:00"), end_ts_ms: at("09:56"), lat: AIRBNB.lat, lon: AIRBNB.lon,
    companions: ["Paige", "Rover"], from_confirmed_visit: true, from_saved_at: "lc-at-20261019-014058" };
  const cluster = { id: "s-2", start_ts_ms: at("10:00"), end_ts_ms: at("11:00"), centroid: AIRBNB, companions: [] };
  assert.deepEqual(stopsBuiltAfterCompanionMerge([spine, savedAt, cluster]).map(s => s.id), ["s-p1"]);
});
