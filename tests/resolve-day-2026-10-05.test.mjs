// resolve-day-2026-10-05.test.mjs — three defects in the "Day of Monday,
// October 5" email (Portside), each pinned here. Mason, 2026-10-06:
//
//   1) "Cafe Corvina appears twice - why? It was one stop"
//   3) "The 3:06 event appears as unlabeled. If we're not confident it's a
//       separate location, why list it as such?"
//   5) "6:54pm IDT · unlabeled should have been Merin - with Evan and Ivy"
//
// Run: node --test tests/resolve-day-2026-10-05.test.mjs

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
const { addSpineDwells, dropUnrestedStops, unnameGuesses } =
  require(path.join(ROOT, "lib/resolve-day.js"))._internal;

const T = (hms) => Date.parse(`2026-10-05T${hms}+03:00`);
const FLAT = { ...LL(0.0, 0.0) };
const ANTILIA = { ...LL(129.3, 173.35) };

// ---------------------------------------------------------------------------
// 1. A borrowed name MOVES when the answer was about the new window.
// ---------------------------------------------------------------------------

const antiliaPlace = { name: "Café Corvina - coffee this morning", source: "user_confirmed", confidence: 1 };
const confirmedRow = { id: "0cbcfee0", name: antiliaPlace.name, start_ms: T("09:04:57"), end_ms: T("09:24:07") };

function antiliaDay(remnantEnd) {
  // The cluster that carried the answer, after the spine clipped it to its tail.
  const remnant = {
    id: "s-2", start: "08:14", end: "x", start_ts_ms: T("08:14:56"), end_ts_ms: T(remnantEnd),
    ...LL(-34.21, -20.02), place: { ...antiliaPlace }, photos: [],
    confirmed_row: { ...confirmedRow }, clipped_by_spine: true,
  };
  const spine = { spine: [{ id: "d1", type: "dwell", major: true,
    start_ms: T("09:04:57"), end_ms: T("09:24:07"),
    place: { ...ANTILIA, name: antiliaPlace.name, tier: "user-confirmed" } }] };
  return { stops: [remnant], spine };
}

test("the answer leaves a short remnant it was never about", () => {
  const { stops, spine } = antiliaDay("08:15:56");
  const added = addSpineDwells(stops, spine);
  const named = stops.filter(s => s.place && s.place.name === antiliaPlace.name);
  assert.equal(named.length, 1, "Corvina is one stop, not two");
  assert.equal(named[0].start_ts_ms, T("09:04:57"));
  assert.deepEqual(added[0].moved_from, { id: "s-2", dropped: true });
});

test("a longer remnant stays, but no longer carries the name", () => {
  const { stops, spine } = antiliaDay("08:40:00");
  addSpineDwells(stops, spine);
  const remnant = stops.find(s => s.id === "s-2");
  assert.ok(remnant, "26 minutes is kept");
  assert.equal(remnant.place.name, null);
  assert.equal(stops.filter(s => s.place.name === antiliaPlace.name).length, 1);
});

test("a twin whose answer still overlaps its own window keeps it (copy, not move)", () => {
  const { stops, spine } = antiliaDay("09:10:00");   // remnant overlaps the confirmed row
  addSpineDwells(stops, spine);
  assert.equal(stops.find(s => s.id === "s-2").place.name, antiliaPlace.name);
});

// ---------------------------------------------------------------------------
// 3. An unrested window between two stays at the same place is not a stop.
// ---------------------------------------------------------------------------

// Three precise fixes drifting ~250 m — no rest anywhere in the window.
const WALK_PINGS = [
  { ts: T("15:06:00"), ...LL(-133.17, -76.5), acc: 12, kind: "transit", activity: "walking" },
  { ts: T("15:20:00"), ...LL(-246.27, -198.81), acc: 10, kind: "transit", activity: "walking" },
  { ts: T("15:44:00"), ...LL(-38.92, -20.9), acc: 14, kind: "transit", activity: "walking" },
];
const gap = { id: "s-6", start: "15:06", end: "15:46", start_ts_ms: T("15:06:00"),
  end_ts_ms: T("15:46:00"), duration_min: 40, ...LL(-177.94, -107.3), photos: [],
  place: { name: null, source: "unknown", confidence: 0 } };
const home = (id, a, b) => ({ id, start_ts_ms: T(a), end_ts_ms: T(b), ...FLAT, photos: [],
  place: { name: "The Harbor Flat", source: "user_confirmed", confidence: 1 } });

test("out and back from the flat is not an 'unlabeled' stop", () => {
  const stops = [home("s-5", "14:44:00", "15:06:00"), { ...gap }, home("s-7", "15:50:00", "16:09:00")];
  const out = dropUnrestedStops(stops, WALK_PINGS);
  assert.equal(out.stops.length, 2);
  assert.ok(!out.stops.some(s => s.id === "s-6"));
  assert.match(out.dropped[0].reason, /same place/);
});

test("the same window between two DIFFERENT places is still a question", () => {
  const elsewhere = { ...home("s-7", "15:50:00", "16:09:00"), ...LL(-604.45, -1088.36) };
  const out = dropUnrestedStops([home("s-5", "14:44:00", "15:06:00"), { ...gap }, elsewhere], WALK_PINGS);
  assert.ok(out.stops.some(s => s.id === "s-6" && s.unrested));
});

// ---------------------------------------------------------------------------
// 5. A geocoder name the calendar independently names is corroborated.
// ---------------------------------------------------------------------------

const yulia = (calendar) => ({ id: "s-10", ...LL(1694.94, 4758.51),
  place: { name: "Merin", source: "google_places", confidence: 0.7 }, calendar_event: calendar });
