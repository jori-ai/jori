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
import { at } from "./fixtures/fake-geo.mjs";

const require = createRequire(import.meta.url);
const { computeAccuracy, farCorrections, judgeSamePlaces, _internal } = require("../lib/live-day.js");
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

// A clock-change day is 23 or 25 hours, and no bucket may hold more minutes
// than the day did. The shape: an overnight seed running in from the evening
// before, an arrival stop overlapping its tail, and a stay running past the
// next midnight. Summing raw durations gave 1913 unexamined minutes.
test("a clock-change day is as long as it was lived", () => {
  const fall = dayWindowMs("2026-11-01", "America/Chicago");
  assert.equal(new Date(fall.start).toISOString(), "2026-11-01T05:00:00.000Z");
  assert.equal(fall.end - fall.start, 25 * 3600_000);
  const spring = dayWindowMs("2026-03-08", "America/Chicago");
  assert.equal(new Date(spring.start).toISOString(), "2026-03-08T06:00:00.000Z");
  assert.equal(spring.end - spring.start, 23 * 3600_000);
});

test("overlapping and boundary-crossing intervals count each minute once", () => {
  const acc = computeAccuracy({ date: "2026-11-01", tz: "America/Chicago", intervals: [
    iv("overnight seed", "2026-10-31T22:05:00.000Z", "2026-11-01T09:55:00.000Z", "calendar_seed", 0.5),
    iv("arrival", "2026-11-01T09:30:00.000Z", "2026-11-01T10:33:00.000Z", "user_confirmed", 1),
    iv("stay", "2026-11-01T12:00:00.000Z", "2026-11-02T07:00:00.000Z"),
  ] });
  // 295 (05:00Z-09:55Z) + 38 (past the seed) + 1080 (to 06:00Z).
  assert.equal(acc.covered_min, 1413);
  assert.equal(acc.unexamined_min, 1413);
  assert.equal(acc.corroborated_min + acc.contradicted_min + acc.unexamined_min, acc.covered_min);
});

// Name grading: an answer 60-500 m off is a contradiction unless a model says
// the two names are one place. Synthetic: a school named the same 98 m apart.
const SCHOOL = at(0, 0), GATE = at(98, 0), MARKET = at(900, 0);
const named = (id, from, to, name, p, source = "spine_dwell") => ({
  ...iv(id, from, to), place: { name, source, confidence: 0.85, lat: p.lat, lon: p.lon, address: `${name}, 2 Sample St` },
});
const answer = (from, to, name, p) => ({ place_type: "user-confirmed", place_name: name,
  arrived_at: from, departed_at: to, latitude: p.lat, longitude: p.lon });
const DAY = { date: "2026-10-27", tz: "UTC", intervals: [
  named("market", "2026-10-27T13:00:00.000Z", "2026-10-27T13:48:00.000Z", "Sample Market", MARKET),
  named("school", "2026-10-27T14:00:00.000Z", "2026-10-27T14:24:00.000Z", "Example School", SCHOOL),
] };
const ANSWERS = [
  answer("2026-10-27T13:00:00.000Z", "2026-10-27T13:48:00.000Z", "Sample Market", MARKET),
  answer("2026-10-27T14:00:00.000Z", "2026-10-27T14:24:00.000Z", "Example School (North Gate)", GATE),
];

test("only the far answer is asked about, with names, address and distance only", async () => {
  const pairs = farCorrections(DAY, ANSWERS);
  assert.deepEqual(pairs.map((p) => [p.id, p.off_by_m]), [["school", 98]]);
  const calls = [];
  const same = await judgeSamePlaces(pairs, { decideImpl: async (o) => { calls.push(o); return { value: true }; } });
  assert.equal(calls[0].site, "live-day-same-place");
  assert.deepEqual(calls[0].state, { asserted: { name: "Example School", address: "Example School, 2 Sample St" },
    corrected: { name: "Example School (North Gate)" }, distance_m: 98 });
  const acc = computeAccuracy(DAY, ANSWERS, { samePlace: same });
  assert.equal(acc.name_accuracy, 1);
  assert.equal(acc.contradictions.length, 0);
  assert.equal(acc.judged_same_place[0].he_said, "Example School (North Gate)");
});

test("no answer, or a no, keeps the distance rule's verdict", async () => {
  assert.equal(computeAccuracy(DAY, ANSWERS).name_accuracy, 0.667);
  const pairs = farCorrections(DAY, ANSWERS);
  for (const decideImpl of [async () => { throw new Error("jev down, ladder down"); }, async () => ({ value: false })]) {
    const same = await judgeSamePlaces(pairs, { decideImpl });
    assert.equal(same.size, 0);
    const acc = computeAccuracy(DAY, ANSWERS, { samePlace: same });
    assert.equal(acc.name_accuracy, 0.667);
    assert.equal(acc.contradictions[0].off_by_m, 98);
  }
});

test("past 500 m a same-place yes is never asked for, and never counted", () => {
  const far = [ANSWERS[0], answer("2026-10-27T14:00:00.000Z", "2026-10-27T14:24:00.000Z", "Example School", at(700, 0))];
  assert.equal(farCorrections(DAY, far).length, 0);
  assert.equal(computeAccuracy(DAY, far, { samePlace: new Set(["school"]) }).name_accuracy, 0.667);
});
