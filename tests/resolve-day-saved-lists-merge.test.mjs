// resolve-day-saved-lists-merge.test.mjs — the saved-place rung reads every
// saved list the installation has, not one snapshot.
//
// The shape: a 52-minute lunch at a restaurant the user had saved in a second,
// live list (marks synced daily), ~21 m from where they sat, that shipped as a
// street address because the rung read only a weeks-old map export, which did
// not have it. The rung now reads both lists; the same venue in both stays one
// place (also under two place ids within 30 m), so it never reads as a tie.
//
// Geometry is a real lunch's (metres kept), placed around the fake origin of
// tests/fixtures/fake-geo.mjs; names and addresses are invented.
//
// Run: node --test tests/resolve-day-saved-lists-merge.test.mjs

import "./synthetic-instance.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { at } from "./fixtures/fake-geo.mjs";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { _internal } = require(path.join(HERE, "..", "lib", "resolve-day.js"));
const { nameFromSavedPlaces, mergeSavedLists } = _internal;

const BAR = at(-788.89, 420.35);
const EXPORT = [
  { name: "Bar Gaivota", ...BAR, address: null, place_id: "g-gaivota" },
];
const LIVE = [
  { name: "Tasca Exemplo", ...at(-20.81, -1.73),
    address: "Rua Exemplo 84, Sample City", place_id: "f-tasca" },
  { name: "Bar Gaivota", ...BAR, address: null, place_id: "g-gaivota" },
];

const MIN = 60_000;
const T0 = Date.parse("2099-03-09T11:30:12Z");
const SEAT = at(0, 0);

function lunchPings() {
  const out = [];
  for (let i = 0; i < 12; i++) {
    out.push({ ts: T0 + i * 4.3 * MIN, ...at((i % 2 - 0.5) * 2.83, (i % 3 - 1) * 2.23), acc: 15, kind: "transit",
               activity: i === 3 || i === 7 ? "stationary" : "unknown" });
  }
  return out;
}

function lunchStop() {
  return {
    id: "s-1", start: "13:30", end: "14:22",
    start_ts_ms: T0, end_ts_ms: T0 + 52 * MIN, duration_min: 52,
    ...SEAT,
    place: { name: null, address: "90 Example Road, Sample City",
             source: "unknown", confidence: 0, distance_m: null },
    photos: [],
  };
}

test("a place only in the live list joins the list, a shared one does not double", () => {
  const merged = mergeSavedLists(EXPORT, LIVE);
  assert.deepEqual(merged.map(p => p.name).sort(), ["Bar Gaivota", "Tasca Exemplo"]);
});

test("the same venue under two place ids inside 30 m is still one place", () => {
  const twin = [{ name: "bar gaivota", ...at(-787.95, 421.46), address: null, place_id: "f-other" }];
  assert.equal(mergeSavedLists(EXPORT, twin).length, 1);
});

test("a sit beside a place only the live list has takes its name", () => {
  const stops = [lunchStop()];
  const saved = mergeSavedLists(EXPORT, LIVE);
  const { named } = nameFromSavedPlaces(stops, lunchPings(), { savedPlaces: saved });
  assert.equal(named.length, 1);
  assert.equal(stops[0].place.name, "Tasca Exemplo");
  assert.equal(stops[0].place.source, "saved_place");
});

test("without the live list the same sit stays unnamed", () => {
  const stops = [lunchStop()];
  const { named } = nameFromSavedPlaces(stops, lunchPings(), { savedPlaces: EXPORT });
  assert.equal(named.length, 0);
  assert.equal(stops[0].place.name, null);
});
