"use strict";
/**
 * presence — resolve "where will the user be at instant T" from the canonical
 * travel timeline (a Supabase table of stays), falling back to
 * data/flights.json when no segment covers T.
 *
 * The single shared brain behind `bin/travel`, `home-presence`, the exercise
 * gate, and every event-recommendation geo-gate.
 *
 * Resolution order for an instant T:
 *   1. a timeline row covering T       → that metro (authoritative, source=db)
 *   2. gap between two known segments  → 'transit' (en route)
 *   3. flights.json derivation         → metro/transit (source=flights)
 *   4. nothing anywhere                → { metro: null } (unknown; callers
 *      fail-open — an unpopulated date should not silence everything)
 *   then (resolvePresence only) the calendar override: a resolved city whose
 *   calendar shows the user away for that instant → { metro: "elsewhere",
 *   source: "calendar" }. Weaken-only; see lib/calendar-presence.js.
 *
 * Times without a zone ("YYYY-MM-DD", "YYYY-MM-DDTHH:MM") are read in the
 * installation's home zone (instance().tz).
 *
 * Config — agent/local/config/travel.json (all optional; with none, every city
 * string slugifies to its own key, no airport code maps to a metro, there is no
 * home metro and no area):
 *   metros       [{ key, aliases: [city / district names], airports: [IATA codes] }]
 *                — canonical metro keys and the strings that map to them
 *   home_metros  [metro keys] where the user lives (no lodging refinement,
 *                home-presence's "at home")
 *   areas        [{ key, regions, towns, state, state_only_towns, stay_keys }]
 *                — a wider area that `travel in-city` treats as the metro `key`
 *                (see inArea below)
 */

const fs = require("fs");
const { fetchJson } = require("./supabase-rest.js");
const { instance, localConfig } = require("./instance.cjs");
const { installTools } = require("./root.cjs");
const CAL = require("./calendar-presence.js");

const FLIGHTS_FILE = installTools("data", "flights.json");

const CONFIG = localConfig("travel", { metros: [], home_metros: [], areas: [] });

const HOME_METROS = new Set((CONFIG.home_metros || []).map(String));
const LIVE_STATUS = new Set(["confirmed", "changed"]);

// Canonical metro keys + the aliases (city names + airport codes) that map to
// them, as [key, aliases, airport codes]. Anything not matched is slugified to
// a freeform key (stable per city).
const METRO_DEFS = (CONFIG.metros || [])
  .filter((m) => m && m.key)
  .map((m) => [String(m.key), (m.aliases || []).map((a) => String(a).toLowerCase()), (m.airports || []).map((c) => String(c).toUpperCase())]);

/**
 * An AMBIGUOUS ("Schrodinger") stay: one row that says "the user is in one of
 * these metros, and we do not yet know which." Stored as pipe-joined metro
 * keys, e.g. `city_a|city_b`.
 *
 * This is not the same as an unknown date. Unknown means the timeline has nothing
 * and every reader fails open. Ambiguous is recorded knowledge — a stretch of
 * weeks shuttling between two cities with no fixed dates, where the user should
 * be assumed to be in both. So an event in either candidate is IN, and an event
 * in some third city is AWAY, which a bare gap could never express.
 */
const AMBIGUOUS_SEP = "|";

/** ["city_a","city_b"] for an ambiguous metro value, else null. */
function ambiguousCandidates(metro) {
  const raw = String(metro || "");
  if (!raw.includes(AMBIGUOUS_SEP)) return null;
  const parts = raw.split(AMBIGUOUS_SEP).map(p => p.trim()).filter(Boolean);
  return parts.length >= 2 ? parts : null;
}

function slugify(s) {
  return String(s || "")
    .split(",")[0]
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "unknown";
}

/** Map an airport code to a metro key, or null. */
function metroFromAirport(code) {
  const c = String(code || "").toUpperCase().trim();
  if (!/^[A-Z]{3}$/.test(c)) return null;
  for (const [key, , codes] of METRO_DEFS) if (codes.includes(c)) return key;
  return null;
}