const lassers = { summary: "the Wells", location: "Merin HBC", location_match: true, physical: true };

test("Merin + 'Friends @ Merin HBC' keeps its name", () => {
  const s = yulia(lassers);
  assert.deepEqual(unnameGuesses([s]), []);
  assert.equal(s.place.name, "Merin");
  assert.equal(s.place.source, "calendar_corroborated");
});

test("a guess with no corroborating event is still unnamed", () => {
  const s = yulia(null);
  assert.deepEqual(unnameGuesses([s]), ["Merin"]);
  assert.equal(s.place.name, null);
});

test("an event at a different venue does not launder a guess", () => {
  const s = yulia({ ...lassers, location: "Port Cafe HBC", location_match: true });
  assert.deepEqual(unnameGuesses([s]), ["Merin"]);
});

// ---------------------------------------------------------------------------
// 6. Silence is stillness at a stop's edges too (Merin ran 18:54–21:00; the
//    trace says ~18:45–21:55). "I think we were there longer."
// ---------------------------------------------------------------------------

const { extendThroughSilence } = require(path.join(ROOT, "lib/resolve-day.js"))._internal;
const Y = { ...LL(1694.94, 4758.51) };
const YULIA_PINGS = [
  { ts: T("18:39:00"), ...LL(2033.8, 3248.43), acc: 5, kind: "transit" },   // 1.6 km, driving
  { ts: T("18:44:00"), ...LL(1694.44, 4415.91), acc: 5, kind: "transit" },   // 345 m
  { ts: T("21:03:00"), ...Y, acc: null, kind: "photo" },                        // still at the table
  { ts: T("21:58:00"), ...LL(1694.24, 5572.34), acc: 5, kind: "transit" },   // 813 m, driving
];
const dinner = () => ({ id: "s-10", start_ts_ms: T("18:54:00"), end_ts_ms: T("21:00:00"), ...Y,
  place: { name: "Merin HBC", source: "calendar_corroborated" } });

test("the dinner runs until the trace shows him leaving", () => {
  const s = dinner();
  const out = extendThroughSilence([s], YULIA_PINGS);
  assert.equal(out.length, 1);
  assert.ok(s.end_ts_ms > T("21:55:00") && s.end_ts_ms < T("21:58:00"), "left ~21:55");
  assert.ok(s.start_ts_ms > T("18:44:00") && s.start_ts_ms < T("18:46:00"), "arrived ~18:45");
});

test("it never runs into the next stop", () => {
  const s = dinner();
  const nextStop = { id: "s-11", start_ts_ms: T("21:30:00"), end_ts_ms: T("22:30:00"), ...LL(1694.24, 5572.34),
    place: { name: "elsewhere" } };
  extendThroughSilence([s, nextStop], YULIA_PINGS);
  assert.ok(s.end_ts_ms <= T("21:30:00"));
});

test("a fix elsewhere soon after the stop leaves it alone", () => {
  const s = dinner();
  extendThroughSilence([s], [{ ts: T("21:04:00"), ...LL(1694.24, 5572.34), acc: 5, kind: "transit" }]);
  assert.equal(s.end_ts_ms, T("21:00:00"));
});

// ---------------------------------------------------------------------------
// 7. A walk he described is a slot, even with no GPS stop under it.
//    "rover's walk is completely missing from the daily summary."
// ---------------------------------------------------------------------------

const { addDescribedNonStops } = require(path.join(ROOT, "lib/resolve-day.js"))._internal;
const WALK = "Evening walk with Rover to the beach";
const ncRow = (id, a, d, lat, lon) => ({ id, place_type: "non-stop", place_name: WALK,
  arrived_at: new Date(T(a)).toISOString(), departed_at: new Date(T(d)).toISOString(),
  latitude: lat, longitude: lon, companions: ["Paige"] });

test("two rows of one described walk become one slot, absorbing the unnamed turnaround", () => {
  const turnaround = { id: "s-8", start_ts_ms: T("17:35:00"), end_ts_ms: T("17:41:00"), ...LL(234.37, 546.19),
    place: { name: null, source: "unknown" }, photos: [{ uuid: "p" }] };
  const stops = [home("s-5", "14:44:00", "17:25:00"), turnaround];
  const added = addDescribedNonStops(stops, [ncRow("a", "17:25:00", "17:35:00", ...PT(206.11, 346.04)),
                                             ncRow("b", "17:53:00", "18:05:00", ...PT(111.87, 101.41))]);
  assert.equal(added.length, 1);
  const w = stops.find(s => s.user_non_stop);
  assert.equal(w.place.name, WALK);
  assert.equal(w.start_ts_ms, T("17:25:00"));
  assert.equal(w.end_ts_ms, T("18:05:00"));
  assert.ok(!stops.includes(turnaround));
  assert.equal(w.photos.length, 1, "the turnaround's photo travels with the walk");
});

test("a described window a settled stop already covers adds nothing", () => {
  const stops = [home("s-5", "17:00:00", "18:30:00")];
  assert.equal(addDescribedNonStops(stops, [ncRow("a", "17:25:00", "17:35:00", ...PT(206.11, 346.04))]).length, 0);
});

test("a fix at the place extends the stop even when he left right after it", () => {
  const s = home("s-5", "14:44:00", "16:09:00");
  extendThroughSilence([s], [
    { ts: T("16:35:00"), ...FLAT, acc: 13, kind: "transit" },
    { ts: T("17:25:00"), ...LL(2.54, 14.68), acc: null, kind: "clvisit" },
    { ts: T("17:28:00"), ...LL(168.41, 257.08), acc: 15, kind: "transit" },
  ]);
  assert.equal(s.end_ts_ms, T("17:25:00"));
});
