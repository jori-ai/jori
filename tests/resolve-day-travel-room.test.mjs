// resolve-day-travel-room.test.mjs — two places are never the same minute.
//
// The incident (2026-10-20, Portside): the evening cluster at the flat was cut on
// its rests into the flat 19:12-20:06 and Lusca from 20:06. A rest-cut stop ends
// on the first fix elsewhere, and that fix (20:06:13) stood at Lusca's table, so
// the summary had him leave the flat and sit down to dinner 175 m away in the
// same minute. The flat's last fix was 19:15. leaveRoomToTravel gives the walk
// back out of the flat's silent tail, and only out of a silent tail.
//
// Run: node --test tests/resolve-day-travel-room.test.mjs

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
const LLG = (e, n) => { const p = fakeAt(e, n); return { lat: p.lat, lng: p.lon }; };

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { leaveRoomToTravel } = require(path.join(ROOT, "lib/resolve-day.js"))._internal;

const U = (hms) => Date.parse(`2026-10-20T${hms}Z`);   // Israel is UTC+3
const FLAT = { ...LL(0.0, 0.0) };
const RAISA = { ...LL(184.72, -21.13) };
const p = (hms, at, acc = 15) => ({ ts: U(hms), lat: at.lat, lon: at.lon, acc });

// The evening's fixes, from location_history.
const PINGS = [
  p("16:12:36", { ...LL(11.31, 4.45) }, 27),
  p("16:12:54", { ...LL(31.1, -23.35) }, 14),
  p("16:15:36", FLAT, 15),
  p("17:06:13", RAISA, 12),
  p("18:56:47", RAISA, 5),
  p("19:09:38", { ...LL(111.21, 23.35) }, 23),
];

const stop = (id, name, at, from, to) => ({
  id, start: from, end: to, start_ts_ms: U(from), end_ts_ms: U(to),
  duration_min: Math.round((U(to) - U(from)) / 60000), lat: at.lat, lon: at.lon,
  place: { name, source: "confirmed_stop" },
});

test("a silent tail gives back the walk to the next place", () => {
  const flat = stop("s-4-r1", "The Harbor Flat", FLAT, "16:12:36", "17:06:13");
  const raisa = stop("s-7", "Lusca", RAISA, "17:06:13", "19:09:38");
  const out = leaveRoomToTravel([flat, raisa], PINGS);
  assert.equal(out.length, 1);
  const walkMin = (raisa.start_ts_ms - flat.end_ts_ms) / 60000;
  assert.ok(walkMin >= 2 && walkMin <= 3, `about two minutes on foot for 175 m, got ${walkMin}`);
  assert.equal(raisa.start_ts_ms, U("17:06:13"), "the next place keeps its own first fix");
  assert.ok(flat.end_ts_ms > U("16:15:36"), "never before the last fix at the flat");
  assert.equal(flat.duration_min, Math.round((flat.end_ts_ms - flat.start_ts_ms) / 60000));
});

test("a fix at the place keeps the stay; nothing is trimmed past evidence", () => {
  const flat = stop("s-4-r1", "The Harbor Flat", FLAT, "16:12:36", "17:06:13");
  const raisa = stop("s-7", "Lusca", RAISA, "17:06:13", "19:09:38");
  const out = leaveRoomToTravel([flat, raisa], [...PINGS, p("17:05:40", FLAT, 8)]);
  assert.equal(out.length, 0);
  assert.equal(flat.end_ts_ms, U("17:06:13"));
});

