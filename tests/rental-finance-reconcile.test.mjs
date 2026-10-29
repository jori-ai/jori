// rental-finance-reconcile.test.mjs — the rental-finance rules on synthetic
// books: valuation keys and parcels, the cash buckets (brokerage by generic or
// legacy names), security-deposit questions and answers, and client-invoice
// reconciliation. Every config this needs is written to a temp
// JORI_LOCAL_DIR, so the result is the same on any installation.
//
// Run: node --test tests/rental-finance-reconcile.test.mjs

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const prevLocal = process.env.JORI_LOCAL_DIR, prevOwner = process.env.JORI_OWNER_NAME;
const LOCAL = fs.mkdtempSync(path.join(os.tmpdir(), "rental-finance-"));
fs.mkdirSync(path.join(LOCAL, "config"), { recursive: true });
process.env.JORI_LOCAL_DIR = LOCAL;
process.env.JORI_OWNER_NAME = "Sam";
const CFG = path.join(LOCAL, "config", "rental-finance.json");
const setConfig = (v) => (v ? fs.writeFileSync(CFG, JSON.stringify(v)) : fs.rmSync(CFG, { force: true }));
beforeEach(() => setConfig(null));
after(() => {
  fs.rmSync(LOCAL, { recursive: true, force: true });
  if (prevLocal === undefined) delete process.env.JORI_LOCAL_DIR; else process.env.JORI_LOCAL_DIR = prevLocal;
  if (prevOwner === undefined) delete process.env.JORI_OWNER_NAME; else process.env.JORI_OWNER_NAME = prevOwner;
});

const { valueByProperty, buildCashBuckets, attributionFor, bucketOf } = require("../lib/finance-real-estate.js");
const { depositsFromHub, depositSection, depositAnswer } = require("../lib/finance-deposit-reconcile.js");
const { reconcileInvoices, invoiceSection, dueDate } = require("../lib/finance-invoice-reconcile.js");

test("one deed, two properties: parcels mapped in config are priced to their own property; the rest follow the holding", () => {
  setConfig({ property_value_keys: { "maple-house": "maple", "river-e12": "river_12" }, parcel_property: { maple_a: "maple-house", maple_b: "maple-annex" } });
  const rec = [
    { parcel_id: "maple_a", holding: "maple", value: 900000 },
    { parcel_id: "maple_b", holding: "maple", value: 400000 },
    { parcel_id: "river_1", holding: "river_12", value: 80000 },
    { parcel_id: "river_2", holding: "river_12", value: 70000 },
    { parcel_id: "oak_lot", holding: "oak_lane", value: 300000 },
  ];
  const v = valueByProperty(rec, ["maple-house", "maple-annex", "river-e12", "oak-lane"], {});
  assert.equal(v.byProperty["maple-house"], 900000);
  assert.equal(v.byProperty["maple-annex"], 400000);
  assert.equal(v.byProperty["river-e12"], 150000);
  assert.equal(v.byProperty["oak-lane"], 300000);            // hyphens → underscores fallback
  // A caller's config wins over the local file.
  const w = valueByProperty(rec, ["maple-house"], { parcel_property: { maple_a: "elsewhere" } });
  assert.equal(w.byProperty.elsewhere, 900000);
  assert.equal(w.byProperty["maple-house"], undefined);
});

test("a closing total that spans several properties is credited to nobody", () => {
  const v = valueByProperty([{ parcel_id: "holding:pair", holding: "pair", value: 500000 }], ["pair-a", "pair-b"], { property_value_keys: { "pair-a": "pair", "pair-b": "pair" } });
  assert.deepEqual(v.byProperty, {});
  assert.equal(v.unsplit.length, 1);
});

const registry = {
  accounts: [
    { mask: "1111", name: "House A Checking", ownership: [{ propertyId: "old-house", to: "2026-05-30" }, { propertyId: "house-a", from: "2026-05-31" }] },
    { mask: "2222", name: "Deposits", ownership: [{ propertyId: "deposit-pot" }] },
    { mask: "3333", name: "Business", ownership: [{ propertyId: "biz" }] },
  ],
  properties: [
    { id: "house-a", kind: "property" }, { id: "old-house", kind: "property" },
    { id: "deposit-pot", kind: "buffer" }, { id: "biz", kind: "business" },
  ],
};

test("an account belongs to a property on a date", () => {
  assert.equal(attributionFor(registry.accounts, { mask: "1111" }, "2026-05-01").propertyId, "old-house");
  assert.equal(attributionFor(registry.accounts, { mask: "1111" }, "2026-06-01").propertyId, "house-a");
  assert.deepEqual(attributionFor(registry.accounts, { mask: "9999" }, "2026-06-01"), { propertyId: null, mapped: false });
  assert.equal(bucketOf("deposit-pot", true, registry.properties), "deposits");
});

