// resolve-day-passage-window.test.mjs — a pipeline "not a stop" verdict speaks
// only for the window stop-passage judged, not for the row it was written on.
//
// The incident (2026-10-19, Jerusalem): stop-passage judged the Example Stadium
// visit row at 19:04-19:24 IDT, on two fixes, while the sweeper's early
// departure stood, and Jev called it a walk. iOS then delivered the real
// departure, 22:20, so the `non-stop` row covered a three-hour football game,
// classifyStops flagged the whole 19:04-22:16 stop as a non-stop, and the
// summary showed "Walk around Example Quarter · 2.1 mi" over the photos of the game.
//
// Run: node --test tests/resolve-day-passage-window.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
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
const rd = require(path.join(ROOT, "lib/resolve-day.js"));
const { loadPassageWindows, nonStopSpan } = rd._internal;
const { classifyStops } = rd;

const iso = (s) => Date.parse(s);
const STADIUM = { ...LL(0.0, 0.0) };
const ROW_ID = "8014116e-d3c7-42d5-8891-a97aee8b28ab";

function logFile(rows) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "passage-")), "log.jsonl");
  fs.writeFileSync(f, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
  return f;
}
const passage = (over = {}) => ({ ts: "2026-10-19T18:01:08.457Z", visit_id: ROW_ID, verdict: "passage", applied: true,
  window: { start: "2026-10-19T16:04:18.000Z", end: "2026-10-19T16:23:54.000Z" }, ...over });

function stadiumStop() {
  return { start_ts_ms: iso("2026-10-19T16:04:00Z"), end_ts_ms: iso("2026-10-19T19:16:00Z"), duration_minutes: 192,
    centroid: STADIUM, primary: { name: "אצטדיון טדי (מלחה)", source: "osm_overpass", confidence: 0.6 }, photos: [] };
}
function machineRow(judged) {
  return { id: ROW_ID, arrived_at: "2026-10-19T16:04:18+00:00", departed_at: "2026-10-19T19:20:00+00:00",
    latitude: STADIUM.lat, longitude: STADIUM.lon, place_name: null, place_type: "non-stop",
    notes: "[passage-auto jev] jev: walk (0.90)", judged_window: judged };
}
const ctx = (userConfirmed) => ({ date: "2026-10-19", knownStopsEntries: [], userConfirmed });

test("loadPassageWindows keeps the latest APPLIED passage window per row", () => {
  const f = logFile([
    passage({ verdict: "hold", applied: false, window: { start: "2026-10-19T16:04:18Z", end: "2026-10-19T16:23:57Z" } }),
    passage(),
    { visit_id: "other", verdict: "rest", applied: false, window: { start: "2026-10-19T10:00:00Z", end: "2026-10-19T11:00:00Z" } },
    "not json",
  ]);
  const m = loadPassageWindows(f);
  assert.equal(m.size, 1);
  assert.deepEqual(m.get(ROW_ID), { start_ms: iso("2026-10-19T16:04:18Z"), end_ms: iso("2026-10-19T16:23:54Z") });
  assert.equal(loadPassageWindows("/nonexistent/stop-passage-log.jsonl").size, 0, "no log: nothing known");
});

test("nonStopSpan is the judged part of the row, or the row itself", () => {
  const judged = { start_ms: iso("2026-10-19T16:04:18Z"), end_ms: iso("2026-10-19T16:23:54Z") };
  assert.deepEqual(nonStopSpan(machineRow(judged)), { a: judged.start_ms, d: judged.end_ms });
  const own = nonStopSpan(machineRow(null));
  assert.equal(own.d - own.a, iso("2026-10-19T19:20:00Z") - iso("2026-10-19T16:04:18Z"));
});

test("a 20-minute verdict does not make a three-hour stop a non-stop", () => {
  const judged = { start_ms: iso("2026-10-19T16:04:18Z"), end_ms: iso("2026-10-19T16:23:54Z") };
  const [s] = classifyStops([stadiumStop()], ctx([machineRow(judged)]));
  assert.equal(s.user_non_stop, false);
});

test("without a known judged window, or with his own non-stop, the row still covers the stop", () => {
  const [unknown] = classifyStops([stadiumStop()], ctx([machineRow(null)]));
  assert.equal(unknown.user_non_stop, true, "old behaviour when the log has nothing");
  const his = { ...machineRow(null), notes: null, judged_window: undefined };
  const [answered] = classifyStops([stadiumStop()], ctx([his]));
  assert.equal(answered.user_non_stop, true, "his answer is about the whole row");
});

test("a verdict that judged most of the stop still flags it", () => {
  const judged = { start_ms: iso("2026-10-19T16:04:18Z"), end_ms: iso("2026-10-19T18:30:00Z") };
  const [s] = classifyStops([stadiumStop()], ctx([machineRow(judged)]));
  assert.equal(s.user_non_stop, true);
});

