"use strict";
//
// broker-token-clock — is the broker's browser sign-in window actually gone?
//
// Its one job: turn broker-token-watch's persisted observation into a yes/no
// about whether the refresh window has run out, so a caller can tell "the
// broker hiccuped" apart from "this is waiting on the user". The consumer is
// the empty- and partial-portfolio guards in bin/broker-snapshot.
//
// Read-only, and it makes no network call by design. Nothing here touches a
// token: the watch's state file holds clocks and a truncated fingerprint,
// never a credential.
//
// Why a file and not the live endpoint: /api/token-health is
// broker-token-watch's dependency, not the snapshot's. The snapshot path is
// deliberately narrow — one read-only /api/portfolio call — and a second
// network dependency would let a token-health outage change what that tool
// says about the portfolio. The watch runs once a day, typically hours before
// the after-close snapshot, so an observation can be most of a day old, which
// is exactly why the remaining days are PROJECTED forward from observedAt
// instead of read literally: a watch that saw "expiring, 0.1 days left" in the
// morning is describing a window that has lapsed by the evening snapshot, and
// a snapshot that read the number flat would tell the user there is nothing to
// do.
//
// Returns the token slots whose window has demonstrably run out. Anything
// missing, unparseable, or genuinely "unknown" returns nothing and the caller
// keeps its existing wording — sending the user to the browser on a guess is
// its own false alarm, so this only speaks when the fact is already on disk.
const fs = require("node:fs");
const { brokerConfig, brokerFile } = require("./broker-config.cjs");

const MS_PER_DAY = 86400000;

/**
 * @param {number} nowMs
 * @param {{stateFile?:string}} [opts]  stateFile overrides the configured one (tests)
 */
function lapsedTokenSlots(nowMs, opts = {}) {
  let parsed;
  try {
    const file = opts.stateFile || brokerFile("token_watch_state");
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const tokens = parsed && parsed.tokens;
  if (!tokens || typeof tokens !== "object") return [];
  const lapsed = [];
  for (const [tokenId, entry] of Object.entries(tokens)) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.state === "expired") {
      lapsed.push({ tokenId, since: entry.observedAt || null });
      continue;
    }
    if (entry.state !== "expiring") continue;
    if (typeof entry.daysRemaining !== "number" || !Number.isFinite(entry.daysRemaining)) continue;
    const observedMs = Date.parse(entry.observedAt || "");
    if (!Number.isFinite(observedMs)) continue;
    if (entry.daysRemaining - (nowMs - observedMs) / MS_PER_DAY > 0) continue;
    lapsed.push({ tokenId, since: new Date(observedMs + entry.daysRemaining * MS_PER_DAY).toISOString() });
  }
  return lapsed;
}

// The bridge's re-authorization link for one token slot ("" when no bridge).
function reauthUrl(tokenId, cfg = brokerConfig()) {
  return cfg.reauth_base ? `${cfg.reauth_base}${tokenId}` : "";
}

module.exports = { lapsedTokenSlots, reauthUrl };
