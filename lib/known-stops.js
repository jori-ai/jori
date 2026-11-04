"use strict";
// known-stops.js — loader for data/known-recurring-stops.json with
// strict filtering of meta/example entries.
//
// The file has a documented schema that mixes structural meta-fields
// (`_comment`, `_updated`, `_match_rules`) with an `entries[]` array of
// real stops. An earlier version of the file also carried an `_example`
// placeholder entry. **Any entry whose key begins with `_` or whose
// payload is marked `_example: true`** (or whose `address` still carries
// a `<placeholder>` token) is dropped at load time, so a placeholder can
// never be matched as a real place — and it is the
// rule every future consumer (resolve-day, findme enrich, location-stops)
// shares through this one helper so no future caller has to re-derive it.

const fs = require("node:fs");
const { installTools } = require("./root.cjs");

// The installation's list (absent in a fresh install: no entries).
const DEFAULT_PATH = installTools("data", "known-recurring-stops.json");

const DAY_NAMES = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

function isPlaceholderAddress(addr) {
  if (!addr || typeof addr !== "string") return false;
  // Matches "<replace with canonical>" style placeholders — never a real address.
  return /<[^>]+>/.test(addr) || /replace\s+with/i.test(addr);
}

function looksLikeExampleEntry(entry) {
  if (!entry || typeof entry !== "object") return true;
  if (entry._example === true) return true;
  if (isPlaceholderAddress(entry.address)) return true;
  return false;
}

function loadKnownStops(filePath = DEFAULT_PATH) {
  let raw;
  try { raw = fs.readFileSync(filePath, "utf8"); }
  catch (err) {
    if (err.code === "ENOENT") return { entries: [], path: filePath, missing: true };
    throw err;
  }

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (err) {
    const e = new Error(`known-recurring-stops.json is not valid JSON: ${err.message}`);
    e.cause = err;
    throw e;
  }

  // The file's shape is an object with an `entries` array plus sibling
  // meta-fields prefixed with `_`. Newer callers may also hand us a plain
  // array; tolerate either shape.
  let entries;
  if (Array.isArray(parsed)) entries = parsed;
  else if (Array.isArray(parsed.entries)) entries = parsed.entries;
  else entries = [];

  const filtered = entries.filter(e => !looksLikeExampleEntry(e));

  return {
    path: filePath,
    entries: filtered,
    filteredOut: entries.length - filtered.length,
    missing: false,
  };
}

function matchesWeekday(entry, dateStr) {
  const rule = entry.weekday;
  if (rule == null || rule === "any") return true;
  // JS Date parses YYYY-MM-DD as UTC midnight; use noon so TZ shifts don't
  // flip the weekday.
  const d = new Date(`${dateStr}T12:00:00`);
  const dow = d.getDay(); // 0=Sun … 6=Sat in the host's local time, the home zone.
  if (rule === "weekday") return dow >= 1 && dow <= 5;
  if (rule === "weekend") return dow === 0 || dow === 6;
  const target = DAY_NAMES[String(rule).toLowerCase().slice(0, 3)];
  if (target == null) return false;
  return dow === target;
}

function parseHM(hm) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hm || ""));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function matchesTimeRange(entry, stopStartHM, stopEndHM) {
  const rng = entry.time_range;
  if (!rng) return true;
  const m = /^(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})$/.exec(String(rng));
  if (!m) return true;
  const rngStart = parseHM(m[1]);
  const rngEnd = parseHM(m[2]);
  const stopStart = parseHM(stopStartHM);
  const stopEnd = parseHM(stopEndHM);
  if (rngStart == null || rngEnd == null || stopStart == null || stopEnd == null) return true;
  // Overlap with a ±30 min buffer on each side (schema documents this).
  const buf = 30;
  return stopEnd + buf >= rngStart && stopStart - buf <= rngEnd;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

function matchesProximity(entry, stopLat, stopLon) {
  const coords = entry.coords;
  if (!coords || !Array.isArray(coords) || coords.length < 2) {
    // No coords on the entry means we can't do proximity. Caller must
    // geocode the address externally and re-check, or accept this as a
    // weekday+time-only match (lower confidence).
    return { ok: null, distance_m: null };
  }
  const [eLat, eLon] = coords;
  const prox = Number.isFinite(entry.proximity_m) ? entry.proximity_m : 120;
  const dist = haversineMeters(stopLat, stopLon, eLat, eLon);
  return { ok: dist <= prox, distance_m: dist };
}

// Find the best match for a stop among loaded entries. Returns the entry
// plus a match shape, or null when nothing matches.
//
// Entries without `coords` populated are NEVER a match — we cannot verify
// the GPS cluster is actually near the named place without a coordinate
// to compare against. This is intentional: silently matching on name
// alone would recreate the same "synthesized visit" class of bug that
// motivated this whole redesign. The loader already warns about entries
// with null coords; it's the file-author's job to populate them (or a
// future one-time geocode pass).
function matchStop(entries, { date, stopStartHM, stopEndHM, lat, lon }) {
  let best = null;
  for (const e of entries) {
    if (!matchesWeekday(e, date)) continue;
    if (!matchesTimeRange(e, stopStartHM, stopEndHM)) continue;
    const prox = matchesProximity(e, lat, lon);
    if (prox.ok !== true) continue;
    const candidate = { entry: e, distance_m: prox.distance_m, coords_matched: true };
    if (!best) best = candidate;
    else if (candidate.distance_m < best.distance_m) best = candidate;
  }
  return best;
}

// Useful at load time / CLI startup: return a list of entries missing
// coords so the caller can warn the user once.
function entriesMissingCoords(entries) {
  return (entries || []).filter(e => {
    const c = e && e.coords;
    return !c || !Array.isArray(c) || c.length < 2;
  });
}

module.exports = {
  loadKnownStops,
  matchStop,
  matchesWeekday,
  matchesTimeRange,
  matchesProximity,
  entriesMissingCoords,
  haversineMeters,
  DEFAULT_PATH,
};
