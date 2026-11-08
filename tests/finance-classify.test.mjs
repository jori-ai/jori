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

test("a large outflow a kept record explains is not asked about (2026-11-08: a property-tax bill filed under Taxes)", () => {
  const tax = t("tax", "cardA", 19324.61, "2026-11-03", { pri: "GOVERNMENT_AND_NON_PROFIT", det: "GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT" });
  const known = new Map([["tax", { kind: "tax", rule: "recurring_tracker", note: "County property tax (tracker)" }]]);
  const c = classify([tax], accounts, { known });
  assert.deepEqual(c.get("tax"), { kind: "tax", rule: "recurring_tracker", note: "County property tax (tracker)" });
  // A small outflow is not touched by it: the record only settles what would have been asked.
  const small = t("small", "cardA", 40, "2026-11-03");
  assert.equal(classify([small], accounts, { known: new Map([["small", { kind: "tax", rule: "x" }]]) }).get("small").kind, "expense");
});

test("a tax payment is tax, never asked about, and carries its property when one is named (a county property-tax bill paid on a card)", () => {
  const tax = t("tax", "cardA", 19324.61, "2026-11-03", { name: "PMT*SAMPLE CTY TCSAMPLE", pri: "GENERAL_SERVICES" });
  const plain = classify([tax], accounts).get("tax");
  assert.equal(plain.kind, "tax");
  assert.equal(plain.rule, "tax_payee");
  assert.equal(plain.property_id, undefined);
  const rules = [{ contains: "sample", property_id: "home-a", from: "2026-06-23" }];
  assert.equal(classify([tax], accounts, { taxProperties: rules }).get("tax").property_id, "home-a");
  // Outside the rule's dates the property is not determinable, so none is claimed.
  assert.equal(classify([{ ...tax, date: "2026-01-05" }], accounts, { taxProperties: rules }).get("tax").property_id, undefined);
  // Merchant name alone, Plaid's own tax category, and an instance's extra phrase all count.
  assert.equal(classify([t("m", "cardA", 12000, "2026-11-03", { name: "x", pri: "GOVERNMENT_AND_NON_PROFIT", det: "GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT" })], accounts).get("m").rule, "plaid_tax_payment");
  const m = t("m2", "cardA", 800, "2026-11-03", { name: "ACME COUNTY TREASURERS OFFICE" });
  assert.equal(classify([m], accounts).get("m2").kind, "tax");
  assert.equal(classify([t("m3", "cardA", 800, "2026-11-03", { name: "BOROUGH LEVY DEPT" })], accounts, { taxPayeePhrases: ["levy dept"] }).get("m3").kind, "tax");
  // An ordinary charge is untouched, and a person's verdict still wins.
  assert.equal(classify([t("o", "cardA", 40, "2026-11-03", { name: "COFFEE" })], accounts).get("o").kind, "expense");
  assert.equal(classify([tax], accounts, { overrides: [{ transaction_id: "tax", kind: "capital", note: "n" }] }).get("tax").kind, "capital");
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

// ── The rental books' payouts ───────────────────────────────────────────────
// A weekly review asked "what was the $X that arrived?" about each tenant's
// rent, one new tenant at a time, although the rental books had already linked
// every one of those credits to the payout it was. The classifier now asks the
// books first (rule 1b); rental-ledger.js says which credits are payouts.

const { payoutsForBankRows } = require("../lib/rental-ledger.js");
const banks = [
  { account_id: "home", type: "depository", mask: "1111" },
  { account_id: "dep", type: "depository", mask: "2222" },
  { account_id: "chk", type: "depository", mask: "3333" },
];
const stripeLine = (code) => `Owner Name DES:${code} ID:X1Y2Z3 INDN:Owner Name CO ID:PROC0001 CCD`;
const row = (id, account_id, amount, date, code) => ({ transaction_id: id, account_id, amount, date, name: stripeLine(code), merchant_name: null, category_primary: "INCOME", category_detailed: "INCOME_CONTRACTOR" });
const payout = (id, last4, cents, at, descriptor, extra = {}) => ({ id, bankLast4: last4, amountCents: cents, createdAt: at, descriptor, status: "paid", tenantName: extra.tenant || "Pat Smith", period: extra.period || "2026-11", ...extra });

test("a credit the books linked to a rent payout is income, a deposit payout is deposit_in, the rest still a question", () => {
  const posted = [row("r1", "home", -512.34, "2026-11-06", "OK SMI R11"), row("d1", "dep", -750, "2026-11-05", "OK JON D11"), t("mystery", "chk", -275, "2026-11-04", { pri: "GENERAL_SERVICES" })];
  const ledgerRows = [
    { id: "plaid:r1", payout: { payoutId: "obt_r1", kind: "rent", descriptor: "OK-SMI R11", tenants: [{ name: "Pat Smith", period: "2026-11", propertyName: "Oak" }] } },
    { id: "plaid:d1", payout: { payoutId: "obt_d1", kind: "deposit", descriptor: "OK-JON D11", tenants: [{ name: "Lee Jones", period: "2026-11", propertyName: "Oak" }] } },
  ];
  const pv = payoutsForBankRows({ ledgerRows, payouts: [], posted, accounts: banks });
  assert.deepEqual(pv.get("r1"), { kind: "rent", source: "hub_link", payout_id: "obt_r1", tenants: ["Pat Smith"], period: "2026-11", property: "Oak" });
  assert.equal(pv.get("d1").kind, "deposit");
  assert.equal(pv.has("mystery"), false);
  const bookVerdicts = new Map([...pv].map(([id, p]) => [id, { kind: p.kind === "deposit" ? "deposit_in" : "income", rule: "rental_books_payout" }]));
  const c = classify(posted, banks, { bookVerdicts });
  assert.equal(c.get("r1").kind, "income");
  assert.equal(c.get("r1").rule, "rental_books_payout");
  assert.equal(c.get("d1").kind, "deposit_in");
  assert.equal(c.get("mystery").kind, "inflow_unexplained");
  // Without the books, the same rent is exactly the question the review used to ask.
  assert.equal(classify(posted, banks).get("r1").kind, "inflow_unexplained");
});

test("a person's verdict beats the books, and the books beat pairing", () => {
  const posted = [row("r1", "home", -433.21, "2026-11-06", "OK SMI R11"), t("out", "chk", 433.21, "2026-11-05", { pri: "GENERAL_SERVICES" })];
  const bookVerdicts = new Map([["r1", { kind: "income", rule: "rental_books_payout" }]]);
  const c = classify(posted, banks, { bookVerdicts });
  assert.equal(c.get("r1").rule, "rental_books_payout");
  assert.equal(c.get("out").kind, "expense", "a same-cents debit elsewhere is not the other leg of a payout");
  const o = classify(posted, banks, { bookVerdicts, overrides: [{ transaction_id: "r1", kind: "refund", note: "said so" }] });
  assert.equal(o.get("r1").kind, "refund");
});

test("rent the books recognise still counts for the stream the user registered for it", () => {
  const exp = [{ id: "oak-rent", account_id: "home", payer_contains: "DES:OK ", amount: null, due_day: 1, grace_days: 7, active_from: "2026-10-01" }];
  const posted = [row("r1", "home", -512.34, "2026-11-06", "OK SMI R11")];
  const c = classify(posted, banks, { expectedIncome: exp, bookVerdicts: new Map([["r1", { kind: "income", rule: "rental_books_payout" }]]) });
  assert.equal(c.get("r1").rule, "rental_books_payout");
  assert.equal(c.get("r1").expected_income_id, "oak-rent");
  assert.equal(incomeStatus(exp, posted, c, "2026-11-15")[0].status, "received", "never 'late' because the books classified it first");
});

test("a payout the hub has not linked yet is found from its record: same bank, same cents, its descriptor", () => {
  // Six tenants paying the same rent land six identical credits on one day;
  // only the descriptor tells them apart.
  const names = ["SMI", "JON", "LEE", "KIM", "DOE", "ROE"];
  const posted = names.map((n, i) => row(`r${i}`, "home", -512.34, "2026-11-07", `OK ${n} R11`));
  const payouts = names.map((n, i) => payout(`obt_${n}`, "1111", 51234, "2026-11-06T14:04:30.000Z", `OK-${n} R11`, { tenant: `Tenant ${n}` }));
  const pv = payoutsForBankRows({ ledgerRows: [], payouts, posted, accounts: banks });
  assert.equal(pv.size, 6);
  for (const [i, n] of names.entries()) {
    assert.equal(pv.get(`r${i}`).payout_id, `obt_${n}`);
    assert.equal(pv.get(`r${i}`).source, "payout_record");
    assert.equal(pv.get(`r${i}`).kind, "rent");
  }
  assert.equal(payoutsForBankRows({ payouts: [payout("obt_d", "2222", 75000, "2026-11-05T14:00:00Z", "OK-JON D11", { kind: "deposit" })], posted: [row("d", "dep", -750, "2026-11-05", "OK JON D11")], accounts: banks }).get("d").kind, "deposit");
  // A record sent to the deposits bank is a deposit even when it carries no kind.
  assert.equal(payoutsForBankRows({ payouts: [payout("obt_e", "2222", 75000, "2026-11-05T14:00:00Z", "OK-LEE D11", { propertySlug: "deposits" })], posted: [row("e", "dep", -750, "2026-11-05", "OK LEE D11")], accounts: banks, depositSlug: "deposits" }).get("e").kind, "deposit");
});

test("a payout record never claims a credit it cannot be sure of", () => {
  const at = "2026-11-06T14:04:30.000Z";
  const one = (payouts, posted, ledgerRows = []) => payoutsForBankRows({ ledgerRows, payouts, posted, accounts: banks });
  // Same cents on the same bank, but the bank line is not the payout's: not claimed.
  assert.equal(one([payout("p", "1111", 51234, at, "OK-SMI R11")], [{ transaction_id: "x", account_id: "home", amount: -512.34, date: "2026-11-07", name: "ZELLE FROM SOMEONE" }]).size, 0);
  // Another bank, another amount, outside the window: not claimed.
  assert.equal(one([payout("p", "1111", 51234, at, "OK-SMI R11")], [row("x", "chk", -512.34, "2026-11-07", "OK SMI R11")]).size, 0);
  assert.equal(one([payout("p", "1111", 51234, at, "OK-SMI R11")], [row("x", "home", -512.35, "2026-11-07", "OK SMI R11")]).size, 0);
  assert.equal(one([payout("p", "1111", 51234, at, "OK-SMI R11")], [row("x", "home", -512.34, "2026-11-20", "OK SMI R11")]).size, 0);
  // A payout that failed or was cancelled never arrived.
  assert.equal(one([payout("p", "1111", 51234, at, "OK-SMI R11", { status: "failed" })], [row("x", "home", -512.34, "2026-11-07", "OK SMI R11")]).size, 0);
  // No descriptor and two credits that fit: neither.
  assert.equal(one([payout("p", "1111", 32109, at, null)], [row("a", "home", -321.09, "2026-11-06", "PAYOUT CO"), row("b", "home", -321.09, "2026-11-07", "PAYOUT CO")]).size, 0);
  // One credit two payouts both want: neither.
  assert.equal(one([payout("p", "1111", 32109, at, null), payout("q", "1111", 32109, at, null)], [row("a", "home", -321.09, "2026-11-06", "PAYOUT CO")]).size, 0);
  // A payout the hub already linked to another row is not reused, and a linked row is not re-matched.
  const linked = [{ id: "plaid:a", payout: { payoutId: "p", kind: "rent", tenants: [] } }];
  const r = one([payout("p", "1111", 51234, at, "OK-SMI R11")], [row("a", "home", -512.34, "2026-11-06", "OK SMI R11"), row("b", "home", -512.34, "2026-11-07", "OK SMI R11")], linked);
  assert.deepEqual([...r.keys()], ["a"]);
  // A debit is never a payout.
  assert.equal(one([payout("p", "1111", 51234, at, "OK-SMI R11")], [row("x", "home", 512.34, "2026-11-07", "OK SMI R11")]).size, 0);
});
