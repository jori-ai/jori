// owner-stays.test.mjs — the nights the user spent at a property they also
// let out, and the books with those nights taken out.
//
// The case that prompted it: a rental the family lived in read "$0 in, $2,813
// out, negative" for a month the family lived there for 29 of 30 nights.
// Fixtures are synthetic (fake coordinates, a synthetic home zone).
//
// Run: node --test tests/owner-stays.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
process.env.JORI_TZ = "America/Chicago"; // a synthetic home zone, before the lib loads
const o = require("../lib/owner-stays.js");

const HOME_A = { propertyId: "home-a", lat: 12.3456, lon: -65.4321, radiusM: 250 };
const HOME_B = { propertyId: "home-b", lat: 23.4567, lon: -54.3210, radiusM: 250 };
const homes = [HOME_A, HOME_B];

// A raw location_history row, `hoursAfter` hours after 03:00 home time on the
// night after `ds` (negative = before).
const row = (ds, hoursAfter, at) => ({
  arrived_at: new Date(o.etInstant(o.addDays(ds, 1), 3) + hoursAfter * 3600e3).toISOString(),
  latitude: at.lat, longitude: at.lon, accuracy_m: 20,
});
const ACROSS_TOWN = { lat: 12.3756, lon: -65.4521 }; // ~4 km from HOME_A
const ABROAD = { lat: 34.5678, lon: 10.1234 };

test("nightInstant is 03:00 home time on both sides of the DST change", () => {
  assert.equal(new Date(o.nightInstant("2026-09-15", 3)).toISOString(), "2026-09-15T08:00:00.000Z"); // CDT
  assert.equal(new Date(o.nightInstant("2026-12-15", 3)).toISOString(), "2026-12-15T09:00:00.000Z"); // CST
  assert.equal(o.etInstant, o.nightInstant, "the historical name is the same function");
  assert.equal(new Date(o.nightInstant("2026-09-15", 3, "Asia/Kolkata")).toISOString(), "2026-09-14T21:30:00.000Z");
});

test("a phone asleep at home all night is bridged by the fixes either side", () => {
  const s = o.toSamples([row("2026-09-10", -9, HOME_A), row("2026-09-10", 7, HOME_A)]);
  assert.deepEqual(o.nightAt("2026-09-10", s, homes), { at: "home-a", basis: "bridged" });
});

test("a night is not the home's when the nearest fix is elsewhere", () => {
  const s = o.toSamples([row("2026-09-15", -5.6, ACROSS_TOWN)]);
  assert.equal(o.nightAt("2026-09-15", s, homes).at, null);
});

test("a night with no fix within six hours is unknown, and counts as rentable", () => {
  const s = o.toSamples([row("2026-09-30", -8, HOME_A)]);
  assert.deepEqual(o.nightAt("2026-09-30", s, homes), { at: null, basis: "unknown" });
});

test("a long departed_at on a visit row does not claim a night", () => {
  // Real row shape: a visit stamped as leaving 59 h after it began.
  const NEARBY = { lat: 12.3566, lon: -65.4321 }; // ~1.2 km from HOME_A
  const rows = [{ ...row("2026-09-24", -6.4, NEARBY), departed_at: "2026-09-26T14:00:00+00:00" },
    row("2026-09-24", 4, NEARBY)];
  assert.equal(o.nightAt("2026-09-24", o.toSamples(rows), homes).at, null);
});

test("a fix with poor accuracy is ignored", () => {
  const bad = { ...row("2026-09-10", 0, HOME_A), accuracy_m: 900 };
  assert.equal(o.toSamples([bad]).length, 0);
});

test("a city abroad is neither home", () => {
  const s = o.toSamples([row("2026-07-30", 0, ABROAD)]);
  assert.equal(o.nightAt("2026-07-30", s, homes).at, null);
});

test("monthNights counts owner nights for one property only", () => {
  const rows = [];
  for (let d = 1; d <= 30; d++) {
    const ds = `2026-09-${String(d).padStart(2, "0")}`;
    rows.push(row(ds, -1, d <= 29 ? HOME_A : ABROAD), row(ds, 1, d <= 29 ? HOME_A : ABROAD));
  }
  const nights = o.classifyNights("2026-09-01", "2026-09-30", rows, homes);
  assert.deepEqual(o.monthNights("2026-09", nights, "home-a"), { days: 30, owner: 29, rentable: 1, unknown: 0 });
  assert.deepEqual(o.monthNights("2026-09", nights, "home-b"), { days: 30, owner: 0, rentable: 30, unknown: 0 });
});

const stmt = (lines) => {
  const income = lines.filter((l) => l.kind === "income").reduce((a, l) => a + l.amount, 0);
  const expenses = lines.filter((l) => l.kind === "expense").reduce((a, l) => a + l.amount, 0);
  return { lines, income, expenses, noi: income - expenses };
};
const L = (categoryId, kind, amount) => ({ categoryId, name: categoryId, kind, amount, count: 1 });
const guest = new Set(["platform-service-fee", "janitorial-turnover", "laundry-cleaning"]);

