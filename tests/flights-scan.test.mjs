// flights-scan.test.mjs — the flights.json merge and calendar decisions that
// jobs/flights-scan.md used to ask an agent to apply by hand.
//
// Pinned incidents:
//   - a cancellation matched by DATE RANGE cancelled the kept duplicate
//     booking. Cancellations match by confirmation code.
//   - two racing runs each created an event. The backstop identifies "this
//     booking's event" by summary + code together.
//   - non-English airline confirmations were dropped by an English subject filter.
//   - the model gave an early-morning landing on the day clocks go back the
//     airport's summer offset, so the timeline had it landing an hour early.
//     Offsets now come from the airport's zone on the date (data/airport-tz.json),
//     and stored entries are corrected on the next run.
//
// Airports and zones here are a synthetic table (London / Athens / Lisbon),
// not the installation's file, so the test is the same on a fresh install.
//
// Also here: bin/flight-search, the live fare search (its section is last).
//
// Run: node --test tests/flights-scan.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gmailQueries, forwardQuery, mergeEntries, eventSpecs, action, isSameEvent,
  loadAirportTz, stationTime, normalizeStationTimes, normalizeEntries, scanReport, AIRPORT_TZ_FILE } from "../lib/flights-scan.mjs";
import { flattenOffers, flattenGoogle, googleParams, serpapiArgs, runSearch, buildReport } from "../bin/flight-search";

test("Gmail queries are sender-domain only (no English subject filter) and include forwards when configured", () => {
  const opts = { airlines: ["example-air.com"], stays: ["example-stays.com"], cars: ["example-cars.com"], forwardAddress: "trips@example.com" };
  const qs = gmailQueries(1760000000, opts);
  assert.ok(qs[0].startsWith("in:sent to:trips@example.com"));
  assert.equal(qs[0], forwardQuery(1760000000, "trips@example.com"));
  assert.ok(qs.some((q) => q.includes("example-air.com")));
  assert.ok(qs.every((q) => !q.includes("subject:")));
  assert.ok(qs.every((q) => q.includes("after:1760000000")));
  // No forward address → no forward query; the sweeps stay.
  const none = gmailQueries(1760000000, { ...opts, forwardAddress: "" });
  assert.equal(none.length, 3);
  assert.ok(none.every((q) => q.startsWith("from:(")));
  assert.equal(forwardQuery(1760000000, ""), null);
});

const stay = (conf, checkin, extra = {}) => ({ type: "accommodation", provider: "ExampleStays", confirmation: conf, checkin, checkout: "2026-08-06", depart: `${checkin}T15:00:00+02:00`, status: "confirmed", ...extra });

test("cancellation matches by confirmation code, never the other booking on the same dates", () => {
  const existing = [
    { ...stay("HMTAQC2XM2", "2026-07-28"), calendar_event_id: "evA" },
    { ...stay("HMP3D2ANY4", "2026-07-28"), calendar_event_id: "evB" },
  ];
  const { entries, touched } = mergeEntries(existing, [{ type: "accommodation", confirmation: "HMTAQC2XM2", status: "canceled" }], "2026-07-01");
  const a = entries.find((e) => e.confirmation === "HMTAQC2XM2");
  const b = entries.find((e) => e.confirmation === "HMP3D2ANY4");
  assert.equal(a.status, "canceled");
  assert.equal(b.status, "confirmed");
  assert.equal(touched.size, 1);
  assert.equal(action(a, eventSpecs(a)[0]), "delete");
});

test("a coded cancellation cancels both legs of a round trip", () => {
  const leg = (n, d) => ({ type: "flight", number: n, confirmation: "RT1", depart: d, status: "confirmed", calendar_event_id: n });
  const { entries, touched } = mergeEntries([leg("XY1", "2026-10-15T10:00:00+01:00"), leg("XY2", "2026-11-01T10:00:00+02:00")], [{ type: "flight", confirmation: "RT1", status: "refunded" }], "2026-10-01");
  assert.deepEqual(entries.map((e) => e.status), ["refunded", "refunded"]);
  assert.equal(touched.size, 2);
});

