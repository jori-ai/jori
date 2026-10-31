// tripit-flights.mjs — TripIt's structured trip objects as flights-scan records.
//
// flights-scan used to send every travel confirmation email to a model, even
// the ones the user had already forwarded to TripIt's inbound address — where TripIt had
// parsed them into typed objects. TripIt's API returns those objects
// (AirObject / LodgingObject / CarObject with segment times, airports, codes),
// so for anything TripIt knows, no model is needed: this module maps them onto
// the same record shape the email extractor produces, and mergeEntries() in
// flights-scan.mjs merges both by confirmation code as before.
//
// The email path stays for what TripIt does NOT cover:
//   - bookings never forwarded to TripIt (most direct airline / stay mail)
//   - mail NEWER than TripIt's last update of that booking — a schedule
//     change or a cancellation TripIt has not seen yet
// coveredByTripit() decides that per email, structurally: was it found by the
// TripIt-forward query, or does it carry a TripIt-known confirmation code AND
// predate TripIt's last modification of that booking. A confirmation code is a
// machine identifier; matching it is token equality, not reading language.
//
// TripIt credentials (basic auth, lib/tripit-api.js): TRIPIT_USERNAME +
// TRIPIT_PASSWORD in .env. Without them, or if the API call fails, the
// caller falls back to the all-email path — exactly the behaviour before TripIt.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const str = (v) => (v == null ? "" : String(v).trim());

/** TripIt DateTime {date, time, utc_offset} → ISO 8601 with the station's own offset. */
export function tripitIso(dt, defaultTime = null) {
  const date = str(dt?.date);
  if (!date) return null;
  const time = str(dt?.time) || defaultTime;
  if (!time) return date;
  const hhmmss = time.length === 5 ? `${time}:00` : time;
  return `${date}T${hhmmss}${str(dt?.utc_offset)}`;
}

function travelers(obj) {
  return asArray(obj?.Traveler).map((t) => [str(t.first_name), str(t.last_name)].filter(Boolean).join(" ")).filter(Boolean);
}

function code(obj) {
  return str(obj?.supplier_conf_num) || str(obj?.booking_site_conf_num) || "";
}

const modifiedMs = (obj) => (Number(obj?.last_modified) > 0 ? Number(obj.last_modified) * 1000 : 0);

/** One TripIt list response root (include_objects=true) → flights-scan records. */
export function recordsFromTripit(root) {
  const out = [];
  for (const a of asArray(root?.AirObject)) {
    const conf = code(a);
    if (!conf) continue;
    const pax = travelers(a);
    for (const s of asArray(a.Segment)) {
      const depart = tripitIso(s.StartDateTime);
      if (!depart) continue;
      const airlineCode = str(s.marketing_airline_code);
      const num = str(s.marketing_flight_number);
      out.push({
        source_message_id: `tripit:air:${a.id}:${str(s.id) || depart}`,
        type: "flight", status: "confirmed", confirmation: conf,
        number: airlineCode && num ? `${airlineCode}${num}` : num || undefined,
        airline: str(s.marketing_airline) || str(a.supplier_name) || undefined,
        from: str(s.start_airport_code) || undefined, from_city: str(s.start_city_name) || undefined,
        to: str(s.end_airport_code) || undefined, to_city: str(s.end_city_name) || undefined,
        depart, arrive: tripitIso(s.EndDateTime) || undefined,
        ...(pax.length ? { passengers: pax } : {}),
        ...(str(s.seats) ? { seats: str(s.seats).split(",").map((x) => x.trim()).filter(Boolean) } : {}),
        _tripit_modified: modifiedMs(a),
      });
    }
  }
  for (const l of asArray(root?.LodgingObject)) {
    const conf = code(l);
    const checkin = str(l.StartDateTime?.date);
    if (!conf || !checkin) continue;
    const addr = l.Address || {};
    out.push({
      source_message_id: `tripit:lodging:${l.id}`,
      type: "accommodation", status: "confirmed", confirmation: conf,
      provider: str(l.supplier_name) || undefined, name: str(l.supplier_name) || undefined,
      location: [str(addr.city), str(addr.country)].filter(Boolean).join(", ") || undefined,
      address: str(addr.address) || undefined,
      checkin, checkout: str(l.EndDateTime?.date) || undefined,
      depart: tripitIso(l.StartDateTime, "12:00:00"),
      ...(Number(l.number_guests) > 0 ? { guests: Number(l.number_guests) } : {}),
      _tripit_modified: modifiedMs(l),
    });
  }
  for (const c of asArray(root?.CarObject)) {
    const conf = code(c);
    const depart = tripitIso(c.StartDateTime, "12:00:00");
    if (!conf || !depart) continue;
    out.push({
      source_message_id: `tripit:car:${c.id}`,
      type: "car_rental", status: "confirmed", confirmation: conf,
      provider: str(c.supplier_name) || undefined,
      pickup_location: str(c.start_location_name) || undefined,
      dropoff_location: str(c.end_location_name) || undefined,
      depart, return: tripitIso(c.EndDateTime, "12:00:00") || undefined,
      vehicle: str(c.car_type) || undefined,
      _tripit_modified: modifiedMs(c),
    });
  }
  // Drop undefined keys so mergeEntries' "material change" diff sees only real fields.
  return out.map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)));
}

