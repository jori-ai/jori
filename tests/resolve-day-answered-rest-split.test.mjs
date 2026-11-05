// resolve-day-answered-rest-split.test.mjs — a rest his own past answer names is
// its own place, however close to the stop it was cut from.
//
// 2026-10-22, Portside: the phone named the 14:12 arrival "Café Corvina" and iOS ran
// that visit to 17:35. From 14:35 to 17:28 the fixes sat 3 m from the flat he has
// confirmed again and again, 73 m from the café, and the 14:16 rest sat by Tamsa,
// where he confirmed dinner the night before. The two rests were 128 m apart, under
// SPLIT_SEPARATION_M (130), so the cut was refused and the afternoon at the flat
// shipped as three hours at Café Corvina.
//
// Run: node --test tests/resolve-day-answered-rest-split.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { at as fakeAt, loadRows } from "./fixtures/fake-geo.mjs";
// Synthetic places (tests/fixtures/fake-geo.mjs): `e` metres east and `n` north
// of an obviously fake origin, keeping the real day's geometry.
const LL = (e, n, suf = "") => { const p = fakeAt(e, n); return { [`lat${suf}`]: p.lat, [`lon${suf}`]: p.lon }; };
const LLR = (e, n) => { const p = fakeAt(e, n); return { latitude: p.lat, longitude: p.lon }; };
const LLG = (e, n) => { const p = fakeAt(e, n); return { lat: p.lat, lng: p.lon }; };

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { splitWideStopsOnRests } = require(path.join(ROOT, "lib/resolve-day.js"))._internal;

// Every raw fix 14:09-17:35 local, as location_history held them (synthetic places).
const PINGS = loadRows(path.join(ROOT, "tests/fixtures/resolve-day-2026-10-22-afternoon.pings.json"), { latKey: "lat", lonKey: "lon" })
  .map(p => ({ ts: Date.parse(p.at), lat: p.lat, lon: p.lon, acc: p.acc, kind: p.kind, activity: p.activity }));

const T = (hms) => Date.parse(`2026-10-22T${hms}+03:00`);

// The stop as resolve-day had it: the café's arrival row, carried as user_confirmed.
const blend = () => ({
  id: "s-20261022-3", start: "14:12", end: "17:35",
  start_ts_ms: T("14:12:33"), end_ts_ms: T("17:35:58"), duration_min: 203,
  ...LL(0.0, 0.0), cluster_radius_km: 0.219, sample_count: 67,
  place: { name: "Café Corvina", address: null, source: "user_confirmed", confidence: 1, distance_m: 58 },
  confirmed_row: { id: "f90ec82f", name: "Café Corvina", place_type: "named" },
  photos: [], companions: [],
});

// His past answers (confirmed-stops.json), the three that sit near that afternoon.
const CONFIRMED = [
  { name: "The Harbor Flat", centroid: { ...LL(-15.09, -3.53) } },
  { name: "Café Corvina", centroid: { ...LL(59.28, -22.24) } },
  { name: "Tamsa", centroid: { ...LL(138.99, 18.58) } },
];
const ctx = () => ({ date: "2026-10-22", knownStopsEntries: [], confirmedStopsEntries: CONFIRMED, companionRows: [] });

test("the afternoon is cut at the flat his answers name, though the rests are 128 m apart", () => {
  const { stops, splits } = splitWideStopsOnRests([blend()], PINGS, ctx());
  assert.equal(splits.length, 1);
  assert.ok(!splits[0].kept_whole, JSON.stringify(splits[0]));
  assert.ok(splits[0].apart_m < 130, "still under the plain separation bar");
  const flat = stops.find(s => s.place.name === "The Harbor Flat");
  assert.ok(flat, JSON.stringify(stops.map(s => s.place.name)));
  assert.equal(flat.place.source, "confirmed_stop");
  assert.ok(flat.duration_min >= 170, `flat for ${flat.duration_min} min`);
  assert.ok(!stops.some(s => s.place.name === "Café Corvina" && s.duration_min > 60),
    "no long café stop is left");
});

