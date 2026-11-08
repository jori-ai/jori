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

// ── What the books already answered ─────────────────────────────────────────
// The same review asked "capital or expense?" about a county tax payment a
// person had already filed under taxes in the books, and "is this a scheduled
// card payment?" about a landscaper's bill a person had filed under repairs.
// A category a person set or confirmed, or the books' own rule or earlier
// decision, answers what the rules leave as a question (rule 11); the books'
// guesses never do.

const { answeredCategoriesForBankRows } = require("../lib/rental-ledger.js");
const { bookCategoryKind, streamsCoveredByBooks } = require("../lib/finance-classify.js");
const cats = [
  { id: "income", kind: "income", name: "Rental Income" },
  { id: "income-interest", kind: "income", name: "Interest Income" },
  { id: "maintenance-repairs", kind: "expense", name: "Maintenance/Repairs" },
  { id: "taxes", kind: "expense", name: "Taxes" },
  { id: "security-deposit", kind: "capital", name: "Security Deposits Held" },
  { id: "mortgage-principal", kind: "capital", name: "Mortgage Principal" },
  { id: "transfers-card-payments", kind: "expense", name: "Transfers & Card Payments", excludedFromReports: true },
  { id: "ask-my-accountant", kind: "expense", name: "Ask My Accountant", isUnclassified: true },
];
const reg = { categoryById: new Map(cats.map((c) => [c.id, c])), unclassifiedId: "ask-my-accountant" };
const lrow = (txn, extra) => ({ id: `plaid:${txn}`, classification: { categoryId: "ask-my-accountant", method: "deterministic", confidence: 0 }, override: null, reviewed: false, ...extra });

test("only a person's category, a reviewed row, an earlier decision or a sure rule counts as the books' answer", () => {
  const rows = [
    lrow("person", { override: { categoryId: "taxes", updatedBy: "someone@example.com" } }),
    lrow("reviewed", { classification: { categoryId: "maintenance-repairs", method: "model", confidence: 0.75 }, reviewed: true }),
    lrow("precedent", { classification: { categoryId: "maintenance-repairs", method: "precedent", confidence: 1 } }),
    lrow("rule", { classification: { categoryId: "income", method: "deterministic", confidence: 1 } }),
    lrow("guess", { classification: { categoryId: "maintenance-repairs", method: "model", confidence: 0.9 } }),
    lrow("unclassified", {}),
    lrow("transfer", { override: { categoryId: "transfers-card-payments" } }),
    lrow("ignored", { override: { categoryId: "taxes", ignored: true } }),
    lrow("split", { override: { categoryId: "taxes" }, splits: [{ categoryId: "taxes", amount: 5 }, { categoryId: "maintenance-repairs", amount: 5 }] }),
    { id: "manual:1", override: { categoryId: "taxes" } },
  ];
  const a = answeredCategoriesForBankRows({ ledgerRows: rows, registry: reg });
  assert.deepEqual([...a.keys()].sort(), ["person", "precedent", "reviewed", "rule", "split"]);
  assert.deepEqual(a.get("person"), { categories: [{ id: "taxes", kind: "expense", name: "Taxes" }], basis: "person", by: "someone@example.com", property_id: null });
  assert.equal(a.get("reviewed").basis, "reviewed");
  assert.equal(a.get("precedent").basis, "precedent");
  assert.equal(a.get("rule").basis, "rule");
  assert.equal(answeredCategoriesForBankRows({ ledgerRows: rows }).size, 0, "no registry, no answers");
});

test("what a books category makes a transaction, by direction", () => {
  const k = (id, inflow, kinds) => bookCategoryKind({ categories: [cats.find((c) => c.id === id)] }, inflow, kinds);
  assert.equal(k("income", true), "income");
  assert.equal(k("income", false), null, "money paid out under an income category answers nothing");
  assert.equal(k("income-interest", true), "interest_earned");
  assert.equal(k("maintenance-repairs", false), "expense");
  assert.equal(k("maintenance-repairs", true), "refund");
  assert.equal(k("taxes", false), "tax");
  assert.equal(k("taxes", true), null);
  assert.equal(k("security-deposit", true), "deposit_in");
  assert.equal(k("security-deposit", false), null);
  assert.equal(k("mortgage-principal", false), "capital");
  assert.equal(k("taxes", false, { taxes: { out: "expense" } }), "expense", "an installation can say otherwise");
  assert.equal(k("taxes", false, { taxes: null }), null);
  assert.equal(bookCategoryKind({ categories: [cats[2], cats[3]] }, false), null, "a split whose parts disagree answers nothing");
});

