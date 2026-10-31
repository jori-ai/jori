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
