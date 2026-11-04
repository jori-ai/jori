"use strict";
// places-log — one line per Google Places call this repo makes, so a bill can
// be traced to the tool that ran it (or shown NOT to be ours).
//
// Why (2026-09-10): the Places budget ran out much sooner than expected and
// there was no log of who made the calls. The
// meter (`places-budget`) reads the billing export, which says WHAT was bought
// (SKU, count, dollars) but never WHO called — and the answer that day was
// nobody in this repo: 4,255 "Place Details Photos" ($27) came from the same
// API key running inside another project's photo proxy. Without a call log
// there was no way to say "jori made 1,300 of these 5,600 calls" except by
// reading every tool.
//
// The log is JSON lines at data/logs/places-calls.jsonl:
//   { ts, host, tool, method, tier, cached, status, ms, n, lane, note }
//   method: searchNearby | searchText | getPlace | photoMedia | photoUrlIssued
//   tier:   essentials | pro | enterprise | enterprise_atmosphere | photo
//           (what the field mask BUYS — the SKU the billing export will name)
//   cached: true when the answer came from a local cache and Google was not
//           called — logged anyway, so a cache's hit rate is readable
//   n:      how many billable requests this line stands for (a photo loop)
//   lane:   which caller inside a tool asked (hum-nearby, hum-excursion, ...), from
//           the entry or the PLACES_LANE env var; absent when untagged. Added
//           2026-10-13: the log named the tool but never the lane, so the October
//           audit had to infer it from the shape of call bursts.
//   job, chain: the cron-run label (JORI_JOB / JORI_JOB_CHAIN, set by
//           bin/cron-run), tick: the hum tick (HUM_TICK_ID), hum_lane:
//           the harvester that ran it (HUM_LANE, set by hum-harvest-all),
//           session: the Claude Code session (CLAUDE_CODE_SESSION_ID), caller:
//           the process ancestry as executable/script BASENAMES only (never
//           arguments: command lines on the mini carry API keys). Added
//           2026-10-20 so "what ran the budget up" is read off the log instead
//           of inferred from bursts against hum ticks.
//   query / lat / lon / radius / place_id: what was asked.
//   sku, est_usd: the billing-export SKU this line buys and its LIST price
//           (lib/places-prices.json), 0 when cached or blocked. Free
//           allowances are per billing account, so the bill can be lower — or,
//           when another project spent the allowance first, exactly this.
//   blocked: the budget guard refused the call. Logged so demand stays
//           visible while the cap is on (Oct 13-20 2026 logged nothing).
//   photoUrlIssued: a Google media URL carrying our key was HANDED OUT (the
//           `places` CLI does this). Not billed here — billed whenever anything
//           later loads it, which is why they are worth counting.
//
// `places-budget calls` summarises this file; `places-budget attribution`
// sets it against what Google saw for the key (Cloud Monitoring, per method)
// and reports the difference as UNATTRIBUTED — calls made on our key by
// something that is not this repo.
//
// Logging must never fail a call: every path here swallows its own errors.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// PLACES_LOG_FILE redirects the log (tests, one-off audits); production never sets it.
const LOG_FILE = process.env.PLACES_LOG_FILE || require("./root.cjs").installTools("data", "logs", "places-calls.jsonl");

// Field → tier, per Google's Places API (New) pricing sheet. Anything not
// listed is Essentials. The tier of a call is the HIGHEST tier of any field
// in its mask, which is what "the field mask is the price tier" means.
const PRO_FIELDS = new Set([
  "displayName", "formattedAddress", "photos", "primaryType", "primaryTypeDisplayName",
  "addressComponents", "adrFormatAddress", "businessStatus", "containingPlaces", "googleMapsUri",
  "iconBackgroundColor", "iconMaskBaseUri", "plusCode", "postalAddress", "shortFormattedAddress",
  "subDestinations", "utcOffsetMinutes", "viewport", "accessibilityOptions", "googleMapsLinks",
]);
const ENTERPRISE_FIELDS = new Set([
  "rating", "userRatingCount", "priceLevel", "priceRange", "currentOpeningHours",
  "currentSecondaryOpeningHours", "regularOpeningHours", "regularSecondaryOpeningHours",
  "internationalPhoneNumber", "nationalPhoneNumber", "websiteUri",
]);
const ATMOSPHERE_FIELDS = new Set([
  "allowsDogs", "curbsidePickup", "delivery", "dineIn", "editorialSummary", "evChargeOptions",
  "fuelOptions", "goodForChildren", "goodForGroups", "goodForWatchingSports", "liveMusic",
  "menuForChildren", "parkingOptions", "paymentOptions", "outdoorSeating", "reservable",
  "restroom", "reviews", "reviewSummary", "generativeSummary", "servesBeer", "servesBreakfast",
  "servesBrunch", "servesCocktails", "servesCoffee", "servesDessert", "servesDinner",
  "servesLunch", "servesVegetarianFood", "servesWine", "takeout", "neighborhoodSummary",
]);