test("JORI_SPLIT_ON_ANSWERED_REST=0 restores the old refusal", () => {
  process.env.JORI_SPLIT_ON_ANSWERED_REST = "0";
  try {
    const { stops, splits } = splitWideStopsOnRests([blend()], PINGS, ctx());
    assert.equal(splits[0].kept_whole, true);
    assert.equal(stops.length, 1);
    assert.equal(stops[0].place.name, "Café Corvina");
  } finally {
    delete process.env.JORI_SPLIT_ON_ANSWERED_REST;
  }
});

test("two close rests named only by the point resolver stay one place", () => {
  // No past answer at either rest: the 130 m footprint rule still holds.
  const c = { ...ctx(), confirmedStopsEntries: [],
    nameRest: (p) => { p.place = { name: p.start < "14:30" ? "Some bar" : "Some street",
                                   source: "osm_overpass", confidence: 0.6, distance_m: 10 }; } };
  const { stops, splits } = splitWideStopsOnRests([blend()], PINGS, c);
  assert.equal(splits[0].kept_whole, true);
  assert.equal(stops.length, 1);
});

test("a rest whose past answer is the stop's own name does not cut it", () => {
  // The rest at the flat answers "The Harbor Flat"; a stop already named that keeps whole.
  const b = { ...blend(), place: { ...blend().place, name: "The Harbor Flat" } };
  const c = { ...ctx(), confirmedStopsEntries: CONFIRMED.filter(e => e.name === "The Harbor Flat") };
  const { splits } = splitWideStopsOnRests([b], PINGS, c);
  assert.equal(splits[0].kept_whole, true, JSON.stringify(splits[0]));
});

// A stop cut on its rests keeps its own start when nothing before the first rest
// puts the user anywhere else. A night at the flat began before midnight, the
// phone lay silent until 1:00, and the morning café sat 148 m away in the same
// cluster: the first rest began at its first fix, so the day opened at 1:00am
// with its first hour belonging to no stop. Synthetic places and date.
const HT = (hms) => Date.parse(`2099-05-07T${hms}+02:00`);
const H_FLAT = fakeAt(0, 0), H_CAFE = fakeAt(148, 0), H_ELSEWHERE = fakeAt(600, 0);
const hfix = (hms, p) => ({ ts: HT(hms), lat: p.lat, lon: p.lon, acc: 10, kind: "fix", activity: "stationary" });
const H_NIGHT = ["01:00:07", "03:00:00", "05:00:00", "07:28:00", "08:30:00"].map(h => hfix(h, H_FLAT));
const H_MORNING = ["09:00:59", "09:10:00", "09:20:00", "09:30:00"].map(h => hfix(h, H_CAFE));
const nightBlend = () => {
  const mid = fakeAt(74, 0);
  return {
    id: "s-20990507-1", start: "00:00", end: "09:38",
    start_ts_ms: HT("00:00:00"), end_ts_ms: HT("09:38:00"), duration_min: 578,
    lat: mid.lat, lon: mid.lon, cluster_radius_km: 0.136, sample_count: 9,
    place: { name: "Café Example", address: null, source: "confirmed_stop", confidence: 0.95, distance_m: 20 },
    photos: [], companions: [],
  };
};
const headCtx = () => ({ date: "2099-05-07", knownStopsEntries: [], companionRows: [], confirmedStopsEntries: [
  { name: "The Example Flat", centroid: { lat: H_FLAT.lat, lon: H_FLAT.lon } },
  { name: "Café Example", centroid: { lat: H_CAFE.lat, lon: H_CAFE.lon } },
] });

