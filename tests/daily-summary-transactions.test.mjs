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
