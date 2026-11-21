// daily-summary-transactions.test.mjs — unit tests for standout-purchase
// selection + stop matching that feeds the daily-summary spine.
// Run: node --test tests/daily-summary-transactions.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { selectStandouts, matchStop, categoryLabel, usd, money } = require(
  "../lib/daily-summary-transactions.js",
);

const stops = [
  { id: "s1", place: { name: "Semma" } },
  { id: "s2", place: { name: "Midwood" } }, // neighborhood, no merchant signal
  { id: "s3", place: { name: "AMC Lincoln Square 13" } },
];

// Plaid sign: amount > 0 is a spend (outflow).
const txn = (o) => ({
  transaction_id: o.id,
  amount: o.amount,
  merchant_name: o.merchant ?? null,
  name: o.name ?? null,
  category_primary: o.cat ?? null,
  payment_channel: o.channel ?? null,
  pending: !!o.pending,
});

test("matchStop links a merchant to a stop by shared significant token", () => {
  assert.equal(matchStop(txn({ merchant: "Semma" }), stops), "s1");
  assert.equal(matchStop(txn({ merchant: "AMC THEATRES LINCOLN SQ" }), stops), "s3");
});

test("matchStop returns null for neighborhood-only / unrelated merchants", () => {
  assert.equal(matchStop(txn({ merchant: "Amazon.com" }), stops), null);
  // "Midwood" is a stopword-free token but no merchant mentions it
  assert.equal(matchStop(txn({ merchant: "Joe Coffee" }), stops), null);
});

test("a large outflow is standout even without a stop match", () => {
  const { standouts } = selectStandouts(
    [txn({ id: "a", amount: 152, merchant: "Warby Parker", cat: "GENERAL_MERCHANDISE", channel: "online" })],
    stops,
  );
  assert.equal(standouts.length, 1);
  assert.equal(standouts[0].amount_usd === undefined, true); // raw object, formatting happens in render layer
  assert.equal(standouts[0].amount, 152);
  assert.equal(standouts[0].stop_id, null);
});

test("a $66 movie ticket (entertainment) is standout and lands on the cinema stop", () => {
  const { standouts, byStopId } = selectStandouts(
    [txn({ id: "amc", amount: 66, merchant: "AMC THEATRES", cat: "ENTERTAINMENT", channel: "in store" })],
    stops,
  );
  assert.equal(standouts.length, 1);
  assert.equal(standouts[0].stop_id, "s3"); // "amc" token matches "AMC Lincoln Square 13"
  assert.deepEqual(byStopId.s3.map((t) => t.transaction_id), ["amc"]);
});

test("a $40 dinner (experiential) is standout even below the $75 floor", () => {
  const { standouts } = selectStandouts(
    [txn({ id: "din", amount: 40, merchant: "Some Wine Bar", cat: "FOOD_AND_DRINK", channel: "in store" })],
    stops,
  );
  assert.equal(standouts.length, 1);
});

test("a small in-person purchase tied to a visited stop IS standout", () => {
  const { standouts, byStopId } = selectStandouts(
    [txn({ id: "b", amount: 32, merchant: "Semma", cat: "FOOD_AND_DRINK", channel: "in store" })],
    stops,
  );
  assert.equal(standouts.length, 1);
  assert.equal(standouts[0].stop_id, "s1");
  assert.deepEqual(byStopId.s1.map((t) => t.transaction_id), ["b"]);
});

test("a small purchase with NO stop match is NOT standout", () => {
  const { standouts } = selectStandouts(
    [txn({ id: "c", amount: 6.5, merchant: "Some Bodega", cat: "FOOD_AND_DRINK", channel: "in store" })],
    stops,
  );
  assert.equal(standouts.length, 0);
});

test("transfers, loan/card payments and autopay are filtered out", () => {
  const { standouts } = selectStandouts(
    [
      txn({ id: "d", amount: 2000, merchant: "Online Transfer", cat: "TRANSFER_OUT" }),
      txn({ id: "e", amount: 900, merchant: "LOAN PMT", cat: "LOAN_PAYMENTS" }),
      txn({ id: "f", amount: 500, name: "AUTOPAY PAYMENT THANK YOU" }),
    ],
    stops,
  );
  assert.equal(standouts.length, 0);
});

test("inflows (deposits) are not 'purchases'", () => {
  const { standouts } = selectStandouts(
    [txn({ id: "g", amount: -3000, merchant: "Payroll", cat: "INCOME" })],
    stops,
  );
  assert.equal(standouts.length, 0);
});

test("results are capped and sorted by amount desc", () => {
  const many = Array.from({ length: 10 }, (_, i) =>
    txn({ id: `m${i}`, amount: 100 + i, merchant: `Shop ${i}`, cat: "GENERAL_MERCHANDISE" }),
  );
  const { standouts } = selectStandouts(many, stops, { max: 3 });
  assert.equal(standouts.length, 3);
  assert.deepEqual(standouts.map((t) => t.amount), [109, 108, 107]);
});