test("the first piece keeps the stop's start when the phone was silent before the first rest", () => {
  const { stops, splits } = splitWideStopsOnRests([nightBlend()], [...H_NIGHT, ...H_MORNING], headCtx());
  assert.equal(splits.length, 1);
  assert.ok(!splits[0].kept_whole, JSON.stringify(splits[0]));
  const flat = stops.find(s => s.place.name === "The Example Flat");
  assert.ok(flat, JSON.stringify(stops.map(s => s.place.name)));
  assert.equal(flat.start_ts_ms, HT("00:00:00"));
  assert.equal(flat.end_ts_ms, HT("09:00:59"));
  const cafe = stops.find(s => s.place.name === "Café Example");
  assert.equal(cafe.start_ts_ms, HT("09:00:59"), "the second piece is untouched");
});

test("a fix elsewhere before the first rest leaves the rest's own start", () => {
  const { stops } = splitWideStopsOnRests([nightBlend()], [hfix("00:30:00", H_ELSEWHERE), ...H_NIGHT, ...H_MORNING], headCtx());
  const flat = stops.find(s => s.place.name === "The Example Flat");
  assert.ok(flat, JSON.stringify(stops.map(s => s.place.name)));
  assert.equal(flat.start_ts_ms, HT("01:00:07"));
});

test("JORI_SPLIT_KEEPS_HEAD=0 leaves the rest's own start", () => {
  process.env.JORI_SPLIT_KEEPS_HEAD = "0";
  try {
    const { stops } = splitWideStopsOnRests([nightBlend()], [...H_NIGHT, ...H_MORNING], headCtx());
    assert.equal(stops.find(s => s.place.name === "The Example Flat").start_ts_ms, HT("01:00:07"));
  } finally { delete process.env.JORI_SPLIT_KEEPS_HEAD; }
});

// ---------------------------------------------------------------------------
// A rest the calendar pins is its own place (nameRest's calendar rung).
//
// 2026-11-03: a 30-minute appointment at a bank branch ~140 m from the flat. The phone
// logged one visit row for the flat that ran all day; the branch left seven fixes in
// 34 seconds plus a photo half an hour later, and the cut found that rest. nameRest
// named it the flat (the named-location ring is 150 m and the rest sat inside it), so
// every rest "resolved to the same place", the stop was kept whole, and the appointment
// was listed as not matched to a location. An address that geocodes beside a rest which
// overlaps the event in time now names the rest. Synthetic places and date.
// ---------------------------------------------------------------------------
const { calendarBeatsRing, calendarRestPlace } = require(path.join(ROOT, "lib/resolve-day.js"))._internal;
const { haversineMeters: crHaversine } = require(path.join(ROOT, "lib/stop-rests.js"));
const crCalPlace = await import(path.join(ROOT, "lib/calendar-place.mjs"));

const CR_FLAT = fakeAt(0, 0);
const CR_BRANCH = fakeAt(0, -140);      // 140 m from the flat's ring centre: inside its 150 m ring
const CR_T = (hms) => Date.parse(`2099-05-07T${hms}+00:00`);
const crFix = (hms, p, activity = "stationary") => ({ ts: CR_T(hms), lat: p.lat, lon: p.lon, acc: 10, kind: "fix", activity });

// The flat all morning, a 34-second burst at the branch, a camera fix there 28 minutes
// later, then the flat again.
const CR_PINGS = [
  crFix("09:00:00", CR_FLAT), crFix("10:30:00", CR_FLAT), crFix("12:00:00", CR_FLAT), crFix("13:30:00", CR_FLAT),
  crFix("13:39:18", CR_BRANCH), crFix("13:39:24", CR_BRANCH, "unknown"), crFix("13:39:35", CR_BRANCH, "unknown"),
  crFix("13:39:52", CR_BRANCH), crFix("13:39:53", CR_BRANCH),
  { ts: CR_T("14:07:48"), lat: CR_BRANCH.lat, lon: CR_BRANCH.lon, acc: null, kind: "photo", activity: null },
  crFix("15:11:54", CR_FLAT), crFix("15:30:00", CR_FLAT), crFix("15:50:00", CR_FLAT),
];

