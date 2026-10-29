#!/usr/bin/env node
// finance — hum harvester for the money track. Reasons over the read-only
// plaid_* data (+ any asset-value tables the installation names in
// agent/local/config/finance.json) + the nightly-built finance-model.json to surface a
// timely, judgment-based financial finding the deterministic plaid-sync
// threshold alerts can't: missing/late income, fees & interest (pure waste),
// overdraft-risk obligations, unusual/duplicate charges, weekly net worth.
//
// Deterministic (no LLM here) — emits ONE candidate; the central hum scout
// ranks it against all topics and decides whether to ping. Fail-closed.
//
// READ-ONLY. Bank data is jori-model-only (health-data tier) — never leaves
// the host to a third-party LLM; the only output is a phone ping to the user.
//
// NOTE: with only bank accounts connected to Plaid, itemized card spend
// (subscriptions, dining, shopping) is invisible — we see income,
// mortgages/autopays, utilities, taxes, fees. Subscription/discretionary
// detectors stay dormant until the credit cards are connected.
//
// No Plaid Items, no finance-model.json (a fresh install): the harvester emits
// null and stays quiet.

import fs from "node:fs";
import { readStdinJson, emit, emitNull, stampRun } from "./_common.mjs";
import supa from "../../../lib/supabase-rest.js";
import classifyLib from "../../../lib/finance-classify.js";
import expectedLib from "../../../lib/finance-expected.js";
import rootLib from "../../../lib/root.cjs";
import instanceLib from "../../../lib/instance.cjs";
const { request } = supa;
const { classify } = classifyLib;
const { incomeStatus, scheduledDue } = expectedLib;

const MODEL_FILE = process.env.FINANCE_MODEL_FILE || rootLib.installTools("data/finance-model.json");
const TZ = instanceLib.instance().tz;

// Net worth: which asset stores to add to bank cash, and what to call them.
// Each `value_histories` entry is a table of dated portfolio totals
// ({label, table, value?: "total_value", date?: "as_of_date", trend?: bool});
// `property_totals` a table of dated real-estate totals; Plaid-held
// brokerage positions (plaid_holdings) are summed under `holdings_label`,
// minus accounts at any `holdings_exclude_institutions` (an institution already
// counted through its own value history). No sources → no net-worth line.
const NET_WORTH = {
  value_histories: [],
  property_totals: null,
  holdings_label: "brokerage (Plaid)",
  holdings_exclude_institutions: [],
  cash_label: "bank cash",
  ...(instanceLib.localConfig("finance", { net_worth: {} }).net_worth || {}),
};

const isMain = import.meta.url === `file://${process.argv[1]}`;

