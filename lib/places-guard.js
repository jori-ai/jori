"use strict";
/**
 * The jori-side half of `places-budget`.
 *
 * Every tool in this repo that calls places.googleapis.com asks here first.
 * When the month's Jori Places spend is past its cap the state file says
 * `blocked`, and the tool exits rather than adding to the bill.
 *
 * Reads the state file directly instead of shelling out to `places-budget
 * guard`: this runs at the top of eight CLIs, several of which are on
 * interactive paths, and a ~60ms node spawn per invocation is not worth it.
 * The file is written atomically, so a partial read is not possible.
 */

const fs = require("fs");
const path = require("path");
const { installTools } = require("./root.cjs");
const { localConfig } = require("./instance.cjs");

const DATA = () => installTools("data");
const stateFile = () => process.env.PLACES_BUDGET_STATE_FILE || path.join(DATA(), "places-budget-state.json");
// The places-budget scope that meters this installation's own Places calls
// (the same key lib/places-client.js reads).
const SCOPE = "jori";

function monthKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** null when allowed, else a human-readable reason. */
function placesBlockReason() {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
  } catch (_) {
    return null; // no meter yet — never block on absence of information
  }
  // A state file from last month tells us nothing about this month's budget.
  if (state.month !== monthKey()) return null;
  const s = state.scopes && state.scopes[SCOPE];
  if (!s || s.level !== "blocked") return null;
  return (
    `Jori's Places API spend is $${Number(s.spend_usd).toFixed(2)} this month, ` +
    `over the $${Number(s.limit_usd).toFixed(2)} cap. Places calls are stopped.\n` +
    `Lift with: places-budget unblock ${SCOPE}`
  );
}

/**
 * Exit the process when blocked. Exit code 3 is the agreed "stopped on budget"
 * signal — distinct from 1, so a caller's own failure and a budget stop are
 * tellable apart in job logs.
 */
function assertPlacesAllowed(toolName, ask = {}) {
  const reason = placesBlockReason();
  if (!reason) return;
  // Logged so demand stays visible while the cap is on (Oct 13-20 2026: nothing).
  try {
    require("./places-log.js").logPlacesCall({ tool: toolName, method: "unknown", ...ask, blocked: true });
  } catch { /* never fail on logging */ }
  console.error(`${toolName}: ${reason}`);
  process.exit(3);
}

// ── The policy: kernel defaults + this installation's own ──
// lib/places-tier-policy.json holds generic, safe defaults. An installation's
// hosts, month ceiling, free-pool assumptions and per-caller caps go in
// agent/local/config/places-tier-policy.json, merged over it (scalars and
// lists replace; assumed_free_per_month and each daily_live_caps tier merge
// key by key). PLACES_POLICY_FILE (tests) is used alone, unmerged.
const POLICY_FILE = path.join(__dirname, "places-tier-policy.json");

function mergePolicy(base, local) {
  const out = { ...base };
  for (const [k, v] of Object.entries(local || {})) {
    if (k === "assumed_free_per_month") out[k] = { ...(base[k] || {}), ...v };
    else if (k === "daily_live_caps") {
      out[k] = { ...(base[k] || {}) };
      for (const [tier, caps] of Object.entries(v || {})) out[k][tier] = { ...(out[k][tier] || {}), ...caps };
    } else out[k] = v;
  }
  return out;
}

/** The effective policy. Throws when the kernel file is unreadable (callers fail closed). */
function readPolicy() {
  if (process.env.PLACES_POLICY_FILE) return JSON.parse(fs.readFileSync(process.env.PLACES_POLICY_FILE, "utf8"));
  const base = JSON.parse(fs.readFileSync(POLICY_FILE, "utf8"));
  return mergePolicy(base, localConfig("places-tier-policy", {}));
}

// ── Per-caller tier caps (2026-10-20) — twin of lib/places_guard.py ──
const countsPath = () => process.env.PLACES_TIER_COUNTS_FILE || path.join(DATA(), ".cache", "places-tier-counts.json");
const CAPPED_TIERS = new Set(["enterprise", "enterprise_atmosphere"]);
const utcDay = () => new Date().toISOString().slice(0, 10);

function readCounts(file = countsPath()) {
  try {
    const c = JSON.parse(fs.readFileSync(file, "utf8"));
    if (c.day === utcDay()) return c;
  } catch {}
  return { day: utcDay(), counts: {} };
}

/** null when `caller` may make one more live text search at `tier` today. */
function tierCapReason(caller, tier, { policyFile, countsFile = countsPath() } = {}) {
  if (!CAPPED_TIERS.has(tier)) return null;
  let caps;
  try { caps = (policyFile ? JSON.parse(fs.readFileSync(policyFile, "utf8")) : readPolicy()).daily_live_caps?.[tier] || {}; }
  catch { return null; } // no policy — never block on absence of information
  const who = caller || "untagged";
  if (!(who in caps)) return `'${who}' has no opt-in for ${tier} text search (lib/places-tier-policy.json).`;
  const used = readCounts(countsFile).counts[`${tier}|${who}`] || 0;
  if (used >= Number(caps[who])) return `'${who}' used its ${caps[who]} ${tier} text searches for today (${utcDay()} UTC).`;
  return null;
}

function countTierCall(caller, tier, { countsFile = countsPath() } = {}) {
  if (!CAPPED_TIERS.has(tier)) return;
  try {
    const c = readCounts(countsFile);
    const k = `${tier}|${caller || "untagged"}`;
    c.counts[k] = (c.counts[k] || 0) + 1;
    fs.mkdirSync(path.dirname(countsFile), { recursive: true });
    const tmp = `${countsFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(c));
    fs.renameSync(tmp, countsFile);
  } catch {}
}

/** Exit 4 (tier cap; 3 is the monthly budget) and log the refusal. */
function assertTierAllowed(toolName, caller, tier, ask = {}) {
  const reason = tierCapReason(caller, tier);
  if (!reason) return;
  try {
    require("./places-log.js").logPlacesCall({ tool: toolName, method: "searchText", tier, ...ask, blocked: true, note: `tier-cap: ${reason}` });
  } catch {}
  console.error(`${toolName}: ${reason}`);
  process.exit(4);
}

module.exports = { assertPlacesAllowed, placesBlockReason, tierCapReason, countTierCall, assertTierAllowed, readPolicy, mergePolicy };
