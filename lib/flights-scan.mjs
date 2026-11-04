// flights-scan.mjs — the code half of bin/flights-scan-run.
//
// Gmail queries (sender-domain, language-agnostic), the flights.json merge,
// and the calendar event shapes + reconciliation decisions. Every rule here
// is transcribed from jobs/flights-scan.md, where the agent used to apply it
// by hand; the only model work left is reading each confirmation email (any
// language) into a typed record.
//
// Flight UTC offsets are code's too (2026-10-20): the model reads the clock
// time printed for each airport, and stationTime() attaches the offset that
// airport's IANA zone really has on that date (data/airport-tz.json).

import fs from "node:fs";
import { createRequire } from "node:module";

const { localConfig } = createRequire(import.meta.url)("./instance.cjs");

// Which senders count as travel bookings, and the address the user forwards
// bookings to (a trip organiser's inbound address; its sent mail is a booking
// source of its own). agent/local/config/flights-scan.json: `airline_domains`,
// `stay_domains`, `car_domains` (replace these lists; `extend_<key>` appends)
// and `forward_address` (none → no forward query).
const CONFIG = localConfig("flights-scan", {
  airline_domains: ["aa.com", "americanairlines.com", "delta.com", "united.com", "airfrance.com", "klm.com", "british-airways.com", "emirates.com", "turkishairlines.com", "ana.co.jp", "jal.com"],
  stay_domains: ["booking.com", "hotels.com", "expedia.com", "vrbo.com", "marriott.com", "hilton.com", "hyatt.com"],
  car_domains: ["hertz.com", "enterprise.com", "avis.com", "budget.com", "alamo.com", "nationalcar.com", "sixt.com"],
  forward_address: "",
});

export const AIRLINES = CONFIG.airline_domains;
export const STAYS = CONFIG.stay_domains;
export const CARS = CONFIG.car_domains;
export const FORWARD_ADDRESS = CONFIG.forward_address || "";

/** The forward query (mail the user sent to the trip organiser), or null when none is configured. */
export function forwardQuery(afterEpochSec, forwardAddress = FORWARD_ADDRESS) {
  return forwardAddress ? `in:sent to:${forwardAddress} after:${afterEpochSec}` : null;
}

/**
 * Gmail queries for the window. Domain sweeps carry no subject filter (some
 * airlines confirm in languages other than English). The forward query, when
 * configured, comes first.
 */
export function gmailQueries(afterEpochSec, { airlines = AIRLINES, stays = STAYS, cars = CARS, forwardAddress = FORWARD_ADDRESS } = {}) {
  const after = `after:${afterEpochSec}`;
  const from = (list) => `from:(${list.join(" OR ")})`;
  return [
    forwardQuery(afterEpochSec, forwardAddress),
    ...[airlines, stays, cars].filter((l) => l && l.length).map((l) => `${from(l)} ${after}`),
  ].filter(Boolean);
}

const dateOf = (s) => String(s || "").slice(0, 10);
const DONE = new Set(["canceled", "refunded"]);

function sameBooking(a, b) {
  return a.confirmation && a.confirmation === b.confirmation && a.type === b.type
    && (dateOf(a.depart) === dateOf(b.depart) || DONE.has(b.status)); // a cancellation may not repeat the date
}

const MATERIAL = ["depart", "arrive", "return", "checkin", "checkout", "seats", "location", "address", "passengers", "pickup_location", "dropoff_location", "number", "from", "to", "status", "name"];

// ── Station time zones ───────────────────────────────────────────────────────
// The model used to write each offset itself, and once gave an early-morning
// landing on the day clocks go back the airport's summer offset: the timeline
// had the flight landing an hour before it did.
// Now the model's job is the wall-clock time and the airport code; the offset
// comes from the airport's zone on that date. Nothing is ever guessed: an
// airport not in the table keeps the extracted value and is flagged.