const crBlend = () => ({
  id: "s-20990507-1", start: "09:00", end: "15:52",
  start_ts_ms: CR_T("09:00:00"), end_ts_ms: CR_T("15:52:00"), duration_min: 412,
  lat: CR_FLAT.lat, lon: CR_FLAT.lon, cluster_radius_km: 0.271, sample_count: 13,
  place: { name: "The Example Flat", address: null, source: "user_confirmed", confidence: 1, distance_m: 5 },
  confirmed_row: { id: "r1", name: "The Example Flat", place_type: "named" },
  photos: [], companions: [],
});

// The point resolver as it answered that day: the flat's ring, with its distance.
const crRing = (lat, lon) => ({ name: "The Example Flat", source: "named_location", confidence: 0.95,
  address: "1 Example St", distance_m: crHaversine(lat, lon, CR_FLAT.lat, CR_FLAT.lon), neighborhood: "Exampleville" });

const crEvent = (over = {}) => ({
  summary: "Appointment (Banking)", location: "9 Example Ave, Exampleville",
  start: { dateTime: "2099-05-07T13:30:00+00:00" }, end: { dateTime: "2099-05-07T14:00:00+00:00" }, ...over,
});
const crCalendar = (events, geo) => ({ mod: { placeEvents: crCalPlace.placeEvents, geocodeLocation: () => geo }, events });
const CR_AT_BRANCH = { lat: fakeAt(6, -140).lat, lon: fakeAt(6, -140).lon, name: "9 Example Ave", is_business: false };

const crCtx = (calendarCtx) => ({ date: "2099-05-07", knownStopsEntries: [], confirmedStopsEntries: [],
  companionRows: [], resolvePoint: crRing, calendar: calendarCtx });

test("a rest beside the appointment's address is named for it, and the stop is cut", () => {
  const { stops, splits } = splitWideStopsOnRests([crBlend()], CR_PINGS, crCtx(crCalendar([crEvent()], CR_AT_BRANCH)));
  assert.ok(!splits[0].kept_whole, JSON.stringify(splits[0]));
  const branch = stops.find(s => s.place.source === "calendar_corroborated");
  assert.ok(branch, JSON.stringify(stops.map(s => [s.start, s.end, s.place.name, s.place.source])));
  assert.equal(branch.place.name, "9 Example Ave");
  assert.equal(branch.start_ts_ms, CR_T("13:39:18"));
  assert.ok(branch.place.distance_m <= 50);
  const flats = stops.filter(s => s.place.name === "The Example Flat");
  assert.equal(flats.length, 2, "the flat on either side");
  assert.ok(flats[0].end_ts_ms <= branch.start_ts_ms && flats[1].start_ts_ms >= branch.end_ts_ms);
});

test("a business geocode names the rest for the business", () => {
  const geo = { ...CR_AT_BRANCH, name: "Example Bank", is_business: true };
  const { stops } = splitWideStopsOnRests([crBlend()], CR_PINGS, crCtx(crCalendar([crEvent()], geo)));
  assert.ok(stops.some(s => s.place.name === "Example Bank" && s.place.source === "calendar_corroborated"));
});

test("without the calendar the rest is the flat and the stop stays whole (the old answer)", () => {
  const { stops, splits } = splitWideStopsOnRests([crBlend()], CR_PINGS, crCtx(null));
  assert.equal(splits[0].kept_whole, true);
  assert.equal(stops.length, 1);
});

test("JORI_CALENDAR_REST_NAME=0 turns the rung off", () => {
  process.env.JORI_CALENDAR_REST_NAME = "0";
  try {
    const { splits } = splitWideStopsOnRests([crBlend()], CR_PINGS, crCtx(crCalendar([crEvent()], CR_AT_BRANCH)));
    assert.equal(splits[0].kept_whole, true);
  } finally { delete process.env.JORI_CALENDAR_REST_NAME; }
});

