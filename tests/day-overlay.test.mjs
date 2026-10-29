// day-overlay.test.mjs — a corrected day keeps its original and layers the
// user's corrections on top; readers get the corrected view, accuracy keeps
// grading the original.
//
// The case (synthetic places): the live-day archive said the morning café was
// the rental; the user said it was the café, and that the afternoon was the
// dog's walk at the port. The email was reissued, the archive kept the rental,
// and "where were we Saturday morning?" would still have answered the rental.
//
// Run: node --test tests/day-overlay.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { at } from "./fixtures/fake-geo.mjs";
const require = createRequire(import.meta.url);
const { correctedLiveDay, correctedResolvedDay, readDayCorrections } = require("../lib/day-overlay.js");
const { computeAccuracy } = require("../lib/live-day.js");

const Z = (hm) => `2026-10-10T${hm}:00Z`;
const T = (hm) => Date.parse(Z(hm));
const DEFAULT_AT = at(50.89, -93.4);
const interval = (id, from, to, name, source, lat = DEFAULT_AT.lat, lon = DEFAULT_AT.lon) => ({
  id, start: Z(from), end: Z(to), start_ts_ms: T(from), end_ts_ms: T(to),
  duration_min: (T(to) - T(from)) / 60000, place: { name, source, confidence: 0.95, lat, lon },
});
const RENTAL = at(0, 0);
const CAFE = at(53.72, -73.39);
const ARCHIVE = {
  date: "2026-10-10", tz: "Asia/Jerusalem",
  intervals: [
    interval("i1", "04:40", "05:30", "The Rental", "confirmed_stop", RENTAL.lat, RENTAL.lon),
    interval("i2", "12:00", "13:30", "The Rental", "confirmed_stop", RENTAL.lat, RENTAL.lon),
  ],
};
// His answer for the café, on its visit row.
const CAFE_ANSWER = { id: "v-dama", place_type: "user-confirmed", place_name: "Cafe Example",
  arrived_at: Z("04:49"), departed_at: Z("05:28"), latitude: CAFE.lat, longitude: CAFE.lon };
// His words about the afternoon, recorded with day-correction.
const PORT = { said_at: "2026-10-11T06:00:00Z", channel: "chat", text: "the afternoon was the dog's walk at the port",
  applies_from: Z("12:00"), applies_to: Z("13:30") };
const LOOSE = { said_at: "2026-10-11T06:01:00Z", channel: "email", text: "we also bought bagels at the corner bakery" };

test("readers get his answer first, with what we believed kept beside it", () => {
  const v = correctedLiveDay(ARCHIVE, { confirmations: [CAFE_ANSWER], corrections: [PORT, LOOSE] });
  assert.equal(v.view, "corrected");
  assert.equal(v.intervals[0].place.name, "Cafe Example");
  assert.equal(v.intervals[0].place.source, "user_confirmed");
  assert.equal(v.intervals[0].original_place.name, "The Rental");
  assert.equal(v.corrections_applied, 1);
  assert.equal(v.intervals[1].his_corrections[0].text, "the afternoon was the dog's walk at the port");
  assert.equal(v.intervals[1].place.name, "The Rental", "his words travel verbatim; code never re-titles from a sentence");
  assert.equal(v.his_corrections_unanchored[0].text, "we also bought bagels at the corner bakery");
});

test("the stored day is never changed, so accuracy still grades the original", () => {
  const before = JSON.stringify(ARCHIVE);
  correctedLiveDay(ARCHIVE, { confirmations: [CAFE_ANSWER], corrections: [PORT] });
  assert.equal(JSON.stringify(ARCHIVE), before);
  // Graded on the original: the Airbnb (170 m off) contradicts the user's café.
  const acc = computeAccuracy(ARCHIVE, [CAFE_ANSWER]);
  assert.ok(acc.name_accuracy === 0 || acc.contradicted_min > 0, JSON.stringify(acc));
  // Graded on the corrected view it would read as right: exactly what must not happen.
  const v = correctedLiveDay(ARCHIVE, { confirmations: [CAFE_ANSWER] });
  assert.notDeepEqual(computeAccuracy(v, [CAFE_ANSWER]).name_accuracy, acc.name_accuracy);
});

test("an answer for a different stretch does not rename the interval", () => {
  // 10 shared minutes of a 50-minute interval and a 60-minute row: not the same stretch.
  const other = { ...CAFE_ANSWER, arrived_at: Z("05:20"), departed_at: Z("06:20") };
  const v = correctedLiveDay(ARCHIVE, { confirmations: [other] });
  assert.equal(v.intervals[0].place.name, "The Rental");
  assert.equal(v.intervals[0].original_place, undefined);
});

test("non-stop and machine rows are not his naming answers", () => {
  const ns = { ...CAFE_ANSWER, place_type: "non-stop", place_name: "walking" };
  const guess = { ...CAFE_ANSWER, place_type: "default-applied" };
  const v = correctedLiveDay(ARCHIVE, { confirmations: [ns, guess] });
  assert.equal(v.intervals[0].place.name, "The Rental");
});

test("location-day: his words ride on the stop they are about", () => {
  const resolved = { date: "2026-10-10", stops: [
    { id: "s1", start_ts_ms: T("04:49"), end_ts_ms: T("05:28"), place: { name: "Cafe Example" } },
    { id: "s2", start_ts_ms: T("12:00"), end_ts_ms: T("13:30"), place: { name: "The Rental" } },
  ] };
  const out = correctedResolvedDay(resolved, [PORT, LOOSE]);
  assert.equal(out.stops[0].his_corrections, undefined);
  assert.equal(out.stops[1].his_corrections[0].text, PORT.text);
  assert.equal(out.his_day_corrections.length, 2);
  assert.equal(out.his_corrections_unanchored.length, 1);
  assert.equal(resolved.stops[1].his_corrections, undefined, "resolve-day output is not mutated");
  assert.equal(correctedResolvedDay(resolved, []), resolved, "nothing to add: unchanged");
});

test("reads the same store day-correction writes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "day-overlay-"));
  fs.writeFileSync(path.join(dir, "2026-10-10.jsonl"), JSON.stringify(PORT) + "\n{torn\n");
  const rows = readDayCorrections("2026-10-10", dir);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, PORT.text);
  fs.rmSync(dir, { recursive: true, force: true });
});