// Installation data (data/, not the kernel): IATA → IANA zone, e.g. built from
// the airportsdata project. No file → every flight is kept as extracted and
// flagged unverified.
export const AIRPORT_TZ_FILE = createRequire(import.meta.url)("./root.cjs").installTools("data", "airport-tz.json");

/** data/airport-tz.json ({zones: {zone: [IATA...]}}) → {IATA: zone}. A missing/broken file → {} (every airport unverified). */
export function loadAirportTz(file = AIRPORT_TZ_FILE) {
  try {
    const out = {};
    for (const [tz, codes] of Object.entries(JSON.parse(fs.readFileSync(file, "utf8")).zones || {})) for (const c of codes) out[c] = tz;
    return out;
  } catch { return {}; }
}

const DTF = new Map();
/** UTC offset of `tz` at instant `ms`, in minutes east of UTC. Throws on a zone Intl does not know. */
export function offsetMinutesAt(tz, ms) {
  let f = DTF.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    DTF.set(tz, f);
  }
  const at = Math.floor(ms / 1000) * 1000;
  const p = Object.fromEntries(f.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - at) / 60000);
}

/**
 * Every offset at which a local clock reading occurs in `tz` — `wallMs` is the
 * reading written as if it were UTC. One normally, two in a fall-back hour
 * (earliest instant first), none in a spring-forward gap.
 */
export function offsetsForWallClock(tz, wallMs) {
  const cands = new Set([-86400e3, 0, 86400e3].map((d) => offsetMinutesAt(tz, wallMs + d)));
  return [...cands].filter((o) => offsetMinutesAt(tz, wallMs - o * 60000) === o).sort((a, b) => b - a);
}

const pad2 = (n) => String(n).padStart(2, "0");
const fmtOffset = (min) => `${min < 0 ? "-" : "+"}${pad2(Math.floor(Math.abs(min) / 60))}:${pad2(Math.abs(min) % 60)}`;
const ISO_PARTS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/; // lang-regex-ok: ISO-8601 structure from the extractor's typed field, not language

function offsetOf(s) {
  if (!s) return null;
  if (s === "Z") return 0;
  const sign = s[0] === "-" ? -1 : 1, digits = s.slice(1).replace(":", "");
  return sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
}

/**
 * One extracted time → { value, verified, reason }. Known airport: the same
 * wall clock with the offset that airport has on that date (in a fall-back
 * hour the extracted offset settles which of the two, else the first). A
 * value ending in `Z` is a UTC instant, re-stated in the airport's local time.
 * Unknown airport, unparseable value, or a clock time that does not exist
 * there (a spring-forward gap): the extracted value, unverified.
 */
export function stationTime(value, iata, zones) {
  const m = ISO_PARTS.exec(String(value || "").trim());
  if (!m) return { value, verified: false, reason: "unparseable" };
  const tz = (zones || {})[String(iata || "").trim().toUpperCase()];
  if (!tz) return { value, verified: false, reason: "unknown_airport" };
  const [, y, mo, d, h, mi, s = "00", off] = m;
  try {
    if (off === "Z") {
      const at = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s), o = offsetMinutesAt(tz, at);
      return { value: `${new Date(at + o * 60000).toISOString().slice(0, 19)}${fmtOffset(o)}`, verified: true, reason: "restated_from_utc", tz };
    }
    const offs = offsetsForWallClock(tz, Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
    if (!offs.length) return { value, verified: false, reason: "nonexistent_local_time" };
    const given = offsetOf(off);
    const pick = offs.includes(given) ? given : offs[0];
    return { value: `${y}-${mo}-${d}T${h}:${mi}:${s}${fmtOffset(pick)}`, verified: true, reason: offs.length > 1 ? "ambiguous_local_time" : null, tz };
  } catch {
    return { value, verified: false, reason: "unknown_zone" };
  }
}

const STATION_OF = { depart: "from", arrive: "to" };

