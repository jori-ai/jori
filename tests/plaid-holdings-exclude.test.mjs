// excludeHoldingsFilter: a brokerage counted through its own feed must be left
// out of the Plaid-holdings sum even when it is an investments-only Item with
// no plaid_accounts rows — the gap that counted a whole brokerage twice in net
// worth.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plaid-excl-"));
process.env.PLAID_TOKEN_FILE = path.join(dir, "plaid-token.json");
fs.writeFileSync(process.env.PLAID_TOKEN_FILE, JSON.stringify({ items: [
  { item_id: "item-broker", institution_name: "Example Brokerage" },
  { item_id: "item-other", institution_name: "Other Invest" },
] }));
const require = createRequire(import.meta.url);
const { excludeHoldingsFilter } = require("../lib/plaid-store.js");

const holdings = [
  { account_id: "acct-broker-1", item_id: "item-broker", market_value: 100 },
  { account_id: "acct-bank", item_id: "item-bank", market_value: 5 },
  { account_id: "acct-other", item_id: "item-other", market_value: 7 },
];

test("an investments-only Item with no plaid_accounts rows is excluded by its Item", () => {
  const keep = excludeHoldingsFilter(["example brokerage"], []);
  assert.deepEqual(holdings.filter(keep).map((h) => h.account_id), ["acct-bank", "acct-other"]);
});

test("account-institution matching still works", () => {
  const keep = excludeHoldingsFilter(["bankco"], [{ account_id: "acct-bank", institution_name: "BankCo" }]);
  assert.deepEqual(holdings.filter(keep).map((h) => h.account_id), ["acct-broker-1", "acct-other"]);
});

test("no exclusions keeps everything; rows without item_id are not dropped", () => {
  assert.equal(holdings.filter(excludeHoldingsFilter([], [])).length, 3);
  assert.equal([{ account_id: "x" }].filter(excludeHoldingsFilter(["example brokerage"], [])).length, 1);
});
