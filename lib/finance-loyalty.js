"use strict";
// finance-loyalty.js — the weekly finance review's miles & points section,
// built from the AwardWallet snapshot (bin/awardwallet-sync: loyalty_accounts,
// loyalty_balance_history) and its sync state (when each program was last read).
// Pure: bin/finance-review-data fetches, this computes, lib/finance-review-render.js draws.
//
// The user (2026-11-09): "the weekly finance summary should include the miles
// and points balance with a summary (and cash equivalent) at the top", then:
// three tiles at the top (two named programs + the total), the full section
// lower down, formatted like the other sections.
//
// NOTHING IS GUESSED. A dollar value appears only for a program the
// installation gave a cents-per-point value (agent/local/config/loyalty.json
// `cents_per_point`: {provider_code: {travel, cash}}); the note under the
// table states every rate used. A balance AwardWallet has not read lately is
// shown "as of" its last successful read, never as current.
//
// Config (agent/local/config/loyalty.json, all optional):
//   cents_per_point  {code: {travel: ¢, cash: ¢}}  travel = an ordinary
//                    redemption; cash = what the points cash out for (bank
//                    programs only; absent = no cash-out)
//   review_tiles     [code, code]  the programs shown as tiles in the review's
//                    header beside the total (default: the two most valuable)
//   stale_days       a balance not read for longer is "as of" (default 14)
//   credit_window_days  card credits expiring within this many days are listed (default 60)

const KIND_TITLES = [["Credit Cards", "Bank points"], ["Airlines", "Airline miles"], ["Hotels", "Hotel points"], ["Rentals", "Car rental"]];
const DAY = 86400000;

const pts = (n) => Math.round(n).toLocaleString("en-US");
const usd0 = (n) => `$${Math.round(n).toLocaleString("en-US")}`;
const fmtDay = (iso, tz) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: tz || "UTC" });
const fmtDate = (ymd) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** "Chase (Ultimate Rewards)" → "Chase"; the program's short brand. */
const brand = (displayName) => String(displayName || "").split(" (")[0].trim();
/** "Marriott (Bonvoy)" → "Marriott Bonvoy". */
const programName = (displayName) => String(displayName || "").replace(/\s*\(([^)]*)\)\s*/, " $1").replace(/\s+/g, " ").trim();

/**
 * The card a bank-points account belongs to, when AwardWallet lists it as a
 * sub-account carrying the whole balance: "Sapphire Reserve® (...1918)".
 */
function cardOf(row) {
  for (const s of row.sub_accounts || []) {
    const m = String(s.display_name || "").match(/ - (.+?)\s*\(\.\.\.(\d{4})\)\s*$/);
    if (m && s.balance_raw === row.balance_raw) return { name: m[1].replace(/[®™]/g, "").trim(), mask: m[2] };
  }
  return null;
}

/**
 * @param {object} a
 * @param {object[]} a.rows       loyalty_accounts rows
 * @param {object[]} a.history    loyalty_balance_history rows {account_id, as_of_date, balance_raw}
 * @param {object}   a.lastOk     sync state last_ok {account_id: iso}
 * @param {string}   a.today      YYYY-MM-DD (the installation's local day)
 * @param {string}   a.weekStart  YYYY-MM-DD; the week's change is measured against the last history row on or before it
 * @param {string}   [a.ownerName] the installation owner; other holders are named
 * @param {string}   [a.tz]
 * @param {object}   [a.config]   loyalty.json
 * @returns {object|null} the packet's `loyalty` section, or null when nothing is tracked
 */
