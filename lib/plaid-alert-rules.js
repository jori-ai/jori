"use strict";
// plaid-alert-rules.js — the pure half of plaid-sync's alert decisions, split
// out so it can be tested without a bank connection or the database.
//
// Two things live here, both added 2026-09-22 after a week in which about 15 of
// 20 bank alerts in chat were the user's own money moving between their own linked
// accounts — checking-to-savings transfers and a round of card payments, each
// reported TWICE (once as the outflow, once as the matching "Deposit"),
// thirteen of them in a single burst on 09-15.
//
// 1. categoryOf() — plaid-sync judges the RAW Plaid objects that
//    /transactions/sync returns, where the category is nested under
//    personal_finance_category. It was reading `t.category_primary`, a column
//    name that only exists on the rows we write to Supabase, so on every alert
//    the category was undefined: every card payment went out as a "Charge", and
//    the category half of isInflow() never fired. This reads either shape.
//
// 2. findCounterLeg() — a transfer or card payment out of one linked account
//    that lands, to the cent, in another linked account within a few days is
//    the user's money changing pockets, not money leaving. Matched on amounts, dates,
//    account ids, account types and Plaid's structured categories — never the
//    descriptor text. The whole point of these alerts is money leaving to
//    someone else, so every rule below leans toward alerting:
//      - Only two outflow kinds can pair: an account-to-account transfer
//        (TRANSFER_OUT_ACCOUNT_TRANSFER) and a card payment
//        (LOAN_PAYMENTS_CREDIT_CARD_PAYMENT). Wires, Zelle/Venmo-style app
//        transfers and everything else never do — that is how the user pays OTHER
//        people. On 2026-09-22 a replay over two years of rows found three
//        Zelle/Venmo payments to outside parties that a looser first draft
//        paired with a tenant's rent credit of the same amount.
//      - A credit into a checking/savings account only counts if Plaid calls it
//        an account transfer in (TRANSFER_IN_ACCOUNT_TRANSFER) — never income
//        such as rent or payroll, never a wire or a check deposit.
//        A credit into a CARD account may carry any category, because issuers
//        label payment credits LOAN_DISBURSEMENTS, TRANSFER_IN_OTHER, even
//        INCOME_SALARY.
//      - Exception: when both legs' descriptions carry the same bank-stamped
//        "Confirmation# ..." code, that's decisive regardless of category.
//        Added 2026-09-22 after a $20,000 business checking -> personal savings
//        transfer alerted "no matching credit in any of your linked accounts"
//        even though the credit was right there: the outflow posted as
//        TRANSFER_OUT_ACCOUNT_TRANSFER (correct) but the inflow, landing in an
//        account titled differently from the sender (a business account paying
//        a personal one), posted as INCOME_CONTRACTOR — Plaid doesn't reliably
//        mirror the transfer-in label across a name mismatch like that, so the
//        category check alone missed a same-cent, same-day, same-confirmation
//        match. The confirmation code is the bank's own machine-generated
//        transaction ID, not free text the user wrote or a merchant name — reading
//        it is structure, not language (CLAUDE.md's code-owns-geometry rule),
//        so it's used only as a narrow tie-breaker alongside the amount/date/
//        account checks below, never in place of them.
//      - The pairing must be unambiguous both ways: exactly one candidate leg,
//        and that leg has exactly one candidate partner. Two equal payments
//        against one credit, or one payment with two possible credits, alert.

// Outflow categories that can be one of the user's own accounts paying another. The
// primaries are what plaid-sync uses to word an unmatched alert; the detailed
// set is what may actually pair. Together they covered every one of the 272
// pairings a two-year replay found, and nothing else.
const OWN_MOVEMENT_OUT = new Set(["TRANSFER_OUT", "LOAN_PAYMENTS"]);
const PAIRABLE_OUT = new Set(["TRANSFER_OUT_ACCOUNT_TRANSFER", "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT"]);