test("a code-less cancellation with two same-date candidates is a no-op, not a guess", () => {
  const existing = [stay("A", "2026-07-28"), stay("B", "2026-07-28")];
  const { entries, touched } = mergeEntries(existing, [{ type: "accommodation", status: "canceled", depart: "2026-07-28T15:00:00+02:00" }], "2026-07-01");
  assert.equal(touched.size, 0);
  assert.ok(entries.every((e) => e.status === "confirmed"));
});

test("new booking appended + touched; unchanged re-extraction is untouched; time change keeps the calendar id", () => {
  const flight = { type: "flight", number: "XY 123", from: "ATH", to: "LHR", depart: "2026-10-29T10:00:00+02:00", arrive: "2026-10-29T12:00:00+00:00", confirmation: "13438368", status: "confirmed" };
  let r = mergeEntries([], [flight], "2026-10-01");
  assert.equal(r.entries.length, 1);
  assert.equal(r.touched.size, 1);
  const withId = [{ ...r.entries[0], calendar_event_id: "ev1" }];
  r = mergeEntries(withId, [flight], "2026-10-01");
  assert.equal(r.touched.size, 0);
  r = mergeEntries(withId, [{ ...flight, arrive: "2026-10-29T13:00:00+00:00", status: "changed" }], "2026-10-01");
  assert.equal(r.touched.size, 1);
  assert.equal(r.entries[0].calendar_event_id, "ev1");
  assert.equal(action(r.entries[0], eventSpecs(r.entries[0])[0]), "update");
});

test("a rescheduled booking (new date, same code) updates in place instead of duplicating", () => {
  const car = { type: "car_rental", provider: "Budget", confirmation: "47483425US3", depart: "2026-10-01T12:00:00+03:00", return: "2026-10-28T12:00:00+03:00", status: "confirmed", calendar_event_id_pickup: "p1" };
  const { entries, touched } = mergeEntries([car], [{ ...car, depart: "2026-10-02T13:00:00+03:00", status: "changed" }], "2026-09-20");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].depart, "2026-10-02T13:00:00+03:00");
  assert.equal(entries[0].calendar_event_id_pickup, "p1");
  assert.equal(touched.size, 1);
});

test("prune: depart more than 14 days past is dropped", () => {
  const old = { type: "flight", number: "X", confirmation: "C", depart: "2026-09-01T10:00:00+01:00", status: "confirmed" };
  assert.equal(mergeEntries([old], [], "2026-10-04").entries.length, 0);
});

test("event specs: flight keeps station offsets; car rental gets pickup+return with the code in BOTH descriptions", () => {
  const [f] = eventSpecs({ type: "flight", number: "XY18", airline: "Example Air", from: "LHR", from_city: "London", to: "ATH", depart: "2026-10-15T22:00:00+01:00", arrive: "2026-10-16T03:30:00+03:00", confirmation: "NEW", passengers: ["Jane Doe"] });
  assert.equal(f.summary, "Flight XY18 — LHR → ATH");
  assert.equal(f.from, "2026-10-15T22:00:00+01:00");
  assert.equal(f.to, "2026-10-16T03:30:00+03:00");
  const flights = [{ type: "flight", number: "XY1", depart: "2026-11-12T11:00:00+02:00", status: "confirmed" }];
  const specs = eventSpecs({ type: "car_rental", provider: "Hertz", pickup_location: "ATH", dropoff_location: "ATH", depart: "2026-10-16T17:00:00+03:00", return: "2026-11-12T12:00:00+02:00", confirmation: "CAR1" }, flights);
  assert.deepEqual(specs.map((s) => s.slot), ["pickup", "return"]);
  assert.equal(specs[0].to, "2026-10-16T17:45:00+03:00");
  assert.equal(specs[1].from, "2026-11-12T11:30:00+02:00");
  assert.ok(specs.every((s) => s.description.includes("Confirmation: CAR1")));
  assert.ok(specs[1].description.startsWith("⚠️ Flight XY1 departs 11:00 same day"));
});