/**
 * A flight record with depart/arrive re-stated in their airports' zones.
 * Returns { rec, changed: [{field, from, to}] (instant moved), unverified: [{field, station, reason}] }.
 * `rec.tz_unverified` lists the fields left as extracted; it is cleared once they verify.
 * Stays and car rentals pass through (their locations are not airport codes).
 */
export function normalizeStationTimes(rec, zones) {
  if (!rec || rec.type !== "flight") return { rec, changed: [], unverified: [] };
  const out = { ...rec }, changed = [], unverified = [];
  for (const [field, station] of Object.entries(STATION_OF)) {
    if (!rec[field]) continue;
    const r = stationTime(rec[field], rec[station], zones);
    if (!r.verified) { unverified.push({ field, station: rec[station] || null, reason: r.reason }); continue; }
    out[field] = r.value;
    if (Date.parse(r.value) !== Date.parse(rec[field])) changed.push({ field, from: rec[field], to: r.value });
  }
  if (unverified.length) out.tz_unverified = unverified.map((u) => u.field);
  else delete out.tz_unverified;
  return { rec: out, changed, unverified };
}

/**
 * The station pass over stored entries, so a booking already in flights.json
 * is corrected on the next run without its email being read again. Cancelled
 * entries are left as they are. Returns { entries, retimed: Set<index>, notes: [{index, changed, unverified}] }.
 */
export function normalizeEntries(entries, zones) {
  const retimed = new Set(), notes = [];
  const out = (entries || []).map((e, i) => {
    if (!e || e.type !== "flight" || DONE.has(e.status)) return e;
    const r = normalizeStationTimes(e, zones);
    if (r.changed.length) retimed.add(i);
    if (r.changed.length || r.unverified.length) notes.push({ index: i, changed: r.changed, unverified: r.unverified });
    return r.rec;
  });
  return { entries: out, retimed, notes };
}

/** "Sun, Nov 1, 4:55 AM" in the airport's own zone, or null when the airport or the time is unknown. */
export function localClock(iso, iata, zones) {
  const tz = (zones || {})[String(iata || "").trim().toUpperCase()];
  const at = Date.parse(iso);
  if (!tz || !Number.isFinite(at)) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(at));
  } catch { return null; }
}

/**
 * Merge freshly extracted records into flights.json (playbook Step 4).
 * Returns { entries, touched: Set<index into entries>, retimed: Set<index> }.
 * `opts.retimed` — indices into `existing` that normalizeEntries re-timed; they
 * count as touched (their calendar events need the new times), and come back
 * in `retimed` (remapped) unless an extracted record also touched them.
 * A cancellation matches by CONFIRMATION CODE (never by date range alone —
 * a cancellation once cancelled the other booking on the same dates); with no code it falls back to date+type
 * only when exactly one entry matches.
 */
