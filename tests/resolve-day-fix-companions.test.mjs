// resolve-day-fix-companions.test.mjs — the people his words put on the fixes of
// a window reach the stop that holds those fixes, even with no visit row behind it.
//
// 2026-10-17, Portside. Asked whether Paige was with him first thing before coffee,
// Mason answered "we were together all the time yesterday", and location-annotate
// tagged Paige on every location row of the day. The 06:54-07:42 stretch at the flat
// rests on the overnight visit row that arrived Friday 20:13, which the companion
// merge never reads (it takes rows that arrived inside the day), so the stop still
// read alone while every fix inside it carried Paige.
//
// Run: node --test tests/resolve-day-fix-companions.test.mjs

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
const { applyFixCompanions } = require(path.join(ROOT, "lib/resolve-day.js"))._internal;

const FLAT = { ...LL(0.0, 0.0) };
const FAR = { ...LL(-428.81, 40.04) };   // the walk's turnaround, ~430 m out
const at = (hms) => Date.parse(`2026-10-17T${hms}Z`);   // UTC; IDT is +3
const fix = (hms, companions, pos = FLAT) => ({
  arrived_at: new Date(at(hms)).toISOString(), latitude: pos.lat, longitude: pos.lon, companions,
});
const stop = (id, from, to, pos = FLAT, companions = []) => ({
  id, start_ts_ms: at(from), end_ts_ms: at(to), lat: pos.lat, lon: pos.lon,
  place: { name: "The Harbor Flat" }, companions: [...companions],
});

test("the morning stretch at the flat takes Paige from its own tagged fixes", () => {
  const s = stop("s-1", "03:54:00", "04:42:00");
  const fixes = ["03:55:10", "04:02:00", "04:10:30", "04:21:00", "04:33:00", "04:40:00"]
    .map(t => fix(t, ["Paige"]));
  const added = applyFixCompanions([s], fixes);
  assert.deepEqual(s.companions, ["Paige"]);
  assert.deepEqual(added, [{ id: "s-1", name: "The Harbor Flat", added: ["Paige"], fixes: 6 }]);
});

test("a name on only a few of a stop's fixes stays off (a walk that set out from it)", () => {
  const s = stop("s-5", "13:00:00", "16:56:00");
  const fixes = [
    fix("13:01:00", null), fix("14:10:00", null), fix("15:20:00", null), fix("16:30:00", null),
    fix("16:55:00", ["Yuri", "Rover"]),
  ];
  assert.deepEqual(applyFixCompanions([s], fixes), []);
  assert.deepEqual(s.companions, []);
});

test("one tagged fix is not enough to name anyone", () => {
  const s = stop("s-p1", "17:35:00", "20:04:00");
  assert.deepEqual(applyFixCompanions([s], [fix("18:00:00", ["Paige"])]), []);
  assert.deepEqual(s.companions, []);
});

test("fixes outside the stop's window or far from it do not count", () => {
  const s = stop("s-1", "03:54:00", "04:42:00");
  const fixes = [
    fix("03:50:00", ["Paige"]), fix("04:42:00", ["Paige"]),            // before / at the end
    fix("04:00:00", ["Paige"], FAR), fix("04:20:00", ["Paige"], FAR),
    fix("04:05:00", null), fix("04:30:00", null),
  ];
  assert.deepEqual(applyFixCompanions([s], fixes), []);
});

test("a person already on the stop is not added twice, and twin fixes count once", () => {
  const s = stop("s-3", "06:12:00", "08:52:00", FLAT, ["Paige"]);
  const fixes = [fix("06:20:00", ["Paige"]), fix("06:20:00", ["Paige"]), fix("07:40:00", ["Paige"])];
  assert.deepEqual(applyFixCompanions([s], fixes), []);
  assert.deepEqual(s.companions, ["Paige"]);
});

test("no tagged fix on the day changes nothing", () => {
  const s = stop("s-1", "03:54:00", "04:42:00");
  assert.deepEqual(applyFixCompanions([s], [fix("04:00:00", null), fix("04:10:00", [])]), []);
  assert.deepEqual(applyFixCompanions([s], null), []);
  assert.deepEqual(s.companions, []);
});
