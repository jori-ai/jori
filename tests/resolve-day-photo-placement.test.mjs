// resolve-day-photo-placement.test.mjs — a photo is shown under the place it was
// taken at, once, and that place's time covers it.
//
// The incident (2026-10-21, Portside; Mason, Oct 22: "This photo at Tamsa bar
// belongs with the section below and sets the time we got there. Not sure why
// it's shown with the previous section."). At 20:40:09 (17:40:09Z) he
// photographed the table at Tamsa, 3 m from the bar and 155 m from the flat. The
// evening at the flat was one wide stop that splitWideStopsOnRests re-cut into
// rests, and a rest ends on the first fix ELSEWHERE, which here was that photo:
// the flat's rest ran to 17:40:09.481 and Tamsa's began at 17:40:09.481. Both
// pieces kept the photo (the filter was inclusive at both ends), later passes
// trimmed the flat to 20:36, and the email showed the photo at the bottom of the
// flat's section as well as under Tamsa.
//
// Pinned here:
//   1. the split hands a photo at the boundary instant to the piece it begins;
//   2. pinStopsToPhotos: a photo whose GPS puts it at a stop, just outside that
//      stop's window, moves the arrival back (or the departure on) to it, and
//      the neighbour gives way, with its guards;
//   3. settleStopPhotos: each photo ends on exactly one stop, the one whose
//      window holds the moment it was taken.
//
// Run: node --test tests/resolve-day-photo-placement.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { at as fakeAt } from "./fixtures/fake-geo.mjs";
// Synthetic places (tests/fixtures/fake-geo.mjs): `e` metres east and `n` north
// of an obviously fake origin, keeping the real day's geometry.
const LL = (e, n, suf = "") => { const p = fakeAt(e, n); return { [`lat${suf}`]: p.lat, [`lon${suf}`]: p.lon }; };
const LLR = (e, n) => { const p = fakeAt(e, n); return { latitude: p.lat, longitude: p.lon }; };
const PT = (e, n) => { const p = fakeAt(e, n); return [p.lat, p.lon]; };
const LLG = (e, n) => { const p = fakeAt(e, n); return { lat: p.lat, lng: p.lon }; };

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { haversineMeters } = require(path.join(ROOT, "lib/stop-rests.js"));
const { splitWideStopsOnRests, pinStopsToPhotos, settleStopPhotos, PHOTO_PIN_MAX_MS } =
  require(path.join(ROOT, "lib/resolve-day.js"))._internal;

const MIN = 60_000;
const U = (hms) => Date.parse(`2026-10-21T${hms}Z`);
const FLAT = { ...LL(0.0, 0.0) };
const SHAFA = { ...LL(156.5, 19.97) };

// The evening's fixes, from location_history (UTC; Israel is UTC+3), with the
// three photos folded in as fixes the way resolve-day's photoPings does.
const p = (hms, lat, lon, acc, kind, activity = null) => ({ ts: U(hms), lat, lon, acc, kind, activity });
const cam = (hms, lat, lon, uuid) => ({ ts: U(hms), lat, lon, acc: null, kind: "photo", activity: null, uuid });
const PINGS = [
  p("13:02:56", ...PT(97.05, 9.4), 3.9, "transit", "walking"),
  p("14:18:16", ...PT(0.04, 0.02), 23.5, "transit", "stationary"),
  p("14:21:33", ...PT(-0.01, -0.01), 11.5, "transit", "stationary"),
  p("14:21:44", ...PT(0.0, 0.0), 10.5, "transit", "stationary"),
  p("17:17:37", ...PT(153.79, 16.38), null, "visit"),
  p("17:17:37", ...PT(0.08, 0.2), 5.5, "transit", "unknown"),
  p("17:17:44", ...PT(0.08, 0.2), 7.4, "transit", "unknown"),
  p("17:22:28", ...PT(0.08, 0.19), 10.3, "transit", "unknown"),
  cam("17:40:09.481", ...PT(153.79, 16.38), "C92ABCE3"),
  p("18:49:34.034", ...PT(157.4, 21.17), null, "visit"),
  cam("18:52:02.817", ...PT(158.03, 21.94), "D6494DA3"),
  cam("18:52:05.251", ...PT(156.77, 20.41), "72C0D0EA"),
  p("19:40:47", ...PT(0.35, 0.57), 15.3, "transit", "unknown"),
  p("19:42:12", ...PT(-0.27, 1.61), 13.9, "transit", "unknown"),
  p("19:50:03", ...PT(0.03, 0.17), 6.9, "transit", "unknown"),
  p("19:53:32", ...PT(0.06, 0.19), 6.8, "transit", "stationary"),
  p("20:16:08", ...PT(0.07, 0.19), 18.3, "transit", "stationary"),
].sort((a, b) => a.ts - b.ts);

