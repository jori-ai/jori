// places-choke-point.test.mjs — every Google Places request in this repo goes
// through lib/places_client.py or lib/places-client.js, which
// price it against the month ledger and refuse past the ceiling, a caller's
// tier opt-in / daily cap, the budget block, or the wrong host — and fail
// closed when any of that cannot be read. A request built anywhere else is
// a path to an overrun nothing would stop (the requirement: a spending cap may
// only be lifted once such an overrun is structurally impossible).
//
// Run: node --test tests/places-choke-point.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CLIENTS = new Set(["lib/places_client.py", "lib/places-client.js"]);
// The request host, written any way a caller could assemble it.
const HOST = /places\.googleapis\.com\/v1|places\.googleapis\.com["'`]\s*\+|maps\.googleapis\.com\/maps\/api\/place/;

function codeFiles() {
  // Every tracked file of the checkout: the kernel's, plus an installation
  // overlay's when one is checked out over it (.overlay.git).
  let out = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" });
  if (fs.existsSync(path.join(ROOT, ".overlay.git"))) {
    try {
      out += "\n" + execFileSync("git", ["--git-dir=.overlay.git", "--work-tree=.", "ls-files"], { cwd: ROOT, encoding: "utf8" });
    } catch { /* no overlay index */ }
  }
  return [...new Set(out.split("\n"))].filter((f) => f && !/\.(md|json|jsonl|txt|lock|png|jpg|svg)$/.test(f)
    && !f.startsWith("tests/") && !f.includes("/node_modules/") && !f.startsWith("data/"));
}

test("no file but the two clients builds a Places API request", () => {
  const offenders = [];
  for (const f of codeFiles()) {
    if (CLIENTS.has(f)) continue;
    let text;
    try { text = fs.readFileSync(path.join(ROOT, f), "utf8"); } catch { continue; }
    if (HOST.test(text)) offenders.push(f);
  }
  assert.deepEqual(offenders, [], `direct Places calls outside the clients:\n  ${offenders.join("\n  ")}\nRoute them through lib/places_client.py / places-client.js.`);
});

// ── the gates themselves (Node client; the Python twin is in places-log-audit.test.py) ──

function sandbox(policyPatch = {}, ledger = null, state = null) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pclient-"));
  const policy = {
    allowed_hosts: [os.hostname().split(".")[0]], monthly_ceiling_usd: 1.0,
    assumed_free_per_month: { "Places API Nearby Search Enterprise": 2 },
    daily_live_caps: { enterprise_atmosphere: { "example-trip-tool": 5 }, enterprise: { "example-lane": 5 } },
    ...policyPatch,
  };
  fs.writeFileSync(path.join(d, "policy.json"), JSON.stringify(policy));
  if (ledger) fs.writeFileSync(path.join(d, "ledger.json"), typeof ledger === "string" ? ledger : JSON.stringify(ledger));
  if (state) fs.writeFileSync(path.join(d, "state.json"), JSON.stringify(state));
  process.env.PLACES_POLICY_FILE = path.join(d, "policy.json");
  process.env.PLACES_LEDGER_FILE = path.join(d, "ledger.json");
  process.env.PLACES_BUDGET_STATE_FILE = path.join(d, "state.json");
  process.env.PLACES_LOG_FILE = path.join(d, "calls.jsonl");
  return d;
}
const pc = () => require("../lib/places-client.js");
const month = new Date().toISOString().slice(0, 7);

test("callCost: free until the assumed allowance, list price after", () => {
  const { callCost } = pc();
  const policy = { assumed_free_per_month: { S: 2 } };
  assert.equal(callCost(policy, { skus: {} }, {}, "S", 0.04), 0);
  assert.equal(callCost(policy, { skus: { S: { calls: 2 } } }, {}, "S", 0.04), 0.04);
  // the account pool, as places-budget last saw it, can only lower the allowance
  assert.equal(callCost(policy, { skus: {} }, { S: 0 }, "S", 0.04), 0.04);
  assert.equal(callCost({}, { skus: {} }, {}, "S", 0.04), 0.04);  // unlisted SKU: nothing assumed free
});

test("the ledger refuses the call that would pass the month ceiling", () => {
  sandbox({}, { month, skus: {}, total_usd: 0.96 });
  const { preflight, PlacesRefused } = pc();
  assert.equal(preflight("example-trip-tool", "searchText", "enterprise_atmosphere").cost, 0.04);  // $1.00: allowed
  assert.throws(() => preflight("example-trip-tool", "searchText", "enterprise_atmosphere"),
    (e) => e instanceof PlacesRefused && e.code === 5);
});

