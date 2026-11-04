// places-budget.test.mjs — `places-budget` (billing export attribution,
// the other projects on the billing account, the per-scope alerts), against a
// synthetic config: our project, another project on the same billing account,
// and a shipped app's project metered notify-only.
//
// Run: node --test tests/places-budget.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// A synthetic installation: every require of bin/places-budget below reads this.
const LOCAL = fs.mkdtempSync(path.join(os.tmpdir(), "pb-local-"));
fs.mkdirSync(path.join(LOCAL, "config"));
fs.writeFileSync(path.join(LOCAL, "config", "places-budget.json"), JSON.stringify({
  bq_project: "proj-self",
  billing_table: "proj-self.billing_export.gcp_billing_export_v1_TEST",
  scopes: {
    app: { projects: ["proj-app"], warn_usd: 7.5, limit_usd: 10, enforcement: "notify-only", manual_block: "places-budget block app", label: "the app" },
    jori: { projects: ["proj-self"], warn_usd: 30, limit_usd: 40, enforcement: "local-guard", label: "this installation" },
    gateway: { projects: ["proj-gateway"], warn_usd: 20, limit_usd: 40, enforcement: "notify-only", manual_block: "set the gateway ceiling to 0", label: "the shared gateway" },
  },
}));
process.env.JORI_LOCAL_DIR = LOCAL;

test("places-budget attributes each day's actual charge to that day's calls, and reconciles per SKU", () => {
  const PB = require("../bin/places-budget");
  const SKU = "Places API Text Search Enterprise + Atmosphere";
  const e = (ts, job) => ({ ts, tool: "places", method: "searchText", tier: "enterprise_atmosphere", cached: false, job });
  const entries = [
    e("2026-10-03T10:00:00Z", "a"),                                  // inside the free pool: $0
    e("2026-10-04T10:00:00Z", "a"), e("2026-10-04T11:00:00Z", "b"),
    e("2026-10-04T12:00:00Z", "b"), e("2026-10-04T13:00:00Z", "b"),
  ];
  const bill = [
    { day: "2026-10-03", proj: "proj-self", sku: SKU, cost: 0, calls: 1 },
    { day: "2026-10-03", proj: "proj-gateway", sku: SKU, cost: 28.12, calls: 1002 },  // someone else's charge
    { day: "2026-10-04", proj: "proj-self", sku: SKU, cost: 0.16, calls: 4 },
    { day: "2026-10-05", proj: "proj-self", sku: SKU, cost: 0.04, calls: 1 }, // no log line that day
  ];
  const billed = PB.attributeBill(entries, bill, "job");
  assert.equal(billed.a, 0.04);
  assert.equal(billed.b, 0.12);
  assert.equal(billed["(billed, no log line)"], 0.04);
  const [rec] = PB.reconcile(entries, bill);
  assert.equal(rec.sku, SKU);
  assert.equal(rec.logged_calls, 5);
  assert.equal(rec.billed_calls, 6);
  assert.equal(rec.unlogged_calls, 1);
  assert.equal(rec.account_calls, 1008);
  assert.deepEqual(rec.other_projects, { "proj-gateway": 1002 });
  // the alert line, from a supplied bill (no BigQuery in tests)
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ptop-")), "calls.jsonl");
  fs.writeFileSync(f, entries.map((x) => JSON.stringify(x)).join("\n") + "\n");
  const top = execFileSync(process.execPath, ["-e",
    `console.log(require(${JSON.stringify(path.join(path.dirname(new URL(import.meta.url).pathname), "../bin/places-budget"))}).topCallersText("2026-10", 3, ${JSON.stringify(bill)}))`],
    { env: { ...process.env, JORI_LOCAL_DIR: LOCAL, PLACES_LOG_FILE: f }, encoding: "utf8" }).trim();
  assert.equal(top, "b $0.12 (3 calls), a $0.04 (2 calls), (billed, no log line) $0.04 (0 calls)");
});

test("free pools: what the OTHER projects on the billing account left of each allowance", () => {
  const PB = require("../bin/places-budget");
  const pools = PB.freePoolRemaining([
    { proj: "proj-gateway", sku: "Places API Text Search Enterprise + Atmosphere", calls: 1652 },
    { proj: "proj-gateway", sku: "Places API Place Details Photos", calls: 300 },
    { proj: "proj-app", sku: "Places API Nearby Search Pro", calls: 2 },
    { proj: "proj-self", sku: "Places API Nearby Search Enterprise", calls: 690 },  // ours: not counted
  ]);
  assert.deepEqual(pools, {
    "Places API Text Search Enterprise + Atmosphere": 0,   // Oct 2026: spent by Oct 3
    "Places API Place Details Photos": 700,
    "Places API Nearby Search Pro": 4998,
  });
});

test("places-budget: a notify-only scope over its cap quotes how to stop it, and no alert says 'undefined'", () => {
  // A shared gateway's over-cap alert once ended "so it is your call:
  // undefined" — the scope's status object never carried manual_block.
  const PB = require("../bin/places-budget");
  const spend = {};
  for (const [name, cfg] of Object.entries(PB.SCOPES)) spend[cfg.projects[0]] = { cost: cfg.limit_usd + 1, calls: 1234 };
  const { scopes } = PB.evaluate(spend, null, "2026-10");
  const notifyOnly = Object.keys(PB.SCOPES).filter((n) => PB.SCOPES[n].enforcement === "notify-only");
  assert.ok(notifyOnly.length > 0);
  for (const name of notifyOnly) {
    assert.equal(scopes[name].manual_block, PB.SCOPES[name].manual_block);
    const { verb, pointer } = PB.alertText(name, scopes[name]);
    assert.equal(verb, "OVER CAP");
    assert.ok(pointer.endsWith(`so it is your call: ${PB.SCOPES[name].manual_block}`), pointer);
    // Genuinely absent: point at the generic block command instead of printing a blank.
    const bare = PB.alertText("no-such-scope", { ...scopes[name], manual_block: null });
    assert.ok(bare.pointer.endsWith("so it is your call: places-budget block no-such-scope") && !bare.pointer.includes("undefined"), bare.pointer);
  }
  // Every branch, every scope: over the cap, at the warning line.
  for (const [name, s] of Object.entries(scopes)) {
    for (const level of ["blocked", "warned"]) {
      const { verb, pointer } = PB.alertText(name, { ...s, level });
      assert.ok(!`${verb} ${pointer}`.includes("undefined"), `${name}/${level}: ${pointer}`);
    }
  }
});

test("places-budget with no config: one local-guard scope, and check is off rather than broken", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "pb-empty-"));
  const bin = path.join(path.dirname(new URL(import.meta.url).pathname), "../bin/places-budget");
  const env = { ...process.env, JORI_LOCAL_DIR: empty, JORI_GCP_PROJECT: "" };
  const scopes = JSON.parse(execFileSync(process.execPath, ["-e", `console.log(JSON.stringify(require(${JSON.stringify(bin)}).SCOPES))`], { env, encoding: "utf8" }));
  assert.deepEqual(Object.keys(scopes), ["jori"]);
  assert.equal(scopes.jori.enforcement, "local-guard");
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "pb-home-"));
  // `check` never reaches bq without a billing table; it logs and exits 0.
  execFileSync(process.execPath, [bin, "check"], { env: { ...env, JORI_HOME: data, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
});