const PRICES = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, "places-prices.json"), "utf8")); }
  catch { return { per_1000_usd: {}, sku_method: {}, sku_tier: {} }; }
})();

/** List price of ONE billable request of this method at this tier. */
function priceFor(method, tier) {
  const per1000 = PRICES.per_1000_usd?.[method]?.[tier];
  return Number.isFinite(per1000) ? per1000 / 1000 : 0;
}

/** The billing-export sku.description this method+tier is billed as. */
function skuFor(method, tier) {
  const m = PRICES.sku_method?.[method];
  if (!m) return null;
  if (method === "photoMedia") return `Places API ${m}`;
  const t = PRICES.sku_tier?.[tier];
  return t ? `Places API ${m} ${t}` : `Places API ${m}`;
}

// Process ancestry as basenames: `node nearby.mjs < node hum-harvest-all.mjs <
// node hum-tick.mjs`. Interpreters are named by the script they run. Arguments
// are never recorded — on the mini they include API keys.
const INTERPRETERS = new Set(["node", "python", "python3", "bash", "sh", "zsh", "env", "npx", "npm"]);
let _callerMemo;
function callerChain(depth = 5) {
  if (_callerMemo !== undefined) return _callerMemo;
  _callerMemo = null;
  try {
    const { execFileSync } = require("node:child_process");
    const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8", timeout: 2000, maxBuffer: 8 * 1024 * 1024 });
    _callerMemo = chainFromPs(out, process.pid, depth);
  } catch { /* best effort */ }
  return _callerMemo;
}

function procName(command) {
  // A token carrying "=" is an env assignment or a flag value (KEY=secret):
  // never a name, never recorded.
  const toks = String(command || "").trim().split(/\s+/).filter((t) => !t.includes("="));
  const exe = path.basename(toks[0] || "").slice(0, 40);
  if (!INTERPRETERS.has(exe.replace(/[0-9.]+$/, "")) && !INTERPRETERS.has(exe)) return exe;
  const script = toks.slice(1).find((t) => !t.startsWith("-"));
  return script ? `${exe} ${path.basename(script).slice(0, 40)}` : exe;
}

/** Pure: build the chain from `ps -o pid=,ppid=,command=` output. Starts at
 *  `pid` itself, walks parents, stops at launchd/cron/sshd or `depth`. */
function chainFromPs(psOut, pid, depth = 5) {
  const procs = new Map();
  for (const line of String(psOut).split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) procs.set(Number(m[1]), { ppid: Number(m[2]), cmd: m[3] });
  }
  const names = [];
  let cur = Number(pid);
  for (let i = 0; i < depth && procs.has(cur) && cur > 1; i++) {
    const p = procs.get(cur);
    const name = procName(p.cmd);
    if (/^(launchd|cron|sshd.*|login)$/.test(name)) break;
    if (names[names.length - 1] !== name) names.push(name);
    cur = p.ppid;
  }
  return names.length ? names.join(" < ").slice(0, 240) : null;
}

/** Who is making this call, from the environment the schedulers set. */
function callContext(env = process.env) {
  const ctx = {};
  if (env.JORI_JOB) ctx.job = String(env.JORI_JOB).slice(0, 60);
  if (env.JORI_JOB_CHAIN && env.JORI_JOB_CHAIN !== env.JORI_JOB) ctx.chain = String(env.JORI_JOB_CHAIN).slice(0, 160);
  if (env.HUM_TICK_ID) ctx.tick = String(env.HUM_TICK_ID).slice(0, 40);
  if (env.HUM_LANE) ctx.hum_lane = String(env.HUM_LANE).slice(0, 40);
  if (env.CLAUDE_CODE_SESSION_ID) ctx.session = String(env.CLAUDE_CODE_SESSION_ID).slice(0, 60);
  return ctx;
}