export function mergeEntries(existing, extracted, today, { retimed = new Set() } = {}) {
  const entries = existing.map((e) => ({ ...e }));
  const touched = new Set();
  for (const rec of extracted) {
    if (!rec || !rec.type || !(rec.confirmation || DONE.has(rec.status)) || !(rec.depart || rec.checkin || DONE.has(rec.status))) continue;
    // A coded cancellation cancels EVERY entry under that code (a round trip's
    // two legs share one) and nothing else; with no match it is a no-op.
    if (DONE.has(rec.status) && rec.confirmation) {
      for (const [e, i] of entries.map((e, i) => [e, i])) {
        if (e.confirmation === rec.confirmation && e.type === rec.type && e.status !== rec.status) {
          entries[i] = { ...e, status: rec.status };
          touched.add(i);
        }
      }
      continue;
    }
    let idx = entries.findIndex((e) => sameBooking(e, rec));
    if (idx < 0 && rec.confirmation) {
      // A rescheduled booking moves its date, so the date match misses. Same code
      // + same leg (flights) or the only entry under that code (stays, cars) is
      // the same booking — updating it beats leaving a stale duplicate.
      const sameLeg = (e) => e.confirmation === rec.confirmation && e.type === rec.type
        && (rec.type !== "flight" || (e.number === rec.number && e.from === rec.from && e.to === rec.to));
      const cands = entries.map((e, i) => [e, i]).filter(([e]) => sameLeg(e));
      if (cands.length === 1) idx = cands[0][1];
    }
    if (idx < 0 && DONE.has(rec.status) && !rec.confirmation) {
      const cands = entries.map((e, i) => [e, i]).filter(([e]) => e.type === rec.type && dateOf(e.depart) === dateOf(rec.depart));
      if (cands.length === 1) idx = cands[0][1];
      else continue; // no code and ambiguous → no-op, never guess
    }
    if (idx >= 0) {
      const cur = entries[idx];
      const changed = MATERIAL.some((k) => rec[k] !== undefined && JSON.stringify(rec[k]) !== JSON.stringify(cur[k]));
      if (changed) {
        const keep = { calendar_event_id: cur.calendar_event_id ?? null, calendar_event_id_pickup: cur.calendar_event_id_pickup ?? null, calendar_event_id_return: cur.calendar_event_id_return ?? null };
        entries[idx] = { ...cur, ...rec, ...keep };
        touched.add(idx);
      }
    } else if (!DONE.has(rec.status)) {
      entries.push({ ...rec, calendar_event_id: null, ...(rec.type === "car_rental" ? { calendar_event_id_pickup: null, calendar_event_id_return: null } : {}) });
      touched.add(entries.length - 1);
    }
  }
  // Prune (depart > 14 days past) and sort; remap touched to the survivors.
  const cut = new Date(`${today}T00:00:00Z`).getTime() - 14 * 86400e3;
  const kept = entries.map((e, i) => [e, i]).filter(([e]) => !e.depart || Date.parse(e.depart) >= cut);
  kept.sort(([a], [b]) => String(a.depart || a.checkin).localeCompare(String(b.depart || b.checkin)));
  const out = kept.map(([e]) => e);
  const remap = (set) => new Set(kept.map(([, i], j) => (set.has(i) ? j : -1)).filter((j) => j >= 0));
  const retimedOnly = new Set([...retimed].filter((i) => !touched.has(i)));
  return { entries: out, touched: remap(new Set([...touched, ...retimed])), retimed: remap(retimedOnly) };
}

function shiftIso(iso, minutes) {
  // Keep the station offset: add minutes to the wall-clock part, re-attach the same offset.
  const m = String(iso).match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::\d{2})?(.*)$/); // lang-regex-ok: ISO-8601 structure
  if (!m) return iso;
  const off = m[2] || "Z";
  const wall = new Date(`${m[1]}:00Z`);
  wall.setUTCMinutes(wall.getUTCMinutes() + minutes);
  return `${wall.toISOString().slice(0, 19)}${off}`;
}

