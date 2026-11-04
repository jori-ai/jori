// stop-passage-turnaround.test.mjs — the far end of a drive is not a "passage".
//
// An airport drop-off run, UTC (local +2h): fixes every five minutes, all
// `driving`. Geometry reads the window as a passage — the user covered 3 km in it —
// which would mark the only record of the airport `non-stop`. A turnaround row
// (bin/day-segments) must reach the evidence step instead, which is where "do
// we already know why the user drove out" is answered.
// Run: node --test tests/stop-passage-turnaround.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { pointsFrom, classifyWindow, isTurnaround, asTurnaround, TURNAROUND_TOKEN } from "../lib/stop-passage.mjs";

// Synthetic coordinates: metres east/north of an obviously fake origin, so the
// fixtures keep the real traces' geometry without pinning a real place.
const ORIGIN = [12.3456, -65.4321];
const M_PER_DEG = 6371000 * Math.PI / 180;
const fakePt = (e, n) => { const lat = ORIGIN[0] + n / M_PER_DEG; return [lat, ORIGIN[1] + e / (M_PER_DEG * Math.cos(lat * Math.PI / 180))]; };
const fakeAt = (e, n) => { const [lat, lon] = fakePt(e, n); return { lat, lon }; };
const fakeRow = (e, n) => { const [latitude, longitude] = fakePt(e, n); return { latitude, longitude }; };

const fix = (t, lat, lon, acc = 5, activity = "driving") =>
  ({ arrived_at: `2026-10-28T${t}Z`, latitude: lat, longitude: lon, accuracy_m: acc, activity });

const TRACE = [
  fix("03:55:59", ...fakePt(0, 0)), fix("04:00:59", ...fakePt(5507.19, -2812.09)),
  fix("04:06:34", ...fakePt(5382.72, -2318.75)), fix("04:11:34", ...fakePt(4026.15, -1460.98)),
  fix("04:16:34", ...fakePt(6411.19, -2784.49)), fix("04:21:35", ...fakePt(1433.04, -1131.96)),
];
const WINDOW = { start: "2026-10-28T04:00:59Z", end: "2026-10-28T04:16:34Z" };

test("geometry alone calls the airport window a passage (the bug)", () => {
  const l1 = classifyWindow({ points: pointsFrom({ fixes: TRACE }), ...WINDOW });
  assert.equal(l1.verdict, "passage");
});

test("a turnaround row is inconclusive instead, so evidence runs and the ask can go out", () => {
  const l1 = classifyWindow({ points: pointsFrom({ fixes: TRACE }), ...WINDOW });
  const t = asTurnaround(l1);
  assert.equal(t.verdict, "inconclusive");
  assert.match(t.reason, /drive out and back/);
  assert.deepEqual(t.features, l1.features);              // the evidence step still reads them
});

test("only the token marks a turnaround; an ordinary row is untouched", () => {
  assert.equal(TURNAROUND_TOKEN, "[turnaround]");
  assert.equal(isTurnaround(`${TURNAROUND_TOKEN} drove 15.4 km out and back`), true);
  assert.equal(isTurnaround("day-segments: osm rung, 4/4 fixes contained"), false);
  assert.equal(isTurnaround(null), false);
});
