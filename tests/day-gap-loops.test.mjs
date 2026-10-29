// day-gap-loops.test.mjs — a walk or drive that IS the event gets an entry;
// one that only gets the user somewhere does not. Requirement: a drive to meet
// friends at a restaurant and the drive back are not entries; a drive or walk
// is only interesting when it is the event itself.
// Places are synthetic (tests/fixtures/fake-geo.mjs) with the real days' geometry.
//
// Run: node --test tests/day-gap-loops.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { detectGapLoops } = require(path.join(ROOT, "lib/day-excursions.js"));
const { at: fakeAt } = await import(path.join(ROOT, "tests/fixtures/fake-geo.mjs"));
const LL = (e, n) => { const p = fakeAt(e, n); return { lat: p.lat, lon: p.lon }; };
// Planar metres between two points, at the points' own latitude.
const metres = (p0, p1) => Math.hypot((p1.lat - p0.lat) * 111320,
  (p1.lon - p0.lon) * 111320 * Math.cos(((p0.lat + p1.lat) / 2) * Math.PI / 180));

const T = (hms) => Date.parse(`2026-10-05T${hms}+03:00`);
const FLAT = { ...LL(0, 0) };
const BEACH = { ...LL(281.49, 579.55) };      // ~650 m north
const DINNER = { ...LL(1694.94, 4758.51) };   // ~5 km

// A path as day-path legs: consecutive [time, point] pairs.
function pathOf(steps) {
  const legs = [];
  for (let i = 0; i < steps.length - 1; i++) {
    const [t0, p0] = steps[i], [t1, p1] = steps[i + 1];
    const m = metres(p0, p1);
    legs.push({ t0: T(t0), t1: T(t1), lat0: p0.lat, lon0: p0.lon, lat1: p1.lat, lon1: p1.lon, m });
  }
  return { segments: [{ legs }] };
}
const mid = (a, b) => ({ lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 });
const stop = (id, a, b, p, name) => ({ id, start_ts_ms: T(a), end_ts_ms: T(b), ...p,
  place: { name, source: "user_confirmed" }, photos: [] });
const noFeatures = { features: async () => [] };

test("walk out and back, a stay home, then the drive to dinner: one walk + the stay, no drive", async () => {
  const dayPath = pathOf([
    ["17:20:00", FLAT], ["17:25:00", FLAT], ["17:40:00", BEACH], ["17:52:00", mid(BEACH, FLAT)],
    ["18:05:00", FLAT], ["18:26:00", FLAT], ["18:37:00", mid(FLAT, DINNER)], ["18:49:00", DINNER],
  ]);
  const stops = [stop("s-1", "14:44:00", "17:20:00", FLAT, "The rented flat"),
                 stop("s-2", "18:49:00", "21:55:00", DINNER, "Example Bistro")];
  const { stops: out, loops } = await detectGapLoops(stops, dayPath, noFeatures);
  const walk = out.find(s => s.excursion);
  assert.ok(walk, "the walk is an entry");
  assert.equal(walk.excursion.mode, "walking");
  assert.ok(walk.start_ts_ms >= T("17:25:00") && walk.start_ts_ms <= T("17:33:00"));
  assert.equal(walk.end_ts_ms, T("18:05:00"));
  const back = out.find(s => s.returned_after_loop);
  assert.ok(back && back.start_ts_ms === T("18:05:00") && back.end_ts_ms === T("18:26:00"));
  assert.equal(out.filter(s => s.excursion).length, 1, "the drive to dinner is not an entry");
  assert.equal(loops.filter(l => l.emitted).length, 1);
});

test("a drive to a destination is never a loop", async () => {
  const dayPath = pathOf([["18:26:00", FLAT], ["18:37:00", mid(FLAT, DINNER)], ["18:49:00", DINNER]]);
  const stops = [stop("s-1", "14:44:00", "18:26:00", FLAT, "The rented flat"),
                 stop("s-2", "18:49:00", "21:55:00", DINNER, "Example Bistro")];
  const { stops: out } = await detectGapLoops(stops, dayPath, noFeatures);
  assert.equal(out.length, 2);
});

test("a drive that loops back home is a Drive entry", async () => {
  const FAR = { ...LL(3351.77, 6362.24) };   // ~7 km
  const dayPath = pathOf([["10:00:00", FLAT], ["10:20:00", FAR], ["10:40:00", FLAT]]);
  const stops = [stop("s-1", "08:00:00", "10:00:00", FLAT, "The rented flat"),
                 stop("s-2", "12:00:00", "13:00:00", DINNER, "Lunch")];
  const { stops: out } = await detectGapLoops(stops, dayPath, noFeatures);
  const d = out.find(s => s.excursion);
  assert.equal(d.excursion.mode, "driving");
  assert.match(d.place.name, /^Drive/);
});

