// calendar-place — was the user at the place on their calendar? Geometry, not words.
//
// The requirement: if the calendar already identifies a stop, don't ask about
// it. The case: an event "Print & Coffee", 09:00–10:00, at a street address in
// a big city; the user was in the print shop at that address at 09:25–09:37.
// Three things missed it:
//   - stop-passage withdrew the stop as a walk and never looked at the calendar
//     (Jev sees calendar events, but only on inconclusive windows);
//   - stop-identify's calendar rung matched on shared address WORDS and fails
//     silently when gog does, so the passage check ran instead;
//   - resolve-day's `location_match` is the same word-overlap test — which
//     also says a street named after a city matches every event in that city.
//
// So: geocode the event's own `location` once (cached forever, negatives too),
// and call it a match only when a point the user was actually AT inside the window —
// a precise fix, a photo, or the visit row — lies within CAL_MATCH_M of it.
// Time overlap alone is never enough: an all-day or multi-hour block overlaps
// every stop in it.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { haversineMeters } = require("./stop-rests.js");

const { installTools } = require("./root.cjs");
// gog: $GOG_BIN, else a package-manager install (launchd's PATH has neither), else PATH.
const GOG = process.env.GOG_BIN || ["/opt/homebrew/bin/gog", "/usr/local/bin/gog"].find((p) => fs.existsSync(p)) || "gog";
const VERIFY_BIN = installTools("bin", "trip-place-verify");
export const CACHE_FILE = installTools("data", "calendar-geocode-cache.json");

// A street-address geocode lands on the building's frontage; GPS in a shop
// runs 15–40 m. 150 m covers both without reaching the next block's venue.
export const CAL_MATCH_M = 150;
// Longer than this is a block of the day ("<a city>", "Stay at ..."), not a place.
export const CAL_MAX_EVENT_MIN = 6 * 60;
// A geocode that failed is retried after this long (the event may get edited).
const NEG_TTL_MS = 7 * 24 * 3600 * 1000;
const URL_LIKE = /^(https?:\/\/|zoom\.|meet\.google|teams\.microsoft)/i;

const iso = (t) => new Date(t).toISOString();

/** Calendar events overlapping [s, e]. `error` is set when gog failed — the
 *  caller must say so, never read it as "no events". */
export function listEvents(s, e, { gog = GOG } = {}) {
  const r = spawnSync(gog, ["calendar", "list", "--json", "--results-only", "--from", iso(s), "--to", iso(e), "--all"],
    { encoding: "utf8", timeout: 15000 });
  if (r.status !== 0) return { events: [], error: (r.stderr || r.error?.message || `exit ${r.status}`).trim().slice(0, 200) };
  try {
    const parsed = JSON.parse(r.stdout || "[]");
    const events = Array.isArray(parsed) ? parsed : (parsed.events || parsed.items || []);
    return { events, error: null };
  } catch (err) {
    return { events: [], error: `unparseable gog output: ${err.message}` };
  }
}

/** Events that could place the user somewhere: timed, opaque, a physical location,
 *  overlapping the window, not a whole-day block. */
export function placeEvents(events, s, e) {
  const out = [];
  for (const ev of events || []) {
    if ((ev.transparency || "opaque") === "transparent") continue;
    const loc = (ev.location || "").trim();
    if (!loc || URL_LIKE.test(loc)) continue;
    const st = ev.start?.dateTime, en = ev.end?.dateTime;
    if (!st || !en) continue; // all-day
    const sMs = Date.parse(st), eMs = Date.parse(en);
    if (!(eMs > sMs) || (eMs - sMs) / 60000 > CAL_MAX_EVENT_MIN) continue;
    if (!(sMs < e && eMs > s)) continue;
    out.push({ summary: (ev.summary || "").trim(), location: loc, start: st, end: en, start_ms: sMs, end_ms: eMs });
  }
  return out;
}

function loadCache(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
}
function saveCache(file, cache) {
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 1));
    fs.renameSync(tmp, file);
  } catch { /* a lost cache entry costs one more lookup, nothing else */ }
}

/** {lat, lon, name, address} for a calendar location string, or null. Cached
 *  by the exact string; biased (not filtered) toward where the user was. */