function loyaltySection({ rows, history = [], lastOk = {}, today, weekStart, ownerName = "", tz, config = {} }) {
  const cpp = config.cents_per_point || {};
  const staleDays = config.stale_days ?? 14;
  const creditWindow = config.credit_window_days ?? 60;
  const now = Date.parse(`${today}T12:00:00Z`);
  const ownerFirst = String(ownerName).split(" ")[0];

  const programs = [];
  for (const r of rows || []) {
    if (!(r.balance_raw > 0)) continue;
    const rate = cpp[r.provider_code] || {};
    const prior = history.filter((h) => h.account_id === r.account_id && h.as_of_date <= weekStart && h.balance_raw != null)
      .sort((x, y) => x.as_of_date.localeCompare(y.as_of_date)).pop();
    const okAt = lastOk[String(r.account_id)] || (r.error_code === 1 ? r.last_retrieve_date : null);
    const age = okAt ? Math.floor((now - Date.parse(okAt)) / DAY) : null;
    const stale = r.error_code !== 1 || age == null || age > staleDays;
    const card = r.kind === "Credit Cards" ? cardOf(r) : null;
    const holder = r.owner_name && ownerFirst && !r.owner_name.startsWith(ownerFirst) ? r.owner_name.split(" ")[0] : null;
    programs.push({
      account_id: r.account_id, code: r.provider_code, brand: brand(r.display_name), kind: r.kind || "Other",
      label: card ? `${brand(r.display_name)} ${card.name} ••${card.mask}` : programName(r.display_name),
      holder, elite: r.elite_status || null,
      points: r.balance_raw, week_delta: prior ? r.balance_raw - prior.balance_raw : 0,
      travel: rate.travel != null ? (r.balance_raw * rate.travel) / 100 : null,
      cash: rate.cash != null ? (r.balance_raw * rate.cash) / 100 : 0,
      stale, as_of: okAt ? fmtDay(okAt, tz) : null,
      stale_reason: !stale ? null
        : r.owner_kind === "direct" ? "Jori's own reader is failing"
          : r.error_code !== 1 ? "AwardWallet can't read the account"
            : "not refreshed by AwardWallet lately",
    });
  }
  if (!programs.length) return null;
  programs.sort((a, b) => (b.travel ?? 0) - (a.travel ?? 0) || b.points - a.points);

  const sum = (list, f) => list.reduce((s, p) => s + (f(p) || 0), 0);
  const total = { points: sum(programs, (p) => p.points), travel: sum(programs, (p) => p.travel), cash: sum(programs, (p) => p.cash), week_delta: sum(programs, (p) => p.week_delta) };
  const valued = programs.some((p) => p.travel != null);

  // Use-it-or-lose-it card credits: dollar sub-accounts expiring inside the window.
  const credits = [];
  for (const r of rows || []) for (const s of r.sub_accounts || []) {
    if (!s.expiration_date || !String(s.balance || "").startsWith("$") || !(s.balance_raw > 0)) continue;
    const by = s.expiration_date.slice(0, 10);
    const days = (Date.parse(`${by}T12:00:00Z`) - now) / DAY;
    if (days < 0 || days > creditWindow) continue;
    const name = String(s.display_name).replace(/^.*? - /, "").replace(/\s*\*\d+$/, "").replace(/^Reserve /, "").replace(/^\$\d+ /, "").replace(/ Credit$/, "");
    credits.push({ brand: brand(r.display_name), name, amount: s.balance_raw, by });
  }
  credits.sort((a, b) => a.by.localeCompare(b.by) || b.amount - a.amount);
  let creditsLine = null;
  if (credits.length) {
    const lastBy = credits[credits.length - 1].by;
    const firstBy = credits[0].by;
    const byBrand = {};
    for (const c of credits) byBrand[c.brand] = (byBrand[c.brand] || 0) + c.amount;
    const soon = credits.filter((c) => c.by === firstBy);
    creditsLine = {
      total_fmt: usd0(sum(credits, (c) => c.amount)), by_fmt: fmtDate(lastBy),
      by_brand: Object.entries(byBrand).map(([b, v]) => `${b} ${usd0(v)}`).join(" · "),
      soonest: firstBy !== lastBy ? { amount_fmt: usd0(sum(soon, (c) => c.amount)), by_fmt: fmtDate(firstBy), names: soon.map((c) => c.name).join(", ") } : null,
      items: credits.map((c) => ({ ...c, amount_fmt: usd0(c.amount), by_fmt: fmtDate(c.by) })),
    };
  }

  const stale = programs.filter((p) => p.stale);
  const staleLine = stale.length ? {
    share_pct: valued && total.travel ? Math.round((sum(stale, (p) => p.travel) / total.travel) * 100) : null,
    reasons: [...new Set(stale.map((p) => p.stale_reason))].map((reason) => ({ reason, programs: stale.filter((p) => p.stale_reason === reason).map((p) => (p.holder ? `${p.label} (${p.holder})` : p.label)) })),
  } : null;

  // Header tiles: the configured programs (all of a provider's accounts together), else the two most valuable.
  const codes = Array.isArray(config.review_tiles) && config.review_tiles.length ? config.review_tiles
    : [...new Set(programs.map((p) => p.code))].slice(0, 2);
  const tiles = codes.map((code) => {
    const list = programs.filter((p) => p.code === code);
    if (!list.length) return null;
    return {
      label: `${list[0].brand} points`, points_fmt: pts(sum(list, (p) => p.points)),
      value_fmt: list.some((p) => p.travel != null) ? usd0(sum(list, (p) => p.travel)) : null,
      week_delta_fmt: sum(list, (p) => p.week_delta) ? `+${pts(sum(list, (p) => p.week_delta))}` : null,
    };
  }).filter(Boolean);

  const groups = [];
  const known = new Set(KIND_TITLES.map(([k]) => k));
  for (const [kind, title] of [...KIND_TITLES, [null, "Other"]]) {
    const list = programs.filter((p) => (kind ? p.kind === kind : !known.has(p.kind)));
    if (!list.length) continue;
    const d = sum(list, (p) => p.week_delta);
    groups.push({
      title, count: list.length, points_fmt: pts(sum(list, (p) => p.points)),
      week_delta_fmt: d ? `${d > 0 ? "+" : "−"}${pts(Math.abs(d))}` : null,
      value_fmt: list.some((p) => p.travel != null) ? usd0(sum(list, (p) => p.travel)) : null,
      programs: list.map((p) => ({
        label: p.label, holder: p.holder, elite: p.elite, points_fmt: pts(p.points),
        week_delta_fmt: p.week_delta ? `${p.week_delta > 0 ? "+" : "−"}${pts(Math.abs(p.week_delta))}` : null,
        value_fmt: p.travel != null ? usd0(p.travel) : null, stale: p.stale, as_of: p.as_of,
      })),
    });
  }

  const rates = Object.entries(cpp).filter(([code]) => programs.some((p) => p.code === code));
  const rateText = (k) => rates.filter(([, r]) => r[k] != null).map(([code, r]) => `${programs.find((p) => p.code === code).brand} ${r[k]}¢`).join(", ");
  const note = [
    valued ? `≈ Value = a conservative value per point for an ordinary redemption: ${rateText("travel")}.` : "No per-point values are configured, so no dollar values are shown.",
    rateText("cash") ? `Cash-out: ${rateText("cash")}; airline and hotel points have none.` : "",
    `Balances from AwardWallet${rows.some((r) => r.owner_kind === "direct") ? " and Jori's own readers" : ""}, read weekly; "as of" = the last successful read.`,
  ].filter(Boolean).join(" ");

  return {
    total: {
      points_fmt: pts(total.points), value_fmt: valued ? usd0(total.travel) : null, cash_fmt: total.cash ? usd0(total.cash) : null,
      week_delta_fmt: total.week_delta ? `${total.week_delta > 0 ? "+" : "−"}${pts(Math.abs(total.week_delta))}` : null,
      program_count: programs.length,
    },
    tiles, groups, credits: creditsLine, stale: staleLine, note,
  };
}

module.exports = { loyaltySection, cardOf, programName, brand };
