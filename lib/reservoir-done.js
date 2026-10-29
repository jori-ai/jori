"use strict";
// reservoir-done — decide which area-reservoir entries the user has already been to.
//
// The reservoir is the standing "what's worth doing here" inventory per trip leg.
// Once the user has actually been somewhere it should read as done rather than as a
// suggestion — struck through, never removed (a place already seen is still part of
// the trip's record, and un-done-ing a false positive has to stay possible).
//
// Evidence, strongest first:
//   1. summary-name  — the place is named in a daily_summaries narrative or in
//                      the chat/corrections the user gave that day. This is the
//                      most accurate signal available: the daily-summary pipeline
//                      already vetted it against chat + transactions + Places,
//                      and it catches visits that never became a named stop
//                      ("we went to the sub base").
//   2. summary-stop  — a resolved stop in resolved_day_json sits within RADIUS.
//                      Also vetted (Google Places, with a confidence score).
//   3. gps-visit     — a location_history *visit* row sits within RADIUS.
//   4. gps-transit   — the travel path passed within RADIUS. Weakest: it means
//                      "drove past", not "went".
//
// Tuning is deliberately loose: a false strike is preferred to a miss (it is
// unlikely anyway without having been in the area). So: no dwell requirement, a
// generous radius, and transit counts. A false strike costs a place the user
// might have revisited; a miss leaves stale clutter in the guide to filter
// mentally forever. The first is the cheaper failure. Every mark records its evidence so a wrong one is auditable
// and reversible rather than a silent rewrite.
//
// No trip-start date is needed: a place only matches if the user was physically near
// it, so days spent on another continent can never strike a French entry. The
// window is just a cost bound on how much history we scan.

const RADIUS_M = 300;

function stripAccents(s) {
  return (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function norm(s) {
  return stripAccents(s)
    .toLowerCase()
    .replace(/[’'`]/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Words too generic to carry a match on their own ("market", "old town").
const STOPWORDS = new Set([
  "le", "la", "les", "de", "du", "des", "the", "and", "aux", "sur", "of", "near",
  "from", "with", "for", "your", "you", "ll", "its",
]);

function tokens(s) {
  return norm(s).split(" ").filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/** Great-circle metres between two lat/lon pairs. */
function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const dPhi = rad(lat2 - lat1);
  const dLam = rad(lon2 - lon1);
  const a =
    Math.sin(dPhi / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLam / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Match one reservoir entry against the trip evidence.
 *
 * @param {object} entry              reservoir entry ({name, lat, lon, ...})
 * @param {object} ev
 * @param {string} ev.summaryText     normalized narrative + chat text, all days
 * @param {Array}  ev.summaryStops    [{name, lat, lon, date}]
 * @param {Array}  ev.gpsVisits       [{place_name, latitude, longitude, arrived_at}]
 * @param {Array}  ev.gpsTransit      [{latitude, longitude, arrived_at}]
 * @param {number} [ev.radiusM]
 * @returns {null | {via, evidence, date}}
 */
function matchEntry(entry, ev) {
  if (!entry || !entry.name) return null;
  const radius = ev.radiusM || RADIUS_M;
  const full = norm(entry.name);
  const et = tokens(entry.name);

  // 1. Named outright in a vetted daily summary / the user's own chat.
  if (full.length > 6 && ev.summaryText && ev.summaryText.includes(full)) {
    return { via: "summary-name", evidence: `named in a daily summary`, date: null };
  }

  // 2. A resolved summary stop nearby.
  let bestStop = null;
  for (const s of ev.summaryStops || []) {
    if (!s.lat || !entry.lat) continue;
    const d = haversineM(entry.lat, entry.lon, s.lat, s.lon);
    if (d > radius) continue;
    // Prefer a stop whose own name shares a word with the entry — that's a real
    // identification rather than just "something happened nearby".
    const overlap = tokens(s.name).filter((t) => et.includes(t)).length;
    const score = overlap > 0 ? 2 : 1;
    if (!bestStop || score > bestStop.score || d < bestStop.d) {
      bestStop = { score, d, s };
    }
  }
  if (bestStop) {
    return {
      via: "summary-stop",
      evidence: `stop "${bestStop.s.name}" ${Math.round(bestStop.d)}m away`,
      date: bestStop.s.date || null,
    };
  }

  // 3. A GPS visit nearby.
  for (const v of ev.gpsVisits || []) {
    if (!entry.lat || !v.latitude) continue;
    const d = haversineM(entry.lat, entry.lon, v.latitude, v.longitude);
    if (d <= radius) {
      return {
        via: "gps-visit",
        evidence: `GPS visit${v.place_name ? ` "${v.place_name}"` : ""} ${Math.round(d)}m away`,
        date: (v.arrived_at || "").slice(0, 10) || null,
      };
    }
  }

  // 4. Drove past. Weakest evidence — recorded as such so it can be reviewed.
  for (const t of ev.gpsTransit || []) {
    if (!entry.lat || !t.latitude) continue;
    const d = haversineM(entry.lat, entry.lon, t.latitude, t.longitude);
    if (d <= radius) {
      return {
        via: "gps-transit",
        evidence: `passed within ${Math.round(d)}m`,
        date: (t.arrived_at || "").slice(0, 10) || null,
      };
    }
  }

  return null;
}

/**
 * Mark entries done in-place on a reservoir's `structured` object.
 *
 * Writes the reservoir's OWN annotation field, `state` ("open" -> "done"), not a
 * parallel flag: the reservoir build's carryAnnotations() re-applies `state`
 * (with skip_reason/felt) onto freshly-researched entries on every rebuild, so
 * anything stored outside it would be silently wiped the next time an area is
 * rebuilt. The `done_*` fields ride alongside as provenance and are carried
 * forward by the same function.
 *
 * Only touches entries that are still "open" — a `skipped` entry (the user ruled
 * it out) or an already-`done` one is left exactly as it is. Never unsets, never
 * removes: struck through, still on the list.
 *
 * @returns {{marked: Array, already: number}}
 */
function markReservoir(reservoir, ev, { now = null } = {}) {
  const stamp = now || new Date().toISOString();
  const marked = [];
  let already = 0;
  for (const [bucket, arr] of Object.entries(reservoir.buckets || {})) {
    if (!Array.isArray(arr)) continue;
    for (const entry of arr) {
      // food_specialties entries are a DISH, not a place — they carry `dish`/
      // `best_place` and no `name`, and "was the galette eaten" is not something
      // proximity can answer. They're deliberately left to the site's manual
      // done/undone button (foods are often missing from the daily summary, so the
      // manual button is the main way they get marked).
      if (!entry || !entry.name) continue;
      // The user's own call, made on the site, always wins: the sweep must never
      // re-strike something just un-struck by hand, or an unmark silently reverts
      // overnight and the button looks broken.
      if (entry.manual) { already++; continue; }
      if (entry.state && entry.state !== "open") { already++; continue; }
      const hit = matchEntry(entry, ev);
      if (!hit) continue;
      entry.state = "done";
      entry.done_at = stamp;
      entry.done_date = hit.date;
      entry.done_source = hit.via;
      entry.done_evidence = hit.evidence;
      delete entry.done; // legacy boolean from this tool's first cut — state is canonical
      marked.push({ bucket, name: entry.name, ...hit });
    }
  }
  return { marked, already };
}

module.exports = { matchEntry, markReservoir, haversineM, norm, tokens, RADIUS_M };