function tierForMask(mask) {
  const fields = String(mask || "").split(",").map(f => f.trim().replace(/^places\./, "")).filter(Boolean);
  if (fields.some(f => ATMOSPHERE_FIELDS.has(f))) return "enterprise_atmosphere";
  if (fields.some(f => ENTERPRISE_FIELDS.has(f))) return "enterprise";
  if (fields.some(f => PRO_FIELDS.has(f))) return "pro";
  return "essentials";
}

/**
 * Append one line. `entry` = { tool, method, tier?, mask?, cached?, status?, ms?, n?, note? }.
 * Pass `mask` and the tier is derived; pass `tier` to state it outright.
 */
function logPlacesCall(entry) {
  try {
    const e = entry || {};
    const method = e.method || "unknown";
    const tier = e.tier || (e.mask ? tierForMask(e.mask) : (method === "photoMedia" || method === "photoUrlIssued" ? "photo" : "essentials"));
    const n = Number.isFinite(e.n) ? e.n : 1;
    const billed = !e.cached && !e.blocked && method !== "photoUrlIssued";
    const line = {
      ts: new Date().toISOString(),
      host: os.hostname().split(".")[0],
      tool: e.tool || "unknown",
      method,
      tier,
      cached: !!e.cached,
      status: e.status == null ? null : e.status,
      ms: e.ms == null ? null : Math.round(e.ms),
      n,
      ...((e.lane || process.env.PLACES_LANE) ? { lane: String(e.lane || process.env.PLACES_LANE).slice(0, 40) } : {}),
      ...(e.blocked ? { blocked: true } : {}),
      ...(skuFor(method, tier) ? { sku: skuFor(method, tier) } : {}),
      est_usd: billed ? Math.round(priceFor(method, tier) * n * 10000) / 10000 : 0,
      ...(e.query != null ? { query: String(e.query).slice(0, 120) } : {}),
      ...(Number.isFinite(Number(e.lat)) && e.lat != null ? { lat: Math.round(Number(e.lat) * 10000) / 10000 } : {}),
      ...(Number.isFinite(Number(e.lon)) && e.lon != null ? { lon: Math.round(Number(e.lon) * 10000) / 10000 } : {}),
      ...(e.radius != null ? { radius: Number(e.radius) } : {}),
      ...(e.place_id ? { place_id: String(e.place_id).slice(0, 80) } : {}),
      ...callContext(),
      ...(callerChain() ? { caller: callerChain() } : {}),
      ...(e.note ? { note: String(e.note).slice(0, 120) } : {}),
    };
    const file = process.env.PLACES_LOG_FILE || LOG_FILE;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(line) + "\n");
  } catch { /* never fail the call being logged */ }
}

/** Read the log back: entries with ts >= sinceIso (all when null). */
function readPlacesLog(sinceIso = null, file = LOG_FILE) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return []; }
  const out = [];
  for (const l of text.split("\n")) {
    if (!l) continue;
    try {
      const e = JSON.parse(l);
      if (!sinceIso || e.ts >= sinceIso) out.push(e);
    } catch { /* a torn line */ }
  }
  return out;
}

/** Per-method totals of LIVE (uncached) calls, plus per-tool detail and, per
 *  lane, how many calls went to Google and how many a cache answered. */
function summarize(entries) {
  const byMethod = {}, byTool = {}, byDay = {}, byLane = {};
  let cachedHits = 0, live = 0, issued = 0;
  for (const e of entries) {
    const n = Number(e.n) || 1;
    if (e.method === "photoUrlIssued") { issued += n; continue; }
    const lane = (byLane[e.lane || "untagged"] = byLane[e.lane || "untagged"] || { live: 0, cached: 0 });
    if (e.cached) { cachedHits += n; lane.cached += n; continue; }
    live += n;
    lane.live += n;
    byMethod[e.method] = (byMethod[e.method] || 0) + n;
    const t = (byTool[e.tool] = byTool[e.tool] || {});
    t[e.method] = (t[e.method] || 0) + n;
    const d = String(e.ts).slice(0, 10);
    byDay[d] = (byDay[d] || 0) + n;
  }
  return { live, cachedHits, photoUrlsIssued: issued, byMethod, byTool, byDay, byLane };
}

