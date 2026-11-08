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
//   1b. A record somebody keeps says what the money was (opts.bookVerdicts,
//      keyed by transaction_id). Today: the rental books, which know every
//      credit that is a payout the rental hub sent — a named tenant's rent
//      (income) or their security deposit (deposit_in); the caller builds it
//      with rental-ledger.js payoutsForBankRows. Before pairing, so a payout
//      is never taken for one leg of a move between the user's own accounts.
//      A rent verdict still carries the registered stream it matches (rule 6's
//      test), so a stream the user registered for that rent sees it arrive.
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
//   8b. After a record that explains it (rule 9), a tax payment → tax, never asked about: Plaid's tax-payment category, or a
//      bill line naming a county tax collector / treasurer / property tax (TAX_PAYEE_PHRASES
//      plus opts.taxPayeePhrases). It carries the property it was paid for when
//      opts.taxProperties ({contains, property_id, from?, to?}) names one.
//   9. An outflow ≥ LARGE_OUTFLOW that a record already explains (opts.known:
//      a bill the recurring tracker follows) → that record's kind: a bill the tracker
//      expected is not a question.
//      Otherwise, an outflow ≥ LARGE_OUTFLOW that nobody has classified → unreviewed_large.
//      Shown on its own line and kept OUT of spending, baselines and runway
//      until the user says what it was. Excluding it is not a guess about what it
//      is; including it would be (it would assume it is recurring spend).
//  10. Any other outflow → expense.
//  11. What the rules above leave as a question (an unexplained inflow, an
//      unreviewed large outflow, a bank debit paired with a card credit by
//      coincidence of amount, which the bank itself does not call a card
//      payment) takes the books' answer when they have one (opts.bookCategories: the bank
//      rows whose category in the rental books a person set or confirmed, or
//      the books' own rule or earlier decision settled; rental-ledger.js
//      answeredCategoriesForBankRows). Only those rows: a verdict the rules
//      reached stays, so this answers questions, it never re-reads spending.
//      The books' guesses (their model's category) are not answers and are
//      never read. What a category makes a transaction: bookCategoryKind.
//
// Plaid's convention: amount > 0 is money LEAVING the account.

// A transfer pulled by one bank from another can post on the far side days later.
const PAIR_DAYS = 7;
const LARGE_OUTFLOW = 10000;

// Text a bank line carries when the payee is a tax authority. Matched as plain
// substrings of the lower-cased merchant + name, with `*` and `#` read as spaces
// ("PMT*SAMPLE CTY TCSAMPLE" → "pmt sample cty tcsample").
const TAX_PAYEE_PHRASES = ["cty tc", "county tc", "tax collector", "treasurer", "property tax", "real estate tax", "real property tax"];
const TAX_PAYMENT_CATEGORY = "GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT";

const dayNum = (d) => Date.parse(`${d}T00:00:00Z`) / 86400000;
// Bank-line text, flattened: lower case, `*`/`#` as spaces, runs of spaces as one.
const lineText = (t) => [...`${t.merchant_name || ""} ${t.name || ""}`.toLowerCase()]
  .map((c) => (c === "*" || c === "#" ? " " : c)).join("").split(" ").filter(Boolean).join(" ");
const cents = (x) => Math.round(Number(x) * 100);

/**
 * @param {object[]} posted    plaid_transactions rows (posted only)
 * @param {object[]} accounts  plaid_accounts rows
 * @param {object}   opts      { overrides: fin_txn_override rows, expectedIncome: fin_expected_income rows,
 *                               bookVerdicts: Map<transaction_id, {kind, rule, ...}> from kept records,
 *                               bookCategories: Map<transaction_id, answer> (rule 11), bookCategoryKinds, largeOutflow }
 * @returns {Map<string, {kind:string, rule:string, pair?:string, expected_income_id?:string, note?:string}>}
 */
