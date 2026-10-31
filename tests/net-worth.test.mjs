// bin/net-worth — the rendered monthly email and the snapshot row, from a
// synthetic gathered picture, and the OFF behaviour with no config.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const KERNEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { renderHtml, snapshotRow } = require(path.join(KERNEL, "bin/net-worth"));

const now = {
  as_of_date: "2026-02-01",
  real_estate: 900_000, real_estate_as_of: "2026-02-01",
  brokerage: 1_200_000, brokerage_as_of: "2026-01-30",
  exchange: 20_000, exchange_as_of: "2026-01-31",
  bank_cash: 50_000, private_holdings: 25_000, card_debt: 4_000,
  gross_assets: 2_195_000, net_worth: 2_191_000,
  pending: [{ address: "1 Example Lane", contract_price: 300_000 }], pending_commitments: 300_000,
  stale_cards: [{ name: "Travel card", last_synced: "2026-01-28" }],
  lines: [["real_estate", "Real estate"], ["brokerage", "Brokerage"], ["bank_cash", "Bank cash"], ["exchange", "Exchange"], ["private_holdings", "Private"]],
  detail: {
    "Brokerage": [{ label: "Joint", value: 1_200_000, sub: null }],
    "Credit cards": [{ label: "Travel card", extra: "Travel", value: -4_000 }],
  },
};
const prev = { as_of_date: "2026-01-01", net_worth: 2_100_000, brokerage: 1_150_000, card_debt: 5_000 };

test("the email leads with net worth and the month-over-month change", () => {
  const html = renderHtml(now, prev, { footer_note: "No mortgage debt.", property: { footnote: "Property is an estimate." } });
  assert.ok(html.includes("$2,191,000"));
  assert.ok(html.includes("▲ $91,000"));
  assert.ok(html.includes("since January 2026"));
  assert.ok(html.includes("Not counted:</strong> 1 Example Lane contracted at $300,000"));
  assert.ok(html.includes("Travel card last reported 2026-01-28"));
  assert.ok(html.includes("Brokerage as of 2026-01-30"));
  assert.ok(html.includes("Property is an estimate."));
  assert.ok(html.includes("No mortgage debt."));
  // Lower card debt is good news: green, pointing down.
  assert.match(html, /color:#1a7f37">▼ \$1,000/);
});

test("the snapshot row carries one column per configured line", () => {
  const row = snapshotRow(now);
  for (const k of ["real_estate", "brokerage", "exchange", "bank_cash", "private_holdings", "card_debt", "net_worth"]) {
    assert.ok(k in row, k);
  }
  assert.equal(row.brokerage, 1_200_000);
  assert.equal(row.detail, now);
});

test("no config: OFF, exit 0, nothing sent", () => {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), "net-worth-off-"));
  const r = spawnSync(process.execPath, [path.join(KERNEL, "bin/net-worth"), "--json", "--email"], {
    env: { ...process.env, JORI_LOCAL_DIR: local }, encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).configured, false);
  fs.rmSync(local, { recursive: true, force: true });
});
