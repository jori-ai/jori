// watch-config.mjs — who the shows & movies list is for, and this installation's
// taste settings, in one place.
//
// The list has three audiences: "solo" (the user alone), "together" (the user and
// one other viewer) and the other viewer's own list, stored under `partner_id`.
// Per-person ratings (watch_ratings.person) use the user's instance owner_id and
// the same partner_id, so an installation keeps the values its rows already hold.
//
// Everything personal lives in agent/local/config/watchlist.json; with no file
// the list still works for one user (the partner audience is simply unused).

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { instance, localConfig } = require("./instance.cjs");

const DEFAULTS = {
  // The second viewer: the stored audience / person value, and the display name.
  partner_id: "partner",
  partner_name: "the partner",
  // Original languages that rank normally; others sort after them.
  preferred_languages: ["en"],
  // The ratings site (web/watch), when one is deployed — named in pings and emails.
  site_url: "",
  // Fallback taste profile for the fit judge when no memory page holds one.
  taste_profile: "",
  // The memory page (auto-memory dir) holding the taste profile.
  taste_profile_page: "user_tv_profile.md",
  // Extra strictness lines for the fit judge (this installation's dislikes).
  fit_rules: [],
  // Region whose subscriptions are billed (always shown in "where to watch").
  home_region: "US",
  // Travel-timeline metro key → ISO country, for "is the user abroad?".
  metro_countries: {},
};

export function watchConfig() {
  return localConfig("watchlist", DEFAULTS);
}

const cfg = watchConfig();
export const PARTNER = String(cfg.partner_id || "partner");
export const PARTNER_NAME = String(cfg.partner_name || "the partner");

export function ownerId() { return instance().owner_id; }
export function ownerName() { return instance().owner_name; }
export function tz() { return instance().tz; }

/** Display name(s) for an audience: "solo" → the user, "together" → both, partner → partner. */
export function whoFor(audience) {
  const me = ownerName();
  if (audience === "solo") return me;
  if (audience === PARTNER) return PARTNER_NAME;
  return `${me} & ${PARTNER_NAME}`;
}

/** "<name>'s solo list" / "<both>'s list" / "<partner>'s list". */
export function listLabel(audience) {
  if (audience === "solo") return `${ownerName()}'s solo list`;
  if (audience === PARTNER) return `${PARTNER_NAME}'s list`;
  return `${whoFor("together")}'s list`;
}

/** The ratings-site URL, or "" when none is deployed. */
export function siteUrl() { return String(cfg.site_url || ""); }
/** The ratings-site host for prose ("watch.example.com"), or "the ratings site". */
export function siteName() {
  const u = siteUrl();
  return u ? u.replace(/^https?:\/\//, "").replace(/\/.*$/, "") : "the ratings site";
}
