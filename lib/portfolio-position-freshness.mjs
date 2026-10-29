#!/usr/bin/env node
// portfolio-position-freshness — one freshness check + one reconnect-hint,
// shared by every gate that refuses to reason over stale brokerage positions
// (a weekly portfolio memo's run-time gate, its preflight, its catch-up).
//
// Shared rather than copied on purpose: a SKIP alert that names the wrong feed
// to reconnect (Plaid, when the stale store was the broker bridge's positions
// table) sends the user to fix something that cannot move the number. A second
// copy of "which feed is fresh" and "what do I tell the user to reconnect" is
// exactly how that class of bug reappears. Whichever caller runs this, the
// answer must be the same answer.
//
// Also owns staleMessage(), the preflight's alert wording — same argument:
// one author for the freshness story, so the numbers in the sentence can't
// drift from the numbers the gate compared.
//
// Feeds (agent/local/config/investments.json `broker`):
//   broker-direct  the bridge snapshot's positions table (bin/broker-snapshot)
//   broker-plaid   Plaid holdings of the SAME brokerage, when
//                  `broker.plaid_institution` names it. Only that institution
//                  counts: holdings from an unrelated Plaid brokerage being
//                  fresh must never vouch for the brokerage the memo sizes.
//
// Two entry points:
//   import { checkFreshness, reconnectHint } from "./portfolio-position-freshness.mjs"
//   node portfolio-position-freshness.mjs            → one line for a bash
//     caller: "<ageH> <asOfIso> <feed> <plaidStatus>", or bare "NONE" / "ERROR".
//     plaidStatus is plaid-linked | plaid-absent.
//   node portfolio-position-freshness.mjs --hint <feed> <plaidStatus>
//     → just the reconnect-hint text, for the same bash caller.

import { createRequire } from "node:module";
import { request } from "./supabase-rest.js";

const require = createRequire(import.meta.url);
const { brokerConfig } = require("./broker-config.cjs");

async function plaidBrokerHoldings(cfg) {
  const inst = String(cfg.plaid_institution || "").trim();
  if (!inst) return { present: false, rows: [] };
  const accts = await request(
    `/rest/v1/plaid_accounts?select=account_id&institution_name=ilike.*${encodeURIComponent(inst)}*`
  ).catch(() => []);
  const ids = (accts || []).map((a) => a.account_id).filter(Boolean);
  if (!ids.length) return { present: false, rows: [] };
  const list = ids.map((id) => JSON.stringify(id)).join(",");
  const rows = await request(`/rest/v1/plaid_holdings?select=as_of&account_id=in.(${list})&order=as_of.desc&limit=1`).catch(() => []);
  return { present: true, rows: rows || [] };
}

// Returns { ageH, asOf, feed, plaidLinked } or { error: "NONE" | "ERROR" }.
export async function checkFreshness({ cfg = brokerConfig(), now = Date.now() } = {}) {
  try {
    const [direct, plaid] = await Promise.all([
      request(`/rest/v1/${cfg.tables.positions}?select=as_of&order=as_of.desc&limit=1`).catch(() => []),
      plaidBrokerHoldings(cfg),
    ]);
    const stamps = [
      { as_of: direct?.[0]?.as_of, feed: "broker-direct" },
      { as_of: plaid.rows?.[0]?.as_of, feed: "broker-plaid" },
    ]
      .filter((s) => s.as_of)
      .map((s) => ({ ...s, ms: Date.parse(s.as_of) }))
      .filter((s) => Number.isFinite(s.ms));
    if (!stamps.length) return { error: "NONE" };
    const newest = stamps.reduce((a, b) => (b.ms > a.ms ? b : a));
    return {
      ageH: (now - newest.ms) / 3600000,
      asOf: new Date(newest.ms).toISOString(),
      feed: newest.feed,
      plaidLinked: !!plaid.present,
    };
  } catch {
    return { error: "ERROR" };
  }
}