/** Map an arbitrary city / venue / location string to a canonical metro key. */
function normalizeMetro(str) {
  if (str == null) return null;
  const raw = String(str).trim();
  if (!raw) return null;
  // A pipe list ("city_a|city_b") is an ambiguous stay — normalize each part,
  // de-duplicate, and keep a stable order so the stored value is canonical.
  // ONLY the pipe separates candidates: a comma is ordinary address punctuation
  // ("Springfield, IL"), and treating it as a separator turned such a string
  // into a bogus ambiguous metro. The CLI converts a user-typed
  // "city_a,city_b" to pipes before calling here.
  if (raw.includes(AMBIGUOUS_SEP)) {
    const parts = [...new Set(raw.split(AMBIGUOUS_SEP).map(p => normalizeMetro(p)).filter(Boolean))].sort();
    if (parts.length >= 2) return parts.join(AMBIGUOUS_SEP);
    if (parts.length === 1) return parts[0];
    return null;
  }
  const lc = raw.toLowerCase();
  if (lc === "transit" || lc === "in-flight" || lc === "in flight") return "transit";
  // Exact airport code?
  const air = metroFromAirport(raw);
  if (air) return air;
  for (const [key, aliases] of METRO_DEFS) {
    for (const a of aliases) {
      // word-ish containment so "Springfield, IL" matches the alias "springfield"
      if (lc === a || lc.includes(a)) return key;
    }
  }
  return slugify(raw);
}

/** The installation's home zone (instance().tz), read once. */
let _homeTz = null;
function homeTz() {
  return (_homeTz ||= instance().tz);
}

/** UTC offset in minutes of `tz` at epoch ms `ms` (DST-aware, pure Intl). */
function zoneOffsetMinutes(ms, tz = homeTz()) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms))) parts[p.type] = p.value;
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/** Home-zone offset (e.g. "-04:00") for a YYYY-MM-DD, DST-aware. */
function getHomeOffset(dateStr, tz = homeTz()) {
  const ms = Date.parse(`${dateStr}T12:00:00Z`);
  const off = zoneOffsetMinutes(Number.isFinite(ms) ? ms : Date.now(), tz);
  const sign = off < 0 ? "-" : "+";
  const a = Math.abs(off);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

/** Home-zone calendar date (YYYY-MM-DD) for an absolute Date. */
function homeDateOf(d, tz = homeTz()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

/**
 * Parse a when-string to epoch ms.
 *   - "" / "now"                  → now
 *   - "YYYY-MM-DD"                → that date at 19:00 home time (events are evening)
 *   - "YYYY-MM-DDTHH:MM[:SS]"     → that home-zone wall-time
 *   - anything with a tz / Z      → as-is
 */
function parseWhen(str) {
  const s = String(str || "").trim();
  if (!s || s.toLowerCase() === "now") return Date.now();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) return new Date(s).getTime();
  const dateOnly = s.match(/^(\d{4}-\d{2}-\d{2})$/);
  if (dateOnly) return new Date(`${s}T19:00:00${getHomeOffset(s)}`).getTime();
  const dt = s.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(:\d{2})?$/);
  if (dt) return new Date(`${s}${s.includes(":") && dt[4] ? "" : dt[4] ? "" : ":00"}${getHomeOffset(dt[1])}`).getTime();
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : Date.now();
}

