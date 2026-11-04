// resolve-day-spine-gap-bridge.test.mjs — the Market Hall walk that got
// bridged over (Mason, 2026-09-18, replying to the 9/17 daily summary):
//
//   "I see my walk to Home Quarter market on the map. Why doesn't it appear in
//    the narrative? Find the root cause and fix"
//
// mergeDuplicateStops bridges two same-place fragments across gaps up to 45
// minutes to absorb ordinary GPS noise (two "Home" clusters either side of a
// brief signal drop). On 2026-09-17 it bridged a 12-minute gap straight
// across a real, GPS-corroborated 33-minute dwell at 76 Oak Ave/Home Quarter
// Market that the day-path spine (a separate GPS reconstruction) had already
// found — and addSpineDwells, which exists to seat exactly this kind of
// spine-only dwell, runs LAST and only fills windows no stop already claims,
// so by the time it looked the bridged Home stop already appeared to cover
// the whole window.
//
// Run: node --test tests/resolve-day-spine-gap-bridge.test.mjs

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
const { mergeDuplicateStops } = _internal;

const ms = (hhmm) => Date.parse(`2026-09-17T${hhmm}:00-04:00`);

const HOME = { ...LL(0.0, 0.0) };
const MARKET_HALL = { ...LL(-252.74, -66.71) }; // ~250m from HOME

function homeStop(id, start, end) {
  return {
    id, start, end, start_ts_ms: ms(start), end_ts_ms: ms(end),
    lat: HOME.lat, lon: HOME.lon,
    place: { name: "Home (Example)", source: "named_location" },
  };
}

test("a real spine dwell inside the gap blocks the bridge", () => {
  const prev = homeStop("s1", "00:00", "10:02");
  const next = homeStop("s2", "10:14", "23:49");
  const dayPath = {
    spine: [
      {
        type: "dwell", major: true,
        start_ms: ms("10:06"), end_ms: ms("10:39"),
        place: { name: "76 Oak Ave", lat: MARKET_HALL.lat, lon: MARKET_HALL.lon },
      },
    ],
  };

  const out = mergeDuplicateStops([prev, next], dayPath);

  assert.equal(out.length, 2, "the gap must stay open — no bridge across a real excursion");
  assert.equal(out[0].id, "s1");
  assert.equal(out[1].id, "s2");
  assert.equal(out[0].end, "10:02");
  assert.equal(out[1].start, "10:14");
});

test("ordinary GPS noise still bridges when the spine has nothing else in the gap", () => {
  const prev = homeStop("s1", "00:00", "10:02");
  const next = homeStop("s2", "10:14", "23:49");
  const dayPathEmpty = { spine: [] };
  const dayPathSamePlace = {
    spine: [
      {
        type: "dwell", major: true,
        start_ms: ms("10:04"), end_ms: ms("10:10"),
        place: { name: "Home (Example)", lat: HOME.lat, lon: HOME.lon }, // same place as the bridge
      },
    ],
  };

  for (const dayPath of [undefined, dayPathEmpty, dayPathSamePlace]) {
    const out = mergeDuplicateStops([homeStop("s1", "00:00", "10:02"), homeStop("s2", "10:14", "23:49")], dayPath);
    assert.equal(out.length, 1, "no real excursion in the gap — the old bridging behavior must be unchanged");
    assert.equal(out[0].end, "23:49");
  }
});

test("a spine dwell that only partly overlaps the gap still blocks the bridge (imprecise neighbour boundary)", () => {
  // Mirrors the actual 9/17 shape: the neighbouring `user_confirmed` row started
  // at 10:14, but the spine dwell it was fragmenting didn't end until 10:39 —
  // 25 minutes past the nominal gap boundary. Overlap, not containment, is
  // what has to trigger the guard.
  const prev = homeStop("s1", "00:00", "10:02");
  const next = homeStop("s2", "10:14", "23:49");
  const dayPath = {
    spine: [
      {
        type: "dwell", major: true,
        start_ms: ms("10:06"), end_ms: ms("10:39"), // ends well after next.start
        place: { name: "76 Oak Ave", lat: MARKET_HALL.lat, lon: MARKET_HALL.lon },
      },
    ],
  };

  const out = mergeDuplicateStops([prev, next], dayPath);
  assert.equal(out.length, 2, "partial overlap with the gap is still proof the bridge is wrong");
});
