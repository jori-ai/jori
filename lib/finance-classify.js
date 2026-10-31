"use strict";
// finance-classify — what each bank/card transaction IS, decided by rules that
// can be read, with the rule recorded on every verdict.
//
// WHY. The 2026-10-04 weekly review reported two credit-card payment credits
// as "income 15 and 53 days late", counted a $20,000 transfer between two of
// the user's own accounts as money in AND money out, and folded a $306,495 wire
// into "spending" and "runway". Every one of those came from treating a
// transaction's sign and Plaid's category as its meaning. This module decides
// meaning once, deterministically, and everything downstream (cash flow,
// spending, runway, anomalies, leakage) reads the verdict instead of
// re-guessing.
//
// The rules, in order — the first that matches wins:
//   1. A person's verdict (fin_txn_override) — always.
//   2. A matched pair across two of the user's own accounts: same amount to the cent,
//      opposite signs, within PAIR_DAYS. Into a card → card_payment (both legs).
//      Into a bank account → internal_transfer (both legs). These are facts:
//      two ledger lines that cancel.
//   3. Plaid says CREDIT_CARD_PAYMENT on an unpaired leg → card_payment
//      (the other side is an account Plaid does not see, e.g. a household
//      member's card paid from an unlinked account).
//   4. A credit on a card that is not a payment → refund.
//   5. Interest / fees, by Plaid category.
//   5b. An unpaired credit into the dedicated deposit account → deposit_in.
//   6. An inflow that matches a stream the user registered (fin_expected_income)
//      → income; rental income by Plaid category → income.
//   7. Plaid TRANSFER_IN/TRANSFER_OUT, unpaired → transfer_external (the user's
//      money moving to or from somewhere unlinked: a brokerage, an exchange…).
//      Neither income nor spending.
//   8. Any other inflow → inflow_unexplained. Reported as a count, never as income.
//   9. An outflow ≥ LARGE_OUTFLOW that nobody has classified → unreviewed_large.
//      Shown on its own line and kept OUT of spending, baselines and runway
//      until the user says what it was. Excluding it is not a guess about what it
//      is; including it would be (it would assume it is recurring spend).
//  10. Any other outflow → expense.
//
// Plaid's convention: amount > 0 is money LEAVING the account.

const PAIR_DAYS = 4;
const LARGE_OUTFLOW = 10000;

const dayNum = (d) => Date.parse(`${d}T00:00:00Z`) / 86400000;
const cents = (x) => Math.round(Number(x) * 100);

/**
 * @param {object[]} posted    plaid_transactions rows (posted only)
 * @param {object[]} accounts  plaid_accounts rows
 * @param {object}   opts      { overrides: fin_txn_override rows, expectedIncome: fin_expected_income rows, largeOutflow }
 * @returns {Map<string, {kind:string, rule:string, pair?:string, expected_income_id?:string, note?:string}>}
 */
