// finance-review-facts.test.mjs — the weekly finance review may not state an
// inference as a fact.
//
// Every case below is a kind of false statement a weekly review once sent,
// reduced to the smallest input that produced it (synthetic accounts, tenants
// and amounts):
//   * two credit-card payment credits reported as "income 15 / 53 days late";
//   * a $20,000 transfer between two of the user's own accounts counted as money
//     in AND money out;
//   * a large wire folded into spending and runway;
//   * an inherited deposit "never received", a paid deposit "$500 short", and a
//     lease starting in ten months "$4,000 unaccounted for" — all paid or
//     partly paid in the hub's records;
//   * one building valued two ways;
//   * a summary that said "autopay", "normal mid-month" and a number the
//     packet never contained.
//
// Run: node --test tests/finance-review-facts.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
// Deposit answers are attributed to the owner by name (lib/instance.cjs).
process.env.JORI_OWNER_NAME = "Alex";
const { classify } = require("../lib/finance-classify.js");
const { depositsFromHub, depositSection, depositAnswer } = require("../lib/finance-deposit-reconcile.js");
const { reconcileInvoices } = require("../lib/finance-invoice-reconcile.js");
const { verifySummary } = require("../lib/finance-review-verify.js");
const { valueByProperty } = require("../lib/finance-real-estate.js");
const { incomeStatus, scheduledDue, nextDueDate } = require("../lib/finance-expected.js");

const accounts = [
  { account_id: "chk", type: "depository", name: "Primary Checking", balance_current: 2100, balance_available: 2100 },
  { account_id: "sav", type: "depository", name: "Primary Savings", balance_current: 18000 },
  { account_id: "biz", type: "depository", name: "Business" },
  { account_id: "dep", type: "depository", name: "Security Deposits" },
  { account_id: "card1", type: "credit", name: "Rewards", balance_current: 640 },
  { account_id: "card2", type: "credit", name: "CREDIT CARD", balance_current: 5000 },
];
const t = (id, account_id, amount, date, extra = {}) => ({ transaction_id: id, account_id, amount, date, name: extra.name || id, merchant_name: null, category_primary: extra.pri || null, category_detailed: extra.det || null });

