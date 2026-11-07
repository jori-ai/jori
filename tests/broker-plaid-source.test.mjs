// broker-plaid-source: Plaid holdings → the bridge-shaped portfolio that
// bin/broker-snapshot writes. The shapes below are the real Plaid rows the
// first link produced trimmed and anonymised.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildPortfolio, normalizeTicker, isUninvestedCash, fetchPlaidRows } = require("../lib/broker-plaid-source.js");

const MAP = {
  "1111": { hash: "HASH-A", name: "Owner Trad 401k" },
  "2222": { hash: "HASH-B", name: "Partner Trad 401k" },
};

const rows = [
  { account_id: "a1", account_mask: "1111", account_name: "Trad IRA", security_id: "s-cash", ticker: "CUR:USD", asset_type: "cash", shares: 38224.75, current_price: 1, market_value: 38224.75, price_as_of: "2026-11-07" },
  { account_id: "a1", account_mask: "1111", account_name: "Trad IRA", security_id: "s-nvda", ticker: "NVDA", name: "NVIDIA", asset_type: "equity", shares: 100, current_price: 186.64, market_value: 18664, cost_basis: 5000, price_as_of: "2026-11-06" },
  { account_id: "a1", account_mask: "1111", account_name: "Trad IRA", security_id: "s-brk", ticker: "BRK.B", asset_type: "equity", shares: 10, current_price: 570.89, market_value: 5708.9, price_as_of: "2026-11-06" },
  { account_id: "a2", account_mask: "2222", account_name: "Partner Trad 401k", security_id: "s-vxus", ticker: "VXUS", asset_type: "etf", shares: 50, current_price: 80.92, market_value: 4046, price_as_of: "2026-11-06" },
  { account_id: "a2", account_mask: "2222", account_name: "Partner Trad 401k", security_id: "s-mm", ticker: "SWVXX", asset_type: "cash", shares: 1000, current_price: 1, market_value: 1000, price_as_of: "2026-11-07" },
  { account_id: "a3", account_mask: "3333", account_name: "SEP", security_id: "s-cash", ticker: "CUR:USD", asset_type: "cash", shares: 0.01, current_price: 1, market_value: 0.01, price_as_of: "2026-11-07" },
];

test("maps accounts onto the bridge-era hash and name, and keeps unmapped ones", () => {
  const { accounts, unmapped } = buildPortfolio(rows, MAP);
  const byHash = Object.fromEntries(accounts.map((a) => [a.accountHash, a]));
  assert.equal(byHash["HASH-A"].accountName, "Owner Trad 401k");
  assert.equal(byHash["HASH-B"].accountName, "Partner Trad 401k");
  assert.equal(byHash["plaid:3333"].accountName, "SEP");
  assert.deepEqual(unmapped, [{ mask: "3333", name: "SEP" }]);
});

test("uninvested cash becomes cashBalance; a money-market fund stays a CASH_EQUIVALENT position", () => {
  const { accounts } = buildPortfolio(rows, MAP);
  const trad = accounts.find((a) => a.accountHash === "HASH-A");
  assert.equal(trad.cashBalance, 38224.75);
  assert.equal(trad.totalValue, 62597.65);
  assert.ok(!trad.positions.some((p) => p.ticker === "CUR:USD"));
  const second = accounts.find((a) => a.accountHash === "HASH-B");
  assert.equal(second.cashBalance, 0);
  assert.equal(second.positions.find((p) => p.ticker === "SWVXX").assetType, "CASH_EQUIVALENT");
  assert.equal(second.positions.find((p) => p.ticker === "VXUS").assetType, "COLLECTIVE_INVESTMENT");
});

test("share-class tickers use the bridge spelling (BRK/B)", () => {
  assert.equal(normalizeTicker("BRK.B"), "BRK/B");
  assert.equal(normalizeTicker("NVDA"), "NVDA");
  assert.equal(normalizeTicker("CUR:USD"), "CUR:USD");
  const { accounts } = buildPortfolio(rows, MAP);
  assert.ok(accounts[0].positions.some((p) => p.ticker === "BRK/B" && p.assetType === "EQUITY"));
});

test("priceDate is the newest close among real positions, never the cash stamp", () => {
  assert.equal(buildPortfolio(rows, MAP).priceDate, "2026-11-06");
});

test("day change is computed from the previous price, and is null (not zero) without one", () => {
  const none = buildPortfolio(rows, MAP).accounts[0].positions.find((p) => p.ticker === "NVDA");
  assert.equal(none.dayChange, null);
  assert.equal(none.dayChangePercent, null);
  const prev = new Map([["HASH-A|NVDA", 180], ["HASH-A|BRK/B", 570.89]]);
  const pos = buildPortfolio(rows, MAP, prev).accounts[0].positions;
  const nvda = pos.find((p) => p.ticker === "NVDA");
  assert.equal(nvda.dayChange, 664);
  assert.equal(nvda.dayChangePercent, 3.69);
  assert.equal(pos.find((p) => p.ticker === "BRK/B").dayChange, 0);
});

test("isUninvestedCash only for currency pseudo-tickers or tickerless cash", () => {
  assert.equal(isUninvestedCash({ asset_type: "cash", ticker: "CUR:USD" }), true);
  assert.equal(isUninvestedCash({ asset_type: "cash", ticker: null }), true);
  assert.equal(isUninvestedCash({ asset_type: "cash", ticker: "SWVXX" }), false);
  assert.equal(isUninvestedCash({ asset_type: "equity", ticker: "CUR:USD" }), false);
});

test("fetchPlaidRows: only the configured brokerage's Items, and a failed Item is reported, not hidden", async () => {
  const store = { getItems: () => [
    { item_id: "i1", institution_name: "Example Brokerage", access_token: "t1" },
    { item_id: "i2", institution_name: "Example Brokerage", access_token: "t2" },
    { item_id: "i3", institution_name: "Chase", access_token: "t3" },
  ] };
  const calls = [];
  const plaid = { holdingsJoined: async (t) => {
    calls.push(t);
    if (t === "t2") throw new Error("ITEM_LOGIN_REQUIRED");
    return { rows: [rows[1]] };
  } };
  const out = await fetchPlaidRows({ plaid_institution: "example brokerage" }, { plaid, store });
  assert.deepEqual(calls, ["t1", "t2"]);
  assert.equal(out.rows.length, 1);
  assert.equal(out.failed.length, 1);
  assert.equal(out.items, 2);
  await assert.rejects(fetchPlaidRows({ plaid_institution: "" }, { plaid, store }));
  await assert.rejects(fetchPlaidRows({ plaid_institution: "other broker" }, { plaid, store }));
});