test("an appointment at the flat's own address changes nothing", () => {
  const atFlat = { lat: CR_FLAT.lat, lon: CR_FLAT.lon, name: "1 Example St", is_business: false };
  const { stops, splits } = splitWideStopsOnRests([crBlend()], CR_PINGS, crCtx(crCalendar([crEvent()], atFlat)));
  // The branch rest is 140 m from the event: out of reach. The flat rests sit on the
  // event but the ring is as near as the event, so no margin.
  assert.equal(splits[0].kept_whole, true);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].place.name, "The Example Flat");
});

test("an address 80 m from the rest is too far to name it", () => {
  const far = fakeAt(80, -140);
  const geo = { lat: far.lat, lon: far.lon, name: "9 Example Ave", is_business: false };
  const { splits } = splitWideStopsOnRests([crBlend()], CR_PINGS, crCtx(crCalendar([crEvent()], geo)));
  assert.equal(splits[0].kept_whole, true);
});

test("an event that ended before the rest began names nothing", () => {
  const early = crEvent({ start: { dateTime: "2099-05-07T09:00:00+00:00" }, end: { dateTime: "2099-05-07T09:30:00+00:00" } });
  const { splits } = splitWideStopsOnRests([crBlend()], CR_PINGS, crCtx(crCalendar([early], CR_AT_BRANCH)));
  assert.equal(splits[0].kept_whole, true);
});

test("a free (transparent) event names nothing", () => {
  const { splits } = splitWideStopsOnRests([crBlend()], CR_PINGS, crCtx(crCalendar([crEvent({ transparency: "transparent" })], CR_AT_BRANCH)));
  assert.equal(splits[0].kept_whole, true);
});

test("a geocoder or calendar failure leaves the ring's answer", () => {
  const boom = { mod: { placeEvents: () => { throw new Error("gog down"); }, geocodeLocation: () => null }, events: [crEvent()] };
  const { splits } = splitWideStopsOnRests([crBlend()], CR_PINGS, crCtx(boom));
  assert.equal(splits[0].kept_whole, true);
});

test("the tightest event wins over a longer block at the same address", () => {
  const block = crEvent({ summary: "Errands", start: { dateTime: "2099-05-07T12:00:00+00:00" }, end: { dateTime: "2099-05-07T16:00:00+00:00" },
                        location: "9 Example Ave, Exampleville" });
  const geos = { "a": { ...CR_AT_BRANCH, name: "9 Example Ave" } };
  const cal = { mod: { placeEvents: crCalPlace.placeEvents, geocodeLocation: () => geos.a }, events: [block, crEvent()] };
  const piece = { start_ts_ms: CR_T("13:39:18"), end_ts_ms: CR_T("15:11:54"), lat: CR_BRANCH.lat, lon: CR_BRANCH.lon };
  const got = calendarRestPlace(piece, { calendar: cal });
  assert.equal(got.summary, "Appointment (Banking)");
});

test("calendarBeatsRing: only a ring name much farther than the event, or a bare neighbourhood", () => {
  const cal = { distance_m: 10 };
  assert.equal(calendarBeatsRing(null, null, cal), true);
  assert.equal(calendarBeatsRing({ source: "neighborhood" }, null, cal), true);
  assert.equal(calendarBeatsRing({ source: "named_location" }, { distance_m: 120 }, cal), true);
  assert.equal(calendarBeatsRing({ source: "named_location" }, { distance_m: 40 }, cal), false, "the crRing is nearly as close");
  assert.equal(calendarBeatsRing({ source: "named_location" }, {}, cal), false, "no crRing distance, no override");
  assert.equal(calendarBeatsRing({ source: "wifi_ssid" }, { distance_m: 140 }, cal), false);
  assert.equal(calendarBeatsRing({ source: "confirmed_stop" }, { distance_m: 140 }, cal), false);
  assert.equal(calendarBeatsRing({ source: "known_recurring" }, { distance_m: 140 }, cal), false);
});