test("a card payment credit is never income, paired or not", () => {
  const posted = [
    t("pay-out", "chk", 1200.5, "2026-09-29", { det: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT", pri: "LOAN_PAYMENTS" }),
    t("pay-in", "card1", -1200.5, "2026-09-29", { det: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT", pri: "LOAN_PAYMENTS" }),
    // A partner's card is paid from an account Plaid does not see: an unpaired credit.
    t("partner-pay", "card2", -4100, "2026-09-08", { name: "PAYMENT THANK YOU-MOBILE", det: "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT", pri: "LOAN_PAYMENTS" }),
  ];
  const c = classify(posted, accounts);
  assert.equal(c.get("pay-out").kind, "card_payment");
  assert.equal(c.get("pay-in").kind, "card_payment");
  assert.equal(c.get("pay-in").rule, "matched_pair");
  assert.equal(c.get("partner-pay").kind, "card_payment");
});

test("an Airbnb refund on a card is a refund, not income", () => {
  const c = classify([t("abnb", "card2", -210.4, "2026-08-14", { name: "AIRBNB", pri: "TRAVEL" })], accounts);
  assert.equal(c.get("abnb").kind, "refund");
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
  const wire = t("wire", "sav", 250000, "2026-09-28", { pri: "GENERAL_SERVICES" });
  assert.equal(classify([wire], accounts).get("wire").kind, "unreviewed_large");
  const c = classify([wire], accounts, { overrides: [{ transaction_id: "wire", kind: "capital", note: "closing" }] });
  assert.equal(c.get("wire").kind, "capital");
  assert.equal(c.get("wire").rule, "override");
});

test("an inflow is income only by a rule: registered stream or rental category — otherwise unexplained", () => {
  const exp = [{ id: "client", account_id: "biz", payer_contains: "clientco", amount: 9000, tolerance: 0 }];
  const posted = [
    t("aw", "biz", -9000, "2026-10-02", { name: "Clientco, Inc. DES:ACH Pmt", det: "INCOME_CONTRACTOR", pri: "INCOME" }),
    t("rent", "chk", -2400, "2026-10-02", { det: "INCOME_RENTAL", pri: "INCOME" }),
    t("zelle", "chk", -150.25, "2026-09-29", { pri: "GENERAL_SERVICES" }),
    t("stripe", "dep", -420.1, "2026-10-02", { det: "INCOME_CONTRACTOR", pri: "INCOME" }),
  ];
  const c = classify(posted, accounts, { expectedIncome: exp, depositAccountIds: ["dep"] });
  assert.equal(c.get("aw").kind, "income");
  assert.equal(c.get("aw").expected_income_id, "client");
  assert.equal(c.get("rent").kind, "income");
  assert.equal(c.get("zelle").kind, "inflow_unexplained");
  assert.equal(c.get("stripe").kind, "deposit_in");
});

test("no registered stream → nothing is ever 'late'; a registered one is late only after due + grace", () => {
  const exp = [{ id: "s", account_id: "biz", payer_contains: "clientco", amount: 9000, due_day: 1, grace_days: 3, active_from: "2026-01-01" }];
  const none = classify([], accounts, { expectedIncome: exp });
  assert.deepEqual(incomeStatus([], [], none, "2026-10-04"), []);
  assert.equal(incomeStatus(exp, [], none, "2026-10-03")[0].status, "not yet due");
  assert.equal(incomeStatus(exp, [], none, "2026-10-05")[0].status, "late");
  const paid = [t("aw", "biz", -9000, "2026-10-02", { name: "Clientco" })];
  assert.equal(incomeStatus(exp, paid, classify(paid, accounts, { expectedIncome: exp }), "2026-10-05")[0].status, "received");
});

test("a shortfall needs a CONFIRMED payment; balance-based amounts are never invented", () => {
  assert.equal(nextDueDate(31, "2026-02-10"), "2026-02-28");
  const sched = [
    { id: "partner-card", label: "Card (Partner)", funding_account_id: "chk", amount_rule: "fixed", fixed_amount: 3200, due_day: 12, autopay: false },
    { id: "card1", label: "Rewards card", funding_account_id: "chk", target_account_id: "card1", amount_rule: "current_balance", due_day: 12, autopay: true },
    { id: "stmt", label: "Stmt", funding_account_id: "chk", amount_rule: "statement_balance", due_day: 12, autopay: true },
  ];
  const due = scheduledDue(sched, accounts, "2026-10-04", 14);
  assert.equal(due.find((x) => x.payment.id === "partner-card").short, true);
  assert.equal(due.find((x) => x.payment.id === "card1").amount, 640);
  assert.equal(due.find((x) => x.payment.id === "stmt").amount, null);
  assert.equal(due.find((x) => x.payment.id === "stmt").short, false);
  assert.deepEqual(scheduledDue([], accounts, "2026-10-04", 14), []);
});

test("one building, one value: a building's two apartments are priced to their own properties", () => {
  const rec = [
    { parcel_id: "elm_1d", holding: "elm", value: 900000 },
    { parcel_id: "elm_1c", holding: "elm", value: 400000 },
    { parcel_id: "oak_1653", holding: "oak_118", value: 80000 },
    { parcel_id: "oak_1655", holding: "oak_118", value: 80000 },
  ];
  const v = valueByProperty(rec, ["elm-home", "elm-1c", "oak-118"], {
    property_value_keys: { "elm-home": "elm", "oak-118": "oak_118" },
    parcel_property: { elm_1d: "elm-home", elm_1c: "elm-1c" },
  });
  assert.equal(v.byProperty["elm-home"], 900000);
  assert.equal(v.byProperty["elm-1c"], 400000);
  assert.equal(v.byProperty["oak-118"], 160000);
});

test("the summary verifier rejects the hallucinations and accepts a faithful sentence", () => {
  const packet = { facts: [{ id: "a1", text: "IRS tax payment (recurring, typically $30,000) is expected Oct 14 from Bank — Primary Savings, which has $18,000 available." }] };
  const bad = verifySummary(packet, { sentences: [{ text: "The card autopay of $3,200 will overdraw checking, which is normal mid-month.", facts: ["a1"] }] });
  assert.equal(bad.ok, false);
  const issues = bad.problems.map((p) => p.issue).join(" | ");
  for (const w of ["3200", "autopay", "normal", "overdraw"]) assert.match(issues, new RegExp(w));
  assert.equal(verifySummary(packet, { sentences: [{ text: "x", facts: [] }] }).ok, false);
  assert.equal(verifySummary(packet, { sentences: [{ text: "x", facts: ["nope"] }] }).ok, false);
  const good = verifySummary(packet, { sentences: [{ text: "The IRS tax payment, typically $30,000, is expected Oct 14 from Bank — Primary Savings, which has $18,000 available.", facts: ["a1"] }] });
  assert.deepEqual(good.problems, []);
});

test("a variable stream takes what the fixed one did not, and is never late", () => {
  const exp = [
    { id: "partner", account_id: "biz", payer_contains: "clientco", amount: null, due_day: null, active_from: "2026-01-01" },
    { id: "owner", account_id: "biz", payer_contains: "clientco", amount: 9000, tolerance: 0, due_day: 6, grace_days: 3, active_from: "2026-01-01" },
  ];
  const posted = [t("m", "biz", -9000, "2026-10-02", { name: "Clientco" }), t("p", "biz", -18000, "2026-09-15", { name: "Clientco" })];
  const c = classify(posted, accounts, { expectedIncome: exp });
  assert.equal(c.get("m").expected_income_id, "owner");
  assert.equal(c.get("p").expected_income_id, "partner");
  const st = Object.fromEntries(incomeStatus(exp, posted, c, "2026-10-20").map((r) => [r.stream.id, r.status]));
  assert.equal(st.partner, "none yet this month");
  assert.equal(st.owner, "received");
});

test("deposits come from the hub's record: missing only when it shows the money outside, never from the balance", () => {
  const W = (positions, outside, extra = {}) => ({ positions: positions.map(([place, amount]) => ({ place, label: place, amount })), outside, owed: 0, trail: [], receivedOn: null, returnedOn: null, ...extra });
  const D = (id, tenant, amount, w, extra = {}) => ({ id, tenant, amount, lease_number: "L", property_id: "birch", property_name: "40 Birch Ave", hub_status: extra.status || "paid", paid_via: extra.via || "external", lease_end: null, whereabouts: w, outside_allowed: extra.allowed || null });
  const deposits = [
    D("lena", "Lena", 1200, W([["1111", 1200]], 0)),
    D("nora", "Nora", 2400, W([["untraced", 2400]], 2400)),
    D("marco", "Marco", 1600, W([["2222", 1600]], 1600), { allowed: { note: "being returned from 2222" } }),
    D("jonas", "Jonas", 3700, W([["closing-credit", 3700]], 0), { allowed: { note: "closing credit" } }),
    D("jules", "Jules", 1500, W([["1111", 1497.5], ["stripe-fee", 2.5]], 0), { via: "stripe" }),
    D("cha", "Charlie", 666.66, W([["stripe", 666.66]], 666.66), { via: "stripe" }),
    D("iris", "Iris", 2400, W([["untraced", 2400]], 0), { status: "released" }),
    D("new", "New", 900, null),
  ];
  const report = {
    computedAt: "2026-10-17T12:00:00Z",
    account: { mask: "1111", name: "Security Deposits" },
    proof: { balance: 3000, deposits: 2697.5, other: 0.38, unlinked: 2400, unexplained: 9.41 },
    unlinked: [{ id: "plaid:x", date: "2026-09-14", amount: 2400, description: "Online Banking transfer from CHK 2222", options: [{ members: [{ depositId: "nora", tenantName: "Nora", amount: 2400 }] }, { members: [{ depositId: "lena", tenantName: "Lena", amount: 1200 }, { depositId: "noel", tenantName: "Noel", amount: 1200 }] }] }],
  };
  const hubTransfers = [{ id: "t", status: "in_transit", arrival: "2026-10-20", shares: [{ deposit_id: "cha" }] }];
  const r = depositsFromHub({ deposits, report, depositMask: "1111", hubTransfers });
  const by = Object.fromEntries(r.rows.map((x) => [x.id, x]));
  assert.equal(by.lena.location, "deposit_account");
  assert.equal(by.jules.location, "deposit_account");          // the $2.50 Stripe fee is accepted, not missing
  assert.equal(by.jules.fee_absorbed, 2.5);
  assert.equal(by.nora.location, "untraced");
  assert.equal(by.marco.location, "operating_account");
  assert.equal(by.marco.expected_location, "exception");         // allowed in the hub: not missing
  assert.equal(by.cha.location, "in_transit");
  assert.equal(by.iris.location, "refunded");
  assert.equal(by.new.location, "untraced");                    // no record yet is a question too
  assert.deepEqual(r.missing.map((x) => x.id).sort(), ["new", "nora"]);
  // The ambiguous transfer is a question with both answers, never a verdict.
  assert.equal(r.ambiguities.length, 1);
  assert.equal(r.ambiguities[0].kind, "sweep");
  assert.match(r.ambiguities[0].text, /Nora .* OR .*Lena .* \+ .*Noel/);
  const sec = depositSection({ run_at: new Date().toISOString(), report: { ...r, deposit_account: "Security Deposits ••1111" } }, "2026-10-17");
  assert.ok(sec.flags.some((f) => f.tag === "deposit-ambiguous"));
  assert.ok(!sec.flags.some((f) => f.tag === "deposit-missing" && /Marco|Jonas|Lena|Jules/.test(f.text)));
  assert.ok(sec.flags.some((f) => f.tag === "deposit-missing" && /Nora/.test(f.text) && /no bank row shows where it is/.test(f.text)));
});

test("one transfer that fits two sets of tenants is asked, not asserted; the owner's answer settles it", () => {
  // A $2,400 ••2222 -> ••1111 transfer: the hub linked it to one tenant, and
  // the review called two others' $1,200 each missing, though their two
  // credits are what it matched.
  const R = "plaid:sep14";
  const leg = (rowId, date, from, to, amount) => ({ rowId, date, from, to, amount, description: `transfer ${from} -> ${to}` });
  const D = (id, tenant, amount, trail, positions, extra = {}) => ({
    id, tenant, amount, lease_number: "L", property_id: "birch", property_name: "40 Birch Ave", hub_status: "paid", paid_via: "external", lease_end: null, outside_allowed: null,
    whereabouts: { trail, positions: positions.map(([place, a]) => ({ place, label: place, amount: a })), outside: positions.filter(([p]) => p !== "1111").reduce((s, [, a]) => s + a, 0), receivedOn: trail[0]?.date || null, returnedOn: null, owed: amount },
    ...extra,
  });
  const base = () => [
    D("nora", "Nora Wells", 2400, [leg("plaid:jul25", "2025-07-14", "tenant", "2222", 2400), leg(R, "2026-09-14", "2222", "1111", 2400)], [["1111", 2400]]),
    D("noel", "Noel Carter", 1200, [leg("plaid:jun17", "2026-06-17", "tenant", "2222", 1200)], [["2222", 1200]]),
    D("lena", "Lena Ross", 1200, [leg("plaid:jun29", "2026-06-29", "tenant", "2222", 1200)], [["2222", 1200]]),
    // Arrived after the transfer, so it cannot have been hers: still missing.
    D("ola", "Ola Late", 2400, [leg("plaid:oct1", "2026-10-01", "tenant", "2222", 2400)], [["2222", 2400]]),
  ];
  const report = { computedAt: "2026-10-18T12:00:00Z", account: { mask: "1111" }, proof: { balance: 2400, deposits: 2400, other: 0, unlinked: 0, unexplained: 0 }, unlinked: [] };
  const run = (r) => depositSection({ run_at: new Date().toISOString(), report: { ...r, deposit_account: "Security Deposits ••1111" } }, "2026-10-18");

  // No answer yet: a question, and neither reading is stated.
  const q = depositsFromHub({ deposits: base(), report, depositMask: "1111" });
  const qb = Object.fromEntries(q.rows.map((x) => [x.id, x]));
  for (const id of ["nora", "noel", "lena"]) assert.equal(qb[id].location, "ambiguous");
  assert.deepEqual(q.missing.map((x) => x.id), ["ola"]);
  const fits = q.ambiguities.filter((a) => a.kind === "transfer-fits-two");
  assert.equal(fits.length, 1);
  assert.deepEqual(fits[0].options.map((set) => set.map((c) => c.id).sort()), [["nora"], ["lena", "noel"]]);
  const qs = run(q);
  assert.ok(qs.flags.some((f) => f.tag === "deposit-ambiguous" && /Nora Wells's/.test(f.text)));
  assert.ok(!qs.flags.some((f) => f.tag === "deposit-missing" && /Nora|Noel|Lena/.test(f.text)));
  assert.ok(qs.flags.some((f) => f.tag === "deposit-missing" && /Ola Late/.test(f.text)));
  assert.equal(qs.questions.length, 1);
  // The command itself is the installation's (rental-finance.json `deposit_answer_command`).
  assert.match(qs.questions[0].answer_with, / plaid:sep14 --whose /);
  assert.equal(qs.section.in_question.length, 3);

  // The owner's answer, as the deposit-answer command records it.
  const answer = depositAnswer({ rowId: "sep14", deposits: base().map((d) => ({ id: d.id, tenantName: d.tenant, amount: d.amount, status: "paid", whereabouts: d.whereabouts })),
    depositMask: "1111", whose: ["Noel Carter", "lena ross"], unknown: ["Nora Wells"], said: "Note that so this warning isn't repeated.", saidOn: "2026-10-18" });
  assert.equal(answer.row_id, R);
  assert.equal(answer.amount, 2400);
  assert.equal(answer.from, "2222");
  const a = depositsFromHub({ deposits: base(), report, depositMask: "1111", answers: [answer] });
  const ab = Object.fromEntries(a.rows.map((x) => [x.id, x]));
  assert.equal(ab.noel.location, "deposit_account");
  assert.equal(ab.lena.amount_in_deposit_account, 1200);
  assert.equal(ab.nora.location, "unconfirmed");                 // not located, not flagged
  assert.equal(a.ambiguities.filter((x) => x.kind === "transfer-fits-two").length, 0);
  assert.deepEqual(a.missing.map((x) => x.id), ["ola"]);
  const as = run(a);
  assert.ok(!as.flags.some((f) => /Nora|Noel|Lena/.test(f.text)));
  assert.equal(as.questions.length, 0);
  assert.equal(as.section.unconfirmed.length, 1);
  assert.match(as.section.rows.find((x) => x.tenant === "Nora Wells").location, /^not known/);
  assert.match(as.section.rows.find((x) => x.tenant === "Noel Carter").location, /per Alex, 2026-10-18/);

  // Naming only whose it was still makes the third tenant unknown: the row cannot count twice.
  const bare = depositAnswer({ rowId: R, deposits: base().map((d) => ({ id: d.id, tenantName: d.tenant, amount: d.amount, status: "paid", whereabouts: d.whereabouts })),
    depositMask: "1111", whose: ["Noel Carter", "Lena Ross"], said: "x", saidOn: "2026-10-18" });
  assert.deepEqual(bare.unknown.map((x) => x.deposit_id), ["nora"]);
  const hand = depositsFromHub({ deposits: base(), report, depositMask: "1111", answers: [{ ...answer, unknown: [] }] });
  assert.equal(hand.rows.find((x) => x.id === "nora").location, "unconfirmed");
  assert.equal(hand.rows.filter((x) => x.location === "deposit_account").reduce((t, x) => t + x.amount_in_deposit_account, 0), 2400);

  // A newer hub row about that tenant does not undo the answer while the hub still
  // credits them the answered row; once it stops and records something newer, the hub is read again.
  const natLater = base();
  natLater[0].whereabouts.trail.push(leg("plaid:oct17", "2026-10-17", "2222", "1111", 2400));
  assert.equal(depositsFromHub({ deposits: natLater, report, depositMask: "1111", answers: [answer] }).rows.find((x) => x.id === "nora").location, "unconfirmed");
  natLater[0].whereabouts.trail = [leg("plaid:jul25", "2025-07-14", "tenant", "2222", 2400), leg("plaid:nov1", "2026-11-01", "2222", "1111", 2400)];
  const noOla = natLater.filter((d) => d.id !== "ola");          // Ola's $2,400 in ••2222 would make Nov 1 a question of its own
  assert.equal(depositsFromHub({ deposits: noOla, report, depositMask: "1111", answers: [answer] }).rows.find((x) => x.id === "nora").location, "deposit_account");
  assert.equal(depositsFromHub({ deposits: natLater, report, depositMask: "1111", answers: [answer] }).rows.find((x) => x.id === "nora").location, "ambiguous");

  // The answer speaks for whose it was only until the hub records them moving again.
  const later = base();
  later[1].whereabouts.trail.push(leg("plaid:oct5", "2026-10-05", "2222", "3333", 1200));
  later[1].whereabouts.positions = [{ place: "3333", label: "3333", amount: 1200 }];
  const l = depositsFromHub({ deposits: later, report, depositMask: "1111", answers: [answer] });
  assert.equal(l.rows.find((x) => x.id === "noel").location, "operating_account");
  assert.ok(l.missing.some((x) => x.id === "noel"));

  // An answer that does not add up, or names a row nobody linked, is refused.
  const hub = base().map((d) => ({ id: d.id, tenantName: d.tenant, amount: d.amount, status: "paid", whereabouts: d.whereabouts }));
  assert.throws(() => depositAnswer({ rowId: R, deposits: hub, depositMask: "1111", whose: ["Noel Carter"], said: "x", saidOn: "2026-10-18" }), /add up to \$1,200.00; the transfer was \$2,400.00/);
  assert.throws(() => depositAnswer({ rowId: "plaid:none", deposits: hub, depositMask: "1111", whose: ["Lena Ross"], said: "x", saidOn: "2026-10-18" }), /answered in the hub/);
  assert.throws(() => depositAnswer({ rowId: R, deposits: hub, depositMask: "1111", whose: ["Nora Wells"], unknown: ["Nora Wells"], said: "x", saidOn: "2026-10-18" }), /both/);
});

test("Client invoices: voids excluded, split payments found, a later lump never steals an earlier invoice, open after the 6th", () => {
  const I = (number, invoice_date, extra = {}) => ({ number, invoice_date, amount: 9000, voided: false, in_scope: true, ...extra });
  const invoices = [I("162", "2026-07-22"), I("163", "2026-08-22"), I("164", "2026-09-22"), I("159", "2026-06-22", { voided: true }), I("150", "2025-11-22", { in_scope: false })];
  const P = (id, date, amount) => ({ transaction_id: id, date, amount, name: "Clientco" });
  const payments = [P("a", "2026-07-31", 9000), P("b", "2026-08-17", 2755.61), P("other", "2026-08-24", 18000), P("c", "2026-08-31", 6244.39), P("d", "2026-10-02", 9000)];
  const r = reconcileInvoices({ invoices, payments, today: "2026-10-04" });
  const by = Object.fromEntries(r.rows.map((x) => [x.number, x]));
  assert.equal(by["163"].status, "paid");
  assert.deepEqual(r.matches.filter((m) => m.invoice_number === "163").map((m) => m.plaid_transaction_id).sort(), ["b", "c"]);
  assert.equal(by["164"].status, "paid");
  assert.equal(by["159"].status, "void");
  assert.equal(by["150"].status, "out_of_scope");
  assert.deepEqual(r.unmatched.map((u) => u.transaction_id), ["other"]);
  assert.equal(r.proof.ok, true);
  const late = reconcileInvoices({ invoices: [I("164", "2026-09-22")], payments: [], today: "2026-10-10" });
  assert.equal(late.rows[0].status, "late");                   // due Oct 6, +3 grace
  assert.equal(reconcileInvoices({ invoices: [I("164", "2026-09-22")], payments: [], today: "2026-10-08" }).rows[0].status, "open");
});