test("the books answer what the rules leave as a question, and only that", () => {
  const posted = [
    t("tax", "cardA", 19324.61, "2026-11-03", { pri: "GOVERNMENT_AND_NON_PROFIT" }),        // unreviewed large on a card
    t("in", "chk", -1200, "2026-11-04", { pri: "TRANSFER_IN", det: "TRANSFER_IN_DEPOSIT" }), // stays transfer_external: not a question
    t("odd", "biz", -640, "2026-11-04", { pri: "GENERAL_SERVICES" }),                          // unexplained
    t("lawn", "chk", 300, "2026-10-19", { pri: "HOME_IMPROVEMENT" }),                          // a bill that happens to pair…
    t("cr", "cardB", -300, "2026-10-20", { pri: "GENERAL_MERCHANDISE" }),                      // …with a card credit
    t("shop", "chk", 80, "2026-11-02", { pri: "GENERAL_MERCHANDISE" }),                        // plain expense
    t("guessed", "biz", -900, "2026-11-05", { pri: "GENERAL_SERVICES" }),                      // the books only guessed
  ];
  const bookCategories = answeredCategoriesForBankRows({ registry: reg, ledgerRows: [
    lrow("tax", { override: { categoryId: "taxes", updatedBy: "p@example.com" } }),
    lrow("in", { override: { categoryId: "maintenance-repairs" } }),
    lrow("odd", { classification: { categoryId: "income", method: "precedent", confidence: 1 } }),
    lrow("lawn", { override: { categoryId: "maintenance-repairs" } }),
    lrow("shop", { override: { categoryId: "mortgage-principal" } }),
    lrow("guessed", { classification: { categoryId: "income", method: "model", confidence: 0.95 } }),
  ] });
  const before = classify(posted, accounts);
  assert.equal(before.get("tax").kind, "unreviewed_large");
  assert.equal(before.get("odd").kind, "inflow_unexplained");
  assert.equal(before.get("lawn").kind, "card_payment");
  const c = classify(posted, accounts, { bookCategories });
  assert.equal(c.get("tax").kind, "tax");
  assert.equal(c.get("tax").rule, "books_category");
  assert.equal(c.get("tax").book_basis, "person");
  assert.equal(c.get("odd").kind, "income");
  assert.equal(c.get("lawn").kind, "expense", "a bank debit a person filed as a repair is not a card payment");
  assert.equal(c.get("in").kind, "transfer_external", "a verdict the rules reached stays");
  assert.equal(c.get("shop").kind, "expense", "spending is never re-read");
  assert.equal(c.get("guessed").kind, "inflow_unexplained", "a guess is not an answer");
  // A person's verdict recorded here still wins.
  const o = classify(posted, accounts, { bookCategories, overrides: [{ transaction_id: "tax", kind: "capital", note: "said so" }] });
  assert.equal(o.get("tax").kind, "capital");
});

