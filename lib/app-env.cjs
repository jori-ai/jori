"use strict";
// app-env.cjs — the environment a web app under apps/ is built with.
//
// The sites (apps/cruises, apps/itin, apps/watch) are Next.js apps that Vercel
// builds from the app directory alone, so they cannot read agent/local at build
// or run time. Everything personal they need — the Supabase project and its
// public anon key, who may sign in, the display zone, and per-site settings —
// is handed to them as environment variables (the Vercel project's env). This
// module is the one place those values are derived from the installation's
// instance and local config, so a deployment can be (re)configured with
// `bin/app-env <app>` instead of by hand.
//
// Sources:
//   - instance.json: supabase_project, tz, owner_id, owner_name, owner_email
//   - config/supabase.json: anon_key
//   - config/apps.json: allowed_emails (default: [owner_email]) and, per app,
//     `sites.<app>` overrides (see APP_KEYS below)
//   - config/watchlist.json: partner_id / partner_name (the second viewer)
//
// With no config the result is all-empty: the sites treat a missing Supabase
// URL or key as "not configured" and turn themselves off.

const { instance, localConfig, supabaseUrl, supabaseAnonKey } = require("./instance.cjs");

const APPS = ["cruises", "itin", "watch"];

const DEFAULTS = {
  // Who may sign in to every site; empty means the owner's own address only.
  allowed_emails: [],
  // Per-app settings: { cruises: { favorite_ports: [...], default_max_cabin_per_night: 440 } }.
  sites: {},
};

function list(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

/** The viewers who rate on the watch site: the owner, then the partner when one is configured. */
function watchViewers(inst, site) {
  if (site.viewers) {
    return list(site.viewers).join(",");
  }
  const out = [];
  if (inst.owner_id) out.push(`${inst.owner_id}:${inst.owner_name && inst.owner_name !== "the user" ? inst.owner_name : inst.owner_id}`);
  // Only a partner the installation actually named: the watchlist module's own
  // default ("partner") is a placeholder, not a person.
  const wl = localConfig("watchlist", {});
  if (wl.partner_id) out.push(`${wl.partner_id}:${wl.partner_name || wl.partner_id}`);
  return out.join(",");
}

/**
 * The env for one app, as an ordered { NAME: value } map. Values are strings;
 * an unset value is "" (the app treats it as absent).
 */
function appEnv(app) {
  if (!APPS.includes(app)) throw new Error(`unknown app: ${app} (one of ${APPS.join(", ")})`);
  const inst = instance();
  const cfg = localConfig("apps", DEFAULTS);
  const site = (cfg.sites && cfg.sites[app]) || {};
  const allowed = list(site.allowed_emails).length ? list(site.allowed_emails)
    : list(cfg.allowed_emails).length ? list(cfg.allowed_emails)
    : list(inst.owner_email);
  const env = {
    NEXT_PUBLIC_SUPABASE_URL: supabaseUrl(),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: supabaseAnonKey(),
    ALLOWED_EMAILS: allowed.map((e) => e.toLowerCase()).join(","),
    NEXT_PUBLIC_SITE_TZ: site.tz || inst.tz || "",
  };
  if (app === "cruises") {
    env.NEXT_PUBLIC_FAVORITE_PORTS = list(site.favorite_ports).join(",");
    const cap = site.default_max_cabin_per_night;
    env.NEXT_PUBLIC_DEFAULT_MAX_CABIN_PER_NIGHT = cap === null ? "any" : cap === undefined ? "" : String(cap);
  }
  if (app === "watch") {
    env.NEXT_PUBLIC_WATCH_VIEWERS = watchViewers(inst, site);
  }
  return env;
}

/** dotenv text (NAME=value lines); empty values are left out unless `all`. */
function formatEnv(env, { all = false } = {}) {
  return Object.entries(env)
    .filter(([, v]) => all || v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join("\n") + "\n";
}

module.exports = { APPS, appEnv, formatEnv };
