// plaid-alert-rules.test — pins the 2026-09-22 bank-alert fixes.
//
// In the week to 09-22 about 15 of 20 bank alerts in chat were the user's own
// money moving between their own linked accounts: each checking-to-checking
// transfer and each card payment was reported twice (the outflow AND the
// matching "Deposit"), and every merchant-less outflow was called a "first
// charge from this merchant". Separately, buildAlerts read `category_primary`
// off raw Plaid objects, which nest it under personal_finance_category, so a
// card payment could never be called anything but a "Charge".
//
// Fixtures are synthetic but shaped like the real rows (raw Plaid objects,
// the categories each issuer actually uses). No bank data, no network: the
// Supabase key is removed, so the stored-row lookup throws and buildAlerts
// judges on this run's transactions only — the same fail-toward-alerting path
// production takes when that lookup errors.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { categoryOf, findCounterLeg } = require("../lib/plaid-alert-rules.js");
const TYPES = { chk: "depository", sav: "depository", card: "credit", card2: "credit" };
let buildAlerts, isInflow;

before(() => {
  ({ buildAlerts, isInflow } = require("../bin/plaid-sync"));
  // AFTER the require: loading plaid-sync re-reads .env, and a key left
  // in place would make these tests query the live table.
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_ANON_KEY;
});

const raw = (id, account_id, amount, date, primary, detailed, extra = {}) => ({
  transaction_id: id, account_id, amount, date, pending: false,
  name: extra.name || "ONLINE TRANSFER", merchant_name: extra.merchant_name || null,
  personal_finance_category: { primary, detailed },
});

// Checking -> savings, both at the same bank, same day.
const XFER_OUT = raw("t-out", "chk", 5000, "2026-09-14", "TRANSFER_OUT", "TRANSFER_OUT_ACCOUNT_TRANSFER");
const XFER_IN = raw("t-in", "sav", -5000, "2026-09-14", "TRANSFER_IN", "TRANSFER_IN_ACCOUNT_TRANSFER");
// Checking pays a card; the card issuer labels its side LOAN_DISBURSEMENTS and
// dates it a day earlier — both observed on 2026-09-14/15.
const CARD_PAY = raw("c-out", "chk", 2750.5, "2026-09-15", "LOAN_PAYMENTS", "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT", { name: "CARD ISSUER DES:CRCARDPMT" });
const CARD_CREDIT = raw("c-in", "card", -2750.5, "2026-09-14", "LOAN_DISBURSEMENTS", "LOAN_DISBURSEMENTS_OTHER_DISBURSEMENT", { name: "PAYMENT THANK YOU" });

test("categoryOf reads the raw Plaid shape and the stored-row shape", () => {
  assert.equal(categoryOf(XFER_OUT).primary, "TRANSFER_OUT");
  assert.equal(categoryOf({ category_primary: "LOAN_PAYMENTS", category_detailed: "X" }).primary, "LOAN_PAYMENTS");
  assert.equal(categoryOf({}).primary, null);
});

test("isInflow now sees the category on a raw object", () => {
  assert.equal(isInflow(raw("p", "a", 1200, "2026-09-14", "TRANSFER_IN", "TRANSFER_IN_OTHER")), true);
});

test("a transfer between two of the user's accounts matches its other leg, both ways round", () => {
  assert.equal(findCounterLeg(XFER_OUT, [XFER_IN], new Set(), TYPES)?.transaction_id, "t-in");
  assert.equal(findCounterLeg(XFER_IN, [XFER_OUT], new Set(), TYPES)?.transaction_id, "t-out");
  assert.equal(findCounterLeg(CARD_PAY, [CARD_CREDIT], new Set(), TYPES)?.transaction_id, "c-in");
});

// The critic's replay over two years of rows found three of these: a Zelle or
// Venmo payment to an outside party, the same amount as a tenant's rent credit
// landing in another account within days. Both must still alert.
test("a Zelle payment to someone else never pairs with a rent credit", () => {
  const zelle = raw("z", "chk", 1850, "2026-06-02", "TRANSFER_OUT", "TRANSFER_OUT_FROM_APPS", { name: "Zelle payment to SERVICE CO" });
  const rent = raw("r", "sav", -1850, "2026-06-01", "INCOME", "INCOME_RENTAL", { name: "RENT COLLECTION" });
  assert.equal(findCounterLeg(zelle, [rent], new Set(), TYPES), null);
  assert.equal(findCounterLeg(rent, [zelle], new Set(), TYPES), null);
});