const PHOTO_ROWS = [
  { uuid: "C92ABCE3", taken_at: "2026-10-21T17:40:09.481+00:00", ...LLR(153.79, 16.38), self_captured: true },
  { uuid: "D6494DA3", taken_at: "2026-10-21T18:52:02.817+00:00", ...LLR(158.03, 21.94), self_captured: true },
  { uuid: "72C0D0EA", taken_at: "2026-10-21T18:52:05.251+00:00", ...LLR(156.77, 20.41), self_captured: true },
];
const photo = (uuid) => ({ uuid, ts: PHOTO_ROWS.find(r => r.uuid === uuid).taken_at });
const uuidsOn = (s) => (s.photos || []).map(x => x.uuid);

// The evening as it reached splitWideStopsOnRests: the phone's "Pella" geofence
// row (place_type `named`, so re-cut), widened over the whole evening.
const evening = () => ({
  id: "s-20261021-8", start: "16:04", end: "23:16", start_ts_ms: U("13:04:00"), end_ts_ms: U("20:16:08"),
  duration_min: 432, ...LL(75.57, 6.51), cluster_radius_km: 0.189, sample_count: 30,
  place: { name: "Pella", source: "user_confirmed", confidence: 1 },
  confirmed_row: { id: "e8778741", name: "Pella", start_ms: U("17:17:37"), end_ms: U("17:40:09.481"), place_type: "named" },
  photos: ["C92ABCE3", "D6494DA3", "72C0D0EA"].map(photo),
});
const nameRest = (piece) => {
  const f = haversineMeters(piece.lat, piece.lon, FLAT.lat, FLAT.lon);
  const s = haversineMeters(piece.lat, piece.lon, SHAFA.lat, SHAFA.lon);
  piece.place = { name: f < s ? "The Harbor Flat" : "Tamsa", source: "confirmed_stop", confidence: 0.95, distance_m: Math.round(Math.min(f, s)) };
};

test("the split gives the photo that ended the flat's rest to Tamsa only", () => {
  const { stops } = splitWideStopsOnRests([evening()], PINGS, { date: "2026-10-21", knownStopsEntries: [], nameRest });
  const flatBefore = stops.find(s => s.place.name === "The Harbor Flat" && s.end_ts_ms === U("17:40:09.481"));
  const shafa = stops.find(s => s.place.name === "Tamsa");
  assert.ok(flatBefore, "the flat's rest ends on the photo, the first fix elsewhere");
  assert.equal(shafa.start_ts_ms, U("17:40:09.481"), "and Tamsa's rest begins on it");
  assert.deepEqual(uuidsOn(flatBefore), [], "not on the flat");
  assert.deepEqual(uuidsOn(shafa).sort(), ["72C0D0EA", "C92ABCE3", "D6494DA3"]);
  const all = stops.flatMap(uuidsOn);
  assert.equal(all.length, new Set(all).size, "no photo on two pieces");
});

test("the last piece still keeps a photo taken at the window's very end", () => {
  const s = evening();
  s.photos = [{ uuid: "END", ts: new Date(U("20:16:08")).toISOString() }];
  const { stops } = splitWideStopsOnRests([s], PINGS, { date: "2026-10-21", knownStopsEntries: [], nameRest });
  assert.deepEqual(uuidsOn(stops[stops.length - 1]), ["END"]);
});