test("thresholds are overridable via opts", () => {
  // $18 shopping, no stop match — below the $25 experiential floor by default.
  const t = [txn({ id: "h", amount: 18, merchant: "Some Gift Shop", cat: "GENERAL_MERCHANDISE", channel: "online" })];
  assert.equal(selectStandouts(t, stops).standouts.length, 0);
  assert.equal(selectStandouts(t, stops, { experientialMin: 10 }).standouts.length, 1);
});

test("a non-experiential mid charge below $75 is NOT standout (utilities)", () => {
  const t = [txn({ id: "u", amount: 60, merchant: "Con Edison", cat: "RENT_AND_UTILITIES" })];
  assert.equal(selectStandouts(t, stops).standouts.length, 0);
});

test("pending in-person charges are kept and flagged", () => {
  const { standouts } = selectStandouts(
    [txn({ id: "i", amount: 120, merchant: "Semma", cat: "FOOD_AND_DRINK", channel: "in store", pending: true })],
    stops,
  );
  assert.equal(standouts[0].pending, true);
});

test("categoryLabel + usd formatting", () => {
  assert.equal(categoryLabel("FOOD_AND_DRINK"), "dining");
  assert.equal(categoryLabel("GENERAL_MERCHANDISE"), "shopping");
  assert.equal(categoryLabel(null), "");
  assert.equal(usd(120), "$120.00");
  assert.equal(usd(66), "$66.00");
  // money = natural prose form: whole dollars drop cents, fractions keep them
  assert.equal(money(120), "$120");
  assert.equal(money(66), "$66");
  assert.equal(money(8.5), "$8.50");
  assert.equal(money(1200), "$1,200");
});

test("a food-delivery charge is not a ride (2026-09-08: Uber Eats listed as rideshare beside a real MTA tap)", () => {
  const { mobilityMode, selectMobility } = require("../lib/daily-summary-transactions.js");
  assert.equal(mobilityMode(txn({ id: "e", amount: 78.93, merchant: "Uber Eats", cat: "FOOD_AND_DRINK" })), null);
  assert.equal(mobilityMode(txn({ id: "d", amount: 31.2, name: "DOORDASH*SEMMA", cat: "FOOD_AND_DRINK" })), null);
  assert.equal(mobilityMode(txn({ id: "u", amount: 22, merchant: "Uber", cat: "TRANSPORTATION" })), "rideshare");
  assert.equal(mobilityMode(txn({ id: "m", amount: 3, name: "MOBILE PURCHASE 09/08 MTA*NYCT PAYGO", merchant: "MTA", cat: "TRANSPORTATION" })), "subway");
  const mob = selectMobility([
    txn({ id: "e", amount: 78.93, merchant: "Uber Eats", cat: "FOOD_AND_DRINK" }),
    txn({ id: "m", amount: 3, merchant: "MTA", cat: "TRANSPORTATION" }),
  ]);
  assert.deepEqual(mob.map(m => m.mode), ["subway"]);
});

// --- An in-person charge names a stop only where it actually happened -------
// 2026-11-18: two grocery charges in the same city bound to one stop because the
// geo path compared only the city string; the larger charge, a shop ~800 m up
// the same road, named a stop it was not at.

const T = require("../lib/daily-summary-transactions.js");

// A charge with a location, as Plaid carries it in raw.location.
const placed = (o) => ({
  ...txn({ id: o.id, amount: o.amount, merchant: o.merchant, cat: o.cat ?? "FOOD_AND_DRINK", channel: "in store", pending: o.pending }),
  date: o.date ?? "2026-03-10",
  authorized_date: o.authorized ?? o.date ?? "2026-03-10",
  raw: { location: o.loc ?? {} },
});

// A stop with a centroid and an address (resolve-day's shape).
const stopAt = (id, lat, lon, address, name = "unnamed") => ({
  id, lat, lon, pattern: "dwell", place: { name, address, source: "spine_dwell" },
});

// Positions are metres north/east of an abstract origin, so no real place is named.
const M_PER_DEG = 111320;
const pos = (northM, eastM) => ({ lat: northM / M_PER_DEG, lon: eastM / M_PER_DEG });
const nearShop = { ...pos(100, 100), city: "Springfield", address: "100 Main St" };
const farShop = { ...pos(1000, 100), city: "Springfield", address: "900 Main St" }; // 900 m north of it
const dwell = stopAt("s9", ...Object.values(pos(103, 102)), "100 Main Street, Springfield");

test("two same-city grocery charges: only the one at the stop names it", () => {
  const far = placed({ id: "far", amount: 235.89, merchant: "Far Grocer", loc: farShop });
  const near = placed({ id: "near", amount: 20.94, merchant: "Near Grocer", loc: nearShop });
  // the bigger, farther charge sorts first, as the fetch orders by amount desc
  const m = T.matchTransactions([far, near], [dwell]);
  assert.deepEqual((m.byStopId.s9 || []).map((c) => c.merchant), ["Near Grocer"]);
});