test("one place, room already, a walk block, or a ride's distance: left alone", () => {
  // the same place twice
  const a = stop("a", "The Harbor Flat", FLAT, "16:00:00", "17:00:00");
  const b = stop("b", "The Harbor Flat", { ...LL(9.42, 7.78) }, "17:00:00", "18:00:00");
  assert.equal(leaveRoomToTravel([a, b], PINGS).length, 0);
  // already five minutes apart
  const c = stop("c", "The Harbor Flat", FLAT, "16:12:36", "17:01:00");
  const d = stop("d", "Lusca", RAISA, "17:06:13", "19:09:38");
  assert.equal(leaveRoomToTravel([c, d], PINGS).length, 0);
  // a walk block is movement, not a place
  const e = stop("e", "The Harbor Flat", FLAT, "16:12:36", "17:06:13");
  const w = { ...stop("w", "Walk around Portside", RAISA, "17:06:13", "17:30:00"), excursion: { routed_m: 900 } };
  assert.equal(leaveRoomToTravel([e, w], PINGS).length, 0);
  // 8.6 km apart with 28 minutes between: a drive fits, nothing to give back
  const abby = stop("abby", "Visiting Abby", { ...LL(2211.55, -8328.93) }, "13:19:00", "15:02:00");
  const home = stop("home", "The Harbor Flat", FLAT, "15:30:00", "15:45:00");
  assert.equal(leaveRoomToTravel([abby, home], []).length, 0);
});

// 2026-10-28, Portside: the drive to the airport (flat out 05:40:47, airport roads from
// 06:00:59, a fix every five minutes) was cut back to 05:30 once the airport was a
// stop, because the straight-line 12.5 km "needs" 30 minutes. The fixes across the
// gap ARE the travel, so nothing is given back; a silent gap still is.
test("a gap with a fix every five minutes is travel he was seen doing", () => {
  const T = (hms) => Date.parse(`2026-10-28T${hms}Z`);
  const flat = { ...LL(7.45, 2.67) };
  const airport = { ...LL(11006.58, -5907.4) };
  const mk = (id, name, at, from, to) => ({
    id, start: from, end: to, start_ts_ms: T(from), end_ts_ms: T(to),
    duration_min: Math.round((T(to) - T(from)) / 60000), lat: at.lat, lon: at.lon,
    place: { name, source: "confirmed_stop" },
  });
  const drive = [
    { ts: T("03:40:47"), ...LL(279.91, -32.24), acc: 30 },
    { ts: T("03:45:58"), ...LL(1542.94, -1085.15), acc: 5 },
    { ts: T("03:50:59"), ...LL(2983.98, -694.53), acc: 5 },
    { ts: T("03:55:59"), ...LL(6909.19, -4382.07), acc: 5 },
    { ts: T("04:00:59"), ...LL(12418.85, -7187.85), acc: 5 },
  ];
  const f = mk("s-1", "The Harbor Flat", flat, "03:14:13", "03:40:47");
  const a = mk("s-a1", "Example Airport", airport, "04:00:59", "04:16:34");
  assert.equal(leaveRoomToTravel([f, a], drive).length, 0);
  assert.equal(f.end_ts_ms, T("03:40:47"), "the flat keeps the fix that proved he had left");

  // the same two stops with the middle of the drive unrecorded: a silent gap, so it still gives back
  const f2 = mk("s-1", "The Harbor Flat", flat, "03:14:13", "03:40:47");
  const a2 = mk("s-a1", "Example Airport", airport, "04:00:59", "04:16:34");
  const holes = [drive[0], drive[4]];
  assert.equal(leaveRoomToTravel([f2, a2], holes).length, 1);
  assert.ok(f2.end_ts_ms < T("03:40:47"));
});

// A stop's START never runs back into the trip from the previous place
// (extendThroughSilence). Lunch 3.3 km from the flat, last fix at the restaurant at
// 13:00, nothing usable until the flat's arrival at 13:20: lunch's end ran on to
// 13:10 and the flat's start back to "last fix at lunch + the ride", 13:10 too, so
// the summary had lunch end and the afternoon at home begin in the same minute, the
// ride gone. leaveRoomToTravel could not give it back: lunch's end then sat seconds
// after its own last fix plus the ride. The start's lower bound is now the previous
// end plus the trip's minutes (travelRoomMs, the formula leaveRoomToTravel uses).
const { extendThroughSilence } = require(path.join(ROOT, "lib/resolve-day.js"))._internal;
const LLP = (e, n) => { const q = fakeAt(e, n); return { lat: q.lat, lon: q.lon }; };
const UM = (hms) => Date.parse(`2026-03-10T${hms}Z`);
const LUNCH = LLP(0, 0);
const FLAT_M = LLP(-1100, 3130);            // ~3.3 km away
const pm = (hms, at, acc = 15, activity = "unknown") => ({ ts: UM(hms), lat: at.lat, lon: at.lon, acc, activity });

