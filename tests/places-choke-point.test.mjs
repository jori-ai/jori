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

// ── A refused call is not a failed lookup; a geocode does not spend the venue cap ──
// (bin/trip-place-verify --geocode, bin/trip-reservoir-build, lib/places-client.js classifyVerifyExit)
{
const { GEOCODE_MASK, classifyVerifyExit, refusalMessage } = require("../lib/places-client.js");
const { tierForMask } = require("../lib/places-log.js");
const guard = require("../lib/places-guard.js");
const { spawnSync } = require("node:child_process");
const TVR_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "trip-verify-"));
const policyFile = path.join(TVR_TMP, "policy.json");
const countsFile = path.join(TVR_TMP, "counts.json");
const policy = (over = {}) => ({
  allowed_hosts: [], monthly_ceiling_usd: 40, assumed_free_per_month: {},
  daily_live_caps: { enterprise_atmosphere: { "trip-place-verify": 80 } }, ...over,
});
const today = new Date().toISOString().slice(0, 10);
fs.writeFileSync(policyFile, JSON.stringify(policy()));
fs.writeFileSync(countsFile, JSON.stringify({ day: today, counts: { "enterprise_atmosphere|trip-place-verify": 80 } }));

const env = (extra = {}) => ({
  ...process.env, GOOGLE_PLACES_API_KEY: "test-key-never-sent",
  PLACES_POLICY_FILE: policyFile, PLACES_TIER_COUNTS_FILE: countsFile,
  PLACES_LEDGER_FILE: path.join(TVR_TMP, "ledger.json"), PLACES_LOG_FILE: path.join(TVR_TMP, "calls.jsonl"),
  PLACES_BUDGET_STATE_FILE: path.join(TVR_TMP, "none.json"), ...extra,
});

test("the geocode mask is below the Enterprise tier, so it is not the Atmosphere cap's business", () => {
  assert.equal(tierForMask(GEOCODE_MASK), "pro");
  assert.ok(GEOCODE_MASK.includes("places.location"));
});

test("with the venue cap used up, a venue search is capped but a geocode is not", () => {
  assert.match(guard.tierCapReason("trip-place-verify", "enterprise_atmosphere", { policyFile, countsFile }) || "", /80/);
  assert.equal(guard.tierCapReason("trip-place-geocode", tierForMask(GEOCODE_MASK), { policyFile, countsFile }), null);
  const pc = require("../lib/places-client.js");
  const saved = { ...process.env };
  Object.assign(process.env, env());
  try {
    const r = pc.preflight("trip-place-geocode", "searchText", tierForMask(GEOCODE_MASK));
    assert.equal(r.sku, "Places API Text Search Pro");
    assert.throws(() => pc.preflight("trip-place-verify", "searchText", "enterprise_atmosphere"), (e) => e.code === 4);
  } finally { for (const k of Object.keys(env())) if (k in saved) process.env[k] = saved[k]; else delete process.env[k]; }
});

test("classifyVerifyExit: a refusal is told apart from no-match and from a crash", () => {
  assert.deepEqual(classifyVerifyExit(0, ""), { kind: "ok" });
  assert.deepEqual(classifyVerifyExit(1, "trip-place-verify: no match for \"x\""), { kind: "no_match" });
  assert.deepEqual(classifyVerifyExit(null, ""), { kind: "error" });
  assert.deepEqual(classifyVerifyExit(2, "usage"), { kind: "error" });
  const daily = classifyVerifyExit(4, "trip-place-verify: 'trip-place-verify' used its 80 enterprise_atmosphere text searches for today (UTC).\n");
  assert.equal(daily.kind, "refused");
  assert.equal(daily.code, 4);
  assert.equal(daily.daily_cap, true);
  assert.ok(!daily.reason.startsWith("trip-place-verify:"));
  assert.equal(classifyVerifyExit(4, "'x' has no opt-in for enterprise text search").daily_cap, false);
  for (const code of [3, 5, 6]) assert.equal(classifyVerifyExit(code, "nope").kind, "refused");
});

test("refusalMessage says cap reached and when to retry, never 'could not geocode' on its own", () => {
  const daily = classifyVerifyExit(4, "'trip-place-verify' used its 80 enterprise_atmosphere text searches for today (UTC).");
  const m = refusalMessage(daily, 'could not geocode "Macau"');
  assert.match(m, /daily cap reached, retry after 00:00 UTC/);
  assert.match(m, /Places refused/);
  assert.match(refusalMessage(classifyVerifyExit(5, "Places month ceiling: $40"), "x"), /month's Places budget/);
});

test("trip-place-verify: a capped venue search exits 4 with the cap named, before any network call", () => {
  const r = spawnSync(path.join(ROOT, "bin", "trip-place-verify"),
    [`Cap Test Venue ${process.pid}`, "1.5", "1.5"], { encoding: "utf8", env: env(), timeout: 20000 });
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stderr, /text searches for today/);
});

test("trip-reservoir-build: a refused geocode says Places refused and exits 3, not 'could not geocode' exit 2", () => {
  // A month ceiling of 0 refuses the (Pro) geocode in the guard, offline.
  const ceiling = path.join(TVR_TMP, "policy-ceiling.json");
  fs.writeFileSync(ceiling, JSON.stringify(policy({ monthly_ceiling_usd: 0 })));
  const r = spawnSync(path.join(ROOT, "bin", "trip-reservoir-build"),
    ["--label", `Nowhereville ${process.pid}, Testland`, "--dry-run"],
    { encoding: "utf8", env: env({ PLACES_POLICY_FILE: ceiling }), timeout: 60000 });
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 3, out);
  assert.match(out, /Places refused/);
  assert.doesNotMatch(out, /check the label/);
});
}