// The two stops as they stood before the silence pass, with the flat still
// holding the photo the old split gave it.
const flatStop = (endHms = "17:38:00") => ({
  id: "s-7", start: "17:18", end: "20:38", start_ts_ms: U("14:18:16"), end_ts_ms: U(endHms),
  duration_min: 0, lat: FLAT.lat, lon: FLAT.lon, place: { name: "The Harbor Flat", source: "confirmed_stop" },
  photos: [photo("C92ABCE3")],
});
const shafaStop = (startHms = "17:41:00") => ({
  id: "s-8", start: "20:41", end: "22:39", start_ts_ms: U(startHms), end_ts_ms: U("19:39:00"),
  duration_min: 0, lat: SHAFA.lat, lon: SHAFA.lon, place: { name: "Tamsa", source: "user_confirmed" },
  photos: ["C92ABCE3", "D6494DA3", "72C0D0EA"].map(photo),
});

test("pin: Tamsa is reached no later than its first photo, and the photo leaves the flat", () => {
  const [flat, shafa] = [flatStop(), shafaStop()];
  const out = pinStopsToPhotos([flat, shafa], PHOTO_ROWS, PINGS);
  assert.equal(shafa.start_ts_ms, U("17:40:09.481"));
  assert.equal(flat.end_ts_ms, U("17:38:00"), "the flat already ended before the photo");
  assert.deepEqual(uuidsOn(flat), []);
  assert.ok(uuidsOn(shafa).includes("C92ABCE3"));
  assert.equal(out.length, 1);
  assert.equal(out[0].edge, "arrival");
  assert.equal(out[0].neighbour, null);
});

test("pin: a flat that runs past the photo gives way to it", () => {
  const [flat, shafa] = [flatStop("17:45:00"), shafaStop("17:46:00")];
  pinStopsToPhotos([flat, shafa], PHOTO_ROWS, PINGS);
  assert.equal(shafa.start_ts_ms, U("17:40:09.481"));
  assert.equal(flat.end_ts_ms, U("17:40:09.481"), "the flat ends where the photo puts him at Tamsa");
  assert.deepEqual(uuidsOn(flat), []);
});

test("pin: a fix back at the flat between the photo and the stop leaves it alone", () => {
  const [flat, shafa] = [flatStop("17:45:00"), shafaStop("17:46:00")];
  const pings = [...PINGS, p("17:43:00", FLAT.lat, FLAT.lon, 8, "transit", "stationary")].sort((a, b) => a.ts - b.ts);
  const out = pinStopsToPhotos([flat, shafa], PHOTO_ROWS, pings);
  assert.equal(out.length, 0);
  assert.equal(shafa.start_ts_ms, U("17:46:00"));
});

test("pin: no further than PHOTO_PIN_MAX_MS", () => {
  const late = new Date(U("17:40:09.481") + PHOTO_PIN_MAX_MS + MIN).toISOString().slice(11, 23);
  const [flat, shafa] = [flatStop(), shafaStop(late)];
  assert.equal(pinStopsToPhotos([flat, shafa], PHOTO_ROWS, PINGS).length, 0);
});

test("pin: the neighbour keeps a stop's worth of time, or nothing moves", () => {
  const flat = { ...flatStop("17:45:00"), start_ts_ms: U("17:35:00") };
  const shafa = shafaStop("17:46:00");
  assert.equal(pinStopsToPhotos([flat, shafa], PHOTO_ROWS, PINGS).length, 0, "the flat would keep 5 minutes");
  assert.equal(flat.end_ts_ms, U("17:45:00"));
});

test("pin: GPS that cannot tell the two places apart moves nothing", () => {
  const near = { ...flatStop("17:45:00"), ...LL(122.69, 16.51) };   // ~30 m from the photo
  const shafa = shafaStop("17:46:00");
  assert.equal(pinStopsToPhotos([near, shafa], PHOTO_ROWS, PINGS).length, 0);
});