test("a walk the home stop swallowed is carved out of it (2026-10-04)", async () => {
  const SEAWALL = { ...LL(-368.77, 134.77) };
  const dayPath = pathOf([
    ["14:40:00", mid(FLAT, BEACH)], ["14:48:00", FLAT], ["17:54:00", FLAT], ["18:15:00", mid(FLAT, BEACH)],
    ["18:38:00", BEACH], ["19:03:30", SEAWALL], ["19:11:00", FLAT], ["19:15:00", FLAT],
  ]);
  const home = stop("s-1", "14:40:00", "19:00:00", FLAT, "The rented flat");
  const sliver = { ...stop("s-2", "19:03:00", "19:04:00", SEAWALL, "The Seawall Promenade"), duration_min: 1 };
  const later = stop("s-3", "19:11:00", "23:59:00", FLAT, "The rented flat");
  const { stops: out } = await detectGapLoops([home, sliver, later], dayPath, noFeatures);
  const walk = out.find(s => s.excursion);
  assert.ok(walk, "the evening walk is an entry");
  // left ~4 min before the 18:15 fix 325 m out — not at the 17:54 fix at home
  assert.ok(walk.start_ts_ms > T("18:10:00") && walk.start_ts_ms < T("18:12:00"));
  assert.equal(walk.end_ts_ms, T("19:11:00"));
  assert.equal(walk.place.name, "Walk to The Seawall Promenade");
  assert.equal(home.end_ts_ms, walk.start_ts_ms, "home gives the walk back");
  assert.ok(!out.includes(sliver), "the 1-minute sliver is part of the walk");
});

test("the walk IN to a stop is not a walk out of it", async () => {
  const dayPath = pathOf([["14:30:00", BEACH], ["14:40:00", FLAT], ["16:00:00", FLAT]]);
  const { stops: out } = await detectGapLoops([stop("s-1", "14:40:00", "16:00:00", FLAT, "The rented flat")],
                                             dayPath, noFeatures);
  assert.equal(out.length, 1);
});

// An evening walk from the flat to the seafront and the port.
// The flat's stop had been handed the walk's two 20:04 photos by nearest time,
// and the step out of the door was a zero-span leg at the loop's first instant.
test("a walk takes its own photos and its first step from the stop it leaves (2026-10-17)", async () => {
  const T17 = (hms) => Date.parse(`2026-10-17T${hms}+03:00`);
  const OUT = { ...LL(150.79, 120.09) };    // ~205 m, the first fix
  const SEA = { ...LL(63.14, 317.57) };    // the seafront, where the photos were
  const PORT = { ...LL(-441.44, 35.59) };   // the turnaround
  const steps = [["19:56:50", FLAT], ["19:56:50", OUT], ["20:02:23", SEA], ["20:14:51", PORT],
                 ["20:24:03", mid(PORT, SEA)], ["20:35:42", FLAT]];
  const legs = [];
  for (let i = 0; i < steps.length - 1; i++) {
    const [t0, p0] = steps[i], [t1, p1] = steps[i + 1];
    legs.push({ t0: T17(t0), t1: T17(t1), lat0: p0.lat, lon0: p0.lon, lat1: p1.lat, lon1: p1.lon,
                m: metres(p0, p1) });
  }
  const photo = (uuid, hms) => ({ uuid, ts: new Date(T17(hms)).toISOString() });
  const flat = { id: "s-5", start_ts_ms: T17("16:00:20"), end_ts_ms: T17("19:56:50"), ...FLAT,
    place: { name: "The rented flat", source: "user_confirmed" },
    photos: [photo("P1700", "17:00:00"), photo("P2004a", "20:04:30"), photo("P2004b", "20:04:35")] };
  const after = { id: "s-p1", start_ts_ms: T17("20:35:42"), end_ts_ms: T17("23:04:00"), ...FLAT,
    place: { name: "The rented flat", source: "confirmed_stop" }, photos: [] };
  const { stops: out } = await detectGapLoops([flat, after], { segments: [{ legs }] },
    { ...noFeatures, hmFromMs: (ms) => new Date(ms + 3 * 3600_000).toISOString().slice(11, 16) });
  const walk = out.find(s => s.excursion);
  assert.ok(walk, "the walk is an entry");
  assert.deepEqual(walk.photos.map(p => p.uuid), ["P2004a", "P2004b"]);
  assert.deepEqual(flat.photos.map(p => p.uuid), ["P1700"], "the flat keeps only its own photo");
  assert.equal(walk.excursion.routed_m, Math.round(legs.reduce((t, l) => t + l.m, 0)),
    "the first step out of the door is part of the walk");
});

test("photos taken after the walk go with the return to the stop", async () => {
  const OUT = { ...LL(149.56, 301.56) };        // ~310 m
  const PORT = { ...LL(-441.44, 35.59) };
  const dayPath = pathOf([["19:00:00", FLAT], ["19:10:00", OUT], ["19:20:00", PORT],
                          ["19:35:00", FLAT], ["21:00:00", FLAT]]);
  const photo = (uuid, hms) => ({ uuid, ts: new Date(T(hms)).toISOString() });
  const flat = { ...stop("s-1", "16:00:00", "21:00:00", FLAT, "The rented flat"),
    photos: [photo("A", "17:00:00"), photo("B", "19:20:00"), photo("C", "20:30:00")] };
  const { stops: out } = await detectGapLoops([flat], dayPath, noFeatures);
  const walk = out.find(s => s.excursion);
  const back = out.find(s => s.returned_after_loop);
  assert.ok(walk && back);
  assert.deepEqual(flat.photos.map(p => p.uuid), ["A"]);
  assert.deepEqual(walk.photos.map(p => p.uuid), ["B"]);
  assert.deepEqual(back.photos.map(p => p.uuid), ["C"]);
});
