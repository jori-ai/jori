// A confirmed place name must stay attached to the window the user confirmed.
//
// Regression source: a live-day archive (its shape; synthetic places via
// tests/fixtures/fake-geo.mjs). An interval runs 22:00Z -> 07:29Z (569
// minutes, overnight) and is named "Corner Cafe". Its own evidence_log holds
// both halves of the story:
//
//   gps_dwell           | 569min cluster at the rental -> The airbnb (user_confirmed, conf 1)
//   user_confirmed_carry| Prior user_confirmed "Corner Cafe" carried forward; current GPS resolution overridden
//
// resolve-day had already identified the overnight cluster correctly. A stale
// 23-minute cafe confirmation from earlier the same day overwrote it, so the
// permanent record says the user slept nine and a half hours at a cafe.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { at } from "./fixtures/fake-geo.mjs";

// Resolve relative to this file so the test exercises the checkout it lives in.
const require = createRequire(import.meta.url);
const RENTAL = at(0, 0); // the overnight rental
const { _internal: {
  preservePriorBeliefs, isDegenerate, shouldReplaceDay, hasObservedIntervals,
} } = require("../lib/live-day.js");

const MIN = 60_000;
const T0 = Date.parse("2026-08-09T22:00:00.000Z");

function interval(id, startMin, durMin, name, source, extra = {}) {
  const start_ts_ms = T0 + startMin * MIN;
  const end_ts_ms = start_ts_ms + durMin * MIN;
  return {
    id,
    start: new Date(start_ts_ms).toISOString(),
    end: new Date(end_ts_ms).toISOString(),
    start_ts_ms,
    end_ts_ms,
    open: false,
    type: "stop",
    place: {
      name,
      source,
      confidence: 1,
      lat: extra.lat ?? RENTAL.lat,
      lon: extra.lon ?? RENTAL.lon,
      address: null,
    },
    calendar: null,
    gps_status: "supports",
    companions: [],
    photos: [],
    duration_min: durMin,
    pattern: "dwell",
    activity_hint: null,
    evidence_log: [],
  };
}

const carryLines = (iv) =>
  iv.evidence_log.filter((e) => e.source === "user_confirmed_carry");

test("a 23-minute confirmation cannot rename the 569-minute overnight stop", () => {
  // The real shape: the cafe visit sits inside the overnight cluster.
  const overnight = interval("iv-overnight", 0, 569, "The airbnb", "user_confirmed", RENTAL);
  const priorCafe = interval("iv-cafe-prior", 540, 23, "Corner Cafe", "user_confirmed", at(285.32, 200.16));

  const newIntervals = [overnight];
  preservePriorBeliefs(newIntervals, [priorCafe]);

  assert.equal(overnight.place.name, "The airbnb",
    "the overnight stop keeps the name resolve-day gave it");
  assert.equal(overnight.place.lat, RENTAL.lat, "and keeps its own coordinates");
  assert.equal(carryLines(overnight).length, 0, "no carry was performed");

  // The confirmation is not lost — it is recorded as evidence on the host stop.
  const contained = overnight.evidence_log.filter(
    (e) => e.source === "user_confirmed_contained");
  assert.equal(contained.length, 1);
  assert.match(contained[0].claim, /Corner Cafe/);

  // ...and it is NOT re-added as its own interval, which would double-count
  // 23 minutes that the overnight stop already covers.
  assert.equal(newIntervals.length, 1);
});

test("a confirmation still renames the stop it actually describes", () => {
  const LUNCH = at(-373.14, -144.54);
  const lunch = interval("iv-lunch", 0, 35, "Rue Example", "osm_overpass", LUNCH);
  const priorLunch = interval("iv-lunch-prior", 2, 30, "Bistro Example", "user_confirmed", at(-365.82, -133.42));

  const newIntervals = [lunch];
  preservePriorBeliefs(newIntervals, [priorLunch]);

  assert.equal(lunch.place.name, "Bistro Example");
  assert.equal(lunch.place.source, "user_confirmed");
  assert.equal(lunch.gps_status, "confirmed");
  // Geometry stays with the interval GPS actually measured.
  assert.equal(lunch.place.lat, LUNCH.lat);
  assert.equal(carryLines(lunch).length, 1);
});

