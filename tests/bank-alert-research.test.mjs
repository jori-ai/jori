// bank-alert-research.test — the bank-alert judge sees what Jori already knows
// before it decides (the user, 2026-11-04: "we should pass memory and ledger
// data to jev for the decision. many of these transactions are expected and
// should be researched before alerting"). Synthetic data; every source is
// stubbed, so no Supabase, Firestore, Gmail or recall.

import { test } from "node:test";
import assert from "node:assert/strict";
import { researchCandidate, ledgerFacts, booksEntry, amountQuery, emailHits } from "../lib/bank-alert-research.mjs";
import { judgeBankAlerts, judgeState } from "../lib/bank-alert-judge.mjs";

const REF = { transaction_id: "tx1", pending_transaction_id: "ptx1", account_id: "acct-a", account_mask: "1234", amount: 12000, date: "2026-11-02", query: "EXAMPLE CLIENT ACH PMT" };

test("ledger asks for this transaction's rows by id and this account's rows by account", async () => {
  const asked = [];
  const fetchRows = async (p) => {
    asked.push(decodeURIComponent(p));
    if (p.startsWith("/rest/v1/fin_expected_income")) return [{ label: "Client retainer", payer_contains: "example client", amount: "12000.00", cadence: "monthly", note: "x".repeat(900) }];
    if (p.startsWith("/rest/v1/fin_scheduled_payments")) return [{ label: "Card autopay", funding_account_id: "acct-a", target_account_id: "card" }];
    return [];
  };
  const l = await ledgerFacts(REF, { fetchRows });
  assert.equal(l.expected_income_on_this_account[0].label, "Client retainer");
  assert.ok(l.expected_income_on_this_account[0].note.length <= 400);
  assert.equal(l.scheduled_payments_on_this_account[0].this_account_is, "funding");
  assert.equal(l.scheduled_payments_on_this_account[0].funding_account_id, undefined);
  assert.ok(asked.some((p) => p.startsWith("/rest/v1/fin_txn_override") && p.includes('in.("tx1","ptx1")')), asked.join("\n"));
  assert.ok(asked.some((p) => p.startsWith("/rest/v1/fin_expected_income") && p.includes("account_id=eq.acct-a")));
  assert.ok(asked.some((p) => p.startsWith("/rest/v1/fin_deposits") && p.includes("location_account_mask=eq.1234")));
  assert.equal(l.security_deposits_held_in_this_account, null);
});

test("books: the entry is found under the pending id when the posted one is absent", async () => {
  const client = { get: async (col, id) => (id === "plaid:ptx1" ? { classification: { categoryId: "income", propertyId: "house-a", method: "model", reason: "matches known rent" }, receipt: { vendor: "Example", lineItems: [{ description: "Rent" }] } } : null) };
  const b = await booksEntry(REF, { client });
  assert.equal(b.category, "income");
  assert.equal(b.property, "house-a");
  assert.deepEqual(b.receipt, { vendor: "Example", lines: ["Rent"] });
  assert.equal(await booksEntry(REF, { client: null }), undefined); // no books on this install: source absent
});

test("email search looks for this exact amount in both spellings around the date", () => {
  const q = amountQuery(14262.41, "2026-11-02");
  assert.equal(q, '("14,262.41" OR "14262.41") after:2026/10/23 before:2026/11/06');
  assert.equal(amountQuery(500, "2026-11-02").startsWith('("500.00")'), true);
});

test("email hits carry sender, subject and snippet only", async () => {
  const gmail = {
    searchIds: async () => ["m1"],
    getMessage: async () => ({ snippet: "Your payout of 12,000.00 is on its way", payload: { headers: [{ name: "From", value: "Payments <p@example.com>" }, { name: "Subject", value: "Payout sent" }, { name: "Date", value: "Mon, 2 Nov 2026" }] } }),
    header: (m, n) => (m.payload.headers.find((h) => h.name === n) || {}).value || null,
  };
  const e = await emailHits(12000, "2026-11-02", { gmail });
  assert.deepEqual(e, [{ from: "Payments <p@example.com>", subject: "Payout sent", date: "Mon, 2 Nov 2026", snippet: "Your payout of 12,000.00 is on its way" }]);
});

test("a failing or slow source leaves a note, never an exception", async () => {
  const r = await researchCandidate(REF, {
    deadlineMs: 50,
    sources: {
      ledger: async () => ({ recorded_verdict: [] }),
      books: async () => { throw new Error("no key"); },
      memory: () => new Promise(() => {}),
      email: async () => [],
    },
  });
  assert.deepEqual(r.ledger, { recorded_verdict: [] });
  assert.equal(r.memory, null);
  assert.equal(r.books, null);
  assert.ok(r.notes.some((n) => n.startsWith("books unavailable")));
  assert.ok(r.notes.some((n) => n.startsWith("memory unavailable")));
});

test("the judge decides on the research, and never sees the lookup refs", async () => {
  const item = {
    id: "tx1", kind: "transaction", ref: REF,
    account: { name: "Business Checking", mask: "1234" },
    transaction: { date: "2026-11-02", direction: "in", amount_usd: 12000, description: "EXAMPLE CLIENT ACH PMT" },
  };
  const seen = [];
  const r = await judgeBankAlerts([item], [], {
    research: async (ref) => ({ ledger: { expected_income_on_this_account: [{ label: "Client retainer", amount: "12000.00" }] }, memory: [], email: [] }),
    judge: async (state) => { seen.push(state); return { alert: !state.item.research?.ledger?.expected_income_on_this_account?.length }; },
    writer: async () => "unused",
  });
  assert.equal(seen[0].item.ref, undefined);
  assert.equal(seen[0].item.research.ledger.expected_income_on_this_account[0].label, "Client retainer");
  assert.equal(r.message, null); // expected income explains it: no alert
  assert.equal(judgeState(item).item.ref, undefined);
});