// ── Home-zone helpers (instance().tz) ──────────────────────────────────────
function etNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: TZ }));
}
function etDateStr(d = etNow()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function isoWeek(d = etNow()) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const ys = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - ys) / 86400000 + 1) / 7)).padStart(2, "0")}`;
}
const usd = (n) => `$${Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
const norm = (t) =>
  (t.merchant_name || t.name || "unknown").toLowerCase().replace(/\b(x{2,}\d+|\d{3,})\b/g, "").replace(/[*#]+/g, " ").replace(/\s+/g, " ").trim();

const FEE_RE = /overdraft|\bnsf\b|atm fee|foreign transaction|interest charge|finance charge|late fee|maintenance fee|service charge|wire fee|returned item/i;

// A Plaid Item reconnect can mint a NEW account_id for the same physical
// card/account. When that happens, Plaid mirrors every transaction on the card
// under BOTH account_ids, so a same-merchant/same-amount/same-date pair
// spanning that account_id pair is guaranteed to look like a duplicate charge
// under a naive merchant+amount match, forever, even though nothing was
// actually charged twice. Confirmed 3-for-3 false positives on one card in
// late August 2026 — all pairs of the same two account_ids.
//
// Two account_ids are treated as the same underlying account when they share
// both mask and institution_name — derived live from `accounts` (already
// fetched every run) rather than a hardcoded id list, so this keeps working
// across the next reconnect that mints yet another account_id. Exported for
// unit tests.
export function isReconnectArtifactPair(accounts, idA, idB) {
  if (!idA || !idB || idA === idB) return false;
  const a = (accounts || []).find((x) => x.account_id === idA);
  const b = (accounts || []).find((x) => x.account_id === idB);
  if (!a || !b || !a.mask || !b.mask || !a.institution_name || !b.institution_name) return false;
  return a.mask === b.mask && a.institution_name.toLowerCase() === b.institution_name.toLowerCase();
}

async function main() {
  let model;
  try {
    model = JSON.parse(fs.readFileSync(MODEL_FILE, "utf8"));
  } catch {
    stampRun("finance", false);
    return emitNull("finance-model not built yet");
  }

  const today = etDateStr();
  const since = etDateStr(new Date(etNow().getTime() - 8 * 86400000)); // last 8 days, live
  // A store's rows come back as [{as_of_date, total_value}], newest first.
  const history = (src, limit) => {
    const value = src.value || "total_value", date = src.date || "as_of_date";
    return request(`/rest/v1/${src.table}?select=${date},${value}&order=${date}.desc&limit=${limit}`)
      .then((rows) => (rows || []).map((r) => ({ as_of_date: r[date], total_value: r[value] })))
      .catch(() => []);
  };
  const [recent, accounts, histories, plaidHoldings, realEstate] = await Promise.all([
    request(`/rest/v1/plaid_transactions?select=transaction_id,account_id,amount,date,name,merchant_name,category_primary,pending&date=gte.${since}&order=date.desc&limit=400`).catch(() => []),
    request(`/rest/v1/plaid_accounts?select=account_id,name,subtype,type,institution_name,balance_current,balance_available`).catch(() => []),
    // Brokerages / exchanges Plaid does not cover keep their own dated totals.
    Promise.all((NET_WORTH.value_histories || []).map((src) => history(src, 8))),
    // Anything held through Plaid needs no query of its own: it is in plaid_holdings.
    request(`/rest/v1/plaid_holdings?select=account_id,market_value,as_of`).catch(() => []),
    NET_WORTH.property_totals ? history({ value: "total_estimate", ...NET_WORTH.property_totals }, 1) : Promise.resolve([]),
  ]);
  const acct = (id) => (accounts || []).find((a) => a.account_id === id) || {};
  const acctName = (id) => acct(id).name || "account";
  const postedRecent = (recent || []).filter((t) => !t.pending);

  const C = []; // candidate findings
  const add = (priority, c) => C.push({ priority, ...c });

  // ── 1. Late income — ONLY streams the user registered (fin_expected_income).
  // Until 2026-10-04 this read finance-model's history-inferred "income
  // streams", which counted credit-card payment credits as income and pinged
  // them as "late". A pattern in history is not an expectation.
  const [expected, overrides, last40] = await Promise.all([
    request("/rest/v1/fin_expected_income?select=*").catch(() => []),
    request("/rest/v1/fin_txn_override?select=*").catch(() => []),
    request(`/rest/v1/plaid_transactions?select=transaction_id,account_id,amount,date,name,merchant_name,category_primary,category_detailed,pending&date=gte.${etDateStr(new Date(etNow().getTime() - 40 * 86400000))}&order=date.desc&limit=1000`).catch(() => []),
  ]);
  const posted40 = (last40 || []).filter((t) => !t.pending);
  const cls = classify(posted40, accounts, { overrides, expectedIncome: expected });
  for (const r of incomeStatus(expected, posted40, cls, today)) {
    if (r.status !== "late") continue;
    const s = r.stream;
    const late = daysBetween(r.cycle_due, today);
    add(100, {
      signal: `${s.label} (${usd(s.amount)}, due ${r.cycle_due} into ${acctName(s.account_id)}) hasn't arrived — ${late}d past due.`,
      urgency: Math.min(0.85, 0.5 + late * 0.05),
      freshness_min: 0,
      dedup_key: `finance:income-late:${s.id}:${r.cycle_due}`,
      supporting_data: { kind: "income_late", stream: s, cycle_due: r.cycle_due, days_late: late },
    });
  }

  // ── 2. Fees & interest (pure waste) ──────────────────────────────────────
  for (const t of postedRecent) {
    const amt = Number(t.amount);
    if (amt < 5) continue;
    const isFee = t.category_primary === "BANK_FEES" || FEE_RE.test(norm(t));
    if (!isFee) continue;
    add(90, {
      signal: `Fee paid: ${usd(amt)} — ${t.merchant_name || t.name} on ${acctName(t.account_id)} (${t.date}).`,
      urgency: 0.6,
      freshness_min: 0,
      dedup_key: `finance:fee:${t.transaction_id}`,
      supporting_data: { kind: "fee", txn: t },
    });
  }

  // ── 3. Overdraft risk — ONLY payments the user confirmed are scheduled
  // (fin_scheduled_payments). A debit merely seen repeating is a prediction,
  // and this used to announce one as "autopay … due" (2026-10-04).
  const scheduled = await request("/rest/v1/fin_scheduled_payments?select=*&active=eq.true").catch(() => []);
  for (const x of scheduledDue(scheduled, accounts, today, 7)) {
    if (!x.short) continue;
    const s = x.payment;
    add(95, {
      signal: `Heads up: ${s.label} (${s.autopay ? "autopay" : "scheduled"}, ${usd(x.amount)}, ${x.amount_basis}) is due ${x.due} but ${acctName(s.funding_account_id)} has ${usd(x.available)} available.`,
      urgency: 0.8,
      freshness_min: 0,
      dedup_key: `finance:overdraft:${s.id}:${x.due}`,
      supporting_data: { kind: "overdraft_risk", payment: s, due: x.due, amount: x.amount, available: x.available },
    });
  }

  // ── 4. Unusual / duplicate / new-merchant charge (relative to history) ───
  for (const t of postedRecent) {
    const amt = Number(t.amount);
    if (amt <= 0 || ["TRANSFER_OUT", "LOAN_PAYMENTS"].includes(t.category_primary)) continue;
    const st = model.merchant_stats?.[norm(t)];
    // duplicate: same merchant + ~same amount within 72h. Only for non-trivial
    // amounts and excluding categories that legitimately repeat (transit taps,
    // coffee/lunch) — a $3 MTA double-tap is normal, not a double-charge.
    const dupEligible = amt >= 25 && !["TRANSPORTATION", "FOOD_AND_DRINK"].includes(t.category_primary);
    const dup = dupEligible && postedRecent.find(
      (u) => u !== t && u.transaction_id !== t.transaction_id && norm(u) === norm(t) && Math.abs(Number(u.amount) - amt) <= 1 && Math.abs(daysBetween(u.date, t.date)) <= 3
    );
    if (dup && t.transaction_id < dup.transaction_id && isReconnectArtifactPair(accounts, t.account_id, dup.account_id)) {
      continue; // reconnect-mirrored pair, not a real double charge — see isReconnectArtifactPair above
    }
    if (dup && t.transaction_id < dup.transaction_id) {
      add(80, {
        signal: `Possible duplicate: two ${usd(amt)} charges at ${t.merchant_name || t.name} within a few days.`,
        urgency: 0.7, freshness_min: 0,
        dedup_key: `finance:dup:${[t.transaction_id, dup.transaction_id].sort().join(":")}`,
        supporting_data: { kind: "duplicate", a: t, b: dup },
      });
      continue;
    }
    if (st && st.count >= 3 && amt >= 200 && amt > Math.max(3 * st.median, st.median + 3 * st.stdev)) {
      add(75, {
        signal: `Unusual: ${usd(amt)} at ${t.merchant_name || t.name} — you usually spend ~${usd(st.median)} there.`,
        urgency: 0.6, freshness_min: 0,
        dedup_key: `finance:unusual:${t.transaction_id}`,
        supporting_data: { kind: "unusual", txn: t, stats: st },
      });
    } else if (!st && amt >= 1000) {
      add(70, {
        signal: `First charge at a new merchant: ${usd(amt)} — ${t.merchant_name || t.name} (${t.date}).`,
        urgency: 0.5, freshness_min: 0,
        dedup_key: `finance:newmerch:${t.transaction_id}`,
        supporting_data: { kind: "new_merchant", txn: t },
      });
    }
  }

  // ── 5. Subscription price creep (dormant until cards connected) ──────────
  for (const s of model.subscriptions || []) {
    if (s.prior_amount == null) continue;
    const delta = s.amount - s.prior_amount;
    if (delta >= 1 && delta >= s.prior_amount * 0.05) {
      add(60, {
        signal: `${s.merchant} went up: ${usd(s.prior_amount)} → ${usd(s.amount)} (+${usd(delta)}/${s.cadence === "annual" ? "yr" : "mo"}).`,
        urgency: 0.5, freshness_min: 0,
        dedup_key: `finance:subprice:${s.merchant}:${s.amount}`,
        supporting_data: { kind: "sub_price_increase", sub: s },
      });
    }
  }

  // ── 6. Net worth (weekly, low urgency) ───────────────────────────────────
  //
  // Every asset store Jori can see contributes, each from its own table: the
  // value histories named in finance.json `net_worth.value_histories`, anything
  // held through Plaid from plaid_holdings, real estate from
  // `net_worth.property_totals`, and bank cash. Before 2026-08-09 this line said
  // "net worth" while summing one brokerage and bank cash alone, so two real
  // accounts were silently missing from the number.
  //
  // The Plaid arm EXCLUDES accounts at `holdings_exclude_institutions`
  // deliberately: an institution that writes its own value history AND appears
  // in plaid_holdings (a broker mid-migration to Plaid) would otherwise be
  // counted twice.
  //
  // CARD DEBT IS SUBTRACTED (2026-08-09: net worth is reported against credit
  // card liabilities). The weekly review always did, and this did not — so the
  // two quoted different "net worth" figures for the same day. Assets minus
  // what is owed is the only number that deserves the name; the gross figure is
  // shown beside it rather than instead of it.
  const sources = (NET_WORTH.value_histories || []).map((src, i) => ({ src, rows: histories[i] || [] })).filter((h) => h.rows.length);
  if (sources.length || (plaidHoldings || []).length || (realEstate || []).length) {
    const cashAssets = (accounts || [])
      .filter((a) => a.type === "depository")
      .reduce((s, a) => s + (Number(a.balance_current) || 0), 0);
    const cardDebt = (accounts || [])
      .filter((a) => a.type === "credit")
      .reduce((s, a) => s + (Number(a.balance_current) || 0), 0);

    const excluded = (NET_WORTH.holdings_exclude_institutions || []).map((x) => String(x).toLowerCase()).filter(Boolean);
    const isExcludedAccount = new Set(
      (accounts || [])
        .filter((a) => excluded.some((x) => (a.institution_name || "").toLowerCase().includes(x)))
        .map((a) => a.account_id)
    );
    const plaidBrokerage = (plaidHoldings || [])
      .filter((h) => !isExcludedAccount.has(h.account_id))
      .reduce((s, h) => s + (Number(h.market_value) || 0), 0);
    const plaidAsOf = (plaidHoldings || []).map((h) => h.as_of).sort().pop();

    const valued = sources.map(({ src, rows }) => ({ src, rows, now: Number(rows[0].total_value) || 0 }));
    const historiesTotal = valued.reduce((s, v) => s + v.now, 0);
    const reNow = (realEstate || []).length ? Number(realEstate[0].total_value) || 0 : 0;
    const grossAssets = historiesTotal + plaidBrokerage + reNow + cashAssets;
    const total = grossAssets - cardDebt;

    // Name each source with its own vintage — these are point-in-time snapshots,
    // and CLAUDE.md § Financial Operations requires saying so every time.
    const parts = [];
    if (reNow) parts.push(`${NET_WORTH.property_totals.label || "property"} ${usd(reNow)} (as of ${realEstate[0].as_of_date})`);
    for (const v of valued) if (v.now) parts.push(`${v.src.label || v.src.table} ${usd(v.now)} (as of ${v.rows[0].as_of_date})`);
    if (plaidBrokerage) parts.push(`${NET_WORTH.holdings_label} ${usd(plaidBrokerage)} (as of ${(plaidAsOf || "").slice(0, 10)})`);
    parts.push(`${NET_WORTH.cash_label} ${usd(cashAssets)}`);

    // A card whose Item is in login_required has stopped reporting, so its last
    // balance is a floor, not a balance — and understating debt overstates net
    // worth. Say which card is stale rather than quietly printing a number that
    // is too flattering.
    const staleCards = (accounts || [])
      .filter((a) => a.type === "credit" && a.last_synced_at && daysBetween(String(a.last_synced_at).slice(0, 10), today) >= 2)
      .map((a) => `${a.name || a.institution_name} (${String(a.last_synced_at).slice(0, 10)})`);

    // Week-on-week movement of each value history marked `trend`.
    const trends = [];
    for (const v of valued.filter((x) => x.src.trend)) {
      const wkAgo = v.rows.find((r) => daysBetween(r.as_of_date, today) >= 6);
      if (!wkAgo) continue;
      const d = v.now - Number(wkAgo.total_value);
      trends.push(`${v.src.label || v.src.table} ${d >= 0 ? "+" : "−"}${usd(Math.abs(d))} wk/wk`);
    }
    const trend = trends.length ? ` (${trends.join(", ")})` : "";
    const debtNote = cardDebt
      ? ` − ${usd(cardDebt)} on the cards${staleCards.length ? `, though ${staleCards.join(" and ")} stopped reporting so that owed figure is a floor` : ""}`
      : "";
    add(20, {
      signal: `Tracked net worth ~${usd(total)} after debt, none of it live: ${parts.join(" + ")}${debtNote}${trend}.`,
      urgency: 0.3,
      freshness_min: 0,
      dedup_key: `finance:networth:${isoWeek()}`,
      supporting_data: {
        kind: "net_worth",
        sources: valued.map((v) => ({ label: v.src.label || v.src.table, value: v.now, as_of: v.rows[0].as_of_date })),
        plaid_brokerage: plaidBrokerage,
        real_estate: reNow,
        cash: cashAssets,
        gross_assets: grossAssets,
        card_debt: cardDebt,
        stale_cards: staleCards,
      },
    });
  }

  if (!C.length) {
    stampRun("finance", false);
    return emitNull("no finance finding");
  }
  C.sort((a, b) => b.priority - a.priority || b.urgency - a.urgency);
  const top = C[0];
  stampRun("finance", true);
  emit({ topic: "finance", signal: top.signal, urgency: top.urgency, freshness_min: top.freshness_min, dedup_key: top.dedup_key, supporting_data: top.supporting_data });
}

if (isMain) {
  const { situation } = await readStdinJson();
  void situation;
  main().catch((e) => {
    console.error(`finance harvester error: ${e.message}`);
    stampRun("finance", false);
    emitNull("error");
  });
}
