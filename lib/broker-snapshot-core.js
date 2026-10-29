"use strict";
// broker-snapshot-core — the pure half of bin/broker-snapshot: turning one
// /api/portfolio response into rows, and composing the two guard alerts.
// Kept apart from the CLI so the wording and the arithmetic are testable
// without the upstream HTTP call or the Supabase writes.

const { localDate } = require("./broker-config.cjs");
const { formatAccountList } = require("./broker-partial-fetch.js");

// Two consecutive weekday runs = the condition survived a full day. Empty
// fetches are usually transient and clear by the next weekday with no
// re-auth, so one run is never enough evidence to send the user to the bridge.
const EMPTY_STREAK_ESCALATE = 2;

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Rows for the accounts and positions tables, and the day's totals. */
function buildRows(accounts, nowIso) {
  const accountRows = [];
  const positionRows = [];
  let totalValue = 0;
  let cashTotal = 0;
  for (const a of accounts || []) {
    const cash = num(a.cashBalance);
    const total = num(a.totalValue);
    if (total !== null) totalValue += total;
    if (cash !== null) cashTotal += cash;
    accountRows.push({
      account_hash: a.accountHash,
      account_name: a.accountName || null,
      cash_balance: cash,
      total_value: total,
      as_of: nowIso,
      updated_at: nowIso,
    });
    for (const p of a.positions || []) {
      positionRows.push({
        account_hash: a.accountHash,
        ticker: p.ticker,
        name: p.name || null,
        shares: num(p.shares),
        market_value: num(p.marketValue),
        cost_basis: num(p.costBasis),
        current_price: num(p.currentPrice),
        day_change: num(p.dayChange),
        day_change_percent: num(p.dayChangePercent),
        asset_type: p.assetType || null,
        as_of: nowIso,
        updated_at: nowIso,
      });
    }
  }
  return { accountRows, positionRows, totalValue, cashTotal, positionsValue: totalValue - cashTotal };
}

function lapseClause(lapsed, cfg, { reassure }) {
  if (!lapsed.length) return "";
  const who = lapsed.length > 1 ? `your ${cfg.label} connections` : `the ${cfg.label} "${lapsed[0].tokenId}" connection`;
  const since = lapsed[0].since ? ` on ${localDate(new Date(lapsed[0].since), cfg.tz)}` : "";
  const link = cfg.reauth_base ? `: ${cfg.reauth_base}${lapsed[0].tokenId}` : ".";
  return reassure
    ? ` One thing though, and it is probably the whole story: the sign-in window on ${who} ran out${since}, and that can only be renewed in a browser. So this is waiting on you rather than on them${link}`
    : ` The sign-in window on ${who} ran out${since}, which is almost certainly the whole story — that can only be renewed in a browser, so this one is waiting on you${link}`;
}

/**
 * The empty-portfolio alert. Run 1 reports only what was observed (unless the
 * token clock already proves a lapse); run EMPTY_STREAK_ESCALATE+ names the
 * remedy. The texts differ on purpose: system-alert-dedup keys on the wording,
 * so the escalation reads as a new condition instead of being collapsed.
 */
function emptyMessage({ streak, lapsed, cfg }) {
  if (streak.count >= EMPTY_STREAK_ESCALATE) {
    const note = cfg.downstream_note ? ` ${cfg.downstream_note}` : "";
    return `⚠️ ${cap(cfg.label)} has come back empty ${streak.count} runs in a row now, since ${localDate(new Date(streak.since), cfg.tz)} — past the point where it has ever sorted itself out. The connection genuinely needs reconnecting in ${cfg.app_label}. Your last good snapshot is untouched.${note}`;
  }
  const tail = lapsed.length
    ? lapseClause(lapsed, cfg, { reassure: true })
    : " Every time this has happened it has cleared on its own by the next weekday, so there's nothing to do yet; if it's still empty tomorrow I'll tell you, and that will mean the connection really does need reconnecting.";
  return `⚠️ ${cap(cfg.label)} positions didn't refresh today — ${cfg.app_label} answered fine but sent back no accounts, so there was nothing to record. Your last good snapshot is untouched and nothing was overwritten.${tail}`;
}

/** The partial-fetch alert (same escalation shape as emptyMessage). */
function partialMessage({ streak, lapsed, cfg, incomingCount, baseline, pct, missingNames }) {
  const missing = baseline.num_accounts - incomingCount;
  const missingClause = missingNames && missingNames.length
    ? ` The ones missing are ${formatAccountList(missingNames)}.`
    : "";
  const lapsedClause = lapseClause(lapsed, cfg, { reassure: false });
  if (streak.count >= EMPTY_STREAK_ESCALATE) {
    return `⚠️ ${cap(cfg.label)} is still only sending back ${incomingCount} of your ${baseline.num_accounts} accounts — ${streak.count} runs in a row now, since ${localDate(new Date(streak.since), cfg.tz)}. That's roughly ${pct}% of the portfolio missing.${missingClause} Nothing has been overwritten and your last good snapshot from ${baseline.as_of_date} is intact, but I've stopped recording until it's whole again, so anything that reads positions will start calling its numbers stale.${lapsedClause || ` Every sign-in window still looks open from here, so if reconnecting in ${cfg.app_label} doesn't bring them back it is worth a look at their end.`} If you genuinely closed ${missing === 1 ? "that account" : "those accounts"}, run ${cfg.snapshot_command} --accept-account-drop once and I'll take the shorter list as the new normal.`;
  }
  return `⚠️ ${cap(cfg.label)} only sent back ${incomingCount} of the ${baseline.num_accounts} accounts I saw on ${baseline.as_of_date} — about ${pct}% of the portfolio isn't in the response.${missingClause} I haven't recorded today's numbers; writing them would have quietly understated everything and pruned the missing positions, and your last good snapshot is untouched.${lapsedClause || " Every sign-in window still looks open, so this is more likely a hiccup at their end than anything for you to fix — it has cleared on its own every time so far. I'll look again on the next run and only come back to you if it's still short."}`;
}

function cap(s) {
  const t = String(s || "");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

module.exports = { buildRows, emptyMessage, partialMessage, EMPTY_STREAK_ESCALATE, num };