// Posting dates of the two legs drift apart: a card credit was dated three days
// BEFORE the checking debit that paid it (2026-09-05 vs 09-08). A wider
// gap falls back to alerting.
const LEG_WINDOW_DAYS = 3;

function categoryOf(t) {
  const pfc = (t && t.personal_finance_category) || {};
  return {
    primary: (t && t.category_primary) || pfc.primary || null,
    detailed: (t && t.category_detailed) || pfc.detailed || null,
  };
}

function isAppTransfer(t) {
  return String(categoryOf(t).detailed || "").endsWith("_FROM_APPS");
}

// The bank's own "Confirmation# XXXXXXXX" stamp on a transfer's description —
// a machine-generated transaction id, not language. Reading it is legal under
// the code-owns-geometry rule the same way an HH:MM stamp or a URL is.
// lang-regex-ok: bank-generated confirmation code, not a language decision
const CONFIRMATION_RE = /confirmation\s*#\s*([a-z0-9]+)/i;
function confirmationOf(t) {
  const m = CONFIRMATION_RE.exec(String((t && t.name) || ""));
  return m ? m[1].toLowerCase() : null;
}

function dayNumber(isoDate) {
  const ms = Date.parse(`${String(isoDate).slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) : null;
}

// Are `a` and `b` the two legs of one movement between the user's own accounts?
// `accountTypes` maps account_id -> Plaid account type ("depository", "credit"…).
// An account whose type is unknown is treated as NOT a card, which only ever
// makes a pair harder to form.
function isPair(a, b, accountTypes = {}) {
  if (!a || !b || a.transaction_id === b.transaction_id) return false;
  if (!a.account_id || !b.account_id || a.account_id === b.account_id) return false;
  if (typeof a.amount !== "number" || typeof b.amount !== "number") return false;
  if (Math.abs(a.amount + b.amount) >= 0.005 || a.amount === 0) return false;
  const da = dayNumber(a.date), db = dayNumber(b.date);
  if (da === null || db === null || Math.abs(da - db) > LEG_WINDOW_DAYS) return false;
  const outflow = a.amount > 0 ? a : b;
  const inflow = a.amount > 0 ? b : a;
  if (!PAIRABLE_OUT.has(categoryOf(outflow).detailed)) return false;
  if (isAppTransfer(inflow)) return false;
  if (categoryOf(inflow).detailed === "TRANSFER_IN_ACCOUNT_TRANSFER") return true;
  if (accountTypes[inflow.account_id] === "credit") return true;
  const co = confirmationOf(outflow), ci = confirmationOf(inflow);
  return Boolean(co && ci && co === ci);
}

/**
 * The other leg of a movement between two of the user's linked accounts, or null.
 *
 * `t` is the transaction being judged (either sign). `candidates` is every row
 * that might be involved — this run's new transactions plus stored rows near
 * t's date and amount (either sign, so rival partners are visible). `consumed`
 * holds ids already paired this run. Returns a leg only when the match is
 * one-to-one: t has exactly one possible leg, and that leg has no possible
 * partner other than t.
 */
function findCounterLeg(t, candidates, consumed = new Set(), accountTypes = {}) {
  const pool = [];
  const seen = new Set();
  for (const c of [t, ...(candidates || [])]) {
    if (!c || !c.transaction_id || seen.has(c.transaction_id) || consumed.has(c.transaction_id)) continue;
    seen.add(c.transaction_id);
    pool.push(c);
  }
  const legs = pool.filter((c) => isPair(t, c, accountTypes));
  if (legs.length !== 1) return null;
  const leg = legs[0];
  const rivals = pool.filter((c) => c.transaction_id !== t.transaction_id && isPair(leg, c, accountTypes));
  return rivals.length === 0 ? leg : null;
}

module.exports = { categoryOf, findCounterLeg, isPair, isAppTransfer, LEG_WINDOW_DAYS, OWN_MOVEMENT_OUT, PAIRABLE_OUT };