// Which remedy actually moves this number. Reconnecting the wrong feed does
// nothing, so this always names the feed that produced the newest stamp, not a
// generic default.
export function reconnectHint(feed, plaidLinked, cfg = brokerConfig()) {
  const label = cfg.label;
  const snap = cfg.snapshot_command;
  const app = cfg.app_label;
  switch (feed) {
    case "broker-plaid":
      return `Re-link the ${label} item in Plaid (\`plaid-connect link --products investments\`, then \`plaid-holdings-sync\`)`;
    case "broker-direct":
      return plaidLinked
        ? `Both ${label} feeds are behind — reconnect ${label} in ${app} (that is what feeds \`${snap}\`), and re-link the ${label} item in Plaid (\`plaid-connect link --products investments\`, then \`plaid-holdings-sync\`)`
        : `${cap(label)} is not connected through Plaid, so \`plaid-holdings-sync\` cannot move this number — the feed that can is \`${snap}\`, so reconnect ${label} in ${app}${cfg.api_url ? ` (${cfg.api_url.replace(/^https?:\/\//, "")})` : ""}`;
    default:
      return `I could not tell which feed produced the last position data, so check both \`${snap}\` and \`plaid-holdings-sync\``;
  }
}

function cap(s) {
  const t = String(s || "");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// The sentence the preflight sends when the projection crosses the limit.
//
// REGRESSION GUARD. This used to report the OBSERVED age and attribute to it
// a comparison the caller actually makes against the PROJECTED age at run
// time ("positions are already 10.8h old, past the 48h limit"). The two
// straddle the limit in exactly the case the check exists for (a feed that is
// fine now but ages out before the run), so the sentence contradicted itself.
// Report both numbers, and name the assumption that separates them, so the
// reader can tell a dead feed from a live one that simply will not be re-read
// in time.
export function staleMessage({ ageH, asOf, projectedAgeH, limitH, runTimeLabel, hint, jobLabel = "portfolio check", feedLabel }) {
  const feed = feedLabel || brokerConfig().label;
  return `⚠️ The upcoming ${runTimeLabel} ${jobLabel} is on track to skip — the newest ${feed} positions are ${ageH.toFixed(1)}h old (as of ${asOf}), and with no further snapshot before then they would be ${projectedAgeH.toFixed(1)}h old at run time, past the ${limitH}h limit the memo requires. ${hint}. There's still time before that run if you reconnect now — the next automatic snapshot will pick it up.`;
}

// Is this invocation inside the window the preflight was designed for?
//
// The gate is `ageH + leadH > limitH`. That comparison only carries
// information while leadH is small: at leadH >= limitH it is true for ANY age,
// including a feed that refreshed sixty seconds ago, so the check stops
// measuring feed health and starts measuring how early it was run.
//
// REGRESSION GUARD. A verifier that reproduced the real scheduled invocation
// on purpose (and so did not pass --dry-run) ran the preflight two days ahead
// of the run it warns about, against a healthy feed, and the user was paged
// that the run was "on track to skip". Reproducing the real path and passing a
// flag that changes it are contradictory goals, so the send decision cannot
// live in a flag the caller has to remember. One full daily-snapshot cycle
// (24h) is the bound: beyond it, at least one healthy snapshot would have to
// fail before the projection could matter, and this check cannot see that
// yet. Outside the window the caller still computes and prints its verdict —
// full fidelity for a verifier — it just does not page.
export const PREFLIGHT_MAX_LEAD_H = 24;

export function preflightShouldAlert({ leadH, maxLeadH = PREFLIGHT_MAX_LEAD_H }) {
  return Number.isFinite(leadH) && leadH <= maxLeadH;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--hint") {
    process.stdout.write(reconnectHint(args[1], args[2] === "plaid-linked") + "\n");
    return;
  }
  const r = await checkFreshness();
  if (r.error) {
    console.log(r.error);
    return;
  }
  console.log(`${r.ageH.toFixed(1)} ${r.asOf} ${r.feed} ${r.plaidLinked ? "plaid-linked" : "plaid-absent"}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