export function geocodeLocation(location, nearLat, nearLon, { cacheFile = CACHE_FILE, verifyBin = VERIFY_BIN, now = Date.now() } = {}) {
  const key = location.trim();
  const cache = loadCache(cacheFile);
  const hit = cache[key];
  // v2 entries know whether Google returned a BUSINESS or a bare address.
  if (hit && hit.v === 2 && (hit.lat != null || now - Date.parse(hit.at) < NEG_TTL_MS)) return hit.lat != null ? hit : null;
  const r = spawnSync(verifyBin, [key, String(nearLat), String(nearLon)], { encoding: "utf8", timeout: 30000 });
  // Exit 3 = Places budget stop. Not a fact about the address — don't cache it.
  if (r.status === 3 || r.error) return null;
  let entry = { v: 2, lat: null, lon: null, at: new Date(now).toISOString() };
  if (r.status === 0 && r.stdout) {
    try {
      const p = JSON.parse(r.stdout);
      if (Number.isFinite(p.lat) && Number.isFinite(p.lon))
        // A business has a type and usually ratings; a bare address
        // ("Jerusalem Blvd 37") has neither.
        entry = { v: 2, lat: p.lat, lon: p.lon, name: p.name || null, address: p.address || null,
                  is_business: !!(p.kind || p.rating != null || p.businessStatus), kind: p.kind || null, at: entry.at };
    } catch { /* negative */ }
  }
  cache[key] = entry;
  saveCache(cacheFile, cache);
  return entry.lat != null ? entry : null;
}

/**
 * The calendar event the user was AT during [start, end], or null.
 * @param points  [{lat, lon, acc?}] — precise fixes / photos inside the window,
 *                plus the visit row's own position. Loose fixes are the caller's
 *                to drop; this only measures.
 * @returns {{match: object|null, error: string|null, checked: number}}
 */