test("a charge whose pin is far from every stop names none, even in the same city", () => {
  const far = placed({ id: "far", amount: 50, merchant: "Far Grocer", loc: farShop });
  assert.equal(T._internal.inPersonStopMatch(far, [dwell]), null);
});

test("a charge near a stop names it", () => {
  const near = placed({ id: "near", amount: 20, merchant: "Near Grocer", loc: nearShop });
  assert.equal(T._internal.inPersonStopMatch(near, [dwell]), "s9");
});

test("the nearest of several stops wins, not the first in the list", () => {
  const other = stopAt("s1", ...Object.values(pos(150, 105)), "100 Main Street, Springfield"); // ~50 m off
  const mine = stopAt("s2", ...Object.values(pos(104, 101)), "100 Main Street, Springfield"); // ~4 m off
  const near = placed({ id: "near", amount: 20, merchant: "Near Grocer", loc: nearShop });
  assert.equal(T._internal.inPersonStopMatch(near, [other, mine]), "s2");
});

test("without coordinates, the street and number must agree (long and short spellings alike)", () => {
  const sameStreet = placed({ id: "a", amount: 30, merchant: "Near Grocer", loc: { city: "Springfield", address: "500 Elm Ave" } });
  const elsewhere = placed({ id: "b", amount: 30, merchant: "Far Grocer", loc: { city: "Springfield", address: "700 Elm Ave" } });
  const noCoords = { id: "s5", pattern: "dwell", place: { name: "unnamed", address: "500 Elm Avenue, Springfield" } };
  assert.equal(T._internal.inPersonStopMatch(sameStreet, [noCoords]), "s5");
  assert.equal(T._internal.inPersonStopMatch(elsewhere, [noCoords]), null);
});

test("a charge with only a city names a stop only when exactly one stop is in that city", () => {
  const cityOnly = placed({ id: "c", amount: 30, merchant: "Some Grocer", loc: { city: "Springfield" } });
  const a = { id: "sa", pattern: "dwell", place: { name: "x", address: "1 A St, Springfield" } };
  const b = { id: "sb", pattern: "dwell", place: { name: "y", address: "2 B St, Springfield" } };
  const away = { id: "sc", pattern: "dwell", place: { name: "z", address: "3 C St, Shelbyville" } };
  assert.equal(T._internal.inPersonStopMatch(cityOnly, [a, away]), "sa");
  assert.equal(T._internal.inPersonStopMatch(cityOnly, [a, b, away]), null);
});

test("a charge with coordinates but stops without any falls back to the street", () => {
  const near = placed({ id: "near", amount: 20, merchant: "Near Grocer", loc: nearShop });
  const noCoords = { id: "s7", pattern: "dwell", place: { name: "u", address: "100 Main Street, Springfield" } };
  assert.equal(T._internal.inPersonStopMatch(near, [noCoords]), "s7");
});

test("browse clusters never take a charge's name", () => {
  const near = placed({ id: "near", amount: 20, merchant: "Near Grocer", loc: nearShop });
  assert.equal(T._internal.inPersonStopMatch(near, [{ ...dwell, pattern: "browse" }]), null);
});

test("chargeDay and chargesOfDay: a purchase belongs to the day it was authorized", () => {
  const D = "2026-03-10";
  const boughtYesterdayPostedToday = placed({ id: "y", amount: 90, merchant: "Early", date: D, authorized: "2026-03-09" });
  const boughtTodayPostedTomorrow = placed({ id: "t", amount: 40, merchant: "Today", date: "2026-03-11", authorized: D });
  const noAuthDate = { ...placed({ id: "n", amount: 12, merchant: "NoAuth", date: D }), authorized_date: null };
  const pending = placed({ id: "p", amount: 8, merchant: "Pending", date: D, authorized: D, pending: true });
  assert.equal(T.chargeDay(boughtYesterdayPostedToday), "2026-03-09");
  assert.equal(T.chargeDay(noAuthDate), D);
  const kept = T.chargesOfDay([boughtYesterdayPostedToday, boughtTodayPostedTomorrow, noAuthDate, pending], D);
  assert.deepEqual(kept.map((t) => t.transaction_id), ["t", "n", "p"]);
  assert.deepEqual(T.chargesOfDay([boughtYesterdayPostedToday]), [boughtYesterdayPostedToday], "no date given: nothing dropped");
});

test("a purchase made the day before no longer prints as a standout of this day", () => {
  const D = "2026-03-10";
  const early = placed({ id: "y", amount: 235.89, merchant: "Early Grocer", date: D, authorized: "2026-03-09", loc: farShop });
  const today = placed({ id: "t", amount: 40, merchant: "Today Grocer", date: D, authorized: D, loc: nearShop });
  const { standouts } = T.selectStandouts(T.chargesOfDay([early, today], D), [dwell]);
  assert.deepEqual(standouts.map((s) => s.merchant), ["Today Grocer"]);
});
