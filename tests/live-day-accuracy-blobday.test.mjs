// live-day-accuracy-blobday.test.mjs — a day whose stops got collapsed into
// one interval must not report a coverage number that reads as success.
//
// `resolution_rate` is COVERAGE (did a confident-looking name get produced),
// never correctness. So the worst shape the belief structure can produce — one
// interval swallowing the whole day — scores a perfect 1.0, because its single
// blob does carry a confident name. nightly-review reads that number to decide
// whether location tracking is healthy.
//
// THE DISCRIMINATOR IS A DISAGREEMENT BETWEEN TWO STORES, NOT A DURATION, and
// the two real days below (their shape, at synthetic places:
// tests/fixtures/fake-geo.mjs) are why. Both are one interval named for the
// house; only one of them is a bug:
//
//   2026-08-23  530 min   2 visit rows, both at the house (0 m apart)
//               -> a genuine all-day-at-home Sunday. 1.0 was CORRECT.
//   2026-08-24  1332 min  12 visit rows spanning 717 m, incl. four addresses
//               -> an evening walk the archive collapsed. 1.0 was a lie.
//
// Duration cannot separate those at any threshold: someone who works long
// hours mostly from home has long single intervals at home on ordinary days.
// A 360-min bar flagged 8 of 116 archived days with only 08-24 corroborated.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pair } from "./fixtures/fake-geo.mjs";

const require = createRequire(import.meta.url);
const {
  applyBlobDayGuard,
  metersBetween,
  maxPairwiseMeters,
  BLOB_DAY_INTERVAL_COUNT,
  DISTINCT_PLACE_METERS,
} = require("../bin/live-day");

// The shape computeAccuracy() returns, in its real key order — the guard has to
// preserve that order, since the nightly playbook stores the object verbatim.
const acc = (over = {}) => ({
  date: "2026-08-24",
  schema_version: 2,
  interval_count: 1,
  covered_min: 1332,
  resolution_rate: 1,
  corroborated_min: 0,
  contradicted_min: 0,
  unexamined_min: 1332,
  name_accuracy: null,
  contradictions: [],
  calendar_supports: 0,
  calendar_missed: 0,
  calendar_unmatched_physical: 0,
  calendar_total_physical: 0,
  calendar_accuracy: null,
  user_confirmed_share: 0,
  coverage_gaps: [],
  resolution_gaps: [],
  ...over,
});

const visit = (latitude, longitude, place_name = "(photo-inferred)") =>
  ({ latitude, longitude, place_name });

const VILLA = pair(0, 0); // the house

// 2026-08-23's actual rows: two photo-synthesized visits at the identical
// coordinate. This is the regression that matters most — it must stay clean.
const AUG23_VISITS = [visit(...VILLA), visit(...VILLA)];

// 2026-08-24's actual rows, as read from location_history: the house cluster
// (within ~5 m) plus the evening walk's four real stops.
const AUG24_VISITS = [
  visit(...pair(0.83, 1.3)),
  visit(...pair(3.83, 2.89)),
  visit(...pair(0, 0)),
  visit(...pair(320.67, -528.84), "101 Main St"),
  visit(...pair(164.95, -695.5), "202 Oak Ct"),
  visit(...pair(112.33, -152.8), "303 Oak Ct"),
  visit(...pair(112.33, -152.8), "303 Oak Ct"),
  visit(...pair(112.33, -152.8), "303 Oak Ct"),
  visit(...pair(87.87, -83.4)),
  visit(...pair(-0.27, -0.15), "Home Example"),
  visit(...pair(-0.27, -0.15), "Home Example"),
  visit(...pair(-0.27, -0.15), "Home Example"),
];

// 600 m due south of the house — the "clearly a different place" case.
const SIX_HUNDRED_M = [VILLA[0] - 600 / 111320, VILLA[1]];

test("the constants are the documented ones", () => {
  assert.equal(BLOB_DAY_INTERVAL_COUNT, 1);
  assert.equal(DISTINCT_PLACE_METERS, 150); // above ~5 m jitter, below the 190 m nearest real stop
});

test("metersBetween is a real haversine", () => {
  assert.equal(Math.round(metersBetween({ lat: 0, lon: 0 }, { lat: 0, lon: 0 })), 0);
  // 0.01 deg of latitude is ~1111 m anywhere on the globe.
  assert.ok(Math.abs(metersBetween({ lat: 12.34, lon: -65.43 }, { lat: 12.35, lon: -65.43 }) - 1111) < 5);
});

test("maxPairwiseMeters finds the widest gap, not the last one", () => {
  const span = maxPairwiseMeters([
    { lat: VILLA[0], lon: VILLA[1] },
    { lat: SIX_HUNDRED_M[0], lon: SIX_HUNDRED_M[1] },
    { lat: VILLA[0], lon: VILLA[1] },
  ]);
  assert.ok(Math.abs(span - 600) < 5, `span ${span}`);
});

// --- the two real days ------------------------------------------------------

test("2026-08-24 is flagged — 12 visits, four addresses, one interval", () => {
  const out = applyBlobDayGuard(acc(), AUG24_VISITS);
  assert.equal(out.resolution_rate, null);
  assert.equal(out.blob_day, true);
  assert.match(out.blob_day_reason, /1 interval archived/);
  assert.match(out.blob_day_reason, /12 visits spanning 71\d m/);
  assert.match(out.blob_day_reason, /stops were collapsed/);
});

test("2026-08-23 is NOT flagged — both visits sit at the same coordinate", () => {
  // The regression that matters most. It was a genuine all-day-at-home Sunday;
  // interval_count 1 and resolution_rate 1.0 were both correct, and an earlier
  // duration-based guard wrongly blanked it.
  const input = acc({ date: "2026-08-23", covered_min: 530, unexamined_min: 530 });
  const out = applyBlobDayGuard(input, AUG23_VISITS);
  assert.equal(out, input, "a real day must pass through untouched, by identity");
  assert.equal(out.resolution_rate, 1);
  assert.ok(!("blob_day" in out));
});

