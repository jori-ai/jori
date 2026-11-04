// finance-classify.test.mjs — what a transaction IS, what income is expected
// and what payment is due: the money model's rules, each reduced to the smallest input that once produced a false
// statement in a weekly finance review:
//   * credit-card payment credits reported as "income 15 / 53 days late";
//   * a $20,000 transfer between two of the user's own accounts counted as
//     money in AND money out;
//   * a $306,495 wire folded into spending and runway;
//   * a predicted manual payment announced as a confirmed autopay.
//
// Synthetic accounts and payers only.
// Run: node --test tests/finance-classify.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { classify } = require("../lib/finance-classify.js");
const { incomeStatus, scheduledDue, nextDueDate } = require("../lib/finance-expected.js");

const accounts = [
  { account_id: "chk", type: "depository", name: "Everyday Checking", balance_current: 2543, balance_available: 2543 },
  { account_id: "sav", type: "depository", name: "Savings", balance_current: 24825 },
  { account_id: "biz", type: "depository", name: "Business Checking" },
  { account_id: "dep", type: "depository", name: "Security Deposits" },
  { account_id: "cardA", type: "credit", name: "Card A", balance_current: 876 },
  { account_id: "cardB", type: "credit", name: "CREDIT CARD", balance_current: 7997 },
];
const t = (id, account_id, amount, date, extra = {}) => ({ transaction_id: id, account_id, amount, date, name: extra.name || id, merchant_name: null, category_primary: extra.pri || null, category_detailed: extra.det || null });

