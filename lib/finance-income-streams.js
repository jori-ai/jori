"use strict";
// finance-income-streams — which repeating inflows in bank history are regular
// enough to call an "income stream" at all. Used by bin/finance-model.
//
// WHY THIS IS STRICT (2026-10-06, Self Improvement Review item 15). The hum
// finance lane paged "$1,516 monthly deposit … usually by the 8th … 15d late"
// about a stream that never existed: the user had no such deposit. The input
// was a household member's card autopay — scattered amounts on scattered
// dates — and the old inference let it through three ways:
//   1. "inflow" was `amount < 0 || category in {INCOME, TRANSFER_IN}`, so a
//      DEBIT (positive Plaid amount) carrying a TRANSFER_IN label counted as
//      money in, and a card account's payment credit counted as income;
//   2. two occurrences were enough, and cadence was the MEDIAN gap only — gaps
//      of 18, 41 and 27 days have a median of 27, which reads "monthly";
//   3. amounts were never compared, so $842 / $2,300 / $1,516 became one
//      "$1,516 deposit" (the median).
// The late-income ALERT stopped reading this inference on 2026-10-04 (it now
// fires only for streams the user registered in fin_expected_income — see
// lib/finance-expected.js), but finance-model.json still publishes
// `income_streams`, and anything that reads it later deserves a list that
// means what it says. So the bar is: credits only, on a cash account, at least
// MIN_OCCURRENCES times, at a consistent cadence and a consistent amount.
// Precision over recall — a real stream that misses the bar is invisible here
// and should be registered as a fact instead; a fake one costs credibility.
//
// Bank rows stay on the host with Jori's own code. No model is involved.

const DAY = 86400000;
const toDate = (s) => new Date(`${s}T00:00:00Z`);
const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / DAY);
const addDays = (s, n) => new Date(toDate(s).getTime() + n * DAY).toISOString().slice(0, 10);
const round2 = (n) => (n == null ? null : Math.round(Number(n) * 100) / 100);

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Normalize a merchant label so "UBER *EATS 8f2", "UBER* EATS" collapse
// together. Bank-issued strings, not anything the user wrote.
function normMerchant(t) {
  const raw = (t.merchant_name || t.name || "unknown").toLowerCase();
  return raw
    .replace(/\b(x{2,}\d+|\d{3,})\b/g, "") // long digit runs / masked ids
    .replace(/[*#]+/g, " ")
    .replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, "") // embedded dates
    .replace(/\s+/g, " ")
    .trim();
}

const RULES = Object.freeze({
  INCOME_FLOOR: 50,          // ignore trivial inflows ("interest earned $0.05")
  MIN_OCCURRENCES: 3,        // two points are a coincidence, not a cadence
  WINDOW: 6,                 // judge the most recent N occurrences (a raise resets the series)
  AMOUNT_TOLERANCE: 0.20,    // every amount within ±20% of the window's median
  CADENCES: [
    // max_dev: the furthest any single gap may sit from the median gap. Monthly
    // allows 6 days: month length (28–31) plus a weekend/holiday posting shift.
    { cadence: "monthly", min: 26, max: 35, max_dev: 6 },
    { cadence: "biweekly", min: 12, max: 16, max_dev: 3 },
  ],
});

// Plaid sign convention: amount < 0 is money INTO the account. Only that is a
// credit — a category label never turns a debit into one.
const PAYMENT_CATEGORIES = new Set(["LOAN_PAYMENTS", "TRANSFER_OUT"]);
function isIncomeCandidate(t, accountType) {
  if (t.pending) return false;
  const amt = Number(t.amount);
  if (!(amt < 0)) return false;
  if (Math.abs(amt) < RULES.INCOME_FLOOR) return false;
  // A credit on a credit-card or loan account is a payment toward it (Chase
  // autopay landing on the card), never income. Unknown account → not judged.
  if (accountType !== "depository") return false;
  if (PAYMENT_CATEGORIES.has(t.category_primary)) return false;
  if (t.category_detailed === "INCOME_INTEREST_EARNED") return false;
  if (normMerchant(t).includes("interest")) return false;
  return true;
}

/**
 * Is this dated, amounted series regular? Returns the cadence + gap, or null
 * with the reason it failed (exposed for tests and for the build log).
 */
function regularity(series) {
  const s = [...series].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)).slice(-RULES.WINDOW);
  if (s.length < RULES.MIN_OCCURRENCES) return { ok: false, reason: `only ${s.length} occurrence(s)` };
  const gaps = s.slice(1).map((x, i) => daysBetween(s[i].date, x.date));
  const g = median(gaps);
  const c = RULES.CADENCES.find((k) => g >= k.min && g <= k.max);
  if (!c) return { ok: false, reason: `median gap ${g}d is no supported cadence` };
  const worst = Math.max(...gaps.map((x) => Math.abs(x - g)));
  if (worst > c.max_dev) return { ok: false, reason: `gaps ${gaps.join("/")}d vary by up to ${worst}d (limit ${c.max_dev}d)` };
  const amounts = s.map((x) => x.amount);
  const m = median(amounts);
  const off = Math.max(...amounts.map((a) => Math.abs(a - m) / m));
  if (off > RULES.AMOUNT_TOLERANCE) return { ok: false, reason: `amounts vary ${Math.round(off * 100)}% from the median (limit ${RULES.AMOUNT_TOLERANCE * 100}%)` };
  return { ok: true, cadence: c.cadence, gap: g, window: s, amount: m };
}

/**
 * Infer the income streams in `posted` (Plaid transactions) that clear the bar.
 * `accounts`: plaid_accounts rows ({account_id, type, name, ...}).
 * Returns [{account_id, account_name, source, cadence, amount, typical_day,
 * last_date, next_expected, count}] — same shape finance-model has always
 * published — plus `rejected` for the build log.
 */
function inferIncomeStreams(posted, accounts) {
  const byId = new Map((accounts || []).map((a) => [a.account_id, a]));
  const groups = new Map();
  for (const t of posted || []) {
    if (!isIncomeCandidate(t, byId.get(t.account_id)?.type)) continue;
    const k = `${t.account_id}::${normMerchant(t)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ date: t.date, amount: Math.abs(Number(t.amount)) });
  }
  const streams = [];
  const rejected = [];
  for (const [k, series] of groups) {
    const [account_id, source] = k.split("::");
    const r = regularity(series);
    if (!r.ok) { rejected.push({ account_id, source, count: series.length, reason: r.reason }); continue; }
    const a = byId.get(account_id) || {};
    const last = r.window[r.window.length - 1].date;
    streams.push({
      account_id,
      account_name: a.name || a.official_name || a.subtype || account_id,
      source,
      cadence: r.cadence,
      amount: round2(r.amount),
      typical_day: Math.round(median(r.window.map((x) => toDate(x.date).getUTCDate()))),
      last_date: last,
      next_expected: addDays(last, r.gap),
      count: series.length,
    });
  }
  streams.sort((a, b) => b.amount - a.amount);
  return { streams, rejected };
}

module.exports = { inferIncomeStreams, regularity, isIncomeCandidate, normMerchant, RULES };