function classify(posted, accounts, opts = {}) {
  const overrides = new Map((opts.overrides || []).map((o) => [o.transaction_id, o]));
  // Fixed-amount streams match first; a variable-amount stream (amount null)
  // takes whatever from its payer the fixed ones did not claim.
  const expected = [...(opts.expectedIncome || [])].sort((a, b) => (a.amount == null) - (b.amount == null));
  const large = opts.largeOutflow ?? LARGE_OUTFLOW;
  // transaction_id → {kind, rule, note}: large outflows a kept record explains (rule 9).
  const taxPhrases = [...TAX_PAYEE_PHRASES, ...(opts.taxPayeePhrases || [])].map((p) => String(p).toLowerCase()).filter(Boolean);
  const taxProperties = opts.taxProperties || [];
  const known = opts.known instanceof Map ? opts.known : new Map();
  // What marks an outgoing transfer as going to one of the user's own accounts:
  // the bank's own-account transfer lines, the user's linked institutions, and
  // the installation's own list (account map `own_transfer_phrases`).
  const ownPhrases = [...OWN_TRANSFER_PHRASES, ...(opts.ownInstitutions || []), ...(opts.ownTransferPhrases || [])]
    .map((x) => String(x || "").toLowerCase().trim()).filter((x) => x.length >= 4);
  // A dedicated security-deposit account (opts.depositAccountIds) holds tenant
  // money only, so an unpaired credit into it is deposit money by construction
  // (payment-processor payouts of deposits land there under the owner's name).
  const depositAccounts = new Set(opts.depositAccountIds || []);
  const typeOf = new Map((accounts || []).map((a) => [a.account_id, a.type]));
  const books = opts.bookVerdicts instanceof Map ? opts.bookVerdicts : new Map();
  // The registered stream an inflow belongs to: same account, its payer text
  // on the bank line, and its amount (a stream with no amount takes any).
  const streamFor = (t) => {
    const desc = `${t.merchant_name || ""} ${t.name || ""}`.toLowerCase();
    return expected.find((e) => e.account_id === t.account_id
      && desc.includes(String(e.payer_contains).toLowerCase())
      && (e.amount == null || Math.abs(-Number(t.amount) - Number(e.amount)) <= Number(e.tolerance || 0) + 0.005)) || null;
  };
  const out = new Map();

  // 1. overrides
  for (const t of posted) {
    const o = overrides.get(t.transaction_id);
    if (o) out.set(t.transaction_id, { kind: o.kind, rule: "override", note: o.note, property_id: o.property_id || null });
  }

  // 1b. kept records
  for (const t of posted) {
    if (out.has(t.transaction_id)) continue;
    const v = books.get(t.transaction_id);
    if (!v || !v.kind) continue;
    const s = v.kind === "income" && Number(t.amount) < 0 ? streamFor(t) : null;
    out.set(t.transaction_id, { ...v, rule: v.rule || "kept_record", kept_record: true, ...(s ? { expected_income_id: s.id } : {}) });
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

  // 2c. a split pair: one outflow equal to the sum of 2–4 inflows from the same
  // payer landing in the user's OTHER synced accounts within PAIR_DAYS — payroll
  // a payroll processor debits as one net amount and pays out per person
  // (the user, 2026-10-17: "paychecks are not rental income. they are accounted
  // for in the Business account"). Same-payer and exact-cent are both required.
  const payerOf = (t) => String(t.name || "").toLowerCase().replace(/^ach credit\s+/, "").replace(/[^a-z ]+/g, " ").trim().split(/\s+/).slice(0, 2).join(" ");
  const freeIns = posted.filter((t) => free(t) && Number(t.amount) < 0);
  for (const o of posted.filter((t) => free(t) && Number(t.amount) > 0)) {
    const target = cents(o.amount);
    const cands = freeIns.filter((i) => !out.has(i.transaction_id) && i.account_id !== o.account_id && Math.abs(dayNum(i.date) - dayNum(o.date)) <= PAIR_DAYS);
    const byPayer = new Map();
    for (const i of cands) { const k = payerOf(i); if (!k) continue; if (!byPayer.has(k)) byPayer.set(k, []); byPayer.get(k).push(i); }
    let hit = null;
    for (const group of byPayer.values()) {
      if (group.length < 2 || group.length > 8) continue;
      for (let m = 3; m < (1 << group.length) && !hit; m++) {
        const set = group.filter((_, j) => m & (1 << j));
        if (set.length < 2 || set.length > 4) continue;
        if (set.reduce((t, i) => t - cents(i.amount), 0) === target) hit = set;
      }
      if (hit) break;
    }
    if (!hit) continue;
    out.set(o.transaction_id, { kind: "internal_transfer", rule: "split_pair", pair: hit.map((i) => i.transaction_id).join(",") });
    for (const i of hit) out.set(i.transaction_id, { kind: "internal_transfer", rule: "split_pair", pair: o.transaction_id });
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
      const hit = streamFor(t);
      if (hit) { set("income", "expected_income", { expected_income_id: hit.id }); continue; }
      if (det === "INCOME_RENTAL") { set("income", "plaid_rental_income"); continue; }
      if (det === "INCOME_INTEREST_EARNED") { set("interest_earned", "plaid_interest_earned"); continue; }
      if (pri === "TRANSFER_IN") { set("transfer_external", "plaid_transfer_in_unpaired"); continue; }
      set("inflow_unexplained", "no_rule"); continue;
    }
    // An unpaired outflow Plaid calls a transfer is only "your money moving" when
    // it goes to an account of the user's own: Zelle to a contractor, payroll,
    // Venmo to a person are payments, i.e. spending (the user, 2026-11-08: count
    // payments to other people as spending). Out of the deposit account it is a
    // tenant's deposit going back; a withdrawal at a counter or ATM is cash.
    if (amt > 0 && depositAccounts.has(t.account_id)) { set("deposit_refund", "out_of_deposit_account"); continue; }
    if (pri === "TRANSFER_OUT") {
      const desc = `${t.merchant_name || ""} ${t.name || ""}`.toLowerCase();
      if (CASH_RE.test(desc)) { set("cash_withdrawal", "cash_withdrawal"); continue; }
      if (ownPhrases.some((ph) => desc.includes(ph))) { set("transfer_external", "plaid_transfer_out_own"); continue; }
      set("expense", "payment_to_other"); continue;
    }
    // A record that already explains a large outflow speaks first (rule 9)
    const k = amt >= large ? known.get(t.transaction_id) : null;
    if (k) { set(k.kind, k.rule, { note: k.note }); continue; }
    if (det === TAX_PAYMENT_CATEGORY || taxPhrases.some((p) => lineText(t).includes(p))) {
      const text = lineText(t);
      const prop = taxProperties.find((r) => r.contains && text.includes(String(r.contains).toLowerCase())
        && (!r.from || t.date >= r.from) && (!r.to || t.date <= r.to));
      set("tax", det === TAX_PAYMENT_CATEGORY ? "plaid_tax_payment" : "tax_payee", prop ? { property_id: prop.property_id } : {});
      continue;
    }
    if (amt >= large) { set("unreviewed_large", `outflow_over_${large}`); continue; }
    set("expense", "default_outflow");
  }

  // 11. the books' answer, for the rows the rules leave as a question
  const answers = opts.bookCategories instanceof Map ? opts.bookCategories : new Map();
  const byId = new Map(posted.map((x) => [x.transaction_id, x]));
  for (const t of posted) {
    const v = out.get(t.transaction_id);
    const a = answers.get(t.transaction_id);
    if (!v || !a || v.rule === "override") continue;
    // A bank debit read as a card payment only because a same-cents credit
    // happened to pair with it: never one the bank itself calls a card payment
    // (that card's purchases are already spending; re-reading it would count
    // them twice).
    const debitTakenForCardPayment = v.kind === "card_payment" && v.rule === "matched_pair" && Number(t.amount) > 0
      && typeOf.get(t.account_id) === "depository" && !CARD_PAYMENT_CATEGORY.has(t.category_detailed) && !CARD_PAYMENT_CATEGORY.has(byId.get(v.pair)?.category_detailed);
    if (!QUESTION_KINDS.has(v.kind) && !debitTakenForCardPayment) continue;
    const kind = bookCategoryKind(a, Number(t.amount) < 0, opts.bookCategoryKinds);
    if (!kind) continue;
    out.set(t.transaction_id, {
      kind, rule: "books_category", replaces: v.rule, book_basis: a.basis,
      categories: (a.categories || []).map((c) => c.id), ...(a.property_id ? { property_id: a.property_id } : {}),
    });
  }
  return out;
}

