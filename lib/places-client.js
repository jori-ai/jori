"use strict";
// places-client — the ONLY way Node code in this repo reaches Google Places.
// Twin of lib/places_client.py: same policy (places-tier-policy.json),
// same month ledger (data/places-ledger.json) and lock file, same
// refusal codes. Read the Python file's header for the gates and why.
//
//   const pc = require("../lib/places-client.js");
//   const data = await pc.post("maps-resolve", "places:searchText", body,
//     { mask, method: "searchText", query });
//   const img = await pc.media("place-photo-store", ref, { maxHeightPx: 800 });  // Response | null
//
// Refusals throw PlacesRefused { code, reason }: 3 month blocked, 4 tier opt-in
// / daily cap, 5 month ceiling, 6 cannot verify (wrong host, policy / ledger /
// lock unreadable — fail closed).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const log = require("./places-log.js");
const guard = require("./places-guard.js");
const { installRoot, installTools } = require("./root.cjs");

const BASE_URL = "https://places.googleapis.com/v1/";
const DATA = () => installTools("data");
const ledgerFile = () => process.env.PLACES_LEDGER_FILE || path.join(DATA(), "places-ledger.json");
const stateFile = () => process.env.PLACES_BUDGET_STATE_FILE || path.join(DATA(), "places-budget-state.json");

class PlacesRefused extends Error {
  constructor(code, reason) { super(reason); this.code = code; this.reason = reason; }
}

const month = () => new Date().toISOString().slice(0, 7);
const host = () => os.hostname().split(".")[0];
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function withLock(file, fn, waitMs = 5000) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + waitMs;
  let fd;
  for (;;) {
    try { fd = fs.openSync(lock, "wx"); break; }
    catch (e) {
      if (e.code !== "EEXIST") throw new PlacesRefused(6, `Places ledger lock failed (${e.message}) — refusing (fail closed).`);
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) { fs.unlinkSync(lock); continue; } } catch { continue; }
      if (Date.now() > deadline) throw new PlacesRefused(6, "Places ledger is locked (another call in flight?) — refusing rather than guessing.");
      sleep(50);
    }
  }
  try { return fn(); } finally { try { fs.closeSync(fd); fs.unlinkSync(lock); } catch {} }
}

function readJson(file, what, missing) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (e) {
    if (e.code === "ENOENT" && missing !== undefined) return missing;
    throw new PlacesRefused(6, `${what} unreadable (${e.message}) — refusing (fail closed).`);
  }
  try { return JSON.parse(text); }
  catch (e) { throw new PlacesRefused(6, `${what} unreadable (${e.message}) — refusing (fail closed).`); }
}

function blockReason() {
  const st = readJson(stateFile(), "places-budget state", null);
  const g = st?.scopes?.jori || {};
  if (st && st.month === month() && (g.level === "blocked" || g.manually_blocked)) {
    return `Jori's Places spend is $${Number(g.spend_usd || 0).toFixed(2)} this month, over the $${Number(g.limit_usd || 0).toFixed(2)} cap. Places calls are stopped.`;
  }
  return null;
}

/** Pure: what n more calls of this SKU cost under the ledger's free-pool view. */
function callCost(policy, ledger, pools, sku, price, n = 1) {
  let free = Number(policy.assumed_free_per_month?.[sku] || 0);
  if (pools && sku in pools) free = Math.min(free, Number(pools[sku]));
  const used = Number(ledger.skus?.[sku]?.calls || 0);
  const billable = Math.max(0, used + n - Math.max(free, used));
  return Math.round(billable * price * 1e6) / 1e6;
}