test("pin: a departure runs on to a photo taken there, and the next place starts after the walk", () => {
  const shafa = { ...shafaStop("17:40:09.481"), end_ts_ms: U("18:50:00") };
  const flat = { ...flatStop(), id: "s-9", start_ts_ms: U("18:51:00"), end_ts_ms: U("20:16:08"), photos: [] };
  const out = pinStopsToPhotos([shafa, flat], PHOTO_ROWS, PINGS);
  assert.deepEqual(out.map(x => x.edge), ["departure", "departure"], "one step per photo, in time order");
  assert.equal(shafa.end_ts_ms, U("18:52:05.251"), "to the last photo taken there");
  assert.ok(flat.start_ts_ms > U("18:52:05.251"), "the flat starts after both photos and the walk");
  assert.ok(flat.start_ts_ms < U("18:56:00"), "about two minutes on foot for 155 m");
});

test("pin: JORI_PHOTO_PIN=0 turns it off", () => {
  process.env.JORI_PHOTO_PIN = "0";
  try {
    const [flat, shafa] = [flatStop(), shafaStop()];
    assert.equal(pinStopsToPhotos([flat, shafa], PHOTO_ROWS, PINGS).length, 0);
    assert.equal(shafa.start_ts_ms, U("17:41:00"));
  } finally { delete process.env.JORI_PHOTO_PIN; }
});

// The two stops as they shipped on Oct 21: the flat 16:02-20:36, Tamsa 20:38-22:37.
const shipped = () => [
  { ...flatStop("17:36:58"), start_ts_ms: U("13:02:56"), photos: [photo("C92ABCE3")] },
  { ...shafaStop("17:38:52"), end_ts_ms: U("19:37:36") },
];

test("settle: the photo on both stops stays only under Tamsa, whose time holds it", () => {
  const [flat, shafa] = shipped();
  const out = settleStopPhotos([flat, shafa], PHOTO_ROWS);
  assert.deepEqual(uuidsOn(flat), []);
  assert.deepEqual(uuidsOn(shafa).sort(), ["72C0D0EA", "C92ABCE3", "D6494DA3"]);
  assert.deepEqual(out, [{ uuid: "C92ABCE3", to: "s-8", name: "Tamsa", from: ["s-7"], moved: false }]);
});

test("settle: a photo only the flat holds moves to the stop whose window holds it", () => {
  const [flat, shafa] = shipped();
  shafa.photos = shafa.photos.filter(x => x.uuid !== "C92ABCE3");
  settleStopPhotos([flat, shafa], PHOTO_ROWS);
  assert.deepEqual(uuidsOn(flat), []);
  assert.ok(uuidsOn(shafa).includes("C92ABCE3"));
});

test("settle: its own GPS keeps it where it is when that is nearer than the stop the clock picks", () => {
  const [flat, shafa] = shipped();
  const rows = [{ ...PHOTO_ROWS[0], latitude: FLAT.lat, longitude: FLAT.lon }];   // taken at the flat
  shafa.photos = [];
  settleStopPhotos([flat, shafa], rows);
  assert.deepEqual(uuidsOn(flat), ["C92ABCE3"]);
  assert.deepEqual(uuidsOn(shafa), []);
});

// A stop the email shows: a name he confirmed, an hour long.
const place = (id, from, to, lat, lon, photos = []) => ({ id, start_ts_ms: U(from), end_ts_ms: U(to),
  duration_min: Math.round((U(to) - U(from)) / MIN), lat, lon, place: { name: id, source: "confirmed_stop" }, photos });

test("settle: without GPS, the boundary instant belongs to the place that begins there", () => {
  const a = place("a", "10:00:00", "11:00:00", 1, 1, [{ uuid: "X", ts: "2026-10-21T11:00:00Z" }]);
  const b = place("b", "11:00:00", "12:00:00", 2, 2, [{ uuid: "X", ts: "2026-10-21T11:00:00Z" }]);
  settleStopPhotos([a, b], []);
  assert.deepEqual(uuidsOn(a), []);
  assert.deepEqual(uuidsOn(b), ["X"]);
});

test("settle: a photo taken between places stays on one stop, the nearest in time", () => {
  const a = place("a", "10:00:00", "11:00:00", 1, 1, [{ uuid: "W", ts: "2026-10-21T11:05:00Z" }]);
  const b = place("b", "11:30:00", "12:00:00", 2, 2, [{ uuid: "W", ts: "2026-10-21T11:05:00Z" }]);
  settleStopPhotos([a, b], []);
  assert.deepEqual(uuidsOn(a), ["W"]);
  assert.deepEqual(uuidsOn(b), []);
});