export function calendarPlaceAt({ start, end, points }, deps = {}) {
  const s = typeof start === "number" ? start : Date.parse(start);
  const e = typeof end === "number" ? end : Date.parse(end);
  const pts = (points || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (!pts.length) return { match: null, error: null, checked: 0 };
  const { events, error } = (deps.listEvents || listEvents)(s, e);
  const cands = placeEvents(events, s, e);
  const anchor = pts[Math.floor(pts.length / 2)];
  let best = null;
  for (const ev of cands) {
    const geo = (deps.geocode || geocodeLocation)(ev.location, anchor.lat, anchor.lon);
    if (!geo) continue;
    const d = Math.min(...pts.map((p) => haversineMeters(p.lat, p.lon, geo.lat, geo.lon)));
    if (d > CAL_MATCH_M) continue;
    // The tightest event wins: a 1-hour "Print & Coffee" over a 4-hour "Errands".
    const dur = ev.end_ms - ev.start_ms;
    if (!best || dur < best.end_ms - best.start_ms || (dur === best.end_ms - best.start_ms && d < best.distance_m))
      best = { ...ev, lat: geo.lat, lon: geo.lon, place_name: geo.name || null, is_business: !!geo.is_business,
               kind: geo.kind || null, distance_m: Math.round(d) };
  }
  return { match: best, error, checked: cands.length };
}

// ---------------------------------------------------------------------------
// Which PLACE the calendar event names. An event's title is the user's name
// for the event, not a location: locations are only in the meeting location
// field, and everything else is a hint. The stop had been written up as
// "Print & Coffee"; the shop was a print shop with its own name, at exactly
// the event's address — 27 m from where the user stood, but one of 18 businesses within 35 m and typed electronics_store, so
// no proximity ranking would ever have picked it.
//
//   1. The location geocodes to a business → that business.
//   2. It geocodes to an address → the businesses AT that address (≤ VENUE_AT_ADDRESS_M
//      of the geocode), and Jev (site calendar-venue) picks one using the event
//      TITLE as a hint and the photos the user took there.
//   3. Otherwise the location itself names the stop ("<street> 37").
// The title is never a name.
// ---------------------------------------------------------------------------
export const VENUE_AT_ADDRESS_M = 30;
const ROOT_BIN = installTools("bin");

/** Businesses within radius of a point, via location-segment's cached searchNearby. */
export function businessesNear(lat, lon, radiusM = VENUE_AT_ADDRESS_M) {
  const py = `import json,sys
from importlib.machinery import SourceFileLoader
m=SourceFileLoader("ls",${JSON.stringify(path.join(ROOT_BIN, "location-segment"))}).load_module()
print(json.dumps(m.google_places_nearby(${Number(lat)},${Number(lon)},${Number(radiusM)})))`;
  const r = spawnSync("python3", ["-c", py], { encoding: "utf8", timeout: 30000 });
  try { return JSON.parse((r.stdout || "").trim().split("\n").pop() || "[]"); } catch { return []; }
}

const words = (m) => (m < 15 ? "right there" : m < 40 ? `about ${Math.round(m / 5) * 5} m away` : `about ${Math.round(m / 10) * 10} m away`);

/**
 * @param match   a calendarPlaceAt() match
 * @param photos  [{labels[], detected_text}] the user took during the window (hints)
 * @returns {Promise<{name:string, source:"calendar_business"|"calendar_venue"|"calendar_address", candidates?:number}>}
 */
export async function venueForCalendarMatch(match, { photos = [], id = null, near = businessesNear, decideImpl = null } = {}) {
  const address = (match.place_name || match.location.split(",")[0]).trim();
  if (match.is_business && match.place_name) return { name: match.place_name, source: "calendar_business" };
  const cands = (near(match.lat, match.lon, VENUE_AT_ADDRESS_M) || [])
    .filter((p) => p && p.name && p.distance_m <= VENUE_AT_ADDRESS_M).slice(0, 12);
  if (!cands.length) return { name: address, source: "calendar_address", candidates: 0 };
  const { decide } = decideImpl ? { decide: decideImpl } : await import("./jev-shadow.mjs");
  const { answerConfidence, jevSiteDef } = await import("./jev.mjs");
  const tpl = jevSiteDef("calendar-venue")?.venue_template;
  if (!tpl) return { name: address, source: "calendar_address", candidates: cands.length };
  const criteria = {};
  cands.forEach((c, i) => { criteria[`c${i}`] = `${c.name}${c.primary_type ? ` (${c.primary_type.replace(/_/g, " ")})` : ""}`; }); // lang-regex-ok: formatting a Places type id
  Object.assign(criteria, tpl.fixed_criteria);
  const { value, jev } = await decide({
    site: "calendar-venue",
    id,
    state: {
      calendar_event_title_hint: match.summary || null,
      calendar_event_location: match.location,
      businesses_at_that_address: cands.map((c, i) => ({ id: `c${i}`, name: c.name, type: c.primary_type || null,
        from_the_address: words(c.distance_m) })),
      photos_he_took_there: photos.slice(0, 6).map((p) => ({
        shows: Array.isArray(p.labels) ? p.labels.slice(0, 15) : [],
        text: Array.isArray(p.detected_text) ? p.detected_text.join(" ").slice(0, 150) : null,
      })),
    },
    questions: { venue: { ...tpl, criteria } },
    interpret: (answers) => {
      const a = answers.venue;
      const pick = a && a.choice;
      const c = pick && pick.startsWith("c") ? cands[Number(pick.slice(1))] : null;
      return { value: c ? c.name : null, confidence: answerConfidence(a) };
    },
    legacy: async () => null, // before 2026-10-08 there was no pick at all
    alwaysShadow: false,
    same: () => null,         // legacy is a constant; the user's corrections are the ground truth
  });
  if (value) return { name: value, source: "calendar_venue", candidates: cands.length };
  // Split between businesses at the address (the print shop and a "canvas
  // printing" listing, both at the event's address, both fitting a photo
  // of a desk and framed prints). That is a one-tap question with just those
  // options — not a silent address, and not a guess.
  const probs = jev && jev.answers && jev.answers.venue && jev.answers.venue.probabilities;
  const shortlist = probs ? Object.entries(probs)
    .filter(([k, p]) => k.startsWith("c") && p >= SHORTLIST_MIN_P)
    .sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, p]) => ({ ...cands[Number(k.slice(1))], p: Math.round(p * 100) / 100 }))
    .filter((c) => c && c.name) : [];
  if (shortlist.length) return { name: null, address, source: "calendar_ambiguous", shortlist, candidates: cands.length };
  return { name: address, source: "calendar_address", candidates: cands.length };
}
const SHORTLIST_MIN_P = 0.15;