test("app transfers never pair, even against a transfer-in", () => {
  const zelle = raw("z2", "chk", 700, "2026-06-02", "TRANSFER_OUT", "TRANSFER_OUT_FROM_APPS");
  const xin = raw("x2", "sav", -700, "2026-06-02", "TRANSFER_IN", "TRANSFER_IN_ACCOUNT_TRANSFER");
  assert.equal(findCounterLeg(zelle, [xin], new Set(), TYPES), null);
});

test("a checking credit only counts if it is a transfer in; a card credit may carry any label", () => {
  const payroll = raw("p1", "sav", -5000, "2026-09-14", "INCOME", "INCOME_SALARY");
  assert.equal(findCounterLeg(XFER_OUT, [payroll], new Set(), TYPES), null);
  const mislabelled = { ...CARD_CREDIT, transaction_id: "c-in-2", personal_finance_category: { primary: "INCOME", detailed: "INCOME_SALARY" } };
  assert.equal(findCounterLeg(CARD_PAY, [mislabelled], new Set(), TYPES)?.transaction_id, "c-in-2");
  // Same credit, account type unknown: read as NOT a card, so no pair.
  assert.equal(findCounterLeg(CARD_PAY, [mislabelled], new Set(), {}), null);
});

// 2026-09-22 incident: a $20,000 business checking -> personal savings transfer
// alerted "no matching credit in any of your linked accounts" even though the
// credit was there. The outflow posted TRANSFER_OUT_ACCOUNT_TRANSFER; the
// inflow, into a differently-titled account, posted INCOME_CONTRACTOR instead
// of TRANSFER_IN_ACCOUNT_TRANSFER. Both legs carried the same bank-stamped
// "Confirmation# ...", which is the tie-breaker that should catch this.
test("a mislabeled inflow still pairs when both legs share a bank confirmation code", () => {
  const out = raw("business-out", "business-chk", 20000, "2026-09-21", "TRANSFER_OUT", "TRANSFER_OUT_ACCOUNT_TRANSFER",
    { name: "Online transfer to CHK 1111 Confirmation# abcd1234x; Owner" });
  const inflow = raw("savings-in", "sav", -20000, "2026-09-21", "INCOME", "INCOME_CONTRACTOR",
    { name: "Online transfer from CHK 2222 Confirmation# abcd1234x; EXAMPLE LLC" });
  assert.equal(findCounterLeg(out, [inflow], new Set(), TYPES)?.transaction_id, "savings-in");
  assert.equal(findCounterLeg(inflow, [out], new Set(), TYPES)?.transaction_id, "business-out");
});

// The confirmation code is a narrow tie-breaker, not a bypass: mismatched (or
// absent) codes must still fall through to the existing category protections.
test("a payroll credit with no matching confirmation code still does not pair", () => {
  const payrollNoCode = raw("p2", "sav", -5000, "2026-09-14", "INCOME", "INCOME_SALARY", { name: "PAYROLL DIRECT DEP" });
  assert.equal(findCounterLeg(XFER_OUT, [payrollNoCode], new Set(), TYPES), null);
  const differentCode = raw("p3", "sav", -5000, "2026-09-14", "INCOME", "INCOME_CONTRACTOR", { name: "Payment Confirmation# zzz999" });
  const outWithCode = { ...XFER_OUT, name: "Online transfer Confirmation# aaa111" };
  assert.equal(findCounterLeg(outWithCode, [differentCode], new Set(), TYPES), null);
});

test("an ambiguous match alerts: two possible legs, or a leg with a rival partner", () => {
  const secondCredit = { ...CARD_CREDIT, transaction_id: "c-in-b", account_id: "card2" };
  assert.equal(findCounterLeg(CARD_PAY, [CARD_CREDIT, secondCredit], new Set(), TYPES), null);
  const rivalPayment = { ...CARD_PAY, transaction_id: "c-out-b", date: "2026-09-13" };
  assert.equal(findCounterLeg(CARD_PAY, [CARD_CREDIT, rivalPayment], new Set(), TYPES), null);
});

test("near misses do not match", () => {
  const offByCent = { ...XFER_IN, transaction_id: "x1", amount: -4999.99 };
  const sameAccount = { ...XFER_IN, transaction_id: "x2", account_id: "chk" };
  const tooLate = { ...XFER_IN, transaction_id: "x3", date: "2026-09-18" };
  assert.equal(findCounterLeg(XFER_OUT, [offByCent, sameAccount, tooLate], new Set(), TYPES), null);
});

