// private-holdings: one valuer for every net-worth figure.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { valueHoldings, privateHoldings, privateTotal } = require("../lib/private-holdings.js");

test("funded stakes are valued at the latest round; others are skipped", () => {
  const list = valueHoldings({ holdings: [
    { name: "Stake A", status: "funded", committed_usd: 25000, entry_valuation_usd: 100e9, mark_valuation_usd: 80e9, mark_as_of: "2026-01" },
    { name: "Stake B", status: "funded", committed_usd: 10000 },
    { name: "Stake C", status: "pledged", committed_usd: 5000 },
  ] });
  assert.deepEqual(list.map((h) => [h.name, h.value]), [["Stake A", 20000], ["Stake B", 10000]]);
  assert.equal(privateTotal(list), 30000);
});

test("reads a file path; missing or unconfigured is an empty list, never a throw", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ph-")), "p.json");
  fs.writeFileSync(f, JSON.stringify({ holdings: [{ name: "X", status: "funded", committed_usd: 1 }] }));
  assert.equal(privateHoldings(f).length, 1);
  assert.deepEqual(privateHoldings(null), []);
  assert.deepEqual(privateHoldings(f + ".missing"), []);
});