test("the bill counts too: spend so far is max(ledger, places-budget's billed figure)", () => {
  sandbox({}, { month, skus: {}, total_usd: 0 }, { month, scopes: { jori: { spend_usd: 0.99, level: "ok" } } });
  assert.throws(() => pc().preflight("example-trip-tool", "searchText", "enterprise_atmosphere"), (e) => e.code === 5);
});

test("fail closed: unreadable ledger, unreadable policy, wrong host", () => {
  sandbox({}, "{not json");
  assert.throws(() => pc().preflight("x", "searchNearby", "pro"), (e) => e.code === 6);
  sandbox({ allowed_hosts: ["somewhere-else"] });
  assert.throws(() => pc().preflight("x", "searchNearby", "pro"), (e) => e.code === 6);
  sandbox();
  fs.writeFileSync(process.env.PLACES_POLICY_FILE, "{oops");
  assert.throws(() => pc().preflight("x", "searchNearby", "pro"), (e) => e.code === 6);
});

test("a paid-tier text search needs the caller's opt-in", () => {
  sandbox();
  assert.throws(() => pc().preflight("places", "searchText", "enterprise_atmosphere", { caller: "example-lane" }), (e) => e.code === 4);
  assert.throws(() => pc().preflight("places", "searchText", "enterprise"), (e) => e.code === 4);  // untagged not listed here
  assert.equal(pc().preflight("places", "searchText", "enterprise", { caller: "example-lane" }).caller, "example-lane");
  // Pro is not capped
  assert.equal(pc().preflight("places", "searchText", "pro", { caller: "anyone" }).cost, 0.032);
});

test("the budget block refuses with 3", () => {
  sandbox({}, null, { month, scopes: { jori: { level: "blocked", spend_usd: 31.72, limit_usd: 30 } } });
  assert.throws(() => pc().preflight("x", "searchNearby", "pro"), (e) => e.code === 3);
});

test("a refused request is logged as blocked and never reaches the network", async () => {
  const d = sandbox({ monthly_ceiling_usd: 0 });
  let fetched = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetched = true; throw new Error("network"); };
  try {
    await assert.rejects(pc().post("example-trip-tool", "places:searchText", { textQuery: "x" },
      { mask: "places.reviews", method: "searchText", key: "k", query: "x" }), (e) => e.code === 5);
  } finally { globalThis.fetch = realFetch; }
  assert.equal(fetched, false);
  const line = JSON.parse(fs.readFileSync(path.join(d, "calls.jsonl"), "utf8").trim().split("\n").pop());
  assert.equal(line.blocked, true);
  assert.match(line.note, /^refused 5/);
});

test("an empty allowed_hosts is a single-machine installation: any host", () => {
  sandbox({ allowed_hosts: [] });
  assert.equal(pc().preflight("x", "searchNearby", "pro").cost, 0.032);
});

test("the policy is the kernel file with the installation's own merged over it", () => {
  delete process.env.PLACES_POLICY_FILE;
  const local = fs.mkdtempSync(path.join(os.tmpdir(), "plocal-"));
  fs.mkdirSync(path.join(local, "config"));
  fs.writeFileSync(path.join(local, "config", "places-tier-policy.json"), JSON.stringify({
    monthly_ceiling_usd: 3, daily_live_caps: { enterprise: { "example-lane": 2 } },
  }));
  const old = process.env.JORI_LOCAL_DIR;
  process.env.JORI_LOCAL_DIR = local;
  try {
    const { readPolicy } = require("../lib/places-guard.js");
    const kernel = JSON.parse(fs.readFileSync(path.join(ROOT, "lib", "places-tier-policy.json"), "utf8"));
    const p = readPolicy();
    assert.equal(p.monthly_ceiling_usd, 3);
    assert.equal(p.daily_live_caps.enterprise["example-lane"], 2);
    for (const [k, v] of Object.entries(kernel.daily_live_caps.enterprise)) assert.equal(p.daily_live_caps.enterprise[k], v);
    assert.deepEqual(p.daily_live_caps.enterprise_atmosphere, kernel.daily_live_caps.enterprise_atmosphere);
  } finally {
    if (old === undefined) delete process.env.JORI_LOCAL_DIR; else process.env.JORI_LOCAL_DIR = old;
  }
});