// --- A place the user names for a window overrules the pipeline's own passage verdict ---
// A short errand stop: the phone's visit row carries a machine `non-stop` verdict
// (tag `[passage-auto`), then the user names the place for that window
// (`location-confirm save-at`, no visit row patched). The named stop must stay a stop.
const { addSavedAtStops } = rd._internal;
const SHOP = LL(2400, 900);

function errandStop() {
  return { start_ts_ms: iso("2026-11-27T13:50:21Z"), end_ts_ms: iso("2026-11-27T13:59:50Z"), duration_minutes: 9,
    centroid: { ...SHOP }, primary: { name: null, source: "unknown", confidence: 0 }, photos: [] };
}
function errandRow(notes, place_name = null) {
  return { id: "row-1", arrived_at: "2026-11-27T13:50:17+00:00", departed_at: "2026-11-27T14:00:12+00:00",
    latitude: SHOP.lat, longitude: SHOP.lon, place_name, place_type: "non-stop", notes };
}
const errandCtx = (userConfirmed) => ({ date: "2026-11-27", knownStopsEntries: [], userConfirmed });
const ERRAND_MACHINE_NOTES = "[sweeper] departed_at synthesized | [passage-auto geometry] no rest over 0 min, covered 174 m";
const ERRAND_DAY_FROM = Date.parse("2026-11-27T05:00:00Z"), ERRAND_DAY_TO = Date.parse("2026-11-28T05:00:00Z");
const errandEntry = (over = {}) => ({ ask_id: "lc-at-20261128-133844", name: "Example Bakery",
  centroid: { ...LL(2420, 930) }, source: "user_stated_at",
  stop_window: { start: "2026-11-27T13:50:17+00:00", end: "2026-11-27T14:00:12+00:00" }, ...over });

test("a stop only the pipeline's passage verdict called a non-stop is marked as such", () => {
  const [s] = classifyStops([errandStop()], errandCtx([errandRow(ERRAND_MACHINE_NOTES)]));
  assert.equal(s.user_non_stop, true);
  assert.equal(s.non_stop_machine, true);
});

test("the user's own 'not a stop' answer is never marked machine, even beside a machine row", () => {
  const [s] = classifyStops([errandStop()], errandCtx([
    errandRow(ERRAND_MACHINE_NOTES),
    { ...errandRow(null), id: "row-2", notes: "answered in chat" },
  ]));
  assert.equal(s.user_non_stop, true);
  assert.equal(s.non_stop_machine, undefined);
});

test("a place the user names for the window clears the passage verdict and names the stop", () => {
  const stops = classifyStops([errandStop()], errandCtx([errandRow(ERRAND_MACHINE_NOTES)]));
  const added = addSavedAtStops(stops, [errandEntry()], ERRAND_DAY_FROM, ERRAND_DAY_TO);
  assert.equal(added.length, 1);
  assert.equal(added[0].same_visit, true);
  assert.equal(added[0].passage_overruled, true);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].place.name, "Example Bakery");
  assert.equal(stops[0].place.source, "user_confirmed");
  assert.equal(stops[0].user_non_stop, false, "the user said the stop happened");
  assert.equal(stops[0].non_stop_machine, undefined);
});

test("the user's own 'not a stop' answer survives a later saved place for the same window", () => {
  const stops = classifyStops([errandStop()], errandCtx([{ ...errandRow(null), notes: "answered in chat" }]));
  const added = addSavedAtStops(stops, [errandEntry()], ERRAND_DAY_FROM, ERRAND_DAY_TO);
  assert.equal(added[0].passage_overruled, undefined);
  assert.equal(stops[0].user_non_stop, true);
});

test("a stop that was never a non-stop is untouched", () => {
  const stops = classifyStops([errandStop()], errandCtx([]));
  const added = addSavedAtStops(stops, [errandEntry()], ERRAND_DAY_FROM, ERRAND_DAY_TO);
  assert.equal(added[0].passage_overruled, undefined);
  assert.equal(stops[0].user_non_stop, false);
  assert.equal(stops[0].place.name, "Example Bakery");
});

test("a stretch merged into a walk keeps its non-stop flag", () => {
  const stops = classifyStops([errandStop()], errandCtx([errandRow(ERRAND_MACHINE_NOTES)]));
  stops[0].merged_walk = { members: 2 };
  const added = addSavedAtStops(stops, [errandEntry()], ERRAND_DAY_FROM, ERRAND_DAY_TO);
  assert.equal(added[0].passage_overruled, undefined);
  assert.equal(stops[0].user_non_stop, true);
});
