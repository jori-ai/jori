// property-values.test.mjs — the valuation reconciler (bin/property-values
// reconcile / isLowConfidence) and the registry-off path, on a synthetic
// registry. No network: the only runs are --dry-run, which spends nothing and
// writes nothing.
// Run: node --test tests/property-values.test.mjs

import { LOCAL_DIR, writeLocalConfig } from "./synthetic-instance.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "property-values");
const { reconcile, isLowConfidence, num } = require(BIN);

const run = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...process.env, RENTCAST_API_KEY: "" } });

test("an interval wider than 80% of the estimate is low confidence", () => {
  assert.equal(isLowConfidence({ price: 300000, priceRangeLow: 220000, priceRangeHigh: 370000 }), false); // 50%
  assert.equal(isLowConfidence({ price: 115000, priceRangeLow: 8000, priceRangeHigh: 240000 }), true);   // >100%
  assert.equal(isLowConfidence({ price: 200000 }), true);  // no interval
  assert.equal(isLowConfidence(null), true);
});

test("num keeps null as unknown, never $0", () => {
  assert.equal(num(null), null);
  assert.equal(num(""), null);
  assert.equal(num("590000"), 590000);
});

test("reconcile: median of credible sources, outliers discarded", () => {
  const r = reconcile([
    { source: "rentcast", estimate: 142000, low_confidence: true },
    { source: "zillow", estimate: 374500, low_confidence: false },
    { source: "manual", estimate: 360000, low_confidence: false },
  ], 280000);
  assert.equal(r.value, Math.round((360000 + 374500) / 2));
  assert.equal(r.basis, "median_of_2");
  assert.deepEqual(r.contributors, ["zillow", "manual"]);
});

test("reconcile: one credible source stands alone; none falls back to cost", () => {
  assert.equal(reconcile([{ source: "zillow", estimate: 500000 }], 400000).basis, "zillow_only");
  const atCost = reconcile([{ source: "rentcast", estimate: 115000, low_confidence: true }], 555000);
  assert.deepEqual([atCost.value, atCost.basis], [555000, "purchase_price"]);
  assert.equal(reconcile([{ source: "rentcast", estimate: 9000, low_confidence: true }], null).basis, "low_confidence_only");
  assert.equal(reconcile([], null).basis, "none");
});

test("reconcile: a wide disagreement is noted", () => {
  const r = reconcile([{ source: "a", estimate: 400000 }, { source: "b", estimate: 600000 }], null);
  assert.match(r.note, /disagree/);
});

test("no registry configured: the tool is off, exit 0, nothing spent", () => {
  writeLocalConfig("property-values", { registry: path.join(LOCAL_DIR, "missing.json") });
  const r = run(["--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no property registry/);
});

test("--dry-run over a synthetic registry plans one call per owned parcel", () => {
  const reg = path.join(LOCAL_DIR, "properties.json");
  fs.writeFileSync(reg, JSON.stringify({
    holdings: { h1: { label: "House One" } },
    parcels: [
      { id: "p1", holding: "h1", address: "1 Example St, Springfield", owned: true, units: [] },
      { id: "p2", holding: "h1", address: "2 Example St, Springfield", owned: false, units: [] },
    ],
  }));
  writeLocalConfig("property-values", { registry: reg, usage_file: path.join(LOCAL_DIR, "usage.json") });
  const r = run(["--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /would value: 1 Example St/);
  assert.doesNotMatch(r.stdout, /2 Example St/);
  assert.match(r.stdout, /1 call\(s\) would have been spent/);
  assert.equal(fs.existsSync(path.join(LOCAL_DIR, "usage.json")), false);
});
