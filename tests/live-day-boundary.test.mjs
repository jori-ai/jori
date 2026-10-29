// live-day-boundary.test.mjs — the day live-day describes must be the day
// the user was actually living, in the zone it was lived in.
//
// Regression fixture is a real archive's intervals (a day in Paris). It
// reported covered_min 1487 of a possible 1440, because the evening stop was
// still open and ran 155 minutes past the Paris midnight boundary while the
// accuracy math measured against a home-zone (US Eastern) day. The record also
// carried the home zone while every interval in it was anchored to Paris
// midnight (22:00Z).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { computeAccuracy, _internal } = require("../lib/live-day.js");
const { tzOffsetMinutes, offsetIso, dayWindowMs } = _internal;

const ms = (iso) => Date.parse(iso);
const iv = (id, start, end, source = "google_places", confidence = 0.9) => ({
  id,
  start,
  end,
  start_ts_ms: ms(start),
  end_ts_ms: ms(end),
  duration_min: Math.round((ms(end) - ms(start)) / 60_000),
  place: { name: id, source, confidence },
});

// The nine intervals of data/live-day-archive/2026-08-10.json.
const AUG10 = [
  iv("Harvest Cafe overnight", "2026-08-09T22:00:00.000Z", "2026-08-10T07:29:20.685Z"),
  iv("Harvest sliver", "2026-08-10T07:33:03.000Z", "2026-08-10T07:34:03.000Z"),
  iv("The airbnb", "2026-08-10T07:35:53.057Z", "2026-08-10T08:38:45.000Z"),
  iv("Coffee correction", "2026-08-10T08:38:46.000Z", "2026-08-10T08:40:12.000Z", "user_confirmed", 1),
  iv("Les Patios", "2026-08-10T09:25:49.000Z", "2026-08-10T10:31:56.409Z"),
  iv("Arenes de Lutece", "2026-08-10T10:44:05.590Z", "2026-08-10T10:51:36.000Z"),
  iv("Bistro des Lettres", "2026-08-10T11:04:40.000Z", "2026-08-10T11:53:29.596Z"),
  iv("Le Chocolat", "2026-08-10T12:20:48.403Z", "2026-08-10T13:01:46.000Z"),
  iv("Bastille Hideaway", "2026-08-10T13:06:46.000Z", "2026-08-11T00:35:48.000Z"),
];

test("tzOffsetMinutes reads the zone, not a hardcoded ET literal", () => {
  assert.equal(tzOffsetMinutes("2026-08-10", "Europe/Paris"), 120);
  assert.equal(tzOffsetMinutes("2026-08-10", "America/New_York"), -240);
  // DST actually moves it — a fixed -04:00 literal is wrong half the year.
  assert.equal(tzOffsetMinutes("2026-01-15", "America/New_York"), -300);
});

test("offsetIso renders an offset the calendar CLI can parse", () => {
  assert.equal(offsetIso(120), "+02:00");
  assert.equal(offsetIso(-240), "-04:00");
  assert.equal(offsetIso(-330), "-05:30");
});

test("a Paris day starts at 22:00Z the previous evening", () => {
  const win = dayWindowMs("2026-08-10", "Europe/Paris");
  assert.equal(new Date(win.start).toISOString(), "2026-08-09T22:00:00.000Z");
  assert.equal(win.end - win.start, 24 * 3600_000);
});

test("2026-08-10 no longer reports more minutes than a day holds", () => {
  const acc = computeAccuracy({ date: "2026-08-10", tz: "Europe/Paris", intervals: AUG10 });
  // The bug: 1487.
  assert.ok(acc.covered_min <= 1440, `covered_min ${acc.covered_min} exceeds a day`);
  // The evening stop is credited up to the boundary and no further: it began
  // 13:06:46Z and the Paris day ends 22:00:00Z, so 533 of its 689 minutes count.
  assert.equal(acc.covered_min, 1331);
});

test("rates stay within [0,1] once the window is clamped", () => {
  const acc = computeAccuracy({ date: "2026-08-10", tz: "Europe/Paris", intervals: AUG10 });
  assert.ok(acc.resolution_rate >= 0 && acc.resolution_rate <= 1, `rate ${acc.resolution_rate}`);
  assert.ok(acc.user_confirmed_share >= 0 && acc.user_confirmed_share <= 1);
});

test("a home-zone day is unchanged — the home case keeps its old answer", () => {
  const home = [
    iv("Home Example", "2026-08-10T04:00:00.000Z", "2026-08-10T13:00:00.000Z"),
    iv("Office", "2026-08-10T14:00:00.000Z", "2026-08-10T18:00:00.000Z"),
  ];
  const acc = computeAccuracy({ date: "2026-08-10", tz: "America/New_York", intervals: home });
  assert.equal(acc.covered_min, 540 + 240);
});

test("a missing tz falls back to the home zone rather than throwing", () => {
  const acc = computeAccuracy({
    date: "2026-08-10",
    intervals: [iv("x", "2026-08-10T12:00:00.000Z", "2026-08-10T13:00:00.000Z")],
  });
  assert.equal(acc.covered_min, 60);
});

test("a night's sleep in Paris is not reported as a daytime coverage gap", () => {
  // 00:30 -> 07:30 Paris = 22:30Z -> 05:30Z. Midpoint 02:00 Paris is 20:00 ET,
  // which the old ET-anchored test treated as daytime.
  const withNight = [
    iv("evening", "2026-08-09T22:00:00.000Z", "2026-08-09T22:30:00.000Z"),
    iv("morning", "2026-08-10T05:30:00.000Z", "2026-08-10T09:00:00.000Z"),
  ];
  const acc = computeAccuracy({ date: "2026-08-10", tz: "Europe/Paris", intervals: withNight });
  assert.equal(acc.coverage_gaps.length, 0);
});
