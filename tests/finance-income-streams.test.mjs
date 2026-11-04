// finance-income-streams.test.mjs — a repeating inflow is an "income stream"
// only when it is regular (Self Improvement Review 2026-10-06, item 15).
//
// The case that failed: a household member's card autopay — scattered amounts
// on scattered dates — became a "$1,516 monthly deposit, usually by the 8th" and was paged
// as 15 days late, with month "2026-08" on an October alert.
//
// Run: node --test tests/finance-income-streams.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { inferIncomeStreams, regularity } = require("../lib/finance-income-streams.js");
const { incomeStatus } = require("../lib/finance-expected.js");
const { classify } = require("../lib/finance-classify.js");

const accounts = [
  { account_id: "chk", type: "depository", name: "Primary Checking" },
  { account_id: "biz", type: "depository", name: "Business Checking" },
  { account_id: "card", type: "credit", name: "CREDIT CARD" },
];
let n = 0;
const t = (account_id, amount, date, extra = {}) => ({
  transaction_id: `t${++n}`, account_id, amount, date, pending: false,
  name: extra.name || "X", merchant_name: extra.merchant || null,
  category_primary: extra.pri || null, category_detailed: extra.det || null,
});

// Irregular card autopay, three ways it reached the old inference.
const AUTOPAY_DATES = ["2026-05-08", "2026-05-26", "2026-07-06", "2026-08-02", "2026-09-06"]; // gaps 18/41/27/35 — median ~31
const AUTOPAY_AMTS = [842.1, 2300.55, 1516.0, 1104.37, 1980.0];
const autopayOnCard = AUTOPAY_DATES.map((d, i) => t("card", -AUTOPAY_AMTS[i], d, { name: "AUTOMATIC PAYMENT - THANK", pri: "LOAN_PAYMENTS", det: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" }));
// The checking side: DEBITS (positive) that Plaid labelled TRANSFER_IN.
const autopayDebitsLabelledIn = AUTOPAY_DATES.map((d, i) => t("chk", AUTOPAY_AMTS[i], d, { name: "BANK CREDIT CRD AUTOPAY", pri: "TRANSFER_IN" }));
// Worst case: genuine credits on a cash account, but irregular in date and amount.
const irregularCredits = AUTOPAY_DATES.map((d, i) => t("chk", -AUTOPAY_AMTS[i], d, { name: "BANK CREDIT CRD AUTOPAY", pri: "TRANSFER_IN" }));

// A real monthly business credit: ~$10,000 on the 1st-3rd, six months.
const business = [
  ["2026-04-01", 10000], ["2026-05-01", 10000], ["2026-06-02", 10500],
  ["2026-07-01", 10000], ["2026-08-03", 9600], ["2026-09-01", 10000],
].map(([d, a]) => t("biz", -a, d, { name: "ACME LLC DES:ACH PMT", pri: "INCOME", det: "INCOME_CONTRACTOR" }));

test("card autopay credits on the card are never income", () => {
  assert.deepEqual(inferIncomeStreams(autopayOnCard, accounts).streams, []);
});

test("debits are never income, whatever category Plaid gives them", () => {
  assert.deepEqual(inferIncomeStreams(autopayDebitsLabelledIn, accounts).streams, []);
});

test("irregular credits on a cash account infer nothing — cadence and amount must both hold", () => {
  const { streams, rejected } = inferIncomeStreams(irregularCredits, accounts);
  assert.deepEqual(streams, []);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0].reason.includes("vary"), rejected[0].reason);
});

test("the whole replay together still infers nothing from the autopay", () => {
  const all = [...autopayOnCard, ...autopayDebitsLabelledIn, ...irregularCredits];
  assert.deepEqual(inferIncomeStreams(all, accounts).streams, []);
});

test("a regular monthly business credit stream is still inferred", () => {
  const { streams } = inferIncomeStreams([...business, ...autopayOnCard, ...irregularCredits], accounts);
  assert.equal(streams.length, 1);
  const s = streams[0];
  assert.equal(s.account_id, "biz");
  assert.equal(s.cadence, "monthly");
  assert.equal(s.amount, 10000);
  assert.equal(s.typical_day, 1);
  assert.equal(s.last_date, "2026-09-01");
  assert.equal(s.count, 6);
});

test("two occurrences are not a stream; three regular ones are", () => {
  assert.equal(regularity([{ date: "2026-08-01", amount: 500 }, { date: "2026-09-01", amount: 500 }]).ok, false);
  assert.equal(regularity([{ date: "2026-07-01", amount: 500 }, { date: "2026-08-01", amount: 500 }, { date: "2026-09-01", amount: 500 }]).ok, true);
});

test("a consistent cadence with wildly varying amounts is not a stream", () => {
  const r = regularity([
    { date: "2026-06-01", amount: 400 }, { date: "2026-07-01", amount: 2000 },
    { date: "2026-08-01", amount: 900 }, { date: "2026-09-01", amount: 1500 },
  ]);
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes("amounts"), r.reason);
});

test("a late alert names the window actually missed, never the last month seen", () => {
  const exp = [{ id: "s", account_id: "biz", payer_contains: "acme", amount: 10000, due_day: 8, grace_days: 3, active_from: "2026-01-01" }];
  const none = classify([], accounts, { expectedIncome: exp });
  // 15 days past an October 8 due date: the cycle is October's, so the
  // harvester's dedup key (keyed on cycle_due) carries 2026-10.
  const r = incomeStatus(exp, [], none, "2026-10-23")[0];
  assert.equal(r.status, "late");
  assert.equal(r.cycle_due, "2026-10-08");
  // More than a week before this month's due date, the window being judged is
  // LAST month's real due date — a calendar month, not "minus 30 days".
  const eom = [{ ...exp[0], due_day: 31 }];
  assert.equal(incomeStatus(eom, [], none, "2026-03-05")[0].cycle_due, "2026-02-28");
  assert.equal(incomeStatus([{ ...exp[0], due_day: 20 }], [], none, "2026-01-02")[0].cycle_due, "2025-12-20");
});
