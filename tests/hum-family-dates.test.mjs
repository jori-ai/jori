import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { daysUntilNextOccurrence, birthdayWindowHits } = require("../lib/hum-family-dates.js");
const gdate = require("../lib/gdate.js");

test("daysUntilNextOccurrence finds this year's date when still upcoming", () => {
  assert.equal(daysUntilNextOccurrence("07-30", "2026-07-28"), 2);
});

test("daysUntilNextOccurrence is 0 on the exact day", () => {
  assert.equal(daysUntilNextOccurrence("07-28", "2026-07-28"), 0);
});

test("daysUntilNextOccurrence wraps to next year when the date already passed", () => {
  const anchor = "2026-07-28";
  const result = daysUntilNextOccurrence("06-15", anchor);
  const expected = gdate.diffDays(anchor, "2027-06-15");
  assert.equal(result, expected);
  assert.ok(result > 0);
});

test("Feb 29 birthday skips non-leap years instead of throwing or silently drifting", () => {
  // Anchored 2026-07-28: 2027 and 2029 aren't leap years, 2028 is.
  const anchor = "2026-07-28";
  const result = daysUntilNextOccurrence("02-29", anchor);
  const expected = gdate.diffDays(anchor, "2028-02-29");
  assert.equal(result, expected);
});

test("birthdayWindowHits filters to T-0/T-2/T-7 by default", () => {
  const anchor = "2026-07-28";
  const bdays = [
    { who: "A", mmdd: "07-28" }, // T-0
    { who: "B", mmdd: "07-30" }, // T-2
    { who: "C", mmdd: "08-04" }, // T-7
    { who: "D", mmdd: "08-01" }, // T-4, should not hit
  ];
  const hits = birthdayWindowHits(bdays, [0, 2, 7], anchor);
  assert.deepEqual(hits.map((h) => h.who).sort(), ["A", "B", "C"]);
  const a = hits.find((h) => h.who === "A");
  assert.equal(a.days, 0);
});

test("birthdayWindowHits returns empty when nothing is in-window", () => {
  const anchor = "2026-07-28";
  const bdays = [{ who: "A", mmdd: "01-01" }];
  assert.deepEqual(birthdayWindowHits(bdays, [0, 2, 7], anchor), []);
});

test("a four-person birthday list resolves without throwing on an arbitrary anchor", () => {
  const bdays = [
    { who: "Alex", mmdd: "06-15" },
    { who: "Sam", mmdd: "03-29" },
    { who: "Noa", mmdd: "03-16" },
    { who: "Eli", mmdd: "09-29" },
  ];
  assert.doesNotThrow(() => birthdayWindowHits(bdays, [0, 2, 7], "2026-07-28"));
});