function dateOf(ts) {
  const m = String(ts || "").match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/** Fetch every timeline row sorted by arrive_at asc. [] on any failure. */
const SEGMENTS_QUERY = "/rest/v1/travel_segments?select=*&order=arrive_at.asc";

// Fail-OPEN read: a failed fetch collapses to []. Correct for presence
// resolution (where/in-city), which then falls back to flights.json so an
// unreadable timeline never silences a date. WRONG for audit/sync, where an
// empty result must mean "the timeline is empty", not "I couldn't read it".
async function fetchSegments() {
  const rows = await fetchJson(SEGMENTS_QUERY);
  return Array.isArray(rows) ? rows : [];
}

// Fail-CLOSED read: throws when the fetch fails (fetchJson returns null on
// network error / timeout / non-200 / parse error, but [] for a genuinely
// empty table). Use in audit + sync so a transient Supabase hiccup can't be
// mistaken for an empty timeline (the false "N missing_segment" alarms +
// duplicate-row re-POSTs that motivated this).
async function fetchSegmentsStrict() {
  const rows = await fetchJson(SEGMENTS_QUERY);
  if (!Array.isArray(rows)) throw new Error("travel timeline read failed (network/timeout/non-200) — refusing to treat as empty");
  return rows;
}

function loadFlights() {
  try {
    const raw = JSON.parse(fs.readFileSync(FLIGHTS_FILE, "utf8"));
    const arr = Array.isArray(raw) ? raw : (raw.bookings || raw.entries || []);
    return arr.filter(b => LIVE_STATUS.has(String(b.status || "confirmed").toLowerCase()));
  } catch {
    return [];
  }
}

/** Derive presence at instant T from flights.json. null if no signal. */
/**
 * How far past "now" a still-open stay (depart_at NULL) is allowed to assert
 * presence for a FUTURE instant.
 *
 * An open-ended stay means "the user flew here and hasn't booked the flight out
 * yet" — a solid fact about the present and the next few weeks, and pure
 * guesswork about next winter. Without a horizon the last trailing stay claims
 * all of time: a single open-ended `flights` row away from home made `travel
 * in-city <home>` answer AWAY for every date for years, so every event lane's
 * geo-gate silently suppressed every home-city recommendation indefinitely. The
 * documented fail-open ("unknown date → don't suppress") could never engage,
 * because the date was not unknown — it was confidently wrong.
 *
 * Past and present always resolve from the open stay (the user really is there). Only
 * future instants beyond the horizon fall through to unknown, where every reader
 * fails open.
 */
const OPEN_STAY_FUTURE_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;

function deriveFromFlights(instantMs, flights, nowMs = Date.now()) {
  const day = homeDateOf(new Date(instantMs));
  // In the air right now?
  for (const b of flights) {
    if (b.type !== "flight") continue;
    const dep = new Date(b.depart).getTime();
    const arr = new Date(b.arrive).getTime();
    if (Number.isFinite(dep) && Number.isFinite(arr) && instantMs >= dep && instantMs <= arr) {
      return { metro: "transit", label: `${b.from}→${b.to}`, source: "flights" };
    }
  }
  // Staying somewhere (lodging) on this date?
  for (const b of flights) {
    if (b.type !== "accommodation") continue;
    const ci = b.checkin || dateOf(b.depart);
    const co = b.checkout;
    if (!ci) continue;
    const covers = co ? (day >= ci && day < co) : (day === ci);
    if (covers) return { metro: normalizeMetro(b.location), label: b.location || b.name, source: "flights" };
  }
  // Most recent flight to land before T sets the city.
  const arrivals = flights
    .filter(b => b.type === "flight" && b.arrive && new Date(b.arrive).getTime() <= instantMs)
    .sort((a, b) => new Date(a.arrive).getTime() - new Date(b.arrive).getTime());
  const last = arrivals[arrivals.length - 1];
  if (last) {
    // Same horizon as an open-ended DB stay, and for the same reason: "the last
    // flight landed here" is a fact about now, not about next winter. Without
    // this the flights fallback re-answers everything the DB horizon just
    // declined — which is exactly what it did on the first deploy of that fix.
    const arrMs = new Date(last.arrive).getTime();
    const asserts = instantMs <= nowMs
      || instantMs <= Math.max(arrMs, nowMs) + OPEN_STAY_FUTURE_HORIZON_MS;
    if (asserts) return { metro: normalizeMetro(last.to_city || last.to), label: last.to_city || last.to, source: "flights" };
  }
  return null;
}

/**
 * Resolve presence at an instant given already-fetched segments + flights.
 *
 * Segments can overlap (a city-specific lodging stay sits inside the coarser
 * flight-airport "dest" stay; a manual correction sits over an auto stay). The
 * winner among all segments COVERING T is the most specific one = the latest to
 * have started (a lodging check-in is later than the flight landing; a manual
 * fix is entered for its window), with source=manual breaking exact ties. When
 * nothing covers T but there are stays on both sides, the user is in transit.
 */
function resolvePresenceAt(instantMs, segments, flights, nowMs = Date.now()) {
  const segs = (segments || []).filter(s => s.arrive_at)
    .map(s => ({ ...s, _arr: new Date(s.arrive_at).getTime(), _dep: s.depart_at ? new Date(s.depart_at).getTime() : null }));

  // An open-ended stay stops asserting once the instant is further out than the
  // horizon. A stay with a real depart_at is bounded and always authoritative.
  const asserts = (s) => s._dep != null
    || instantMs <= nowMs
    || instantMs <= Math.max(s._arr, nowMs) + OPEN_STAY_FUTURE_HORIZON_MS;

  const covering = segs.filter(s => s._arr <= instantMs && (s._dep == null || instantMs < s._dep) && asserts(s));
  if (covering.length) {
    covering.sort((a, b) => (a._arr - b._arr) || ((a.source === "manual" ? 1 : 0) - (b.source === "manual" ? 1 : 0)));
    const win = covering[covering.length - 1];
    const cands = ambiguousCandidates(win.metro);
    if (cands) {
      // metro stays null so every existing reader keeps its unknown/fail-open
      // branch unchanged; callers that understand ambiguity read `candidates`.
      return {
        metro: null, ambiguous: true, candidates: cands,
        label: win.place_label || cands.join(" or "), source: "db", segment_id: win.id,
      };
    }
    return { metro: win.metro, label: win.place_label || win.metro, source: "db", segment_id: win.id };
  }

  // No segment covers T — gap between two known stays = in transit.
  const prev = segs.filter(s => s._arr <= instantMs && asserts(s)).sort((a, b) => a._arr - b._arr).pop();
  const next = segs.filter(s => s._arr > instantMs).sort((a, b) => a._arr - b._arr)[0];
  if (prev && next) return { metro: "transit", label: `${prev.metro}→${next.metro}`, source: "db" };

  const fromFlights = deriveFromFlights(instantMs, flights || [], nowMs);
  if (fromFlights) return fromFlights;
  return { metro: null, label: null, source: "unknown" };
}

/**
 * Convenience: resolve presence for a when-string (async, fetches inputs).
 *
 * The calendar override (lib/calendar-presence.js) is applied here, so
 * every reader of this function — `travel in-city`/`where`, home-presence and
 * the other presence gates — inherits "the calendar beats the travel database". It can only
 * turn a resolved city into "elsewhere" (weaken-only), and with no usable
 * override file the result is exactly the timeline's. `opts.calendar: false`
 * skips it (the override's own producer needs the bare timeline).
 */
async function resolvePresence(whenStr, opts = {}) {
  const instantMs = parseWhen(whenStr);
  const [segments, flights] = [await fetchSegments(), loadFlights()];
  let res = resolvePresenceAt(instantMs, segments, flights);
  if (opts.calendar !== false) res = CAL.applyCalendarOverride(res, instantMs, CAL.loadOverrides());
  // `et_date` is the historical field name (callers read it): the home-zone date.
  return { ...res, instant: new Date(instantMs).toISOString(), et_date: homeDateOf(new Date(instantMs)) };
}

/**
 * THE shared "is the user in city X at <when>" verdict, from a resolved presence.
 * Pure. Used by `travel in-city` (every lane's geo-gate), `travel check-picks`
 * (chat's event picks) and anything else that asks the question — one place
 * owns the semantics:
 *   - the resolved metro is the target            → IN
 *   - an ambiguous stay listing the target         → IN(ambiguous)
 *   - nothing known (not strict)                   → UNKNOWN, reads IN (fail-open)
 *   - anything else, incl. a calendar "elsewhere"  → AWAY
 */
function inCityVerdict(target, res, { strict = false, accept = null } = {}) {
  // `accept`: every stored metro key that counts as the target (an area, below).
  const ok = accept || [target];
  const isTarget = ok.includes(res.metro);
  const isCandidate = res.ambiguous ? (res.candidates || []).some((c) => ok.includes(c)) : false;
  const unknown = res.metro == null && !res.ambiguous;
  const inCity = isTarget || isCandidate || (unknown && !strict);
  const verdict = isTarget ? "IN"
    : isCandidate ? "IN(ambiguous)"
    : unknown ? "UNKNOWN(fail-open)" : "AWAY";
  return { target, in: inCity, verdict, unknown, ambiguous: !!res.ambiguous };
}

/**
 * Areas, for the in-city comparison only (normalizeMetro and METRO_DEFS are
 * untouched). A metro and its wider region are one place for "can the user get
 * to this event": without this, `travel in-city "<the region>"` read AWAY while
 * a town of the region read IN, because the region slugified to its own key.
 * A listing and a stay are in the same area when both fall in it; the stay side
 * by its stored key (stayKeys), so a stay stored as a town's or the region's
 * slug still matches a listing for the metro.
 *
 * An area (config `areas[]`):
 *   key               the metro key it counts as
 *   regions           names of the region itself ("<county>", "<region>")
 *   towns             towns of the area that are named nowhere else of note
 *   state             the state / province names that are address structure here
 *   state_only_towns  towns that count only when the state is also named (a
 *                     bare name another metro owns)
 *   stay_keys         further stored metro keys inside the area
 */
const US_PARTS = new Set(["usa", "us", "united states"]);
const isUsPart = (p) => US_PARTS.has(p) || p.startsWith("united states of ");
const AREAS = (CONFIG.areas || []).filter((a) => a && a.key).map((a) => {
  const low = (xs) => new Set((xs || []).map((x) => String(x).toLowerCase()));
  const area = { key: String(a.key), regions: low(a.regions), towns: low(a.towns), state: low(a.state), stateOnly: low(a.state_only_towns) };
  area.stayKeys = [...new Set([area.key, ...(a.stay_keys || []).map(String), ...[...area.regions, ...area.towns].map(slugify)])];
  return area;
});

/**
 * Is this listing in `area`? Pure. Reads the comma parts of an address as
 * structure: venue/street first, then city, then state + ZIP, then country.
 *   - a town of the area (or anything normalizeMetro calls the area's metro)
 *     decides, unless a part AFTER it is something else ("<town>, <elsewhere>");
 *   - a region decides only when every other part is the area, its state, a
 *     ZIP or the US: "<other town>, <region>" is the other town, and a region
 *     name inside a longer name ("University of <region>") is not a region.
 */
function inArea(place, area) {
  if (!area) return false;
  const parts = String(place || "").toLowerCase().split(",").map((p) => p.trim()).filter(Boolean);
  const bare = parts.map((p) => {
    const w = p.split(" ").filter(Boolean);
    // lang-regex-ok: a US ZIP code is address structure
    return w.length && /^\d{5}(?:-\d{4})?$/.test(w[w.length - 1]) ? w.slice(0, -1).join(" ") : p;
  });
  const inState = bare.some((p) => area.state.has(p));
  const kinds = bare.map((p) => {
    if (!p || area.state.has(p) || isUsPart(p)) return "structure";
    if (area.regions.has(p)) return "region";
    if (area.towns.has(p) || (inState && area.stateOnly.has(p)) || normalizeMetro(p) === area.key) return "town";
    return "other";
  });
  const firstArea = kinds.findIndex((k) => k === "region" || k === "town");
  if (firstArea < 0 || kinds.slice(firstArea).includes("other")) return false;
  return kinds.includes("town") || !kinds.includes("other");
}

/** What `travel in-city <place>` compares: { key, accept } for inCityVerdict. Pure. */
function inCityTarget(place) {
  for (const area of AREAS) if (inArea(place, area)) return { key: area.key, accept: area.stayKeys };
  const key = normalizeMetro(place);
  return { key, accept: [key] };
}

/** Async convenience: is the user in `place` at `when`? → inCityVerdict + the resolution. */
async function isInCity(place, when, opts = {}) {
  const t = inCityTarget(place);
  const res = await resolvePresence(when, opts);
  return { ...inCityVerdict(t.key, res, { ...opts, accept: t.accept }), res };
}

module.exports = {
  HOME_METROS, METRO_DEFS,
  normalizeMetro, metroFromAirport, slugify, ambiguousCandidates, AMBIGUOUS_SEP,
  getHomeOffset, homeDateOf, zoneOffsetMinutes, homeTz, parseWhen, dateOf,
  // The historical names (callers outside this file still use them).
  getETOffset: getHomeOffset, etDateOf: homeDateOf,
  fetchSegments, fetchSegmentsStrict, loadFlights, deriveFromFlights, resolvePresenceAt, resolvePresence,
  inCityVerdict, isInCity, inCityTarget, inArea, AREAS,
  OPEN_STAY_FUTURE_HORIZON_MS,
  FLIGHTS_FILE,
};
