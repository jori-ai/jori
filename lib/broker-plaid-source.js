"use strict";
// broker-plaid-source — feed bin/broker-snapshot from Plaid instead of the
// broker bridge, WITHOUT changing anything downstream.
//
// The snapshot has one input seam: a bridge-shaped portfolio
//   { accounts: [{ accountHash, accountName, cashBalance, totalValue,
//                  positions: [{ ticker, name, shares, marketValue, costBasis,
//                                currentPrice, dayChange, dayChangePercent,
//                                assetType }] }] }
// This module builds exactly that from Plaid /investments/holdings/get, so the
// empty/partial guards, the history tables, the positions cache and every
// reader of the broker tables (weekly memo, net worth, hum, chat) keep working
// on the same rows they always read.
//
// Selected by agent/local/config/investments.json `broker.source: "plaid"`.
// Only Items whose institution name contains `broker.plaid_institution` count.
//
// Identity continuity: `broker.plaid_accounts` maps a Plaid account MASK (it
// survives a re-link; account_id does not) to the bridge's existing
// { hash, name }, so history rows keep one key per account across the switch.
// An unmapped account still appears, keyed `plaid:<mask or account_id>`.
//
// What Plaid does NOT give, and how it is filled:
//   - day change: computed against the previous day's price for the same
//     account+ticker in the position history (prevPrices). No previous price
//     → null, never a guessed zero.
//   - the price date: Plaid prices are the official close of
//     `institution_price_as_of`, which can lag the fetch by a day. The
//     snapshot keys the day's rows on THAT date (priceDate), not on the fetch
//     date, so a Friday close fetched on Saturday is recorded as Friday.
//
// READ-ONLY: uses only lib/plaid-api.js holdingsJoined (GET-shaped
// /investments/holdings/get). Pure transform below is unit-tested.

const CASH_TICKER = /^CUR:/i;

// Plaid security types → the bridge's asset types, which consumers filter on
// (finance-real-estate reads CASH_EQUIVALENT as the brokerage money market).
const TYPE_MAP = {
  equity: "EQUITY",
  etf: "COLLECTIVE_INVESTMENT",
  "mutual fund": "COLLECTIVE_INVESTMENT",
  "fixed income": "FIXED_INCOME",
  derivative: "OPTION",
  cash: "CASH_EQUIVALENT", // a money-market fund with a real ticker
  cryptocurrency: "CRYPTO",
};

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(n) {
  return n === null ? null : Math.round(n * 100) / 100;
}

// Plaid spells share classes BRK.B; the bridge (and every row of history,
// every target list) spells them BRK/B. Keep the bridge spelling.
function normalizeTicker(t) {
  if (!t) return t;
  return /^[A-Z]+\.[A-Z]$/.test(t) ? t.replace(".", "/") : t;
}

// Uninvested cash: Plaid's cash security with a currency pseudo-ticker, or no
// ticker at all. A cash-typed security WITH a real ticker is a money-market
// fund and stays a position.
function isUninvestedCash(row) {
  if (String(row.asset_type || "").toLowerCase() !== "cash") return false;
  return !row.ticker || CASH_TICKER.test(row.ticker) || row.ticker === "CASH";
}

/**
 * Build the bridge-shaped portfolio from Plaid holdings rows.
 *
 * @param rows        holdingsJoined(...).rows for every matching Item, each row
 *                    also carrying `account_id`, `account_mask`, `account_name`.
 * @param accountMap  broker.plaid_accounts: { [mask]: { hash, name } }
 * @param prevPrices  Map("<hash>|<ticker>" → previous day's price) or null.
 * @returns { accounts, priceDate, unmapped }
 */
function buildPortfolio(rows, accountMap = {}, prevPrices = null) {
  const byAccount = new Map();
  const unmapped = [];
  let priceDate = null;

  for (const r of rows || []) {
    const key = r.account_mask || r.account_id;
    if (!byAccount.has(key)) {
      const mapped = accountMap[r.account_mask] || null;
      if (!mapped) unmapped.push({ mask: r.account_mask || null, name: r.account_name || null });
      byAccount.set(key, {
        accountHash: mapped?.hash || `plaid:${key}`,
        accountName: mapped?.name || r.account_name || null,
        cashBalance: 0,
        totalValue: 0,
        positions: [],
      });
    }
    const acct = byAccount.get(key);
    const value = num(r.market_value);
    if (value !== null) acct.totalValue += value;

    if (isUninvestedCash(r)) {
      if (value !== null) acct.cashBalance += value;
      continue;
    }

    // The newest price date among real positions is the day this snapshot
    // describes. Cash-typed rows — money-market funds included — are stamped
    // "today" whatever the market did, so they never set it.
    if (r.price_as_of && String(r.asset_type || "").toLowerCase() !== "cash") {
      const d = String(r.price_as_of).slice(0, 10);
      if (!priceDate || d > priceDate) priceDate = d;
    }

    const ticker = normalizeTicker(r.ticker) || r.security_id;
    const shares = num(r.shares);
    const price = num(r.current_price);
    const prev = prevPrices ? num(prevPrices.get(`${acct.accountHash}|${ticker}`)) : null;
    const dayChange = prev !== null && price !== null && shares !== null ? round2((price - prev) * shares) : null;
    const dayChangePercent = prev ? Math.round(((price - prev) / prev) * 1e4) / 100 : null;

    acct.positions.push({
      ticker,
      name: r.name || null,
      shares,
      marketValue: value,
      costBasis: num(r.cost_basis),
      currentPrice: price,
      dayChange: price === null ? null : dayChange,
      dayChangePercent: price === null ? null : dayChangePercent,
      assetType: TYPE_MAP[String(r.asset_type || "").toLowerCase()] || (r.asset_type ? String(r.asset_type).toUpperCase() : null),
    });
  }

  const accounts = [...byAccount.values()].map((a) => ({
    ...a,
    cashBalance: round2(a.cashBalance),
    totalValue: round2(a.totalValue),
  }));
  return { accounts, priceDate, unmapped };
}

/**
 * Fetch live holdings for every Plaid Item of the configured brokerage.
 * Any Item that fails is reported in `failed` and contributes no accounts —
 * the snapshot's partial-fetch guard then refuses to write a short portfolio.
 */
async function fetchPlaidRows(cfg, { plaid = require("./plaid-api.js"), store = require("./plaid-store.js") } = {}) {
  const inst = String(cfg.plaid_institution || "").toLowerCase().trim();
  if (!inst) throw new Error("broker.source is \"plaid\" but broker.plaid_institution is empty");
  const items = store.getItems().filter((i) => String(i.institution_name || "").toLowerCase().includes(inst));
  if (!items.length) throw new Error(`no Plaid Item matches "${cfg.plaid_institution}" — link it with plaid-connect link --products investments`);
  const rows = [];
  const failed = [];
  for (const item of items) {
    try {
      const joined = await plaid.holdingsJoined(item.access_token);
      for (const r of joined.rows || []) rows.push({ ...r, item_id: item.item_id });
    } catch (e) {
      failed.push({ item_id: item.item_id, error: String((e && e.message) || e) });
    }
  }
  return { rows, failed, items: items.length };
}

module.exports = { buildPortfolio, fetchPlaidRows, normalizeTicker, isUninvestedCash, TYPE_MAP };