// ---------------------------------------------------------------------------
// A booking at the stop's own address beats a name the 30 m ring found from an
// older answer. `confirmed_stop` is a proximity match to a place named on an
// earlier day; two venues facing each other across a street both sit inside it,
// and the ring names whichever was confirmed first. A timed, opaque, physical
// event that covers the stop and geocodes beside it is today's evidence and names
// the other door. Synthetic places and date.
// ---------------------------------------------------------------------------
const { calendarOverProximityName } = require(path.join(ROOT, "lib/resolve-day.js"))._internal;

const BP_T = (hms) => Date.parse(`2099-05-07T${hms}+00:00`);
const BP_STOP_AT = fakeAt(0, 0);
const BP_BOOKED_AT = fakeAt(15, 0);   // the booked venue's door, 15 m from the stop

const bpStopNamedByRing = (over = {}) => ({
  id: "s-20990507-2", start: "17:50", end: "19:45",
  start_ts_ms: BP_T("17:50:00"), end_ts_ms: BP_T("19:45:00"), duration_min: 115,
  lat: BP_STOP_AT.lat, lon: BP_STOP_AT.lon,
  place: { name: "Jazz Club Example", address: "131 Example St", source: "confirmed_stop", confidence: 0.95, distance_m: 6 },
  calendar_event: { summary: "Headliner at Comedy Club Example", location: "Comedy Room Example, 130 Example St",
                    location_match: true, physical: true, event_share: 0.7 },
  confirmed_row: null, photos: [], companions: [],
  ...over,
});

const bpBooking = (over = {}) => ({
  summary: "Headliner at Comedy Club Example", location: "Comedy Room Example, 130 Example St, Exampleville",
  start: { dateTime: "2099-05-07T18:00:00+00:00" }, end: { dateTime: "2099-05-07T20:30:00+00:00" }, ...over,
});

const bpGeoAt = (p, name = "Comedy Room Example") => ({ lat: p.lat, lon: p.lon, name, is_business: true });
const bpCtxFor = (events, geo) => ({
  date: "2099-05-07", knownStopsEntries: [], confirmedStopsEntries: [], companionRows: [],
  calendar: { mod: { placeEvents: crCalPlace.placeEvents, geocodeLocation: () => geo }, events },
});

test("the booked venue's name replaces the ring's, and the old name stays visible", () => {
  const stops = [bpStopNamedByRing()];
  const named = calendarOverProximityName(stops, bpCtxFor([bpBooking()], bpGeoAt(BP_BOOKED_AT)));
  assert.equal(stops[0].place.name, "Comedy Room Example");
  assert.equal(stops[0].place.source, "calendar_corroborated");
  assert.equal(stops[0].displaced_label, "Jazz Club Example");
  assert.equal(named.length, 1);
  assert.deepEqual([named[0].name, named[0].was], ["Comedy Room Example", "Jazz Club Example"]);
  assert.ok(stops[0].place.distance_m <= 50);
});

test("an address the geocoder reads as a bare street names the stop by the event's own venue field", () => {
  const stops = [bpStopNamedByRing()];
  calendarOverProximityName(stops, bpCtxFor([bpBooking()], { ...bpGeoAt(BP_BOOKED_AT), is_business: false, name: "130 Example St" }));
  assert.equal(stops[0].place.name, "Comedy Room Example");
});

test("an answer about this window is never replaced", () => {
  const stops = [bpStopNamedByRing({ place: { name: "Jazz Club Example", source: "user_confirmed", confidence: 1 } })];
  assert.deepEqual(calendarOverProximityName(stops, bpCtxFor([bpBooking()], bpGeoAt(BP_BOOKED_AT))), []);
  assert.equal(stops[0].place.name, "Jazz Club Example");
});

test("home, a known recurring place and a wifi name are left alone", () => {
  for (const source of ["named_location", "known_recurring", "wifi_ssid"]) {
    const stops = [bpStopNamedByRing({ place: { name: "Jazz Club Example", source, confidence: 0.95 } })];
    assert.deepEqual(calendarOverProximityName(stops, bpCtxFor([bpBooking()], bpGeoAt(BP_BOOKED_AT))), [], source);
    assert.equal(stops[0].place.name, "Jazz Club Example");
  }
});