/** Calendar events an entry owns: [{slot, idField, summary, from, to, allDay, location, description}]. */
export function eventSpecs(e, allEntries = []) {
  const conf = e.confirmation;
  if (e.type === "flight") {
    return [{ slot: "main", idField: "calendar_event_id", summary: `Flight ${e.number} — ${e.from} → ${e.to}`,
      from: e.depart, to: e.arrive || shiftIso(e.depart, 120), location: `${e.from_city || ""} ${e.from}`.trim(),
      description: `${e.airline || ""} ${e.number} ${e.from} → ${e.to}. Confirmation: ${conf}. Seats: ${(e.seats || []).join(", ") || "n/a"}. Passengers: ${(e.passengers || []).join(", ")}.` }];
  }
  if (e.type === "accommodation") {
    return [{ slot: "main", idField: "calendar_event_id", summary: e.name ? `Stay at ${e.name}` : `Stay — ${e.provider} ${e.location}`,
      from: e.checkin, to: e.checkout, allDay: true, location: e.address || e.location || "",
      description: `${e.provider}. Confirmation: ${conf}. Check-in ${e.checkin}, check-out ${e.checkout}. Guests: ${e.guests ?? "n/a"}.` }];
  }
  if (e.type === "car_rental") {
    const sameDayFlight = allEntries.find((f) => f.type === "flight" && !DONE.has(f.status) && e.return && dateOf(f.depart) === dateOf(e.return) && f.depart < e.return);
    const warn = sameDayFlight ? `⚠️ Flight ${sameDayFlight.number} departs ${String(sameDayFlight.depart).slice(11, 16)} same day — verify early return. ` : "";
    return [
      { slot: "pickup", idField: "calendar_event_id_pickup", summary: `${e.provider} car pickup — ${e.pickup_location}`,
        from: e.depart, to: shiftIso(e.depart, 45), location: e.pickup_location || "",
        description: `${e.provider} booking ${conf}. Confirmation: ${conf}. ${e.vehicle || ""}. Return ${e.return} at ${e.dropoff_location}.` },
      ...(e.return ? [{ slot: "return", idField: "calendar_event_id_return", summary: `${e.provider} car return — ${e.dropoff_location}`,
        from: shiftIso(e.return, -30), to: e.return, location: e.dropoff_location || "",
        description: `${warn}${e.provider} booking ${conf}. Confirmation: ${conf}. Return at ${e.dropoff_location}.` }] : []),
    ];
  }
  return [];
}

/** Reconciliation matrix → "create" | "update" | "delete" | "noop" for one spec of one touched entry. */
export function action(entry, spec) {
  const id = entry[spec.idField];
  if (DONE.has(entry.status)) return id ? "delete" : "noop";
  return id ? "update" : "create";
}

/** Step 5a backstop: an existing event is THIS booking's only if summary matches AND description carries the code. */
export function isSameEvent(ev, spec, confirmation) {
  return ev && ev.summary === spec.summary && String(ev.description || "").includes(`Confirmation: ${confirmation}`);
}

/**
 * Step 6's one chat message, or null when nothing changed. A booking whose only
 * change is a corrected time zone is reported as that, not as a new find, with
 * its local times at each airport (never "the calendar was wrong": it may not have been).
 */
export function scanReport(entries, touched, retimed = new Set(), zones = {}) {
  const found = [...touched].filter((i) => !retimed.has(i));
  const fixed = [...touched].filter((i) => retimed.has(i));
  const parts = [];
  if (found.length) {
    const lines = found.map((i) => {
      const e = entries[i];
      const what = e.type === "flight" ? `${e.number} ${e.from}→${e.to} ${String(e.depart).slice(0, 10)}`
        : e.type === "accommodation" ? `${e.provider} ${e.location || ""} ${e.checkin} to ${e.checkout}`
        : `${e.provider} ${e.pickup_location || ""} ${String(e.depart).slice(0, 10)} to ${String(e.return || "").slice(0, 10)}`;
      return `  - [${e.type === "car_rental" ? "car" : e.type}] ${what} (${e.status})`;
    });
    parts.push(`Travel scan: found ${found.length} booking${found.length === 1 ? "" : "s"}:\n${lines.join("\n")}`);
  }
  if (fixed.length) {
    const lines = fixed.map((i) => {
      const e = entries[i];
      const at = (iso, code, city) => `${city || code} ${localClock(iso, code, zones) || iso}`;
      return `  - ${e.number} ${e.from}→${e.to}: leaves ${at(e.depart, e.from, e.from_city)}${e.arrive ? `, lands ${at(e.arrive, e.to, e.to_city)}` : ""}`;
    });
    const one = fixed.length === 1;
    parts.push(`${found.length ? "Also, I" : "Travel scan: I"} had the time zone wrong on ${one ? "one flight" : `${fixed.length} flights`}, so your travel timeline was off for ${one ? "it" : "them"}. Here ${one ? "it is" : "they are"} now, in local time:\n${lines.join("\n")}`);
  }
  return parts.length ? parts.join("\n\n") : null;
}