test("backstop: summary AND code must both match (round-trip legs share a code)", () => {
  const spec = { summary: "Flight XY18 — LHR → ATH" };
  assert.ok(isSameEvent({ summary: "Flight XY18 — LHR → ATH", description: "x Confirmation: NEW." }, spec, "NEW"));
  assert.ok(!isSameEvent({ summary: "Flight XY19 — ATH → LHR", description: "x Confirmation: NEW." }, spec, "NEW"));
  assert.ok(!isSameEvent({ summary: "Flight XY18 — LHR → ATH", description: "no code" }, spec, "NEW"));
});

// ── Station time zones ──────────────────────────────────────────────────────

// A synthetic airport table (the shape loadAirportTz returns).
const ZONES = { LHR: "Europe/London", ATH: "Europe/Athens", LIS: "Europe/Lisbon" };
// ZZ991 as flights-scan would have stored it with the model's summer offset at
// the arrival airport, on the morning its clocks go back (2026-10-25).
const zz991 = () => ({ type: "flight", number: "ZZ991", airline: "Example Air", from: "ATH", from_city: "Athens", to: "LHR", to_city: "London",
  depart: "2026-10-25T05:05:00+02:00", arrive: "2026-10-25T07:55:00+01:00", status: "confirmed", confirmation: "13438368", calendar_event_id: "q9vu" });