// Google's method names → this log's short names.
const GOOGLE_METHOD = {
  "google.maps.places.v1.Places.SearchNearby": "searchNearby",
  "google.maps.places.v1.Places.SearchText": "searchText",
  "google.maps.places.v1.Places.GetPlace": "getPlace",
  "google.maps.places.v1.Places.GetPhotoMedia": "photoMedia",
  "google.maps.places.v1.Places.AutocompletePlaces": "autocomplete",
};

/**
 * What Google saw for the key minus what we logged, per method. `seen` is
 * { method(short): count }. A negative gap means we logged more than Google
 * counted (clock skew at the window edges) and is reported as 0.
 */
function attribution(seen, logged) {
  const methods = new Set([...Object.keys(seen || {}), ...Object.keys(logged || {})]);
  const rows = [];
  let seenTotal = 0, loggedTotal = 0, unattributedTotal = 0;
  for (const m of [...methods].sort()) {
    const s = Number(seen?.[m] || 0), l = Number(logged?.[m] || 0);
    const u = Math.max(0, s - l);
    rows.push({ method: m, google: s, ours: l, unattributed: u });
    seenTotal += s; loggedTotal += l; unattributedTotal += u;
  }
  return { rows, google: seenTotal, ours: loggedTotal, unattributed: unattributedTotal,
           unattributed_share: seenTotal ? Math.round((unattributedTotal / seenTotal) * 100) / 100 : 0 };
}

/** Who a line belongs to, for `places-budget audit --by job`: the most
 *  specific label the line carries. Lines written before 2026-10-20 have only
 *  tool + lane. */
function jobOf(e) {
  if (e.job) return e.hum_lane ? `${e.job}/${e.hum_lane}` : e.job;
  if (e.hum_lane) return `hum/${e.hum_lane}`;
  if (e.lane) return `${e.tool}:${e.lane}`;
  if (e.session) return `${e.tool}:claude-session`;
  return `${e.tool}:untagged`;
}

/**
 * Group the month's lines for the audit. Returns rows sorted by estimated cost:
 * { key, live, cached, blocked, est_usd }. `by` = job | lane | day | query | tool | sku.
 * est_usd is recomputed from the price table for old lines that predate it.
 */
function auditRows(entries, by = "job") {
  const keyOf = {
    job: jobOf,
    lane: (e) => e.lane || e.hum_lane || "untagged",
    day: (e) => String(e.ts).slice(0, 10),
    query: (e) => e.query != null ? `${e.tool}: ${e.query}` : (e.place_id ? `${e.tool}: place ${e.place_id}` : `${e.tool}: (query not logged)`),
    tool: (e) => e.tool,
    sku: (e) => e.sku || skuFor(e.method, e.tier) || `${e.method}/${e.tier}`,
  }[by] || jobOf;
  const rows = new Map();
  for (const e of entries) {
    if (e.method === "photoUrlIssued") continue;
    const k = keyOf(e);
    const r = rows.get(k) || { key: k, live: 0, cached: 0, blocked: 0, est_usd: 0 };
    const n = Number(e.n) || 1;
    if (e.blocked) r.blocked += n;
    else if (e.cached) r.cached += n;
    else {
      r.live += n;
      r.est_usd += e.est_usd != null ? Number(e.est_usd) : priceFor(e.method, e.tier) * n;
    }
    rows.set(k, r);
  }
  return [...rows.values()]
    .map((r) => ({ ...r, est_usd: Math.round(r.est_usd * 100) / 100 }))
    .sort((a, b) => b.est_usd - a.est_usd || b.live - a.live);
}

module.exports = {
  logPlacesCall, readPlacesLog, summarize, attribution, tierForMask, GOOGLE_METHOD, LOG_FILE,
  priceFor, skuFor, callContext, chainFromPs, jobOf, auditRows, PRICES,
};