const instant = (s) => { const t = Date.parse(s); return Number.isFinite(t) ? t : String(s || ""); };
const sameLegRoute = (e, r) => r.type !== "flight" || (e.from === r.from && e.to === r.to);

/**
 * Only what TripIt adds: a booking flights.json does not have, or a real time
 * change to one it does. Every run re-reads all upcoming trips, and TripIt's
 * spelling of a field ("AA100", a passenger list, a city name) can differ from
 * what the email extractor stored — without this filter that difference would
 * register as a "change" every run (calendar rewrite + chat ping, daily). For a
 * time change, the existing entry's identifying fields are carried over so
 * mergeEntries matches it rather than appending a duplicate.
 */
export function tripitDelta(existing, records) {
  const out = [];
  for (const r of records) {
    const mine = (existing || []).filter((e) => e.confirmation === r.confirmation && e.type === r.type && sameLegRoute(e, r));
    if (!mine.length) { out.push(r); continue; }
    const startKey = r.type === "accommodation" ? "checkin" : "depart";
    if (mine.some((e) => instant(e[startKey]) === instant(r[startKey]) && (!r.arrive || !e.arrive || instant(e.arrive) === instant(r.arrive)))) continue;
    if (mine.length !== 1) continue; // ambiguous (several legs on one route) → leave it to the email path
    const e = mine[0];
    const times = r.type === "flight" ? { depart: r.depart, arrive: r.arrive }
      : r.type === "accommodation" ? { checkin: r.checkin, checkout: r.checkout, depart: r.depart }
      : { depart: r.depart, return: r.return };
    out.push({ ...e, ...Object.fromEntries(Object.entries(times).filter(([, v]) => v)), source_message_id: r.source_message_id, status: "changed" });
  }
  return out;
}

/** Upcoming trips (all pages) → {records, coverage: Map<code, lastModifiedMs>}. */
export async function fetchTripit({ user, password, api = require("./tripit-api.js") } = {}) {
  const roots = [];
  let page = 1, max = 1;
  do {
    const r = await api.listTrips({ user, password, past: false, includeObjects: true, pageNum: page, pageSize: 25 });
    roots.push(r.root);
    max = r.maxPage || 1;
    page++;
  } while (page <= max && page <= 10);
  const records = roots.flatMap(recordsFromTripit);
  const coverage = new Map();
  for (const r of records) coverage.set(r.confirmation, Math.max(coverage.get(r.confirmation) || 0, r._tripit_modified || 0));
  return { records, coverage };
}

/** Uppercase alphanumeric tokens of a text — for exact confirmation-code membership. */
export function codeTokens(text) {
  const out = new Set();
  let cur = "";
  for (const ch of String(text || "").toUpperCase()) {
    const c = ch.charCodeAt(0);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90)) cur += ch;
    else { if (cur) out.add(cur); cur = ""; }
  }
  if (cur) out.add(cur);
  return out;
}

/**
 * Is this email already represented by TripIt's structured data?
 *   email: { viaTripitForward, text, internalDate (ms) }
 * A forward to TripIt (the configured forward_address) is covered outright. Otherwise the email must
 * carry a TripIt-known confirmation code AND be no newer than TripIt's last
 * modification of that booking (plus a 1 h grace for TripIt's own parse lag
 * running the other way). Anything newer goes to the model — it may be the
 * change or cancellation TripIt has not seen.
 */
export function coveredByTripit(email, coverage, { graceMs = 3600e3 } = {}) {
  if (!coverage || !coverage.size) return false;
  if (email.viaTripitForward) return true;
  const tokens = codeTokens(email.text);
  for (const [conf, modified] of coverage) {
    if (conf.length < 5 || !tokens.has(conf.toUpperCase())) continue;
    if (!modified) return false; // unknown vintage → let the model read it
    return Number(email.internalDate || 0) <= modified + graceMs;
  }
  return false;
}
