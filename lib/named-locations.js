"use strict";
// named-locations.js — the JS reader of data/named-locations.json, the one
// list of the user's homes and family homes. place_naming.py (location-segment,
// location-current-stop, stop-identify) and `findme` read the same file, so the
// day resolver cannot disagree with them about what "at a family home" means.
//
// A stop that reaches the day through the spine (addSpineDwells) carries the
// visit row's street address and never asks a naming rung, so a long stop at a
// family home the user had already named came back as a bare street address.
// See nameSpineDwells in resolve-day.js.

const fs = require("node:fs");
const path = require("node:path");
const { haversineMeters } = require(path.join(__dirname, "known-stops.js"));
const { installTools } = require("./root.cjs");

// The installation's list, read per call (a test that points HOME or
// JORI_HOME at a sandbox sees its own). Absent in a fresh install: no homes.
const defaultPath = () => installTools("data", "named-locations.json");

// Same 150 m as place_naming.NAMED_LOCATION_MATCH_M and live-day's
// GEOFENCE_YIELD_M — the three must agree.
const NAMED_LOCATION_MATCH_M = 150;

// A missing or unreadable file reads as empty: naming falls through to the
// other rungs instead of failing the day.
function loadNamedLocations(filePath = process.env.JORI_NAMED_LOCATIONS_FILE || defaultPath()) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const items = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.entries) ? raw.entries : []);
    return items.filter(e => e && e.name && Number.isFinite(e.lat) && Number.isFinite(e.lon));
  } catch (_) {
    return [];
  }
}

// The closest named location within radiusM, or null: { entry, distance_m }.
function matchNamedLocation(entries, lat, lon, radiusM = NAMED_LOCATION_MATCH_M) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  let best = null;
  for (const e of entries || []) {
    const d = haversineMeters(lat, lon, e.lat, e.lon);
    if (d <= radiusM && (!best || d < best.distance_m)) best = { entry: e, distance_m: d };
  }
  return best;
}

// ---------------------------------------------------------------------------
// By ADDRESS. Geocoders and the user's own records can disagree on a street's
// language (a Hebrew street name transliterated or translated into English)
// AND on its house number (three numbers for one house), so address matching
// must be transliteration/translation-aware, and a model, not a regex, decides
// (Rule #0b).
//
// So a home is also recognised by its street address. Code picks which homes a
// stop COULD be (geometry, below); a model reads the addresses
// (lib/address-match.mjs) and its answer is kept, so one geocoder label
// is judged once. An entry with an address and no coordinates (a family home
// the wiki has an address for and the user has never confirmed a stop at) is
// matched this way only, inside its `tz`.
// ---------------------------------------------------------------------------

// A stop this far from a home's recorded spot can still be that home when its
// own geocoded address says so: a visit cluster's centroid can sit 300 m off
// the door (a 305 m overnight cluster has been seen), and the geocoder labels the
// point it was handed. Further than this is another neighbourhood, where a
// street of the same name is a different street.
const ADDRESS_NEAR_M = 500;

// Every entry that carries an address: those with coordinates, and address-only
// entries that say which timezone they are in (without one there is no bound on
// where the address could be, and one street name recurs in many towns).
function loadAddressHomes(filePath = process.env.JORI_NAMED_LOCATIONS_FILE || defaultPath()) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const items = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.entries) ? raw.entries : []);
    return items.filter(e => e && e.name && typeof e.address === "string" && e.address.trim()
      && ((Number.isFinite(e.lat) && Number.isFinite(e.lon)) || (typeof e.tz === "string" && e.tz)));
  } catch (_) {
    return [];
  }
}

// The homes a stop at (lat, lon) could be by address: within ADDRESS_NEAR_M of
// one with coordinates, or address-only in the stop's own timezone `tz`.
// Geometry only; whether it IS that home is the model's call.
function addressCandidates(entries, lat, lon, tz = null) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
  const out = [];
  for (const e of entries || []) {
    if (!e || !e.address) continue;
    if (Number.isFinite(e.lat) && Number.isFinite(e.lon)) {
      const d = haversineMeters(lat, lon, e.lat, e.lon);
      if (d <= ADDRESS_NEAR_M) out.push({ entry: e, distance_m: d });
    } else if (tz && e.tz === tz) {
      out.push({ entry: e, distance_m: null });
    }
  }
  return out;
}

module.exports = { NAMED_LOCATION_MATCH_M, ADDRESS_NEAR_M, loadNamedLocations, matchNamedLocation,
                   loadAddressHomes, addressCandidates };