function classify(posted, accounts, opts = {}) {
  const overrides = new Map((opts.overrides || []).map((o) => [o.transaction_id, o]));
  // Fixed-amount streams match first; a variable-amount stream (amount null)
  // takes whatever from its payer the fixed ones did not claim.
  const expected = [...(opts.expectedIncome || [])].sort((a, b) => (a.amount == null) - (b.amount == null));
  const large = opts.largeOutflow ?? LARGE_OUTFLOW;
  // A dedicated security-deposit account (opts.depositAccountIds) holds tenant
  // money only, so an unpaired credit into it is deposit money by construction
  // (payment-processor payouts of deposits land there under the owner's name).
  const depositAccounts = new Set(opts.depositAccountIds || []);
  const typeOf = new Map((accounts || []).map((a) => [a.account_id, a.type]));
  const out = new Map();

  // 1. overrides
  for (const t of posted) {
    const o = overrides.get(t.transaction_id);
    if (o) out.set(t.transaction_id, { kind: o.kind, rule: "override", note: o.note, property_id: o.property_id || null });
  }

  // 2. pairs. Greedy by closeness in time, each transaction used at most once,
  // and only between two DIFFERENT accounts both of which Plaid syncs.
  const free = (t) => !out.has(t.transaction_id) && typeOf.has(t.account_id);
  const outs = posted.filter((t) => free(t) && Number(t.amount) > 0);
  const ins = posted.filter((t) => free(t) && Number(t.amount) < 0);
  const candidates = [];
  const insByCents = new Map();
  for (const i of ins) {
    const k = -cents(i.amount);
    if (!insByCents.has(k)) insByCents.set(k, []);
    insByCents.get(k).push(i);
  }
  for (const o of outs) {
    for (const i of insByCents.get(cents(o.amount)) || []) {
      if (i.account_id === o.account_id) continue;
      const gap = Math.abs(dayNum(i.date) - dayNum(o.date));
      if (gap <= PAIR_DAYS) candidates.push({ o, i, gap });
    }
  }
  candidates.sort((a, b) => a.gap - b.gap || a.o.transaction_id.localeCompare(b.o.transaction_id));
  const used = new Set();
  for (const { o, i } of candidates) {
    if (used.has(o.transaction_id) || used.has(i.transaction_id)) continue;
    used.add(o.transaction_id); used.add(i.transaction_id);
    const kind = typeOf.get(i.account_id) === "credit" ? "card_payment" : "internal_transfer";
    out.set(o.transaction_id, { kind, rule: "matched_pair", pair: i.transaction_id });
    out.set(i.transaction_id, { kind, rule: "matched_pair", pair: o.transaction_id });
  }

  // 3–10. single legs
  for (const t of posted) {
    if (out.has(t.transaction_id)) continue;
    const amt = Number(t.amount);
    const det = String(t.category_detailed || "");
    const pri = String(t.category_primary || "");
    const isCard = typeOf.get(t.account_id) === "credit";
    const set = (kind, rule, extra = {}) => out.set(t.transaction_id, { kind, rule, ...extra });

    if (det === "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT") { set("card_payment", "plaid_card_payment_unpaired"); continue; }
    if (amt < 0 && isCard) { set("refund", "credit_on_card"); continue; }
    if (det.startsWith("BANK_FEES_INTEREST") || det === "LOAN_PAYMENTS_CREDIT_CARD_INTEREST") { set("interest", "plaid_interest"); continue; }
    if (amt > 0 && pri === "BANK_FEES") { set("fee", "plaid_bank_fee"); continue; }
    if (amt < 0 && depositAccounts.has(t.account_id)) { set("deposit_in", "into_deposit_account"); continue; }
    if (amt < 0) {
      const desc = `${t.merchant_name || ""} ${t.name || ""}`.toLowerCase();
      const hit = expected.find((e) => e.account_id === t.account_id
        && desc.includes(String(e.payer_contains).toLowerCase())
        && (e.amount == null || Math.abs(-amt - Number(e.amount)) <= Number(e.tolerance || 0) + 0.005));
      if (hit) { set("income", "expected_income", { expected_income_id: hit.id }); continue; }
      if (det === "INCOME_RENTAL") { set("income", "plaid_rental_income"); continue; }
      if (det === "INCOME_INTEREST_EARNED") { set("interest_earned", "plaid_interest_earned"); continue; }
      if (pri === "TRANSFER_IN") { set("transfer_external", "plaid_transfer_in_unpaired"); continue; }
      set("inflow_unexplained", "no_rule"); continue;
    }
    if (pri === "TRANSFER_OUT") { set("transfer_external", "plaid_transfer_out_unpaired"); continue; }
    if (amt >= large) { set("unreviewed_large", `outflow_over_${large}`); continue; }
    set("expense", "default_outflow");
  }
  return out;
}

/** Kinds that are real spending (money gone to someone else for goods/services/taxes). */
const SPEND_KINDS = new Set(["expense", "fee", "interest", "tax"]);

module.exports = { classify, SPEND_KINDS, LARGE_OUTFLOW, PAIR_DAYS };
