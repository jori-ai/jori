"use strict";
// broker-config — where this installation's brokerage read adapter points,
// and what it calls things. One reader for bin/broker-snapshot,
// bin/broker-token-watch, lib/broker-token-clock.js and
// lib/portfolio-position-freshness.mjs, so they can never disagree about a
// table name, a state file or the label a message uses.
//
// The adapter speaks to a broker bridge: a small web app the user runs that
// holds the broker's OAuth grants and exposes two READ-ONLY routes behind an
// `x-api-key` read-only key:
//   GET /api/portfolio      { accounts: [{ accountHash, accountName, cashBalance,
//                             totalValue, positions: [{ ticker, name, shares,
//                             marketValue, costBasis, currentPrice, dayChange,
//                             dayChangePercent, assetType }] }] }
//   GET /api/token-health   { tokens: [{ tokenId, state, refreshDaysRemaining,
//                             refreshFingerprint }], reauthUrlBase? }
// The read-only key is rejected by every trade route on the bridge, so nothing
// that reads through this adapter can place an order. Trades go through the
// bridge's own approval path (a per-trade Face ID approval in the app), which
// this code never touches.
//
// Config: agent/local/config/investments.json → `broker` (see
// localConfig in lib/instance.cjs). No `api_url` there (and no env override)
// means no broker is connected: every caller treats that as OFF and exits 0.

const { localConfig, instance } = require("./instance.cjs");
const { installTools } = require("./root.cjs");

const BROKER_DEFAULTS = {
  // How messages name the brokerage ("Your brokerage positions didn't refresh").
  label: "brokerage",
  // How messages name the bridge app the user reconnects in.
  app_label: "the broker bridge app",
  // Base URL of the bridge; "" = not connected.
  api_url: "",
  // Env vars that carry the URL override and the read-only key (.env).
  url_env: "BROKER_API_URL",
  key_env: "BROKER_RO_API_KEY",
  // The broker's refresh-token life, which only a browser sign-in renews.
  refresh_window_days: 7,
  // Warn this many days before the window closes.
  warn_within_days: 2,
  // Supabase tables the snapshot writes.
  tables: {
    accounts: "broker_accounts",
    positions: "broker_positions",
    value_history: "broker_value_history",
    position_history: "broker_position_history",
    account_history: "broker_account_history",
  },
  // State and cache files, relative to the installation's kernel tree.
  files: {
    token_watch_state: "data/broker-token-watch-state.json",
    empty_streak: "data/broker-snapshot-empty-streak.json",
    partial_streak: "data/broker-snapshot-partial-streak.json",
    positions_cache: "data/broker-positions.json",
  },
  // jori-send-curl intents (keep them in send-intents.json's private lists).
  intents: { holdings: "brokerage-holdings", token: "brokerage-token" },
  // The command the user re-runs to accept a smaller account list.
  snapshot_command: "broker-snapshot",
  // Optional sentence appended to the escalated empty-fetch alert, naming what
  // stops while the feed is down (e.g. a weekly memo's freshness gate).
  downstream_note: "",
  // Plaid institution name fragment for the same brokerage, when it is also
  // linked through Plaid (a second feed for the freshness check); "" = none.
  plaid_institution: "",
};

function brokerConfig() {
  const cfg = localConfig("investments", { broker: {} }).broker || {};
  const out = { ...BROKER_DEFAULTS, ...cfg };
  out.tables = { ...BROKER_DEFAULTS.tables, ...(cfg.tables || {}) };
  out.files = { ...BROKER_DEFAULTS.files, ...(cfg.files || {}) };
  out.intents = { ...BROKER_DEFAULTS.intents, ...(cfg.intents || {}) };
  out.api_url = String(process.env[out.url_env] || out.api_url || "").replace(/\/$/, "");
  out.ro_key = process.env[out.key_env] || "";
  out.reauth_base = out.api_url ? `${out.api_url}/tokens?reauth=` : "";
  out.tz = instance().tz;
  return out;
}

// Absolute path of one of the adapter's state files (read per call, so a test
// that points JORI_HOME or HOME at a sandbox sees it).
function brokerFile(key, cfg = brokerConfig()) {
  const rel = cfg.files[key];
  if (!rel) throw new Error(`broker-config: unknown file key ${key}`);
  return rel.startsWith("/") ? rel : installTools(rel);
}

// The calendar date in the installation's zone, YYYY-MM-DD.
function localDate(d, tz) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

module.exports = { brokerConfig, brokerFile, localDate, BROKER_DEFAULTS };