/** Every gate, in order; reserves the cost in the ledger. */
function preflight(tool, method, tier, { n = 1, caller } = {}) {
  let policy;
  try { policy = guard.readPolicy(); }
  catch (e) { throw new PlacesRefused(6, `Places policy unreadable (${e.message}) — refusing (fail closed).`); }
  // An empty allowed_hosts means a single-machine installation: any host.
  // Set it when several machines share the code but one holds the ledger.
  const hosts = policy.allowed_hosts || [];
  if (hosts.length && !hosts.includes(host())) {
    throw new PlacesRefused(6, `Places calls are made only from ${hosts.join(", ")} (this is ${host()}); the spend ledger lives there. Run it there.`);
  }
  const blocked = blockReason();
  if (blocked) throw new PlacesRefused(3, blocked);
  // The policy names lanes (--lane / PLACES_LANE), else the tool; a bare hand
  // run of the general-purpose `places` CLI is "untagged".
  const who = caller || process.env.PLACES_LANE || (tool === "places" ? "untagged" : tool);
  if (method === "searchText" && (tier === "enterprise" || tier === "enterprise_atmosphere")) {
    // A paid tier always needs an opt-in: a tier missing from the policy means
    // nobody may buy it, never "uncapped".
    const caps = policy.daily_live_caps?.[tier] || {};
    {
      if (!(who in caps)) throw new PlacesRefused(4, `'${who}' has no opt-in for ${tier} text search (lib/places-tier-policy.json). Use a cheaper field mask.`);
      const used = guardCounts()[`${tier}|${who}`] || 0;
      if (used >= Number(caps[who])) throw new PlacesRefused(4, `'${who}' used its ${caps[who]} ${tier} text searches for today (UTC).`);
    }
  }
  const sku = log.skuFor(method, tier) || `${method}/${tier}`;
  const price = log.priceFor(method, tier);
  const file = ledgerFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withLock(file, () => {
    let led = readJson(file, "Places ledger", { month: month(), skus: {}, total_usd: 0 });
    if (led.month !== month()) led = { month: month(), skus: {}, total_usd: 0, previous: { month: led.month, total_usd: led.total_usd } };
    const st = readJson(stateFile(), "places-budget state", null);
    const sameMonth = st && st.month === month();
    const billed = sameMonth ? Number(st.scopes?.jori?.spend_usd || 0) : 0;
    const pools = sameMonth ? (st.free_pool_remaining || {}) : {};
    const cost = callCost(policy, led, pools, sku, price, n);
    const spent = Math.max(Number(led.total_usd || 0), billed);
    const ceiling = Number(policy.monthly_ceiling_usd || 0);
    if (spent + cost > ceiling) {
      throw new PlacesRefused(5, `Places month ceiling: $${spent.toFixed(2)} spent (ledger $${Number(led.total_usd || 0).toFixed(2)}, bill $${billed.toFixed(2)}) + $${cost.toFixed(3)} for this call > $${ceiling.toFixed(2)}.`);
    }
    const s = (led.skus[sku] = led.skus[sku] || { calls: 0, est_usd: 0 });
    s.calls += n;
    s.est_usd = Math.round((s.est_usd + cost) * 1e6) / 1e6;
    led.total_usd = Math.round((Number(led.total_usd || 0) + cost) * 1e6) / 1e6;
    led.updated_at = new Date().toISOString();
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(led, null, 1));
    fs.renameSync(tmp, file);
    return { caller: who, sku, cost };
  });
}

function guardCounts() {
  try {
    const f = process.env.PLACES_TIER_COUNTS_FILE || path.join(DATA(), ".cache/places-tier-counts.json");
    const c = JSON.parse(fs.readFileSync(f, "utf8"));
    return c.day === new Date().toISOString().slice(0, 10) ? c.counts || {} : {};
  } catch { return {}; }
}

function apiKey(explicit) {
  let k = explicit || process.env.GOOGLE_PLACES_API_KEY;
  if (!k) {
    try {
      for (const line of fs.readFileSync(path.join(installRoot(), ".env"), "utf8").split("\n")) {
        const m = /^GOOGLE_PLACES_API_KEY=(.*)$/.exec(line);
        if (m) k = m[1].trim().replace(/^["']|["']$/g, "");
      }
    } catch {}
  }
  if (!k) throw new PlacesRefused(6, "GOOGLE_PLACES_API_KEY not set");
  return k;
}

function gate(tool, method, tier, opts) {
  try { return preflight(tool, method, tier, opts); }
  catch (e) {
    if (e instanceof PlacesRefused) {
      log.logPlacesCall({ tool, method, tier, blocked: true, note: `refused ${e.code}: ${e.reason}`, ...(opts.ask || {}) });
    }
    throw e;
  }
}

async function request(tool, httpMethod, p, body, { mask, method, tier, timeoutMs = 15_000, key, caller, ...ask } = {}) {
  tier = tier || log.tierForMask(mask);
  // No key = Places is not set up here: refuse before reserving any cost.
  let k;
  try { k = apiKey(key); }
  catch (e) { log.logPlacesCall({ tool, method, tier, blocked: true, note: `refused ${e.code}: ${e.reason}`, ...ask }); throw e; }
  const res = gate(tool, method, tier, { caller, ask });
  const t0 = Date.now();
  let status = null;
  try {
    const r = await fetch(BASE_URL + p, {
      method: httpMethod,
      headers: { "X-Goog-Api-Key": k, "X-Goog-FieldMask": mask,
                 ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = r.status;
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(`Places ${method} failed: ${r.status} ${JSON.stringify(j).slice(0, 200)}`); e.status = r.status; throw e; }
    return j;
  } finally {
    log.logPlacesCall({ tool, method, tier, status, ms: Date.now() - t0, ...ask });
    guard.countTierCall(res.caller, tier);
  }
}

/** POST places:searchText / places:searchNearby through every gate. */
const post = (tool, p, body, opts) => request(tool, "POST", p, body, opts);
/** GET places/<id> through every gate. */
const get = (tool, p, opts) => request(tool, "GET", p, null, { method: "details", ...opts });

/** A photo's bytes (`<photo name>/media`). Returns the fetch Response, or null on a non-2xx. */
async function media(tool, ref, { maxHeightPx = 800, timeoutMs = 25_000, key, note, ...ask } = {}) {
  const k = apiKey(key);
  gate(tool, "photoMedia", "photo", { ask });
  const t0 = Date.now();
  let status = null;
  try {
    const r = await fetch(`${BASE_URL}${ref}/media?maxHeightPx=${maxHeightPx}&key=${k}`,
      { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    status = r.status;
    return r.ok ? r : null;
  } finally {
    log.logPlacesCall({ tool, method: "photoMedia", tier: "photo", status, ms: Date.now() - t0, ...(note ? { note } : {}), ...ask });
  }
}

module.exports = { post, get, media, preflight, callCost, PlacesRefused, BASE_URL };
