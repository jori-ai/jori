"use strict";
/**
 * geo-timezone — best-effort IANA timezone for a travel_segments row.
 *
 * travel_segments has no lat/lon, just a freeform `metro` slug (derived from
 * lodging address or flight city, e.g. "springfield", "lake_town") and a
 * `place_label` ("Springfield, France — ..."). We resolve a timezone by:
 *   1. exact metro-key match against the installation's metros
 *   2. country/US-state suffix parsed from place_label
 *   3. null (caller falls back — e.g. to the phone's self-reported tz)
 *
 * Config — agent/local/config/geo-timezone.json (optional; with none, the
 * built-in cities and the country / US-state suffix rungs answer):
 *   metro_place  { "<metro key>": "<ISO 3166 code>" } — where each of the
 *                installation's own metro keys (agent/local/config/travel.json)
 *                and one-off lodging slugs is: a country ("FR") or a US state
 *                ("US-NY"), resolved through COUNTRY_CODE_TZ / US_STATE_TZ.
 */

const { localConfig } = require("./instance.cjs");

// Country name (as it appears at the end of a "City, Country" place_label) ->
// primary IANA timezone. Not exhaustive — unmatched countries fall through to
// the caller's fallback.
const COUNTRY_TZ = {
  france: "Europe/Paris",
  spain: "Europe/Madrid",
  italy: "Europe/Rome",
  portugal: "Europe/Lisbon",
  greece: "Europe/Athens",
  turkey: "Europe/Istanbul",
  israel: "Asia/Jerusalem",
  "united kingdom": "Europe/London",
  uk: "Europe/London",
  germany: "Europe/Berlin",
  netherlands: "Europe/Amsterdam",
  belgium: "Europe/Brussels",
  switzerland: "Europe/Zurich",
  croatia: "Europe/Zagreb",
  "dominican republic": "America/Santo_Domingo",
  "turks and caicos": "America/Grand_Turk",
  curacao: "America/Curacao",
  "st. lucia": "America/St_Lucia",
  "st lucia": "America/St_Lucia",
  peru: "America/Lima",
  brazil: "America/Sao_Paulo",
  india: "Asia/Kolkata",
  nepal: "Asia/Kathmandu",
};

// US state abbreviation -> IANA timezone (single-tz-dominant mapping; states
// that genuinely split zones default to their most populous zone).
const US_EASTERN = "America/New_York"; // kernel-guard-ok: the US Eastern zone in a table of every US state's zone
const US_STATE_TZ = {
  ny: US_EASTERN, nj: US_EASTERN, ct: US_EASTERN,
  ma: US_EASTERN, fl: US_EASTERN, mi: US_EASTERN,
  oh: US_EASTERN, pa: US_EASTERN, va: US_EASTERN,
  nc: US_EASTERN, ga: US_EASTERN, me: US_EASTERN,
  il: "America/Chicago", tx: "America/Chicago", mn: "America/Chicago",
  wi: "America/Chicago", mo: "America/Chicago", la: "America/Chicago",
  ca: "America/Los_Angeles", wa: "America/Los_Angeles", or: "America/Los_Angeles", nv: "America/Los_Angeles",
  az: "America/Phoenix", co: "America/Denver", ut: "America/Denver",
};

// ISO 3166-1 alpha-2 country code -> primary IANA timezone (the countries of
// COUNTRY_TZ), for the metro_place config.
const COUNTRY_CODE_TZ = {
  FR: COUNTRY_TZ.france, ES: COUNTRY_TZ.spain, IT: COUNTRY_TZ.italy, PT: COUNTRY_TZ.portugal,
  GR: COUNTRY_TZ.greece, TR: COUNTRY_TZ.turkey, IL: COUNTRY_TZ.israel, GB: COUNTRY_TZ.uk,
  DE: COUNTRY_TZ.germany, NL: COUNTRY_TZ.netherlands, BE: COUNTRY_TZ.belgium, CH: COUNTRY_TZ.switzerland,
  HR: COUNTRY_TZ.croatia, DO: COUNTRY_TZ["dominican republic"], TC: COUNTRY_TZ["turks and caicos"],
  CW: COUNTRY_TZ.curacao, LC: COUNTRY_TZ["st lucia"], PE: COUNTRY_TZ.peru, BR: COUNTRY_TZ.brazil,
  IN: COUNTRY_TZ.india, NP: COUNTRY_TZ.nepal,
};

/** The zone of an ISO 3166 code: "FR" (a country) or "US-NY" (a US state); null when unknown. */
function zoneOfPlaceCode(code) {
  const c = String(code || "").trim().toUpperCase();
  if (c.startsWith("US-")) return US_STATE_TZ[c.slice(3).toLowerCase()] || null;
  return COUNTRY_CODE_TZ[c] || null;
}

// Large cities a timeline slug commonly names, the same for every installation.
const CITY_TZ = {
  boston: US_EASTERN,
  detroit: US_EASTERN,
  chicago: "America/Chicago",
  paris: "Europe/Paris",
  lisbon: "Europe/Lisbon",
  london: "Europe/London",
  rome: "Europe/Rome",
  madrid: "Europe/Madrid",
  barcelona: "Europe/Madrid",
  athens: "Europe/Athens",
  istanbul: "Europe/Istanbul",
};