test("cash buckets: deposits are restricted, retirement is not spendable, an unknown account is its own line", () => {
  const plaid = [
    { account_id: "a", mask: "1111", type: "depository", balance_current: 10000, name: "x" },
    { account_id: "d", mask: "2222", type: "depository", balance_current: 4800, name: "y" },
    { account_id: "b", mask: "3333", type: "depository", balance_current: 2000, name: "z" },
    { account_id: "u", mask: "9999", type: "depository", balance_current: 50, name: "Mystery" },
  ];
  const posted = [{ account_id: "a", date: "2026-10-10", amount: 500 }]; // $500 out this week
  const brokerageAccounts = [
    { account_hash: "h1", account_name: "Individual Brokerage", cash_balance: 1000, as_of: "2026-10-12" },
    { account_hash: "h2", account_name: "Roth IRA", cash_balance: 700, as_of: "2026-10-12" },
  ];
  const brokeragePositions = [{ account_hash: "h1", asset_type: "CASH_EQUIVALENT", market_value: 3000 }];
  const c = buildCashBuckets({ plaidAccounts: plaid, registry, brokerageAccounts, brokeragePositions, posted, today: "2026-10-12", config: {} });
  assert.equal(c.buckets.real_estate.total, 10000);
  assert.equal(c.buckets.real_estate.accounts[0].week_ago_balance, 10500);
  assert.equal(c.buckets.business.total, 2000);
  assert.equal(c.buckets.brokerage_taxable.total, 4000);
  assert.match(c.buckets.brokerage_taxable.settlement_note, /T\+1/);
  assert.equal(c.restricted.security_deposits.total, 4800);
  assert.equal(c.not_spendable.retirement_cash, 700);
  assert.equal(c.unmapped.total, 50);
  assert.equal(c.free_cash, 16000);
});

test("cash buckets: an installation's legacy brokerage prefix is read and the bucket is also served under it", () => {
  setConfig({ brokerage_key: "acme" });
  const c = buildCashBuckets({
    plaidAccounts: [], registry,
    acmeAccounts: [{ account_hash: "h1", account_name: "Joint", cash_balance: 250, as_of: "2026-10-12" }],
    acmePositions: [], posted: [], today: "2026-10-12", config: { acme_taxable_accounts: ["joint"] },
  });
  assert.equal(c.buckets.acme_taxable.total, 250);
  assert.equal(c.buckets.acme_taxable, c.buckets.brokerage_taxable);
  // Without config there is no legacy bucket, and no brokerage at all is fine.
  setConfig(null);
  const bare = buildCashBuckets({ plaidAccounts: [], registry, posted: [], today: "2026-10-12", config: {} });
  assert.equal(bare.buckets.brokerage_taxable.total, 0);
  assert.equal(bare.buckets.acme_taxable, undefined);
});

// ── Security deposits ──
const leg = (rowId, date, from, to, amount) => ({ rowId, date, from, to, amount, description: `transfer ${from} -> ${to}` });
const D = (id, tenant, amount, trail, positions) => ({
  id, tenant, amount, lease_number: "L1", property_id: "house-a", property_name: "House A", hub_status: "paid", paid_via: "external", lease_end: null, outside_allowed: null,
  whereabouts: { trail, positions: positions.map(([place, a]) => ({ place, label: place, amount: a })), outside: positions.filter(([p]) => p !== "5555").reduce((s, [, a]) => s + a, 0), receivedOn: trail[0]?.date || null, returnedOn: null, owed: amount },
});
const R = "plaid:t1";
const base = () => [
  D("ann", "Ann Example", 2000, [leg("plaid:p0", "2026-01-10", "tenant", "4444", 2000), leg(R, "2026-03-01", "4444", "5555", 2000)], [["5555", 2000]]),
  D("bob", "Bob Example", 1000, [leg("plaid:p1", "2026-02-01", "tenant", "4444", 1000)], [["4444", 1000]]),
  D("cat", "Cat Example", 1000, [leg("plaid:p2", "2026-02-03", "tenant", "4444", 1000)], [["4444", 1000]]),
];
const report = { computedAt: "2026-03-05T12:00:00Z", account: { mask: "5555" }, proof: { balance: 2000, deposits: 2000, other: 0, unlinked: 0, unexplained: 0 }, unlinked: [] };
const hub = () => base().map((d) => ({ id: d.id, tenantName: d.tenant, amount: d.amount, status: "paid", whereabouts: d.whereabouts }));