test("a card payment credit is never income, paired or not", () => {
  const posted = [
    t("pay-out", "chk", 1364.24, "2026-09-29", { det: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT", pri: "LOAN_PAYMENTS" }),
    t("pay-in", "cardA", -1364.24, "2026-09-29", { det: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT", pri: "LOAN_PAYMENTS" }),
    // A household member's card paid from an account Plaid does not see: an unpaired credit.
    t("other-pay", "cardB", -8515.76, "2026-09-08", { name: "PAYMENT THANK YOU-MOBILE", det: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT", pri: "LOAN_PAYMENTS" }),
  ];
  const c = classify(posted, accounts);
  assert.equal(c.get("pay-out").kind, "card_payment");
  assert.equal(c.get("pay-in").kind, "card_payment");
  assert.equal(c.get("pay-in").rule, "matched_pair");
  assert.equal(c.get("other-pay").kind, "card_payment");
});

test("a travel refund on a card is a refund, not income", () => {
  const c = classify([t("rf", "cardB", -298.28, "2026-08-14", { name: "LODGING REFUND", pri: "TRAVEL" })], accounts);
  assert.equal(c.get("rf").kind, "refund");
});

test("a transfer between two of the user's own accounts is internal, even when Plaid calls the inflow income", () => {
  const c = classify([
    t("x-out", "biz", 20000, "2026-09-21", { pri: "TRANSFER_OUT" }),
    t("x-in", "sav", -20000, "2026-09-21", { pri: "INCOME", det: "INCOME_CONTRACTOR" }),
  ], accounts);
  assert.equal(c.get("x-out").kind, "internal_transfer");
  assert.equal(c.get("x-in").kind, "internal_transfer");
});

test("a large unclassified outflow is held out of spending until the user says what it was", () => {
  const wire = t("wire", "sav", 306495.06, "2026-09-28", { pri: "GENERAL_SERVICES" });
  assert.equal(classify([wire], accounts).get("wire").kind, "unreviewed_large");
  const c = classify([wire], accounts, { overrides: [{ transaction_id: "wire", kind: "capital", note: "closing" }] });
  assert.equal(c.get("wire").kind, "capital");
  assert.equal(c.get("wire").rule, "override");
});

test("an inflow is income only by a rule: registered stream or rental category — otherwise unexplained", () => {
  const exp = [{ id: "acme", account_id: "biz", payer_contains: "acme", amount: 12000, tolerance: 0 }];
  const posted = [
    t("pay", "biz", -12000, "2026-10-02", { name: "Acme Corp DES:ACH Pmt", det: "INCOME_CONTRACTOR", pri: "INCOME" }),
    t("rent", "chk", -2400, "2026-10-02", { det: "INCOME_RENTAL", pri: "INCOME" }),
    t("p2p", "chk", -284.63, "2026-09-29", { pri: "GENERAL_SERVICES" }),
    t("payout", "dep", -664.16, "2026-10-02", { det: "INCOME_CONTRACTOR", pri: "INCOME" }),
  ];
  const c = classify(posted, accounts, { expectedIncome: exp, depositAccountIds: ["dep"] });
  assert.equal(c.get("pay").kind, "income");
  assert.equal(c.get("pay").expected_income_id, "acme");
  assert.equal(c.get("rent").kind, "income");
  assert.equal(c.get("p2p").kind, "inflow_unexplained");
  assert.equal(c.get("payout").kind, "deposit_in");
});

test("no registered stream → nothing is ever 'late'; a registered one is late only after due + grace", () => {
  const exp = [{ id: "s", account_id: "biz", payer_contains: "acme", amount: 12000, due_day: 1, grace_days: 3, active_from: "2026-01-01" }];
  const none = classify([], accounts, { expectedIncome: exp });
  assert.deepEqual(incomeStatus([], [], none, "2026-10-04"), []);
  assert.equal(incomeStatus(exp, [], none, "2026-10-03")[0].status, "not yet due");
  assert.equal(incomeStatus(exp, [], none, "2026-10-05")[0].status, "late");
  const paid = [t("pay", "biz", -12000, "2026-10-02", { name: "Acme" })];
  assert.equal(incomeStatus(exp, paid, classify(paid, accounts, { expectedIncome: exp }), "2026-10-05")[0].status, "received");
});

test("a shortfall needs a CONFIRMED payment; balance-based amounts are never invented", () => {
  assert.equal(nextDueDate(31, "2026-02-10"), "2026-02-28");
  const sched = [
    { id: "manual", label: "Card B (manual)", funding_account_id: "chk", amount_rule: "fixed", fixed_amount: 6757.85, due_day: 12, autopay: false },
    { id: "cardA", label: "Card A", funding_account_id: "chk", target_account_id: "cardA", amount_rule: "current_balance", due_day: 12, autopay: true },
    { id: "stmt", label: "Stmt", funding_account_id: "chk", amount_rule: "statement_balance", due_day: 12, autopay: true },
  ];
  const due = scheduledDue(sched, accounts, "2026-10-04", 14);
  assert.equal(due.find((x) => x.payment.id === "manual").short, true);
  assert.equal(due.find((x) => x.payment.id === "cardA").amount, 876);
  assert.equal(due.find((x) => x.payment.id === "stmt").amount, null);
  assert.equal(due.find((x) => x.payment.id === "stmt").short, false);
  assert.deepEqual(scheduledDue([], accounts, "2026-10-04", 14), []);
});

test("a variable stream takes what the fixed one did not, and is never late", () => {
  const exp = [
    { id: "variable", account_id: "biz", payer_contains: "acme", amount: null, due_day: null, active_from: "2026-01-01" },
    { id: "fixed", account_id: "biz", payer_contains: "acme", amount: 12000, tolerance: 0, due_day: 6, grace_days: 3, active_from: "2026-01-01" },
  ];
  const posted = [t("f", "biz", -12000, "2026-10-02", { name: "Acme" }), t("v", "biz", -20000, "2026-09-15", { name: "Acme" })];
  const c = classify(posted, accounts, { expectedIncome: exp });
  assert.equal(c.get("f").expected_income_id, "fixed");
  assert.equal(c.get("v").expected_income_id, "variable");
  const st = Object.fromEntries(incomeStatus(exp, posted, c, "2026-10-20").map((r) => [r.stream.id, r.status]));
  assert.equal(st.variable, "none yet this month");
  assert.equal(st.fixed, "received");
});