/** Verdicts that leave the review asking the user what a transaction was. */
const QUESTION_KINDS = new Set(["inflow_unexplained", "unreviewed_large"]);
const CARD_PAYMENT_CATEGORY = new Set(["LOAN_PAYMENTS_CREDIT_CARD_PAYMENT", "TRANSFER_OUT_ACCOUNT_TRANSFER_CREDIT_CARD", "TRANSFER_IN_CREDIT_CARD_PAYMENT"]);

// What a category in the books makes a transaction, by direction. Most follow
// the category's own kind; these mean something narrower. An installation can
// override or add entries (`{categoryId: {in, out}}`, a missing or null side =
// the category answers nothing that way and the question stays).
const BOOK_CATEGORY_KINDS = {
  taxes: { out: "tax" },
  "occupancy-tax": { out: "tax" },
  "bank-fees": { in: "refund", out: "fee" },
  "income-interest": { in: "interest_earned" },
  "security-deposit": { in: "deposit_in" },
  // The owner's own money moving into or out of the books, from or to an
  // account the bank feed does not see.
  "owner-draw": { in: "transfer_external", out: "transfer_external" },
  "capital-contribution": { in: "transfer_external", out: "transfer_external" },
};
const BY_CATEGORY_KIND = { income: { in: "income" }, expense: { in: "refund", out: "expense" }, capital: { out: "capital" } };

