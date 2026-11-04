// cruise-plan-windows.test.mjs — pins the "where are we when the plan is
// silent" rule.
//
// The written travel plan only reaches as far as the user has decided, so every
// sailing after it matched nothing and most of the corpus was unreachable.
// Requirement: where the plan does not say, assume one of the home cities, and
// show every announced sailing up to two years ahead.
//
// The load-bearing half is what does NOT get filled: a plan leg abroad makes a
// home-port departure that week one the user cannot take. Explicit windows
// must stay exclusive over their own dates.
//
// Synthetic home cities come from a fixture config (cruise-watch `home_cities`).
//
// Run: node --test tests/cruise-plan-windows.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withDefaultWindows, defaultCities } from "../lib/cruise/plan.mjs";

const HOME_A = "Home One, XA";
const HOME_B = "Home Two, XB";
const ABROAD = "Abroad City, XC";
const FIX = mkdtempSync(join(tmpdir(), "cruise-plan-"));
mkdirSync(join(FIX, "config"), { recursive: true });
writeFileSync(join(FIX, "config", "cruise-watch.json"), JSON.stringify({ home_cities: [HOME_B, HOME_A] }));
process.env.JORI_LOCAL_DIR = FIX;
const DEFAULT_CITIES = defaultCities();

const FROM = "2026-08-31";
const assumedOnly = (ws) => ws.filter((w) => w.assumed);
const coversOn = (ws, city, date) =>
  ws.some((w) => w.city === city && w.start <= date && date <= w.end);

test("dates past the end of the plan get both home cities", () => {
  const out = withDefaultWindows(
    [{ city: HOME_A, start: "2026-09-01", end: "2026-09-30" }],
    { from: FROM, horizonDays: 400 },
  );
  assert.ok(coversOn(out, HOME_B, "2027-06-15"));
  assert.ok(coversOn(out, HOME_A, "2027-06-15"));
});

test("an explicit elsewhere-window is NOT backfilled with home cities", () => {
  // The whole reason this fills gaps rather than blanketing the horizon.
  const out = withDefaultWindows(
    [{ city: ABROAD, start: "2026-10-01", end: "2026-10-28" }],
    { from: FROM, horizonDays: 400 },
  );
  for (const city of DEFAULT_CITIES) {
    assert.equal(coversOn(out, city, "2026-10-15"), false, `${city} leaked into the leg abroad`);
  }
  // ...and the day after it ends is open again.
  assert.ok(coversOn(out, HOME_A, "2026-10-29"));
});

test("a gap BETWEEN two explicit windows is filled", () => {
  const out = withDefaultWindows(
    [
      { city: ABROAD, start: "2026-09-05", end: "2026-09-10" },
      { city: ABROAD, start: "2026-09-20", end: "2026-09-25" },
    ],
    { from: FROM, horizonDays: 60 },
  );
  assert.ok(coversOn(out, HOME_A, "2026-09-15"), "the middle gap");
  assert.equal(coversOn(out, HOME_A, "2026-09-07"), false, "the first leg");
  assert.equal(coversOn(out, HOME_A, "2026-09-22"), false, "the second leg");
});

test("window ends are inclusive on both sides", () => {
  // findPlanWindow treats a window ending 10-28 as covering the 28th; if the
  // fill disagreed, single days would leak home cities at every boundary.
  const out = withDefaultWindows(
    [{ city: ABROAD, start: "2026-10-01", end: "2026-10-28" }],
    { from: FROM, horizonDays: 200 },
  );
  assert.equal(coversOn(out, HOME_A, "2026-10-01"), false, "first day of the leg");
  assert.equal(coversOn(out, HOME_A, "2026-10-28"), false, "last day of the leg");
  assert.ok(coversOn(out, HOME_A, "2026-09-30"), "day before");
  assert.ok(coversOn(out, HOME_A, "2026-10-29"), "day after");
});

test("nothing beyond the horizon is filled", () => {
  const out = withDefaultWindows([], { from: FROM, horizonDays: 730 });
  assert.ok(coversOn(out, HOME_A, "2028-08-30"), "inside the horizon");
  assert.equal(coversOn(out, HOME_A, "2028-09-05"), false, "past it");
});

test("gaps collapse into spans, not one window per day", () => {
  const out = assumedOnly(withDefaultWindows([], { from: FROM, horizonDays: 730 }));
  assert.equal(out.length, DEFAULT_CITIES.length, "one window per city, not 730");
});

test("explicit windows are preserved untouched and marked apart", () => {
  const explicit = [{ city: ABROAD, start: "2026-10-01", end: "2026-10-28" }];
  const out = withDefaultWindows(explicit, { from: FROM, horizonDays: 200 });
  const kept = out.find((w) => w.city === ABROAD);
  assert.deepEqual(kept, explicit[0]);
  assert.equal(kept.assumed, undefined, "an explicit window must not be flagged assumed");
  assert.ok(assumedOnly(out).every((w) => w.assumed === true));
});

test("an empty plan still yields a usable horizon rather than nothing", () => {
  const out = withDefaultWindows([], { from: FROM, horizonDays: 365 });
  assert.equal(out.length, DEFAULT_CITIES.length);
});

test("no home cities configured → no assumed windows (the watch is off)", () => {
  const out = withDefaultWindows([], { from: FROM, horizonDays: 365, cities: [] });
  assert.equal(out.length, 0);
});
