// location-ambient geometry (Step 1c + Step 2.5): code, not a model turn.
// Synthetic homes and coordinates; the home zone and walk windows are passed in.

import test from "node:test";
import assert from "node:assert/strict";
import { classifyWander, routineWalk, proximity, haversineM, homes } from "../lib/ambient-geometry.mjs";

const step = (lat, lon, dLat, dLon, n) => Array.from({ length: n }, (_, i) => ({ lat: lat + dLat * i, lon: lon + dLon * i }));

test("haversine sanity: ~111m per 0.001 deg latitude", () => {
  const d = haversineM(12, -65, 12.001, -65);
  assert.ok(d > 110 && d < 112);
});

test("straight walk is transit", () => {
  assert.equal(classifyWander(step(12.3456, -65.4321, 0.0005, 0, 10)).kind, "transit");
});

test("loop around a few blocks is wandering", () => {
  const loop = [];
  for (let i = 0; i < 16; i++) { const a = (i / 16) * 2 * Math.PI; loop.push({ lat: 12.3456 + 0.002 * Math.cos(a), lon: -65.4321 + 0.003 * Math.sin(a) }); }
  const c = classifyWander(loop);
  assert.equal(c.kind, "wandering", JSON.stringify(c));
});

test("sitting still is a tight cluster (transit/skip), too few points is no-data", () => {
  assert.equal(classifyWander(step(12.3456, -65.4321, 1e-5, 1e-5, 6)).kind, "transit");
  assert.equal(classifyWander([{ lat: 1, lon: 1 }]).kind, "no-data");
});

test("homes: the configured names, else the named locations of kind home", () => {
  const entries = [{ name: "Home A", kind: "home", lat: 12.3456, lon: -65.4321 }, { name: "Home C", kind: "home", lat: 2, lon: 2 },
    { name: "Family B", kind: "family", lat: 1, lon: 1 }];
  assert.deepEqual(homes(entries, null).map((h) => h.name), ["Home A", "Home C"]);
  assert.deepEqual(homes(entries, ["Home C"]).map((h) => h.name), ["Home C"]);
});

test("routine walk: at home inside a window skips, at noon does not, far away never, no windows never", () => {
  const opts = { homeList: [{ name: "Home A", lat: 12.3456, lon: -65.4321 }], windows: [[7, 9], [14, 16], [21, 25]], tz: "America/Chicago" };
  const at = (iso) => Date.parse(iso);
  assert.equal(routineWalk(12.3458, -65.4323, at("2026-10-04T13:15:00Z"), opts), "Home A"); // 08:15 CDT
  assert.equal(routineWalk(12.3458, -65.4323, at("2026-10-04T17:00:00Z"), opts), null);     // 12:00 CDT
  assert.equal(routineWalk(34.5678, 10.1234, at("2026-10-04T13:15:00Z"), opts), null);
  assert.equal(routineWalk(12.3458, -65.4323, at("2026-10-05T05:30:00Z"), opts), "Home A"); // 00:30 CDT, late window
  assert.equal(routineWalk(12.3458, -65.4323, at("2026-10-04T13:15:00Z"), { ...opts, windows: [] }), null);
});

test("proximity fires only within 150m, closest first", () => {
  const p = proximity([{ name: "far", lat: 12.3556, lon: -65.4321 }, { name: "near", lat: 12.3461, lon: -65.4321 }], 12.3456, -65.4321);
  assert.equal(p.ranked[0].name, "near");
  assert.equal(p.fire.name, "near");
  assert.equal(proximity([{ name: "far", lat: 12.3556, lon: -65.4321 }], 12.3456, -65.4321).fire, null);
});