/**
 * The verdict a books answer gives one transaction, or null when it gives none.
 * A split row answers only when every part says the same.
 *
 * @param {{categories: {id:string, kind:string}[]}} answer  from answeredCategoriesForBankRows
 * @param {boolean} inflow  money in (Plaid amount < 0)
 * @param {object}  [kinds] installation overrides, as BOOK_CATEGORY_KINDS
 */
function bookCategoryKind(answer, inflow, kinds = {}) {
  const dir = inflow ? "in" : "out";
  const table = { ...BOOK_CATEGORY_KINDS, ...(kinds || {}) };
  const picks = (answer?.categories || []).map((c) => {
    const k = Object.prototype.hasOwnProperty.call(table, c.id) ? table[c.id]?.[dir] : BY_CATEGORY_KIND[c.kind]?.[dir];
    return k || null;
  });
  return picks.length && picks.every((k) => k && k === picks[0]) ? picks[0] : null;
}

/**
 * Registered income streams that only ever see money the books already name
 * (each arrival in the window a kept-record verdict: a hub payout). Such a
 * stream adds nothing — the books say whose money it was, and whether a
 * tenant's rent is missing is the hub's rent invoices' answer — so a reader
 * neither lists it nor calls it late.
 */
function streamsCoveredByBooks(verdicts) {
  const all = new Map();
  for (const v of verdicts.values()) {
    if (!v.expected_income_id) continue;
    all.set(v.expected_income_id, (all.get(v.expected_income_id) ?? true) && v.kept_record === true);
  }
  return new Set([...all].filter(([, covered]) => covered).map(([id]) => id));
}

/** Kinds that are real spending (money gone to someone else for goods/services/taxes). */
const SPEND_KINDS = new Set(["expense", "fee", "interest", "tax", "cash_withdrawal"]);
// Bank-generated descriptor text for a transfer to an account of the holder's own.
const OWN_TRANSFER_PHRASES = ["online banking transfer to", "transfer to chk", "transfer to sav", "apple cash", "moneylink", "brokerage"];
const CASH_RE = /\bwithdrwl\b|\batm\b|cash withdrawal/; // lang-regex-ok: bank-generated withdrawal descriptor

module.exports = { classify, bookCategoryKind, streamsCoveredByBooks, TAX_PAYEE_PHRASES, SPEND_KINDS, QUESTION_KINDS, LARGE_OUTFLOW, PAIR_DAYS };