test("loadAirportTz: {zones: {zone: [IATA...]}} → {IATA: zone}; a missing file → {}", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airport-tz-"));
  const f = path.join(dir, "airport-tz.json");
  fs.writeFileSync(f, JSON.stringify({ zones: { "Europe/London": ["LHR", "LGW"], "Europe/Athens": ["ATH"] } }));
  assert.deepEqual(loadAirportTz(f), { LHR: "Europe/London", LGW: "Europe/London", ATH: "Europe/Athens" });
  assert.deepEqual(loadAirportTz(path.join(dir, "missing.json")), {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test("ZZ991: a stored landing on the morning clocks go back is re-timed to the winter offset and counts as touched", () => {
  const { entries, retimed } = normalizeEntries([zz991()], ZONES);
  assert.equal(entries[0].arrive, "2026-10-25T07:55:00+00:00");
  assert.equal(new Date(entries[0].arrive).toISOString(), "2026-10-25T07:55:00.000Z");
  assert.equal(entries[0].depart, "2026-10-25T05:05:00+02:00"); // Athens had already gone back (04:00 local)
  assert.deepEqual([...retimed], [0]);
  const m = mergeEntries(entries, [], "2026-10-20", { retimed });
  assert.deepEqual([...m.touched], [0]);
  assert.deepEqual([...m.retimed], [0]);
  assert.equal(action(m.entries[0], eventSpecs(m.entries[0])[0]), "update"); // its calendar event gets the corrected end
  assert.equal(eventSpecs(m.entries[0])[0].to, "2026-10-25T07:55:00+00:00");
});

test("Athens' DST end (2026-10-25): +03:00 the day before, +02:00 from that night", () => {
  assert.equal(stationTime("2026-10-24T22:00:00+03:00", "ATH", ZONES).value, "2026-10-24T22:00:00+03:00");
  assert.equal(stationTime("2026-10-25T22:00:00+03:00", "ATH", ZONES).value, "2026-10-25T22:00:00+02:00");
  assert.equal(stationTime("2026-07-15T22:00:00+02:00", "ATH", ZONES).value, "2026-07-15T22:00:00+03:00");
});

test("the wall clock is kept; only the offset is code's (no offset, 'HH:MM' form, lower-case code)", () => {
  assert.equal(stationTime("2026-10-25T07:55", "lhr", ZONES).value, "2026-10-25T07:55:00+00:00");
  assert.equal(stationTime("2026-10-15T22:00:00", "LHR", ZONES).value, "2026-10-15T22:00:00+01:00");
  assert.equal(stationTime("2026-12-01T10:00:00+05:00", "LIS", ZONES).value, "2026-12-01T10:00:00+00:00");
});

test("a UTC value ('Z') is the instant, re-stated in the airport's local time", () => {
  const r = stationTime("2026-10-25T09:55:00Z", "ATH", ZONES);
  assert.equal(r.value, "2026-10-25T11:55:00+02:00");
  assert.equal(r.verified, true);
});

test("a fall-back hour: the extracted offset settles which 01:30, else the first", () => {
  assert.equal(stationTime("2026-10-25T01:30:00+00:00", "LHR", ZONES).value, "2026-10-25T01:30:00+00:00");
  assert.equal(stationTime("2026-10-25T01:30:00+01:00", "LHR", ZONES).value, "2026-10-25T01:30:00+01:00");
  const r = stationTime("2026-10-25T01:30:00", "LHR", ZONES);
  assert.equal(r.value, "2026-10-25T01:30:00+01:00");
  assert.equal(r.reason, "ambiguous_local_time");
});

test("never invents: unknown airport, a spring-forward gap, or junk keeps the extracted value, flagged", () => {
  const gap = stationTime("2027-03-28T01:30:00+00:00", "LHR", ZONES);
  assert.deepEqual([gap.value, gap.verified, gap.reason], ["2027-03-28T01:30:00+00:00", false, "nonexistent_local_time"]);
  const n = normalizeStationTimes({ type: "flight", number: "ZZ1", from: "LHR", to: "QQQ", depart: "2026-11-02T08:00:00+01:00", arrive: "2026-11-02T20:00:00+01:00" }, ZONES);
  assert.equal(n.rec.depart, "2026-11-02T08:00:00+00:00");
  assert.equal(n.rec.arrive, "2026-11-02T20:00:00+01:00");
  assert.deepEqual(n.rec.tz_unverified, ["arrive"]);
  assert.deepEqual(n.unverified, [{ field: "arrive", station: "QQQ", reason: "unknown_airport" }]);
  assert.equal(stationTime("tomorrow", "LHR", ZONES).verified, false);
  // An empty table (file missing) verifies nothing and changes nothing.
  const none = normalizeEntries([zz991()], {});
  assert.equal(none.entries[0].arrive, "2026-10-25T07:55:00+01:00");
  assert.equal(none.retimed.size, 0);
  assert.deepEqual(none.entries[0].tz_unverified, ["depart", "arrive"]);
});

test("idempotent: a corrected entry and a re-extraction with the model's wrong offset are both no-ops", () => {
  const once = normalizeEntries([zz991()], ZONES).entries;
  const twice = normalizeEntries(once, ZONES);
  assert.equal(twice.retimed.size, 0);
  const again = normalizeStationTimes({ ...zz991(), calendar_event_id: undefined }, ZONES).rec;
  const m = mergeEntries(twice.entries, [again], "2026-10-20", { retimed: twice.retimed });
  assert.equal(m.touched.size, 0);
  assert.equal(m.entries.length, 1);
});

test("cancelled entries and non-flights are left alone", () => {
  const cancelled = { ...zz991(), status: "canceled" };
  const car = { type: "car_rental", provider: "Hertz", confirmation: "C1", pickup_location: "LHR", depart: "2026-10-25T07:55:00+01:00" };
  const { entries, retimed } = normalizeEntries([cancelled, car], ZONES);
  assert.deepEqual(entries, [cancelled, car]);
  assert.equal(retimed.size, 0);
});

test("a time-zone fix is reported as one, in each airport's local time, and never as a new booking", () => {
  const { entries, retimed } = normalizeEntries([zz991()], ZONES);
  const m = mergeEntries(entries, [], "2026-10-20", { retimed });
  const msg = scanReport(m.entries, m.touched, m.retimed, ZONES);
  assert.ok(msg.startsWith("Travel scan: I had the time zone wrong on one flight"), msg);
  assert.ok(msg.includes("ZZ991 ATH→LHR: leaves Athens Sun, Oct 25, 5:05 AM, lands London Sun, Oct 25, 7:55 AM"), msg);
  assert.ok(!msg.includes("found"), msg);
  assert.equal(scanReport(m.entries, new Set(), new Set(), ZONES), null);
  const plain = scanReport([{ type: "flight", number: "XY18", from: "LHR", to: "ATH", depart: "2026-10-15T22:00:00+01:00", status: "confirmed" }], new Set([0]));
  assert.equal(plain, "Travel scan: found 1 booking:\n  - [flight] XY18 LHR→ATH 2026-10-15 (confirmed)");
});

test("the installation's airport-tz.json (when there is one): valid zones, no code under two zones", (t) => {
  if (!fs.existsSync(AIRPORT_TZ_FILE)) return t.skip("no data/airport-tz.json in this installation");
  const raw = JSON.parse(fs.readFileSync(AIRPORT_TZ_FILE, "utf8")).zones;
  const seen = new Map();
  for (const [tz, codes] of Object.entries(raw)) {
    assert.doesNotThrow(() => new Intl.DateTimeFormat("en-US", { timeZone: tz }), tz);
    for (const c of codes) {
      assert.match(c, /^[A-Z]{3}$/);
      assert.ok(!seen.has(c), `${c} listed under ${seen.get(c)} and ${tz}`);
      seen.set(c, tz);
    }
  }
});

// ── bin/flight-search: Duffel and Google Flights in one list ─────────────────
// A fare search through one source alone missed a carrier the other source had
// for far less, and a fare for two travellers read as if it were per person.
// The CLI now searches both sources by default, names the source on every row,
// prices every row as TOTAL (all passengers together) and PER PERSON, ends with
// the airlines each source returned, and keeps going when one source fails.
// The pure parts run in-process; the CLI runs below have fetch stubbed, in
// flight-search and in the bin/serpapi child it spawns (a data: module through
// NODE_OPTIONS), so no request leaves the machine. Routes, carriers (XA, XB, XC)
// and fares are synthetic.

const FS_OPTS = Object.freeze({
  origin: "LIS", dest: "LHR", departDate: "2027-03-10", returnDate: null, returnTo: "",
  adults: 2, cabin: "economy", max: 10, currency: "USD", direct: false, carrier: "",
  sortKey: "price", source: "both", json: false, debug: false,
});

const duffelOffer = (id, amount, carrier, num, dep, arr) => ({
  id, total_amount: amount, total_currency: "USD",
  slices: [{ duration: "PT7H05M", segments: [{
    origin: { iata_code: "LIS" }, destination: { iata_code: "LHR" }, departing_at: dep, arriving_at: arr,
    marketing_carrier: { iata_code: carrier }, marketing_carrier_flight_number: num, aircraft: { name: "Example 787" },
  }] }],
});
const DUFFEL_OFFERS = [
  duffelOffer("off_1", "900.00", "XA", "0100", "2027-03-10T18:00:00", "2027-03-11T06:05:00"),
  duffelOffer("off_2", "1100.50", "XB", "0200", "2027-03-10T20:00:00", "2027-03-11T08:05:00"),
];

const googleItem = (price, flightNumber, dep, arr) => ({
  price, type: "One way", total_duration: 425,
  flights: [{ departure_airport: { id: "LIS", time: dep }, arrival_airport: { id: "LHR", time: arr },
    duration: 425, airline: "Example Air", flight_number: flightNumber, airplane: "Example 777" }],
});
const GOOGLE_LINK = "https://www.google.com/travel/flights?example";
const GOOGLE_RESP = {
  search_metadata: { google_flights_url: GOOGLE_LINK },
  search_parameters: { currency: "USD" },
  best_flights: [googleItem(240, "XC 300", "2027-03-10 19:00", "2027-03-11 07:05")],
  other_flights: [googleItem(905, "XA 100", "2027-03-10 18:00", "2027-03-11 06:05"), { price: null, flights: [] }],
};

const bothOk = {
  duffel: async (o) => ({ rows: flattenOffers(DUFFEL_OFFERS, o) }),
  google: async (o) => flattenGoogle(GOOGLE_RESP, o),
};

test("flight-search: every row names its source and prices TOTAL (all passengers) and PER PERSON", () => {
  const d = flattenOffers(DUFFEL_OFFERS, FS_OPTS);
  assert.equal(d[0].source, "duffel");
  // The fields callers already read are unchanged.
  assert.equal(d[0].offer_id, "off_1");
  assert.equal(d[0].total_amount, "900.00");
  assert.equal(d[0].currency, "USD");
  assert.equal(d[0].outbound.carrier, "XA");
  assert.equal(d[0].return, null);
  assert.equal(d[0].passengers, 2);
  assert.equal(d[0].price_total, 900);
  assert.equal(d[0].price_per_person, 450);
  assert.equal(d[0].price_basis, "total_for_all_passengers");

  const g = flattenGoogle(GOOGLE_RESP, FS_OPTS);
  assert.equal(g.link, GOOGLE_LINK);
  assert.equal(g.rows.length, 2, "an item with no price is skipped");
  const [c] = g.rows;
  assert.equal(c.source, "google");
  assert.equal(c.offer_id, null);
  assert.equal(c.total_amount, "240.00");
  assert.equal(c.price_per_person, 120);
  assert.equal(c.outbound.depart, "2027-03-10T19:00:00", "Google's local time in Duffel's shape");
  assert.deepEqual([c.outbound.segments[0].carrier, c.outbound.segments[0].flight_no], ["XC", "300"]);
  assert.equal(c.outbound.duration_min, 425);
  assert.equal(c.trip, "one_way");
});

test("flight-search: the Google Flights request mirrors the search (one way, round trip, open-jaw, filters)", () => {
  const one = googleParams(FS_OPTS);
  assert.equal(one.type, "2");
  assert.equal(one.departure_id, "LIS");
  assert.equal(one.arrival_id, "LHR");
  assert.equal(one.outbound_date, "2027-03-10");
  assert.equal(one.adults, "2");
  assert.equal(one.travel_class, "1");
  assert.equal(one.sort_by, "2");
  assert.equal(one.deep_search, "true");
  assert.equal(one.return_date, undefined);
  assert.equal(one.stops, undefined);

  const rt = googleParams({ ...FS_OPTS, returnDate: "2027-03-20" });
  assert.equal(rt.type, "1");
  assert.equal(rt.return_date, "2027-03-20");

  const jaw = googleParams({ ...FS_OPTS, returnDate: "2027-03-20", returnTo: "CDG" });
  assert.equal(jaw.type, "3");
  assert.equal(jaw.departure_id, undefined);
  assert.deepEqual(JSON.parse(jaw.multi_city_json), [
    { departure_id: "LIS", arrival_id: "LHR", date: "2027-03-10" },
    { departure_id: "LHR", arrival_id: "CDG", date: "2027-03-20" },
  ]);

  const filtered = googleParams({ ...FS_OPTS, direct: true, carrier: "XA", cabin: "business", sortKey: "duration" });
  assert.equal(filtered.stops, "1");
  assert.equal(filtered.include_airlines, "XA");
  assert.equal(filtered.travel_class, "3");
  assert.equal(filtered.sort_by, "5");

  const args = serpapiArgs(one);
  assert.deepEqual(args.slice(0, 2), ["google_flights", "-"]);
  assert.equal(args.at(-1), "--raw", "--raw keeps the Google Flights page link");
  assert.ok(args.includes("--adults=2"));
});

test("flight-search: one merged list, cheapest first, with each source's airlines and the ones only one had", async () => {
  const results = await runSearch(FS_OPTS, bothOk);
  const rep = buildReport(results, FS_OPTS);
  assert.equal(rep.code, 0);
  assert.equal(rep.err, "");
  assert.ok(rep.out.includes("TOTAL is for all 2 adults together; PER PERSON = TOTAL / 2."), rep.out);
  const lines = rep.out.split("\n");
  const sep = lines.findIndex((l) => l.startsWith("─"));
  assert.ok(lines[sep - 1].includes("SOURCE") && lines[sep - 1].includes("PER PERSON"), lines[sep - 1]);
  const rows = lines.slice(sep + 1, sep + 5);
  assert.match(rows[0], /^1 +google +USD 240\.00 +USD 120\.00 +XC +XC 300 /);
  assert.match(rows[1], /^2 +duffel +USD 900\.00 +USD 450\.00 +XA +XA 100 .* off_1$/, "Duffel's zero-padded number reads as XA 100");
  assert.match(rows[2], /^3 +google +USD 905\.00 /);
  assert.match(rows[3], /^4 +duffel +USD 1100\.50 +USD 550\.25 /);
  assert.ok(rep.out.includes("  duffel: 2 offers, cheapest USD 900.00 total (USD 450.00 per person) — XA, XB"), rep.out);
  assert.ok(rep.out.includes("  google: 2 offers, cheapest USD 240.00 total (USD 120.00 per person) — XA, XC"), rep.out);
  assert.ok(rep.out.includes("  only on duffel: XB"), rep.out);
  assert.ok(rep.out.includes("  only on google: XC"), rep.out);
  assert.ok(rep.out.includes(`Google Flights page: ${GOOGLE_LINK}`), rep.out);

  const capped = buildReport(results, { ...FS_OPTS, max: 1 });
  assert.ok(capped.out.includes("Showing 1 of 4 matching offers"), capped.out);
  assert.ok(capped.out.includes("only on duffel: XB"), "coverage counts what each source returned, not just the rows shown");

  const one = buildReport(results, { ...FS_OPTS, adults: 1 });
  assert.ok(one.out.includes("Prices are for 1 adult"), one.out);
});

test("flight-search: one source failing shows the other's rows with a note; only every source failing exits 1", async () => {
  const boom = (msg) => async () => { throw new Error(msg); };
  const noDuffel = await runSearch(FS_OPTS, { ...bothOk, duffel: boom("Duffel auth failed (HTTP 401).") });
  const a = buildReport(noDuffel, FS_OPTS);
  assert.equal(a.code, 0);
  assert.ok(a.out.startsWith("Note: Duffel unavailable this run (Duffel auth failed (HTTP 401)); showing Google Flights results only."), a.out);
  assert.ok(a.out.includes("  duffel: unavailable this run"), a.out);
  assert.ok(!a.out.includes(" duffel  "), "no Duffel rows");

  const noGoogle = await runSearch(FS_OPTS, { ...bothOk, google: boom("Google Flights search (SerpApi) failed: SERPAPI_API_KEY is not set") });
  const b = buildReport(noGoogle, FS_OPTS);
  assert.equal(b.code, 0);
  assert.ok(b.out.startsWith("Note: Google Flights unavailable this run (Google Flights search (SerpApi) failed: SERPAPI_API_KEY is not set); showing Duffel results only."), b.out);
  assert.ok(b.out.includes("off_1"));

  const none = buildReport(await runSearch(FS_OPTS, { duffel: boom("Duffel error: x"), google: boom("Google Flights search (SerpApi) failed: y") }), FS_OPTS);
  assert.equal(none.code, 1);
  assert.equal(none.out, "");
  assert.equal(none.err, "flight-search: Duffel error: x\nflight-search: Google Flights search (SerpApi) failed: y\n");

  // One named source: only it is searched, and its failure is the error it always was.
  let googleCalled = false;
  const only = await runSearch({ ...FS_OPTS, source: "duffel" }, {
    duffel: boom("no Duffel token: set DUFFEL_API_TOKEN."),
    google: async () => { googleCalled = true; return { rows: [] }; },
  });
  assert.equal(googleCalled, false);
  const c = buildReport(only, { ...FS_OPTS, source: "duffel" });
  assert.equal(c.code, 1);
  assert.equal(c.err, "flight-search: no Duffel token: set DUFFEL_API_TOKEN.\n");
});

test("flight-search --json: still one array of offer rows; notes and coverage go to stderr", async () => {
  const rep = buildReport(await runSearch(FS_OPTS, bothOk), { ...FS_OPTS, json: true });
  const rows = JSON.parse(rep.out);
  assert.ok(Array.isArray(rows));
  assert.equal(rows.length, 4);
  for (const r of rows) {
    for (const k of ["offer_id", "total_amount", "currency", "outbound", "return", "source", "passengers", "price_total", "price_per_person"]) assert.ok(k in r, k);
  }
  assert.deepEqual(rows.map((r) => r.source), ["google", "duffel", "google", "duffel"]);
  assert.ok(rep.err.includes("Coverage"), rep.err);
});

test("flight-search: Google round-trip rows say the price covers the whole trip and the return is not listed", async () => {
  const opts = { ...FS_OPTS, returnDate: "2027-03-20" };
  const g = flattenGoogle(GOOGLE_RESP, opts);
  assert.equal(g.rows[0].trip, "round_trip");
  assert.equal(g.rows[0].return, null);
  assert.equal(g.rows[0].return_listed, false);
  const rep = buildReport(await runSearch(opts, { google: async (o) => flattenGoogle(GOOGLE_RESP, o), duffel: async () => ({ rows: [] }) }), opts);
  assert.ok(rep.out.includes("Google rows: the price covers the whole trip"), rep.out);
  assert.ok(rep.out.includes("  duffel: no offers matched"), rep.out);
});

// The real CLI, fetch stubbed in it and in the bin/serpapi child it spawns.
const FS_BIN = fileURLToPath(new URL("../bin/flight-search", import.meta.url));
const FETCH_STUB = `import fs from "node:fs";
const dir = process.env.FLIGHT_SEARCH_STUB_DIR;
globalThis.fetch = async (url) => {
  const u = String(url);
  fs.appendFileSync(dir + "/calls.log", u + "\\n");
  const name = u.startsWith("https://api.duffel.com/") ? "duffel" : u.startsWith("https://serpapi.com/") ? "serpapi" : "none";
  let fx = null;
  try { fx = JSON.parse(fs.readFileSync(dir + "/" + name + ".json", "utf8")); } catch {}
  if (!fx) return new Response(JSON.stringify({ error: "stub: no fixture" }), { status: 599 });
  return new Response(JSON.stringify(fx.body), { status: fx.status || 200 });
};`;

function runFlightSearch(args, fixtures) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flight-search-test-"));
  try {
    for (const [name, fx] of Object.entries(fixtures)) fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(fx));
    const r = spawnSync(process.execPath, [FS_BIN, ...args], {
      encoding: "utf8",
      timeout: 60000,
      env: {
        ...process.env,
        // The installation's secrets file is found under HOME (unless JORI_HOME
        // names a checkout): point HOME at the empty temp dir so neither process
        // reads a real key. The stand-in keys below are all they see.
        HOME: dir,
        NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(FETCH_STUB)}`,
        FLIGHT_SEARCH_STUB_DIR: dir,
        DUFFEL_API_TOKEN: "test-duffel-token",
        SERPAPI_API_KEY: "test-serpapi-key",
      },
    });
    let calls = [];
    try { calls = fs.readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n").filter(Boolean); } catch {}
    return { ...r, calls };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("flight-search CLI: Duffel refused, Google through bin/serpapi still answers (exit 0, with a note)", () => {
  const r = runFlightSearch(["LIS", "LHR", "--date", "2027-03-10", "--adults", "2"], {
    duffel: { status: 401, body: { errors: [{ message: "unauthorized" }] } },
    serpapi: { status: 200, body: GOOGLE_RESP },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.length, 2, r.calls.join("\n"));
  assert.ok(r.calls.every((u) => u.startsWith("https://api.duffel.com/") || u.startsWith("https://serpapi.com/")), r.calls.join("\n"));
  const serp = new URL(r.calls.find((u) => u.startsWith("https://serpapi.com/")));
  assert.equal(serp.searchParams.get("engine"), "google_flights");
  assert.equal(serp.searchParams.get("type"), "2");
  assert.equal(serp.searchParams.get("adults"), "2");
  assert.equal(serp.searchParams.get("q"), null, "google_flights takes no free-text query");
  assert.ok(r.stdout.startsWith("Note: Duffel unavailable this run (Duffel auth failed (HTTP 401)"), r.stdout);
  assert.match(r.stdout, /\n1 +google +USD 240\.00 +USD 120\.00 /);
  assert.ok(r.stdout.includes(`Google Flights page: ${GOOGLE_LINK}`), r.stdout);
});

test("flight-search CLI: --source duffel never spends a SerpApi search; --json output is the offer array", () => {
  const r = runFlightSearch(["--json", "LIS", "LHR", "--date", "2027-03-10", "--source", "duffel", "--adults", "2"], {
    duffel: { status: 200, body: { data: { offers: DUFFEL_OFFERS } } },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.calls.length === 1 && r.calls[0].startsWith("https://api.duffel.com/"), r.calls.join("\n"));
  const rows = JSON.parse(r.stdout);
  assert.deepEqual(rows.map((x) => [x.source, x.offer_id, x.price_per_person]), [["duffel", "off_1", 450], ["duffel", "off_2", 550.25]]);
  assert.ok(r.stderr.includes("  duffel: 2 offers"), r.stderr);
});