const PINGS_M = [
  pm("12:28:30", LUNCH), pm("12:45:00", LUNCH), pm("13:00:57", LUNCH, 13),
  pm("13:10:47", LLP(400, 520), 84),       // too loose to place him
  pm("13:20:39", FLAT_M, 10),               // the flat's arrival
  pm("13:22:34", LLP(-1090, 3120), 20, "walking"),
  pm("14:30:00", FLAT_M), pm("17:10:00", FLAT_M),
];

const stopm = (id, name, at, from, to) => ({
  id, start: from, end: to, start_ts_ms: UM(from), end_ts_ms: UM(to),
  duration_min: Math.round((UM(to) - UM(from)) / 60000), lat: at.lat, lon: at.lon,
  place: { name, source: "user_confirmed" },
});

function run(env) {
  const old = process.env.JORI_SILENCE_TRAVEL_ROOM;
  if (env == null) delete process.env.JORI_SILENCE_TRAVEL_ROOM; else process.env.JORI_SILENCE_TRAVEL_ROOM = env;
  try {
    const lunch = stopm("s-3", "The Restaurant", LUNCH, "12:28:00", "13:09:00");
    const flat = stopm("s-4", "Home", FLAT_M, "13:20:39", "17:13:00");
    extendThroughSilence([lunch, flat], PINGS_M);
    leaveRoomToTravel([lunch, flat], PINGS_M);
    return { lunch, flat };
  } finally {
    if (old == null) delete process.env.JORI_SILENCE_TRAVEL_ROOM; else process.env.JORI_SILENCE_TRAVEL_ROOM = old;
  }
}

test("the ride home keeps its minutes between lunch and the flat", () => {
  const { lunch, flat } = run(null);
  const gapMin = (flat.start_ts_ms - lunch.end_ts_ms) / 60000;
  assert.ok(gapMin >= 9, `about ten minutes for a 3.3 km ride, got ${gapMin.toFixed(1)}`);
  assert.ok(flat.start_ts_ms >= UM("13:19:39"), "the flat starts no earlier than its own row");
  assert.ok(lunch.end_ts_ms >= UM("13:00:57"), "lunch runs at least to its last fix");
  assert.equal(flat.duration_min, Math.round((flat.end_ts_ms - flat.start_ts_ms) / 60000));
});

test("JORI_SILENCE_TRAVEL_ROOM=0 restores the old bound (the two touch)", () => {
  const { lunch, flat } = run("0");
  assert.ok(flat.start_ts_ms - lunch.end_ts_ms < 60_000, "the old pass let the flat start where lunch ended");
});

test("within one place there is no trip, so a start still runs back to the previous end", () => {
  const A = LLP(0, 0);
  const pings = [pm("09:00:00", A), pm("09:40:00", A), pm("10:40:00", LLP(30, 20))];
  const first = stopm("s-1", "Home", A, "09:00:00", "09:41:00");
  const second = stopm("s-2", "Home", LLP(30, 20), "10:41:00", "12:00:00");
  extendThroughSilence([first, second], pings);
  assert.ok(second.start_ts_ms - first.end_ts_ms <= 60_000, "the quiet hour is stillness at the same place, no trip left between");
});

test("a start still runs back through silence after a far place when the gap holds the trip", () => {
  const far = LLP(0, 0), home = LLP(-1100, 3130);
  const pings = [pm("09:00:00", far), pm("09:30:00", far), pm("11:00:00", home), pm("12:00:00", home)];
  const a = stopm("s-1", "Somewhere", far, "09:00:00", "09:31:00");
  const b = stopm("s-2", "Home", home, "11:20:00", "13:00:00");
  extendThroughSilence([a, b], pings);
  assert.ok(b.start_ts_ms <= UM("11:00:00"), "the fix at home at 11:00 is direct evidence");
  assert.ok(b.start_ts_ms - a.end_ts_ms >= 9 * 60_000, "and the trip keeps its minutes");
});

