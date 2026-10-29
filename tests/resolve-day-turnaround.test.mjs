// resolve-day-turnaround.test.mjs — an unanswered "where did that drive go?" reaches the summary.
//
// Mason, 2026-10-29: the far end of a drive out and back is a destination worth
// asking about unless the purpose is known. bin/day-segments writes it as a
// `segment-derived` visit row whose notes carry [turnaround]; the live card asks
// about it, and loadOpenTurnarounds lists it in unknown_stops[] so the daily
// summary asks too if the card never got an answer. This file's own stops come
// from the trace, where a drive has no rest, so without the loader the summary
// would not mention the run at all (the 2026-10-28 airport run).
//
// Run: node --test tests/resolve-day-turnaround.test.mjs

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
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
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { _internal } = require(path.join(HERE, "..", "lib", "resolve-day.js"));
const { loadOpenTurnarounds } = _internal;

const realFetch = globalThis.fetch;
const realKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
let rows;
// Set per test: supabaseSelect reads the key when it is called, and returns null
// without one, which would pass the "asks nothing" tests for the wrong reason.
beforeEach(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
  rows = [];
  globalThis.fetch = async () => ({ ok: rows !== null, json: async () => rows });
});
afterEach(() => {
  globalThis.fetch = realFetch;
  if (realKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = realKey;
});

// 2026-10-28, local = UTC+2: the airport run 06:00:59-06:16:34
const AIRPORT_ROW = {
  id: "9f1c-airport", arrived_at: "2026-10-28T04:00:59+00:00", departed_at: "2026-10-28T04:16:34+00:00",
  ...LLR(0.0, 0.0),
  notes: "[turnaround] drove 15.4 km out and back to where it began; 4/4 fixes within 3 km of the far point over 16 min, no stop seen there. Purpose unknown.",
};
const stop = (over) => ({
  id: "s1", start_ts_ms: Date.parse("2026-10-28T04:00:59Z"), end_ts_ms: Date.parse("2026-10-28T04:16:34Z"),
  ...LL(-1233.43, 817.36), place: { name: "Example Airport", confidence: 0.95 }, ...over,
});

test("an unanswered turnaround row becomes an open question for the summary", async () => {
  rows = [AIRPORT_ROW];
  const got = await loadOpenTurnarounds("2026-10-28", [], false);
  assert.equal(got.length, 1);
  assert.equal(got[0].id, "turnaround-9f1c-airport");
  assert.equal(got[0].source, "drive_turnaround");
  assert.equal(got[0].start, "06:00");          // read in the zone of where it was, not the home zone
  assert.equal(got[0].end, "06:16");
  assert.deepEqual([got[0].lat, got[0].lon], [...PT(0.0, 0.0)]);
  assert.deepEqual(got[0].candidates, []);
});

test("a row without the token is not ours", async () => {
  rows = [{ ...AIRPORT_ROW, notes: "day-segments: osm rung, 4/4 fixes contained" }];
  assert.deepEqual(await loadOpenTurnarounds("2026-10-28", [], false), []);
});

test("a named stop over the same window and place closes it (a save-at writes no row)", async () => {
  rows = [AIRPORT_ROW];
  assert.deepEqual(await loadOpenTurnarounds("2026-10-28", [stop()], false), []);
});

test("the flat's stay over the whole drive does not close it: it is 15 km away", async () => {
  rows = [AIRPORT_ROW];
  const flat = stop({ ...LL(-12225.36, 6741.3), place: { name: "The Harbor Flat", confidence: 0.95 },
    start_ts_ms: Date.parse("2026-10-28T00:00:00Z"), end_ts_ms: Date.parse("2026-10-28T10:00:00Z") });
  assert.equal((await loadOpenTurnarounds("2026-10-28", [flat], false)).length, 1);
});

test("a low-confidence or unnamed stop there does not close it", async () => {
  rows = [AIRPORT_ROW];
  const weak = stop({ place: { name: "Airport Boulevard", confidence: 0.4 } });
  const unnamed = stop({ place: { name: null, confidence: 0 } });
  assert.equal((await loadOpenTurnarounds("2026-10-28", [weak, unnamed], false)).length, 1);
});

test("a failed lookup asks nothing rather than guessing", async () => {
  rows = null;
  assert.deepEqual(await loadOpenTurnarounds("2026-10-28", [], false), []);
});
