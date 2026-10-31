// venue-events/config.mjs — this installation's venue-events settings.
//
// Everything that says WHERE the user lives and WHICH venues are watched comes
// from agent/local/config/venue-events.json (lib/instance.cjs localConfig). A
// fresh install has none of it: no sources, so venue-ingest fetches nothing and
// the watch lanes have nothing to read — off, not broken.
//
//   home_metro    the metro slug the venue store's rows belong to unless a row
//                 says otherwise (travel's metro keys, e.g. a city slug)
//   metros        metros the store has a feed for (the morning brief says when
//                 the user is somewhere it does not cover)
//   near_zone     the `zone` value a regional feed gives rows close to its base
//                 (what the morning brief counts as "tonight, nearby")
//   metro_tz      {metro: IANA zone} for metros other than home (the calendar
//                 check reads an event's wall clock in its own zone)
//   horizon_days  how far ahead sources are fetched (default 120)
//   sources       [{key, kind, groups[], ...kind-specific fields}] — see fetchers.mjs
//   sources_file  instead of (or as well as) `sources`: a private JSON file
//                 (repo-relative) holding {sources[], metro_tz{}} — a venue
//                 catalogue kept with the installation's other data files.
//                 A list of files is read in order (sources concatenated,
//                 metro_tz merged, the first horizon_days wins); a missing
//                 file is skipped

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { instance, localConfig } = require("../instance.cjs");
const { REPO_ROOT } = require("../root.cjs");

const DEFAULTS = { home_metro: "", metros: [], near_zone: "near", metro_tz: {}, horizon_days: 120, sources: [], sources_file: null };

/**
 * Private JSON files named by a config key: one path or a list of paths
 * (repo-relative or absolute) → their parsed contents, in order. A missing
 * file is skipped (an installation may not have made it yet); a broken one throws.
 */
export function readPrivateFiles(spec, what = "file") {
  const files = (Array.isArray(spec) ? spec : [spec]).filter(Boolean);
  const out = [];
  for (const file of files) {
    try { out.push(JSON.parse(fs.readFileSync(path.isAbsolute(file) ? file : path.join(REPO_ROOT, file), "utf8")) || {}); }
    catch (e) { if (e.code !== "ENOENT") throw new Error(`${what} ${file}: ${e.message}`); }
  }
  return out;
}

function readCatalogue(spec) {
  const cats = readPrivateFiles(spec, "venue-events sources_file");
  if (!cats.length) return null;
  return {
    horizon_days: cats.map((c) => c.horizon_days).find(Boolean) || null,
    sources: cats.flatMap((c) => c.sources || []),
    metro_tz: Object.assign({}, ...cats.map((c) => c.metro_tz || {})),
  };
}

let _cfg = null;
export function venueConfig({ fresh = false } = {}) {
  if (_cfg && !fresh) return _cfg;
  const cfg = localConfig("venue-events", DEFAULTS);
  const cat = readCatalogue(cfg.sources_file);
  _cfg = {
    ...cfg,
    horizon_days: cfg.horizon_days || cat?.horizon_days || 120,
    sources: [...(cfg.sources || []), ...(cat?.sources || [])],
    metro_tz: { ...(cat?.metro_tz || {}), ...(cfg.metro_tz || {}) },
  };
  return _cfg;
}

/** The metro a row belongs to when it names none. "home" when nothing is configured. */
export const homeMetro = () => venueConfig().home_metro || "home";

/** The installation's home zone; venue calendars without an offset are read in it. */
export const homeTz = () => instance().tz || "UTC";

/** The zone label of a regional feed's near-base rows. */
export const nearZone = () => venueConfig().near_zone || "near";

/** IANA zone of a metro: home's is the instance zone; others from metro_tz; null when unknown. */
export function metroTz(metro) {
  if (!metro) return null;
  if (metro === homeMetro()) return instance().tz || null;
  const map = venueConfig().metro_tz || {};
  // A metro taken from a city name ("far city") finds its slug key ("far_city").
  return map[metro] || map[String(metro).trim().toLowerCase().replace(/[\s-]+/g, "_")] || null;
}

/** Test hook: forget the cached config (after pointing JORI_LOCAL_DIR elsewhere). */
export function resetVenueConfig() { _cfg = null; }