// A visit row's departure can run minutes past the last fix at the place. Home's last
// fix at 09:51:58, its row's departure 09:57:07, and twelve seconds later a walking fix
// 185 m down the street: the fixes across the gap saw the walk, but not the departure,
// so they are not travel seen from its start. Home gives back its walk to the market
// (1.15 km at walking pace) out of its silent tail, never past its last fix.
const UW = (hms) => Date.parse(`2026-03-14T${hms}Z`);
const HOME_W = LLP(0, 0), MARKET_W = LLP(950.4, -641.8);
const pw = (hms, at, acc = 15, activity = "walking") => ({ ts: UW(hms), lat: at.lat, lon: at.lon, acc, activity });
const WALK_PINGS = [
  pw("09:48:12", LLP(4.2, 4.4), 17),
  pw("09:51:58", LLP(3.4, -2.4), 10, "unknown"),
  pw("09:57:19", LLP(157.7, -95.9), 16),
  pw("09:57:57", LLP(175.4, -120.3), 8),
  pw("10:02:17", LLP(357.6, -282.7), 14),
  pw("10:07:42", LLP(848.6, -569.4), 21),
];
const stopw = (id, name, at, from, to) => ({
  id, start: from, end: to, start_ts_ms: UW(from), end_ts_ms: UW(to),
  duration_min: Math.round((UW(to) - UW(from)) / 60000), lat: at.lat, lon: at.lon,
  place: { name, source: "named_location" },
});

function walkOut(env) {
  const old = process.env.JORI_TRAVEL_SEEN_DEPARTURE;
  if (env == null) delete process.env.JORI_TRAVEL_SEEN_DEPARTURE; else process.env.JORI_TRAVEL_SEEN_DEPARTURE = env;
  try {
    const home = stopw("s-3", "Home", HOME_W, "09:48:12", "09:57:07");
    const market = stopw("s-4", "The Market", MARKET_W, "10:06:47", "11:13:54");
    const out = leaveRoomToTravel([home, market], WALK_PINGS);
    return { home, market, out };
  } finally {
    if (old == null) delete process.env.JORI_TRAVEL_SEEN_DEPARTURE; else process.env.JORI_TRAVEL_SEEN_DEPARTURE = old;
  }
}

test("a walking fix too far from the place to reach since its end means the departure was not seen", () => {
  const { home, market, out } = walkOut(null);
  assert.equal(out.length, 1);
  const walkMin = (market.start_ts_ms - home.end_ts_ms) / 60000;
  assert.ok(walkMin >= 13 && walkMin <= 14.5, `about 14 minutes on foot for 1.15 km, got ${walkMin.toFixed(1)}`);
  assert.ok(home.end_ts_ms > UW("09:51:58"), "never before the last fix at home");
  assert.equal(market.start_ts_ms, UW("10:06:47"), "the next place keeps its own start");
  assert.equal(home.duration_min, Math.round((home.end_ts_ms - home.start_ts_ms) / 60000));
});

test("a fix at the place after that time still keeps the stay", () => {
  const home = stopw("s-3", "Home", HOME_W, "09:48:12", "09:57:07");
  const market = stopw("s-4", "The Market", MARKET_W, "10:06:47", "11:13:54");
  assert.equal(leaveRoomToTravel([home, market], [...WALK_PINGS, pw("09:56:40", LLP(6, 3), 9, "unknown")]).length, 0);
  assert.equal(home.end_ts_ms, UW("09:57:07"));
});

test("a first fix a walker could reach since the end is travel seen from its start", () => {
  // the same walk, the first fix away 90 seconds after home's end (169 m clear of its accuracy, under 7 km/h)
  const pings = WALK_PINGS.map(q => (q.ts === UW("09:57:19") ? { ...q, ts: UW("09:58:37") } : q))
    .filter(q => q.ts !== UW("09:57:57"));
  const home = stopw("s-3", "Home", HOME_W, "09:48:12", "09:57:07");
  const market = stopw("s-4", "The Market", MARKET_W, "10:06:47", "11:13:54");
  assert.equal(leaveRoomToTravel([home, market], pings).length, 0);
});

test("JORI_TRAVEL_SEEN_DEPARTURE=0 keeps the old test (the gap's fixes are the travel)", () => {
  const { home, out } = walkOut("0");
  assert.equal(out.length, 0);
  assert.equal(home.end_ts_ms, UW("09:57:07"));
});
