// Cruise-watch configuration — this installation's home cities, embarkation
// ports, per-line search parameters, filter thresholds, alert bars and site URL,
// read from agent/local/config/cruise-watch.json over the generic defaults
// below. With no config the watch is OFF, not broken: no home cities and no
// ports means the extractors search nothing and the filter matches nothing.
//
// Catalog files (data/cruise-ports.json, data/cruise-ships.json) are this
// installation's own data; readCatalog() returns null when one is absent.

import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
const { localConfig, supabaseUrl } = require("../instance.cjs");
const { TOOLS_DIR } = require("../root.cjs");

export const CRUISE_DEFAULTS = {
  // Cities assumed in a gap of the travel plan (lib/cruise/plan.mjs).
  home_cities: [],
  // How far past the plan to keep looking, in days.
  horizon_days: 730,
  // Embarkation port names the aggregator pull (cruisefeed.mjs) asks for.
  embark_ports: [],
  // line → the embarkation port codes that line's own search takes
  // (holland, msc, ncl). A line with no entry searches with no port filter.
  line_embark_ports: {},
  // RCL Group (Royal, Celebrity) search office code; "" leaves it unset.
  rcl_office: "",
  // Princess results page departure-port code; "" lists every port.
  princess_departure_port: "",
  // The browsing site's base URL (cruise-link deep links); "" when there is none.
  site_url: "",
  filters: {
    // Per-line ship age floor: built_after_year is strict (2016 → 2017+ ships).
    default: { built_after_year: 2000 },
    lines: {},
    max_per_person_per_night: 120,
    tax_estimate_per_person_per_night: 35,
    nights_min: 2,
    nights_max: 21,
    // A member rating at or above this outranks the age floor.
    rating_overrides_age: 4.0,
    // Lines listed here sort first among matches, regardless of price.
    preferred_lines: [],
  },
  alerts: {
    drop_min_pct: 10,
    drop_min_usd: 75,
    new_deal_max_per_person_per_night: 80,
  },
};

/** The merged config; `filters` and `alerts` merge one level deep. */
export function cruiseConfig() {
  const cfg = localConfig("cruise-watch", CRUISE_DEFAULTS);
  return {
    ...cfg,
    filters: { ...CRUISE_DEFAULTS.filters, ...(cfg.filters || {}) },
    alerts: { ...CRUISE_DEFAULTS.alerts, ...(cfg.alerts || {}) },
    line_embark_ports: { ...(cfg.line_embark_ports || {}) },
  };
}

/** A path under the kernel tree's data/ directory (JORI_CRUISE_DATA_DIR overrides, for tests). */
export function dataPath(name) {
  return path.join(process.env.JORI_CRUISE_DATA_DIR || path.join(TOOLS_DIR, "data"), name);
}

/** A data/ catalog file parsed, or null when this installation has none. */
export async function readCatalog(name) {
  try {
    return JSON.parse(await readFile(dataPath(name), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

/** This installation's Supabase REST base (SUPABASE_URL wins), or "". */
export function cruiseSupabaseUrl() {
  return process.env.SUPABASE_URL || supabaseUrl();
}