test("a real card payment out of a bank account is never re-read as spending, whatever the books filed it under", () => {
  // That card's purchases are already spending; calling the payment an expense too counts them twice.
  const posted = [
    t("pay", "chk", 640, "2026-11-02", { pri: "LOAN_PAYMENTS", det: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" }),
    t("in", "cardA", -640, "2026-11-03", { pri: "LOAN_PAYMENTS", det: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" }),
    t("solo", "chk", 210, "2026-11-04", { pri: "LOAN_PAYMENTS", det: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT" }),
  ];
  const bookCategories = answeredCategoriesForBankRows({ registry: reg, ledgerRows: [
    lrow("pay", { override: { categoryId: "maintenance-repairs" } }), lrow("solo", { override: { categoryId: "maintenance-repairs" } }),
  ] });
  const c = classify(posted, accounts, { bookCategories });
  assert.equal(c.get("pay").kind, "card_payment");
  assert.equal(c.get("solo").kind, "card_payment");
});

test("the books never re-read what the tax rule or a tracked bill already settled", () => {
  // Rules 8b and 9 answer before rule 11 is reached: a books category on the same row changes nothing.
  const posted = [
    t("cty", "cardA", 19324.61, "2026-11-03", { name: "PMT*SAMPLE CTY TCSAMPLE", pri: "GENERAL_SERVICES" }),
    t("bill", "chk", 12500, "2026-11-04", { pri: "GENERAL_SERVICES" }),
  ];
  const bookCategories = answeredCategoriesForBankRows({ registry: reg, ledgerRows: [
    lrow("cty", { override: { categoryId: "maintenance-repairs" } }),
    lrow("bill", { override: { categoryId: "mortgage-principal" } }),
  ] });
  const known = new Map([["bill", { kind: "expense", rule: "recurring_tracker", note: "Insurance (tracker)" }]]);
  const c = classify(posted, accounts, { bookCategories, known });
  assert.equal(c.get("cty").kind, "tax");
  assert.equal(c.get("cty").rule, "tax_payee");
  assert.deepEqual(c.get("bill"), { kind: "expense", rule: "recurring_tracker", note: "Insurance (tracker)" });
});

test("a stream registered by hand for money the books already name is redundant; one they only partly name is not", () => {
  const exp = [
    { id: "oak-rent", account_id: "home", payer_contains: "DES:OK ", amount: null, due_day: 1, grace_days: 7, active_from: "2026-10-01" },
    { id: "elm-rent", account_id: "home", payer_contains: "DES:EL ", amount: null, due_day: 1, grace_days: 7, active_from: "2026-10-01" },
  ];
  const posted = [row("r1", "home", -512.34, "2026-11-06", "OK SMI R11"), row("r2", "home", -700, "2026-10-06", "EL ZED R10"), row("r3", "home", -700, "2026-11-06", "EL ZED R11")];
  const c = classify(posted, banks, { expectedIncome: exp, bookVerdicts: new Map([["r1", { kind: "income", rule: "rental_books_payout" }], ["r3", { kind: "income", rule: "rental_books_payout" }]]) });
  assert.deepEqual([...streamsCoveredByBooks(c)], ["oak-rent"]);
  assert.deepEqual([...streamsCoveredByBooks(classify(posted, banks, { expectedIncome: exp }))], [], "no books, nothing redundant");
});

test("an outgoing transfer to another person is spending; to one's own account it stays a transfer; out of the deposit account it is a deposit refund; at an ATM it is cash", () => {
  const c = classify([
    t("zelle", "chk", 335, "2026-11-04", { name: "Zelle payment to EDY'S SERVICE CORP for \"cleaning\"", pri: "TRANSFER_OUT" }),
    t("payroll", "biz", 6749.28, "2026-11-04", { name: "GUSTO DES:NET", pri: "TRANSFER_OUT" }),
    t("own", "chk", 3000, "2026-11-03", { name: "Online Banking transfer to CHK 2255 Confirmation# 1", pri: "TRANSFER_OUT" }),
    t("bank", "sav", 15000, "2026-10-03", { name: "TRANSFER A AND B:JP Morgan Chase Confirmation# 2", pri: "TRANSFER_OUT" }),
    t("dep", "dep", 1600, "2026-10-26", { name: "Zelle payment to TENANT for \"Deposit refund\"", pri: "TRANSFER_OUT" }),
    t("atm", "chk", 135, "2026-10-21", { name: "5C002II6 10/21 # WITHDRWL LEUMI CARD ATM", pri: "TRANSFER_OUT" }),
  ], accounts, { depositAccountIds: ["dep"], ownInstitutions: ["Chase"] });
  assert.equal(c.get("zelle").kind, "expense");
  assert.equal(c.get("zelle").rule, "payment_to_other");
  assert.equal(c.get("payroll").kind, "expense");
  assert.equal(c.get("own").kind, "transfer_external");
  assert.equal(c.get("bank").kind, "transfer_external");
  assert.equal(c.get("dep").kind, "deposit_refund");
  assert.equal(c.get("atm").kind, "cash_withdrawal");
});

test("payroll paid as one net amount and received per person is a transfer between one's own accounts (split pair)", () => {
  const c = classify([
    t("net", "biz", 6749.28, "2026-11-06", { name: "PAYROLLCO DES:NET 802512", pri: "TRANSFER_OUT" }),
    t("p1", "chk", -3374.64, "2026-11-07", { name: "ACH CREDIT Acme LLC PAYROLL ON 11/07", pri: "INCOME", det: "INCOME_SALARY" }),
    t("p2", "chk", -3374.64, "2026-11-07", { name: "ACH CREDIT Acme LLC PAYROLL ON 11/07", pri: "INCOME", det: "INCOME_SALARY" }),
    t("rent", "chk", -3374.64, "2026-11-07", { name: "OTHER PAYER DES:RENT", pri: "INCOME" }),
  ], accounts);
  assert.equal(c.get("net").kind, "internal_transfer");
  assert.equal(c.get("net").rule, "split_pair");
  assert.equal(c.get("p1").kind, "internal_transfer");
  assert.equal(c.get("p2").kind, "internal_transfer");
  assert.notEqual(c.get("rent").kind, "internal_transfer"); // another payer is never part of the set
});

test("a split pair matches pending credits too (payroll lands a day later, pending first)", () => {
  const c = classify([t("net", "biz", 100, "2026-11-06", { name: "PAYROLLCO DES:NET", pri: "TRANSFER_OUT" })], accounts, {
    pending: [{ ...t("q1", "chk", -60, "2026-11-07", { name: "ACH CREDIT Acme LLC PAYROLL" }), pending: true }, { ...t("q2", "chk", -40, "2026-11-07", { name: "ACH CREDIT Acme LLC PAYROLL" }), pending: true }],
  });
  assert.equal(c.get("net").kind, "internal_transfer");
  assert.equal(c.has("q1"), false);
});
