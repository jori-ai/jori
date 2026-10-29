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
// Run: node --test tests/flights-scan.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gmailQueries, forwardQuery, mergeEntries, eventSpecs, action, isSameEvent,
  loadAirportTz, stationTime, normalizeStationTimes, normalizeEntries, scanReport, AIRPORT_TZ_FILE } from "../lib/flights-scan.mjs";

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