test("an event at the same venue under another spelling changes nothing", () => {
  const stops = [bpStopNamedByRing()];
  assert.deepEqual(calendarOverProximityName(stops, bpCtxFor([bpBooking()], bpGeoAt(BP_BOOKED_AT, "The Jazz Club Example"))), []);
  assert.equal(stops[0].place.source, "confirmed_stop");
});

test("an event that covers little of the stop names nothing", () => {
  const stops = [bpStopNamedByRing()];
  const late = bpBooking({ start: { dateTime: "2099-05-07T19:30:00+00:00" }, end: { dateTime: "2099-05-07T20:30:00+00:00" } });
  assert.deepEqual(calendarOverProximityName(stops, bpCtxFor([late], bpGeoAt(BP_BOOKED_AT))), []);
  assert.equal(stops[0].place.name, "Jazz Club Example");
});

test("a long event the stop only passed through names nothing", () => {
  const stops = [bpStopNamedByRing()];
  const block = bpBooking({ start: { dateTime: "2099-05-07T17:00:00+00:00" }, end: { dateTime: "2099-05-07T23:00:00+00:00" } });
  assert.deepEqual(calendarOverProximityName(stops, bpCtxFor([block], bpGeoAt(BP_BOOKED_AT))), []);
  assert.equal(stops[0].place.name, "Jazz Club Example");
});

test("an address 80 m from the stop is too far to name it", () => {
  const stops = [bpStopNamedByRing()];
  assert.deepEqual(calendarOverProximityName(stops, bpCtxFor([bpBooking()], bpGeoAt(fakeAt(80, 0)))), []);
  assert.equal(stops[0].place.name, "Jazz Club Example");
});

test("a free (transparent) event names nothing", () => {
  const stops = [bpStopNamedByRing()];
  assert.deepEqual(calendarOverProximityName(stops, bpCtxFor([bpBooking({ transparency: "transparent" })], bpGeoAt(BP_BOOKED_AT))), []);
  assert.equal(stops[0].place.name, "Jazz Club Example");
});

test("a video call is not a place", () => {
  const stops = [bpStopNamedByRing()];
  assert.deepEqual(calendarOverProximityName(stops, bpCtxFor([bpBooking({ location: "https://meet.example.com/abc" })], bpGeoAt(BP_BOOKED_AT))), []);
});

test("a stop the user said was not a stop is left alone", () => {
  const stops = [bpStopNamedByRing({ user_non_stop: true })];
  assert.deepEqual(calendarOverProximityName(stops, bpCtxFor([bpBooking()], bpGeoAt(BP_BOOKED_AT))), []);
});

test("no calendar, or a calendar or geocoder failure, leaves the ring's answer", () => {
  const stops = [bpStopNamedByRing()];
  assert.deepEqual(calendarOverProximityName(stops, { date: "2099-05-07", calendar: null }), []);
  const boom = { date: "2099-05-07", calendar: { mod: { placeEvents: () => { throw new Error("gog down"); }, geocodeLocation: () => null }, events: [bpBooking()] } };
  assert.deepEqual(calendarOverProximityName(stops, boom), []);
  assert.deepEqual(calendarOverProximityName(stops, bpCtxFor([bpBooking()], null)), []);
  assert.equal(stops[0].place.name, "Jazz Club Example");
});

test("JORI_CALENDAR_OVER_PROXIMITY=0 turns the pass off", () => {
  process.env.JORI_CALENDAR_OVER_PROXIMITY = "0";
  try {
    const stops = [bpStopNamedByRing()];
    assert.deepEqual(calendarOverProximityName(stops, bpCtxFor([bpBooking()], bpGeoAt(BP_BOOKED_AT))), []);
    assert.equal(stops[0].place.name, "Jazz Club Example");
  } finally { delete process.env.JORI_CALENDAR_OVER_PROXIMITY; }
});