test("deposits: a transfer that fits two sets of tenants is a question with the configured answer command", () => {
  setConfig({ deposit_answer_command: "my-facts deposit-answer" });
  const q = depositsFromHub({ deposits: base(), report, depositMask: "5555" });
  for (const r of q.rows) assert.equal(r.location, "ambiguous");
  assert.deepEqual(q.missing, []);
  const sec = depositSection({ run_at: new Date().toISOString(), report: { ...q, deposit_account: "Deposits ••5555" } }, "2026-03-05");
  assert.equal(sec.questions.length, 1);
  assert.ok(sec.questions[0].answer_with.startsWith("my-facts deposit-answer plaid:t1 "));
  // No command configured: a placeholder, never another installation's tool.
  setConfig(null);
  const q2 = depositSection({ run_at: new Date().toISOString(), report: { ...depositsFromHub({ deposits: base(), report, depositMask: "5555" }), deposit_account: "x" } }, "2026-03-05");
  assert.ok(q2.questions[0].answer_with.startsWith("<deposit-answer command> plaid:t1 "));
});

test("deposits: the user's answer settles it, attributed to the user by name", () => {
  const answer = depositAnswer({ rowId: "t1", deposits: hub(), depositMask: "5555", whose: ["Bob Example", "cat example"], said: "those two", saidOn: "2026-03-05" });
  assert.deepEqual(answer.unknown.map((u) => u.deposit_id), ["ann"]);
  const a = depositsFromHub({ deposits: base(), report, depositMask: "5555", answers: [answer] });
  const by = Object.fromEntries(a.rows.map((x) => [x.id, x]));
  assert.equal(by.bob.location, "deposit_account");
  assert.equal(by.ann.location, "unconfirmed");
  assert.match(by.bob.location_basis, /^Sam, 2026-03-05:/);
  const sec = depositSection({ run_at: new Date().toISOString(), report: { ...a, deposit_account: "Deposits ••5555" } }, "2026-03-05");
  assert.match(sec.section.rows.find((x) => x.tenant === "Bob Example").location, /per Sam, 2026-03-05/);
  assert.throws(() => depositAnswer({ rowId: "t1", deposits: hub(), depositMask: "5555", whose: ["Bob Example"], said: "x", saidOn: "2026-03-05" }), /add up to/);
  assert.throws(() => depositAnswer({ rowId: "t1", deposits: hub(), depositMask: "5555", whose: ["Bob Example", "Cat Example"], said: " ", saidOn: "2026-03-05" }), /Sam's own words/);
});

// ── Client invoices ──
test("invoices: a two-part payment settles one invoice, a later lump does not steal it, the rest is unmatched", () => {
  const I = (number, invoice_date, extra = {}) => ({ number, invoice_date, amount: 5000, voided: false, in_scope: true, ...extra });
  const P = (id, date, amount) => ({ transaction_id: id, date, amount, name: "CLIENT ACH" });
  const invoices = [I("1", "2026-04-22"), I("2", "2026-05-22"), I("0", "2026-03-22", { voided: true })];
  const payments = [P("a", "2026-04-30", 5000), P("b", "2026-05-25", 1500), P("other", "2026-05-27", 9000), P("c", "2026-05-31", 3500)];
  const r = reconcileInvoices({ invoices, payments, today: "2026-06-12" });
  const by = Object.fromEntries(r.rows.map((x) => [x.number, x]));
  assert.equal(by["1"].status, "paid");
  assert.equal(by["2"].status, "paid");
  assert.deepEqual(r.matches.filter((m) => m.invoice_number === "2").map((m) => m.plaid_transaction_id).sort(), ["b", "c"]);
  assert.equal(by["0"].status, "void");
  assert.deepEqual(r.unmatched.map((u) => u.transaction_id), ["other"]);
  assert.ok(r.proof.ok);
  assert.equal(dueDate("2026-12-22"), "2027-01-06");
  const late = reconcileInvoices({ invoices: [I("3", "2026-06-22")], payments: [], today: "2026-07-10", dueDay: 6, graceDays: 3 });
  assert.equal(late.rows[0].status, "late");
});

test("invoices: flags name the configured label, else the run's, else a plain one", () => {
  const run = { run_at: "2026-07-10T00:00:00Z", report: { proof: { ok: true, invoiced: 5000, paid: 0, outstanding: 5000 }, rows: [{ number: "3", invoice_date: "2026-06-22", amount: 5000, open_amount: 5000, due_date: "2026-07-06", status: "late" }], ambiguities: [] } };
  assert.match(invoiceSection(run, "2026-07-10").flags[0].text, /^Client invoice 3/);
  setConfig({ invoices: { label: "Acme Consulting" } });
  assert.match(invoiceSection(run, "2026-07-10").flags[0].text, /^Acme Consulting invoice 3/);
  assert.match(invoiceSection({ ...run, report: { ...run.report, label: "Run Label" } }, "2026-07-10").flags[0].text, /^Run Label invoice 3/);
  assert.match(invoiceSection(run, "2026-07-10", (d) => d, "Given").flags[0].text, /^Given invoice 3/);
});
