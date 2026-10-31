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