test("settle: a stretch the email does not show as a place never takes a photo", () => {
  const home = place("h", "10:00:00", "11:00:00", 1, 1, [{ uuid: "M", ts: "2026-10-21T11:10:00Z" }]);
  const moving = { id: "m", start_ts_ms: U("11:05:00"), end_ts_ms: U("11:20:00"), lat: 2, lon: 2, is_movement: true, photos: [] };
  assert.equal(settleStopPhotos([home, moving], []).length, 0);
  assert.deepEqual(uuidsOn(home), ["M"]);
});

// The critic's case: a 15-minute café the resolver only guessed is not drawn in
// the email (isMainStop), so a photo moved onto it would vanish.
const guessedCafe = () => ({ id: "cafe", start_ts_ms: U("17:39:00"), end_ts_ms: U("17:54:00"), duration_min: 15,
  lat: SHAFA.lat, lon: SHAFA.lon, place: { name: "Some café", source: "google_places" }, photos: [] });

test("settle: a photo is never moved onto a stop the email does not show", () => {
  const flat = { ...flatStop("17:38:00"), photos: [photo("C92ABCE3")] };
  const cafe = guessedCafe();
  assert.equal(settleStopPhotos([flat, cafe], PHOTO_ROWS).length, 0);
  assert.deepEqual(uuidsOn(flat), ["C92ABCE3"]);
});

test("settle: of two holders, the one the email shows keeps it", () => {
  const flat = { ...flatStop("17:38:00"), photos: [photo("C92ABCE3")] };
  const cafe = { ...guessedCafe(), photos: [photo("C92ABCE3")] };
  settleStopPhotos([flat, cafe], PHOTO_ROWS);
  assert.deepEqual(uuidsOn(flat), ["C92ABCE3"]);
  assert.deepEqual(uuidsOn(cafe), []);
});

test("pin: a stop the email does not show is not pinned and does not take the photo", () => {
  const flat = flatStop("17:38:00");
  const cafe = { ...guessedCafe(), start_ts_ms: U("17:41:00") };
  assert.equal(pinStopsToPhotos([flat, cafe], PHOTO_ROWS, PINGS).length, 0);
  assert.deepEqual(uuidsOn(flat), ["C92ABCE3"]);
});

test("pin: a neighbour the email shows is not trimmed out of it", () => {
  const before = { id: "n", start_ts_ms: U("17:12:00"), end_ts_ms: U("17:47:00"), duration_min: 35,
    lat: FLAT.lat, lon: FLAT.lon, place: { name: "A guess", source: "osm_overpass" }, photos: [] };
  const shafa = shafaStop("17:48:00");
  const pings = PINGS.filter(q => q.ts < U("17:12:00") || q.ts > U("17:47:00") || q.kind === "photo");
  assert.equal(pinStopsToPhotos([before, shafa], PHOTO_ROWS, pings).length, 0, "35 min would become 28, under the email's 30");
  assert.equal(before.end_ts_ms, U("17:47:00"));
});

test("pin: a walk between the photo and the stop leaves both alone", () => {
  const [flat, shafa] = [flatStop("17:30:00"), shafaStop("17:46:00")];
  const walk = { id: "w", start_ts_ms: U("17:30:00"), end_ts_ms: U("17:45:00"), duration_min: 15,
    ...LL(66.14, -37.97), excursion: true, place: { name: "Walk", source: "excursion" }, photos: [] };
  assert.equal(pinStopsToPhotos([flat, walk, shafa], PHOTO_ROWS, PINGS).length, 0);
  assert.equal(shafa.start_ts_ms, U("17:46:00"));
});

test("settle: JORI_PHOTO_SETTLE=0 turns it off", () => {
  process.env.JORI_PHOTO_SETTLE = "0";
  try {
    const [flat, shafa] = shipped();
    assert.equal(settleStopPhotos([flat, shafa], PHOTO_ROWS).length, 0);
    assert.deepEqual(uuidsOn(flat), ["C92ABCE3"]);
  } finally { delete process.env.JORI_PHOTO_SETTLE; }
});