// Metro keys mapped directly: the built-in cities, then the installation's own
// metros and lodging slugs (config metro_place), which win.
function metroTzFrom(metroPlace) {
  const out = { ...CITY_TZ };
  for (const [k, code] of Object.entries(metroPlace || {})) {
    const tz = zoneOfPlaceCode(code);
    if (tz) out[String(k).toLowerCase()] = tz;
  }
  return out;
}
const METRO_TZ = metroTzFrom(localConfig("geo-timezone", { metro_place: {} }).metro_place);

function slugToWords(metro) {
  return String(metro || "").replace(/_/g, " ").trim().toLowerCase();
}

/**
 * Resolve an IANA timezone for a travel_segments row, or null if unknown.
 * @param {string} metro - canonical metro slug (e.g. "springfield")
 * @param {string} [placeLabel] - freeform label (e.g. "Springfield, France — ...")
 */
function timezoneForMetro(metro, placeLabel, metroTz = METRO_TZ) {
  const key = String(metro || "").trim().toLowerCase();
  if (!key || key === "transit") return null;
  if (metroTz[key]) return metroTz[key];

  if (placeLabel) {
    // "City, Country/ST — description" -> take the segment before the em
    // dash, then the piece after the last comma.
    const head = String(placeLabel).split(/—|-\s/)[0];
    const parts = head.split(",").map(s => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const suffix = parts[parts.length - 1].toLowerCase();
      if (COUNTRY_TZ[suffix]) return COUNTRY_TZ[suffix];
      if (/^[a-z]{2}$/.test(suffix) && US_STATE_TZ[suffix]) return US_STATE_TZ[suffix];
    }
  }

  // Bare city-name fallback (flight-leg segments have no place_label suffix).
  const words = slugToWords(key);
  for (const [name, tz] of Object.entries(metroTz)) {
    if (slugToWords(name) === words) return tz;
  }
  return null;
}

/**
 * IANA timezone at a coordinate, or null (bad input / lookup unavailable).
 * Offline polygon lookup — used to render each daily-summary stop in the local
 * time of where the user actually was.
 */
let _tzlookup;
function timezoneForCoords(lat, lon) {
  // Number(null) is 0 — a missing fix must not become the Gulf of Guinea.
  if (lat == null || lon == null || lat === "" || lon === "") return null;
  const la = Number(lat), lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
  if (Math.abs(la) > 90 || Math.abs(lo) > 180) return null;
  try {
    if (_tzlookup === undefined) {
      const mod = require("@photostructure/tz-lookup");
      _tzlookup = typeof mod === "function" ? mod : (mod.default || mod.tzlookup || null);
    }
    return _tzlookup ? _tzlookup(la, lo) || null : null;
  } catch {
    _tzlookup = null;
    return null;
  }
}

// Short zone label for a day that spans more than one zone ("CEST", "IDT").
// Intl only has names for some zones in en-US (Israel comes back "GMT+3"), so
// Asia/Jerusalem is mapped by its own DST state; anything else unnamed keeps
// the GMT string, which is still unambiguous.
function tzAbbr(tz, atMs = Date.now()) {
  if (!tz) return "";
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
      .formatToParts(new Date(atMs)).find(p => p.type === "timeZoneName")?.value || "";
    if (tz === "Asia/Jerusalem") return name === "GMT+3" ? "IDT" : "IST";
    return name;
  } catch {
    return "";
  }
}

// Zone at an instant, from the final stops: the stop containing it, else the
// nearest stop in time, else `fallback`. Used for anything that
// carries an instant but no position of its own (last activity, tasks).
function tzAtMs(stops, ms, fallback = null) {
  if (!Number.isFinite(ms)) return fallback;
  let best = null, bestD = Infinity;
  for (const s of stops || []) {
    if (!s.tz || !Number.isFinite(s.start_ts_ms) || !Number.isFinite(s.end_ts_ms)) continue;
    if (ms >= s.start_ts_ms && ms <= s.end_ts_ms) return s.tz;
    const d = Math.min(Math.abs(ms - s.start_ts_ms), Math.abs(ms - s.end_ts_ms));
    if (d < bestD) { bestD = d; best = s.tz; }
  }
  return best || fallback;
}

// Does a resolved day state any time in a zone other than its default `dayTz`?
// Not just "more than one stop zone": a long-haul flight day has the default
// zone it began in but every stop at the destination — a single stop zone
// that still differs from the day's, so wake/sleep/tasks/events must be
// re-zoned and every clock labelled exactly as on a two-zone day.
function crossesZones(tzs, dayTz) {
  if (!Array.isArray(tzs) || !tzs.length) return false;
  return tzs.length > 1 || (!!dayTz && tzs[0] !== dayTz);
}

module.exports = { timezoneForMetro, timezoneForCoords, tzAbbr, tzAtMs, crossesZones, zoneOfPlaceCode, metroTzFrom,
  METRO_TZ, CITY_TZ, COUNTRY_TZ, COUNTRY_CODE_TZ, US_STATE_TZ };