test("adjustStatement: income as booked, guest costs whole, every other expense scaled", () => {
  const s = stmt([L("income", "income", 1000), L("janitorial-turnover", "expense", 400), L("hoa", "expense", 900), L("utilities", "expense", 300)]);
  const a = o.adjustStatement(s, 0.5, guest);
  assert.equal(a.income, 1000);
  assert.equal(a.expenses, 400 + 450 + 150);
  assert.equal(a.noi, 1000 - 1000);
  assert.deepEqual(a.asBooked, { income: 1000, expenses: 1600, noi: -600 });
  assert.equal(a.lines.find((l) => l.categoryId === "hoa").asBooked, 900);
});

test("adjustStatement: a month with 29 of 30 nights owner", () => {
  // As booked: $2,813.15 of expenses, $400 of it turnover cleaning.
  const s = stmt([L("janitorial-turnover", "expense", 400), L("hoa", "expense", 924.12), L("rest", "expense", 1489.03)]);
  const a = o.adjustStatement(s, 29 / 30, guest);
  // Each scaled line rounds to the cent on its own: 924.12/30 = 30.80, 1489.03/30 = 49.63.
  assert.equal(Math.round(a.expenses * 100), 40000 + 3080 + 4963);
  assert.equal(Math.round(a.asBooked.expenses * 100), 281315);
});

test("adjustStatement: zero owner share changes nothing; capital lines are not scaled", () => {
  const s = stmt([L("income", "income", 500), L("hoa", "expense", 100)]);
  s.lines.push({ categoryId: "reno", name: "reno", kind: "capital", amount: 50, count: 1 });
  const a = o.adjustStatement(s, 0, guest);
  assert.equal(a.expenses, 100);
  assert.equal(a.lines.find((l) => l.kind === "capital").amount, 50);
});

test("monthNights: a full-months-only property has no partly rentable month", () => {
  const rows = [];
  for (let d = 1; d <= 30; d++) {
    const ds = `2026-09-${String(d).padStart(2, "0")}`;
    rows.push(row(ds, -1, d <= 29 ? HOME_A : ABROAD), row(ds, 1, d <= 29 ? HOME_A : ABROAD));
  }
  const nights = o.classifyNights("2026-09-01", "2026-09-30", rows, homes);
  // 29 of 30 nights the family's: the one leftover night does not count as available.
  const nm = o.monthNights("2026-09", nights, "home-a", { fullMonthsOnly: true });
  assert.deepEqual(nm, { days: 30, owner: 29, rentable: 0, unknown: 0, ineligible: true });
  assert.equal(o.ownerShareOf(nm), 1);
  // Without the flag the same month still scales by nights.
  assert.equal(o.ownerShareOf(o.monthNights("2026-09", nights, "home-a")), 29 / 30);
});

test("monthNights: a full-months-only property with no owner night is a whole rentable month", () => {
  const rows = [];
  for (let d = 1; d <= 31; d++) {
    const ds = `2026-07-${String(d).padStart(2, "0")}`;
    rows.push(row(ds, -1, ABROAD), row(ds, 1, ABROAD));
  }
  const nights = o.classifyNights("2026-07-01", "2026-07-31", rows, homes);
  const nm = o.monthNights("2026-07", nights, "home-a", { fullMonthsOnly: true });
  assert.deepEqual(nm, { days: 31, owner: 0, rentable: 31, unknown: 0 });
  assert.equal(o.ownerShareOf(nm), 0);
});

test("a single owner night makes a full-months-only month wholly the owner's; guest costs stay whole", () => {
  const rows = [row("2026-08-10", -1, HOME_A), row("2026-08-10", 1, HOME_A)];
  const nights = o.classifyNights("2026-08-01", "2026-08-31", rows, homes);
  const nm = o.monthNights("2026-08", nights, "home-a", { fullMonthsOnly: true });
  assert.equal(nm.owner, 1);
  assert.equal(nm.ineligible, true);
  const s = stmt([L("income", "income", 6000), L("janitorial-turnover", "expense", 250), L("hoa", "expense", 900)]);
  const a = o.adjustStatement(s, o.ownerShareOf(nm), guest);
  assert.equal(a.income, 6000);
  assert.equal(a.expenses, 250);
});

test("the config marks one property full-months-only and the other not", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owner-stays-"));
  const file = path.join(dir, "owner-use-properties.json");
  fs.writeFileSync(file, JSON.stringify({
    properties: { "home-a": { named_location: "Home A", full_months_only: true }, "home-b": { named_location: "Home B" } },
    radius_m: 250, night_hour_et: 4,
  }));
  const cfg = o.loadConfig(file);
  const named = [{ name: "Home A", lat: 12.3456, lon: -65.4321 }, { name: "Home B", lat: 23.4567, lon: -54.321 }];
  assert.equal(o.ownerUseFor("home-a", cfg, named).fullMonthsOnly, true);
  assert.equal(o.ownerUseFor("home-b", cfg, named).fullMonthsOnly, false);
  assert.equal(o.ownerUseFor("home-b", cfg, named).nightHour, 4, "the older night_hour_et key still reads");
  assert.equal(o.ownerUseFor("home-c", cfg, named), null);
  assert.equal(o.ownerUseFor("home-a", o.loadConfig(path.join(dir, "absent.json")), named), null, "no config: no owner-use property");
  fs.rmSync(dir, { recursive: true, force: true });
});
