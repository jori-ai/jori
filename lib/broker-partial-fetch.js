"use strict";
// broker-partial-fetch — the predicate that decides whether a broker
// /api/portfolio response is a PARTIAL fetch (some accounts missing) rather
// than a whole one, and the wording that names what is missing.
//
// Pure, so it can be tested without the CLI, its Supabase writes or the
// upstream HTTP call (bin/broker-snapshot is the caller).
//
// WHY THIS EXISTS. A zero-accounts guard is not enough, because that is not how
// a broker bridge holding SEVERAL independent OAuth grants degrades: when one
// grant lapses the bridge stays healthy and answers HTTP 200 with just the
// surviving grant's accounts. Written as-is, those runs understate the
// portfolio by one grant's worth with no alert possible, prune the missing
// positions from the "now" mirror, and let a downstream memo size decisions
// against a fraction of the portfolio while its freshness gate passes (the row
// is fresh — it is wrong, not stale).
//
// The predicate is an AND of "fewer accounts than last time" and "materially
// less money", because neither half is safe alone:
//
//   - Account COUNT alone false-positives on a cosmetic list change: two
//     near-empty accounts leaving the list (10 -> 8, value -2.4%) is not a
//     partial fetch, and blocking that run would be wrong.
//
//   - Portfolio VALUE alone false-positives on a market crash. The worst single
//     session on record is -20.5% (1987-10-19).
//
// Together they separate the two cases with a wide margin: a lapsed grant
// typically drops several accounts AND around half the value in one step. 25%
// sits above every single-session market move ever recorded and well below
// that, so it is correct on both sides without tuning.
const PARTIAL_DROP_VALUE_PCT = 0.25;

/**
 * @param {{num_accounts:number,total_value:number}|null} baseline
 *        The last written snapshot (the value-history table), or null when
 *        there is none (first ever run) — no baseline means no judgement.
 * @param {number} incomingCount  accounts in this response
 * @param {number} incomingTotal  summed totalValue of this response
 * @param {number} [dropPct]      override for tests
 * @returns {{partial:boolean, valueDropPct:number, missingAccounts:number}}
 */
function isPartialFetch(baseline, incomingCount, incomingTotal, dropPct = PARTIAL_DROP_VALUE_PCT) {
  if (!baseline || !Number.isFinite(baseline.num_accounts) || !Number.isFinite(baseline.total_value)) {
    return { partial: false, valueDropPct: 0, missingAccounts: 0 };
  }
  if (!(baseline.total_value > 0)) {
    return { partial: false, valueDropPct: 0, missingAccounts: 0 };
  }
  const valueDropPct = (baseline.total_value - incomingTotal) / baseline.total_value;
  const missingAccounts = baseline.num_accounts - incomingCount;
  return {
    partial: missingAccounts > 0 && valueDropPct >= dropPct,
    valueDropPct,
    missingAccounts,
  };
}

// WHICH accounts are missing. An alert that names only a count ("3 of the 8
// accounts") leaves the user guessing at a fact the system already holds: the
// accounts table is written only by a WHOLE run (a partial run exits before
// the upsert), so it is still the last good roster and the set difference
// against this response is a read, not new bookkeeping.
//
// Hash-keyed, never name-keyed: account_name is a display label the broker can
// change, accountHash is the identity the rest of the pipeline upserts on.

/**
 * @param {Array<{hash:string,name:(string|null)}>} baselineAccounts
 *        Last good roster. Empty when the read failed — the caller then falls
 *        back to counts alone rather than claiming nothing is missing.
 * @param {Array<{accountHash:string}>} incoming  accounts in this response
 * @returns {string[]} display names of the accounts that did not come back
 */
function missingAccountNames(baselineAccounts, incoming) {
  if (!Array.isArray(baselineAccounts) || !baselineAccounts.length) return [];
  const present = new Set(
    (Array.isArray(incoming) ? incoming : []).map((a) => a && a.accountHash).filter(Boolean)
  );
  return baselineAccounts
    .filter((r) => r && r.hash && !present.has(r.hash))
    .map((r) => r.name || `account ${String(r.hash).slice(0, 6)}`);
}

/** "A", "A and B", "A, B and C" — the message reads as a sentence, not a list. */
function formatAccountList(names) {
  if (!Array.isArray(names) || !names.length) return "";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

module.exports = { isPartialFetch, missingAccountNames, formatAccountList, PARTIAL_DROP_VALUE_PCT };