test("a stop that merely grew a little still adopts its confirmation", () => {
  // 30min confirmed -> 80min settled is the same lunch, not a different stop.
  const grown = interval("iv-grown", 0, 80, "unresolved", "osm_overpass");
  const prior = interval("iv-grown-prior", 0, 30, "Le Comptoir", "user_confirmed");

  const newIntervals = [grown];
  preservePriorBeliefs(newIntervals, [prior]);

  assert.equal(grown.place.name, "Le Comptoir");
});

test("a confirmation with no overlapping interval is carried forward whole", () => {
  const morning = interval("iv-morning", 0, 60, "Bastille Hideaway", "accommodation");
  const orphan = interval("iv-orphan", 300, 45, "Darna", "user_confirmed");

  const newIntervals = [morning];
  preservePriorBeliefs(newIntervals, [orphan]);

  assert.equal(newIntervals.length, 2);
  assert.ok(newIntervals.some((i) => i.place.name === "Darna"));
  assert.equal(morning.place.name, "Bastille Hideaway");
});

test("two confirmations cannot both claim the same interval", () => {
  const stop = interval("iv-shared", 0, 60, "unresolved", "osm_overpass");
  const longer = interval("iv-p1", 0, 55, "Khaaw Hoom", "user_confirmed");
  const shorter = interval("iv-p2", 5, 40, "Le Chocolat", "user_confirmed");

  const newIntervals = [stop];
  preservePriorBeliefs(newIntervals, [shorter, longer]);

  // Longest confirmation wins the interval. The other is NOT re-added as a
  // second interval over the same minutes — it is kept as evidence.
  assert.equal(stop.place.name, "Khaaw Hoom");
  assert.equal(carryLines(stop).length, 1, "renamed exactly once");
  assert.equal(newIntervals.length, 1, "no duplicate stop over the same minutes");
  assert.ok(stop.evidence_log.some(
    (e) => e.source === "user_confirmed_contained" && /Le Chocolat/.test(e.claim)));
});

test("a partly-clipped confirmation is not re-added as an overlapping stop", () => {
  // resolve-day re-cut a 60-minute confirmed dwell down to 12 minutes. Those
  // minutes are already represented; pushing the prior back produced a second
  // stop over the same window, a duplicate iv-gps-<start> id, and a
  // covered_min that can exceed the 1440 minutes a day actually holds.
  const clipped = interval("iv-clipped", 48, 12, "unresolved", "osm_overpass");
  const prior = interval("iv-clipped-prior", 0, 60, "Arenes de Lutece", "user_confirmed");

  const newIntervals = [clipped];
  preservePriorBeliefs(newIntervals, [prior]);

  assert.equal(newIntervals.length, 1);
  assert.ok(newIntervals[0].evidence_log.some(
    (e) => e.source === "user_confirmed_contained"));
});

test("preservePriorBeliefs never emits overlapping intervals or duplicate ids", () => {
  // Adversarial mix: contained, clipped, contending and genuinely orphaned
  // confirmations against one settled stop.
  const stop = interval("iv-host", 0, 600, "The airbnb", "user_confirmed");
  const priors = [
    interval("iv-a", 10, 20, "Corner Cafe", "user_confirmed"),
    interval("iv-b", 100, 45, "Bistro Example", "user_confirmed"),
    interval("iv-c", 580, 60, "Darna", "user_confirmed"),
    interval("iv-d", 900, 30, "Khaaw Hoom", "user_confirmed"),
  ];

  const newIntervals = [stop];
  preservePriorBeliefs(newIntervals, priors);

  const ids = newIntervals.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length, "no duplicate interval ids");

  const sorted = [...newIntervals].sort((a, b) => a.start_ts_ms - b.start_ts_ms);
  for (let i = 0; i < sorted.length - 1; i++) {
    assert.ok(sorted[i].end_ts_ms <= sorted[i + 1].start_ts_ms,
      `intervals ${sorted[i].id} and ${sorted[i + 1].id} overlap`);
  }
  // The one confirmation that shares no minutes with the stop is still kept.
  assert.ok(newIntervals.some((i) => i.place.name === "Khaaw Hoom"));
});