// --- the rule ---------------------------------------------------------------

test("a 1-interval day with co-located visits is not flagged", () => {
  // Ten photo-inferred rows re-derived at one address, plus GPS jitter.
  const jittery = Array.from({ length: 10 }, (_, i) =>
    visit(VILLA[0] + i * 0.00001, VILLA[1] - i * 0.00001));
  const out = applyBlobDayGuard(acc(), jittery);
  assert.equal(out.resolution_rate, 1);
  assert.ok(!("blob_day" in out));
});

test("a 1-interval day with visits 600 m apart is flagged", () => {
  const out = applyBlobDayGuard(acc(), [visit(...VILLA), visit(...SIX_HUNDRED_M)]);
  assert.equal(out.resolution_rate, null);
  assert.equal(out.blob_day, true);
  assert.match(out.blob_day_reason, /2 visits spanning 599 m/); // haversine, vs the flat 600 m construction
});

test("a multi-interval day is never flagged, however far apart its visits are", () => {
  // The archive enumerated the day; there is no disagreement to report.
  for (const n of [2, 5, 8]) {
    const input = acc({ interval_count: n });
    const out = applyBlobDayGuard(input, AUG24_VISITS);
    assert.equal(out, input, `interval_count ${n} must pass through`);
    assert.ok(!("blob_day" in out));
  }
});

test("the threshold is exclusive at exactly 150 m", () => {
  const at = (m) => [visit(...VILLA), visit(VILLA[0] - m / 111320, VILLA[1])];
  assert.ok(!("blob_day" in applyBlobDayGuard(acc(), at(149))));
  assert.ok(!("blob_day" in applyBlobDayGuard(acc(), at(150))));
  assert.equal(applyBlobDayGuard(acc(), at(160)).blob_day, true);
});

test("fewer than two usable visit rows cannot show a disagreement", () => {
  assert.ok(!("blob_day" in applyBlobDayGuard(acc(), [])));
  assert.ok(!("blob_day" in applyBlobDayGuard(acc(), [visit(...VILLA)])));
});

test("rows without usable coordinates are dropped, not counted as a place", () => {
  // Number(null) is 0, so a null coordinate that survived the filter would read
  // as null island and put a ~9,000 km span on the day. Caught by this test
  // during development, and it is the whole reason the guard coerces by hand.
  const junk = [
    visit(...VILLA),
    { latitude: null, longitude: null },
    { latitude: undefined, longitude: VILLA[1] },
    { latitude: "", longitude: "" },
    { latitude: 0, longitude: 0 },
    {},
  ];
  const out = applyBlobDayGuard(acc(), junk);
  assert.ok(!("blob_day" in out), `null coords must not manufacture a span: ${out.blob_day_reason}`);
  assert.equal(out.resolution_rate, 1);
});

test("an out-of-range coordinate is dropped too", () => {
  const bad = [visit(...VILLA), { latitude: 999, longitude: VILLA[1] }];
  assert.ok(!("blob_day" in applyBlobDayGuard(acc(), bad)));
});

// --- fail open --------------------------------------------------------------

test("a failed location_history read fails OPEN — the metric is not blanked", () => {
  // null means "could not look". Blanking resolution_rate on a network blip
  // would be a worse bug than the one this guard fixes.
  for (const failure of [null, undefined, "error", { error: "boom" }, 0]) {
    const input = acc();
    const out = applyBlobDayGuard(input, failure);
    assert.equal(out, input, `visits=${JSON.stringify(failure)} must pass through`);
    assert.equal(out.resolution_rate, 1);
    assert.ok(!("blob_day" in out));
  }
});

test("an empty read is not a failed read — [] means the store holds nothing", () => {
  // Distinct from null: no rows means no disagreement, which is also no flag,
  // but it must not be reached by the fail-open path.
  const out = applyBlobDayGuard(acc(), []);
  assert.ok(!("blob_day" in out));
});

test("the guard tolerates a malformed accuracy object", () => {
  assert.equal(applyBlobDayGuard(null, AUG24_VISITS), null);
  assert.equal(applyBlobDayGuard(undefined, AUG24_VISITS), undefined);
  assert.equal(applyBlobDayGuard("nope", AUG24_VISITS), "nope");
});

// --- output shape -----------------------------------------------------------

test("the flag sits immediately beside the number it invalidates", () => {
  const keys = Object.keys(applyBlobDayGuard(acc(), AUG24_VISITS));
  const i = keys.indexOf("resolution_rate");
  assert.deepEqual(keys.slice(i, i + 3), ["resolution_rate", "blob_day", "blob_day_reason"]);
  // Nothing else moved: same keys, same order, plus the two new ones.
  assert.deepEqual(
    keys.filter(k => k !== "blob_day" && k !== "blob_day_reason"),
    Object.keys(acc()),
  );
});

test("a flagged day keeps every other field untouched", () => {
  const out = applyBlobDayGuard(acc(), AUG24_VISITS);
  assert.equal(out.date, "2026-08-24");
  assert.equal(out.interval_count, 1);
  assert.equal(out.covered_min, 1332);
  assert.equal(out.unexamined_min, 1332);
  assert.equal(out.name_accuracy, null);
  assert.equal(out.schema_version, 2);
});

test("a flagged day missing resolution_rate is still flagged", () => {
  const out = applyBlobDayGuard({ date: "x", interval_count: 1 }, AUG24_VISITS);
  assert.equal(out.blob_day, true);
  assert.match(out.blob_day_reason, /12 visits/);
});