test("a merchant charge never matches, however coincidental the amount", () => {
  const charge = raw("m", "chk", 5000, "2026-09-14", "GENERAL_SERVICES", "GENERAL_SERVICES_OTHER", { merchant_name: "Architect" });
  assert.equal(findCounterLeg(charge, [XFER_IN], new Set(), TYPES), null);
});

test("one credit cannot vouch for two equal payments", () => {
  const second = { ...XFER_OUT, transaction_id: "t-out-2" };
  const consumed = new Set();
  const leg = findCounterLeg(XFER_OUT, [XFER_IN], consumed, TYPES);
  consumed.add(XFER_OUT.transaction_id); consumed.add(leg.transaction_id);
  assert.equal(findCounterLeg(second, [XFER_IN], consumed, TYPES), null);
});

test("an internal transfer in one run produces no alert on either side", async () => {
  const run = [XFER_OUT, XFER_IN];
  const alerts = await buildAlerts("Bank", run, [], run, new Set(), TYPES);
  assert.deepEqual(alerts, []);
});

test("a card payment matched across two Items is silent on both, whichever syncs first", async () => {
  const run = [CARD_PAY, CARD_CREDIT];
  const cardFirst = new Set();
  assert.deepEqual(await buildAlerts("Card", [CARD_CREDIT], [], run, cardFirst, TYPES), []);
  assert.deepEqual(await buildAlerts("Bank", [CARD_PAY], [], run, cardFirst, TYPES), []);
  const bankFirst = new Set();
  assert.deepEqual(await buildAlerts("Bank", [CARD_PAY], [], run, bankFirst, TYPES), []);
  assert.deepEqual(await buildAlerts("Card", [CARD_CREDIT], [], run, bankFirst, TYPES), []);
});

test("a wire out never pairs, even with a same-amount credit elsewhere", () => {
  const wireOut = raw("wo", "chk", 12000, "2026-09-08", "TRANSFER_OUT", "TRANSFER_OUT_WIRE");
  const deposit = raw("wi", "sav", -12000, "2026-09-09", "TRANSFER_IN", "TRANSFER_IN_DEPOSIT");
  const acctXfer = raw("wa", "sav", -12000, "2026-09-09", "TRANSFER_IN", "TRANSFER_IN_ACCOUNT_TRANSFER");
  assert.equal(findCounterLeg(wireOut, [deposit], new Set(), TYPES), null);
  assert.equal(findCounterLeg(wireOut, [acctXfer], new Set(), TYPES), null);
});

test("a card payment to an issuer that is not linked still alerts, and says what is true", async () => {
  const [line] = await buildAlerts("Bank", [CARD_PAY], [], [CARD_PAY], new Set(), TYPES);
  assert.ok(line.startsWith("Bank: Card payment:"), line);
  assert.ok(line.includes("no matching credit in any of your linked accounts"), line);
  assert.ok(!line.includes("first charge"), line);
});

test("an external transfer with no matching leg still alerts", async () => {
  const wire = raw("w", "chk", 9000, "2026-09-08", "TRANSFER_OUT", "TRANSFER_OUT_ACCOUNT_TRANSFER", { name: "WIRE OUT" });
  const alerts = await buildAlerts("Bank", [wire], [], [wire], new Set(), TYPES);
  assert.equal(alerts.length, 1);
  assert.ok(alerts[0].includes("Transfer out:"), alerts[0]);
});

test("an ordinary deposit with no matching debit still alerts", async () => {
  const pay = raw("d", "chk", -3000, "2026-09-09", "INCOME", "INCOME_SALARY", { name: "PAYROLL" });
  const alerts = await buildAlerts("Bank", [pay], [], [pay], new Set(), TYPES);
  assert.equal(alerts.length, 1);
  assert.ok(alerts[0].includes("Deposit:"), alerts[0]);
});

test("through buildAlerts, a Zelle payment and a same-amount rent credit both still alert", async () => {
  const zelle = raw("z3", "chk", 2400, "2026-04-02", "TRANSFER_OUT", "TRANSFER_OUT_FROM_APPS", { name: "Zelle payment to VENDOR" });
  const rent = raw("r3", "sav", -2400, "2026-04-01", "INCOME", "INCOME_RENTAL", { name: "RENT COLLECTION" });
  const run = [zelle, rent];
  const alerts = await buildAlerts("Bank", run, [], run, new Set(), TYPES);
  assert.equal(alerts.length, 2, alerts.join(" | "));
});