test("re-running a refresh does not accumulate duplicate carry lines", () => {
  const first = interval("iv-repeat", 0, 35, "unresolved", "osm_overpass");
  const prior = interval("iv-repeat-prior", 0, 30, "Caractere", "user_confirmed");

  preservePriorBeliefs([first], [prior]);
  assert.equal(carryLines(first).length, 1);

  // Next 10-minute tick: today's belief becomes the prior, GPS rebuilds the
  // interval fresh. The carry line must not be appended a second time.
  const rebuilt = interval("iv-repeat", 0, 35, "unresolved", "osm_overpass");
  rebuilt.evidence_log = [...first.evidence_log];
  preservePriorBeliefs([rebuilt], [first]);
  assert.equal(carryLines(rebuilt).length, 1, "carry line deduped across refreshes");
});

// ---------------------------------------------------------------------------
// A day we failed to resolve must never overwrite a day we had already resolved.
//
// Regression source: data/live-day-archive/2026-08-07.json — 776 bytes,
// "intervals": [], "interval_count": 0, against 19-26KB either side. The raw
// data was never missing: location_history holds 178 rows and 30 visits for
// 2026-08-07. resolve-day produced no stops on one tick, live-day.json was
// overwritten with nothing, and the midnight rollover filed that as the
// permanent record of his day. Nothing ever goes back for a day.
// ---------------------------------------------------------------------------

const day = (date, n) => ({
  date,
  intervals: Array.from({ length: n }, (_, i) => ({ id: `iv-${i}` })),
});

test("a day with no intervals is recognised as a failure, not a quiet day", () => {
  assert.equal(isDegenerate(day("2026-08-07", 0)), true);
  assert.equal(isDegenerate(day("2026-08-07", 3)), false);
  assert.equal(isDegenerate(null), true);
  assert.equal(isDegenerate({ date: "2026-08-07" }), true, "missing intervals array");
});

test("an empty rebuild does not replace an archive that already had intervals", () => {
  // The exact 2026-08-07 shape: 30 visits believed, then a tick that resolved 0.
  assert.equal(shouldReplaceDay(day("2026-08-07", 0), day("2026-08-07", 30)), false);
});

test("a day of nothing but calendar seeds has observed nothing worth keeping", () => {
  // Seeds are re-derived from Google every tick, so freezing the file to
  // protect them would stall the day for no gain.
  const seeded = { date: "2026-08-07", intervals: [{ place: { source: "calendar_seed" } }] };
  const observed = { date: "2026-08-07", intervals: [{ place: { source: "osm_overpass" } }] };
  assert.equal(hasObservedIntervals(seeded), false);
  assert.equal(hasObservedIntervals(observed), true);
  assert.equal(hasObservedIntervals({ date: "x", intervals: [] }), false);
  assert.equal(hasObservedIntervals(null), false);
});

test("a real rebuild always replaces, including a smaller-but-nonempty one", () => {
  assert.equal(shouldReplaceDay(day("2026-08-07", 9), day("2026-08-07", 30)), true);
  assert.equal(shouldReplaceDay(day("2026-08-07", 30), day("2026-08-07", 1)), true);
});

test("the guard only applies within one date", () => {
  // Rollover: yesterday's rich file must not block today's fresh empty start.
  assert.equal(shouldReplaceDay(day("2026-08-08", 0), day("2026-08-07", 30)), true);
});

test("with nothing on disk, anything is written", () => {
  assert.equal(shouldReplaceDay(day("2026-08-07", 0), null), true);
  assert.equal(shouldReplaceDay(day("2026-08-07", 0), undefined), true);
});

test("two empties are harmless — the guard does not wedge the file", () => {
  assert.equal(shouldReplaceDay(day("2026-08-07", 0), day("2026-08-07", 0)), true);
});
