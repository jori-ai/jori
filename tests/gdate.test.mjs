import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
process.env.JORI_TZ = "America/Chicago"; // the zone comes from instance().tz; pin it
const g = require("../lib/gdate.js");

// Anchor facts: 2026-06-27 is a Saturday (the "Day of Saturday, June 27, 2026"
// daily summary), so 2026-06-28 is a Sunday.
test("weekday of a known date is correct and TZ-independent", () => {
  assert.equal(g.dow("2026-06-27"), "Saturday");
  assert.equal(g.dow("2026-06-28"), "Sunday");
  assert.equal(g.dowNum("2026-06-28"), 0);
  assert.equal(g.dow("2026-01-01"), "Thursday"); // Jan 1 2026 = Thu
});

test("addDays handles month/year rollover", () => {
  assert.equal(g.addDays("2026-06-28", 1), "2026-06-29");
  assert.equal(g.addDays("2026-06-30", 1), "2026-07-01");
  assert.equal(g.addDays("2026-01-01", -1), "2025-12-31");
  assert.equal(g.addDays("2024-02-28", 1), "2024-02-29"); // leap year
});

test("diffDays is signed and correct across a month boundary", () => {
  assert.equal(g.diffDays("2026-06-28", "2026-07-05"), 7);
  assert.equal(g.diffDays("2026-07-05", "2026-06-28"), -7);
  assert.equal(g.diffDays("2026-06-28", "2026-06-28"), 0);
});

test("resolve handles today/tomorrow/yesterday against an anchor", () => {
  assert.equal(g.resolve("today", "2026-06-28"), "2026-06-28");
  assert.equal(g.resolve("tomorrow", "2026-06-28"), "2026-06-29");
  assert.equal(g.resolve("yesterday", "2026-06-28"), "2026-06-27");
});

test("resolve handles +Nd / -Nd / +Nw", () => {
  assert.equal(g.resolve("+7d", "2026-06-28"), "2026-07-05");
  assert.equal(g.resolve("-3d", "2026-06-28"), "2026-06-25");
  assert.equal(g.resolve("+2w", "2026-06-28"), "2026-07-12");
});

test("resolve handles next/last/this weekday", () => {
  // 2026-06-28 is Sunday
  assert.equal(g.resolve("next monday", "2026-06-28"), "2026-06-29");
  assert.equal(g.resolve("next sunday", "2026-06-28"), "2026-07-05"); // strictly future
  assert.equal(g.resolve("last friday", "2026-06-28"), "2026-06-26");
  assert.equal(g.resolve("tuesday", "2026-06-28"), "2026-06-30"); // bare = next
  assert.equal(g.dow(g.resolve("this saturday", "2026-06-28")), "Saturday");
});

test("invalid dates throw, not silently coerce", () => {
  assert.throws(() => g.dow("2026-13-01"));
  assert.throws(() => g.dow("2026-02-30"));
  assert.throws(() => g.assertISO("06/28/2026"));
  assert.throws(() => g.resolve("someday"));
});

test("todayISO returns a valid home-zone ISO date", () => {
  const t = g.todayISO();
  assert.match(t, /^\d{4}-\d{2}-\d{2}$/);
  assert.doesNotThrow(() => g.assertISO(t));
});

test("describe returns the full structured shape", () => {
  const d = g.describe("2026-06-28", "2026-06-28");
  assert.equal(d.iso, "2026-06-28");
  assert.equal(d.weekday, "Sunday");
  assert.equal(d.is_today, true);
  assert.equal(d.days_from_today, 0);
  assert.equal(d.tz, "America/Chicago");
});
